// Read-only, same-origin history RPCs. Serialized into an isolated provider tab.
// No cookies, CSRF tokens, raw responses or account email leave this function.
export async function readGemini(operation, offset=0, id=null) {
 let stage="Gemini sign-in",retryAfterSeconds=null;
 try {
  if(location.protocol!=="https:"||location.hostname!=="gemini.google.com")throw Error("Wrong website");
  async function request(path,options={},maximum=8*1024*1024){
   const response=await fetch(path,{...options,credentials:"same-origin",redirect:"error"});
   if(response.status===429){const seconds=Number(response.headers?.get("retry-after"));retryAfterSeconds=Number.isFinite(seconds)&&seconds>0?Math.min(seconds,604800):900;throw Error("Rate limited; pause and retry later");}
   if(!response.ok)throw Error("Website request failed ("+response.status+")");
   let text="";const decoder=new TextDecoder();let bytes=0;
   if(response.body?.getReader){const reader=response.body.getReader();try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>maximum){await reader.cancel();throw Error("Website response exceeds reader limit");}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}}
   else {text=await response.text();if(new TextEncoder().encode(text).length>maximum)throw Error("Website response exceeds reader limit");}
   return text;
  }
  const prefix=location.pathname.match(/^\/u\/(\d{1,3})(?:\/|$)/)?.[0]?.replace(/\/$/,"")||"";
  const html=await request(prefix+"/app");
  const field=name=>{const match=html.match(new RegExp('"'+name+'"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")'));return match?JSON.parse(match[1]):null;};
  const token=field("SNlM0e"),email=field("oPEP7c");
  if(typeof token!=="string"||!token||typeof email!=="string"||!/^\S+@\S+\.\S+$/.test(email))throw Error("Sign in to Gemini first; active account could not be verified");
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(email.trim().toLowerCase()));
  const account="gemini-"+Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,"0")).join("");
  const rpc=operation==="list"?"MaZiqc":operation==="detail"?"hNvQHb":null;
  if(!rpc)throw Error("Unsupported reader operation");
  if(operation==="list"&&offset!==0&&(typeof offset!=="string"||offset.length>2048))throw Error("Invalid pagination token");
  if(operation==="detail"&&(typeof id!=="string"||!/^c_[a-zA-Z0-9_-]{1,198}$/.test(id)))throw Error("Invalid conversation ID");
  stage=operation==="list"?"Gemini listing":"Gemini conversation";
  const payload=operation==="list"?[100,offset===0?null:offset,[0,null,1]]:[id,10000,null,1,[0],[4],null,1];
  const body=new URLSearchParams({"f.req":JSON.stringify([[[rpc,JSON.stringify(payload),null,"generic"]]]),at:token});
  const raw=await request(prefix+"/_/BardChatUi/data/batchexecute?rpcids="+rpc+"&source-path="+encodeURIComponent(prefix+"/app"),{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},body:body.toString()},128*1024*1024);
  let data,frames=0;
  const responseShape=value=>value===undefined?"missing":value===null?"null":Array.isArray(value)?"array("+value.length+")":typeof value;
  let payloadShape="missing",envelopeShape="missing";
  for(const line of raw.split("\n")){const text=line.trim();if(!text.startsWith("["))continue;let envelope;try{envelope=JSON.parse(text);}catch{continue;}if(!Array.isArray(envelope))continue;for(const item of envelope)if(Array.isArray(item)&&item[0]==="wrb.fr"&&item[1]===rpc){frames++;payloadShape=responseShape(item[2]);envelopeShape=item.slice(3,8).map(responseShape).join(",");if(typeof item[2]==="string")data=JSON.parse(item[2]);}}
  if(operation==="list"&&frames===1&&payloadShape==="null")return {account,readerError:{stage,code:"history_unavailable",message:"Gemini returned no conversation-list data for this account. No saved history and restricted or disabled history access cannot be distinguished. Coverage remains unverified; no empty-history claim was saved."}};
  if(frames!==1||!Array.isArray(data))throw Error("Unsupported Gemini response format [frames="+frames+"; payload="+payloadShape+"; decoded="+responseShape(data)+"; envelope="+envelopeShape+"]. No empty-history claim was saved.");
  if(operation==="list"){
   // An explicit empty result array is distinct from a null/error response.
   const entries=data.length===0?[]:Array.isArray(data[2])?data[2]:data[0];
   if(!Array.isArray(entries)||entries.length>100)throw Error("Unsupported Gemini listing format");
   const next=data[1]===null||data[1]===undefined?null:data[1];
   if(next!==null&&(typeof next!=="string"||!next||next.length>2048))throw Error("Invalid pagination token");
   const items=entries.map(row=>{if(!Array.isArray(row)||typeof row[0]!=="string"||!/^c_[a-zA-Z0-9_-]{1,198}$/.test(row[0]))throw Error("Unsupported Gemini listing format");return {id:row[0],title:typeof row[1]==="string"?row[1]:"",updated:null};});
   return {account,total:null,items,next};
  }
  const turns=data[0];if(!Array.isArray(turns)||turns.length>=10000)throw Error("Unsupported or capped Gemini conversation");
  const messages=[],seen=new Set();let parent=null;
  for(const turn of [...turns].reverse()){
   if(!Array.isArray(turn)||!Array.isArray(turn[0])||turn[0][0]!==id||typeof turn[0][1]!=="string"||!/^r_[a-zA-Z0-9_-]+$/.test(turn[0][1]))throw Error("Unsupported Gemini turn identity");
   const responseId=turn[0][1],prompt=turn[2]?.[0]?.[0],candidates=turn[3]?.[0];
   if(typeof prompt!=="string"||!Array.isArray(candidates))throw Error("Unsupported Gemini content format");
   const stamp=Array.isArray(turn[4])&&typeof turn[4][0]==="number"?new Date(turn[4][0]*1000):null;
   const timestamp=stamp&&Number.isFinite(stamp.getTime())?stamp.toISOString():null;
   const userId=responseId+"-user";
   if(seen.has(userId))throw Error("Repeated Gemini turn identity");seen.add(userId);
   messages.push({id:userId,role:"user",content:prompt,parent,timestamp,nonTextBlocks:0});
   for(const candidate of candidates){
    const cid=candidate?.[0],parts=candidate?.[1];
    const shape=value=>value===undefined?"missing":value===null?"null":Array.isArray(value)?"array":typeof value;
    const validId=typeof cid==="string"&&/^rc_[a-zA-Z0-9_-]+$/.test(cid);
    const validParts=parts===undefined||parts===null||(Array.isArray(parts)&&parts.every(part=>typeof part==="string"||part===null));
    if(!Array.isArray(candidate)||!validId||!validParts||seen.has(cid))throw Error("Unsupported Gemini candidate format [candidate="+shape(candidate)+"; id="+shape(cid)+"; rc-id="+(validId?"yes":"no")+"; parts="+shape(parts)+"; first="+shape(parts?.[0])+"; duplicate="+(seen.has(cid)?"yes":"no")+"]");
    const textParts=Array.isArray(parts)?parts.filter(part=>typeof part==="string"):[];
    const missing=parts==null||parts.length===0?1:parts.filter(part=>part===null).length;
    seen.add(cid);messages.push({id:cid,role:"assistant",content:textParts.join("\n"),parent:userId,timestamp,nonTextBlocks:missing});
   }
   // The selected candidate is not established by array order.
   parent=null;
  }
  for(const message of messages)Object.assign(message,{contentCaptureVersion:2,blockTypes:message.content?["text"]:["non_text_candidate"],preservedBlockTypes:message.content?["text"]:[],omittedBlockTypes:["unverified_auxiliary_fields",...(message.nonTextBlocks?["non_text_candidate"]:[])],attachmentRefs:[],attachmentMetadataOmitted:0});
  return {account,detail:{messages,title:""}};
 }catch(error){
  const message=typeof error?.message==="string"&&/^(Wrong website|Sign in to Gemini|Website request failed \(\d+\)$|Rate limited;|Website response exceeds|Unsupported|Invalid pagination|Invalid conversation|Repeated Gemini)/.test(error.message)?error.message:"Website reader failed; check sign-in and compatibility";
  return {readerError:{stage,message,...(retryAfterSeconds?{code:"rate_limited",retryAfterSeconds}:{})}};
 }
}
