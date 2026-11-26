import { describe,it,expect } from "vitest";
import { archiveWebConversation,parseWebExport } from "../../src/web/history.js";
const chat = [{id:"c",title:"Untrusted title",create_time:1,mapping:{
 root:{parent:null,message:null},
 a:{parent:"root",message:{id:"a",author:{role:"user"},create_time:2,content:{parts:["hello"]}}},
 b:{parent:"a",message:{id:"b",author:{role:"assistant"},create_time:3,content:{parts:["branch B"]}}},
 c:{parent:"a",message:{id:"c",author:{role:"assistant"},create_time:4,content:{parts:["branch C",{image:"not downloaded"}]}}}
}}];
describe("web history",()=>{
 it("keeps both branches and marks non-text content",()=>{
  const [c]=parseWebExport("chatgpt",chat);expect(c.messages).toHaveLength(3);
  const a=archiveWebConversation("chatgpt","personal",c,"/archive");
  expect(a.messages.map(m=>JSON.parse(m.metadata_json).parent_id)).toEqual(["root","a","a"]);
  expect(JSON.parse(a.messages[2].metadata_json).non_text_blocks).toBe(1);
  expect(a.project_root).toBe("/archive");expect(a.git_branch).toBeNull();
 });
 it("stable identity separates accounts and preserves edited revisions",()=>{
  const [c]=parseWebExport("chatgpt",chat);
  const first=archiveWebConversation("chatgpt","personal",c,"/archive");
  expect(archiveWebConversation("chatgpt","personal",c,"/archive")).toEqual(first);
  expect(archiveWebConversation("chatgpt","work",c,"/archive").session_ref).not.toBe(first.session_ref);
  c.messages[0].content="edited";
  const next=archiveWebConversation("chatgpt","personal",c,"/archive");
  expect(next.session_ref).toBe(first.session_ref);expect(next.messages[0].id).not.toBe(first.messages[0].id);
  expect(JSON.parse(next.messages[0].metadata_json).provider_message_id).toBe("a");
 });
 it("reads Claude text blocks once and records omitted attachments",()=>{
  const [c]=parseWebExport("claude",[{uuid:"c",created_at:"2026-01-01T00:00:00Z",chat_messages:[
   {uuid:"u",sender:"human",text:"fallback",content:[{type:"text",text:"actual"}],attachments:[{}]},
   {uuid:"a",sender:"assistant",text:"reply"}]}]);
  expect(c.messages[0].content.startsWith("actual\n")).toBe(true);expect(c.messages[0].content).not.toContain("fallback");expect(c.messages[0].attachmentRefs).toEqual([{status:"metadata-only"}]);expect(c.messages[0].role).toBe("user");
  expect(c.messages[1].parent).toBeNull();expect(c.messages[0].nonTextBlocks).toBe(1);
 });
 it("does not invent Claude ancestry from array order and preserves explicit sibling parents",()=>{
  const [c]=parseWebExport("claude",[{uuid:"tree",chat_messages:[
   {uuid:"u",sender:"human",text:"question"},
   {uuid:"a",sender:"assistant",text:"first branch",parent_message_uuid:"u"},
   {uuid:"b",sender:"assistant",text:"second branch",parent_message_uuid:"u"},
   {uuid:"unknown",sender:"human",text:"unknown branch"}]}]);
  expect(c.messages.map(m=>m.parent)).toEqual([null,"u","u",null]);
 });
 it("rejects malformed imports rather than silently losing conversations",()=>{
  expect(()=>parseWebExport("chatgpt",{})).toThrow("conversations.json");
  expect(()=>parseWebExport("claude",[{uuid:"c"}])).toThrow("chat_messages");
  const [c]=parseWebExport("chatgpt",chat);c.messages.push(c.messages[0]);
  expect(()=>archiveWebConversation("chatgpt","personal",c,"/archive")).toThrow("Duplicate");
 });
});
