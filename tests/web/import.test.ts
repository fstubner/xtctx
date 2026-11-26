import {it,expect} from "vitest";
import {claudeContent} from "../../src/web/claude-content.js";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SqliteHandoffIndex} from "../../src/handoff/sqlite-index.js";
import {headerLine,sessionLine,endLine} from "../../src/handoff/export-file.js";
import {archiveWebConversation,parseWebCapture,type WebConversation} from "../../src/web/history.js";
it("real index deduplicates captures, enriches export timestamps, keeps revisions and rebuilds retrieval",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"xtctx-web-"));
 const index=new SqliteHandoffIndex(join(dir,"index.db"),dir,[],{refreshBudgetMs:60000});
 try{
 const c:WebConversation={id:"c",title:"web",startedAt:null,complete:false,messages:[{id:"m",role:"user",content:"stable sentinel",parent:null,timestamp:null,nonTextBlocks:0}]};
 async function merge(){const archived=archiveWebConversation("chatgpt","personal",c,dir);async function* lines(){yield headerLine(dir);yield sessionLine(archived);yield endLine(1,1);}return index.importSessions(lines());}
 expect((await merge()).messagesAdded).toBe(1);expect((await merge()).messagesAdded).toBe(0);
 c.complete=true;c.messages[0].timestamp="2026-10-23T00:00:00.000Z";
 expect((await merge()).sessionsUpdated).toBe(1);
 const exported:string[]=[];await index.exportSessions(async line=>{exported.push(line);});
 const session=JSON.parse(exported[1]);expect(session.messages).toHaveLength(1);expect(session.messages[0].timestamp).toBe(c.messages[0].timestamp);
 expect(JSON.parse(session.messages[0].metadata_json).source_complete).toBe(true);
 c.complete=false;c.messages[0].timestamp=null;expect((await merge()).sessionsUnchanged).toBe(1);
 c.messages[0].content="edited sentinel";expect((await merge()).messagesAdded).toBe(1);
 const lines:string[]=[];await index.exportSessions(async line=>{lines.push(line);});expect(JSON.parse(lines[1]).messages).toHaveLength(2);
 }finally{await index.close();await rm(dir,{recursive:true,force:true});}
});

it("real index merges separate message batches and retries without loss or reordered indices",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"xtctx-web-batches-"));
 const index=new SqliteHandoffIndex(join(dir,"index.db"),dir,[],{refreshBudgetMs:60000});
 try{
  async function merge(offset:number){
   const parsed=parseWebCapture({version:1,provider:"claude",capture_kind:"provider-api",message_offset:offset,conversation:{id:"c",messages:Array.from({length:2},(_,i)=>({id:"m"+(i+offset),role:"user",content:"synthetic "+(i+offset),parent:null,timestamp:null}))}});
   const archived=archiveWebConversation(parsed.provider,"personal",parsed.conversation,dir);
   async function* lines(){yield headerLine(dir);yield sessionLine(archived);yield endLine(1,2);}
   return index.importSessions(lines());
  }
  expect((await merge(0)).messagesAdded).toBe(2);expect((await merge(2)).messagesAdded).toBe(2);expect((await merge(0)).messagesAdded).toBe(0);
  const lines:string[]=[];await index.exportSessions(async line=>{lines.push(line);});
  const messages=JSON.parse(lines[1]).messages;
  expect(messages.map((m:{message_index:number})=>m.message_index)).toEqual([0,1,2,3]);
  expect(messages.map((m:{content:string})=>m.content)).toEqual(["synthetic 0","synthetic 1","synthetic 2","synthetic 3"]);
 }finally{await index.close();await rm(dir,{recursive:true,force:true});}
});

it("new extractor metadata enriches an unchanged message once without duplicate records",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"xtctx-web-extractor-"));const index=new SqliteHandoffIndex(join(dir,"index.db"),dir,[],{refreshBudgetMs:60000});
 try{
 const c:WebConversation={id:"c",title:"web",startedAt:null,complete:false,messages:[{id:"m",role:"user",content:"",parent:null,timestamp:null,nonTextBlocks:1}]};
 async function merge(){const a=archiveWebConversation("claude","personal",c,dir);async function* lines(){yield headerLine(dir);yield sessionLine(a);yield endLine(1,1);}return index.importSessions(lines());}
 expect((await merge()).messagesAdded).toBe(1);
 Object.assign(c.messages[0],claudeContent({content:[{type:"image"}]}));
 expect((await merge()).sessionsUpdated).toBe(1);expect((await merge()).sessionsUnchanged).toBe(1);
 const lines:string[]=[];await index.exportSessions(async l=>{lines.push(l);});const messages=JSON.parse(lines[1]).messages;
 expect(messages).toHaveLength(1);expect(JSON.parse(messages[0].metadata_json).content_capture_version).toBe(2);
 }finally{await index.close();await rm(dir,{recursive:true,force:true});}
});

it("stores and retries a streamed large message without splitting or truncating it",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"xtctx-large-web-"));const index=new SqliteHandoffIndex(join(dir,"index.db"),dir,[],{refreshBudgetMs:60000});
 try{
 const content="猫😀".repeat(600000);
 const c:WebConversation={id:"large-c",title:"large",startedAt:null,complete:false,messages:[{id:"large-m",role:"assistant",content,parent:null,timestamp:null,nonTextBlocks:0}]};
 const archived=archiveWebConversation("claude","personal",c,dir);
 async function* lines(){yield headerLine(dir);yield sessionLine(archived);yield endLine(1,1);}
 expect((await index.importSessions(lines())).messagesAdded).toBe(1);expect((await index.importSessions(lines())).messagesAdded).toBe(0);
 const exported:string[]=[];await index.exportSessions(async line=>{exported.push(line);});
 const messages=JSON.parse(exported[1]).messages;expect(messages).toHaveLength(1);expect(messages[0].content).toBe(content);
 }finally{await index.close();await rm(dir,{recursive:true,force:true});}
});
