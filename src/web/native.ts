import {saveBrowserReceipt} from "../coverage/browser.js";
import { endianness } from "node:os";
import { parseWebCapture } from "./history.js";
import { importWebConversations } from "../cli/web-history.js";
import { runDiffSync } from "../sync/diff-sync.js";
const MAX_FRAME = 4*1024*1024;
const little = endianness() === "LE";
/** Frames are capped before allocation/parsing; fragmented headers are supported. */
export class NativeFrames {
  private pending = Buffer.alloc(0);
  feed(chunk: Buffer): unknown[] {
    if (this.pending.length + chunk.length > MAX_FRAME + 4) throw new Error("Native frame buffer limit exceeded");
    this.pending=Buffer.concat([this.pending,chunk]);
    const result:unknown[]=[];
    while(this.pending.length>=4) {
      const size=little ? this.pending.readUInt32LE(0) : this.pending.readUInt32BE(0);
      if(size===0 || size>MAX_FRAME) throw new Error("Invalid native frame length");
      if(this.pending.length<4+size) break;
      try { result.push(JSON.parse(this.pending.subarray(4,4+size).toString("utf8")) as unknown); }
      catch { throw new Error("Invalid native JSON"); }
      this.pending=this.pending.subarray(4+size);
    }
    return result;
  }
  finish():void { if(this.pending.length) throw new Error("Truncated native message"); }
}
export function nativeFrame(value:unknown):Buffer {
  const body=Buffer.from(JSON.stringify(value),"utf8");
  if(body.length>1024*1024) throw new Error("Native response too large");
  const header=Buffer.alloc(4);
  if(little) header.writeUInt32LE(body.length);else header.writeUInt32BE(body.length);
  return Buffer.concat([header,body]);
}
/** Reassembles one bounded capture per native port; incomplete transfers never reach import. */
export class NativeTransfers {
 private pending: {id:string;total:number;next:number;bytes:number;started:number;parts:string[]} | null = null;
 constructor(private maximum=64*1024*1024) {}
 get active():boolean { return this.pending!==null; }
 feed(raw:unknown,now=Date.now()): {complete:false;transferId:string;index:number} | {complete:true;transferId:string;index:number;capture:unknown} {
  try {
   if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("Invalid capture transfer");
   const v=raw as Record<string,unknown>;
   if(v.version!==1||v.action!=="capture-part"||typeof v.transferId!=="string"||!/^[a-zA-Z0-9_-]{1,100}$/.test(v.transferId)||!Number.isInteger(v.index)||!Number.isInteger(v.total)||(v.total as number)<1||(v.total as number)>512||typeof v.data!=="string"||Buffer.byteLength(v.data)>1024*1024)throw new Error("Invalid capture transfer part");
   if(!this.pending){if(v.index!==0)throw new Error("Capture transfer must start at zero");this.pending={id:v.transferId,total:v.total as number,next:0,bytes:0,started:now,parts:[]};}
   const p=this.pending;
   if(p.id!==v.transferId||p.total!==v.total||p.next!==v.index||now-p.started>180000)throw new Error("Capture transfer order or deadline mismatch");
   p.bytes+=Buffer.byteLength(v.data);if(p.bytes>this.maximum)throw new Error("Capture transfer exceeds byte budget");
   p.parts.push(v.data);p.next++;
   if(p.next<p.total)return {complete:false,transferId:p.id,index:v.index as number};
   const text=p.parts.join("");this.pending=null;
   return {complete:true,transferId:p.id,index:v.index as number,capture:JSON.parse(text) as unknown};
  }catch(error){this.pending=null;throw error;}
 }
}

export async function runWebNative(options:{project:string;account:string;sync?:boolean}):Promise<void> {
  const frames=new NativeFrames();
  const transfers=new NativeTransfers();
  // stdout is exclusively framed JSON. Account/project come from administrator
  // launch arguments, never a website or extension message.
  for await(const chunk of process.stdin) {
    for(const raw of frames.feed(chunk as Buffer)) {
      let reply:unknown;
      if(raw && typeof raw === "object" && !Array.isArray(raw) && (raw as Record<string,unknown>).version === 1 && (raw as Record<string,unknown>).action === "status") {
        process.stdout.write(nativeFrame({ok:true,host:"io.xtctx.web_history",protocol:1,capabilities:["message-offset","content-blocks-v2","large-message-stream","gemini-history-v1","coverage-v2"]}));
        continue;
      }
      try {
        if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&(raw as Record<string,unknown>).action==='coverage'){
          reply=await saveBrowserReceipt(raw,options.project,options.sync===true);
          process.stdout.write(nativeFrame(reply));continue;
        }
        let capture=raw;
        let transferAck: {complete:true;transferId:string;index:number} | undefined;
        if(raw && typeof raw==="object" && (raw as Record<string,unknown>).action==="capture-part"){
          const transfer=transfers.feed(raw);
          if(!transfer.complete){process.stdout.write(nativeFrame({ok:true,...transfer}));continue;}
          capture=transfer.capture;
          transferAck={complete:true,transferId:transfer.transferId,index:transfer.index};
        }else if(transfers.active)throw new Error("Incomplete capture transfer");
        const {provider,conversation,providerAccount}=parseWebCapture(capture);
        const imported=await importWebConversations(provider,providerAccount?`${options.account}:${providerAccount}`:options.account,[conversation],options.project);
        if(options.sync) {
          try {const synced=await runDiffSync({projectDir:options.project});reply={ok:true,imported,synced,syncPending:synced.busy || synced.skipped.length > 0};}
          catch {reply={ok:true,imported,syncPending:true,error:"Saved locally; authenticated sync is pending"};}
        } else reply={ok:true,imported,syncEnabled:false};
        if(transferAck)reply={...(reply as Record<string,unknown>),...transferAck};
      } catch {reply={ok:false,error:"Capture rejected or local import unavailable"};}
      process.stdout.write(nativeFrame(reply));
    }
  }
  frames.finish();
}
