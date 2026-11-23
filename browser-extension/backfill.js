import {readGemini} from "./gemini-reader.js";
import {claudeContent} from "./claude-content.js";
// Runs in an extension page, not a short-lived service worker. Closing it pauses.

let stopped=false,running=false;

const progress=document.querySelector("#progress");

const validId=x=>typeof x==="string" && /^[a-zA-Z0-9_-]{1,200}$/.test(x);

export function chatGptContent(value){

 const content=value&&typeof value==="object"&&!Array.isArray(value)?value:{};

 if(Array.isArray(content.parts)){

  const texts=[];let nonTextBlocks=0;

  for(const part of content.parts){

   if(typeof part==="string")texts.push(part);

   else if(part&&typeof part==="object"&&part.type==="text"&&typeof part.text==="string")texts.push(part.text);

   else nonTextBlocks++;

  }

  return {text:texts.join("\n"),nonTextBlocks};

 }

 if(typeof content.text==="string")return {text:content.text,nonTextBlocks:0};

 // Keep the message identity even when its payload is audio/image/tool metadata.

 // Never stringify an opaque payload or invent replacement conversation text.

 return {text:"",nonTextBlocks:1};

}

export function normalizeDetail(provider,raw){

 const messages=[];
 if(provider==="gemini"){if(!Array.isArray(raw.messages))throw Error("Unsupported Gemini detail format");return raw.messages;} 

 if(provider==="chatgpt"){

  if(!raw.mapping || typeof raw.mapping!=="object")throw new Error("Unsupported ChatGPT detail format");

  for(const [nodeId,node] of Object.entries(raw.mapping)){

   const m=node?.message;if(!m)continue;

   const extracted=chatGptContent(m.content);

   const role=m.author?.role;if(!["user","assistant","system","tool","developer"].includes(role))throw new Error("Unsupported message role");

   const id=m.id||nodeId;if(!validId(id))throw new Error("Invalid message identity");

   messages.push({id,role,content:extracted.text,nonTextBlocks:extracted.nonTextBlocks,parent:typeof node.parent==="string"?node.parent:null,timestamp:typeof m.create_time==="number"?new Date(m.create_time*1000).toISOString():null});

  }

 }else{

  if(!Array.isArray(raw.chat_messages))throw new Error("Unsupported Claude detail format");

  for(const m of raw.chat_messages){

   const role=m.sender==="human"?"user":m.sender;

   if(!validId(m.uuid)||!["user","assistant"].includes(role))throw new Error("Unsupported Claude identity/role");

   const extracted=claudeContent(m);
   messages.push({id:m.uuid,role,...extracted,parent:validId(m.parent_message_uuid)?m.parent_message_uuid:null,timestamp:typeof m.created_at==="string"?m.created_at:null});

  }

 }

 return messages;

}

// Runs in the matching tab's isolated extension world. No page JavaScript access is needed.

// Credentials never leave this function.

