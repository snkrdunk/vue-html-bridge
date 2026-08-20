# vue-html-bridge Design Documents

The documents in this directory are the source of truth for the design after the move to a monorepo.

## Overall design

- [Monorepo overall design](./monorepo.md)
- [List of changes from the old design](./decision-changes.md)

## Per-package design

- [`vue-html-bridge` (core)](./packages/core.md)
- [`@vue-html-bridge/validator-api`](./packages/validator-api.md)
- [`@vue-html-bridge/analyzer`](./packages/analyzer.md)
- [`@vue-html-bridge/adapter-markuplint`](./packages/adapter-markuplint.md)
- [`@vue-html-bridge/language-server`](./packages/language-server.md)
- [`@vue-html-bridge/settings`](./packages/settings.md)
- [`@vue-html-bridge/cli`](./packages/cli.md)
- [`@vue-html-bridge/adapter-loader`](./packages/adapter-loader.md)
- [`@vue-html-bridge/adapter-testkit`](./packages/adapter-testkit.md)

## Where this fits

`Design Document_ vue-html-bridge.md`, at the root of the repository, stays as a record of the design discussion before the move to a monorepo. Most decisions about the variant generation algorithm carried over to the core design as-is, but some were changed on purpose. The changed decisions and the reasons for each change are recorded in [List of changes from the old design](./decision-changes.md). If the root document and this directory disagree about the public API, responsibility boundaries, LSP, or validator integration, the documents in this directory take priority.

## Terms

| Term                 | Meaning                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| source               | The input Vue SFC                                                                                                        |
| generated HTML       | Static HTML generated from the source, with no Vue syntax left in it                                                     |
| variant              | One of the possible HTML outputs a single SFC can generate, together with the conditions that produce it and its mapping |
| core diagnostic      | An issue that core finds while interpreting the SFC or generating variants                                               |
| validator diagnostic | An issue that an HTML validator finds in the generated HTML                                                              |
| source diagnostic    | A validator diagnostic mapped back to a position in the SFC and aggregated                                               |
| adapter              | An implementation that connects one specific HTML validator to the common interface                                      |
| provenance           | Information showing which SFC syntax, value, or transform a piece of generated HTML came from                            |
