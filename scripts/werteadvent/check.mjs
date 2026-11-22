import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {data,root} from './build.mjs';
import {collectPublicRoutes} from '../lib/public-routes.mjs';
const artifactArg=process.argv.find(s=>s.startsWith('--artifact='));
const site=artifactArg?path.resolve(artifactArg.slice(11)):root;
const p=n=>String(n).padStart(2,'0');
assert.equal(data.values.length,24);
const suppliedManifest=JSON.parse(fs.readFileSync(path.join(site,'assets/werteadvent-2026/icons/manifest.json'),'utf8'));
for(const [i,v] of data.values.entries()){
 assert.equal(v.day,i+1);assert.equal(v.value,suppliedManifest[i].value);assert.equal(v.category,suppliedManifest[i].category);
 assert.equal(v.category,i<12?'Mensch':i<18?'Planet':'Demokratie');
 assert(v.creatorIdeas.length>=4);assert.equal(v.liveQuestions.length,5);assert.deepEqual(v.videos.map(x=>x.seconds),[15,30,60]);
 assert(v.explanation&&v.question&&v.story&&v.effect);assert.equal(Object.keys(v.copy).length,4);
 for(const video of v.videos)assert(video.hook&&video.thought&&video.invitation);
 for(const icon of [v.iconWithLabel,v.iconWithoutLabel])assert(fs.statSync(path.join(site,'assets/werteadvent-2026/icons',icon)).size>100);
 for(const variant of ['thumbnail','labelled'])assert(fs.statSync(path.join(site,`assets/werteadvent-2026/${variant}-${p(v.day)}.webp`)).size>100);
}
for(const route of ['werteadvent',data.hiddenRoute]){
 const html=fs.readFileSync(path.join(site,route,'index.html'),'utf8');
 assert(html.includes('name="robots" content="noindex, nofollow, noarchive"'));assert(html.includes('name="woek-private-interaction"'));
 assert.equal((html.match(/class="wa-value wa-/g)||[]).length,24);
 assert(!html.includes('{{'));assert(!/main\.js|googletag|analytics\.js|<iframe/i.test(html));
 assert(!/[–—]/u.test(html));assert(!/\/Users\/|WOEK-AI-MASTERREFERENCE|[Cc]laude|sk-proj-|gh[pous]_/.test(html));
 assert(!html.includes('Eine Aktion von Natalie Weber'));
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
 for(const m of html.matchAll(/href="#([^"]+)"/g))assert(ids.includes(m[1]),'missing anchor '+m[1]);
}
// Exercise the actual shared indexability classifier on an isolated projection.
const temp=fs.mkdtempSync('/tmp/werteadvent-routes-');
try{for(const route of ['werteadvent',data.hiddenRoute]){fs.mkdirSync(path.join(temp,route));fs.copyFileSync(path.join(site,route,'index.html'),path.join(temp,route,'index.html'));}assert.equal(collectPublicRoutes(temp).routes.length,0);}finally{fs.rmSync(temp,{recursive:true,force:true});}
if(artifactArg){
 const needles=['/werteadvent/',data.hiddenRoute,'#WerteAdvent','Werte-Advent 2026'];
 const scan=(dir)=>{if(!fs.existsSync(dir))return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())scan(full);else if(/\.(?:json|xml|html|atom|txt)$/.test(entry.name)){const s=fs.readFileSync(full,'utf8');assert(!needles.some(x=>s.includes(x)),`Unlisted campaign leaked into discovery: ${full}`);}}};
 for(const dir of ['sitemaps','assets/search','public/data'])scan(path.join(site,dir));
 for(const name of ['sitemap.xml','feed.xml','feed.json','feed.atom','rss.xml','assets/data/navigation.json','assets/data/public-routes.json'])scanFile(name);
 function scanFile(name){const f=path.join(site,name);if(fs.existsSync(f)){const s=fs.readFileSync(f,'utf8');assert(!needles.some(x=>s.includes(x)),`Discovery leak in ${name}`);}}
}
console.log('WERTEADVENT_CHECK=PASS: 24 content records, 48 original downloads, 48 previews, anchors, privacy, robots and shared indexability.');