export async function readProvider(provider,operation,offset,id,archived,organizationId){

 let stage="site check",rateLimitSeconds=null;

 try {

 const expected=provider==="chatgpt"?"chatgpt.com":provider==="gemini"?"gemini.google.com":"claude.ai";

 if(location.hostname!==expected || location.protocol!=="https:")throw new Error("Wrong website");

 const headers={};

 async function get(path,maximum=4*1024*1024){
  // ChatGPT shares account limits with ordinary browsing. Pace every HTTP
  // request, including auth/listing requests, not only successful imports.
  if(provider==='chatgpt')await new Promise(resolve=>setTimeout(resolve,10000));


  const response=await fetch(path,{credentials:"same-origin",headers,redirect:"error"});

  if(response.status===429){
   const header=response.headers?.get("retry-after");
   const seconds=header&&/^\d+$/.test(header)?Number(header):header?Math.ceil((Date.parse(header)-Date.now())/1000):NaN;
   rateLimitSeconds=Number.isFinite(seconds)&&seconds>0?Math.max(1,seconds):900;
  }
  if(!response.ok)throw new Error(response.status===429?"Rate limited; pause and retry later":"Website request failed ("+response.status+")");

  let text="";
  if(response.body?.getReader){
   const reader=response.body.getReader();const decoder=new TextDecoder();let size=0;
   try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maximum){await reader.cancel();throw new Error("Website response exceeds the bounded reader limit");}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
   finally {reader.releaseLock();}
  }else {text=await response.text();if(new TextEncoder().encode(text).length>maximum)throw new Error("Website response exceeds the bounded reader limit");}

  try {return JSON.parse(text);}catch {throw new Error("Website returned a non-JSON response; check the reader tab for sign-in or a browser challenge");}

 }

 if(provider==="chatgpt"){

  stage="ChatGPT sign-in";

  const session=await get("/api/auth/session");

  if(typeof session.accessToken!=="string"||typeof session.user?.id!=="string")throw new Error("Sign in to ChatGPT first");

  headers.Authorization="Bearer "+session.accessToken;

  const account=session.user.id;

  if(operation==="list"){

   stage="ChatGPT listing";

   const data=await get("/backend-api/conversations?offset="+offset+"&limit=100&order=updated&is_archived="+Boolean(archived));

   if(!Array.isArray(data.items)||!Number.isInteger(data.total))throw new Error("Unsupported ChatGPT listing format");

   return {account,total:data.total,items:data.items.map(x=>({id:x.id,updated:x.update_time??null})),next:offset+data.items.length<data.total?offset+data.items.length:null};

  }

  if(!/^[a-zA-Z0-9_-]{1,200}$/.test(id))throw new Error("Invalid conversation ID");

  stage="ChatGPT conversation";

  const data=await get("/backend-api/conversation/"+encodeURIComponent(id),128*1024*1024);

  return {account,detail:{mapping:data.mapping,title:data.title}};

 }

 stage="Claude organizations";

 const organizations=await get("/api/organizations");

 if(!Array.isArray(organizations)||!organizations.length||organizations.length>100||organizations.some(x=>!x||typeof x.uuid!=="string"||!/^[a-zA-Z0-9_-]{1,200}$/.test(x.uuid)))throw new Error("Unsupported Claude organization listing");

 if(!organizationId&&organizations.length>1)return {selectionRequired:true,organizations:organizations.map(x=>({id:x.uuid,name:typeof x.name==="string"?x.name.slice(0,200):"Claude organization"}))};

 const account=organizationId||organizations[0].uuid;

 if(!organizations.some(x=>x.uuid===account))throw new Error("Selected Claude organization is no longer accessible");

 if(!/^[a-zA-Z0-9_-]{1,200}$/.test(account))throw new Error("Invalid organization ID");

 const base="/api/organizations/"+encodeURIComponent(account)+"/chat_conversations";

 if(operation==="list"){

  stage="Claude listing";

  const data=await get(base);

  if(!Array.isArray(data)||data.length>100000)throw new Error("Unsupported Claude listing format");

  return {account,total:data.length,organizationCount:organizations.length,items:data.map(x=>({id:x.uuid,updated:x.updated_at??null})),next:null};

 }

 if(!/^[a-zA-Z0-9_-]{1,200}$/.test(id))throw new Error("Invalid conversation ID");

 stage="Claude conversation";

 const data=await get(base+"/"+encodeURIComponent(id)+"?tree=True&rendering_mode=messages&render_all_tools=true",128*1024*1024);

 return {account,detail:{chat_messages:data.chat_messages,name:data.name}};

 }catch(error){

  // executeScript can discard thrown exceptions. Return only our fixed diagnostics,

  // never arbitrary exception text, response bodies, cookies, URLs or credentials.

  const known=["Wrong website","Website response exceeds the bounded reader limit","Sign in to ChatGPT first","Unsupported ChatGPT listing format","Invalid conversation ID","Unsupported Claude organization listing","Selected Claude organization is no longer accessible","Invalid organization ID","Unsupported Claude listing format","Website returned a non-JSON response; check the reader tab for sign-in or a browser challenge","Rate limited; pause and retry later"];

  const raw=typeof error?.message==="string"?error.message:"";

  const message=known.includes(raw)||/^Website request failed \(\d{3}\)$/.test(raw)?raw:"Website request did not complete; check the reader tab for sign-in or a browser challenge";

  return {readerError:{stage,message,...(rateLimitSeconds===null?{}:{code:"rate_limited",retryAfterSeconds:rateLimitSeconds})}};

 }

}

