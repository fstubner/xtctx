import { spawn } from "node:child_process";

export interface CliCompactionProviderOptions {
  command: string;
  args?: string[];
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export class CliCompactionProvider {
  constructor(private readonly options: CliCompactionProviderOptions) {}

  async summarize(input: string): Promise<string> {
    const timeoutMs = this.options.timeoutMs ?? 60_000;

    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args ?? [], {
        cwd: this.options.cwd,
        env: {
          ...process.env,
          ...(this.options.env ?? {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`CLI provider timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);

        if (code !== 0) {
          reject(new Error(`CLI provider failed with exit code ${code}: ${stderr.trim()}`));
          return;
        }

        resolve(stdout.trim());
      });

      child.stdin.write(input);
      child.stdin.end();
    });
  }
}
