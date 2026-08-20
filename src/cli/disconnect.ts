import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  describeDisconnectPlan,
  disconnectProject,
  printDisconnectResult,
} from "../config/disconnect.js";

export interface DisconnectCliOptions {
  projectPath?: string;
  tool?: string;
  all?: boolean;
  yes?: boolean;
  homeDir?: string;
}

export async function runDisconnect(options: DisconnectCliOptions = {}): Promise<void> {
  if (options.yes) {
    // `--yes` skips the prompt, not the disclosure. Antigravity keeps its MCP
    // config at app level, so disconnecting here removes xtctx from
    // Antigravity for every project on the machine — which was previously
    // only mentioned once the files had been written.
    const plan = describeDisconnectPlan(options);
    for (const warning of plan.warnings) {
      process.stdout.write(`  warning ${warning}\n`);
    }
  } else {
    const confirmed = await confirmDisconnect(options);
    if (!confirmed) {
      process.stdout.write("xtctx disconnect cancelled.\n");
      return;
    }
  }

  const result = await disconnectProject({
    projectPath: options.projectPath,
    tool: options.tool,
    all: options.all,
    homeDir: options.homeDir,
  });
  printDisconnectResult(result);
  printLeftovers(result.projectRoot);
}

/**
 * Disconnect unwires xtctx from other tools; it does not delete the project's
 * own directory, which holds an index built from transcript content. Leaving
 * that unmentioned makes "disconnect" sound more complete than it is.
 */
function printLeftovers(projectRoot: string): void {
  process.stdout.write(
    `  left in place ${join(projectRoot, ".xtctx")} ` +
      `(config and the local indexed transcript content — delete the directory to remove it)\n`,
  );
}

async function confirmDisconnect(options: DisconnectCliOptions): Promise<boolean> {
  const plan = describeDisconnectPlan(options);
  process.stdout.write(`xtctx disconnect will remove handoff management for ${plan.tools.join(", ")}\n`);
  process.stdout.write(`Project: ${plan.projectRoot}\n`);
  for (const write of plan.writes) {
    const note = write.note ? ` (${write.note})` : "";
    process.stdout.write(`  ${write.kind.padEnd(22)} ${write.path}${note}\n`);
  }
  for (const warning of plan.warnings) {
    process.stdout.write(`  warning ${warning}\n`);
  }

  if (input.isTTY !== true || output.isTTY !== true) {
    throw new Error("Refusing non-interactive disconnect without --yes.");
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Apply these changes? [y/N] ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}
