import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {requiredAssets, readPublicRelease, verifyExistingPublicAssets, PUBLIC_REPO} from '../../scripts/assets/verify-existing-public-assets.mjs';
import {journalReleaseEntries, syncJournalReleaseAssets, JOURNAL_MEDIA_REPO} from '../../scripts/assets/sync-journal-release-assets.mjs';

const h = s => 'sha256:' + createHash('sha256').update(s).digest('hex');
const expected = [
  {tag:'woek-public-assets-v2', name:'book.pdf', bytes:3, digest:h('abc')},
  {tag:'woek-journal-pdfs-v1', name:'journal.pdf', bytes:3, digest:h('xyz')},
];
const response = item => ({name:item.name, state:'uploaded', size:item.bytes, digest:item.digest});
const good = async tag => expected.filter(x => x.tag === tag).map(response);

test('an explicit new journal destination leaves historical URLs intact and rejects unapproved repositories', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'journal-media-destination-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'assets/pdf/journal'),{recursive:true});fs.mkdirSync(path.join(root,'assets/data'),{recursive:true});
  for (const name of ['old','new']) fs.writeFileSync(path.join(root,`assets/pdf/journal/${name}.pdf`),name);
  fs.writeFileSync(path.join(root,'assets/data/public-release-assets.json'),JSON.stringify({assets:{}}));
  const destination=path.join(root,'assets/data/journal-release-destinations.json');
  fs.writeFileSync(destination,JSON.stringify({version:1,assets:{'assets/pdf/journal/new.pdf':JOURNAL_MEDIA_REPO}}));
  const entries=new Map(journalReleaseEntries(root));
  assert.ok(entries.get('assets/pdf/journal/old.pdf').startsWith(`https://github.com/${PUBLIC_REPO}/`));
  assert.ok(entries.get('assets/pdf/journal/new.pdf').startsWith(`https://github.com/${JOURNAL_MEDIA_REPO}/`));
  syncJournalReleaseAssets(root);assert.equal(syncJournalReleaseAssets(root,{check:true}).status,'aktuell');
  fs.writeFileSync(destination,JSON.stringify({version:1,assets:{'assets/pdf/journal/new.pdf':'someone/foreign'}}));
  assert.throws(()=>journalReleaseEntries(root),/JOURNAL_RELEASE_DESTINATION_INVALID/);
});

test('verifies the new media release independently with the same full digest gate', async () => {
  const fresh={tag:'woek-journal-pdfs-v1',repository:JOURNAL_MEDIA_REPO,name:'new.pdf',bytes:3,digest:h('new')};
  const seen=[];
  const read=async (tag,repository)=>{seen.push([tag,repository]);return (repository===JOURNAL_MEDIA_REPO?[fresh]:expected.filter(x=>x.tag===tag)).map(response);};
  assert.deepEqual(await verifyExistingPublicAssets([...expected,fresh],read),{status:'EXISTING_PUBLIC_ASSETS_VERIFIED',checked:3,releases:3});
  assert.ok(seen.some(([tag,repo])=>tag==='woek-journal-pdfs-v1' && repo===JOURNAL_MEDIA_REPO));
  await assert.rejects(verifyExistingPublicAssets([...expected,{...fresh,digest:h('bad')}],read),/PUBLIC_ASSET_MISSING_OR_CHANGED/);
  await assert.rejects(readPublicRelease('woek-public-assets-v2',fetch,undefined,undefined,JOURNAL_MEDIA_REPO),/PUBLIC_RELEASE_REPOSITORY_INVALID/);
});

