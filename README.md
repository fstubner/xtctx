# xtctx

[![CI](https://github.com/fstubner/xtctx/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/ci.yml)
[![Site Deploy](https://github.com/fstubner/xtctx/actions/workflows/deploy-site.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/deploy-site.yml)
[![Release](https://github.com/fstubner/xtctx/actions/workflows/release.yml/badge.svg)](https://github.com/fstubner/xtctx/actions/workflows/release.yml)
[![npm Publish](https://github.com/fstubner/xtctx/actions/workflows/publish.yml/badge.svg)](https://github.com/fstubner/xtctx/actions/workflows/publish.yml)
[![Latest Release](https://img.shields.io/github/v/release/fstubner/xtctx?display_name=tag&sort=semver)](https://github.com/fstubner/xtctx/releases)
[![License](https://img.shields.io/github/license/fstubner/xtctx)](LICENSE)
[![Node >=24](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

xtctx indexes the transcripts that AI coding agents write on your machine and
serves them over MCP. An agent in a project can list recent sessions from
every supported agent and read their messages.

xtctx doesn't write summaries or run a background service. Transcripts stay on
your machine unless a project turns on cloud sync or a remote embedding
endpoint (see [Privacy](#privacy)).

Documentation: [xtctx.com/docs](https://xtctx.com/docs/).

## Install

xtctx needs Node.js 24 or later. Install it as a plugin, set it up per
project, or both.

**The plugin** adds the MCP server and the handoff skill to your agent, once
per machine. It writes nothing into your projects.

```bash
claude plugin marketplace add fstubner/xtctx && claude plugin install xtctx@xtctx
```

```bash
codex plugin marketplace add fstubner/xtctx && codex plugin add xtctx@xtctx
```

```bash
copilot plugin marketplace add fstubner/xtctx && copilot plugin install xtctx@xtctx
```

```bash
agy plugin install https://github.com/fstubner/xtctx
```

In Cursor, add the marketplace from the agent CLI, then install from
`/plugins` in a chat:

```bash
cursor-agent plugin marketplace add https://github.com/fstubner/xtctx
```

VS Code installs plugins from the Chat view once `chat.plugins.enabled` is
on. opencode has no support for this plugin format, so use `setup` there.

**`xtctx setup`** sets up one project. Run it in the project root:

```bash
npx -y xtctx setup
```

It adds the MCP server to each agent's project config and adds a short xtctx
section to the instruction files the agents read (`CLAUDE.md`, `AGENTS.md`,
Cursor rules and so on), telling them which tools to use. In Claude Code it
also installs a session-start hook that shows the agent the most recent
session and how to read it.

Retrieval only works in a project that has been set up. Elsewhere the tools
reply that the project isn't configured and give the setup command, so the
agent can offer to run it.

| | Plugin | `setup` |
|---|---|---|
| MCP tools and handoff skill | yes | yes |
| Available in every project | yes | no |
| Can read sessions in a project that hasn't run `setup` | no | no |
| Most recent session shown at session start | no | Claude Code only |
| Instruction files tell the agent about xtctx | no | yes |
| Writes into your project | no | yes |
| Agents covered | six | seven (Copilot CLI with `--global-mcp`) |

The plugin runs `npx -y xtctx`, the latest version on npm. Setup pins the
version that ran it (`npx -y xtctx@<version>`), and running setup again moves
the pin. The plugin's skill text comes from this repository's `main` branch,
so it can mention features that haven't reached npm yet.

### Semantic search (optional)

Search matches keywords by default, and the base install is about 55 MB. To
also match by meaning, install the local embedding model once per machine:

```bash
npx -y xtctx embeddings enable
```

It asks before downloading about 540 MB into `~/.xtctx/embeddings`; pass
`--yes` in scripts. `xtctx embeddings disable` removes it again and leaves
your index, vectors included, as it is.

Once it's installed, the MCP server builds vectors in the background when
the remaining work fits in about fifteen minutes. For a bigger backlog,
`xtctx status` tells you to run `xtctx scan --embed`. Until vectors exist,
search falls back to keyword.

The first time it embeds, xtctx times the model on each device it can use and
keeps the fastest in `~/.xtctx/device.json`. On a machine with a usable GPU
that has measured about six times faster than the CPU. `xtctx calibrate
--force` measures again, for example after a hardware change.

A project can use an OpenAI-compatible embedding endpoint instead
([`docs/embedding-providers.md`](docs/embedding-providers.md)), and then needs
no local model.

### The first scan

In a project with a long history, the first scan builds the index from
scratch and can take minutes. The MCP server starts the scan when it starts and
answers while it runs: each reply uses what has been indexed so far and says which
agents' transcripts it hasn't read yet. After that, scans only read what each
agent has added.

## Commands

| Command | What it does |
|---|---|
| `xtctx setup` | Sets up this project (see above). `--global-mcp` also writes Copilot CLI's machine-wide config. |
| `xtctx status` | Shows the config, the index, each agent's transcripts and hooks, and anything that has drifted. |
| `xtctx scan` | Indexes new transcript content now. The MCP server also does this every time it starts. `--embed` finishes building vectors in one go. |
| `xtctx export` | Writes this project's indexed sessions to a JSON Lines file. |
| `xtctx import <file>` | Merges an export back into the index. |
| `xtctx disconnect <tool>` | Stops xtctx managing one agent in this project. `--all` does every agent. |
| `xtctx embeddings enable` / `disable` | Adds or removes local semantic search. |
| `xtctx calibrate` | Measures which device embeds fastest. |
| `xtctx login --sync-url <url>`, `xtctx sync enable`, `xtctx logout` | Cloud sync ([`docs/cloud-sync.md`](docs/cloud-sync.md)). |

Every option is listed at [xtctx.com/docs/commands](https://xtctx.com/docs/commands/).

Started by an MCP client, `xtctx` runs the MCP server. Run in a terminal, it
shows the CLI. To add it to an MCP client by hand:

```json
{
  "mcpServers": {
    "xtctx": {
      "command": "npx",
      "args": ["-y", "xtctx@<version>"]
    }
  }
}
```

### Disconnecting

`xtctx disconnect <tool>` removes xtctx's MCP entry, instruction section,
hooks and generated skill files for that agent, and marks it disabled in
`.xtctx/config.yaml`. It never deletes transcripts, your skills or the index.
`--all` also deletes `.xtctx/skills`, apart from skills you wrote yourself.

Antigravity and Copilot CLI each keep one MCP config for all projects. Setup
always writes Antigravity's, because Antigravity has no project-level MCP
config, and writes
Copilot CLI's only with `--global-mcp`. Disconnecting a project leaves both
files alone. Pass `--global-mcp` to remove xtctx from them, which removes it
for every project on the machine.

To remove xtctx completely, run `xtctx disconnect --all --global-mcp` in each
project, then delete each project's `.xtctx` folder. Export first if you want
to keep sessions whose transcripts are gone.

## Your index

Each project's index lives in `.xtctx/state/xtctx.db`. Claude Code deletes
transcripts after 30 days by default, but xtctx keeps what it indexed, so for
older sessions the index can be the only copy left.

xtctx never deletes it. Upgrades migrate it in place, and a damaged one is set
aside and rebuilt with its sessions copied back in. `xtctx status` tells you
how many sessions exist only in the index.

`xtctx export` backs it up to `xtctx-export-<time>.jsonl` in the current
folder (`--out <file>` to choose, `--out -` for stdout). It never overwrites a
file. `xtctx import <file>` merges a backup into any project's index, and
importing the same file twice adds nothing new.

The index and its exports hold your raw conversations. Don't commit them.

## MCP tools

- `xtctx_recent_sessions`: recent sessions in this project.
- `xtctx_session_detail`: the raw messages of one session.
- `xtctx_search_sessions`: searches across sessions, by keyword and, once it's
  enabled, by meaning. `mode: "literal"` searches the transcript files
  directly, so it finds exact text before the index has caught up. It reports
  when it stops at its result limit or time budget.
- `xtctx_continuity_status`: setup and index diagnostics.
- `xtctx_handoff_manifest`: stable session IDs and detail pointers for an
  external orchestrator. xtctx keeps no task state of its own
  ([`docs/orchestrator-integration.md`](docs/orchestrator-integration.md)).

Search runs over overlapping windows of the raw messages and returns the
matching message range.

With both the plugin and `setup` in Claude Code, the same server shows up
twice, as `xtctx` and `plugin:xtctx:xtctx`. Setup allows the tools under both
names in `.claude/settings.json`, which Claude Code applies once you trust the
workspace.

## Supported agents

- Claude Code
- Codex
- Cursor
- GitHub Copilot (VS Code)
- GitHub Copilot CLI
- Google Antigravity
- opencode

Some agents get a startup hook and others only an instruction section.
`xtctx status` shows which.

xtctx reads Antigravity's conversations from its running language server when
it can, and otherwise from its readable `brain` files. Its encrypted `.pb`
files aren't read.

Each agent controls its own transcript format, and formats can change between
versions. xtctx reports records it doesn't recognise instead of guessing, and
`xtctx status` reports them.

## Skills

Setup keeps project skills in `.xtctx/skills/<skill-id>/SKILL.md`, starting
with the built-in `xtctx-handoff` skill. Interactive setup lets you pick other
skills from your agents to keep in sync. `setup --yes` syncs only the
built-in skill and ones you picked before.

Setup writes them to:

- Claude Code: `.claude/skills/`
- Cursor: `.cursor/rules/xtctx-skills/`
- GitHub Copilot: `.github/instructions/`
- Antigravity, Codex, opencode and Copilot CLI: a pointer in their
  instruction section (`GEMINI.md`, `AGENTS.md` or Copilot's instructions)

## Files in your project

- `.xtctx/config.yaml`: settings
- `.xtctx/skills/`: project skills
- `.xtctx/state/xtctx.db`: the index; back it up, never commit it
- An xtctx section in `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
  `.cursor/rules/xtctx.mdc` and `.github/copilot-instructions.md`, where the
  agent uses that file

xtctx only edits between its `<!-- xtctx:begin -->` and `<!-- xtctx:end -->`
markers. Run `xtctx setup --yes` again to repair those sections.

## Privacy

xtctx sends no telemetry. Transcripts leave your machine only if a project
turns on one of these:

- **Cloud sync.** Nothing is sent until you log in (`xtctx login`) and enable
  it for the project (`xtctx sync enable`). Then that project's transcript
  text goes to your own sync server, including any paths or output the agents
  wrote into it, and your other machines' agents can read it over MCP. There
  is no hosted xtctx service and no default server.
- **An external embedding endpoint**, written into `.xtctx/config.yaml`.
  Search windows are sent there to be embedded. xtctx never picks one up
  from an environment variable.

`xtctx status` shows both whenever they're on.

## Development

```bash
npm ci
npm --prefix site ci
npm run verify:release
```

Individual checks:

```bash
npm test
npm run test:drift
npm run lint
npm run build
npm run demo:public
```

`npm test` leaves out the smoke, drift and eval suites, which build, start
processes and load a real embedding model. What each suite covers and what it
can't catch is in [`docs/testing-strategy.md`](docs/testing-strategy.md).

Indexing speed measurements, including approaches that were tried and
rejected, are in [`docs/embedding-performance.md`](docs/embedding-performance.md).

`npm run demo:public` builds fake Claude Code and Codex transcripts in a
temporary project, starts the MCP server and calls the tools, without
touching your real transcripts ([`docs/demo.md`](docs/demo.md)).

## Releasing

Releases are manual. To release, run the **release** workflow, pick
`patch`, `minor` or `major`, and type `release`. It runs `verify:release`,
bumps the version, moves the notes under `[Unreleased]` in `CHANGELOG.md` to
the new version, tags, creates the GitHub release and publishes to npm.

Untick `publish_npm` to skip npm. The **publish** workflow publishes an
existing tag later, and checks the commit really carries that tag first.
Details are in [`docs/release.md`](docs/release.md).
