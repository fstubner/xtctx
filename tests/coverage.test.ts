import {describe,it,expect,vi} from 'vitest';
import {reconcileSessionIds,verifyMessageHashes} from '../src/coverage/reconcile.js';
describe('source coverage evidence',()=>{
 it('distinguishes missing source sessions and retained archive history',()=>{expect(reconcileSessionIds(['a','b','b'],['a','c'])).toEqual({matched_sessions:1,missing_sessions:1,retained_sessions:1});});
 it('does not treat equal counts as text parity',()=>{expect(verifyMessageHashes(new Map([['a','hash1']]),new Map([['b','hash1']])).text_parity).toBe('mismatch');expect(verifyMessageHashes(new Map([['a','hash1']]),new Map([['a','hash2']])).text_parity).toBe('mismatch');});
 it('requires identities and hashes including extra indexed messages to match',()=>{expect(verifyMessageHashes(new Map([['a','hash1']]),new Map([['a','hash1']]))).toEqual({text_parity:'verified',verified_messages:1});expect(verifyMessageHashes(new Map(),new Map([['a','hash1']])).text_parity).toBe('mismatch');});
});

import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {collectCoverage} from '../src/cli/coverage.js';
import {SUPPORTED_TOOLS} from '../src/tools/sources.js';
import {browserReceipt} from '../src/coverage/browser.js';
it('reports every supported disabled source as not checked, never absent or verified',async()=>{
 const root=await mkdtemp(join(tmpdir(),'coverage-test-'));
 try{await mkdir(join(root,'.xtctx/state'),{recursive:true});await writeFile(join(root,'.xtctx/config.yaml'),JSON.stringify({tools:Object.fromEntries(SUPPORTED_TOOLS.map(t=>[t.id,{enabled:false}]))}));
 const db=new Database(join(root,'.xtctx/state/xtctx.db'));db.exec('CREATE TABLE sessions(source_session_id TEXT,tool TEXT);CREATE TABLE messages(id TEXT,tool TEXT,source_session_id TEXT,content TEXT)');db.close();
 const receipts=await collectCoverage({archive:root});expect(receipts).toHaveLength(SUPPORTED_TOOLS.length);
 for(const receipt of receipts){expect(receipt.evidence.find(e=>e.kind==='inventory')).toMatchObject({state:'not_checked',discovered_sessions:null});expect(receipt.evidence.some(e=>e.kind==='reconciliation')).toBe(false);}
 }finally{await rm(root,{recursive:true,force:true});}
});
it('browser receipts use separate opaque scopes and reject URLs and invalid counts',()=>{
 const raw={provider:'gemini',scope:'scope-'+ 'a'.repeat(64),checked_at:new Date().toISOString(),state:'finished',listed_sessions:43,imported_sessions:null};
 expect(browserReceipt(raw)).toMatchObject({source:'gemini-web',scope:raw.scope});
 expect(browserReceipt({...raw,scope:'scope-'+ 'b'.repeat(64)}).scope).not.toBe(raw.scope);
 expect(()=>browserReceipt({...raw,scope:'person@example.com'})).toThrow();expect(()=>browserReceipt({...raw,listed_sessions:-1})).toThrow();
});

import {readHermesHistory} from '../src/cli/hermes-history.js';
it('verifies Hermes identities against actual bytes and detects a content edit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'coverage-hermes-'));
 try{
 await mkdir(join(root,'.xtctx/state'),{recursive:true});await writeFile(join(root,'.xtctx/config.yaml'),'tools: {}');
 const sourceFile=join(root,'source.db');const source=new Database(sourceFile);source.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,parent_session_id TEXT,started_at REAL);CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,tool_call_id TEXT,tool_calls TEXT,tool_name TEXT)');source.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('s','test',null,1700000000);source.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)').run(1,'s','user','before\0after',1700000001,null,null,null);source.close();
 const snapshot=readHermesHistory(sourceFile,'main',root)[0],message=snapshot.messages[0];
 const db=new Database(join(root,'.xtctx/state/xtctx.db'));db.exec('CREATE TABLE sessions(source_session_id TEXT,tool TEXT);CREATE TABLE messages(id TEXT,tool TEXT,source_session_id TEXT,content TEXT)');db.prepare('INSERT INTO sessions VALUES(?,?)').run(snapshot.source_session_id,'hermes');db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(message.id,'hermes',snapshot.source_session_id,message.content);db.close();
 const spec={archive:root,source:'hermes-main',database:sourceFile,namespace:'main'};
 expect((await collectCoverage(spec))[0].evidence.find(e=>e.kind==='reconciliation')).toMatchObject({matched_sessions:1,missing_sessions:0,text_parity:'verified',verified_messages:1});
 const changed=new Database(join(root,'.xtctx/state/xtctx.db'));changed.prepare('UPDATE messages SET content=?').run('corrupted');changed.close();
 expect((await collectCoverage(spec))[0].evidence.find(e=>e.kind==='reconciliation')).toMatchObject({text_parity:'mismatch'});
 }finally{await rm(root,{recursive:true,force:true});}
});

