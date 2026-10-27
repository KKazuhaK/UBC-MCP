import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {parseHTML} from 'linkedom';

test('automatic registration sync refuses incomplete tables and excludes identity',async()=>{
 const headers=['','Section','Registration Status','Instructional Format','Meeting Patterns'];
 const cells=['<button aria-label="Private Student (12345678) - 2026-27 Winter Term 2 (UBC-V)"></button>',
  '<span data-automation-id="promptOption">CPSC_V 110-201 - Example</span>',
  '<span data-automation-id="promptOption">Registered</span>','<span data-automation-id="promptOption">Lecture</span>',''];
 const {document}=parseHTML(`<html><body><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody><tr>${cells.map(c=>`<td>${c}</td>`).join('')}</tr></tbody></table></body></html>`);
 let visible='My Enrolled Courses 2 items';Object.defineProperty(document.body,'innerText',{get:()=>visible});
 let listener;const sent=[];
 const chrome={runtime:{id:'ext',onMessage:{addListener:fn=>listener=fn},sendMessage:async msg=>{if(msg.type==='ubc.sync.enabled')return {ok:true,enabled:true};sent.push(msg);return {ok:true,count:msg.snapshots.length};}}};
 const bundle=await build({entryPoints:['src/collector/auto-sync.ts'],bundle:true,platform:'browser',format:'iife',write:false});
 runInNewContext(bundle.outputFiles[0].text,{document,chrome,MutationObserver:class{observe(){}},setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1,console});
 const sync=()=>new Promise(resolve=>listener({type:'ubc.sync.now'},{id:'ext'},resolve));
 assert.equal((await sync()).ok,false);assert.equal(sent.length,0);
 visible='My Enrolled Courses 1 item';
 assert.equal((await sync()).ok,true);assert.equal(sent.length,1);
 assert.equal(sent[0].snapshots[0].kind,'registrations');
 assert.doesNotMatch(JSON.stringify(sent[0]),/Private Student|12345678/);
});
