---
title: Commands
description: Every xtctx command, option and MCP tool.
---

## Commands

| Command | What it does |
| --- | --- |
| `xtctx setup` | Sets up the current project: instruction files, MCP config, the Claude Code hook and skills. |
| `xtctx status` | Shows what's set up and indexed, and what to do next. |
| `xtctx scan` | Indexes the project's transcripts now. The MCP server also does this when it starts and on each tool call, reading only what's new. During a long first scan, tools answer with what's indexed so far and say which agents they haven't read yet. |
| `xtctx export` | Writes the project's indexed sessions to a JSON Lines file, including sessions whose transcripts are gone. Never overwrites a file. The file holds your raw conversations, so don't commit it. |
| `xtctx import <file>` | Merges an export into the project's index. Importing the same file twice adds nothing. |
| `xtctx embeddings enable` | Installs the local model and runtime for semantic search. Asks first. |
| `xtctx embeddings disable` | Removes them. Search goes back to keyword only. |
| `xtctx calibrate` | Measures which device embeds fastest and saves it in `~/.xtctx/device.json`. Also runs on its own the first time xtctx embeds. Needs semantic search. |
| `xtctx login` | Signs in to your cloud sync server with GitHub. Doesn't upload anything. |
| `xtctx sync [action]` | Cloud sync for the project: `enable`, `disable`, `status`, `device [name]`, `token`, or no action to upload once. See [Cloud sync](#cloud-sync). |
| `xtctx logout` | Signs out of cloud sync and revokes your tokens. |
| `xtctx disconnect [tool]` | Stops xtctx managing an agent in the project. Leaves transcripts alone. See [Remove xtctx](/docs/install/#remove-xtctx). |
| `xtctx` | Started by an MCP client, runs the MCP server. In a terminal, or with `XTCTX_NO_AUTO_MCP=1`, prints help. |

## Options

`setup`, `status`, `scan`, `export`, `import`, `sync` and `disconnect` take `-p, --project <path>` to work on another project.

| Option | Command | What it does |
| --- | --- | --- |
| `-y, --yes` | `setup`, `disconnect`, `embeddings enable` | Skips the question. Without a terminal, `setup` syncs only the built-in skill and skills already chosen in the config. |
| `--repair` | `setup` | Also removes files older versions left behind (`.xtctx/.store`, `.xtctx/tool-config`). Keeps the index. |
| `--global-mcp` | `setup` | Also writes Copilot CLI's machine-wide MCP config. |
| `--global-mcp` | `disconnect` | Also removes xtctx from Antigravity's and Copilot CLI's machine-wide configs. These affect every project, so they're left alone otherwise. |
| `--all` | `disconnect` | Disconnects every agent and deletes `.xtctx/skills`. |
| `-v, --verbose` | `status` | Adds each transcript format xtctx didn't recognise, skill hashes and full paths. |
| `--embed` | `scan` | Builds vectors for everything that doesn't have one yet. Needs semantic search. |
| `--no-calibrate` | `scan` | With `--embed`, skips measuring devices. |
| `-o, --out <file>` | `export` | Defaults to `xtctx-export-<time>.jsonl` in the current folder. `-` writes to stdout. |
| `--force` | `calibrate` | Measures again, for example after a hardware change. |
| `--device <name>` | `login` | The name this device shows in the cloud. Defaults to a random label. |
| `--sync-url <url>` | `login` | Your sync server's URL. Required, unless `XTCTX_SYNC_URL` is set. |
| `-w, --watch` | `sync` | Uploads every 10 seconds until you stop it. |
| `--delete-data` | `logout` | Also deletes everything you uploaded. |

## Semantic search

Search is keyword only until you run `xtctx embeddings enable`. After that, the MCP server builds vectors in the background, as long as this machine can finish the backlog in about 15 minutes. If it can't, `xtctx status` tells you to run `xtctx scan --embed`. While vectors are missing or the model isn't available, search falls back to keyword, and `xtctx status` says why.

## Cloud sync

Cloud sync is optional and off by default. There is no hosted xtctx server, so first deploy the Worker in [`cloud/`](https://github.com/fstubner/xtctx/tree/main/cloud) to your own Cloudflare account. A project only uploads after both of these steps:

1. Run `xtctx login --sync-url <your server>`.
2. In each project you want to upload, run `xtctx sync enable`.

After that, the project's transcript text is uploaded to your server, where agents on your other machines can read it over MCP. While an agent has the MCP server running in the project, it uploads every 10 seconds.

:::caution
Messages are uploaded as written, so they can include file paths, command output and secrets. Only turn on sync for projects whose transcripts you are willing to upload.
:::

`xtctx sync disable` stops uploading and keeps what's already there. `xtctx logout --delete-data` deletes it. `xtctx sync token` prints a read-only token for an MCP client that can't sign in itself.

[Cloud sync](https://github.com/fstubner/xtctx/blob/main/docs/cloud-sync.md) lists exactly what is and isn't uploaded.

## MCP tools

| Tool | What it does |
| --- | --- |
| `xtctx_recent_sessions` | Lists recent sessions from every indexed agent. |
| `xtctx_session_detail` | Returns one session's raw messages by `session_ref`, or the newest session's. |
| `xtctx_search_sessions` | Searches across sessions and returns the ones that match. |
| `xtctx_continuity_status` | Shows setup and index diagnostics. |
| `xtctx_handoff_manifest` | Returns stable session references and detail pointers for an orchestrator. |

`xtctx_search_sessions` takes a `mode`: `hybrid` (the default: keyword, plus meaning when semantic search is on), `keyword`, `vector` or `literal`. `vector` fails when semantic search is off. `literal` searches the transcript files directly instead of the index, so it works before indexing has finished.
