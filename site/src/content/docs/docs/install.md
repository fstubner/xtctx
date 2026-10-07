---
title: Installation
description: Install, set up, verify and remove xtctx, and enable semantic search.
---

xtctx needs Node.js 24 or later.

## Plugin and setup

The plugin is installed once per agent and makes the xtctx tools and the handoff skill available in every project. Setup is run once per project and writes the files listed under [Set up a project](#set-up-a-project).

In a project that hasn't been set up, the tools don't read anything. They reply that the project isn't configured and give the setup command, so the agent can offer to run it.

## Install the plugin

```bash
claude plugin marketplace add fstubner/xtctx
claude plugin install xtctx@xtctx

codex plugin marketplace add fstubner/xtctx
codex plugin add xtctx@xtctx

copilot plugin marketplace add fstubner/xtctx
copilot plugin install xtctx@xtctx

agy plugin install https://github.com/fstubner/xtctx

cursor-agent plugin marketplace add https://github.com/fstubner/xtctx
```

In Cursor, finish by installing xtctx from `/plugins` in a chat. In VS Code, turn on `chat.plugins.enabled` and install it from the Chat view. opencode doesn't support this plugin format, so use setup there.

## Set up a project

1. In the project root, run:

   ```bash
   npx -y xtctx setup
   ```

2. Restart any agent that was already open. Agents only read their MCP config when they start.

Setup writes:

- An xtctx section in each agent's instruction file, telling the agent which xtctx tools to use.
- An MCP config entry for each agent, pinned to the xtctx version you ran. Run setup again to update it.
- For Claude Code, a `SessionStart` hook that reminds the agent recent sessions are there to look up.
- The handoff skill, in each agent's own format.
- `.xtctx/config.yaml`, and a `.gitignore` that keeps the index out of git.

Antigravity's MCP config is machine-wide, so setup always writes there. Copilot CLI's is machine-wide too, and setup only writes it with `--global-mcp`.

:::note
Claude Code only applies the tool permissions setup writes to `.claude/settings.json` in a trusted workspace. Open the project in Claude Code once and accept the trust prompt, or it will refuse the xtctx tools.
:::

## Check it worked

Run `npx -y xtctx status`. It shows which agents are set up, how many sessions are indexed for each, and what to do next.

- Before any agent has used an xtctx tool, it shows `Scan never` and no sessions.
- With only the plugin installed, it says the config is missing and to run `xtctx setup`.

## Turn on semantic search

Search matches keywords by default, and the install is about 55 MB. Semantic search also matches by meaning, using a model that runs on your machine.

It's set per machine, so it works the same for plugin and setup installs. Run `npx -y xtctx embeddings enable` and confirm (`--yes` skips the question). The model and its runtime go into `~/.xtctx/embeddings`, about 540 MB, and the MCP server then builds vectors in the background; see [Semantic search](/docs/commands/#semantic-search). `npx -y xtctx embeddings disable` turns it off again.

A project that uses a remote embedding endpoint doesn't need the local model; see [Embedding providers](https://github.com/fstubner/xtctx/blob/main/docs/embedding-providers.md).

## Remove xtctx

To stop xtctx managing one agent in a project:

```bash
npx -y xtctx disconnect <tool>
```

`<tool>` is `claude-code`, `cursor`, `codex`, `copilot`, `antigravity`, `opencode` or `copilot-cli`. This removes the agent's MCP entry, xtctx section, hook and skill files, and marks it disabled in `.xtctx/config.yaml`. If several agents read the same instruction file, its xtctx section stays until all of them are disconnected.

`--yes` skips the confirmation, and you need it when there's no terminal. For `--all` and `--global-mcp`, see [Options](/docs/commands/#options). Disconnecting never deletes your transcripts, `.xtctx/config.yaml` or the index.

:::caution
To remove xtctx from a machine, run `xtctx disconnect --all --global-mcp` in each project you set up, then delete each project's `.xtctx` folder. Run `xtctx export` first: for sessions whose transcripts are already deleted, the index is the only copy.
:::
