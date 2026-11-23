import {it,expect,vi} from "vitest";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {webcrypto} from "node:crypto";
import {parseWebCapture,archiveWebConversation,parseWebExport} from "../../src/web/history.js";
const html='{"SNlM0e":"synthetic-private-csrf","oPEP7c":"person@example.invalid"}';
const frame=(rpc:string,data:unknown)=>")]}'\n123\n"+JSON.stringify([["wrb.fr",rpc,JSON.stringify(data)]]);
const response=(text:string)=>({ok:true,text:async()=>text});
function load(fetch=vi.fn(),path="/app"){
 const context={location:{hostname:"gemini.google.com",protocol:"https:",pathname:path},fetch,TextEncoder,TextDecoder,URLSearchParams,crypto:webcrypto};
 runInNewContext(readFileSync("browser-extension/gemini-reader.js","utf8").replaceAll("export ",""),context);
 return {read:(context as unknown as {readGemini:(...args:unknown[])=>Promise<{account:string;detail:{messages:Array<{id:string;content:string;parent:string|null;omittedBlockTypes:string[]}>};readerError:{message:string;code?:string}}>}).readGemini,fetch};
}
function turn(id="r_one",prompt="question",answer="answer"){
 return [["c_chat",id],null,[[prompt]],[[["rc_"+id,[answer]]]], [1700000000,0]];
}
it("Gemini uses account-bound, fixed read-only RPCs and opaque pagination",async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(response(html)).mockResolvedValueOnce(response(frame("MaZiqc",[null,"opaque-token",[["c_chat","title"]]])));
 const {read}=load(fetch,"/u/1/app");const result=await read("list",0,null);
 expect(result).toMatchObject({items:[{id:"c_chat",title:"title",updated:null}],next:"opaque-token"});
 expect(result.account).toMatch(/^gemini-[a-f0-9]{64}$/);expect(JSON.stringify(result)).not.toContain("synthetic-private");expect(JSON.stringify(result)).not.toContain("person@");
 expect(fetch.mock.calls[0][0]).toBe("/u/1/app");expect(fetch.mock.calls[1][0]).toContain("/u/1/_/BardChatUi/data/batchexecute?rpcids=MaZiqc");
 expect(fetch.mock.calls[1][1]).toMatchObject({credentials:"same-origin",redirect:"error",method:"POST"});
 expect(JSON.parse(new URLSearchParams(fetch.mock.calls[1][1].body).get('f.req')!)[0][0][1]).toBe(JSON.stringify([100,null,[0,null,1]]));
});
it("Gemini retains stable turn/candidate IDs, chronology and inferred timestamps",async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(response(html)).mockResolvedValueOnce(response(frame("hNvQHb",[[turn("r_new","new","Ω\\0tail"),turn()]])));
 const result=await load(fetch).read("detail",0,"c_chat");
 expect(result.detail.messages.map((m:{id:string})=>m.id)).toEqual(["r_one-user","rc_r_one","r_new-user","rc_r_new"]);
 expect(result.detail.messages[3].content).toBe("Ω\\0tail");expect(result.detail.messages[1].parent).toBe("r_one-user");
 expect(result.detail.messages[2].parent).toBeNull();expect(result.detail.messages[0].omittedBlockTypes).toContain("unverified_auxiliary_fields");
 const parsed=parseWebCapture({version:1,provider:"gemini",provider_account:result.account,capture_kind:"provider-api",conversation:{id:"c_chat",title:"title",messages:result.detail.messages}});
 const archive=archiveWebConversation(parsed.provider,"personal",parsed.conversation,"/archive");
 expect(archive.tool).toBe("gemini-web");expect(JSON.parse(archive.messages[0].metadata_json)).toMatchObject({source_complete:false,representation:"provider-api"});
});
it("Gemini rejects sign-in ambiguity, malformed RPC frames and unknown content",async()=>{
 for(const [page,data]of [["{}",null],[html,"not a response"],[html,frame("hNvQHb",[[[["c_chat","r_one"],null,null,null]]])]]){
  const fetch=vi.fn().mockResolvedValueOnce(response(page as string)).mockResolvedValueOnce(response(data as string));
  expect(await load(fetch).read("detail",0,"c_chat")).toHaveProperty("readerError");
 }
});
it("Gemini preserves cooldown evidence and never exposes raw server text",async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(response(html)).mockResolvedValueOnce({ok:false,status:429,headers:{get:()=>"120"},text:async()=>"sensitive server response"});
 const result=await load(fetch).read("list");expect(result).toMatchObject({readerError:{stage:"Gemini listing",code:"rate_limited",retryAfterSeconds:120}});
 expect(JSON.stringify(result)).not.toContain("sensitive");
});
it("Gemini refuses unsupported export formats rather than treating Takeout as Claude",()=>{
 expect(()=>parseWebExport("gemini",[])).toThrow("Takeout");
});
it("Gemini conversations cannot cross their requested source identity",async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(response(html)).mockResolvedValueOnce(response(frame("hNvQHb",[[turn()]])));
 expect(await load(fetch).read("detail",0,"c_other")).toHaveProperty("readerError");
});

