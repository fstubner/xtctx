# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.
This file is maintained automatically by Release Please.

## [0.10.0](https://github.com/fstubner/xtctx/compare/xtctx-v0.9.1...xtctx-v0.10.0) (2026-05-07)


### Features

* **cli:** add `xtctx onboard` interactive first-run wizard ([#68](https://github.com/fstubner/xtctx/issues/68)) ([0ecae34](https://github.com/fstubner/xtctx/commit/0ecae343803df86dd98c8ecf76e6bc8d33836d9c))

## [0.9.1](https://github.com/fstubner/xtctx/compare/xtctx-v0.9.0...xtctx-v0.9.1) (2026-05-02)


### Bug Fixes

* **canary:** drop shebang from drift-canary.mjs so the orchestrator test can import it ([45f14a4](https://github.com/fstubner/xtctx/commit/45f14a458f923fd43c95d1fa34aa1bf30e8c0d52))
* **canary:** drop shebang from drift-canary.mjs so the orchestrator test passes ([42eb566](https://github.com/fstubner/xtctx/commit/42eb566a5cf2e6672cc233b8680a2acd1b0d897b))

## [0.9.0](https://github.com/fstubner/xtctx/compare/xtctx-v0.8.0...xtctx-v0.9.0) (2026-05-02)


### Features

* **scrapers:** add opencode and Copilot CLI scrapers ([99c464e](https://github.com/fstubner/xtctx/commit/99c464e818e6387c3ea95a29b9dbee0bda96689b))
* **scrapers:** add opencode and GitHub Copilot CLI scrapers ([7b93bcc](https://github.com/fstubner/xtctx/commit/7b93bccaf9b6290ae3735bf151cf41a819a38bc3))

## [0.8.0](https://github.com/fstubner/xtctx/compare/xtctx-v0.7.1...xtctx-v0.8.0) (2026-05-02)


### Features

* **mcp:** pluggable format adapters + native MCP rendering for all 7 tools ([c16abdf](https://github.com/fstubner/xtctx/commit/c16abdf0124a6a5d10c0bafcd760f0d6ec00bd86))
* **mcp:** pluggable format adapters + native MCP rendering for all 7 tools ([7e08c07](https://github.com/fstubner/xtctx/commit/7e08c07894d5b7d40b9623f8faf3de6890a6fb87))

## [0.7.1](https://github.com/fstubner/xtctx/compare/xtctx-v0.7.0...xtctx-v0.7.1) (2026-04-27)


### Miscellaneous

* **web:** drop runtime SPA in favor of CLI-only introspection ([b07b379](https://github.com/fstubner/xtctx/commit/b07b379b0a05fda2310f95ac6c95f9018d570c6a))
* **web:** drop runtime SPA in favor of CLI-only introspection ([a06f17b](https://github.com/fstubner/xtctx/commit/a06f17bbf335a98038940308f46655535b98471a))

## [0.7.0](https://github.com/fstubner/xtctx/compare/xtctx-v0.6.0...xtctx-v0.7.0) (2026-04-26)


### Features

* **landing:** replace Vite+Vue landing with Astro 5 site adopted from netscli ([a6eb335](https://github.com/fstubner/xtctx/commit/a6eb335c3bb2e10166447a41692f699f5625943b))
* **landing:** replace Vite+Vue landing with Astro 5 site adopted from netscli ([6a75bd0](https://github.com/fstubner/xtctx/commit/6a75bd022d50077a289fbf358335452117565151))

## [0.6.0](https://github.com/fstubner/xtctx/compare/xtctx-v0.5.0...xtctx-v0.6.0) (2026-04-21)


### Features

* **compact:** index compacted sessions into hybrid search (M2) ([63fdc44](https://github.com/fstubner/xtctx/commit/63fdc445935e81a9b26ec5662aff44d35efbb0c9))
* **compact:** index compacted sessions into hybrid search (M2) ([7cfe4cf](https://github.com/fstubner/xtctx/commit/7cfe4cf826a7f0356b313380d9911ff01b0623d8))

## [0.5.0](https://github.com/fstubner/xtctx/compare/xtctx-v0.4.6...xtctx-v0.5.0) (2026-04-21)


### Features

* **canary:** nightly drift check against real Claude Code / Codex / Gemini CLIs ([9edbdcb](https://github.com/fstubner/xtctx/commit/9edbdcba2f6f1545a87c82d7930d462b5cf81daa))


### Bug Fixes

* **scrapers:** platform-gate Cursor default path (same P1 class as Copilot) ([4d62948](https://github.com/fstubner/xtctx/commit/4d6294832f432a406a1b51f02c5fb5a1a492e576))

## [0.4.6](https://github.com/fstubner/xtctx/compare/xtctx-v0.4.5...xtctx-v0.4.6) (2026-04-21)


### Miscellaneous

* **deps:** resolve all 33 Dependabot vulnerabilities (1 critical, 11 high, 21 moderate) ([a510727](https://github.com/fstubner/xtctx/commit/a510727d8cdc1566e319553c107bbbdd0dd47a1e))
* **deps:** resolve all 33 Dependabot vulnerabilities (1 critical, 11 high, 21 moderate) ([c306644](https://github.com/fstubner/xtctx/commit/c30664478227808d567a042c5fc35a1d831865c9))

## [0.4.5](https://github.com/fstubner/xtctx/compare/xtctx-v0.4.4...xtctx-v0.4.5) (2026-04-21)


### Bug Fixes

* **scrapers:** close drift gaps + 3 Copilot bugs — graceful-degradation whitelists, Linux path, incremental scrape, chunk-ID collision ([50c9bfd](https://github.com/fstubner/xtctx/commit/50c9bfdafb718c42907ee7a8e1ac253c0f8a3676))
* **scrapers:** close drift gaps with graceful-degradation whitelists + fix three Copilot bugs ([c352b8f](https://github.com/fstubner/xtctx/commit/c352b8f9fc034601bcbee9b7e90db2bf99a2ea31))

## [0.4.4](https://github.com/fstubner/xtctx/compare/xtctx-v0.4.3...xtctx-v0.4.4) (2026-04-21)


### Bug Fixes

* **config:** gracefully degrade on legacy shared.yaml instead of throwing ([650c4b8](https://github.com/fstubner/xtctx/commit/650c4b831ee641276cbf4726888fed8d30d93ba9))
* **config:** gracefully degrade on legacy shared.yaml instead of throwing ([eded78a](https://github.com/fstubner/xtctx/commit/eded78aeb7980c9ca2ea21dd18751f231ac9d6ab))

## [0.4.3](https://github.com/fstubner/xtctx/compare/xtctx-v0.4.2...xtctx-v0.4.3) (2026-04-21)


### Miscellaneous

* testing rigor — ranking eval, drift mutations, golden snapshots, bench stub ([689e497](https://github.com/fstubner/xtctx/commit/689e497e80cecd2d9e5b418a873b33521f4dfee6))
* testing rigor — ranking eval, drift mutations, golden snapshots, bench stub ([1f4e23c](https://github.com/fstubner/xtctx/commit/1f4e23c78cd5094052111d8da0ff1b126c8d85d4))

## [0.4.2](https://github.com/fstubner/xtctx/compare/xtctx-v0.4.1...xtctx-v0.4.2) (2026-04-21)


### Miscellaneous

* sweeping cleanup — cross-tool smoke suite, package-info fix, dead-code removal ([be471bb](https://github.com/fstubner/xtctx/commit/be471bbafb6412241ea82f5c3053eace9007f876))
* sweeping cleanup — cross-tool smoke suite, package-info fix, dead-code removal ([4889d9d](https://github.com/fstubner/xtctx/commit/4889d9d0581ec24c97d2cfdc2534248a09efa638))

## [0.4.1](https://github.com/fstubner/xtctx/compare/xtctx-v0.4.0...xtctx-v0.4.1) (2026-04-15)


### Bug Fixes

* MCP dedupe, ingest reliability, scratch gitignore ([#32](https://github.com/fstubner/xtctx/issues/32)) ([0b168ea](https://github.com/fstubner/xtctx/commit/0b168eadb6a756c69e406c707cfee94839c1125b))

## [0.4.0](https://github.com/fstubner/xtctx/compare/xtctx-v0.3.3...xtctx-v0.4.0) (2026-04-14)


### Features

* full skill/MCP/hook handoff across all five coding tools ([#26](https://github.com/fstubner/xtctx/issues/26)) ([1026fec](https://github.com/fstubner/xtctx/commit/1026fec1c81e546ebacfe3e17c70ee32cb4977bf))

## [0.3.3](https://github.com/fstubner/xtctx/compare/xtctx-v0.3.2...xtctx-v0.3.3) (2026-02-26)


### Documentation

* clarify api token and github pages behavior ([c23f317](https://github.com/fstubner/xtctx/commit/c23f317deb666039b1b365a0150e61cc4dd6f5b6))
* clarify optional API token behavior ([d95575e](https://github.com/fstubner/xtctx/commit/d95575e6d707f5ce30d22ec0dff0a3657b4ff319))
* keep readme focused on api token behavior ([79b78f9](https://github.com/fstubner/xtctx/commit/79b78f9d2c8e65b8924cb10bdb6b3c4a959ca1ec))

## [0.3.2](https://github.com/fstubner/xtctx/compare/xtctx-v0.3.1...xtctx-v0.3.2) (2026-02-26)


### Documentation

* add root AGENTS guide for repository automation ([1439030](https://github.com/fstubner/xtctx/commit/1439030dfc458cf88f9a7e3abf7f925d678aa1ab))


### Miscellaneous

* deploy landing site to github pages ([6ddecd1](https://github.com/fstubner/xtctx/commit/6ddecd1828e6f3e2ba60200ba8a4dc659e629e73))
* deploy landing site to GitHub Pages ([4fbbfdc](https://github.com/fstubner/xtctx/commit/4fbbfdc1ffadd615e444ab865afa8196ee2f6466))

## [0.3.1](https://github.com/fstubner/xtctx/compare/xtctx-v0.3.0...xtctx-v0.3.1) (2026-02-26)


### Miscellaneous

* auto-enable merge for release-please prs ([8028118](https://github.com/fstubner/xtctx/commit/80281187525971817d238d8c6c93e67309e01d69))
* auto-enable merge for release-please PRs ([7c8535f](https://github.com/fstubner/xtctx/commit/7c8535ff7858111fa570bc528c457e29e99c5098))

## [0.3.0](https://github.com/fstubner/xtctx/compare/xtctx-v0.2.0...xtctx-v0.3.0) (2026-02-26)


### Features

* make API security config file first and refresh README ([bac9c3b](https://github.com/fstubner/xtctx/commit/bac9c3bfa44e0b0c4a080f2fcf42550c1e21ef29))
* make API security config file first and refresh README ([8625dba](https://github.com/fstubner/xtctx/commit/8625dba6383cd416ae6d45790bfe67e5eac0eaad))

## [0.2.0](https://github.com/fstubner/xtctx/compare/xtctx-v0.1.0...xtctx-v0.2.0) (2026-02-25)


### Features

* add api security hardening and owasp checklist ([5660c52](https://github.com/fstubner/xtctx/commit/5660c52591cfcacd1611cfa914e31435d2747c80))
* add API server and Phase 9 Vue web UI ([775543e](https://github.com/fstubner/xtctx/commit/775543e93720c24786abbeb3089e0393eeffa904))
* add auto-tagging for file references and domain classification ([fc27a52](https://github.com/fstubner/xtctx/commit/fc27a52de6edad9cd1b29dd3ee6685d9eb3db4b5))
* add Claude Code conversation scraper ([ba01b58](https://github.com/fstubner/xtctx/commit/ba01b583bfe440e6c274024961dd3472908a923c))
* add CLI compaction provider ([e5f38f8](https://github.com/fstubner/xtctx/commit/e5f38f87a51d5352bf46e741694fa7a70933d8dd))
* add CLI entrypoints and MCP serve command ([866052c](https://github.com/fstubner/xtctx/commit/866052c79c5e2d85aa7f391dcb260e83cd765e5b))
* add core type definitions ([c8dba56](https://github.com/fstubner/xtctx/commit/c8dba5614b83c7521638da67d7c0e664fb4434d1))
* add deduplication with similarity-based supercession ([7023c92](https://github.com/fstubner/xtctx/commit/7023c920fa8b294e5cc9500a456748ecc5cc06bf))
* add hybrid search with reciprocal rank fusion ([830dbe7](https://github.com/fstubner/xtctx/commit/830dbe78ea30dd3c5679e1b9c998150861d57a93))
* add ingestion coordinator, watcher, and daemon ([92a4553](https://github.com/fstubner/xtctx/commit/92a455311683f28b1a4cbdfbef6a8662cbb04faa))
* add knowledge repository with YAML file persistence ([52c2e5c](https://github.com/fstubner/xtctx/commit/52c2e5cbf8100364a17036daad9e24dd090a38b6))
* add LanceDB vector store wrapper ([4f10d46](https://github.com/fstubner/xtctx/commit/4f10d463c48dc916fe5ad8ca1eb2bea73c736927))
* add local embedding service using MiniLM ([dc66f51](https://github.com/fstubner/xtctx/commit/dc66f51b48200b5fb6a42c42be246edd311b7464))
* add MCP server scaffold with all tool definitions ([fa3554f](https://github.com/fstubner/xtctx/commit/fa3554fa5f424448eb3cab339e6a6c23707cb21e))
* add phase 12 landing page ([791f535](https://github.com/fstubner/xtctx/commit/791f53561146f5858ea7de458b084e9d14d6ce5b))
* add phase 13 multi-tool scrapers ([f81c2fb](https://github.com/fstubner/xtctx/commit/f81c2fb2406a98e554ae2246cbd96ffdd4571a78))
* add rule-based compaction pipeline ([7e5d58d](https://github.com/fstubner/xtctx/commit/7e5d58d4fd86cb5eb777021a5e6943b86c07cee8))
* add scraper registry and state management ([9859e2d](https://github.com/fstubner/xtctx/commit/9859e2d49c1678c85e0d824cd87a372aeaae9f63))
* automate releases and bundle web ui in npm package ([3d6ecac](https://github.com/fstubner/xtctx/commit/3d6ecac4db0e88d594e6d5c4e17d9c245d74999b))
* implement MCP tool handlers ([71c6ab5](https://github.com/fstubner/xtctx/commit/71c6ab5f97dde0d0dc63759d4b7014adc0ef78f3))
* implement phase 10 config sync ([dc2661a](https://github.com/fstubner/xtctx/commit/dc2661a58af83f4fafaa008bf8f0b796631341da))
* implement phase 14 hardening and release tooling ([4590f38](https://github.com/fstubner/xtctx/commit/4590f38d26d6ad80fb4737cf721796df68fae307))
* wire ingestion runtime into serve and ingest commands ([89dd876](https://github.com/fstubner/xtctx/commit/89dd876cd8de12617220e7a2e1167dd4bce8c1b5))


### Bug Fixes

* allow release-please prs to trigger ci ([fc00a77](https://github.com/fstubner/xtctx/commit/fc00a77145dbecee8f1a4f80fa3f60b635647738))
* allow release-please PRs to trigger ci ([c398b12](https://github.com/fstubner/xtctx/commit/c398b12b9273baf13136c16ee7cadca6129a0d10))
* normalize npm package metadata ([c6cf81f](https://github.com/fstubner/xtctx/commit/c6cf81f45c737d59629b48e850a9c13b6b97566e))
* normalize npm package metadata ([5553c78](https://github.com/fstubner/xtctx/commit/5553c78f9cf65d4f90d72604b2608d9d5eef40b7))
* run ci for release-please branches ([97e5111](https://github.com/fstubner/xtctx/commit/97e5111ee098faaaa8dc4f31338183c3b5fb610a))
* run ci for release-please branches ([90bf917](https://github.com/fstubner/xtctx/commit/90bf9179d05fb103e52036c55648cde422317752))


### Documentation

* add open source governance and release docs ([a9e18f5](https://github.com/fstubner/xtctx/commit/a9e18f51c1c87c2a6d6da241a37d7bf28e058ea3))
* add phase 14 integration hardening follow-up ([56e7a6e](https://github.com/fstubner/xtctx/commit/56e7a6ee45c0e32fc48940cb319929224a657fb2))
* add xtctx usage skill guide ([e247258](https://github.com/fstubner/xtctx/commit/e247258de8284297af869a22fb44f1f897001d5b))


### Miscellaneous

* ignore codex local workspace directory ([33af3cb](https://github.com/fstubner/xtctx/commit/33af3cbb99f88a9666c0858922d7984fc18b2408))
* ignore runtime state directory ([3a8911d](https://github.com/fstubner/xtctx/commit/3a8911dca76787ef8f6724642a85474de566815e))

## [0.1.0] - 2026-02-25

### Added

- Core TypeScript project scaffold, tests, and CLI entrypoint.
- MCP server scaffold and tool handlers:
  - `xtctx_search`
  - `xtctx_recent_sessions`
  - `xtctx_session_detail`
  - `xtctx_project_knowledge`
  - `xtctx_save_*`
  - `xtctx_*_config` handlers
- Knowledge repository with autotagging and dedup/supersession behaviors.
- LanceDB-backed vector store + embedding service + hybrid search.
- Ingestion coordinator, watcher, daemon, and CLI ingestion commands.
- Rule-based compaction pipeline and external CLI compaction provider.
- API server and Vue web UI (dashboard/search/knowledge/sources/config pages).
- Config sync engine generating tool-native managed sections:
  - `.cursorrules`
  - `CLAUDE.md`
  - `AGENTS.md`
  - `.github/copilot-instructions.md`
- Additional scraper implementations:
  - Claude Code
  - Cursor (SQLite)
  - Codex CLI (JSONL)
  - GitHub Copilot (JSON)
  - Gemini CLI (JSON)
- Integration hardening:
  - Integration tests for MCP/API/web parity paths
  - Retry and coordinated shutdown utilities
  - CI workflow (Node 20/22)
  - Release verification scripts and packaging allowlist
  - Operator/runbook docs in `README.md`
