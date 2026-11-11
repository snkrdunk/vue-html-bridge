# Architecture and the Vue Model

Status: Draft  
Last updated: 2026-11-11

## 1. Purpose and how to read this document

This document records why the architecture lets one analysis serve several environments — an editor, a terminal, pre-commit hooks, CI — and why those environments report the same diagnostics for the same input. It also summarizes how the Vue side is modeled, because that model is what keeps the analysis free of environment-specific state.

It defines nothing new. This directory is where the design is authoritative ([the design index](./README.md)), and this file only connects its documents. Every statement below is a short paraphrase with a link; if one ever disagrees with its linked section, trust the linked section and correct this file. To follow a decision into its detail, open the link rather than extending this file.

## 2. Environments

| Environment | Entry point | What the host adds around the shared analysis | Defined in |
| --- | --- | --- | --- |
| Editor (any LSP client) | `vue-html-bridge-language-server --stdio` | Unsaved buffers, debounce and cancellation, document versions, publish and hover | [language-server.md §1](./packages/language-server.md#1-role), [language-server.md §2](./packages/language-server.md#2-distribution-and-startup), [ADR-0009](../adr/0009-language-server-distribution.md) |
| Terminal and pre-commit | `vue-html-bridge [file\|dir\|glob ...]` | File enumeration from disk, flags, text output, exit codes | [cli.md §1](./packages/cli.md#1-role), [cli.md §2](./packages/cli.md#2-distribution-and-invocation) |
| CI | The same CLI | Machine-readable output on request, a severity threshold for failing the job, run-level errors that outrank findings | [cli.md §7](./packages/cli.md#7-output), [cli.md §8](./packages/cli.md#8-run-outcomes-and-exit-codes) |
| CI on untrusted contributions | The same CLI with `--untrusted` | External adapters off, Markuplint on its bundled defaults | [cli.md §5](./packages/cli.md#5-trust) |

**AI-agent hooks.** The existing design documents do not specify an AI-agent hook integration. The only non-editor entry point is the CLI, and its contract does not depend on who calls it: exit codes `0`, `1` and `2`, text output by default, and NDJSON only when `--format ndjson` is given ([cli.md §7](./packages/cli.md#7-output), [cli.md §8](./packages/cli.md#8-run-outcomes-and-exit-codes)). A hook that runs the CLI would see exactly that contract. Nothing more is claimed here.

## 3. Responsibility split

```text
  language-server                              cli
  (buffers, versions, LSP positions)           (disk files, flags, exit codes)
        |                                         |
  ------+------------- host line: below it, shared by both hosts -------------+------
        |
        +-- settings        resolve the layers, split into per-package options
        +-- adapter-loader  load adapters, gate external code by trust
        +-- analyzer        run, reverse-map, aggregate, cache, cancel
              +-- core      SFC to variants and a source map; knows no validator
              +-- adapters  one HTML string to diagnostics; know no Vue
```

The package-by-package table and the dependency graph live in [monorepo.md §4](./monorepo.md#4-package-structure) and [monorepo.md §4.1](./monorepo.md#41-dependencies); the rules behind the lines are the design principles in [monorepo.md §3](./monorepo.md#3-design-principles). What this document adds is the reasoning that connects them:

- **The line is drawn by what could drift.** Anything that decides which diagnostics appear for given inputs sits below the host line, in one place; the inputs themselves, such as trust, come from the host. [settings.md §1](./packages/settings.md#1-role) says that defining the schema once is what keeps the hosts from drifting. [adapter-loader.md §1](./packages/adapter-loader.md#1-role) says the same about trust gating, where drift would mean running different workspace code. [decision-changes.md](./decision-changes.md) (change 5) records the CLI as a thin second consumer of the analyzer, not a second implementation.
- **Hosts own I/O, lifecycle, presentation and the policy inputs they feed in.** [language-server.md §1](./packages/language-server.md#1-role) and [cli.md §1](./packages/cli.md#1-role) list what each one does and, equally, what it must never do: neither calls the Markuplint API directly, and both reach core only through the analyzer ([language-server.md §3](./packages/language-server.md#3-dependencies)).
- **core and adapters stay ignorant of each other and of the hosts.** core does not know validators, adapters do not know Vue, and the analyzer does not know LSP ([monorepo.md §3](./monorepo.md#3-design-principles)). That is the basis for the stated goal of adding a validator other than Markuplint without touching either host ([monorepo.md §4](./monorepo.md#4-package-structure)), and for giving the adapter contract its own test kit ([adapter-testkit.md §1](./packages/adapter-testkit.md#1-role)).
- **One exception is accepted on purpose.** Converting offsets to line and column may be duplicated in the two hosts until a measured need justifies a shared utility; shared fixtures keep the copies honest ([cli.md §7](./packages/cli.md#7-output)).

## 4. Why every environment reports the same diagnostics

Each row is a mechanism, what it guarantees, and where it is both defined and tested.

| Mechanism | What it guarantees | Defined in | Pinned by |
| --- | --- | --- | --- |
| One analysis path | Both hosts send the analyzer the same kind of request (source text, file name, URI) and only reshape its result | [monorepo.md §5](./monorepo.md#5-end-to-end-data-flow), [language-server.md §3](./packages/language-server.md#3-dependencies), [cli.md §1](./packages/cli.md#1-role) | [monorepo.md §12.2](./monorepo.md#122-across-the-monorepo), [cli.md §9](./packages/cli.md#9-tests) (item 14) |
| Source text is a value | An unsaved editor buffer and a file read from disk are the same kind of input; the analyzer never re-reads the file | [analyzer.md §2.1](./packages/analyzer.md#21-analyze-requestresult), [ADR-0002](../adr/0002-type-analysis-context-ownership.md) for type dependencies | [cli.md §9](./packages/cli.md#9-tests) (item 14 requires identical content) |
| One settings model | Schema, defaults, validation, merge order and decomposition exist once; flags and `workspace/configuration` are only the top layer | [settings.md §1](./packages/settings.md#1-role), [settings.md §4](./packages/settings.md#4-resolution-validation--merging), [settings.md §6](./packages/settings.md#6-decomposition), [cli.md §4.2](./packages/cli.md#42-flag-mapping) | [settings.md §8](./packages/settings.md#8-tests) (item 7), [cli.md §9](./packages/cli.md#9-tests) (item 1) |
| One adapter loader | Which adapters load, under which trust, and how failures are classified are decided once | [adapter-loader.md §1](./packages/adapter-loader.md#1-role), [adapter-loader.md §4](./packages/adapter-loader.md#4-loading-rules), [ADR-0008](../adr/0008-external-adapter-trust-model.md) | [adapter-loader.md §6](./packages/adapter-loader.md#6-tests) (item 8), [cli.md §9](./packages/cli.md#9-tests) (item 13) |
| One check on adapter settings | The analyzer, which both hosts pass through, validates the shape of adapter settings before creating a session | [ADR-0007](../adr/0007-adapter-settings-runtime-validation-location.md) | The verifying test named in [ADR-0007](../adr/0007-adapter-settings-runtime-validation-location.md) |
| Deterministic computation | By design, the same input gives the same order and identifiers, from variant generation to the CLI's file list | [monorepo.md §3](./monorepo.md#3-design-principles) (principle 6), [core.md §9](./packages/core.md#9-determinism-and-cancellation), [validator-api.md §5](./packages/validator-api.md#5-determinism), [analyzer.md §5.2](./packages/analyzer.md#52-virtual-filename), [cli.md §6](./packages/cli.md#6-execution-model) | [core.md §10](./packages/core.md#10-tests) (item 12), [analyzer.md §12](./packages/analyzer.md#12-tests) (item 16), [validator-api.md §9](./packages/validator-api.md#9-test-requirements), [cli.md §9](./packages/cli.md#9-tests) (item 4) |
| One coordinate system | Internal positions are UTF-16 offsets: adapters convert the validator's own coordinates into them, and line and column appear only when a host writes its output | [monorepo.md §6.1](./monorepo.md#61-coordinate-system), [language-server.md §5](./packages/language-server.md#5-position-encoding), [cli.md §7](./packages/cli.md#7-output), [ADR-0004](../adr/0004-position-encoding-scope.md) | [validator-api.md §9](./packages/validator-api.md#9-test-requirements), [language-server.md §13.1](./packages/language-server.md#131-unit), [cli.md §9](./packages/cli.md#9-tests) (item 8, shared fixtures) |
| Caches are accelerators | Caches are in memory, keyed on content, settings and versions, and never written to disk, so by design they change speed and not output; the CLI has no persistent cache | [monorepo.md §10.2](./monorepo.md#102-cache-layers), [analyzer.md §10](./packages/analyzer.md#10-cache), [cli.md §10](./packages/cli.md#10-open-questions) | [analyzer.md §12](./packages/analyzer.md#12-tests) (item 13) |
| Failure isolation | A broken adapter or configuration costs only that adapter's results; core diagnostics and other adapters survive | [monorepo.md §3](./monorepo.md#3-design-principles) (principle 7), [monorepo.md §11](./monorepo.md#11-error-handling), [analyzer.md §9](./packages/analyzer.md#9-merging-core-and-adapter-failures) | [analyzer.md §12](./packages/analyzer.md#12-tests) (item 10) |

Two guards keep the table true over time. The dependency direction between packages is checked in CI ([ADR-0001](../adr/0001-build-release-tooling.md), [monorepo.md §4.1](./monorepo.md#41-dependencies)), and the hosts are compared end to end on one fixture, once trusted and once restricted ([cli.md §9](./packages/cli.md#9-tests) item 14, [language-server.md §13.3](./packages/language-server.md#133-end-to-end)). That comparison fixes the trust policy, the resolved settings together with their issues, the adapter-loader results and the file content, and then asserts the same code, range, severity and adapter for each diagnostic.

## 5. Where hosts differ on purpose

The differences fall into two groups, and the split matters: only the second group can change what runs.

### 5.1 Presentation and lifecycle

These do not change which validation findings the analyzer returns for equal inputs.

| Aspect | Language server | CLI | Defined in |
| --- | --- | --- | --- |
| Freshness of input | Open buffers with document versions; stale results are dropped | One disk snapshot per file, no versions; signals abort the run | [language-server.md §6](./packages/language-server.md#6-document-lifecycle), [cli.md §6](./packages/cli.md#6-execution-model) |
| Positions and paths | The position encoding negotiated with the client | 1-based line and column in UTF-16 units; workspace-relative paths with `/` | [language-server.md §5](./packages/language-server.md#5-position-encoding), [cli.md §7](./packages/cli.md#7-output) |
| Workspace shape | Multi-root; each folder has its own settings, sessions and cache; a lone file outside any folder gets a restricted session | One workspace root per run; files outside it are rejected | [language-server.md §9.1](./packages/language-server.md#91-multi-root), [cli.md §6](./packages/cli.md#6-execution-model) |
| Editor-only settings | Honored | Accepted in files, ignored | [cli.md §4.2](./packages/cli.md#42-flag-mapping) |
| Session-level adapter failures | One notice per workspace, plus at most one diagnostic per document | Reported once per run, outside the per-file results | [language-server.md §7.3](./packages/language-server.md#73-workspaceconfig-failure), [cli.md §8](./packages/cli.md#8-run-outcomes-and-exit-codes) |

The last row is why "same diagnostics" is about validation findings. For a session-level failure the two hosts present the same underlying event differently.

### 5.2 Policy

These can change which adapters run, or whether analysis runs at all.

| Policy | Language server | CLI | Defined in |
| --- | --- | --- | --- |
| Workspace trust | Untrusted unless the client says otherwise | Trusted by default; `--untrusted` restricts | [language-server.md §4.2](./packages/language-server.md#42-initialization-options), [cli.md §5](./packages/cli.md#5-trust) |
| Invalid settings | Continue with resolved fallbacks and report the issues | Error-level issues are fatal and exit with `2` before analysis | [settings.md §4](./packages/settings.md#4-resolution-validation--merging), [language-server.md §9.2](./packages/language-server.md#92-settings), [cli.md §4.1](./packages/cli.md#41-sources-and-precedence) |

The reasons are stated in the linked sections: the LSP has no trust protocol that all clients share, running a CLI in a repository is an explicit act, an editor must not go dark on a bad settings file, and CI must not pass on silently wrong settings. Because these two inputs can change the result, parity is defined after they are equalized, exactly as the parity tests do. For invalid settings, equalizing means settings without error-level issues: given one, the CLI stops before analyzing while the language server carries on with fallbacks, so there is no common run to compare.

## 6. Limits of the guarantee

Two environments report the same diagnostics when all of the following hold:

- **The inputs are the same.** That means the SFC content (the saved file, not an unsaved buffer that differs from it), the type files and `tsconfig` the SFC reaches ([core.md §2](./packages/core.md#2-public-api)), and the Markuplint configuration the adapter discovers ([adapter-markuplint.md §4](./packages/adapter-markuplint.md#4-config-resolution)).
- **The resolved settings are the same, and none of their issues is error-level.** The CLI stops before analyzing on an error-level issue, while the language server continues with fallbacks ([settings.md §4](./packages/settings.md#4-resolution-validation--merging), [cli.md §4.1](./packages/cli.md#41-sources-and-precedence)). The settings also fix the generation options ([settings.md §6](./packages/settings.md#6-decomposition)).
- **The trust policy is the same**, because it decides whether workspace Markuplint configuration, JavaScript configuration and external adapters take part ([cli.md §5](./packages/cli.md#5-trust)).
- **The installed versions are the same.** The core version is part of the variant identity, and the core and compiler versions are part of the core result cache key ([monorepo.md §6.2](./monorepo.md#62-variant-identity), [analyzer.md §10](./packages/analyzer.md#10-cache)). The Markuplint adapter owns the rule profile applied to generated HTML ([adapter-markuplint.md §5](./packages/adapter-markuplint.md#5-generated-html-profile)). [validator-api.md §5](./packages/validator-api.md#5-determinism) makes determinism conditional on the validator version, and Markuplint is a peer dependency of the adapter ([adapter-markuplint.md §3.2](./packages/adapter-markuplint.md#32-module-format), [package manifest](../../packages/adapter-markuplint/package.json)), so each installation resolves it within the supported range.

Not specified in the existing design documents:

- **Version skew between environments.** Packages are versioned independently ([monorepo.md §13](./monorepo.md#13-release-and-compatibility)). A language server installed for an editor and a CLI pinned in a project can therefore carry different analyzer, core or Markuplint versions. The documents do not say how to keep them aligned, or whether they should.
- **AI-agent hooks.** See section 2.

The scope limits of the analysis itself are the same in every environment, so they are a shared limitation and not a parity gap ([monorepo.md §2.2](./monorepo.md#22-not-included-in-the-initial-release), [core.md §11](./packages/core.md#11-known-limitations)).

## 7. Vue model

core turns a template into static HTML variants without running Vue. [core.md §3](./packages/core.md#3-processing-pipeline) gives the pipeline.

| Vue concern | How it is modeled | Defined in |
| --- | --- | --- |
| `v-if`, `v-for`, dynamic attributes | Expressions that affect the output become shared decisions, and the whole template is evaluated once per combination, so related nodes agree with each other | [core.md §4.1](./packages/core.md#41-dont-create-independent-variants-per-node) |
| Child components and slots | Not emitted, so content rules across a component boundary are not checked; fallback content of a `<slot>` is rendered | [core.md §5.2](./packages/core.md#52-components-and-slots) |
| Directives | Each has an explicit rule: an attribute, a removal, a placeholder, or an exclusion with a diagnostic | [core.md §5.3](./packages/core.md#53-directives) |
| Custom directives | Dropped unless a declared mapping says which attributes they set | [core.md §5.3.1](./packages/core.md#531-custom-directive-attribute-value-modeling), [ADR-0010](../adr/0010-custom-directive-attribute-value-modeling.md) |
| Values that cannot be known | Replaced by a marked placeholder; the analyzer later explains it in bridge terms | [core.md §5.4](./packages/core.md#54-dummy-values-and-sentinels), [analyzer.md §7](./packages/analyzer.md#7-normalization-based-on-provenance) |

Deliberately outside the model: the runtime DOM, child component templates and the content model across them, content inserted by `v-html`, and the runtime side effects of custom directives. A declared custom-directive mapping is only the author's claim about what the directive does, and nothing checks it ([core.md §11](./packages/core.md#11-known-limitations), [monorepo.md §2.2](./monorepo.md#22-not-included-in-the-initial-release)).

This is what makes the analysis environment-independent. The variants depend only on the SFC text, the type files and `tsconfig` it reaches, and the generation options. No application, browser or runtime DOM is involved ([monorepo.md §2.2](./monorepo.md#22-not-included-in-the-initial-release)). Type analysis reads files as data and never runs workspace code, so it sits outside the trust boundary ([core.md §2](./packages/core.md#2-public-api), [language-server.md §10.2](./packages/language-server.md#102-external-adapter)). A custom-directive mapping is declarative and runs no code, so trust does not gate it either ([cli.md §5](./packages/cli.md#5-trust)). What depends on trust is validator configuration and external adapters, the two places where workspace code can run.

## 8. Reading map

| Question | Start with |
| --- | --- |
| Why does a CLI exist next to the language server? | [decision-changes.md](./decision-changes.md) (change 5), [monorepo.md §1](./monorepo.md#1-purpose) |
| How do I add a setting that both hosts understand? | [settings.md §3](./packages/settings.md#3-settings-schema), [settings.md §6](./packages/settings.md#6-decomposition), [cli.md §4.2](./packages/cli.md#42-flag-mapping) |
| How do I add a validator? | [validator-api.md §3](./packages/validator-api.md#3-public-spi), [adapter-testkit.md §1](./packages/adapter-testkit.md#1-role), [ADR-0008](../adr/0008-external-adapter-trust-model.md) |
| Which Markuplint version, and why? | [ADR-0003](../adr/0003-markuplint-api-usage-and-version-pin.md), [ADR-0012](../adr/0012-markuplint-v5-upgrade.md) |
| How are positions converted for each client? | [ADR-0004](../adr/0004-position-encoding-scope.md), [language-server.md §5](./packages/language-server.md#5-position-encoding) |
| How do I see the HTML that was validated? | [ADR-0011](../adr/0011-emit-html-debug-dump.md), [cli.md §4.2](./packages/cli.md#42-flag-mapping) |
| How is the monorepo built and released? | [ADR-0001](../adr/0001-build-release-tooling.md), [monorepo.md §13](./monorepo.md#13-release-and-compatibility) |
