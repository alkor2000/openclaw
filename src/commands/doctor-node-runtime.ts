import { createDoctorHealthContribution } from "../flows/doctor-health-contribution.js";
import { isSupportedNodeVersion, parseSemver } from "../infra/runtime-guard.js";
import { resolveNodeVersionManager } from "../shared/version-manager-path.js";
// Doctor health contribution: Node.js runtime diagnostics.
//
// Surfaces the Node version, install channel (version manager vs system), and
// proactive lifecycle guidance during `openclaw doctor`. Version support is
// delegated entirely to runtime-guard's isSupportedNodeVersion (the canonical
// engines contract) rather than a local copy, so this note can never disagree
// with what installs actually enforce. Path redaction reuses the shared
// shortenHomePath helper (POSIX + Windows home boundaries, case-insensitive,
// see #121455) rather than local variants.
//
// The default summary omits the executable path entirely so ordinary copied
// Doctor output does not disclose local filesystem layout. Path inclusion is
// parameterized (includeExecPath); registration and a verbose gate still
// require integration with the existing Doctor runtime owner.
import { shortenHomePath } from "../utils.js";

/**
 * Node.js release lifecycle dates (maintenance entry and end-of-life),
 * sourced from the official Node.js release working group schedule. Used
 * only for advisory lifecycle notes about releases the engines contract
 * already accepts; support decisions themselves come from
 * isSupportedNodeVersion. Unknown majors degrade gracefully (no note).
 */
interface NodeReleaseInfo {
  major: number;
  maintenanceStart: string; // ISO date the release enters maintenance
  endOfLife: string; // ISO date the release reaches end-of-life
  isLts: boolean;
}

const NODE_RELEASE_SCHEDULE: NodeReleaseInfo[] = [
  { major: 22, maintenanceStart: "2025-10-21", endOfLife: "2027-04-30", isLts: true },
  { major: 24, maintenanceStart: "2026-10-20", endOfLife: "2028-04-30", isLts: true },
  { major: 25, maintenanceStart: "2026-04-01", endOfLife: "2026-06-01", isLts: false },
  { major: 26, maintenanceStart: "2027-10-20", endOfLife: "2029-04-30", isLts: true },
];

/** Collected facts about the current Node.js runtime. */
export interface NodeRuntimeDiagnostics {
  version: string | null;
  major: number | null;
  execPath: string | null;
  versionManaged: boolean;
  versionManagerHint: string | null;
}

/**
 * Collect Node runtime facts from the live process (or an injected
 * environment for tests). Never throws; unknown shapes degrade to nulls.
 */
export function collectNodeRuntimeDiagnostics(
  env: Record<string, string | undefined> = process.env,
  execPath: string | null = process.execPath ?? null,
  versionRaw: string | null = process.version ?? null,
): NodeRuntimeDiagnostics {
  const version = versionRaw ? versionRaw.replace(/^v/, "") : null;
  const parsed = version ? parseSemver(version) : null;
  // An installed manager must not relabel a different selected executable.
  const manager = execPath ? resolveNodeVersionManager(execPath, env) : "system";
  return {
    version,
    major: parsed ? parsed.major : null,
    execPath,
    versionManaged: manager !== "system",
    versionManagerHint: manager === "system" || manager === "other" ? null : manager,
  };
}

/** Days until an ISO date from now, rounded up to preserve its UTC boundary. */
function daysUntil(isoDate: string): number {
  const target = Date.parse(`${isoDate}T00:00:00Z`);
  // A positive partial day must not trigger maintenance or EOL before midnight UTC.
  return Math.ceil((target - Date.now()) / 86_400_000);
}

/** Roughly whole months represented by a day count (floored, min 0). */
function monthsFromDays(days: number): number {
  return Math.max(0, Math.floor(days / 30));
}

/**
 * Build proactive lifecycle warnings for the detected Node runtime.
 *
 * Support decisions delegate to the canonical engines contract
 * (isSupportedNodeVersion). For unsupported versions the warning points at
 * the engines requirement. For supported versions, advisory notes surface
 * upstream lifecycle facts (past EOL / in maintenance) without inventing an
 * upgrade target the engines contract does not express.
 */
export function buildNodeRuntimeWarnings(diag: NodeRuntimeDiagnostics): string[] {
  const warnings: string[] = [];
  if (!diag.version || diag.major === null) {
    return warnings;
  }
  if (!isSupportedNodeVersion(diag.version)) {
    warnings.push(
      `Node ${diag.version} is outside OpenClaw's supported engine range (see package.json engines).\n` +
        `Upgrade Node: https://nodejs.org/en/download`,
    );
    return warnings;
  }
  const release = NODE_RELEASE_SCHEDULE.find((entry) => entry.major === diag.major);
  if (!release) {
    return warnings;
  }
  const eolDays = daysUntil(release.endOfLife);
  const maintenanceDays = daysUntil(release.maintenanceStart);
  const label = release.isLts ? `Node ${release.major} LTS` : `Node ${release.major}`;
  if (eolDays <= 0) {
    warnings.push(
      `${label} reached upstream end-of-life on ${release.endOfLife}; it no longer receives security updates.\n` +
        `Consider a currently maintained release: https://nodejs.org/en/download`,
    );
  } else if (maintenanceDays <= 0) {
    warnings.push(
      `${label} is in upstream maintenance mode (EOL ${release.endOfLife}, ~${monthsFromDays(eolDays)} months remaining).`,
    );
  }
  return warnings;
}

/**
 * Render the one-line runtime summary.
 *
 * Default form omits the executable path so ordinary copied Doctor output
 * does not disclose local filesystem layout:
 *   `Node 24.14.0 · via nvm`  /  `Node 24.14.0 · system install`
 *
 * With includeExecPath the path is included, redacted through the shared
 * shortenHomePath helper (POSIX + Windows home boundaries,
 * case-insensitive):
 *   `Node 24.14.0 · ~/.nvm/versions/node/v24.14.0/bin/node · via nvm`
 */
export function buildNodeRuntimeSummary(
  diag: NodeRuntimeDiagnostics,
  options: { includeExecPath?: boolean } = {},
): string {
  const version = diag.version ? `Node ${diag.version}` : "Node (version unknown)";
  const channel = diag.versionManaged
    ? diag.versionManagerHint
      ? `via ${diag.versionManagerHint}`
      : "version-managed"
    : "system install";
  if (options.includeExecPath && diag.execPath) {
    return `${version} \u00b7 ${shortenHomePath(diag.execPath)} \u00b7 ${channel}`;
  }
  return `${version} \u00b7 ${channel}`;
}

/**
 * Ready-to-wire Doctor health contribution. Not yet registered in the
 * initial contribution list. Integration must extend the existing Doctor
 * runtime owner and preserve its compatibility and SQLite diagnostics. The
 * default render never includes the executable path; only a verbose gate
 * should enable includeExecPath.
 */
export const nodeRuntimeHealthContribution = createDoctorHealthContribution({
  id: "doctor:node-runtime",
  label: "Node.js runtime",
  run: async (ctx): Promise<void> => {
    const diag = collectNodeRuntimeDiagnostics();
    // includeExecPath stays false until a verbose gate
    // lands; ordinary Doctor output must not disclose filesystem layout.
    const summary = buildNodeRuntimeSummary(diag, { includeExecPath: false });
    ctx.runtime.log(summary);
    for (const warning of buildNodeRuntimeWarnings(diag)) {
      ctx.runtime.log(warning);
    }
  },
});
