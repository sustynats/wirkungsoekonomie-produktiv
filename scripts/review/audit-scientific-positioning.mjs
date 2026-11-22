import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root = process.cwd();
const roots = [{name:'wirkungsoekonomie-produktiv', root}, ...process.argv.slice(2).map((p,i)=>({name:i===0?'woek-akademie-app':'woek-institut-app',root:path.resolve(p)}))];
const pattern = /Parallelwissenschaft|eigene Wissenschaft|neue Wissenschaft|Steuerungsdisziplin|Wirkungswissenschaften|Evolutionsökonom|Evolutionäre Ökonomik|Neoklassik|St\. Galler|St\. Gallen|SGMM|Public Value/iu;
const artifacts = [];
const counts = {};
for (const repo of roots) {
  const files = execFileSync('git',['ls-files','-z'],{cwd:repo.root,maxBuffer:30e6}).toString().split('\0').filter(Boolean);
  const totals = {tracked:files.length,text_scanned:0,not_materialized:0,matching_files:0,publications:0};
  for (const rel of files) {
    if (/^(?:woek-parlament-app|outputs|output|tmp|source-assets|assets\/search|public\/data)\//.test(rel)) continue;
    const isPublication = /\.(pdf|docx|pptx)$/i.test(rel);
    const file = path.join(repo.root, rel);
    if (!fs.existsSync(file)) { totals.not_materialized++; if(isPublication) artifacts.push({repository:repo.name,path:rel,status:'Original nicht lokal materialisiert; Edition nicht als gelesen behauptet'}); continue; }
    if(isPublication) {totals.publications++;artifacts.push({repository:repo.name,path:rel,bytes:fs.statSync(file).size,status:'Original unverändert; separate Editionsprüfung erforderlich'});continue;}
    if (!/\.(html|md|mdx|json|ya?ml|[cm]?[jt]sx?|txt|csv)$/i.test(rel)) continue;
    const text=fs.readFileSync(file,'utf8');totals.text_scanned++;
    if(!pattern.test(text)) continue;
    const content=rel.endsWith('.html') ? text.replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi,m=>m.replace(/[^\n]/g,' ')) : text;
    const hits=content.split('\n').flatMap((line,i)=>pattern.test(line)?[{line:i+1,passage:line.trim().slice(0,900)}]:[]);
    if(!hits.length)continue;
    totals.matching_files++;
    artifacts.push({repository:repo.name,path:rel,sha256:crypto.createHash('sha256').update(text).digest('hex'),hits,status:/^(?:content\/wirkungswissenschaften|blog\/|buch\/|referenz\/version|content\/lehrgaenge\/woek-g-v)/.test(rel)?'Historische/veröffentlichte Fassung: Original erhalten, gegebenenfalls datierter Hinweis':'Inventarisiert; keine automatische fachliche Umschreibung'});
  }
  counts[repo.name]=totals;
}
const academy=roots.find(r=>r.name==='woek-akademie-app');
let curriculum=null;
if(academy){const base='content/lehrgaenge/akademie/curriculum-v4';const manifest=JSON.parse(fs.readFileSync(path.join(academy.root,base,'CURRICULUM_V4_MANIFEST.json')));const walk=p=>fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(p,e.name)):[path.join(p,e.name)]);const files=walk(path.join(academy.root,base));curriculum={declared:manifest.counts,base_scripts:files.filter(p=>p.includes('/lectures/')&&!p.includes('/offerings/')&&p.endsWith('.md')).length,offering_scripts:files.filter(p=>p.includes('/offerings/')&&p.includes('/lectures/')&&p.endsWith('.md')).length,assessments:files.filter(p=>/assessment/.test(p)&&p.endsWith('.json')).length,scope:'Quellbestand gezählt; keine Behauptung öffentlicher Zugänglichkeit oder Volllektüre jeder Fassung'};}
const out={date:'2026-11-10',counts,curriculum,limits:['Suchinventar und Fundstellen sind kein fachliches Einzelreview aller Editionen.','Private Masterreferenz wurde separat auf Oracle verifiziert und wird nicht exportiert.','Historische Bücher/PDFs und persönliche Beiträge werden nicht neu freigegeben.'],artifacts};
fs.mkdirSync(path.join(root,'reports'),{recursive:true});
fs.writeFileSync(path.join(root,'reports/scientific-positioning-inventory-20261110.json'),JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({counts,curriculum},null,2));
