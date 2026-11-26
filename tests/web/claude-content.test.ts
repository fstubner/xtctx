import {it,expect} from "vitest";
import {claudeContent,parseContentProvenance} from "../../src/web/claude-content.js";
import {readFileSync} from "node:fs";
import ts from "typescript";
const fixture={content:[{type:"text",text:"plain"},{type:"tool_use",name:"artifacts",input:{content:"<h1>saved code</h1>",command:"DO NOT EXECUTE"}},{type:"tool_result",content:[{type:"text",text:"tool output"},{type:"image",source:{data:"opaque"}}]},{type:"artifact",code:"const preserved = true;"},{type:"document",source:{type:"text",data:"document text"}},{type:"image",source:{data:"opaque"}},{type:"redacted_thinking",data:"opaque"}],attachments:[{uuid:"file-1",file_name:"C:/private/report.txt",file_type:"text/plain",extracted_content:"attachment text",url:"https://not-fetched.invalid",token:"not copied"}]};
it("preserves readable tools, artifacts, documents and attachment text while reporting opaque leaves",()=>{
 const result=claudeContent(fixture);
 for(const text of ["plain","saved code","DO NOT EXECUTE","tool output","const preserved","document text","attachment text"])expect(result.content).toContain(text);
 expect(result.content).not.toContain("opaque");expect(result.content).not.toContain("not-fetched");expect(result.content).not.toContain("not copied");
 expect(result.nonTextBlocks).toBe(4);expect(result.preservedBlockTypes).toEqual(expect.arrayContaining(["tool_use","tool_result","artifact","document","attachment_text"]));
 expect(result.omittedBlockTypes).toEqual(expect.arrayContaining(["image","tool_result","redacted_thinking","attachment"]));
 expect(result.attachmentRefs).toEqual([{id:"file-1",name:"report.txt",mediaType:"text/plain",status:"text-extracted"}]);
});
it("content is literal data; binary inputs and oversized nesting remain explicit omissions or failures",()=>{
 const result=claudeContent({content:[{type:"tool_use",name:"upload",input:{data:"data:image/png;base64,opaque"}}]});
 expect(result.content).toBe("");expect(result.nonTextBlocks).toBe(1);
 let nested:unknown={type:"text",text:"deep"};for(let i=0;i<14;i++)nested={type:"tool_result",content:[nested]};
 expect(()=>claudeContent({content:[nested]})).toThrow("nesting");
});
it("attachment metadata has bounded descriptors and never accepts paths, URLs or arbitrary credentials",()=>{
 const result=claudeContent({attachments:Array.from({length:10},()=>({name:"file.txt",token:"synthetic-secret",source:"https://not-fetched.invalid"}))});
 expect(result.attachmentRefs).toHaveLength(8);expect(result.attachmentMetadataOmitted).toBe(2);expect(result.nonTextBlocks).toBe(10);
 expect(()=>parseContentProvenance({...result,attachmentRefs:[{name:"/private/file",status:"metadata-only"}]})).toThrow("attachment name");
 expect(JSON.stringify(parseContentProvenance(result))).not.toContain("synthetic-secret");
});
it("browser extractor is generated from the same source as the native/export extractor",()=>{
 const source=readFileSync("src/web/claude-content.ts","utf8");
 const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}});
 expect(readFileSync("browser-extension/claude-content.js","utf8")).toBe("// Generated from src/web/claude-content.ts; run node scripts/build-web-content.mjs.\n"+outputText);
});
