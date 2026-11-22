// Receives a real Playwright page; also used by the isolated Pages release.
export default async function check(page,{base='http://127.0.0.1:8799',screenshots='output/playwright'}={}){
 const results=[];
 function assert(ok,message){if(!ok)throw new Error(message);results.push(message);}
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/werteadvent/');
 await page.evaluate(()=>localStorage.removeItem('werteadvent-2026-preparation-v1'));
 await page.reload();await page.locator('[data-js-controls]').first().waitFor({state:'visible'});
 assert(await page.locator('.wa-calendar [data-day]').count()===24,'24 calendar values');
 assert(await page.locator('[data-value]').count()===24,'24 inspiration cards');
 assert((await page.locator('meta[name=robots]').getAttribute('content'))==='noindex, nofollow, noarchive','robots exclusions');
 assert(await page.locator('.wa-header').getByText('Natalie').count()===0,'campaign header without personal promotion');
 for(const width of [320,390,430,768,1440]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`no horizontal overflow at ${width}px`);}
 await page.setViewportSize({width:390,height:844});
 await page.locator('[data-filter=Planet]').click();assert(await page.locator('.wa-calendar [data-day]:visible').count()===6,'Planet filter: 6 values');
 await page.locator('[data-filter=Demokratie]').click();assert(await page.locator('.wa-calendar [data-day]:visible').count()===6,'Demokratie filter: 6 values');
 await page.locator('#reset-filters').click();await page.locator('#date-filter').selectOption('24');assert(await page.locator('.wa-calendar [data-day]:visible').count()===1,'date filter: one value');
 await page.locator('#reset-filters').click();
 for(let n=1;n<=24;n++){const id='tag-'+String(n).padStart(2,'0');await page.locator(`.wa-calendar [data-day="${n}"]`).click();assert(await page.locator('#'+id).evaluate(el=>el.open),`calendar anchor opens ${id}`);await page.locator('#'+id+' summary').click();}
 await page.goto(base+'/werteadvent/#tag-21');assert(await page.locator('#tag-21').evaluate(el=>el.open),'direct shared value opens automatically');
 await page.locator('[data-favorite="21"]').click();await page.locator('[data-done="21"]').check();await page.reload();
 assert(await page.locator('[data-favorite="21"]').getAttribute('aria-pressed')==='true','favorite survives reload');assert(await page.locator('[data-done="21"]').isChecked(),'participation status survives reload');
 await page.locator('#progress-filter').selectOption('done');assert(await page.locator('.wa-calendar [data-day]:visible').count()===1,'done-value filter');await page.locator('#progress-filter').selectOption('open');assert(await page.locator('.wa-calendar [data-day]:visible').count()===23,'not-yet-done filter');await page.locator('#progress-filter').selectOption('all');assert((await page.locator('#favorite-filter-label').innerText()).includes('(1)'),'favorite count visible');assert(!(await page.locator('#wa-stats-consent').isChecked()),'aggregate statistics default off');
 await page.locator('#favorites-only').check();assert(await page.locator('.wa-calendar [data-day]:visible').count()===1,'favorites filter');
 await page.locator('#reset-filters').click();await page.locator('#format-filter').selectOption('30');assert(await page.locator('[data-format-seconds="30"].is-highlighted').count()===24,'30-second ideas highlighted for all values');
 await page.locator('#tool-value').selectOption('18');assert((await page.locator('#creator-tools').innerText()).includes('Ernährungssicherheit'),'creator tools substitute selected value');
 await page.context().grantPermissions(['clipboard-read','clipboard-write']);
 await page.locator('#creator-tools button').first().click();assert((await page.evaluate(()=>navigator.clipboard.readText())).includes('Ernährungssicherheit'),'clipboard copies selected value');
 await page.evaluate(()=>Object.defineProperty(navigator,'share',{value:undefined,configurable:true}));
 await page.locator('#tag-21 [data-share]').click();await page.locator('#share-dialog').waitFor({state:'visible'});await page.locator('[data-share-action=link]').click();assert((await page.evaluate(()=>navigator.clipboard.readText()))==='https://wirkungsoekonomie.de/werteadvent/#tag-21','value share fallback copies correct anchor');
 assert((await page.locator('#share-whatsapp').getAttribute('href')).includes(encodeURIComponent('#tag-21')),'WhatsApp carries value anchor');
 await page.keyboard.press('Escape');assert(!(await page.locator('#share-dialog').evaluate(d=>d.open)),'share dialog keyboard dismissal');
 await page.evaluate(()=>Object.defineProperty(navigator,'share',{value:async payload=>{window.__shared=payload},configurable:true}));
 await page.locator('#tag-21 [data-share]').click();assert((await page.evaluate(()=>window.__shared.url)).endsWith('#tag-21'),'native share API used with correct value');
 await page.evaluate(()=>{window.__actualClipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});window.__actualExec=document.execCommand;document.execCommand=()=>false;});
 await page.locator('#tag-21 [data-copy]').first().click();assert(await page.locator('#manual-copy').isVisible(),'manual-copy fallback if clipboard unavailable');await page.keyboard.press('Escape');
 await page.locator('#clear-local').click();assert(!(await page.locator('[data-done="21"]').isChecked()),'clear local preparation');
 for(const img of await page.locator('.wa-calendar img').all()){const src=await img.getAttribute('src');const response=await page.request.get(base+src);assert(response.ok(),`icon preview ${src.split('/').pop()}`);}
 const downloads=await page.locator('[download]').evaluateAll(links=>[...new Set(links.map(a=>a.href))]);
 for(const url of downloads){const response=await page.request.get(url,{maxRedirects:8});assert(response.ok(),`download ${new URL(url).pathname.split('/').pop()}`);}
 assert((await page.locator('.wa-contact-links a').first().getAttribute('href'))==='https://www.tiktok.com/@sustynats','TikTok user-supplied profile');
 assert((await page.locator('.wa-contact-links a').nth(1).getAttribute('href'))==='https://discord.com/users/1206956406805102593','Discord user-supplied profile');
 await page.goto(base+'/werte-advent-2026-creators-k7m4p9x2/#tag-24');assert(await page.locator('#tag-24').evaluate(el=>el.open),'hidden route and direct anchor');
 await page.goto(base+'/werteadvent/');await page.locator('#day-jump').selectOption('7');assert(await page.locator('#tag-07').evaluate(el=>el.open),'quick day selector');
 await page.emulateMedia({reducedMotion:'reduce'});assert(await page.evaluate(()=>getComputedStyle(document.querySelector('.wa-day')).transitionDuration)==='0s','reduced motion');
 await page.goto(base+'/werteadvent/');await page.screenshot({path:screenshots+'/werteadvent-mobile.png'});
 await page.locator('[data-filter=all]').click();await page.locator('#kalender').scrollIntoViewIfNeeded();await page.screenshot({path:screenshots+'/werteadvent-calendar-mobile.png'});
 await page.locator('.wa-calendar [data-day="1"]').click();await page.locator('#tag-01 summary').scrollIntoViewIfNeeded();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.screenshot({path:screenshots+'/werteadvent-card-mobile.png'});
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/werteadvent/');await page.screenshot({path:screenshots+'/werteadvent-desktop.png'});
 assert(errors.length===0,'no browser JavaScript errors');
 return {status:'PASS',checks:results.length,results};
}
