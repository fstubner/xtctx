# xtctx

[![CI](https://github.com/fstubner/xtctx/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/ci.yml)
[![Site Deploy](https://github.com/fstubner/xtctx/actions/workflows/deploy-site.yml/badge.svg?branch=main)](https://github.com/fstubner/xtctx/actions/workflows/deploy-site.yml)
[![Release](https://github.com/fstubner/xtctx/actions/workflows/release.yml/badge.svg)](https://github.com/fstubner/xtctx/actions/workflows/release.yml)
[![npm Publish](https://github.com/fstubner/xtctx/actions/workflows/publish.yml/badge.svg)](https://github.com/fstubner/xtctx/actions/workflows/publish.yml)
[![Latest Release](https://img.shields.io/github/v/release/fstubner/xtctx?display_name=tag&sort=semver)](https://github.com/fstubner/xtctx/releases)
[![License](https://img.shields.io/github/license/fstubner/xtctx)](LICENSE)
[![Node >=24](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

xtctx lets one AI coding agent pick up where another left off.

Claude Code, Codex, Cursor and the rest each keep their own transcripts on
your machine. xtctx indexes them per project and serves them over MCP, so when
you switch agents, the new one can look up what the last one did and read the
actual conversation. There are no summaries, no memory layer and no
background service. It reads the files your agents already write.

Everything stays on your machine. The one exception is cloud sync, which is
off by default and only talks to a server you deploy yourself
([`docs/cloud-sync.md`](docs/cloud-sync.md)).

Documentation: [xtctx.com/docs](https://xtctx.com/docs/).

## Install

There are two ways in, and most people end up using both.

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
also installs a session-start hook that reminds the agent recent sessions are
there to look up.

Retrieval only works in a project that has been set up. Elsewhere the tools
reply that the project isn't configured and give the setup command, so the
agent can offer to run it.

| | Plugin | `setup` |
|---|---|---|
| MCP tools and handoff skill | yes | yes |
| Available in every project | yes | no |
| Can read sessions in a project that hasn't run `setup` | no | no |
| Reminder at session start | no | Claude Code only |
| Instruction files tell the agent about xtctx | no | yes |
| Writes into your project | no | yes |
| Agents covered | six | all seven |

The plugin runs `npx -y xtctx`, the latest version on npm. Setup pins the
version that ran it (`npx -y xtctx@<version>`), and running setup again moves
the pin. The plugin's skill text comes from this repository's `main` branch,
so it can mention features that haven't reached npm yet.

### Semantic search (optional)

xtctx searches by keyword out of the box. The base install is about 55 MB
with nothing extra to download. To also search by meaning, install the local
embedding model once per machine:

```bash
npx -y xtctx embeddings enable
```

It asks before downloading about 540 MB into `~/.xtctx/embeddings`; pass
`--yes` in scripts. `xtctx embeddings disable` removes it again and leaves
your index, vectors included, as it is. The model isn't bundled because it
pushed the first start past two minutes, which is longer than some MCP clients
wait.

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
scratch and can take minutes. The server starts it straight away and answers
while it runs: each reply uses what has been indexed so far and says which
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
| `xtctx login`, `xtctx sync enable` | Cloud sync ([`docs/cloud-sync.md`](docs/cloud-sync.md)). |

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
always writes Antigravity's, because it has nowhere else to go, and writes
Copilot CLI's only with `--global-mcp`. Disconnecting a project leaves both
files alone. Pass `--global-mcp` to remove xtctx from them, which removes it
for every project on the machine.

To remove xtctx completely, run `xtctx disconnect --all --global-mcp` in each
project, then delete each project's `.xtctx` folder. Export first if you want
to keep sessions whose transcripts are gone.

## Your index

Each project's index lives in `.xtctx/state/xtctx.db`. Agents delete old
transcripts (Claude Code after 30 days by default), but xtctx keeps what it
indexed, so for older sessions the index can be the only copy left.

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
  directly, so it finds exact text before the index has caught up. It says
  when it stopped early instead of reporting fewer results as all there is.
- `xtctx_continuity_status`: setup and index diagnostics.
- `xtctx_handoff_manifest`: stable session IDs and detail pointers for an
  external orchestrator. xtctx keeps no task state of its own
  ([`docs/orchestrator-integration.md`](docs/orchestrator-integration.md)).

Search works on overlapping windows of the raw conversation, never on
summaries, and points back to the matching messages.

With both the plugin and `setup` in Claude Code, the same server shows up
twice, as `xtctx` and `plugin:xtctx:xtctx`. Setup allows the tools under both
names, so neither asks for permission.

## Supported agents

- Claude Code
- Codex
- Cursor
- GitHub Copilot (VS Code)
- GitHub Copilot CLI
- Google Antigravity
- opencode

Agents differ in what can be set up for them: some get hooks, some only an
instruction section. `xtctx status` shows what each one has.

xtctx reads Antigravity's conversations from its running language server when
it can, and otherwise from its readable `brain` files. Its encrypted `.pb`
files aren't read.

Transcript formats belong to each agent and change without notice. xtctx
reports records it doesn't recognise instead of guessing, and `xtctx status`
is where to check.

## Skills

Setup keeps project skills in `.xtctx/skills/<skill-id>/SKILL.md`, starting
with the built-in `xtctx-handoff` skill. Interactive setup lets you pick other
skills from your agents to keep in sync. `setup --yes` syncs only the
built-in skill and ones you picked before.

Each agent gets them where it looks for them:

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

Day to day:

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

Before working on indexing speed, read
[`docs/embedding-performance.md`](docs/embedding-performance.md). Several of
the obvious ideas have already been measured and lost.

`npm run demo:public` builds fake Claude Code and Codex transcripts in a
temporary project, starts the MCP server and calls the tools, without
touching your real transcripts ([`docs/demo.md`](docs/demo.md)).

## Releasing

Merging releases nothing. To release, run the **release** workflow, pick
`patch`, `minor` or `major`, and type `release`. It runs `verify:release`,
bumps the version, moves the notes under `[Unreleased]` in `CHANGELOG.md` to
the new version, tags, creates the GitHub release and publishes to npm.

Untick `publish_npm` to skip npm. The **publish** workflow publishes an
existing tag later, and checks the commit really carries that tag first.
[`docs/release.md`](docs/release.md) has the details and the history behind
them.
