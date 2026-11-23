import {it,expect} from "vitest";
import {sanitizeMetadata} from "../../src/sync/upload-format.js";
it("sync preserves web provenance and omissions but strips paths and credentials",()=>{
 const metadata={provider_message_id:"m",provider_conversation_id:"c",parent_id:"p",source_complete:false,timestamp_inferred:true,non_text_blocks:2,representation:"provider-api",revision:"hash",untrusted_transcript_data:true,token:"synthetic-secret",sourcePath:"C:/private/transcript"};
 const uploaded=JSON.parse(sanitizeMetadata(JSON.stringify(metadata)));
 expect(uploaded).toMatchObject({provider_message_id:"m",parent_id:"p",non_text_blocks:2,source_complete:false,representation:"provider-api",revision:"hash"});
 expect(uploaded).not.toHaveProperty("token");expect(uploaded).not.toHaveProperty("sourcePath");
});

it("sync preserves typed block evidence and validated attachment descriptors without arbitrary fields",()=>{
 const result=JSON.parse(sanitizeMetadata(JSON.stringify({content_capture_version:2,preserved_block_types:["tool_result"],omitted_block_types:["image"],attachment_refs:[{id:"f",name:"report.txt",mediaType:"text/plain",status:"metadata-only",token:"synthetic-secret",url:"https://not-uploaded.invalid"}]})));
 expect(result.attachment_refs).toEqual([{id:"f",name:"report.txt",mediaType:"text/plain",status:"metadata-only"}]);
 expect(result.preserved_block_types).toEqual(["tool_result"]);expect(JSON.stringify(result)).not.toContain("synthetic-secret");expect(JSON.stringify(result)).not.toContain("not-uploaded");
});

it("optional descriptors yield to core provenance under the remote metadata budget",()=>{
 const metadata={provider_message_id:"m",content_capture_version:2,attachment_refs:Array.from({length:8},()=>({id:"f".repeat(100),name:"猫".repeat(120),mediaType:"text/plain",status:"metadata-only"}))};
 const uploaded=sanitizeMetadata(JSON.stringify(metadata));const result=JSON.parse(uploaded);
 expect(Buffer.byteLength(uploaded)).toBeLessThanOrEqual(4096);expect(result.provider_message_id).toBe("m");
 expect(result.content_capture_version).toBe(2);expect(result.attachment_refs.length).toBeLessThan(8);
 expect(result.attachment_metadata_omitted).toBe(8-result.attachment_refs.length);
});

it("preserves local archive provenance without uploading raw tool arguments",()=>{
 const result=JSON.parse(sanitizeMetadata(JSON.stringify({source_provider:"hermes",source_namespace:"main",source_message_id:42,source_channel:"discord",source_parent_session_id:"parent",tool_call_id:"call-1",tool_name:"shell",tool_calls:'[{"arguments":"private payload"}]',sourceFormat:"desktop",mayIncludeInjectedContext:true,nonTextParts:3,sourcePath:"C:/private"})));
 expect(result).toMatchObject({source_provider:"hermes",source_namespace:"main",source_message_id:42,source_channel:"discord",source_parent_session_id:"parent",tool_call_id:"call-1",tool_name:"shell",tool_calls_omitted:true,sourceFormat:"desktop",mayIncludeInjectedContext:true,nonTextParts:3});
 expect(result).not.toHaveProperty("tool_calls");expect(result).not.toHaveProperty("sourcePath");expect(JSON.stringify(result)).not.toContain("private payload");
});
