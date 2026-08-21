// Adapter session lifecycle (analyzer.md §9.2, validator-api §3.1): a failed
// createSession disables only that adapter — everything else still runs.
import {
  isAdapterSessionFailure,
  type AdapterFailure,
  type HtmlValidatorAdapter,
  type ValidatorSession,
} from "@vue-html-bridge/validator-api";
import type { AnalyzerLogger, ConfiguredAdapter } from "./types.js";

export interface AdapterSessionEntry {
  adapterId: string;
  adapter: HtmlValidatorAdapter;
  settings: unknown;
  session?: ValidatorSession;
  sessionFailure?: AdapterFailure;
}

export async function createSessions(
  configured: readonly ConfiguredAdapter[],
  workspaceRoot: string,
  logger: AnalyzerLogger,
): Promise<readonly AdapterSessionEntry[]> {
  const enabled = configured.filter((entry) => entry.enabled);
  return Promise.all(
    enabled.map(async (entry): Promise<AdapterSessionEntry> => {
      try {
        const session = await entry.adapter.createSession({
          workspaceRoot,
          settings: entry.settings,
          logger,
        });
        return {
          adapterId: entry.adapter.id,
          adapter: entry.adapter,
          settings: entry.settings,
          session,
        };
      } catch (error) {
        if (isAdapterSessionFailure(error)) {
          return {
            adapterId: entry.adapter.id,
            adapter: entry.adapter,
            settings: entry.settings,
            sessionFailure: error.failure,
          };
        }
        logger.error(
          "Adapter createSession rejected without an AdapterSessionFailure shape.",
          {
            adapterId: entry.adapter.id,
          },
        );
        return {
          adapterId: entry.adapter.id,
          adapter: entry.adapter,
          settings: entry.settings,
          sessionFailure: {
            code: "execution-error",
            message: `The "${entry.adapter.id}" adapter failed to start.`,
            recoverable: false,
          },
        };
      }
    }),
  );
}

export async function disposeSessions(
  entries: readonly AdapterSessionEntry[],
): Promise<void> {
  await Promise.all(entries.map((entry) => entry.session?.dispose()));
}
