import { it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHermesHistory } from "../src/cli/hermes-history.js";
import { SqliteHandoffIndex } from "../src/handoff/sqlite-index.js";
import { headerLine, sessionLine, endLine } from "../src/handoff/export-file.js";

it("imports source messages without mutation, retries idempotently and retains edits and profile identity",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"xtctx-hermes-"));const file=join(dir,"state.db");const source=new Database(file);
 source.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,parent_session_id TEXT,started_at REAL); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,tool_call_id TEXT,tool_calls TEXT,tool_name TEXT)");
 source.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run("s","discord",null,1700000000);
 const insert=source.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)");
 insert.run(1,"s","user","original",1700000001,null,null,null);
 insert.run(2,"s","assistant",null,1700000002,null,'[{"id":"call"}]',null);
 const index=new SqliteHandoffIndex(join(dir,"index.db"),dir,[],{refreshBudgetMs:60000});
 try{
  async function merge(){const sessions=readHermesHistory(file,"main",dir);async function* lines(){yield headerLine(dir);for(const s of sessions)yield sessionLine(s);yield endLine(sessions.length,sessions.reduce((n,s)=>n+s.messages.length,0));}return index.importSessions(lines());}
  expect((await merge()).messagesAdded).toBe(2);expect((await merge()).messagesAdded).toBe(0);
  const first=readHermesHistory(file,"main",dir)[0];expect(first.messages[1].content).toBe("");expect(JSON.parse(first.messages[1].metadata_json).tool_calls).toContain("call");
  expect(readHermesHistory(file,"worker",dir)[0].session_ref).not.toBe(first.session_ref);
  source.prepare("UPDATE messages SET content=? WHERE id=1").run("edited");expect((await merge()).messagesAdded).toBe(1);
  insert.run(3,"s","tool","appended",1700000003,"call",null,"search");expect((await merge()).messagesAdded).toBe(1);
  insert.run(4,"s","session_meta","metadata",1700000004,null,null,null);
  expect(readHermesHistory(file,"main",dir)[0].messages.at(-1)?.role).toBe("system");
  expect((source.prepare("SELECT count(*) n FROM messages").get() as {n:number}).n).toBe(4);
  source.prepare("UPDATE messages SET role='unknown' WHERE id=3").run();expect(()=>readHermesHistory(file,"main",dir)).toThrow("Unsupported Hermes message");
  source.prepare("DELETE FROM sessions").run();expect(()=>readHermesHistory(file,"main",dir)).toThrow("orphan");
 }finally{await index.close();source.close();await rm(dir,{recursive:true,force:true});}
});
