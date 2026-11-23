import {it,expect,vi} from "vitest";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
interface TestElement {value:string;textContent:string;hidden:boolean;children:TestElement[];addEventListener:()=>void;replaceChildren:(...children:TestElement[])=>void;appendChild:(child:TestElement)=>void;}
interface TestContext {
 document:{querySelector:(id:string)=>TestElement};
 normalizeDetail:(provider:string,raw:unknown)=>unknown;
 readProvider:(...args:unknown[])=>Promise<unknown>;
 run:()=>Promise<void>;
 startImport:()=>Promise<void>;
 chatgptCooldown:(now:number,retryAfter:number,previous?:{at:number;strikes:number})=>{at:number;strikes:number;until:number};
 sendCapture:(capture:unknown,bridge:unknown)=>Promise<unknown>;
 captureBatches:(capture:unknown,maximum?:number)=>Array<{message_offset:number;conversation:{messages:Array<{id:string;content:string}>}}>;
}
function load(extra:Record<string,unknown>={}):TestContext{
 const elements=new Map<string,TestElement>();
 if(extra.chrome && typeof extra.chrome==="object" && !("storage" in extra.chrome))Object.assign(extra.chrome,{storage:{local:{get:async()=>({})}}});
 const element=():TestElement=>({value:"",textContent:"",hidden:true,children:[],addEventListener:()=>{},replaceChildren(...children){this.children=children;},appendChild(child){this.children.push(child);}});
 const context={document:{createElement:()=>element(),querySelector:(id:string)=>{if(!elements.has(id))elements.set(id,{...element(),value:id==="#provider"?"chatgpt":""});return elements.get(id)!;}},TextEncoder,TextDecoder,URL,setTimeout:(fn:()=>void)=>fn(),...extra};
 runInNewContext(readFileSync("browser-extension/gemini-reader.js","utf8").replaceAll("export ",""),context);
 runInNewContext(readFileSync("browser-extension/claude-content.js","utf8").replaceAll("export ",""),context);
 runInNewContext(readFileSync("browser-extension/backfill.js","utf8").replace(/^import .*;\r?\n/gm,"").replaceAll("export ",""),context);return context as unknown as TestContext;
}
it("ChatGPT detail keeps provider identities and parents, rejecting unknown formats",()=>{
 const ctx=load();const mapping={n:{parent:"p",message:{id:"m",author:{role:"user"},create_time:1,content:{parts:["text",{image:"opaque"}]}}}};
 expect(ctx.normalizeDetail("chatgpt",{mapping})).toEqual([{id:"m",parent:"p",role:"user",content:"text",nonTextBlocks:1,timestamp:"1970-01-01T00:00:01.000Z"}]);
 expect(()=>ctx.normalizeDetail("chatgpt",{})).toThrow("format");
});
it("signed-in request uses fixed relative endpoints and never returns its access token",async()=>{
 const fetch=vi.fn().mockResolvedValueOnce({ok:true,text:async()=>JSON.stringify({accessToken:"synthetic-secret",user:{id:"account"}})}).mockResolvedValueOnce({ok:true,text:async()=>JSON.stringify({items:[{id:"c",update_time:1}],total:1})});
 const ctx=load({location:{hostname:"chatgpt.com",protocol:"https:"},fetch});
 const result=await ctx.readProvider("chatgpt","list",0,null,false);
 expect(JSON.stringify(result)).not.toContain("synthetic-secret");expect(result).toMatchObject({account:"account",next:null,items:[{id:"c"}]});
 expect(fetch.mock.calls.every(([path])=>path.startsWith("/"))).toBe(true);
});
it("rate limits and wrong-origin tabs stop without reading further pages",async()=>{
 const fetch=vi.fn().mockResolvedValue({ok:false,status:429});
 const ctx=load({location:{hostname:"claude.ai",protocol:"https:"},fetch});
 expect(await ctx.readProvider("chatgpt","list",0,null,false)).toMatchObject({readerError:{message:"Wrong website"}});expect(fetch).not.toHaveBeenCalled();
 expect(await ctx.readProvider("claude","list",0,null,false)).toMatchObject({readerError:{stage:"Claude organizations",message:"Rate limited; pause and retry later"}});expect(fetch).toHaveBeenCalledTimes(1);
});
it("pending remote sync does not advance the durable conversation checkpoint",async()=>{
 const set=vi.fn();const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},tabs:{create:async()=>({id:1}),get:async()=>({status:"complete",url:"https://chatgpt.com/",active:true})},storage:{local:{get:async()=>({}),set}},scripting:{executeScript:async({args}:{args:unknown[]})=>[{result:args[1]==="list"?{account:"a",items:[{id:"c",updated:1}],next:null}:{account:"a",detail:{mapping:{n:{message:{id:"m",author:{role:"user"},content:{parts:["hi"]}}}}}}}]},runtime:{sendNativeMessage:async(_host:string,body:{action?:string})=>body.action==="status"?({ok:true,host:"io.xtctx.web_history",protocol:1,capabilities:["message-offset","content-blocks-v2"]}):({ok:true,syncPending:true})}}});
 await ctx.run();expect(set).not.toHaveBeenCalled();expect(ctx.document.querySelector("#progress").textContent).toContain("sync pending");
});

