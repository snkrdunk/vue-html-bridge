export const PACKAGE_NAME = "@vue-html-bridge/adapter-loader";

export type {
  AdapterLoadFailure,
  AdapterLoadFailureKind,
  AdapterModuleResolver,
  LoadAdaptersRequest,
  LoadAdaptersResult,
  LoadAdaptersTrust,
  LoadedAdapter,
  ResolvedValidatorSetting,
} from "./types.js";

export { loadConfiguredAdapters } from "./load.js";

export {
  AdapterModuleResolutionError,
  nodeModuleResolver,
} from "./resolver.js";

// Exported for CLI/language-server host integration tests (adapter-loader.md
// §6 item 8) — see contract-fixture.ts for how to use these.
export {
  ADAPTER_LOADER_CONTRACT_BUILTINS,
  ADAPTER_LOADER_CONTRACT_SCENARIOS,
  adapterLoaderContractModuleResolver,
  CONTRACT_FIXTURE_API_VERSION_MISMATCH_EXTERNAL,
  CONTRACT_FIXTURE_BUILTIN_BAD_VERSION_ID,
  CONTRACT_FIXTURE_BUILTIN_ID,
  CONTRACT_FIXTURE_DUPLICATE_EXTERNAL,
  CONTRACT_FIXTURE_INVALID_SHAPE_EXTERNAL,
  CONTRACT_FIXTURE_THROWING_EXTERNAL,
  CONTRACT_FIXTURE_UNRESOLVABLE_EXTERNAL,
  CONTRACT_FIXTURE_VALID_EXTERNAL,
  type AdapterLoaderContractScenario,
} from "./contract-fixture.js";
