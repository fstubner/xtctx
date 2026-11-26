import {it,expect} from "vitest";
import {mkdtemp,writeFile,rm,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";import {join} from "node:path";
import {CodexCliScraper} from "../../src/scrapers/codex.js";
it("recovers desktop response-user text from image-heavy records and resumes without duplicates",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"codex-desktop-"));const state=join(dir,"state");await mkdir(state);
 const meta={type:"session_meta",timestamp:"2026-10-23T00:00:00Z",payload:{id:"desktop",cwd:dir,originator:"Codex Desktop"}};
 const user={type:"response_item",timestamp:"2026-10-23T00:00:01Z",payload:{type:"message",role:"user",content:[{type:"input_text",text:"unique user sentinel"},{type:"input_image",image_url:"data:image/png;base64,"+"A".repeat(9*1024*1024)}]}};
 try{await writeFile(join(dir,"rollout-desktop.jsonl"),[meta,user].map(x=>JSON.stringify(x)).join("\n")+"\n");
 const reader=new CodexCliScraper(dir,state);const chunks=[];for await(const c of reader.scrape())chunks.push(c);
 expect(chunks).toHaveLength(1);expect(chunks[0].role).toBe("user");expect(chunks[0].content).toBe("unique user sentinel");expect(chunks[0].metadata).toMatchObject({sourceFormat:"codex-desktop-response-user",mayIncludeInjectedContext:true,nonTextParts:1});
 const retry=[];for await(const c of reader.scrape())retry.push(c);expect(retry).toHaveLength(0);
 const authoritative={type:"event_msg",timestamp:"2026-10-23T00:00:01Z",payload:{type:"user_message",message:"authoritative sentinel"}};
 await writeFile(join(dir,"rollout-desktop.jsonl"),[meta,authoritative,user].map(x=>JSON.stringify(x)).join("\n")+"\n");
 const preferred=[];for await(const c of reader.scrape())preferred.push(c);expect(preferred).toHaveLength(1);expect(preferred[0].content).toBe("authoritative sentinel");
 }finally{await rm(dir,{recursive:true,force:true});}
});