it("withheld site permission stops before reading a tab or sending transcripts",async()=>{
 const executeScript=vi.fn();const sendNativeMessage=vi.fn();
 const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>false},scripting:{executeScript},runtime:{sendNativeMessage}}});
 await ctx.run();expect(executeScript).not.toHaveBeenCalled();expect(sendNativeMessage).not.toHaveBeenCalled();
 expect(ctx.document.querySelector("#progress").textContent).toContain("Site access");
});
it("tab injection denial gives site-specific recovery without requesting all sites",async()=>{
 const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},tabs:{create:async()=>({id:1}),get:async()=>({status:"complete",url:"https://chatgpt.com/",active:true})},storage:{local:{get:async()=>({}),set:async()=>{}}},runtime:{sendNativeMessage:async()=>({ok:true,host:"io.xtctx.web_history",protocol:1,capabilities:["message-offset","content-blocks-v2"]})},scripting:{executeScript:async()=>{throw new Error("Cannot access contents of the page. Extension manifest must request permission");}}}});
 await ctx.run();expect(ctx.document.querySelector("#progress").textContent).toContain("newly opened");
 expect(ctx.document.querySelector("#progress").textContent).toContain("ISOLATED injection");
 expect(ctx.document.querySelector("#progress").textContent).not.toContain("Details > Site access");
});

it("backfill executes in the isolated world without requesting broader manifest access",()=>{
 const source=readFileSync("browser-extension/backfill.js","utf8");
 expect(source).toContain('world:"ISOLATED"');expect(source).not.toContain('world:"MAIN"');
 const manifest=JSON.parse(readFileSync("browser-extension/manifest.json","utf8"));
 expect(manifest.host_permissions).toBeUndefined();
 expect(manifest.optional_host_permissions).toEqual(["https://chatgpt.com/*","https://claude.ai/*","https://gemini.google.com/*","https://sync.xtctx.com/*"]);
});

it("opens a fresh provider reader tab and never injects into a pre-existing tab",async()=>{
 const create=vi.fn(async()=>({id:42}));const remove=vi.fn();
 const executeScript=vi.fn(async()=>[{result:{account:"a",items:[],next:null}}]);
 const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},tabs:{create,get:async()=>({status:"complete",url:"https://chatgpt.com/",active:false}),remove},storage:{local:{get:async()=>({}),set:async()=>{}}},runtime:{sendNativeMessage:async()=>({ok:true,host:"io.xtctx.web_history",protocol:1,capabilities:["message-offset","content-blocks-v2"]})},scripting:{executeScript}}});
 await ctx.run();expect(create).toHaveBeenCalledWith({url:"https://chatgpt.com/",active:false});
 expect(executeScript.mock.calls).toHaveLength(2);expect(remove).toHaveBeenCalledWith(42);
});

it("non-parts ChatGPT messages preserve text and expose opaque omissions without aborting the chat",()=>{
 const ctx=load();
 const mapping=Object.fromEntries([{content_type:"code",text:"print(1)"},{content_type:"execution_output",text:"1"},{content_type:"audio",asset_pointer:"not-downloaded"},null].map((content,i)=>[String(i),{message:{id:"m"+i,author:{role:"assistant"},content}}]));
 expect(ctx.normalizeDetail("chatgpt",{mapping})).toMatchObject([
 {id:"m0",content:"print(1)",nonTextBlocks:0},
 {id:"m1",content:"1",nonTextBlocks:0},
 {id:"m2",content:"",nonTextBlocks:1},
 {id:"m3",content:"",nonTextBlocks:1}]);
});

