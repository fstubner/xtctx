import {it,expect} from "vitest";
import {mkdtemp,rm,mkdir} from "node:fs/promises";import {tmpdir} from "node:os";import {join} from "node:path";
import {AntigravityScraper,type AntigravityRuntimeClient,type AntigravityRuntimeConversation} from "../../src/scrapers/antigravity.js";
it("recovers older live history after artifact fallback and replays changed/restored sessions without relying on a global timestamp",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"antigravity-recovery-"));const state=join(dir,"state");await mkdir(state);
 const conversation=(id:string,text:string):AntigravityRuntimeConversation=>({sessionId:id,workspaces:[],messages:[{sessionId:id,role:"user",content:text,timestamp:new Date("2020-01-01T00:00:00Z"),referencedFiles:[]}]});
 let rows=[conversation("older","original")];let degraded=false;
 const client:AntigravityRuntimeClient={async listConversations(){return {conversations:rows,...(degraded?{degradation:"one source failed"}:{})};}};
 const scraper=new AntigravityScraper(dir,state,undefined,client);
 const read=async()=>{const found=[];for await(const x of scraper.scrape())found.push(x);return found;};
 try{
  await scraper.saveScrapedPosition({lastTimestamp:new Date("2026-10-23T00:00:00Z")});
  expect((await read()).map(x=>x.content)).toEqual(["original"]);expect(await read()).toHaveLength(0);
  rows=[...rows,conversation("restored","old but newly discovered")];expect((await read()).map(x=>x.content)).toEqual(["old but newly discovered"]);
  rows=[conversation("older","edited"),rows[1]];degraded=true;await expect(read()).rejects.toThrow();
  degraded=false;expect((await read()).map(x=>x.content)).toEqual(["edited"]);expect(await read()).toHaveLength(0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
