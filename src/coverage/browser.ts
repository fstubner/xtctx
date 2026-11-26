import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {writeFileAtomic} from '../utils/atomic-file.js';
import {isOptedIn} from '../sync/consent.js';
import {resolveUploadCredentials,assertSecureSyncUrl} from '../sync/client.js';
export function browserReceipt(raw:unknown){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid receipt');
 const v=raw as Record<string,unknown>;
 if(!['chatgpt','claude','gemini'].includes(v.provider as string)||typeof v.scope!=='string'||!/^scope-[a-f0-9]{64}$/.test(v.scope)||typeof v.checked_at!=='string'||v.checked_at.length>32||!Number.isFinite(Date.parse(v.checked_at))||Date.parse(v.checked_at)>Date.now()+300000||!['partial','finished','rate_limited','unavailable'].includes(v.state as string)||![v.listed_sessions,v.imported_sessions].every(n=>n===null||typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=1e10))throw Error('Invalid receipt');
 return {version:2,source:v.provider+'-web',scope:v.scope,evidence:[{kind:'browser',checked_at:new Date(v.checked_at).toISOString(),state:v.state,listed_sessions:v.listed_sessions,imported_sessions:v.imported_sessions,original_attachments:'unverified',unsupported_content:'unverified'}]};
}
export async function saveBrowserReceipt(raw:unknown,project:string,sync:boolean){
 const receipt=browserReceipt(raw),archive=resolve(project);
 const file=join(archive,'.xtctx/state/web-coverage-'+createHash('sha256').update(receipt.source+receipt.scope).digest('hex')+'.json');
 let previous:typeof receipt|undefined;
 try{previous=JSON.parse(await readFile(file,'utf8')) as typeof receipt;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('Stored receipt unreadable');}
 const current=previous&&previous.evidence[0].checked_at>=receipt.evidence[0].checked_at?previous:receipt;
 if(current===receipt)await writeFileAtomic(file,JSON.stringify(receipt),{mode:0o600});
 if(!sync)return {ok:true,syncEnabled:false};
 if(!await isOptedIn(archive))throw Error('Archive not opted in');
 const credentials=await resolveUploadCredentials();if(!credentials)throw Error('Collector credentials required');assertSecureSyncUrl(credentials.syncUrl);
 try{const response=await fetch(credentials.syncUrl.replace(/\/$/,'')+'/api/coverage',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+credentials.token,'Content-Type':'application/json'},body:JSON.stringify({...current,device_name:credentials.deviceName})});return {ok:true,syncPending:!response.ok};}catch{return {ok:true,syncPending:true};}
}