it("missing native host stops before opening or reading provider tabs",async()=>{
 const create=vi.fn();const executeScript=vi.fn();
 const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},runtime:{id:"fixture-id",sendNativeMessage:async()=>{throw new Error("Specified native messaging host not found.");}},tabs:{create},scripting:{executeScript}}});
 await ctx.run();expect(create).not.toHaveBeenCalled();expect(executeScript).not.toHaveBeenCalled();
 expect(ctx.document.querySelector("#progress").textContent).toContain("before reading history");
 expect(ctx.document.querySelector("#progress").textContent).toContain("fixture-id");
});

it("Claude sign-in failures survive the script boundary without returning response bodies",async()=>{
 const fetch=vi.fn().mockResolvedValue({ok:false,status:401,text:async()=>"synthetic-private-response"});
 const ctx=load({location:{hostname:"claude.ai",protocol:"https:"},fetch});
 const result=await ctx.readProvider("claude","list",0,null,false);
 expect(result).toMatchObject({readerError:{stage:"Claude organizations",message:"Website request failed (401)"}});
 expect(JSON.stringify(result)).not.toContain("synthetic-private-response");
});
it("arbitrary browser exception text never crosses the reader boundary",async()=>{
 const ctx=load({location:{hostname:"claude.ai",protocol:"https:"},fetch:async()=>{throw new Error("synthetic-secret-cookie");}});
 const result=await ctx.readProvider("claude","list",0,null,false);
 expect(result).toMatchObject({readerError:{stage:"Claude organizations"}});
 expect(JSON.stringify(result)).not.toContain("synthetic-secret-cookie");
});
it("Claude browser capture preserves unknown ancestry and counts omitted blocks",()=>{
 const ctx=load();
 expect(ctx.normalizeDetail("claude",{chat_messages:[{uuid:"u",sender:"human",content:[{type:"text",text:"hello"},{type:"image"}],attachments:[{}]},{uuid:"a",sender:"assistant",text:"reply"},{uuid:"b",sender:"assistant",text:"sibling",parent_message_uuid:"u"}]})).toMatchObject([{id:"u",parent:null,nonTextBlocks:2},{id:"a",parent:null},{id:"b",parent:"u"}]);
});

it("reader failures display their stage and never send transcript data or save a checkpoint",async()=>{
 const set=vi.fn();const sendNativeMessage=vi.fn(async()=>({ok:true,host:"io.xtctx.web_history",protocol:1,capabilities:["message-offset","content-blocks-v2"]}));
 const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},tabs:{create:async()=>({id:7}),get:async()=>({status:"complete",url:"https://claude.ai/",active:true})},storage:{local:{get:async()=>({}),set}},runtime:{sendNativeMessage},scripting:{executeScript:async()=>[{result:{readerError:{stage:"Claude organizations",message:"Website request failed (401)"}}}]}}});
 ctx.document.querySelector("#provider").value="claude";
 await ctx.run();
 expect(ctx.document.querySelector("#progress").textContent).toBe("Reader v8: Claude organizations: Website request failed (401)");
 expect(set).not.toHaveBeenCalled();expect(sendNativeMessage).toHaveBeenCalledTimes(1);
});

it("multiple Claude organizations require explicit selection before reading any conversations",async()=>{
 const fetch=vi.fn().mockResolvedValue({ok:true,text:async()=>JSON.stringify([{uuid:"org-a",name:"Personal"},{uuid:"org-b",name:"Team"}])});
 const ctx=load({location:{hostname:"claude.ai",protocol:"https:"},fetch});
 expect(await ctx.readProvider("claude","list",0,null,false,null)).toMatchObject({selectionRequired:true,organizations:[{id:"org-a"},{id:"org-b"}]});
 expect(fetch).toHaveBeenCalledTimes(1);
});
it("selected Claude organization is checked against membership before any listing request",async()=>{
 const fetch=vi.fn().mockResolvedValueOnce({ok:true,text:async()=>JSON.stringify([{uuid:"org-a"},{uuid:"org-b"}])}).mockResolvedValueOnce({ok:true,text:async()=>"[]"});
 const ctx=load({location:{hostname:"claude.ai",protocol:"https:"},fetch});
 expect(await ctx.readProvider("claude","list",0,null,false,"org-b")).toMatchObject({account:"org-b",items:[],next:null});
 expect(fetch.mock.calls[1][0]).toBe("/api/organizations/org-b/chat_conversations");
 const denied=load({location:{hostname:"claude.ai",protocol:"https:"},fetch:vi.fn().mockResolvedValue({ok:true,text:async()=>JSON.stringify([{uuid:"org-a"}])})});
 expect(await denied.readProvider("claude","list",0,null,false,"other")).toMatchObject({readerError:{message:"Selected Claude organization is no longer accessible"}});
});
it("organization selection UI stops without importing or advancing checkpoints",async()=>{
 const set=vi.fn();const native=vi.fn(async()=>({ok:true,host:"io.xtctx.web_history",protocol:1,capabilities:["message-offset","content-blocks-v2"]}));
 const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},tabs:{create:async()=>({id:7}),get:async()=>({status:"complete",url:"https://claude.ai/",active:true})},storage:{local:{get:async()=>({}),set}},runtime:{sendNativeMessage:native},scripting:{executeScript:async()=>[{result:{selectionRequired:true,organizations:[{id:"org-a",name:"<unsafe name>"},{id:"org-b",name:"Team"}]}}]}}});
 ctx.document.querySelector("#provider").value="claude";await ctx.run();
 expect(ctx.document.querySelector("#organization-label").hidden).toBe(false);
 expect(ctx.document.querySelector("#organization").children[1].textContent).toContain("<unsafe name>");
 expect(ctx.document.querySelector("#progress").textContent).toContain("Choose a Claude organization");
 expect(native).toHaveBeenCalledTimes(1);expect(set).not.toHaveBeenCalled();
});

