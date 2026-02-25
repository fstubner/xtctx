import { describe, it, expect } from "vitest";
import { CliCompactionProvider } from "@xtctx/compaction/providers/cli";

describe("CliCompactionProvider", () => {
  it("runs external command and returns stdout", async () => {
    const provider = new CliCompactionProvider({
      command: process.execPath,
      args: [
        "-e",
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d.toUpperCase()));",
      ],
      timeoutMs: 5_000,
    });

    const output = await provider.summarize("hello cli provider");
    expect(output).toContain("HELLO CLI PROVIDER");
  });

  it("throws on non-zero exit code", async () => {
    const provider = new CliCompactionProvider({
      command: process.execPath,
      args: ["-e", "process.stderr.write('boom');process.exit(2);"],
      timeoutMs: 5_000,
    });

    await expect(provider.summarize("ignored")).rejects.toThrow("exit code 2");
  });
});
