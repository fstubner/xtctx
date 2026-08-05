import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import { describeSetupPlan, runSetup as setup } from "../config/setup.js";
import { BUILT_IN_SKILL_ID, discoverProjectSkills } from "../config/skills.js";

export interface SetupCliOptions {
  projectPath?: string;
  yes?: boolean;
  repair?: boolean;
  includeGlobalMcp?: boolean;
}

export async function runSetup(options: SetupCliOptions = {}): Promise<void> {
  const selectedSkillIds = options.yes ? undefined : await promptSkillSelection(options.projectPath);
  if (!options.yes) {
    const confirmed = await confirmSetup(options, selectedSkillIds);
    if (!confirmed) {
      process.stdout.write("xtctx setup cancelled.\n");
      return;
    }
  }

  const result = await setup({
    projectPath: options.projectPath,
    yes: options.yes,
    repair: options.repair,
    selectedSkillIds,
    includeGlobalMcp: options.includeGlobalMcp,
  });

  const hasCriticalFailure = result.warnings.some((w) => w.includes("Failed to"));
  if (hasCriticalFailure) {
    process.exitCode = 1;
  }
}

async function promptSkillSelection(projectPath?: string): Promise<string[] | undefined> {
  if (input.isTTY !== true || output.isTTY !== true) {
    return undefined;
  }

  const projectRoot = resolve(projectPath ?? process.cwd());
  const skills = (await discoverProjectSkills({ projectRoot }))
    .filter((skill) => skill.id !== BUILT_IN_SKILL_ID)
    .sort((left, right) => left.id.localeCompare(right.id));

  process.stdout.write("xtctx will sync the built-in xtctx-handoff skill.\n");
  if (skills.length === 0) {
    process.stdout.write("No additional project or user skills were discovered.\n");
    return [BUILT_IN_SKILL_ID];
  }

  process.stdout.write("Additional skills discovered:\n");
  skills.forEach((skill, index) => {
    process.stdout.write(`  ${String(index + 1).padStart(2)} ${skill.id} (${skill.source})\n`);
  });

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Add skills by number, comma separated. Press Enter for built-in only. ");
    const selected = answer
      .split(",")
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0 && value <= skills.length)
      .map((value) => skills[value - 1]?.id)
      .filter((value): value is string => Boolean(value));
    return [BUILT_IN_SKILL_ID, ...selected];
  } finally {
    rl.close();
  }
}

async function confirmSetup(options: SetupCliOptions, selectedSkillIds?: string[]): Promise<boolean> {
  const plan = describeSetupPlan(options.projectPath, selectedSkillIds, options.includeGlobalMcp);
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
