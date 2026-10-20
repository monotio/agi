import assert from "node:assert/strict";
import {test} from "node:test";
import { isLegacyAuthoredProject, projectConventions, readAuthoringConventions } from "../src/authoring/projectConventions.ts";
import {gameUpdates, hasReleasedBoot} from "../src/authoring/scriptSizeMigration.ts";
import {releasedTemplates} from "./released-template-fixtures.ts";
import {assembleLogic} from "../src/logic/assembler.ts";
import {createContainer} from "../src/container/container.ts";
for (const {version,source} of releasedTemplates) test(`decoded ${version} boot proves an old playable export was authored here`,()=>{
 const c=createContainer(); c.putResource('logic',0,assembleLogic(source,{dictionary:new Map()}).payload);
 assert.equal(hasReleasedBoot(Object.fromEntries(c.files)),true);
});
test('workspace alone does not prove authorship, and originals override every claim',()=>{
 const files={};
 assert.equal(isLegacyAuthoredProject({files,imported:true,library:{source:'zip'}}),false);
 for(const extra of [{library:{source:'authored'}},{templateId:'starter'},{provider:'stub'},{sessionId:'older'},{}]) assert.equal(isLegacyAuthoredProject({files,...extra}),true);
 assert.equal(isLegacyAuthoredProject({files:{AGI:new TextEncoder().encode('Version 2.936\0')},authoringConventions:{version:1,legacyRoomMemory:true}}),false);
 assert.deepEqual(projectConventions({files,imported:true}),{version:1});
 assert.throws(()=>readAuthoringConventions({version:2}));
});
test('legacy feedback notices distinguish released, customized, unrelated and absent replies',()=>{
 const source=releasedTemplates.at(-1)!.source;
 const c=createContainer(); c.putResource('logic',0,assembleLogic(source,{dictionary:new Map()}).payload);
 const files=Object.fromEntries(c.files);
 assert.equal(gameUpdates({'logic:0':source},files,true).length,2);
 const custom=source.replace("I don't know the word",'Unknown word');
 assert.equal(gameUpdates({'logic:0':custom},files,true).find(r=>r.kind==='words')?.source,undefined);
 assert.equal(gameUpdates({'logic:0':'word.to.string(s1,1); return;'},files,true).some(r=>r.kind==='words'),false);
 assert.equal(gameUpdates({},files,true).some(r=>r.kind==='words'),false);
 assert.deepEqual(gameUpdates({'logic:0':source},files,false),[]);
});
test('room memory Add can use a proven unused flag, but never indirect flag writes or source-less code',()=>{
 const source='set(f199); call(1); return;';
 const c=createContainer(); c.putResource('logic',0,assembleLogic(source,{dictionary:new Map()}).payload);
 const files=Object.fromEntries(c.files);
 assert.ok(gameUpdates({'logic:0':source},files,true).find(r=>r.kind==='memory')?.source);
 assert.equal(gameUpdates({'logic:0':'set.v(v40); return;'},files,true).find(r=>r.kind==='memory')?.source,undefined);
 assert.equal(gameUpdates({},files,true).find(r=>r.kind==='memory')?.source,undefined);
});
