import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ContextRecord, ContextType } from "../types/context.js";

const TYPE_DIRS: Record<ContextType, string> = {
  decision: "decisions",
  error_solution: "errors",
  insight: "insights",
  convention: "conventions",
  gotcha: "gotchas",
};

export class KnowledgeRepository {
  constructor(private readonly knowledgeDir: string) {}

  async initialize(): Promise<void> {
    for (const dir of Object.values(TYPE_DIRS)) {
      await mkdir(join(this.knowledgeDir, dir), { recursive: true });
    }
  }

  async save(record: ContextRecord): Promise<void> {
    const dir = TYPE_DIRS[record.type];
    const filePath = join(this.knowledgeDir, dir, `${record.id}.yaml`);
    await writeFile(filePath, stringifyYaml(record), "utf-8");
  }

  async getById(id: string): Promise<ContextRecord | null> {
    for (const dir of Object.values(TYPE_DIRS)) {
      const filePath = join(this.knowledgeDir, dir, `${id}.yaml`);
      try {
        const content = await readFile(filePath, "utf-8");
        return parseYaml(content) as ContextRecord;
      } catch {
        continue;
      }
    }

    return null;
  }

  async listByType(type: ContextType): Promise<ContextRecord[]> {
    const dir = TYPE_DIRS[type];
    const dirPath = join(this.knowledgeDir, dir);

    try {
      const files = await readdir(dirPath);
      const records: ContextRecord[] = [];

      for (const file of files) {
        if (!file.endsWith(".yaml")) {
          continue;
        }

        const content = await readFile(join(dirPath, file), "utf-8");
        records.push(parseYaml(content) as ContextRecord);
      }

      return records.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    } catch {
      return [];
    }
  }

  async listAll(): Promise<ContextRecord[]> {
    const all: ContextRecord[] = [];

    for (const type of Object.keys(TYPE_DIRS) as ContextType[]) {
      all.push(...(await this.listByType(type)));
    }

    return all.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }

  async supersede(oldId: string, newId: string): Promise<void> {
    const old = await this.getById(oldId);
    if (old) {
      old.superseded_by = newId;
      await this.save(old);
    }
  }
}
