import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createProjectServices } from "../runtime/services.js";
import { headerLine, sessionLine, endLine } from "../handoff/export-file.js";
import { archiveWebConversation, parseWebExport, type WebProvider, type WebConversation } from "../web/history.js";
import { runDiffSync } from "../sync/diff-sync.js";
export async function readWebJson(path: string, maximum = 128 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    if (size > maximum) throw new Error("Web export exceeds the 128 MiB import limit; split the export first");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export async function importWebConversations(provider: WebProvider, account: string, conversations: WebConversation[], project: string) {
  // Normalize and validate the entire batch before opening/writing the index.
  const archived = conversations.map((c) => archiveWebConversation(provider, account, c, resolve(project)));
  const services = await createProjectServices(project);
  try {
    if (!services.config.present || services.config.error || !services.sessions.importSessions) throw new Error("Set up the chosen web-history project with xtctx setup first");
    async function* lines() {
      yield headerLine(services.projectRoot);
      for (const session of archived) yield sessionLine(session);
      yield endLine(archived.length, archived.reduce((n,c) => n+c.messages.length,0));
    }
    const summary = await services.sessions.importSessions(lines());
    if (!summary.complete || summary.invalidLines.length) throw new Error("Web import was incomplete");
    return summary;
  } finally { await services.sessions.close(); }
}
export async function runWebImport(file: string, options: { provider: string; account: string; project: string; dryRun?: boolean; sync?: boolean }): Promise<void> {
  if (options.provider !== "chatgpt" && options.provider !== "claude") throw new Error("Provider must be chatgpt or claude");
  const conversations = parseWebExport(options.provider, await readWebJson(resolve(file)));
  // Validate identity and roles in dry runs too.
  const archived = conversations.map((c) => archiveWebConversation(options.provider as WebProvider, options.account,c,resolve(options.project)));
  const report = { conversations: archived.length, messages: archived.reduce((n,c) => n+c.messages.length,0),
    nonTextBlocks: conversations.reduce((n,c) => n+c.messages.reduce((s,m) => s+m.nonTextBlocks,0),0) };
  if (options.dryRun) { console.log(JSON.stringify({ dryRun:true,...report })); return; }
  const result = await importWebConversations(options.provider,options.account,conversations,options.project);
  console.log(JSON.stringify({ ...report,...result }));
  if (options.sync) console.log(JSON.stringify({sync:await runDiffSync({projectDir:resolve(options.project)})}));
}
