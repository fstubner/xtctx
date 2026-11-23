import {readFile,readdir,mkdtemp,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {parse as parseYaml} from 'yaml';
import {SUPPORTED_TOOLS} from '../tools/sources.js';
import {hashParts} from '../handoff/hash.js';
import {reconcileSessionIds,verifyMessageHashes} from '../coverage/reconcile.js';
import {resolveUploadCredentials,assertSecureSyncUrl} from '../sync/client.js';
import {isOptedIn} from '../sync/consent.js';
import {browserReceipt} from '../coverage/browser.js';
import {readHermesHistory} from './hermes-history.js';

type Spec={archive:string;source?:string;tool?:string;database?:string;namespace?:string};
type Evidence=Record<string,unknown>;
/** Explicit administrator-selected archives only; specs cannot select credentials or destinations. */
export async function collectCoverage(spec:Spec){
 const archive=resolve(spec.archive);
 const config=parseYaml(await readFile(join(archive,'.xtctx/config.yaml'),'utf8')) as {tools?:Record<string,{enabled?:boolean;storePath?:string}>};
 if(!config||typeof config!=='object'||Array.isArray(config))throw Error('Invalid archive configuration');
 const db=new Database(join(archive,'.xtctx/state/xtctx.db'),{readonly:true,fileMustExist:true});
 const temp=await mkdtemp(join(tmpdir(),'xtctx-coverage-'));
 try{
  const definitions=spec.source?[{id:spec.namespace?'hermes':spec.tool??spec.source}]:SUPPORTED_TOOLS;
  const receipts=[];
  for(const item of definitions){
   const tool=item.id,source=spec.source??tool;
   if(!/^[a-z0-9._:-]{1,64}$/.test(source))throw Error('Invalid source');
   const rows=db.prepare('SELECT source_session_id FROM sessions WHERE tool=?').all(tool) as {source_session_id:string}[];
   const ids=rows.map(x=>x.source_session_id).filter(id=>!spec.namespace||id.startsWith(spec.namespace+':'));
   const counts=db.prepare('SELECT count(*) n FROM messages WHERE tool=?'+(spec.namespace?' AND source_session_id LIKE ?':'')).get(...(spec.namespace?[tool,spec.namespace+':%']:[tool])) as {n:number};
   let completedAt:string|null=null;
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='settings'").get()){const started=db.prepare("SELECT value FROM settings WHERE key='last_scan_at'").get() as {value:string}|undefined;const duration=db.prepare("SELECT value FROM settings WHERE key='last_scan_ms'").get() as {value:string}|undefined;if(started&&duration&&Number.isFinite(Date.parse(started.value))&&Number.isFinite(Number(duration.value)))completedAt=new Date(Date.parse(started.value)+Number(duration.value)).toISOString();}
   const evidence:Evidence[]=[{kind:'collection',checked_at:new Date().toISOString(),indexed_sessions:ids.length,indexed_messages:counts.n,completed:completedAt!==null,completed_at:completedAt,original_attachments:'unverified',unsupported_content:'unverified'}];
   const inventory:Evidence={kind:'inventory',checked_at:new Date().toISOString(),state:'not_checked',discovered_sessions:null,excluded_sessions:null};
   if(spec.database&&spec.namespace){
    const sessions=readHermesHistory(spec.database,spec.namespace,archive);
    inventory.state='detected';inventory.discovered_sessions=sessions.length;
    const comparison=reconcileSessionIds(sessions.map(s=>s.source_session_id),ids);
    const expected=new Map(sessions.flatMap(s=>s.messages.map(m=>[m.id,m.content_hash] as const)));
    const actual=new Map((db.prepare('SELECT id,CAST(content AS BLOB) content FROM messages WHERE tool=? AND source_session_id LIKE ?').all(tool,spec.namespace+':%') as {id:string;content:Buffer}[]).map(m=>[m.id,hashParts([m.content.toString('utf8')])]));
    evidence.push({kind:'reconciliation',checked_at:new Date().toISOString(),...comparison,...verifyMessageHashes(expected,actual)});
   }else if(!tool.endsWith('-web')){
    const definition=SUPPORTED_TOOLS.find(d=>d.id===tool);
    const configured=config.tools?.[tool];
    if(!definition)inventory.state='unsupported';
    else if(configured?.enabled!==false){
     let storeDetected=false;
     try{
      const store=configured?.storePath?resolve(archive,configured.storePath):definition.defaultStorePath();await stat(store);storeDetected=true;
      const scraper=definition.createScraper(store,temp,undefined,undefined,true);
      inventory.state='detected';
      const classified = await scraper.listCoverageSessions?.();
      const sourceIds = scraper.listCoverageSessions ? classified?.ids : await scraper.listSessionIds?.();
      if (sourceIds) {
       inventory.discovered_sessions = sourceIds.size;
       const comparison = reconcileSessionIds(sourceIds, ids);
       if (classified) {
        const indexed = new Set(ids);
        const excluded = [...classified.emptyIds].filter(id => !indexed.has(id)).length;
        inventory.excluded_sessions = excluded;
        comparison.missing_sessions -= excluded;
       }
       evidence.push({kind:'reconciliation',checked_at:new Date().toISOString(),...comparison,text_parity:'unverified',verified_messages:null});
      }
     }catch(error){inventory.state=!storeDetected&&(error as NodeJS.ErrnoException).code==='ENOENT'?'not_detected':'inaccessible';}
    }
   }
   evidence.push(inventory);receipts.push({version:2,source,scope:'main',evidence});
  }
  return receipts;
 }finally{db.close();await rm(temp,{recursive:true,force:true});}
}
export async function runCoverage(options:{project?:string;spec?:string;upload?:boolean}){
 let specs:Spec[];
 if(options.spec){const value:unknown=JSON.parse(await readFile(options.spec,'utf8'));if(!Array.isArray(value)||value.length>64||value.some(s=>!s||typeof s.archive!=='string'||['source','tool','database','namespace'].some(k=>s[k]!==undefined&&typeof s[k]!=='string')))throw Error('Invalid coverage specification');specs=value;}
 else if(options.project)specs=[{archive:options.project}];else throw Error('Specify --project or --spec');
 const credentials=options.upload?await resolveUploadCredentials():null;
 if(options.upload&&!credentials)throw Error('Collector credentials required');
 if(credentials)assertSecureSyncUrl(credentials.syncUrl);
 for(const spec of specs){
  if(options.upload&&!await isOptedIn(resolve(spec.archive)))throw Error('Archive is not opted into sync');
  const receipts=await collectCoverage(spec);
  for(const file of await readdir(join(spec.archive,'.xtctx/state'))){
   if(!/^web-coverage-[a-f0-9]{64}\.json$/.test(file))continue;
   const text=await readFile(join(spec.archive,'.xtctx/state',file),'utf8');if(Buffer.byteLength(text)>16384)throw Error('Stored receipt exceeds limit');
   const saved=JSON.parse(text) as {source:string;scope:string;evidence:Record<string,unknown>[]};
   if(spec.source&&saved.source!==spec.source)continue;
   const browser=saved.evidence?.[0];
   receipts.push(browserReceipt({provider:saved.source?.replace(/-web$/,''),scope:saved.scope,...browser}));
  }
  for(const receipt of receipts){
   if(credentials){const response=await fetch(credentials.syncUrl.replace(/\/$/,'')+'/api/coverage',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+credentials.token,'Content-Type':'application/json'},body:JSON.stringify({...receipt,device_name:credentials.deviceName})});if(!response.ok)throw Error('Coverage upload failed ('+response.status+')');}
   console.log(JSON.stringify({...receipt,uploaded:Boolean(credentials)}));
  }
 }
}
