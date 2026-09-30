// Tests for the Node.js runtime Doctor health contribution.
//
// Support decisions are delegated to runtime-guard's isSupportedNodeVersion
// (the canonical engines contract), so these tests exercise the delegation
// boundary with engines edge versions rather than re-encoding version
// knowledge. Lifecycle fixtures model an accepted runtime independently of
// the repository's current engine range. Redaction scenarios are NOT tested
// here: path redaction moved
// to the shared shortenHomePath helper (#121455) which carries its own
// regression tests. This file covers version-manager detection, diagnostics
// collection, lifecycle advisories, and the two summary forms (default
// without the executable path, verbose-style with it).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeGuard from "../infra/runtime-guard.js";
import {
  buildNodeRuntimeSummary,
  buildNodeRuntimeWarnings,
  collectNodeRuntimeDiagnostics,
  type NodeRuntimeDiagnostics,
} from "./doctor-node-runtime.js";

/** Convenience factory for diagnostics fixtures. */
function makeDiag(overrides: Partial<NodeRuntimeDiagnostics> = {}): NodeRuntimeDiagnostics {
  return {
    version: "24.15.0",
    major: 24,
    execPath: "/usr/bin/node",
    versionManaged: false,
    versionManagerHint: null,
    ...overrides,
  };
}

describe("collectNodeRuntimeDiagnostics", () => {
  it("reports the selected system Node despite an installed nvm", () => {
    const diag = collectNodeRuntimeDiagnostics(
      { NVM_DIR: "/home/test/.nvm" },
      "/usr/bin/node",
      "v24.15.0",
    );
    expect(diag.versionManaged).toBe(false);
    expect(diag.versionManagerHint).toBe(null);
    expect(buildNodeRuntimeSummary(diag)).toBe("Node 24.15.0 · system install");
  });

  it("collects an nvm-managed runtime", () => {
    const diag = collectNodeRuntimeDiagnostics(
      {},
      "/home/test/.nvm/versions/node/v24.15.0/bin/node",
      "v24.15.0",
    );
    expect(diag.version).toBe("24.15.0");
    expect(diag.major).toBe(24);
    expect(diag.versionManaged).toBe(true);
    expect(diag.versionManagerHint).toBe("nvm");
  });

  it("reports the selected fnm runtime despite an installed nvm", () => {
    const diag = collectNodeRuntimeDiagnostics(
      { NVM_DIR: "/home/test/.nvm", FNM_DIR: "/opt/fnm" },
      "/opt/fnm/node-versions/v24.15.0/installation/bin/node",
      "v24.15.0",
    );
    expect(diag.versionManaged).toBe(true);
    expect(diag.versionManagerHint).toBe("fnm");
    expect(buildNodeRuntimeSummary(diag)).toBe("Node 24.15.0 · via fnm");
  });

  it("classifies Windows executable paths with mixed casing", () => {
    const diag = collectNodeRuntimeDiagnostics(
      {},
      "C:\\Users\\Test\\.NVM\\versions\\node\\v24.15.0\\node.exe",
      "v24.15.0",
    );
    expect(diag.versionManaged).toBe(true);
    expect(diag.versionManagerHint).toBe("nvm");
  });

  it("renders other managed runtimes without inventing a manager name", () => {
    const diag = collectNodeRuntimeDiagnostics(
      {},
      "/home/test/.asdf/installs/nodejs/24.15.0/bin/node",
      "v24.15.0",
    );
    expect(diag.versionManaged).toBe(true);
    expect(diag.versionManagerHint).toBe(null);
    expect(buildNodeRuntimeSummary(diag)).toBe("Node 24.15.0 · version-managed");
  });

  it("degrades gracefully for an unknown runtime shape", () => {
    const diag = collectNodeRuntimeDiagnostics({}, null, null);
    expect(diag.version).toBe(null);
    expect(diag.major).toBe(null);
    expect(diag.execPath).toBe(null);
    expect(diag.versionManaged).toBe(false);
    expect(diag.versionManagerHint).toBe(null);
  });

  it("collects a system install runtime", () => {
    const diag = collectNodeRuntimeDiagnostics({}, "/usr/bin/node", "v24.15.0");
    expect(diag.versionManaged).toBe(false);
    expect(diag.versionManagerHint).toBe(null);
    expect(diag.execPath).toBe("/usr/bin/node");
  });
});

