import { it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CursorScraper } from "../../src/scrapers/cursor.js";

it("inventories physical records, preserving NUL identities and excluding pruned references",async()=>{
 const root=await mkdtemp(join(tmpdir(),"cursor-inventory-"));
 try {
  const workspace=join(root,"workspaceStorage");await mkdir(join(workspace,"one"),{recursive:true});await mkdir(join(root,"globalStorage"));
  const db=new Database(join(root,"globalStorage/state.vscdb"));db.exec("CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE composerHeaders(composerId TEXT)");
  const insert=db.prepare("INSERT INTO cursorDiskKV VALUES(?,?)");insert.run("composerData:present","malformed payload still physically exists");insert.run("composerData:with\0nul","{}");insert.run("bubbleId:present:b","not read");db.prepare("INSERT INTO composerHeaders VALUES(?)").run("header-only");db.close();
  const ws=new Database(join(workspace,"one/state.vscdb"));ws.exec("CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT)");ws.prepare("INSERT INTO ItemTable VALUES(?,?)").run("composer.composerData",JSON.stringify({allComposers:[{composerId:"pruned"}]}));ws.close();
  expect(await new CursorScraper(workspace,join(root,"state")).listSessionIds()).toEqual(new Set(["present","with\0nul"]));
  expect(await new CursorScraper(workspace,join(root,"state"),root).listSessionIds()).toBeNull();
  const large=new Database(join(root,"globalStorage/state.vscdb"));large.prepare("INSERT INTO cursorDiskKV VALUES(?,?)").run("composerData:"+"x".repeat(4096),"{}");large.close();
  expect(await new CursorScraper(workspace,join(root,"state")).listSessionIds()).toBeNull();
 }finally{await rm(root,{recursive:true,force:true});}
});
it("propagates unavailable global payload storage rather than claiming zero",async()=>{
 const root=await mkdtemp(join(tmpdir(),"cursor-inventory-"));
 try {const ws=join(root,"workspaceStorage");await mkdir(ws);await expect(new CursorScraper(ws,join(root,"state")).listSessionIds()).rejects.toThrow();}
 finally {await rm(root,{recursive:true,force:true});}
});
it("distinguishes an empty recognized payload store from an unsupported schema",async()=>{
 const root=await mkdtemp(join(tmpdir(),"cursor-inventory-"));
 try {
  const ws=join(root,"workspaceStorage");await mkdir(ws);await mkdir(join(root,"globalStorage"));
  const db=new Database(join(root,"globalStorage/state.vscdb"));db.close();
  expect(await new CursorScraper(ws,join(root,"state")).listSessionIds()).toBeNull();
  const recognized=new Database(join(root,"globalStorage/state.vscdb"));recognized.exec("CREATE TABLE cursorDiskKV(key TEXT,value TEXT)");recognized.close();
  expect(await new CursorScraper(ws,join(root,"state")).listSessionIds()).toEqual(new Set());
  const duplicates=new Database(join(root,"globalStorage/state.vscdb"));
  const add=duplicates.prepare("INSERT INTO cursorDiskKV VALUES(?,?)");
  duplicates.transaction(()=>{for(let i=0;i<100001;i++)add.run("composerData:duplicate","{}");add.run("composerData:later-distinct","{}");})();duplicates.close();
  expect(await new CursorScraper(ws,join(root,"state")).listSessionIds()).toBeNull();
 }finally{await rm(root,{recursive:true,force:true});}
});

it("classifies only explicit empty conversation arrays in coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-coverage-"));
  try {
    const workspace = join(root, "workspaceStorage");
    await mkdir(workspace);
    await mkdir(join(root, "globalStorage"));
    const db = new Database(join(root, "globalStorage/state.vscdb"));
    db.exec("CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT)");
    const add = db.prepare("INSERT INTO cursorDiskKV VALUES(?,?)");
    add.run("composerData:empty", '{"fullConversationHeadersOnly":[]}');
    add.run("composerData:active", '{"fullConversationHeadersOnly":[{}]}');
    add.run("composerData:unknown", '{}');
    add.run("composerData:malformed", '{');
    db.close();
    const scraper = new CursorScraper(workspace, join(root, "state"));
    const ids = new Set(["empty", "active", "unknown", "malformed"]);
    expect(await scraper.listSessionIds()).toEqual(ids);
    expect(await scraper.listCoverageSessions()).toEqual({ ids, emptyIds: new Set(["empty"]) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