it("selected organization never reuses another organization's conversation checkpoint",async()=>{
 const set=vi.fn();const get=vi.fn(async(key:string)=>key==="bulk-claude"?{[key]:{account:"org-a",done:{c:1}}}:{});
 const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},tabs:{create:async()=>({id:7}),get:async()=>({status:"complete",url:"https://claude.ai/",active:true})},storage:{local:{get,set}},runtime:{sendNativeMessage:async(_host:string,body:{action?:string})=>body.action==="status"?({ok:true,host:"io.xtctx.web_history",protocol:1,capabilities:["message-offset","content-blocks-v2"]}):({ok:true})},scripting:{executeScript:async({args}:{args:unknown[]})=>[{result:args[1]==="list"?{account:"org-b",items:[{id:"c",updated:1}],next:null}:{account:"org-b",detail:{chat_messages:[{uuid:"m",sender:"human",text:"synthetic"}]}}}]}}});
 ctx.document.querySelector("#provider").value="claude";ctx.document.querySelector("#organization").value="org-b";
 await ctx.run();expect(get).toHaveBeenCalledWith("bulk-claude:org-b");
 expect(set).toHaveBeenCalledWith({"bulk-claude:org-b":{account:"org-b",done:{c:1},contentVersions:{c:2}}});
});

it("large captures split below the frame cap with full Unicode messages and stable offsets",()=>{
 const ctx=load();const messages=Array.from({length:8},(_,i)=>({id:"m"+i,role:"user",content:"猫".repeat(100000),parent:null,timestamp:null}));
 const capture={version:1,provider:"claude",conversation:{id:"c",title:"large",messages}};
 const batches=ctx.captureBatches(capture,1024*1024);
 expect(batches.length).toBeGreaterThan(1);expect(batches.flatMap(x=>x.conversation.messages)).toEqual(messages);
 expect(batches.map(x=>x.message_offset)).toEqual([0,3,6]);
 for(const b of batches)expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThanOrEqual(1024*1024);
 const large={...messages[0],content:"x".repeat(1024*1024+1)};expect(ctx.captureBatches({...capture,conversation:{id:"c",messages:[large]}})[0].conversation.messages[0]).toEqual(large);
});
it("Claude detail can exceed the old raw-response limit without crossing the native bridge",async()=>{
 const data={chat_messages:[],opaque:"x".repeat(5*1024*1024)};
 const fetch=vi.fn().mockResolvedValueOnce({ok:true,text:async()=>JSON.stringify([{uuid:"org"}])}).mockResolvedValueOnce({ok:true,text:async()=>JSON.stringify(data)});
 const ctx=load({location:{hostname:"claude.ai",protocol:"https:"},fetch});
 expect(await ctx.readProvider("claude","detail",0,"c",false,"org")).toMatchObject({account:"org",detail:{chat_messages:[]}});
});
it("streaming reader cancels an oversized listing at the configured byte bound",async()=>{
 const cancel=vi.fn();const releaseLock=vi.fn();const read=vi.fn().mockResolvedValue({done:false,value:new Uint8Array(4*1024*1024+1)});
 const ctx=load({location:{hostname:"claude.ai",protocol:"https:"},fetch:async()=>({ok:true,body:{getReader:()=>({read,cancel,releaseLock})}})});
 expect(await ctx.readProvider("claude","list",0,null,false)).toMatchObject({readerError:{message:"Website response exceeds the bounded reader limit"}});
 expect(cancel).toHaveBeenCalled();expect(releaseLock).toHaveBeenCalled();expect(read).toHaveBeenCalledTimes(1);
});

