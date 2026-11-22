import './werteadvent-participation.mjs?v=20261119-2';
const canonical='https://wirkungsoekonomie.de/werteadvent/';
const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
const pad=n=>String(n).padStart(2,'0');
const cards=$$('[data-value]');
const values=new Map(cards.map(c=>[Number(c.dataset.value),c.querySelector('summary strong').textContent]));
const tiles=$$('[data-day]');
const key='werteadvent-2026-preparation-v1';
let state={favorites:[],done:[]},storageAvailable=true,filter='all',shareDay=0,toastTimer;
try{const parsed=JSON.parse(localStorage.getItem(key)||'null');if(parsed){for(const k of ['favorites','done'])state[k]=Array.isArray(parsed[k])?[...new Set(parsed[k].filter(n=>Number.isInteger(n)&&n>=1&&n<=24))]:[];}}catch{storageAvailable=false;}
function toast(message){const node=$('#wa-toast');clearTimeout(toastTimer);node.textContent=message;node.hidden=false;toastTimer=setTimeout(()=>node.hidden=true,4000);}
function save(){try{localStorage.setItem(key,JSON.stringify(state));}catch{storageAvailable=false;toast('Der Browser erlaubt keine Speicherung. Markierungen gelten für diese Sitzung.');}updateState();}
function updateState(){
 for(const tile of tiles){const n=Number(tile.dataset.day);tile.classList.toggle('is-favorite',state.favorites.includes(n));tile.classList.toggle('is-done',state.done.includes(n));tile.setAttribute('aria-label',`${n}. Dezember: ${values.get(n)}${state.favorites.includes(n)?', Favorit':''}${state.done.includes(n)?', bereits aufgegriffen':''}`);}
 for(const b of $$('[data-favorite]')){const marked=state.favorites.includes(Number(b.dataset.favorite));b.setAttribute('aria-pressed',String(marked));b.textContent=marked?'★ Als Favorit gemerkt':'Als Favorit merken';}
 for(const input of $$('[data-done]'))input.checked=state.done.includes(Number(input.dataset.done));
 for(const warning of $$('[data-storage-warning]'))warning.textContent=storageAvailable?'':'Speicherung ist hier nicht verfügbar; Markierungen gelten nur für diese Sitzung.';
 $('#favorite-filter-label').textContent=`Meine Favoriten (${state.favorites.length})`;applyFilters();
}
function applyFilters(){const date=$('#date-filter').value,format=$('#format-filter').value,favorites=$('#favorites-only').checked,progress=$('#progress-filter').value;let visible=0;
 for(const t of tiles){const match=(progress==='all'||(progress==='done'?state.done.includes(Number(t.dataset.day)):!state.done.includes(Number(t.dataset.day))))&&(filter==='all'||t.dataset.category===filter)&&(date==='all'||t.dataset.day===date)&&(!favorites||state.favorites.includes(Number(t.dataset.day)))&&(format==='all'||['15','30','60'].includes(format)||t.dataset.formats.split(',').includes(format));t.hidden=!match;if(match)visible++;}
 for(const b of $$('[data-filter]'))b.setAttribute('aria-pressed',String(b.dataset.filter===filter));
 for(const v of $$('[data-format-seconds]'))v.classList.toggle('is-highlighted',v.dataset.formatSeconds===format);
 $('#filter-status').textContent=`${visible} ${visible===1?'Wert':'Werte'}${format!=='all'?' · '+(['15','30','60'].includes(format)?format+'-Sekunden-Ideen hervorgehoben':format):''}`;
 const hints={'Live':'Jede Karte enthält fünf offene Live-Fragen und einen kopierbaren Live-Titel.','Geschichte':'Jede Karte enthält eine typische Alltagssituation als Inspiration für deine eigene Geschichte.','Community-Frage':'Jede Karte enthält offene Fragen und einen kopierbaren Kommentar zur Aktivierung deiner Community.','Duett / Stitch':'Reagiere auf eine freigegebene Perspektive zum Tageswert. Nutze nur passende Plattformfunktionen und beachte die jeweiligen Nutzungsrechte.'};$('#format-hint').textContent=hints[format]||'';$('#format-hint').hidden=!hints[format];$('#empty-calendar').hidden=visible>0;
}
function selectValue(n){if(values.has(Number(n))){$('#tool-value').value=n;renderTools();}}
function openValue(n,{scroll=true}={}){const c=$(`#tag-${pad(n)}`);if(!c)return;c.open=true;selectValue(n);if(scroll){requestAnimationFrame(()=>{c.scrollIntoView({block:'start',behavior:'instant'});c.querySelector('summary').focus({preventScroll:true});});}}
function openHash(){const match=location.hash.match(/^#tag-(\d{1,2})$/);if(match)openValue(Number(match[1]));}
function copyElement(title,text){const wrap=document.createElement('div');wrap.className='wa-copy';const inner=document.createElement('div'),strong=document.createElement('strong'),p=document.createElement('p'),button=document.createElement('button');strong.textContent=title;p.textContent=text;button.type='button';button.textContent='Kopieren';button.dataset.copy=text;button.setAttribute('aria-label',title+' kopieren');inner.append(strong,p);wrap.append(inner,button);return wrap;}
function renderTools(){const name=values.get(Number($('#tool-value').value));const tools=[['Live-Einstieg',`Heute ist beim #WerteAdvent das Thema ${name}. Was bedeutet dieser Wert für euch? Ich möchte heute mit euch darüber sprechen, wo wir ihn in unserem Alltag erleben und was passieren müsste, damit wir ihn wirklich ernst nehmen.`],['Video-Abschluss',`Was bedeutet ${name} für dich? Schreib es in die Kommentare oder mach dein eigenes Video dazu. Wir sprechen heute auf TikTok gemeinsam über diesen Wert. #WerteAdvent`],['Einladung an andere Creator','Wir machen beim Werte-Advent mit! Vom 1. bis 24. Dezember gibt es jeden Tag einen gemeinsamen Wert, über den alle aus ihrer eigenen Perspektive sprechen können. Mach auch mit: #WerteAdvent']];$('#creator-tools').replaceChildren(...tools.map(([t,x])=>copyElement(t,x)));}
function sharePayload(n){const url=canonical+(n?`#tag-${pad(n)}`:'');const invitation=`Mach mit beim Werte-Advent 2026! Vom 1. bis 24. Dezember sprechen Creator und Live-Hosts jeden Tag über einen gemeinsamen Wert. Jeder in seinem Stil und aus seiner Perspektive. Alle Infos, Themen und kostenlosen Icons findest du hier: ${url} #WerteAdvent`;
 return {url,title:n?`${n}. Dezember: ${values.get(n)} · Werte-Advent 2026`:'Werte-Advent 2026',text:n?`${n}. Dezember beim #WerteAdvent: ${values.get(n)}. Deine Perspektive zählt!`:'24 Tage. 24 Werte. Hunderte Perspektiven. Mach mit beim #WerteAdvent!',invitation};}
const dialog=$('#share-dialog');
function shareFallback(n){shareDay=n;const p=sharePayload(n);$('#share-subtitle').textContent=n?`${n}. Dezember · ${values.get(n)}`:'24 Tage. 24 Werte. Hunderte Perspektiven.';$('#share-whatsapp').href='https://wa.me/?text='+encodeURIComponent(p.invitation);$('[data-share-action=native]').hidden=!navigator.share;$('#manual-copy-label').hidden=true;if(!dialog.open)dialog.showModal();}
async function share(n){shareDay=n;const {title,text,url}=sharePayload(n);if(navigator.share){try{await navigator.share({title,text,url});return;}catch(error){if(error.name==='AbortError')return;}}shareFallback(n);}
async function copyText(text,button){let copied=false;if(navigator.clipboard&&window.isSecureContext){try{await navigator.clipboard.writeText(text);copied=true;}catch{}}
 if(!copied){const textarea=document.createElement('textarea');textarea.value=text;textarea.setAttribute('readonly','');textarea.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;opacity:0';(dialog.open?dialog:document.body).append(textarea);textarea.focus();textarea.select();textarea.setSelectionRange(0,text.length);try{copied=document.execCommand('copy');}catch{}textarea.remove();button?.focus({preventScroll:true});}
 if(copied){toast('Kopiert. Bereit für deinen Beitrag.');if(button){const prev=button.textContent;button.textContent='Kopiert ✓';setTimeout(()=>{if(button.isConnected)button.textContent=prev;},1800);}return;}
 if(!dialog.open)shareFallback(shareDay);$('#manual-copy-label').hidden=false;$('#manual-copy').value=text;$('#manual-copy').focus();$('#manual-copy').select();toast('Bitte den markierten Text manuell kopieren.');
}
document.addEventListener('click',event=>{const target=event.target.closest('button,a');if(!target)return;
 if(target.hasAttribute('data-copy')){copyText(target.dataset.copy,target);return;}
 if(target.hasAttribute('data-share')){share(Number(target.dataset.share));return;}
 if(target.hasAttribute('data-favorite')){const n=Number(target.dataset.favorite);state.favorites=state.favorites.includes(n)?state.favorites.filter(x=>x!==n):[...state.favorites,n];save();return;}
 if(target.hasAttribute('data-filter')){filter=target.dataset.filter;applyFilters();return;}
 if(target.hasAttribute('data-select-value'))selectValue(Number(target.dataset.selectValue));
 if(target.hasAttribute('data-day')){const n=Number(target.dataset.day);openValue(n);}
 if(target.hasAttribute('data-share-action')){const p=sharePayload(shareDay),action=target.dataset.shareAction;if(action==='native'){share(shareDay);return;}const text=action==='invitation'?p.invitation:action==='tiktok'?p.text+' '+p.url:p.url;copyText(text,target);}
});
for(const input of $$('[data-done]'))input.addEventListener('change',()=>{const n=Number(input.dataset.done);state.done=input.checked?[...new Set([...state.done,n])]:state.done.filter(x=>x!==n);save();});
for(const s of ['#date-filter','#format-filter','#favorites-only','#progress-filter'])$(s).addEventListener('change',applyFilters);
$('#reset-filters').addEventListener('click',()=>{filter='all';$('#date-filter').value='all';$('#format-filter').value='all';$('#favorites-only').checked=false;$('#progress-filter').value='all';applyFilters();});
$('#jump-button').addEventListener('click',()=>{const n=Number($('#day-jump').value);if(n){location.hash=`tag-${pad(n)}`;openValue(n);}else{toast('Wähle zuerst einen Tageswert aus.');$('#day-jump').focus();}});
$('#day-jump').addEventListener('change',()=>{const n=Number($('#day-jump').value);if(n){location.hash=`tag-${pad(n)}`;openValue(n);}});
$('#tool-value').addEventListener('change',renderTools);
$('#clear-local').addEventListener('click',()=>{state={favorites:[],done:[]};try{localStorage.removeItem(key);}catch{}updateState();toast('Deine lokalen Markierungen wurden gelöscht.');});
window.addEventListener('storage',event=>{if(event.key===key){try{const v=JSON.parse(event.newValue||'null');state={favorites:v?.favorites?.filter(n=>values.has(n))||[],done:v?.done?.filter(n=>values.has(n))||[]};updateState();}catch{}}});
window.addEventListener('hashchange',openHash);
function berlinToday(now=new Date()){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));return parts.year==='2026'&&parts.month==='12'&&Number(parts.day)<=24?Number(parts.day):0;}
function updateToday(){const day=berlinToday();for(const tile of tiles){const today=Number(tile.dataset.day)===day;tile.classList.toggle('is-today',today);tile.querySelector('.wa-day-note').textContent=today?'Heute im Werte-Advent':'Ideen entdecken';if(today)tile.setAttribute('aria-current','date');else tile.removeAttribute('aria-current');}}
setInterval(updateToday,60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)updateToday();});
let previewBuilt=false;$('.wa-material-preview').addEventListener('toggle',()=>{if(!$('.wa-material-preview').open||previewBuilt)return;previewBuilt=true;$('#icon-preview').replaceChildren(...tiles.map(tile=>{const n=Number(tile.dataset.day),a=document.createElement('a'),img=document.createElement('img'),text=document.createElement('span');a.href='#tag-'+pad(n);a.dataset.day=n;img.src=`/assets/werteadvent-2026/labelled-${pad(n)}.webp?v=2`;img.alt='Comic-Icon '+values.get(n);img.loading='lazy';img.width=240;img.height=240;text.textContent=pad(n)+'. '+values.get(n);a.append(img,text);return a;}));});
for(const c of $$('[data-js-controls]'))c.hidden=false;
renderTools();updateState();updateToday();openHash();
