# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.
This file is maintained automatically by Release Please.

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