it("Gemini account identity is required at the native boundary",()=>{
 const capture={version:1,provider:"gemini",conversation:{id:"c_chat",title:"title",messages:[]}};
 expect(()=>parseWebCapture(capture)).toThrow("verified provider account");
 const a=parseWebCapture({...capture,provider_account:"gemini-"+"a".repeat(64)});
 const b=parseWebCapture({...capture,provider_account:"gemini-"+"b".repeat(64)});
 expect(archiveWebConversation(a.provider,"personal:"+a.providerAccount,a.conversation,"/archive").session_ref).not.toBe(archiveWebConversation(b.provider,"personal:"+b.providerAccount,b.conversation,"/archive").session_ref);
});

it("Gemini retains non-text candidate identities and multiple text segments with explicit omissions",async()=>{
 const value=turn();(value[3] as unknown[])=[[["rc_image",null],["rc_segments",["one",null,"two"]]]];
 const fetch=vi.fn().mockResolvedValueOnce(response(html)).mockResolvedValueOnce(response(frame("hNvQHb",[[value]])));
 const result=await load(fetch).read("detail",0,"c_chat");
 expect(result.detail.messages[1]).toMatchObject({id:"rc_image",content:"",nonTextBlocks:1});
 expect(result.detail.messages[1].omittedBlockTypes).toContain("non_text_candidate");
 expect(result.detail.messages[2]).toMatchObject({id:"rc_segments",content:"one\ntwo",nonTextBlocks:1});
 const parsed=parseWebCapture({version:1,provider:"gemini",provider_account:result.account,conversation:{id:"c_chat",messages:result.detail.messages}});
 expect(parsed.conversation.messages).toHaveLength(3);
});
it("Gemini shape diagnostics exclude text, tokens and source IDs",async()=>{
 const value=turn();(value[3] as unknown[])=[[["private-unrecognized-id",[{secret:"private payload"}]]]];
 const fetch=vi.fn().mockResolvedValueOnce(response(html)).mockResolvedValueOnce(response(frame("hNvQHb",[[value]])));
 const result=await load(fetch).read("detail",0,"c_chat");const diagnostic=JSON.stringify(result);
 expect(result.readerError.message).toContain("rc-id=no");expect(result.readerError.message).toContain("first=object");
 expect(diagnostic).not.toContain("private-unrecognized-id");expect(diagnostic).not.toContain("private payload");expect(diagnostic).not.toContain("synthetic-private");
});

it("Gemini recognizes an explicit empty listing but never treats null responses as empty",async()=>{
 const emptyFetch=vi.fn().mockResolvedValueOnce(response(html)).mockResolvedValueOnce(response(frame("MaZiqc",[])));
 expect(await load(emptyFetch).read("list")).toMatchObject({items:[],next:null});
 for(const payload of [null,"null"]){
  const fetch=vi.fn().mockResolvedValueOnce(response(html)).mockResolvedValueOnce(response(JSON.stringify([["wrb.fr","MaZiqc",payload,null,["sensitive opaque value"]]])));
  const result=await load(fetch).read("list");
  expect(result.readerError.message).toMatch(/[Nn]o empty-history claim/);if(payload===null)expect(result.readerError.code).toBe("history_unavailable");else expect(result.readerError.message).toContain("frames=1");
  expect(JSON.stringify(result)).not.toContain("sensitive opaque value");expect(result).not.toHaveProperty("items");
 }
});
