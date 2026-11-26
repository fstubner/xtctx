import {it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
function fixture(){
 const sent:Array<{action:string;reason?:string;capture?:{conversation:{id:string;messages:Array<{id:string;content:string;parent:null}>}}}>=[];
 let tick:()=>Promise<void>=async()=>{};let content="first";let id:string|null="provider-id";let visibility="visible";let streaming=false;let pending=false;
 const node={getAttribute:(k:string)=>k==="data-message-id"?id:k==="data-message-author-role"?"user":null,closest:()=>null,get innerText(){return content;}};
 runInNewContext(readFileSync("browser-extension/capture.js","utf8"),{TextEncoder,Date,location:{hostname:"chatgpt.com",pathname:"/c/conversation"},document:{title:"title",get visibilityState(){return visibility;},querySelector:()=>streaming?{}:null,querySelectorAll:()=>[node]},chrome:{runtime:{sendMessage:async(m:typeof sent[number])=>{sent.push(m);return {ok:true,syncPending:pending};}}},setInterval:(fn:typeof tick)=>{tick=fn;}});
 return {sent,tick:async()=>{await new Promise(r=>setTimeout(r,0));await tick();},setContent:(s:string)=>{content=s;},setId:(s:string|null)=>{id=s;},hide:()=>{visibility="hidden";},stream:()=>{streaming=true;},setPending:()=>{pending=true;}};
}
it("opened-page capture deduplicates unchanged snapshots, preserves edits and never invents parent links",async()=>{
 const f=fixture();await f.tick();expect(f.sent).toHaveLength(1);expect(f.sent[0].capture!.conversation.messages[0].parent).toBeNull();
 f.setContent("edited");await f.tick();expect(f.sent).toHaveLength(2);expect(f.sent[1].capture!.conversation.messages[0]).toMatchObject({id:"provider-id",content:"edited"});
});
it("missing identities and oversized snapshots report a bounded diagnostic instead of silent success",async()=>{
 const f=fixture();await f.tick();f.setId(null);await f.tick();expect(f.sent.at(-1)).toEqual({action:"capture-unavailable",reason:"missing-provider-ids"});
 f.setId("provider-id");f.setContent("x".repeat(2600*1024));await f.tick();expect(f.sent.at(-1)).toEqual({action:"capture-unavailable",reason:"snapshot-too-large"});
});
it("hidden and streaming views do not capture changed text",async()=>{
 const f=fixture();await f.tick();f.hide();f.setContent("hidden");await f.tick();expect(f.sent).toHaveLength(1);
 const g=fixture();await g.tick();g.stream();g.setContent("streaming");await g.tick();expect(g.sent).toHaveLength(1);
});
