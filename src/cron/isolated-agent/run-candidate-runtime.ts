import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { resolveProviderScopedAuthProfile } from "../../auto-reply/reply/agent-runner-auth-profile.js";
import { readConfiguredModelAuthProfileProvider } from "../../config/sessions/auth-profile-override-provenance.js";
import { isCliProvider } from "./run-execution.runtime.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";
import { resolveEffectiveAgentRuntime } from "./run.runtime.js";

/** Shares candidate execution policy between harness preparation and dispatch. */
export function createCronCandidateExecutionResolver(
  params: Pick<
    CronRunExecutionParams,
    "cfgWithAgentDefaults" | "agentId" | "runSessionKey" | "cronSession"
  >,
) {
  return (provider: string, model: string, sessionRuntimeOverride: string | undefined) => {
    const executionProvider = sessionRuntimeOverride
      ? isCliProvider(sessionRuntimeOverride, params.cfgWithAgentDefaults)
        ? sessionRuntimeOverride
        : provider
      : (resolveCliRuntimeExecutionProvider({
          provider,
          cfg: params.cfgWithAgentDefaults,
          agentId: params.agentId,
          modelId: model,
        }) ?? provider);
    const runtime =
      sessionRuntimeOverride ??
      resolveEffectiveAgentRuntime({
        cfg: params.cfgWithAgentDefaults,
        provider,
        modelId: model,
        agentId: params.agentId,
        sessionKey: params.runSessionKey,
        sessionEntry: params.cronSession.sessionEntry,
      });
    return {
      sessionRuntimeOverride,
      executionProvider,
      cliExecution: isCliProvider(executionProvider, params.cfgWithAgentDefaults),
      runtime,
    };
  };
}

/** Prepare provider facts once, then retain a later explicit account intent at use time. */
export function prepareCronCandidateAuthSelection(
  params: Pick<
    CronRunExecutionParams,
    "liveSelection" | "cronSession" | "cfgWithAgentDefaults" | "workspaceDir"
  >,
  provider: string,
) {
  const configuredAuthProvider = readConfiguredModelAuthProfileProvider(
    params.liveSelection,
    params.cronSession.sessionEntry,
  );
  const selectedAuthProfile = configuredAuthProvider
    ? resolveProviderScopedAuthProfile({
        provider,
        primaryProvider: configuredAuthProvider,
        authProfileId: params.liveSelection.authProfileId,
        authProfileIdSource: params.liveSelection.authProfileIdSource,
        config: params.cfgWithAgentDefaults,
        workspaceDir: params.workspaceDir,
      })
    : params.liveSelection;
  return () => {
    const selection = readConfiguredModelAuthProfileProvider(
      params.liveSelection,
      params.cronSession.sessionEntry,
    )
      ? selectedAuthProfile
      : params.liveSelection;
    return {
      embedded: {
        authProfileId: selection.authProfileId,
        authProfileIdSource: selection.authProfileId ? selection.authProfileIdSource : undefined,
      },
      cli: selection.authProfileId
        ? {
            authProfileId: selection.authProfileId,
            authProfileIdSource:
              selection.authProfileIdSource === "user" ? ("user" as const) : ("auto" as const),
          }
        : undefined,
    };
  };
}