it('does not call an existing source absent when a nested inventory read fails',async()=>{
 const root=await mkdtemp(join(tmpdir(),'coverage-nested-'));
 const definition=SUPPORTED_TOOLS.find(tool=>tool.id==='codex')!;
 const create=definition.createScraper;
 const spy=vi.spyOn(definition,'createScraper').mockImplementation((...args)=>{
  const scraper=create(...args);
  scraper.listSessionIds=async()=>{throw Object.assign(new Error('nested file disappeared'),{code:'ENOENT'});};
  return scraper;
 });
 try{
  await mkdir(join(root,'.xtctx/state'),{recursive:true});
  await mkdir(join(root,'source'));
  await writeFile(join(root,'.xtctx/config.yaml'),JSON.stringify({tools:{codex:{enabled:true,storePath:'source'}}}));
  const db=new Database(join(root,'.xtctx/state/xtctx.db'));db.exec('CREATE TABLE sessions(source_session_id TEXT,tool TEXT);CREATE TABLE messages(id TEXT,tool TEXT,source_session_id TEXT,content TEXT)');db.close();
  const receipt=(await collectCoverage({archive:root,source:'codex'}))[0];
  expect(receipt.evidence.find(e=>e.kind==='inventory')).toMatchObject({state:'inaccessible',discovered_sessions:null});
  expect(receipt.evidence.some(e=>e.kind==='reconciliation')).toBe(false);
  await writeFile(join(root,'.xtctx/config.yaml'),JSON.stringify({tools:{codex:{enabled:true,storePath:'absent'}}}));
  expect((await collectCoverage({archive:root,source:'codex'}))[0].evidence.find(e=>e.kind==='inventory')).toMatchObject({state:'not_detected',discovered_sessions:null});
 }finally{spy.mockRestore();await rm(root,{recursive:true,force:true});}
});

it('reconciles empty Cursor records without hiding unknown or indexed records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coverage-cursor-'));
  try {
    await mkdir(join(root, '.xtctx/state'), { recursive: true });
    await mkdir(join(root, 'workspaceStorage'));
    await mkdir(join(root, 'globalStorage'));
    await writeFile(join(root, '.xtctx/config.yaml'), JSON.stringify({
      tools: { cursor: { enabled: true, storePath: 'workspaceStorage' } },
    }));
    const source = new Database(join(root, 'globalStorage/state.vscdb'));
    source.exec('CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value TEXT)');
    const insert = source.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
    for (const id of ['empty', 'indexed-empty']) {
      insert.run('composerData:' + id, '{"fullConversationHeadersOnly":[]}');
    }
    insert.run('composerData:unknown', '{}');
    insert.run('composerData:nonempty', '{"fullConversationHeadersOnly":[{}]}');
    source.close();

    const archive = new Database(join(root, '.xtctx/state/xtctx.db'));
    archive.exec('CREATE TABLE sessions(source_session_id TEXT, tool TEXT); CREATE TABLE messages(id TEXT, tool TEXT, source_session_id TEXT, content TEXT)');
    const addSession = archive.prepare('INSERT INTO sessions VALUES (?, ?)');
    addSession.run('indexed-empty', 'cursor');
    addSession.run('archive-only', 'cursor');
    archive.close();

    const [receipt] = await collectCoverage({ archive: root, source: 'cursor' });
    expect(receipt.evidence.find(row => row.kind === 'inventory')).toMatchObject({
      state: 'detected', discovered_sessions: 4, excluded_sessions: 1,
    });
    expect(receipt.evidence.find(row => row.kind === 'reconciliation')).toMatchObject({
      matched_sessions: 1, missing_sessions: 2, retained_sessions: 1,
      text_parity: 'unverified', verified_messages: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
