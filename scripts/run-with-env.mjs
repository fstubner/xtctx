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
import { existsSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

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
const child = spawn(windowsCommand(cmd), cmdArgs, {
  env: childEnv,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

/**
 * Resolve a bare command name to a real file on Windows.
 *
 * `spawn` there will not run a `.cmd`/`.bat` shim under its bare name, which
 * is what `shell: true` used to paper over — but Node deprecated that
 * alongside an args array (DEP0190), and a shell would also reinterpret the
 * arguments, which is wrong when one of them is a prompt. So look the command
 * up on PATH the way the shell would and hand `spawn` the actual file.
 *
 * Guessing an extension is not enough: the same tool is `npm.cmd` on a plain
 * install and `npm.exe` under a version manager, and naming the wrong one
 * fails with EINVAL rather than falling back. Returns the name unchanged when
 * nothing matches, so the failure is spawn's own.
 */
function windowsCommand(cmd) {
  if (process.platform !== "win32") return cmd;
  if (isAbsolute(cmd) || cmd.includes("/") || cmd.includes("\\")) return cmd;
  if (extname(cmd)) return cmd;

  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = join(dir, cmd + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return cmd;
}