describe("buildNodeRuntimeWarnings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["20.18.0", 20],
    ["24.0.0", 24],
  ] as const)("warns without lifecycle advice for unsupported Node %s", (version, major) => {
    expect(runtimeGuard.isSupportedNodeVersion(version)).toBe(false);
    const warnings = buildNodeRuntimeWarnings(makeDiag({ version, major }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("outside OpenClaw's supported engine range");
    expect(warnings[0]).toContain("package.json engines");
    expect(warnings[0]).not.toContain("maintenance");
  });

  it.each([
    ["22.22.3", 22],
    ["24.15.0", 24],
    ["24.16.0", 24],
    ["25.9.0", 25],
    ["26.0.0", 26],
    ["26.1.0", 26],
  ] as const)("delegates Node %s support to the real engines contract", (version, major) => {
    const supported = runtimeGuard.isSupportedNodeVersion(version);
    const warnings = buildNodeRuntimeWarnings(makeDiag({ version, major }));
    const engineWarnings = warnings.filter((warning) =>
      warning.includes("outside OpenClaw's supported engine range"),
    );
    expect(engineWarnings).toHaveLength(supported ? 0 : 1);
    if (!supported) {
      expect(warnings).toEqual(engineWarnings);
    }
  });

  describe("lifecycle advice for an accepted runtime", () => {
    beforeEach(() => {
      // Historical release dates stay testable after the real engines contract retires a major.
      vi.spyOn(runtimeGuard, "isSupportedNodeVersion").mockReturnValue(true);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns no warnings before upstream maintenance", () => {
      expect(buildNodeRuntimeWarnings(makeDiag({ version: "24.15.0", major: 24 }))).toEqual([]);
    });

    it("notes maintenance mode for a release in upstream maintenance", () => {
      const warnings = buildNodeRuntimeWarnings(makeDiag({ version: "22.22.3", major: 22 }));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("maintenance mode");
      expect(warnings[0]).toContain("EOL 2027-04-30");
    });

    it("warns when a release has reached upstream end-of-life", () => {
      const warnings = buildNodeRuntimeWarnings(makeDiag({ version: "25.9.0", major: 25 }));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Node 25 reached upstream end-of-life on 2026-06-01");
      expect(warnings[0]).toContain("no longer receives security updates");
    });

    it.each([
      ["25.9.0", 25, "2026-03-31T23:59:59.999Z", null],
      [
        "25.9.0",
        25,
        "2026-04-01T00:00:00.000Z",
        "Node 25 is in upstream maintenance mode (EOL 2026-06-01",
      ],
      [
        "25.9.0",
        25,
        "2026-05-31T23:59:59.999Z",
        "Node 25 is in upstream maintenance mode (EOL 2026-06-01",
      ],
      [
        "25.9.0",
        25,
        "2026-06-01T00:00:00.000Z",
        "Node 25 reached upstream end-of-life on 2026-06-01",
      ],
      ["26.0.0", 26, "2027-10-19T23:59:59.999Z", null],
      [
        "26.0.0",
        26,
        "2027-10-20T00:00:00.000Z",
        "Node 26 LTS is in upstream maintenance mode (EOL 2029-04-30",
      ],
    ] as const)(
      "reports Node %s (major %i) lifecycle on %s",
      (version, major, date, expectedWarning) => {
        vi.setSystemTime(new Date(date));
        const warnings = buildNodeRuntimeWarnings(makeDiag({ version, major }));
        expect(warnings).toEqual(
          expectedWarning === null ? [] : [expect.stringContaining(expectedWarning)],
        );
      },
    );
  });

  it("returns no warnings when the version is missing", () => {
    expect(buildNodeRuntimeWarnings(makeDiag({ version: null, major: null }))).toEqual([]);
  });

  it("returns no lifecycle note for an unknown future major", () => {
    expect(buildNodeRuntimeWarnings(makeDiag({ version: "99.0.0", major: 99 }))).toEqual([]);
  });
});

describe("buildNodeRuntimeSummary", () => {
  it("renders version and channel only by default (no executable path)", () => {
    const summary = buildNodeRuntimeSummary(
      makeDiag({
        execPath: "/home/test/.nvm/versions/node/v24.15.0/bin/node",
        versionManaged: true,
        versionManagerHint: "nvm",
      }),
    );
    expect(summary).toBe("Node 24.15.0 \u00b7 via nvm");
    expect(summary).not.toContain("/home/test");
    expect(summary).not.toContain(".nvm");
  });

  it("renders a system install without a path by default", () => {
    expect(buildNodeRuntimeSummary(makeDiag())).toBe("Node 24.15.0 \u00b7 system install");
  });

  it("includes the executable path when includeExecPath is set", () => {
    const summary = buildNodeRuntimeSummary(
      makeDiag({
        execPath: "/opt/node/bin/node",
        versionManaged: true,
        versionManagerHint: "volta",
      }),
      { includeExecPath: true },
    );
    expect(summary).toContain("/opt/node/bin/node");
    expect(summary).toContain("via volta");
  });

  it("labels a version-managed runtime without a hint generically", () => {
    const summary = buildNodeRuntimeSummary(
      makeDiag({ versionManaged: true, versionManagerHint: null }),
    );
    expect(summary).toBe("Node 24.15.0 \u00b7 version-managed");
  });

  it("degrades gracefully when the version is unknown", () => {
    const summary = buildNodeRuntimeSummary(makeDiag({ version: null }));
    expect(summary).toBe("Node (version unknown) \u00b7 system install");
  });

  it("uses the interpunct separator between segments", () => {
    const summary = buildNodeRuntimeSummary(makeDiag(), { includeExecPath: true });
    const segments = summary.split(" \u00b7 ");
    expect(segments).toHaveLength(3);
    expect(segments[0]).toBe("Node 24.15.0");
    expect(segments[2]).toBe("system install");
  });
});
