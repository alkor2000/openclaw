/** Read-only Node findings shared by Doctor and status commands. */
import { nodeRuntimeFailure, nodeRuntimeNote } from "../../node-sqlite.mjs";
import {
  formatUnsupportedNodeVersionMessage,
  parseNodeReleaseVersion,
  SUPPORTED_NODE_VERSIONS,
} from "../../node-version.mjs";
import { isDefaultInstallIdentity } from "../config/paths.js";
import { isNodeRuntime } from "../daemon/runtime-binary.js";
import { resolveNodeRuntimeInfo } from "../daemon/runtime-paths.js";
import { summarizeGatewayServiceLayout } from "../daemon/service-layout.js";
import { resolveGatewayService } from "../daemon/service.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatInstallOwnerMessage, readInstallOwner } from "../infra/install-owner.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { detectRuntime } from "../infra/runtime-guard.js";

const CHECK_ID = "core/doctor/node-runtime";

// Upstream lifecycle dates are advisory; SQLite capabilities own admission.
// Compare UTC instants so notes never start before the published effective date.
const NODE_RELEASE_SCHEDULE = [
  { major: 24, maintenance: "2026-10-20", eol: "2028-04-30", lts: true },
  { major: 25, maintenance: "2026-04-01", eol: "2026-06-01", lts: false },
  { major: 26, maintenance: "2027-10-20", eol: "2029-04-30", lts: true },
] as const;

function unsupportedNodeFinding(
  version: string | null,
  capabilityError?: string,
  ownerHint?: string,
): HealthFinding {
  return {
    checkId: CHECK_ID,
    severity: "warning",
    source: "gateway-service",
    message: `Gateway service Node ${version ?? "unknown"} is unsupported. Required: ${SUPPORTED_NODE_VERSIONS}.`,
    requirement: SUPPORTED_NODE_VERSIONS,
    fixHint:
      ownerHint ??
      [
        ...(capabilityError ? [capabilityError] : []),
        formatUnsupportedNodeVersionMessage(version),
        "After switching Node, refresh a managed Gateway with `openclaw gateway install --force`; for an externally managed service, have its deployment owner update the launcher.",
      ].join("\n"),
  };
}

async function collectCurrentNodeRuntimeFindings(
  includeLifecycleAdvice: boolean,
): Promise<readonly HealthFinding[]> {
  const runtime = await detectRuntime();
  if (runtime.kind !== "node" || !runtime.sqliteProbe) {
    return [];
  }
  const failure = nodeRuntimeFailure(runtime.version, runtime.sqliteProbe);
  const message = failure ?? nodeRuntimeNote(runtime.version, runtime.sqliteProbe);
  const major = parseNodeReleaseVersion(runtime.version)?.major;
  const release =
    includeLifecycleAdvice && !failure
      ? NODE_RELEASE_SCHEDULE.find((entry) => entry.major === major)
      : undefined;
  const now = Date.now();
  const endOfLife = release ? now >= Date.parse(`${release.eol}T00:00:00Z`) : false;
  const installOwner =
    failure || endOfLife
      ? await readInstallOwner(
          await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url, argv1: process.argv[1] }),
        )
      : null;
  const findings: HealthFinding[] = message
    ? [
        {
          checkId: CHECK_ID,
          severity: failure ? "error" : "info",
          source: "cli",
          message,
          requirement: SUPPORTED_NODE_VERSIONS,
          target: runtime.execPath ?? undefined,
          ...(failure
            ? {
                fixHint: installOwner
                  ? formatInstallOwnerMessage(installOwner)
                  : formatUnsupportedNodeVersionMessage(runtime.version),
              }
            : {}),
        },
      ]
    : [];
  if (release) {
    const label = release.lts ? `Node ${runtime.version} LTS` : `Node ${runtime.version}`;
    if (endOfLife) {
      findings.push({
        checkId: CHECK_ID,
        severity: "warning",
        source: "cli",
        message: `${label} reached upstream end-of-life on ${release.eol}; it no longer receives security updates.`,
        fixHint: installOwner
          ? formatInstallOwnerMessage(installOwner)
          : "Consider a currently maintained release: https://nodejs.org/en/download",
      });
    } else if (now >= Date.parse(`${release.maintenance}T00:00:00Z`)) {
      findings.push({
        checkId: CHECK_ID,
        severity: "info",
        source: "cli",
        message: `${label} is in upstream maintenance mode (EOL ${release.eol}).`,
      });
    }
  }
  return findings;
}

/** Inspect the CLI and recorded service without starting or repairing the service. */
export async function collectNodeRuntimeFindings(
  env: NodeJS.ProcessEnv = process.env,
  { includeLifecycleAdvice = false }: { includeLifecycleAdvice?: boolean } = {},
): Promise<HealthFinding[]> {
  return [
    ...(await collectCurrentNodeRuntimeFindings(includeLifecycleAdvice)),
    ...(await collectServiceNodeRuntimeFindings(env)),
  ];
}

/** Inspect the recorded service executable without starting or repairing the service. */
async function collectServiceNodeRuntimeFindings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HealthFinding[]> {
  const findings: HealthFinding[] = [];
  if (!isDefaultInstallIdentity(env)) {
    return findings;
  }
  try {
    const command = await resolveGatewayService().readCommand(env, { timeoutMs: 5_000 });
    const executable = command?.programArguments[0];
    if (executable && isNodeRuntime(executable)) {
      const runtime = await resolveNodeRuntimeInfo(executable, { ...env, ...command.environment });
      if (runtime.status === "probe-failed") {
        throw runtime.error;
      }
      if (runtime.status === "unsupported") {
        const layout = await summarizeGatewayServiceLayout(command);
        const owner = await readInstallOwner(
          layout?.packageRootReal ?? layout?.packageRoot ?? null,
        );
        findings.push(
          unsupportedNodeFinding(
            runtime.version,
            runtime.capabilityError,
            owner ? formatInstallOwnerMessage(owner) : undefined,
          ),
        );
      } else if (runtime.note) {
        findings.push({
          checkId: CHECK_ID,
          severity: "info",
          source: "gateway-service",
          message: runtime.note,
          target: executable,
        });
      }
    }
  } catch {
    findings.push({
      checkId: CHECK_ID,
      severity: "warning",
      source: "gateway-service",
      message: "The recorded Gateway service Node runtime could not be inspected.",
      fixHint: "Run `openclaw gateway status --deep` and check access to its recorded executable.",
    });
  }
  return findings;
}