test('verifies both existing public releases by name, size, upload state and full SHA256', async () => {
  assert.deepEqual(await verifyExistingPublicAssets(expected,good), {status:'EXISTING_PUBLIC_ASSETS_VERIFIED', checked:2, releases:2});
});
test('missing, different, draft and undigested assets fail closed', async () => {
  for (const alteration of [a => [], a => [{...a[0],size:4}], a => [{...a[0],digest:h('abd')}], a => [{...a[0],state:'new'}], a => [{...a[0],digest:null}]]) {
    await assert.rejects(verifyExistingPublicAssets(expected, async tag => tag === expected[0].tag ? alteration(await good(tag)) : good(tag)),/PUBLIC_ASSET_MISSING_OR_CHANGED/);
  }
});
test('duplicate remote names or an unrecognized scope fail', async () => {
  await assert.rejects(verifyExistingPublicAssets(expected, async tag => {const a=await good(tag);return [...a,...a];}),/PUBLIC_RELEASE_ASSET_AMBIGUOUS/);
  await assert.rejects(verifyExistingPublicAssets([expected[0]],good),/PUBLIC_ASSET_SCOPE_INCOMPLETE/);
  await assert.rejects(verifyExistingPublicAssets([...expected,{...expected[0],tag:'other'}],good),/PUBLIC_ASSET_SCOPE_INVALID/);
});
test('paginates only pinned public repository and rejects draft, errors and oversized responses', async () => {
  const seen=[];
  const fetcher=async (url,opts) => {seen.push({url,opts});return {ok:true,json:async()=>url.includes('/tags/') ? {id:7,tag_name:'woek-journal-pdfs-v1',draft:false} : new URL(url).searchParams.get('page') === '1' ? Array.from({length:100},(_,i)=>({name:`${i}.pdf`})) : [{name:'last.pdf'}]};};
  assert.equal((await readPublicRelease('woek-journal-pdfs-v1',fetcher)).length,101);
  assert.equal(seen.length,3);assert.ok(seen.every(x=>x.url.startsWith(`https://api.github.com/repos/${PUBLIC_REPO}/releases/`) && x.opts.method==='GET' && !x.opts.headers.Authorization && x.opts.redirect==='error'));
  await assert.rejects(readPublicRelease('other',fetcher),/PUBLIC_RELEASE_TAG_INVALID/);
  await assert.rejects(readPublicRelease('woek-journal-pdfs-v1',async()=>({ok:false})),/PUBLIC_RELEASE_METADATA_UNAVAILABLE/);
  await assert.rejects(readPublicRelease('woek-journal-pdfs-v1',async()=>({ok:true,json:async()=>({id:7,tag_name:'woek-journal-pdfs-v1',draft:true})})),/PUBLIC_RELEASE_INVALID/);
  await assert.rejects(readPublicRelease('woek-journal-pdfs-v1',async url=>({ok:true,json:async()=>url.includes('/tags/') ? {id:7,tag_name:'woek-journal-pdfs-v1',draft:false} : new Array(101)})),/PUBLIC_RELEASE_ASSETS_INVALID/);
});
test('local sources and journal URLs are pinned; duplicates and path escapes fail', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'woek-doc-release-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const files=['assets/downloads/woek-register/v1.5/WOeK_Masterregister_v1.5_2026-08-21.xlsx','public/downloads/originals/WOeK_Begriffsleitfaden_fuehrend_v1.6.pdf','public/downloads/originals/WOeK_Begriffsleitfaden_fuehrend_v1.7.pdf','assets/pdf/journal/j.pdf'];
  for (const file of files) {fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),file);}
  const url=`https://github.com/${PUBLIC_REPO}/releases/download/woek-journal-pdfs-v1/journal.pdf`;
  assert.equal(requiredAssets(root,[[files[3],url]]).length,4);
  assert.throws(()=>requiredAssets(root,[]),/PUBLIC_JOURNAL_LIST_EMPTY/);
  assert.throws(()=>requiredAssets(root,[[files[3],url],[files[3],url]]),/PUBLIC_ASSET_DUPLICATE/);
  assert.throws(()=>requiredAssets(root,[[files[3],url.replace('sustynats','someone')]]),/PUBLIC_JOURNAL_REFERENCE_INVALID/);
  fs.unlinkSync(path.join(root,files[3]));fs.symlinkSync('/etc/hosts',path.join(root,files[3]));
  assert.throws(()=>requiredAssets(root,[[files[3],url]]),/PUBLIC_ASSET_PATH_INVALID/);
});
test('retries one explicit temporary server failure without weakening release validation', async () => {
  let calls=0, delays=[];
  const read=async url => {
    calls++;
    if (calls===1) return {ok:false,status:503};
    return {ok:true,json:async()=>url.includes('/tags/') ? {id:7,tag_name:'woek-journal-pdfs-v1',draft:false} : []};
  };
  assert.deepEqual(await readPublicRelease('woek-journal-pdfs-v1',read,async ms=>delays.push(ms)),[]);
  assert.deepEqual(delays,[1000]);assert.equal(calls,3);
});
test('rate limits retry only when reset is explicit and nearby', async () => {
  const makeResponse = reset => ({ok:false,status:403,headers:{get:k=>k==='x-ratelimit-remaining' ? '0' : k==='x-ratelimit-reset' ? reset : null}});
  const delays=[];let calls=0;
  const read=async url=>{calls++;return calls===1 ? makeResponse('1005') : {ok:true,json:async()=>url.includes('/tags/') ? {id:7,tag_name:'woek-journal-pdfs-v1',draft:false} : []};};
  assert.deepEqual(await readPublicRelease('woek-journal-pdfs-v1',read,async ms=>delays.push(ms),()=>1000000),[]);
  assert.deepEqual(delays,[6000]);
  for (const reset of [null,'999','1061']) {
    let tries=0;
    await assert.rejects(readPublicRelease('woek-journal-pdfs-v1',async()=>{tries++;return makeResponse(reset);},async()=>assert.fail('must not sleep'),()=>1000000),/PUBLIC_RELEASE_METADATA_UNAVAILABLE_HTTP_403/);
    assert.equal(tries,1);
  }
});
test('unexpected HTTP failures stop immediately and report only the HTTP status', async () => {
  let calls=0;
  await assert.rejects(readPublicRelease('woek-journal-pdfs-v1',async()=>{calls++;return {ok:false,status:404};},async()=>assert.fail('must not sleep')),/PUBLIC_RELEASE_METADATA_UNAVAILABLE_HTTP_404/);
  assert.equal(calls,1);
});
test('a repeated temporary HTTP failure stops after three bounded retries', async () => {
  let calls=0;const delays=[];
  await assert.rejects(readPublicRelease('woek-journal-pdfs-v1',async()=>{calls++;return {ok:false,status:503};},async ms=>delays.push(ms)),/PUBLIC_RELEASE_METADATA_UNAVAILABLE_HTTP_503/);
  assert.equal(calls,4);assert.deepEqual(delays,[1000,2000,4000]);
});

test('recovers from three temporary 504 responses without skipping validation', async () => {
  let calls=0;const delays=[];
  const read=async url=>{calls++;return calls<=3 ? {ok:false,status:504} : {ok:true,json:async()=>url.includes('/tags/') ? {id:7,tag_name:'woek-journal-pdfs-v1',draft:false} : []};};
  assert.deepEqual(await readPublicRelease('woek-journal-pdfs-v1',read,async ms=>delays.push(ms)),[]);
  assert.equal(calls,5);assert.deepEqual(delays,[1000,2000,4000]);
});