it("a failed later batch keeps the conversation checkpoint unadvanced",async()=>{
 const set=vi.fn();let chunks=0;
 const native=vi.fn(async(_host:string,body:{action?:string})=>body.action==="status"?({ok:true,host:"io.xtctx.web_history",protocol:1,capabilities:["message-offset","content-blocks-v2"]}):({ok:true,syncPending:++chunks===2}));
 const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},tabs:{create:async()=>({id:7}),get:async()=>({status:"complete",url:"https://claude.ai/",active:true})},storage:{local:{get:async()=>({}),set}},runtime:{sendNativeMessage:native},scripting:{executeScript:async({args}:{args:unknown[]})=>[{result:args[1]==="list"?{account:"org",items:[{id:"c",updated:1}],next:null}:{account:"org",detail:{chat_messages:Array.from({length:3},(_,i)=>({uuid:"m"+i,sender:"human",text:"x".repeat(900000)}))}}}]}}});
 ctx.document.querySelector("#provider").value="claude";ctx.document.querySelector("#organization").value="org";
 await ctx.run();expect(chunks).toBe(2);expect(set).not.toHaveBeenCalled();
 expect(ctx.document.querySelector("#progress").textContent).toContain("sync pending");
});

it("Claude extractor upgrades revisit legacy checkpoints but skip current-version captures",async()=>{
 for(const version of [undefined,2]){
  const native=vi.fn(async(_host:string,body:{action?:string})=>body.action==="status"?({ok:true,host:"io.xtctx.web_history",protocol:1,capabilities:["message-offset","content-blocks-v2"]}):({ok:true}));
  const stored={account:"org",done:{c:1},...(version?{contentVersions:{c:version}}:{})};
  const set=vi.fn();const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},tabs:{create:async()=>({id:7}),get:async()=>({status:"complete",url:"https://claude.ai/",active:true})},storage:{local:{get:async(key:string)=>({[key]:stored}),set}},runtime:{sendNativeMessage:native},scripting:{executeScript:async({args}:{args:unknown[]})=>[{result:args[1]==="list"?{account:"org",items:[{id:"c",updated:1}],next:null}:{account:"org",detail:{chat_messages:[{uuid:"m",sender:"human",text:"synthetic"}]}}}]}}});
  ctx.document.querySelector("#provider").value="claude";ctx.document.querySelector("#organization").value="org";await ctx.run();
  expect(native).toHaveBeenCalledTimes(version?1:2);expect(set).toHaveBeenCalledTimes(version?1:2);
 }
});

for(const mismatch of [false,true])it(`streams one intact large message and validates final acknowledgement (mismatch=${mismatch})`,async()=>{
 const content="猫😀".repeat(600000);const capture={conversation:{messages:[{id:"large",content}]}};
 const parts:string[]=[];let listener:(reply:unknown)=>void=()=>{};const disconnect=vi.fn();
 const port={onMessage:{addListener:(fn:typeof listener)=>{listener=fn;}},onDisconnect:{addListener:()=>{}},disconnect,postMessage:(part:{data:string;index:number;total:number;transferId:string})=>{
  parts.push(part.data);queueMicrotask(()=>listener({ok:true,complete:part.index===part.total-1,transferId:mismatch&&part.index===part.total-1?"wrong":part.transferId,index:part.index,syncPending:true}));
 }};
 const ctx=load({setTimeout,clearTimeout,crypto:{randomUUID:()=>"transfer-test"},chrome:{runtime:{connectNative:()=>port}}});
 const result=ctx.sendCapture(capture,{capabilities:["large-message-stream"]});
 if(mismatch)await expect(result).rejects.toThrow("acknowledgement mismatch");else expect(await result).toMatchObject({ok:true,complete:true,syncPending:true});
 expect(JSON.parse(parts.join(""))).toEqual(capture);expect(disconnect).toHaveBeenCalledTimes(1);
});
it("large messages require an updated bridge before sending anything",async()=>{
 const sendNativeMessage=vi.fn();const ctx=load({chrome:{runtime:{sendNativeMessage}}});
 await expect(ctx.sendCapture({conversation:{messages:[{content:"x".repeat(1024*1024+1)}]}},{capabilities:[]})).rejects.toThrow("large-message update");expect(sendNativeMessage).not.toHaveBeenCalled();
});

