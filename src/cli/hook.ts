import { createProjectServices } from "../runtime/services.js";

export interface HookOptions {
  projectPath?: string;
  tool?: string;
  event?: string;
}

export async function runHook(options: HookOptions = {}): Promise<void> {
  if (options.event && options.event !== "session-start") {
    return;
  }

  const services = await createProjectServices(options.projectPath);
  const status = await services.sessions.getStatus();
  const tool = options.tool ?? "unknown";

  process.stdout.write(
    [
      "# xtctx handoff",
      "",
      `Tool: ${tool}`,
      `Project root: ${services.projectRoot}`,
      `Last scan: ${status.last_scan_at ?? "never"}`,
      "",
      "Recent transcript context is available through MCP.",
      "Call `xtctx_recent_sessions`, then `xtctx_session_detail` for relevant sessions.",
      "",
    ].join("\n"),
  );
}
