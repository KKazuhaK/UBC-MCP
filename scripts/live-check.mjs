import assert from 'node:assert/strict';
import {PublicHttp} from '../dist/http.js';
import {Catalog} from '../dist/providers/catalog.js';
import {Grades} from '../dist/providers/grades.js';
const http=new PublicHttp(),catalog=new Catalog(http),grades=new Grades(http);
const results=[];
for(const [label,check]of [
  ['Vancouver catalog',async()=>{const r=await catalog.course('UBCV','CPSC','210');assert.match(r.course.title,/Software/);return {source:r.source,fetchedAt:r.fetchedAt};}],
  ['Okanagan catalog',async()=>{const r=await catalog.course('UBCO','COSC','111');assert.equal(r.course.campus,'UBCO');return {source:r.source,fetchedAt:r.fetchedAt};}],
  ['UBCGrades distribution',async()=>{const r=await grades.course('UBCV','MATH','100','2022S');assert.ok(r.sections.length>0);assert.ok(r.overall);return {source:r.source,fetchedAt:r.fetchedAt};}],
])try{results.push({label,status:'pass',...await check()});}catch(e){results.push({label,status:'fail',reason:e.message});process.exitCode=1;}
console.log(JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));