// Split only at message boundaries. Provider IDs and full text remain unchanged.
export function captureBatches(capture,maximum=2500*1024){
 const messages=capture.conversation.messages;
 if(messages.length>20000)throw new Error("Conversation exceeds the 20000-message import limit");
 const size=value=>new TextEncoder().encode(JSON.stringify(value)).length;
 const batches=[];let offset=0,batch=[],bytes=0;
 const envelope=part=>({...capture,message_offset:offset,conversation:{...capture.conversation,messages:part}});
 const overhead=size(envelope([]))+16;
 const flush=()=>{const frame=envelope(batch);if(size(frame)>64*1024*1024)throw new Error("Conversation part exceeds the 64 MiB bounded capture limit");batches.push(frame);offset+=batch.length;batch=[];bytes=0;};
 for(const message of messages){
  if(new TextEncoder().encode(message.content).length>64*1024*1024)throw new Error("One message exceeds the 64 MiB bounded capture limit; no text was truncated");
  const added=size(message)+1;
  if(overhead+added>maximum){if(batch.length)flush();batch=[message];bytes=added;flush();continue;}
  if(batch.length&&(overhead+bytes+added>maximum||batch.length>=200))flush();
  batch.push(message);bytes+=added;
 }
 if(batch.length||!batches.length)flush();
 return batches;
}

// Large messages keep one source identity. Only the transport JSON is fragmented.
export async function sendCapture(capture,bridge){
 const text=JSON.stringify(capture),bytes=new TextEncoder().encode(text).length;
 const needsLarge=capture.conversation.messages.some(m=>new TextEncoder().encode(m.content).length>1024*1024);
 if((needsLarge||bytes>2500*1024)&&!bridge.capabilities?.includes("large-message-stream"))throw new Error("Native bridge needs the large-message update; no checkpoint was advanced");
 if(bytes<=2500*1024)return chrome.runtime.sendNativeMessage("io.xtctx.web_history",capture);
 if(bytes>64*1024*1024)throw new Error("Capture exceeds the 64 MiB transfer budget; no text was truncated");
 const total=Math.ceil(text.length/(256*1024));const transferId=crypto.randomUUID();
 const port=chrome.runtime.connectNative("io.xtctx.web_history");
 return new Promise((resolve,reject)=>{
  let index=0,settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);try{port.disconnect();}catch{}if(error)reject(error);else resolve(value);};
  const timer=setTimeout(()=>finish(new Error("Large-message transfer timed out; resume retries safely")),180000);
  const send=()=>{if(stopped)return finish(new Error("Paused during large-message transfer; resume retries safely"));try{port.postMessage({version:1,action:"capture-part",transferId,index,total,data:text.slice(index*256*1024,(index+1)*256*1024)});}catch{finish(new Error("Large-message bridge disconnected; resume retries safely"));}};
  port.onDisconnect.addListener(()=>finish(new Error("Large-message bridge disconnected; resume retries safely")));
  port.onMessage.addListener(reply=>{
   if(settled)return;
   if(!reply?.ok)return finish(new Error("Local archive rejected a large message; checkpoint retained"));
   if(index===total-1){if(reply.complete!==true||reply.transferId!==transferId||reply.index!==index)return finish(new Error("Large-message acknowledgement mismatch; checkpoint retained"));return finish(null,reply);}
   if(reply.complete!==false||reply.transferId!==transferId||reply.index!==index)return finish(new Error("Large-message acknowledgement mismatch; checkpoint retained"));
   index++;send();
  });
  send();
 });
}

export async function checkNativeBridge(){

 try {

  const reply=await chrome.runtime.sendNativeMessage("io.xtctx.web_history",{version:1,action:"status"});

  if(!reply?.ok||reply.host!=="io.xtctx.web_history"||reply.protocol!==1)throw new Error("Native host replied but has an incompatible bridge version");
  return reply;

 }catch(error){

  const reason=typeof error?.message==="string"?error.message:"unknown native-messaging error";

  throw new Error("Native bridge check failed before reading history. Host: io.xtctx.web_history; extension: "+chrome.runtime.id+". Browser: "+reason);

 }

}

export function chatgptCooldown(now,retryAfter,previous={}){
 const recent=Number.isFinite(previous.at)&&now-previous.at<86400000&&now>=previous.at;
 const strikes=recent&&Number.isInteger(previous.strikes)?Math.min(3,Math.max(0,previous.strikes)):0;
 const seconds=Math.max(Number.isSafeInteger(retryAfter)&&retryAfter>0?retryAfter:900,3600*2**strikes);
 const until=now+seconds*1000;
 if(!Number.isFinite(new Date(until).getTime()))throw Error('Invalid provider cooldown. Stop importing and check the website.');
 return {at:now,strikes:Math.min(4,strikes+1),until};
}

