#!/usr/bin/env node
/**
 * Cross-platform env-prefix runner used by npm scripts so we can set a single
 * env var before invoking a command without adding a `cross-env` dependency.
 *
 * Usage:
 *   node scripts/run-with-env.mjs KEY=VALUE [KEY2=VALUE2 ...] -- <cmd> [args...]
 *
 * The literal `--` separator is required to delimit env assignments from the
 * command. The child process inherits stdio and the parent's env.
 */
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const separatorIdx = argv.indexOf("--");
if (separatorIdx === -1) {
  console.error("run-with-env: missing '--' separator between env and command");
  process.exit(2);
}

const envPairs = argv.slice(0, separatorIdx);
const commandParts = argv.slice(separatorIdx + 1);
if (commandParts.length === 0) {
  console.error("run-with-env: no command supplied after '--'");
  process.exit(2);
}

const childEnv = { ...process.env };
for (const pair of envPairs) {
  const eqIdx = pair.indexOf("=");
  if (eqIdx === -1) {
    console.error(`run-with-env: expected KEY=VALUE, got: ${pair}`);
    process.exit(2);
  }
  childEnv[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
}

const [cmd, ...cmdArgs] = commandParts;
const child = spawn(cmd, cmdArgs, {
  env: childEnv,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
