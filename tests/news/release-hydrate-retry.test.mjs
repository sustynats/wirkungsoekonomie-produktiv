import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {downloadHydrationPart} from '../../scripts/news/release-hydrate.mjs';
const exec=promisify(execFile);
const publicUrl=`https://github.com/sustynats/wirkungsoekonomie.de/releases/download/wirkungsticker-data-2026-11/${'a'.repeat(64)}.json.gz`;
async function withServer(statuses,fn){
 let calls=0;const server=http.createServer((_req,res)=>{const status=statuses[Math.min(calls++,statuses.length-1)];res.writeHead(status);res.end(status===200?'ok':'unavailable');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const local=`http://127.0.0.1:${server.address().port}/synthetic`;
 const run=(cmd,args,options)=>{assert.equal(cmd,'curl');const a=[...args];a[a.indexOf('--proto')+1]='=http';a[a.indexOf('--proto-redir')+1]='=http';a[a.indexOf('--url')+1]=local;return exec(cmd,a,options);};
 try {await fn(run,()=>calls);} finally {await new Promise(resolve=>server.close(resolve));}
}
test('public 504 is retried and successful bytes returned',async()=>withServer([504,200],async(run,count)=>{
 const result=await downloadHydrationPart(publicUrl,64,{run});assert.equal(result.toString(),'ok');assert.equal(count(),2);
}));
test('public 404 fails immediately without retry',async()=>withServer([404,200],async(run,count)=>{
 await assert.rejects(downloadHydrationPart(publicUrl,64,{run}));assert.equal(count(),1);
}));
test('public 504 stops after three attempts and private transport never retries',async()=>{
 await withServer([504],async(run,count)=>{await assert.rejects(downloadHydrationPart(publicUrl,64,{run}));assert.equal(count(),3);});
 let calls=0;const run=async()=>{calls++;throw Error('synthetic');};
 const privateUrl=`https://github.com/sustynats/wirkungsoekonomie-produktiv/releases/download/wirkungsticker-data-2026-11/${'a'.repeat(64)}.json.gz`;
 await assert.rejects(downloadHydrationPart(privateUrl,64,{run}),/RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE/);assert.equal(calls,1);
});

test('three explicit 504s trigger exactly one pinned native public-release fallback',async()=>withServer([504],async(run,count)=>{
 let calls=0;
 const fallbackRun=async(cmd,args,options)=>{
  if(cmd==='curl')return run(cmd,args,options);
  calls++;assert.equal(cmd,'gh');assert.deepEqual(args,['release','download','wirkungsticker-data-2026-11','--repo','sustynats/wirkungsoekonomie.de','--pattern',`${'a'.repeat(64)}.json.gz`,'--output','-']);
  assert.equal(options.timeout,50000);return {stdout:Buffer.from('fallback')};
 };
 const bytes=await downloadHydrationPart(publicUrl,64,{run:fallbackRun});assert.equal(bytes.toString(),'fallback');assert.equal(count(),3);assert.equal(calls,1);
}));