it("saves separate listing coverage without claiming account-wide completeness",async()=>{
 const set=vi.fn();const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},tabs:{create:async()=>({id:1}),get:async()=>({status:"complete",url:"https://chatgpt.com/",active:true})},storage:{local:{get:async()=>({}),set}},runtime:{sendNativeMessage:async()=>({ok:true,host:"io.xtctx.web_history",protocol:1,capabilities:[]})},scripting:{executeScript:async()=>[{result:{account:"account",total:0,items:[],next:null}}]}}});
 await ctx.run();expect(set).toHaveBeenCalledWith({"bulk-chatgpt:coverage":expect.objectContaining({accountWideVerified:false,originalAttachmentsDownloaded:false,listings:[expect.objectContaining({scope:"normal",listed:0,reportedTotal:0,listingExhausted:true}),expect.objectContaining({scope:"archived",listed:0,listingExhausted:true})]})});
 expect(ctx.document.querySelector("#progress").textContent).toContain("Finished selected listing");
});

it("provider 429 returns only a bounded Retry-After diagnostic and never reads its body",async()=>{
 const text=vi.fn();const ctx=load({location:{hostname:"claude.ai",protocol:"https:"},fetch:async()=>({ok:false,status:429,headers:{get:()=>"120"},text})});
 expect(await ctx.readProvider("claude","list",0,null,false)).toMatchObject({readerError:{code:"rate_limited",retryAfterSeconds:120}});expect(text).not.toHaveBeenCalled();
});
it("saved provider cooldown blocks requests before tab creation or native calls",async()=>{
 const create=vi.fn();const native=vi.fn();const ctx=load({chrome:{storage:{local:{get:async()=>({"rate-limit:chatgpt":Date.now()+600000})}},tabs:{create},runtime:{sendNativeMessage:native}}});
 await ctx.run();expect(create).not.toHaveBeenCalled();expect(native).not.toHaveBeenCalled();expect(ctx.document.querySelector("#progress").textContent).toContain("cooldown active");
});
it("rate limits save cooldown without advancing conversation checkpoints or retrying",async()=>{
 const set=vi.fn();const executeScript=vi.fn(async()=>[{result:{readerError:{stage:"ChatGPT conversation",message:"Rate limited; pause and retry later",code:"rate_limited",retryAfterSeconds:120}}}]);
 const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},tabs:{create:async()=>({id:1}),get:async()=>({status:"complete",url:"https://chatgpt.com/",active:true})},storage:{local:{get:async()=>({}),set}},runtime:{sendNativeMessage:async()=>({ok:true,host:"io.xtctx.web_history",protocol:1})},scripting:{executeScript}}});
 await ctx.run();expect(executeScript).toHaveBeenCalledTimes(1);expect(set).toHaveBeenCalledTimes(2);expect(set).toHaveBeenCalledWith({"rate-limit-history:chatgpt":expect.objectContaining({strikes:1})});expect(set).toHaveBeenCalledWith({"rate-limit:chatgpt":expect.any(Number)});expect(ctx.document.querySelector("#progress").textContent).toContain("no automatic retry");
});

it("Gemini resumes a rate-limited sweep without re-reading confirmed conversations",async()=>{
 const values:Record<string,unknown>={};let limited=true;const details:string[]=[];
 const capture={messages:[{id:"r_one-user",role:"user",content:"hello",parent:null,timestamp:null,nonTextBlocks:0}],title:"title"};
 const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},tabs:{create:async()=>({id:1}),get:async()=>({status:"complete",url:"https://gemini.google.com/u/1/app"}),remove:async()=>{}},storage:{local:{get:async(key:string)=>({[key]:values[key]}),set:async(data:Record<string,unknown>)=>{Object.assign(values,structuredClone(data));}}},scripting:{executeScript:async({args}:{args:unknown[]})=>{
  if(args[0]==="list")return [{result:{account:"gemini-"+"a".repeat(64),items:[{id:"c_one",updated:null},{id:"c_two",updated:null}],next:null}}];
  details.push(args[2] as string);if(args[2]==="c_two"&&limited)return [{result:{readerError:{stage:"Gemini conversation",code:"rate_limited",retryAfterSeconds:60}}}];
  return [{result:{account:"gemini-"+"a".repeat(64),detail:capture}}];
 }},runtime:{sendNativeMessage:async(_host:string,body:{action?:string})=>body.action==="status"?({ok:true,host:"io.xtctx.web_history",protocol:1,capabilities:["gemini-history-v1","message-offset"]}):({ok:true})}}});
 ctx.document.querySelector("#provider").value="gemini";ctx.document.querySelector("#gemini-account-url").value="https://gemini.google.com/u/1/app";
 await ctx.run();expect(details).toEqual(["c_one","c_two"]);expect(values["bulk-gemini:gemini-"+"a".repeat(64)]).toHaveProperty("geminiSweep");
 limited=false;values["rate-limit:gemini"]=0;await ctx.run();expect(details).toEqual(["c_one","c_two","c_two"]);
 expect(values["bulk-gemini:gemini-"+"a".repeat(64)]).not.toHaveProperty("geminiSweep");expect(values["bulk-gemini:gemini-"+"a".repeat(64)+":coverage"]).toMatchObject({accountWideVerified:false});
});

