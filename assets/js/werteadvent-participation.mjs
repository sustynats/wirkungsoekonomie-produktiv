const section=document.querySelector('#beitrag-melden');
if(section){
 const api=section.dataset.waApi,consentVersion='2026-11-19-v1',consentKey='werteadvent-2026-stats-consent-v1';
 const consent=document.querySelector('#wa-stats-consent'),statsStatus=document.querySelector('#wa-stats-status');
 let enabled=false;
 try{enabled=localStorage.getItem(consentKey)==='yes';}catch{}
 if(navigator.globalPrivacyControl===true)enabled=false;
 consent.checked=enabled;
 function status(){statsStatus.textContent=enabled?'Freiwillige Statistik ist eingeschaltet. Ausschalten wirkt sofort für weitere Aufrufe.':'Statistik ist ausgeschaltet. Die Seite funktioniert vollständig ohne Zustimmung.';}
 function count(event,day=0,resource=''){
  if(!enabled||navigator.webdriver||!['wirkungsoekonomie.de','www.wirkungsoekonomie.de'].includes(location.hostname))return;
  fetch(api+'/events',{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',headers:{'Content-Type':'text/plain;charset=UTF-8'},body:JSON.stringify({event,day,resource,consent:true}),keepalive:true}).catch(()=>{});
 }
 consent.addEventListener('change',()=>{enabled=consent.checked;try{localStorage.setItem(consentKey,enabled?'yes':'no');}catch{}status();if(enabled)count('visit');});
 for(const card of document.querySelectorAll('[data-value]')){card.addEventListener('toggle',()=>{if(card.open)count('value_open',Number(card.dataset.value));});if(card.open)count('value_open',Number(card.dataset.value));}
 document.addEventListener('click',e=>{const link=e.target.closest('a');if(!link)return;if(link.hasAttribute('data-report-day')){document.querySelector('#report-value').value=link.dataset.reportDay;return;}if(!link.hasAttribute('download'))return;
  const url=new URL(link.href),card=link.closest('[data-value]');let day=0,resource='';
  if(card){day=Number(card.dataset.value);resource=url.pathname.includes('Mit_Beschriftung')?'icon-labelled':'icon-unlabelled';}
  else{const file=url.pathname.split('/').pop();resource=file.includes('mit_Beschriftung')?'icons-labelled':file.includes('ohne_Beschriftung')?'icons-unlabelled':file.includes('24_Comic_Icons')?'icons-all':file.includes('Hochformat')?'templates':file.endsWith('.pdf')?'concept':file.includes('sharepic')?'sharepic':file.includes('qr-code')?'qr':'';}
  if(resource)count('download',day,resource);
 });
 async function post(path,payload){const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);try{const response=await fetch(api+path,{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});const result=await response.json();if(!response.ok||!result.ok)throw Error(result.message||'Der Dienst ist gerade nicht verfügbar. Bitte versuche es später erneut.');return result;}finally{clearTimeout(timeout);}}
 const reportForm=document.querySelector('#wa-report-form'),reportStatus=document.querySelector('#report-status');
 reportForm.addEventListener('submit',async e=>{e.preventDefault();if(!reportForm.reportValidity())return;const submit=reportForm.querySelector('[type=submit]');submit.disabled=true;reportStatus.textContent='Dein Link wird übermittelt …';document.querySelector('#report-receipt').hidden=true;
  try{const f=new FormData(reportForm),result=await post('/reports',{day:Number(f.get('day')),url:f.get('url'),consent:f.get('consent')==='on',consent_version:consentVersion,website:f.get('website')||''});reportStatus.textContent=result.message;if(result.deletion_code){document.querySelector('#report-deletion-code').value=result.deletion_code;document.querySelector('#copy-deletion-code').dataset.copy=result.deletion_code;document.querySelector('#report-receipt').hidden=false;}reportForm.querySelector('[name=consent]').checked=false;}
  catch(error){reportStatus.textContent=error.name==='AbortError'?'Die Verbindung dauert zu lange. Bitte prüfe deine Verbindung und versuche es erneut. Mehrfache Meldungen werden nicht doppelt gezählt.':error.message;}finally{submit.disabled=false;}
 });
 const deleteForm=document.querySelector('#wa-delete-form'),deleteStatus=document.querySelector('#delete-status');
 deleteForm.addEventListener('submit',async e=>{e.preventDefault();if(!deleteForm.reportValidity())return;const submit=deleteForm.querySelector('[type=submit]');submit.disabled=true;try{const result=await post('/reports/delete',{deletion_code:new FormData(deleteForm).get('deletion_code').trim()});deleteStatus.textContent=result.message;deleteForm.reset();}catch{deleteStatus.textContent='Die Meldung konnte gerade nicht gelöscht werden. Bitte versuche es erneut oder nutze den Kontakt zu Natalie.';}finally{submit.disabled=false;}});
 window.addEventListener('storage',e=>{if(e.key===consentKey){enabled=e.newValue==='yes';consent.checked=enabled;status();}});status();count('visit');
}
