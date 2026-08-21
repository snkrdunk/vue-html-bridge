// Workspace analyzer construction (language-server.md §9.1). Phase 1 is a
// single workspace with the built-in Markuplint adapter and hardcoded
// default settings — multi-root, real settings resolution, config watching,
// and external-adapter trust all land in Phase 2 Track 4 / Phase 3.
import { markuplintAdapter } from "@vue-html-bridge/adapter-markuplint";
import {
  createTypeAnalysisContext,
  createWorkspaceAnalyzer,
  type WorkspaceAnalyzer,
} from "@vue-html-bridge/analyzer";

export function createDefaultWorkspaceAnalyzer(
  workspaceRoot: string,
): Promise<WorkspaceAnalyzer> {
  return createWorkspaceAnalyzer({
    workspaceRoot,
    adapters: [{ adapter: markuplintAdapter, settings: {}, enabled: true }],
    // One TypeAnalysisContext per workspace (ADR-0002; §9.1) — constructed
    // once, alongside the analyzer, and threaded through unchanged.
    typeContext: createTypeAnalysisContext(),
  });
}
