import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { clearMemoryPluginState } from "../../../plugins/memory-state.test-fixtures.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

export type ContextEngineAttemptOptions = Parameters<typeof createContextEngineAttemptRunner>[0];

export function completedStream(message: unknown) {
  return { result: async () => message, [Symbol.asyncIterator]: () => (async function* () {})() };
}

export function useContextEngineAttemptHarness(sessionKey: string) {
  const hoisted = getHoisted();
  const tempPaths: string[] = [];
  const suiteTempPaths: string[] = [];
  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    clearMemoryPluginState();
    hoisted.detectAndLoadPromptImagesMock.mockClear();
  });
  afterEach(() => {
    suiteTempPaths.push(...tempPaths.splice(0));
    clearMemoryPluginState();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await cleanupTempPaths(suiteTempPaths);
  });
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });
  return {
    hoisted,
    tempPaths,
    runAttempt: (
      options: Omit<ContextEngineAttemptOptions, "sessionKey" | "tempPaths" | "contextEngine"> &
        Partial<Pick<ContextEngineAttemptOptions, "contextEngine" | "sessionKey">> = {},
    ) =>
      createContextEngineAttemptRunner({
        sessionKey,
        tempPaths,
        contextEngine: createContextEngineBootstrapAndAssemble(),
        ...options,
      }),
  };
}

export function signedAssistant(
  thinking: string,
  thinkingSignature: string,
  text: string,
  timestamp: number,
) {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking, thinkingSignature },
      { type: "text", text },
    ],
    stopReason: "stop",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    timestamp,
  } as AgentMessage;
}

export function requireRecords(value: unknown, label: string): Array<Record<string, unknown>> {
  expect(value, label).toBeInstanceOf(Array);
  return value as Array<Record<string, unknown>>;
}

export function findRecord(
  records: Array<Record<string, unknown>>,
  predicate: (record: Record<string, unknown>) => boolean,
  label: string,
) {
  const record = records.find(predicate);
  if (!record) {
    throw new Error(`expected record: ${label}`);
  }
  return record;
}
