import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { describeSetupPlan, runSetup as setup } from "../config/setup.js";

export interface SetupCliOptions {
  projectPath?: string;
  yes?: boolean;
  repair?: boolean;
}

export async function runSetup(options: SetupCliOptions = {}): Promise<void> {
  if (!options.yes) {
    const confirmed = await confirmSetup(options.projectPath);
    if (!confirmed) {
      process.stdout.write("xtctx setup cancelled.\n");
      return;
    }
  }

  await setup({
    projectPath: options.projectPath,
    yes: options.yes,
    repair: options.repair,
  });
}

async function confirmSetup(projectPath?: string): Promise<boolean> {
  const plan = describeSetupPlan(projectPath);
  process.stdout.write(`xtctx setup will configure handoff for ${plan.projectRoot}\n`);
  for (const write of plan.writes) {
    process.stdout.write(`  ${write.kind.padEnd(22)} ${write.path}\n`);
  }

  if (input.isTTY !== true || output.isTTY !== true) {
    throw new Error("Refusing non-interactive setup without --yes.");
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Apply these changes? [y/N] ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}