it("Gemini rejects a reader redirected to a different account before reading history",async()=>{
 const executeScript=vi.fn();
 const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},tabs:{create:async()=>({id:1}),get:async()=>({status:"complete",url:"https://gemini.google.com/u/0/app"})},storage:{local:{get:async()=>({})}},scripting:{executeScript},runtime:{sendNativeMessage:async()=>({ok:true,host:"io.xtctx.web_history",protocol:1,capabilities:["gemini-history-v1"]})}}});
 ctx.document.querySelector("#provider").value="gemini";ctx.document.querySelector("#gemini-account-url").value="https://gemini.google.com/u/1/app";
 await ctx.run();expect(executeScript).not.toHaveBeenCalled();expect(ctx.document.querySelector("#progress").textContent).toContain("different Google account slot");
});

it("Gemini records unavailable history without inventing zero counts or advancing conversation checkpoints",async()=>{
 const set=vi.fn();const account="gemini-"+"b".repeat(64);
 const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},tabs:{create:async()=>({id:1}),get:async()=>({status:"complete",url:"https://gemini.google.com/u/1/app"})},storage:{local:{get:async()=>({}),set}},scripting:{executeScript:async()=>[{result:{account,readerError:{stage:"Gemini listing",code:"history_unavailable",message:"Gemini returned no conversation-list data. Coverage remains unverified."}}}]},runtime:{sendNativeMessage:async()=>({ok:true,host:"io.xtctx.web_history",protocol:1,capabilities:["gemini-history-v1"]})}}});
 ctx.document.querySelector("#provider").value="gemini";ctx.document.querySelector("#gemini-account-url").value="https://gemini.google.com/u/1/app";
 await ctx.run();expect(set).toHaveBeenCalledTimes(1);
 const saved=set.mock.calls[0][0]["bulk-gemini:"+account+":coverage"];
 expect(saved).toMatchObject({status:"unavailable",reason:"missing-history-payload",listings:[],accountWideVerified:false});
 expect(saved).not.toHaveProperty("completedAt");expect(saved).not.toHaveProperty("importedThisRun");
 expect(ctx.document.querySelector("#progress").textContent).toContain("Coverage remains unverified");
});

it('ChatGPT repeat cooldowns grow, honor longer provider waits and reset after a quiet day',()=>{
 const ctx=load(),now=1700000000000;
 const first=ctx.chatgptCooldown(now,120);expect(first.until-now).toBe(3600000);
 const second=ctx.chatgptCooldown(now+3600000,120,first);expect(second.until-(now+3600000)).toBe(7200000);
 expect(ctx.chatgptCooldown(now,9*86400).until-now).toBe(9*86400000);
 expect(ctx.chatgptCooldown(now+2*86400000,120,first).until-(now+2*86400000)).toBe(3600000);
});
it('ChatGPT paces auth and listing requests, including unchanged-history listing work',async()=>{
 const waits:number[]=[];const delay=vi.fn((fn:()=>void,ms:number)=>{waits.push(ms);fn();});
 const fetch=vi.fn().mockResolvedValueOnce({ok:true,text:async()=>JSON.stringify({accessToken:'synthetic-secret',user:{id:'account'}})}).mockResolvedValueOnce({ok:true,text:async()=>JSON.stringify({items:[],total:0})});
 const ctx=load({location:{hostname:'chatgpt.com',protocol:'https:'},fetch,setTimeout:delay});
 await ctx.readProvider('chatgpt','list',0,null,false);
 expect(fetch).toHaveBeenCalledTimes(2);expect(waits).toEqual([10000,10000]);
});

