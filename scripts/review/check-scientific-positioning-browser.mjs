import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const baseUrl=process.env.BASE_URL || 'http://127.0.0.1:8799';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({headless:true,channel:'chrome'});
const page=await browser.newPage();
const routes=['/','/wirkungswissenschaften/','/wirkungswissenschaften/wirkungsoekonomie/','/wirkungswissenschaften/faq/','/begriffe/wirkungswissenschaften/','/methodik/','/methodenraum.html','/bibliothek/','/referenz/aktualisierung/','/quellenarchiv/wok-q-9053/','/bibliothek/studienskripte/v4/woek-g-base-003/','/bibliothek/studienskripte/v4/woek-g-base-049/','/bibliothek/studienskripte/v4/woek-g-base-076/','/bibliothek/studienskripte/v4/woek-wb-wm-v4-001/'];
const findings=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));
for(const width of [320,360,375,390,428,768,1024,1280,1440]) {
  await page.setViewportSize({width,height:900});
  for(const route of routes){
    const response=await page.goto(baseUrl+route,{waitUntil:'domcontentloaded'});
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth);
    let violations=[];
    if([390,1440].includes(width)){
      await page.addScriptTag({path:'/tmp/woek-einordnung-axe.min.js'});
      violations=await page.evaluate(async()=>{const r=await axe.run('#wissenschaftliche-einordnung, main',{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}});return r.violations.map(v=>({id:v.id,impact:v.impact,targets:v.nodes.map(n=>n.target)}));});
    }
    findings.push({width,route,status:response.status(),overflow,violations});
  }
}
fs.mkdirSync('reports',{recursive:true});
fs.writeFileSync('reports/scientific-positioning-browser-20261110.json',JSON.stringify({findings,errors},null,2)+'\n');
await page.goto(baseUrl+'/wirkungswissenschaften/wirkungsoekonomie/');
await page.setViewportSize({width:390,height:900});
await page.screenshot({path:'/tmp/woek-einordnung-mobile.png',fullPage:false});
await page.setViewportSize({width:1440,height:1000});
await page.screenshot({path:'/tmp/woek-einordnung-desktop.png',fullPage:true});
await browser.close();
const failures=findings.filter(f=>f.status!==200||f.overflow||f.violations.length);
console.log(JSON.stringify({checks:findings.length,failures,errors},null,2));
if(failures.length||errors.length)process.exitCode=1;
