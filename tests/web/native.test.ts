import {it,expect} from "vitest";
import {NativeFrames,NativeTransfers,nativeFrame} from "../../src/web/native.js";
import {parseWebCapture} from "../../src/web/history.js";
it("native frames handle split headers, Unicode and consecutive messages",()=>{
 const bytes=Buffer.concat([nativeFrame({text:"Ã§Å’Â«"}),nativeFrame({text:"two"})]);
 const decoder=new NativeFrames();expect(decoder.feed(bytes.subarray(0,2))).toEqual([]);
 expect(decoder.feed(bytes.subarray(2))).toEqual([{text:"Ã§Å’Â«"},{text:"two"}]);decoder.finish();
});
it("rejects oversized and truncated input before JSON parsing",()=>{
 const d=new NativeFrames();expect(()=>d.feed(Buffer.from([255,255,255,255]))).toThrow("length");
 const e=new NativeFrames();e.feed(Buffer.from([1,0]));expect(()=>e.finish()).toThrow("Truncated");
});
it("capture is partial and cannot choose account, project or an upload URL",()=>{
 const value={version:1,provider:"chatgpt",project:"/evil",account:"other",url:"https://evil.test",conversation:{id:"c",messages:[{id:"m",role:"user",content:"hi",timestamp:null,parent:null}]}};
 const parsed=parseWebCapture(value);expect(parsed.conversation.complete).toBe(false);expect(parsed).not.toHaveProperty("project");expect(parsed).not.toHaveProperty("account");
 expect(()=>parseWebCapture({...value,provider:"other"})).toThrow("provider");
});

it("native capture retains validated non-text omission counts",()=>{
 const value={version:1,provider:"chatgpt",conversation:{id:"c",messages:[{id:"m",role:"assistant",content:"",parent:null,timestamp:null,nonTextBlocks:2}]}};
 expect(parseWebCapture(value).conversation.messages[0].nonTextBlocks).toBe(2);
 expect(()=>parseWebCapture({...value,conversation:{id:"c",messages:[{...value.conversation.messages[0],nonTextBlocks:-1}]}})).toThrow("non-text");
});

it("API capture keeps its provenance while remaining explicitly partial",()=>{
 const parsed=parseWebCapture({version:1,provider:"chatgpt",capture_kind:"provider-api",conversation:{id:"c",messages:[]}});
 expect(parsed.conversation.representation).toBe("provider-api");expect(parsed.conversation.complete).toBe(false);
});

it("capture message offsets are bounded and preserved",()=>{
 const value={version:1,provider:"claude",message_offset:3,conversation:{id:"c",messages:[{id:"m",role:"user",content:"hi",timestamp:null,parent:null}]}};
 expect(parseWebCapture(value).conversation.messageOffset).toBe(3);
 for(const offset of [-1,0.5,20000,"3"])expect(()=>parseWebCapture({...value,message_offset:offset})).toThrow("offset");
});

it("large-message transfer reassembles exact Unicode and imports no incomplete payload",()=>{
 const text=JSON.stringify({content:"猫".repeat(500000),tail:"done"});const transfer=new NativeTransfers();let final:unknown;
 for(let index=0,total=Math.ceil(text.length/200000);index<total;index++){
  const result=transfer.feed({version:1,action:"capture-part",transferId:"fixture",index,total,data:text.slice(index*200000,(index+1)*200000)});
  if(result.complete)final=result.capture;else expect("capture" in result).toBe(false);
 }
 expect(final).toEqual(JSON.parse(text));expect(transfer.active).toBe(false);
});
it("transfer budget, interleaving, duplicate parts and deadlines fail closed",()=>{
 const part={version:1,action:"capture-part",transferId:"fixture",index:0,total:2,data:"{"};
 for(const invalid of [{...part,index:0},{...part,index:1,transferId:"other"},{...part,index:1,total:3}]){
  const t=new NativeTransfers();t.feed(part,0);expect(()=>t.feed(invalid,1)).toThrow();expect(t.active).toBe(false);
 }
 const t=new NativeTransfers(2);t.feed(part,0);expect(()=>t.feed({...part,index:1,data:"long"},1)).toThrow("budget");
 const expired=new NativeTransfers();expired.feed(part,0);expect(()=>expired.feed({...part,index:1,data:"}"},180001)).toThrow("deadline");
});
it("native capture retains a complete message larger than the former 1 MiB bound",()=>{
 const content="x".repeat(1024*1024+1);const value={version:1,provider:"claude",conversation:{id:"c",messages:[{id:"m",role:"user",content,parent:null,timestamp:null}]}};
 expect(parseWebCapture(value).conversation.messages[0].content).toBe(content);
});
