import {it,expect} from "vitest";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createProjectServices} from "../../src/runtime/services.js";
import {runScan} from "../../src/cli/scan.js";
it("all-local requires an explicit destination",async()=>{
 await expect(runScan({allLocal:true})).rejects.toThrow("explicit");
});
it("explicit archive includes projectless sessions without weakening ordinary project matching",async()=>{
 const root=await mkdtemp(join(tmpdir(),"xtctx-all-local-"));
 try {
 const store=join(root,"store");const archive=join(root,"archive");
 await mkdir(store);await mkdir(join(archive,".xtctx"),{recursive:true});
 const tools=Object.fromEntries(["claude-code","cursor","codex","copilot","antigravity","opencode","copilot-cli"].map(id=>[id,{enabled:id==="codex",...(id==="codex"?{storePath:store}:{})}]));
 await writeFile(join(archive,".xtctx/config.yaml"),JSON.stringify({tools}));
 for(const [id,cwd] of [["personal",undefined],["other","/unrelated/workspace"]]) {
 const events=[{timestamp:"2026-10-01T12:00:00Z",type:"session_meta",payload:{id,...(cwd?{cwd}:{})}},
 {timestamp:"2026-10-01T12:00:01Z",type:"event_msg",payload:{type:"user_message",message:"synthetic personal archive fixture"}}];
 await writeFile(join(store,id+".jsonl"),events.map(x=>JSON.stringify(x)).join("\n")+"\n");
 }
 const normal=await createProjectServices(archive);
 expect(normal.config.error).toBeUndefined();
 try {await normal.sessions.listRecentSessions(10);await normal.sessions.whenScanSettled();expect((await normal.sessions.getStatus()).messages).toBe(0);}finally{await normal.sessions.close();}
 const global=await createProjectServices(archive,{allLocalSessions:true});
 try {await global.sessions.listRecentSessions(10);await global.sessions.whenScanSettled();expect((await global.sessions.getStatus()).sessions).toBe(2);}finally{await global.sessions.close();}
 await expect(createProjectServices(archive)).rejects.toThrow("all-local archive");
 const reopened=await createProjectServices(archive,{allLocalSessions:true});
 try {expect((await reopened.sessions.getStatus()).sessions).toBe(2);}finally{await reopened.sessions.close();}
 }finally{await rm(root,{recursive:true,force:true});}
});

it("refuses machine collection inside a repository before creating an index",async()=>{
 const root=await mkdtemp(join(tmpdir(),"xtctx-machine-repo-"));
 try {
  await mkdir(join(root,".git"));
  await expect(createProjectServices(join(root,"nested"),{allLocalSessions:true})).rejects.toThrow("outside Git");
 }finally{await rm(root,{recursive:true,force:true});}
});