it('does not start a second extension-page import while another holds its lock',async()=>{
 const create=vi.fn(),request=vi.fn(async(_name:string,_options:unknown,callback:(lock:null)=>Promise<void>)=>callback(null));
 const ctx=load({navigator:{locks:{request}},chrome:{tabs:{create}}});
 await ctx.startImport();expect(request).toHaveBeenCalledTimes(1);expect(create).not.toHaveBeenCalled();expect(ctx.document.querySelector('#progress').textContent).toContain('already running');
});

it("resumes ChatGPT at a completed page boundary and skips a finished normal listing",async()=>{
 const state:Record<string,unknown>={};const offsets:unknown[][]=[];let fail=true;
 const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},tabs:{create:async()=>({id:1}),get:async()=>({status:"complete",url:"https://chatgpt.com/"}),remove:async()=>{}},storage:{local:{get:async(key:string)=>({[key]:state[key]}),set:async(value:Record<string,unknown>)=>{Object.assign(state,structuredClone(value));}}},runtime:{sendNativeMessage:async()=>({ok:true,host:"io.xtctx.web_history",protocol:1,capabilities:["message-offset"]})},scripting:{executeScript:async({args}:{args:unknown[]})=>{
 offsets.push([args[1],args[2],args[4]]);
 if(args[4]&&fail)throw Error("synthetic interruption");
 return [{result:{account:"a",items:[],total:0,next:null}}];
 }}}});
 await ctx.run();expect(offsets).toEqual([["list",0,false],["list",0,true]]);
 fail=false;offsets.length=0;await ctx.run();expect(offsets).toEqual([["list",0,true]]);
 offsets.length=0;await ctx.run();expect(offsets).toEqual([["list",0,false],["list",0,true]]);
});
it("resumes an interrupted later ChatGPT page without requesting page zero",async()=>{
 const state:Record<string,unknown>={};const offsets:unknown[]=[];let fail=true;
 const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},tabs:{create:async()=>({id:1}),get:async()=>({status:"complete",url:"https://chatgpt.com/"}),remove:async()=>{}},storage:{local:{get:async(key:string)=>({[key]:state[key]}),set:async(value:Record<string,unknown>)=>{Object.assign(state,structuredClone(value));}}},runtime:{sendNativeMessage:async()=>({ok:true,host:"io.xtctx.web_history",protocol:1,capabilities:["message-offset"]})},scripting:{executeScript:async({args}:{args:unknown[]})=>{
 if(args[1]==="detail")return [{result:{account:"a",detail:{mapping:{m:{message:{id:"m",author:{role:"user"},content:{parts:["hi"]}}}}}}}];
 offsets.push(args[2]);if(args[2]===100&&fail)throw Error("synthetic interruption");
 return [{result:{account:"a",items:args[2]===0&&!args[4]?[{id:"c",updated:1}]:[],total:101,next:args[2]===0&&!args[4]?100:null}}];
 }}}});
 await ctx.run();expect(offsets).toEqual([0,100]);fail=false;offsets.length=0;
 await ctx.run();expect(offsets).toEqual([100,0]);
});

it("web sync mode skips native bridge check and sends backfill captures through background sync-capture",async()=>{
 const state:Record<string,unknown>={syncMode:"web",syncToken:"tok"};
 const sendMessage=vi.fn(async()=>({ok:true}));const sendNativeMessage=vi.fn();
 const ctx=load({chrome:{permissions:{request:async()=>true,contains:async()=>true},tabs:{create:async()=>({id:1}),get:async()=>({status:"complete",url:"https://chatgpt.com/",active:true}),remove:async()=>{}},storage:{local:{get:async(keys:string|string[])=>{
  if(typeof keys==="string")return {[keys]:state[keys]};
  return Object.fromEntries(keys.map(k=>[k,state[k]]));
 },set:async(value:Record<string,unknown>)=>{Object.assign(state,structuredClone(value));}}},runtime:{sendMessage,sendNativeMessage},scripting:{executeScript:async({args}:{args:unknown[]})=>{
  if(args[1]==="detail")return [{result:{account:"a",detail:{mapping:{m:{message:{id:"m",author:{role:"user"},content:{parts:["hi"]}}}}}}}];
  return [{result:{account:"a",items:args[4]?[]:[{id:"c",updated:1}],total:1,next:null}}];
 }}}});
 await ctx.run();
 expect(sendNativeMessage).not.toHaveBeenCalled();
 expect(sendMessage).toHaveBeenCalledWith({action:"sync-capture",capture:expect.objectContaining({provider:"chatgpt"})});
});