async function run(){

 if(running)return;running=true;stopped=false;

 let readerTabId=null;

 try{

 progress.textContent="Reader v8: checking site permission and selecting a signed-in tab...";

 const provider=document.querySelector("#provider").value;
 const cooldownKey="rate-limit:"+provider;
 const cooldown=(await chrome.storage.local.get(cooldownKey))[cooldownKey];
 if(Number.isFinite(cooldown)&&cooldown>Date.now())throw new Error("Provider cooldown active until "+new Date(cooldown).toLocaleString()+". Checkpoints are safe; resume after that time.");

 const origin="https://"+(provider==="chatgpt"?"chatgpt.com":provider==="gemini"?"gemini.google.com":"claude.ai")+"/*";

 if(!await chrome.permissions.request({origins:[origin]}))throw new Error("Website permission required");

 const expectedHost=provider==="chatgpt"?"chatgpt.com":provider==="gemini"?"gemini.google.com":"claude.ai";

 if(!await chrome.permissions.contains({origins:[origin]}))throw new Error("Site access was not granted. In Brave, open xtctx extension Details > Site access and allow https://"+expectedHost+"/* only, then retry.");

 // Use a newly navigated, owned tab: pre-existing tabs may retain a stale

 // document permission state after installing/reloading an unpacked extension.

 const syncCfg = await chrome.storage.local.get(["syncMode", "syncToken"]);
 const useWebSync = syncCfg.syncMode === "web" || (Boolean(syncCfg.syncToken) && syncCfg.syncMode !== "local");
 if(useWebSync && !syncCfg.syncToken)throw new Error("Web sync not configured. Add a sync token in the popup or switch to Local Dev Mode.");

 const bridge=useWebSync
  ? {ok:true,capabilities:["message-offset","content-blocks-v2"]}
  : await checkNativeBridge();
 if(provider==="claude"&&!bridge.capabilities?.includes("content-blocks-v2"))throw new Error("Native bridge needs the content-preservation update before Claude import. No checkpoint was advanced.");

 if(provider==="gemini"&&!bridge.capabilities?.includes("gemini-history-v1"))throw Error("Native bridge needs the Gemini update before import. No checkpoint was advanced.");
 let readerUrl="https://"+expectedHost+"/",requestedGeminiSlot=null;
 if(provider==="gemini"){
  let chosen;try{chosen=new URL(document.querySelector("#gemini-account-url").value);}catch{throw Error("Paste the URL of the Gemini tab for the account you want to import.");}
  if(chosen.origin!=="https://gemini.google.com"||chosen.username||chosen.password)throw Error("Use a Gemini account tab URL on https://gemini.google.com only.");
  const match=chosen.pathname.match(/^\/(?:u\/(\d{1,3})\/)?app(?:\/[a-zA-Z0-9_-]+)?\/?$/);
  if(!match)throw Error("Use the Gemini app tab URL after selecting your Google account.");
  let slot=match[1]??chosen.searchParams.get("authuser")??"0";
  if(!/^\d{1,3}$/.test(slot))throw Error("Use a Gemini URL with a numeric Google account selector.");
  requestedGeminiSlot=Number(slot);readerUrl="https://gemini.google.com/u/"+requestedGeminiSlot+"/app";
 }
 const tab=await chrome.tabs.create({url:readerUrl,active:false});

 if(!Number.isInteger(tab?.id))throw new Error("Could not open the provider reader tab");

 readerTabId=tab.id;

 const deadline=Date.now()+30000;

 while(true){

  const current=await chrome.tabs.get(tab.id);

  if(current.status==="complete"){

   const url=new URL(current.url);

   if(url.protocol!=="https:"||url.hostname!==expectedHost)throw new Error("Sign in to "+expectedHost+" in its reader tab, then retry");

   if(provider==="gemini"){
    const actual=Number(url.pathname.match(/^\/u\/(\d{1,3})(?:\/|$)/)?.[1]??0);
    if(actual!==requestedGeminiSlot)throw Error("Gemini redirected to a different Google account slot. Select the intended account in Gemini and retry with its tab URL.");
   }
   break;

  }

  if(Date.now()>deadline)throw new Error("Provider reader tab did not finish loading; retry when it is ready");

  if(stopped)throw new Error("Backfill paused");

  await new Promise(resolve=>setTimeout(resolve,250));

 }

 const organizationId=provider==="claude"?(document.querySelector("#organization").value||null):null;

 let key="bulk-"+provider+(organizationId?":"+organizationId:"");

 let stored=provider==="gemini"?{done:{},account:null}:((await chrome.storage.local.get(key))[key]||{done:{},account:null});
 let geminiSweep=null;

 let completed=0,skipped=0,nonTextBlocks=0,listingStatus="";

 async function read(operation,offset=0,id=null,archived=false){

  let result;

  try {result=await chrome.scripting.executeScript({target:{tabId:tab.id},world:"ISOLATED",func:provider==="gemini"?readGemini:readProvider,args:provider==="gemini"?[operation,offset,id]:[provider,operation,offset,id,archived,organizationId]});}

  catch(error){

   if(typeof error?.message === "string" && /cannot access|permission|host/i.test(error.message))throw new Error("Reader v8: Brave rejected ISOLATED injection into a newly opened "+expectedHost+" reader tab despite the site grant. This is not an API or native-host error. Keep the reader tab open and report this diagnostic; do not change permissions again.");

   throw error;

  }

  const value=result[0]?.result;

  if(value?.selectionRequired){

   if(!Array.isArray(value.organizations)||!value.organizations.length||value.organizations.some(x=>!validId(x.id)))throw new Error("Invalid Claude organization choices");

   const select=document.querySelector("#organization");

   const placeholder=document.createElement("option");placeholder.value="";placeholder.textContent="Choose an organization";

   select.replaceChildren(placeholder);

   for(const org of value.organizations){const option=document.createElement("option");option.value=org.id;option.textContent=org.name+" ("+org.id.slice(0,8)+")";select.appendChild(option);}

   select.value="";document.querySelector("#organization-label").hidden=false;

   throw new Error("Choose a Claude organization above, then click Start or resume backfill. Each organization keeps its own progress.");

  }

  if(value?.readerError){
   if(provider==="gemini"&&value.readerError.code==="history_unavailable"&&/^gemini-[a-f0-9]{64}$/.test(value.account)){
    await chrome.storage.local.set({["bulk-gemini:"+value.account+":coverage"]:{version:1,provider,account:value.account,observedAt:new Date().toISOString(),status:"unavailable",reason:"missing-history-payload",listings:[],accountWideVerified:false,originalAttachmentsDownloaded:false}});
   }
   if(value.readerError.code==="rate_limited"){
    const seconds=Number.isInteger(value.readerError.retryAfterSeconds)&&value.readerError.retryAfterSeconds>0?value.readerError.retryAfterSeconds:900;
    let until=Date.now()+seconds*1000;
    if(provider==='chatgpt'){
     const key='rate-limit-history:chatgpt';const previous=(await chrome.storage.local.get(key))[key]||{};
     const next=chatgptCooldown(Date.now(),seconds,previous);until=next.until;
     await chrome.storage.local.set({[key]:next});
    }
    await chrome.storage.local.set({[cooldownKey]:until});
    throw new Error("Rate limited by "+expectedHost+". Checkpoints saved. Resume after "+new Date(until).toLocaleString()+"; no automatic retry will run.");
   }
   throw new Error("Reader v8: "+value.readerError.stage+": "+value.readerError.message);
  }

  if(!value?.account)throw new Error("Reader v8: Brave returned no reader result before import. Reload xtctx and reopen backfill; no conversation checkpoint was advanced.");

  if(provider==="claude"&&key==="bulk-claude"){

   const scopedKey="bulk-claude:"+value.account;

   const scoped=(await chrome.storage.local.get(scopedKey))[scopedKey];

   stored=scoped||(stored.account===value.account?stored:{done:{},account:null});key=scopedKey;

  }

  if(provider==="gemini"&&key==="bulk-gemini"){
   if(!/^gemini-[a-f0-9]{64}$/.test(value.account))throw Error("Gemini active account could not be verified.");
   const scopedKey="bulk-gemini:"+value.account;
   const scoped=(await chrome.storage.local.get(scopedKey))[scopedKey];
   const legacy=(await chrome.storage.local.get("bulk-gemini"))["bulk-gemini"];
   stored=scoped||(legacy?.account===value.account?legacy:{done:{},account:null});key=scopedKey;
   geminiSweep=stored.geminiSweep||new Date().toISOString();
  }
  if(stored.account&&stored.account!==value.account)throw new Error("Account changed; use a separate browser profile/archive");

  stored.account=value.account;return value;

 }

 // A completed sweep is followed by a fresh reconciliation on the next explicit run.
 if(provider==="chatgpt"&&stored.listingResume?.normal?.finished&&stored.listingResume?.archived?.finished)delete stored.listingResume;
 const coverage=[];
 for(const archived of provider==="chatgpt"?[false,true]:[false]){

 const listingScope=archived?"archived":"normal";
 const resume=provider==="chatgpt"?stored.listingResume?.[listingScope]:null;
 if(resume?.finished){coverage.push(resume.coverage);continue;}
 let offset=resume?.offset??0;const tokens=new Set();const seen=new Set(resume?.seen??[]);let pages=resume?.pages??0,reportedTotal=resume?.reportedTotal??null,totalStable=resume?.totalStable??true,organizationCount=null;

 do{

  if(stopped)break;

  const page=await read("list",offset,null,archived);
  pages++;
  if(Number.isInteger(page.total)){if(reportedTotal!==null&&reportedTotal!==page.total)totalStable=false;reportedTotal=page.total;}
  if(Number.isInteger(page.organizationCount))organizationCount=page.organizationCount;

  listingStatus=(archived?"Archived":"Normal")+" listing: "+(Number.isInteger(page.total)?page.total+" reported":"total not reported")+(provider==="gemini"?"; page "+pages:"; offset "+offset);

  progress.textContent=listingStatus+". Saved checkpoints "+Object.keys(stored.done).length+"; imported this run "+completed+"; unchanged "+skipped+".";

  if(page.next!==null){
   if(provider==="gemini"){if(typeof page.next!=="string"||!page.next||page.next.length>2048||tokens.has(page.next)||!page.items.length)throw Error("Invalid pagination; stopped safely");tokens.add(page.next);}
   else if(!Number.isInteger(page.next)||page.next<=offset||!page.items.length)throw Error("Invalid pagination; stopped safely");
  }

  const pageSeen=new Set();
  for(const item of page.items){

   if(stopped)break;

   if(!validId(item.id))throw new Error("Invalid conversation ID in listing");

   if(pageSeen.has(item.id))throw new Error("Repeated conversation in listing; retry when history is stable");pageSeen.add(item.id);
   // Updated-order pagination can move an already seen chat onto a later page.
   if(seen.has(item.id)&&provider!=="chatgpt")throw new Error("Repeated conversation in listing; retry when history is stable");seen.add(item.id);

   if(provider==="gemini"&&stored.geminiSweep===geminiSweep&&stored.contentVersions?.[item.id]===geminiSweep){skipped++;continue;}
   if(item.updated!==null&&stored.done[item.id]===item.updated&&(provider!=="claude"||stored.contentVersions?.[item.id]===2)){skipped++;continue;}

   const {detail}=await read("detail",0,item.id);

   const capture={version:1,provider,...(provider==="gemini"?{provider_account:stored.account}:{}),capture_kind:"provider-api",conversation:{id:item.id,title:detail.title||detail.name||item.title||"",messages:normalizeDetail(provider,detail)}};

   const batches=captureBatches(capture);
   if(batches.length>1&&!bridge.capabilities?.includes("message-offset"))throw new Error("Native bridge needs the large-conversation update before import. No conversation checkpoint was advanced.");
   for(let part=0;part<batches.length;part++){
    if(stopped)throw new Error("Paused during a conversation; resume retries it safely");
    progress.textContent=listingStatus+". Saving conversation part "+(part+1)+" of "+batches.length+"...";
    const reply=useWebSync
     ? await chrome.runtime.sendMessage({action:"sync-capture",capture:batches[part]})
     : await sendCapture(batches[part],bridge);
    if(!reply?.ok)throw new Error(reply?.error||"Local archive rejected a conversation part; checkpoint retained");
    if(reply.syncPending)throw new Error("Saved locally; remote sync pending. Resume to retry safely");
   }

   nonTextBlocks+=capture.conversation.messages.reduce((n,m)=>n+(m.nonTextBlocks||0),0);

   if(provider==="gemini"){stored.geminiSweep=geminiSweep;stored.contentVersions??={};stored.contentVersions[item.id]=geminiSweep;}
   stored.done[item.id]=item.updated;if(provider==="claude"){stored.contentVersions??={};stored.contentVersions[item.id]=2;}await chrome.storage.local.set({[key]:stored});

   completed++;progress.textContent=`${listingStatus}. Saved checkpoints ${Object.keys(stored.done).length}. Imported ${completed}; unchanged ${skipped}; non-text blocks not imported ${nonTextBlocks}. Keep this page open.`;

   await new Promise(resolve=>setTimeout(resolve,provider==="chatgpt"?3000:2000));

  }

  if(!stopped){
   offset=page.next;
   if(provider==="chatgpt"){
    stored.listingResume??={};
    stored.listingResume[listingScope]={offset,seen:[...seen],pages,reportedTotal,totalStable,finished:offset===null,coverage:{scope:listingScope,listed:seen.size,reportedTotal,totalStable,pages,organizationCount:null,listingExhausted:offset===null}};
    await chrome.storage.local.set({[key]:stored});
   }
  }

 }while(offset!==null&&!stopped);
 coverage.push({scope:provider==="chatgpt"?(archived?"archived":"normal"):provider==="gemini"?"visible-history":"selected-organization",listed:seen.size,reportedTotal,totalStable,pages,organizationCount,listingExhausted:offset===null&&!stopped});

 if(stopped)break;

 }

 if(!stopped&&provider==="gemini"){delete stored.geminiSweep;delete stored.contentVersions;await chrome.storage.local.set({[key]:stored});}
 if(!stopped)await chrome.storage.local.set({[key+":coverage"]:{version:1,provider,account:stored.account,completedAt:new Date().toISOString(),listings:coverage,importedThisRun:completed,unchangedThisRun:skipped,omittedBlocksThisRun:nonTextBlocks,accountWideVerified:false,originalAttachmentsDownloaded:false}});
 let receiptStatus='';
 if(!stopped&&stored.account&&bridge.capabilities?.includes('coverage-v2')){
  const scopeBytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(provider+':'+String(stored.account)+':'+String(organizationId||'default')));
  const scope='scope-'+Array.from(new Uint8Array(scopeBytes),n=>n.toString(16).padStart(2,'0')).join('');
  try{const receipt=await chrome.runtime.sendNativeMessage('io.xtctx.web_history',{action:'coverage',provider,scope,checked_at:new Date().toISOString(),state:'finished',listed_sessions:coverage.reduce((n,c)=>n+c.listed,0),imported_sessions:null});receiptStatus=receipt?.ok?(receipt.syncPending?' Dashboard receipt sync pending.':receipt.syncEnabled===false?' Receipt saved locally only.':' Dashboard receipt synced.'):' Dashboard receipt could not be saved.';}catch{receiptStatus=' Dashboard receipt sync unavailable.';}
 }
 const inventory=coverage.map(x=>x.scope+": "+x.listed+(x.reportedTotal===null?" listed":" / "+x.reportedTotal+" reported")+(x.totalStable?"":" (total changed during this run)")+(x.organizationCount===null?"":"; "+x.organizationCount+" accessible organization(s)")).join(". ");
 progress.textContent=`${stopped?"Paused":"Finished selected listing"}. Imported ${completed}; unchanged ${skipped}; non-text blocks not imported ${nonTextBlocks}. Checkpoints saved. ${stopped?"":"Coverage receipt saved. "}Account-wide coverage is unverified. Original attachments were not downloaded. ${inventory}${receiptStatus}`;

 }catch(error){readerTabId=null;progress.textContent=error instanceof Error?error.message:"Backfill stopped; checkpoint retained";}

 finally{

  // Only close our own inactive tab; preserve an activated tab for sign-in/debugging.

  if(readerTabId!==null){

   try {const own=await chrome.tabs.get(readerTabId);if(!own.active)await chrome.tabs.remove(readerTabId);}catch{}

  }

  running=false;

 }

}

async function startImport(){
 if(globalThis.navigator?.locks){
  await navigator.locks.request('xtctx-website-import',{ifAvailable:true},async lock=>{
   if(!lock){progress.textContent='Another xtctx import page is already running. Pause or close it before starting here.';return;}
   await run();
  });
 }else await run();
}
document.querySelector("#start").addEventListener("click",startImport);

document.querySelector("#stop").addEventListener("click",()=>{stopped=true;});


function updateProviderFields(){const gemini=document.querySelector("#provider").value==="gemini";document.querySelector("#gemini-account-label").hidden=!gemini;document.querySelector("#gemini-account-help").hidden=!gemini;}
document.querySelector("#provider").addEventListener("change",updateProviderFields);updateProviderFields();
