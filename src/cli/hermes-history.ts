import Database from "better-sqlite3";
import { resolve } from "node:path";
import { hashParts } from "../handoff/hash.js";
import type { ArchivedSession } from "../handoff/archive.js";
import { headerLine, sessionLine, endLine } from "../handoff/export-file.js";
import { createProjectServices } from "../runtime/services.js";
import { runDiffSync } from "../sync/diff-sync.js";
import { toDate } from "../scrapers/base.js";

type Row = Record<string, unknown>;
const roles = new Set(["user", "assistant", "system", "tool", "session_meta"]);
function date(value: unknown): string {
  const parsed = toDate(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() === 0) throw new Error("Hermes record has an invalid timestamp");
  return parsed.toISOString();
}
/** Explicit, read-only source import. No credentials/model configuration is copied. */
export function readHermesHistory(file: string, namespace: string, project: string): ArchivedSession[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(namespace)) throw new Error("Invalid Hermes source namespace");
  const db = new Database(resolve(file), { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const sessions = db.prepare("SELECT id, source, parent_session_id, started_at FROM sessions ORDER BY id").all() as Row[];
      const query = db.prepare("SELECT id, session_id, role, content, timestamp, tool_call_id, tool_calls, tool_name FROM messages WHERE session_id = ? ORDER BY id");
      const orphan = db.prepare("SELECT count(*) AS n FROM messages m LEFT JOIN sessions s ON s.id=m.session_id WHERE s.id IS NULL").get() as {n:number};
      if (orphan.n) throw new Error("Hermes source contains orphan messages; import refused");
      return sessions.map((session): ArchivedSession => {
        if (typeof session.id !== "string" || !session.id) throw new Error("Hermes session lacks identity");
        const sourceId = `${namespace}:${session.id}`;
        const ref = `hermes:${sourceId}`;
        const messages = (query.all(session.id) as Row[]).map((row) => {
          if (typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id < 0 || typeof row.role !== "string" || !roles.has(row.role)) throw new Error("Unsupported Hermes message identity or role");
          if (row.content !== null && typeof row.content !== "string") throw new Error("Unsupported Hermes message content; nothing truncated");
          const content = row.content as string | null ?? "";
          const metadata = JSON.stringify({source_provider:"hermes", source_role:row.role, source_namespace:namespace, source_message_id:row.id, source_channel:session.source, source_parent_session_id:session.parent_session_id, tool_call_id:row.tool_call_id, tool_calls:row.tool_calls, tool_name:row.tool_name});
          return { id:hashParts([ref,String(row.id),row.role,content,metadata]), timestamp:date(row.timestamp), role:row.role === "session_meta" ? "system" : row.role, content, message_index:row.id, content_hash:hashParts([content]), metadata_json:metadata, source_pointer:`hermes:${namespace}:${session.id}:${row.id}` };
        });
        const start = date(session.started_at);
        return {session_ref:ref,tool:"hermes",source_session_id:sourceId,project_root:resolve(project),git_branch:null,git_commit:null,started_at:start,last_activity_at:messages.reduce((last,m)=>m.timestamp>last?m.timestamp:last,start),preview:null,source_path:resolve(file),messages};
      });
    })();
  } finally { db.close(); }
}
export async function runHermesImport(file: string, options: {namespace:string;archive:string;dryRun?:boolean;sync?:boolean}): Promise<void> {
  // Validate the complete read-only snapshot before any archive write.
  const archived=readHermesHistory(file,options.namespace,options.archive);
  const counts={sourceSessions:archived.length,sourceMessages:archived.reduce((n,s)=>n+s.messages.length,0),emptySessions:archived.filter(s=>!s.messages.length).length};
  if(options.dryRun){console.log(JSON.stringify({dryRun:true,...counts}));return;}
  const services=await createProjectServices(options.archive);
  try {
    if(!services.config.present||services.config.error||!services.sessions.importSessions)throw new Error("Configure the explicit Hermes archive first");
    async function* lines(){yield headerLine(services.projectRoot);for(const session of archived)yield sessionLine(session);yield endLine(counts.sourceSessions,counts.sourceMessages);}
    const result=await services.sessions.importSessions(lines());
    if(!result.complete||result.invalidLines.length)throw new Error("Hermes import incomplete; retry safely");
    console.log(JSON.stringify({...counts,...result}));
  }finally{await services.sessions.close();}
  if(options.sync)console.log(JSON.stringify({sync:await runDiffSync({projectDir:resolve(options.archive)})}));
}
