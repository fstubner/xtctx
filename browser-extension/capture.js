// Isolated world: no cookies, page scripts, private endpoints or arbitrary-page access.
(()=>{
 if(globalThis.__xtctxWebCapture)return;globalThis.__xtctxWebCapture=true;
 let previous="",busy=false,retryAt=0,retryDelay=5000;
 async function capture(){
  if(busy || document.visibilityState!=="visible" || Date.now()<retryAt)return;
  if(document.querySelector('[data-testid="stop-button"], [data-is-streaming="true"]'))return;
  const provider=location.hostname==="chatgpt.com"?"chatgpt":"claude";
  const match=location.pathname.match(provider==="chatgpt"?/\/c\/([^/]+)$/:/^\/chat\/([^/]+)$/);if(!match)return;
  const nodes=provider==="chatgpt"?[...document.querySelectorAll('[data-message-author-role][data-message-id]')]:[...document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"]')];
  if(!nodes.length)return;
  const messages=[];const ids=new Set();
  for(const node of nodes){
   const container=node.closest('[data-message-id]');const id=node.getAttribute("data-message-id")||container?.getAttribute("data-message-id");
   // Without real provider IDs there is no reliable export deduplication.
   if(!id){chrome.runtime.sendMessage({action:"capture-unavailable",reason:"missing-provider-ids"}).catch(()=>{});return;}
   if(ids.has(id))continue;ids.add(id);
   const role=node.getAttribute("data-message-author-role")||(node.getAttribute("data-testid")==="user-message"?"user":"assistant");
   if(!["user","assistant"].includes(role))continue;
   const content=node.innerText;if(!content?.trim())continue;
   messages.push({id,role,content,parent:null,timestamp:null});
  }
  if(!messages.length)return;
  const snapshot={version:1,provider,conversation:{id:match[1],title:document.title,messages}};
  const serialized=JSON.stringify(snapshot);if(serialized===previous)return;
  if(new TextEncoder().encode(serialized).length>2500*1024){await chrome.runtime.sendMessage({action:"capture-unavailable",reason:"snapshot-too-large"}).catch(()=>{});retryAt=Date.now()+60000;return;}
  busy=true;try{
   const result=await chrome.runtime.sendMessage({action:"capture",capture:snapshot});
   if(result?.ok && !result.syncPending){previous=serialized;retryAt=0;retryDelay=5000;}
   else {retryAt=Date.now()+retryDelay;retryDelay=Math.min(retryDelay*2,60000);}
  }catch{retryAt=Date.now()+retryDelay;retryDelay=Math.min(retryDelay*2,60000);}finally{busy=false;}
 }
 // A timer avoids mutation-observer feedback loops and caps work on streaming pages.
 setInterval(capture,5000);void capture();
})();
