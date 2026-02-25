import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface InitOptions {
  projectPath?: string;
  force?: boolean;
}

const DEFAULT_CONFIG_YAML = `version: "1"
project:
  name: ""
  root: "."
ingestion:
  scrapers: []
  watchPaths: []
  pollIntervalMs: 30000
  excludePatterns:
    - node_modules/**
    - dist/**
compaction:
  strategy: rule-based
  sessionBoundaryMinutes: 30
search:
  defaultMode: hybrid
  defaultDepth: summary
  defaultLimit: 10
domainTags: {}
web:
  port: 3232
`;

const DEFAULT_TOOL_CONFIG_YAML = `shared:
  skills: []
  commands: []
  agents: []
toolPreferences: {}
`;

export async function runInit(options: InitOptions = {}): Promise<void> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const xtctxDir = join(projectRoot, ".xtctx");
  const knowledgeDir = join(xtctxDir, "knowledge");
  const configFile = join(xtctxDir, "config.yaml");
  const toolConfigDir = join(xtctxDir, "tool-config");
  const toolConfigFile = join(toolConfigDir, "shared.yaml");
  const stateDir = join(xtctxDir, "state");

  await mkdir(xtctxDir, { recursive: true });
  await mkdir(knowledgeDir, { recursive: true });
  await mkdir(join(knowledgeDir, "decisions"), { recursive: true });
  await mkdir(join(knowledgeDir, "errors"), { recursive: true });
  await mkdir(join(knowledgeDir, "insights"), { recursive: true });
  await mkdir(join(knowledgeDir, "conventions"), { recursive: true });
  await mkdir(join(knowledgeDir, "gotchas"), { recursive: true });
  await mkdir(toolConfigDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  await writeIfMissing(configFile, DEFAULT_CONFIG_YAML, options.force ?? false);
  await writeIfMissing(toolConfigFile, DEFAULT_TOOL_CONFIG_YAML, options.force ?? false);

  console.log(`Initialized xtctx in ${xtctxDir}`);
}

async function writeIfMissing(
  filePath: string,
  content: string,
  force: boolean,
): Promise<void> {
  if (!force) {
    try {
      await readFile(filePath, "utf-8");
      return;
    } catch {
      // File missing, continue with write.
    }
  }

  await writeFile(filePath, content, "utf-8");
}
