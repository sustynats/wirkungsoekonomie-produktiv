import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import check from './browser-check.mjs';
const {chromium}=await import(pathToFileURL(process.env.WA_PLAYWRIGHT).href);
const browser=await chromium.launch({executablePath:process.env.WA_CHROME,headless:true,args:['--no-sandbox']});
try{const page=await browser.newPage();const report=await check(page);fs.writeFileSync('output/playwright/browser-results.json',JSON.stringify(report,null,2)+'\n');console.log(`Browser check: ${report.status}, ${report.checks} checks`);}finally{await browser.close();}
