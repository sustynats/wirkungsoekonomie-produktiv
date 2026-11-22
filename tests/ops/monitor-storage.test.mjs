import test from 'node:test';
import assert from 'node:assert/strict';
import {guardMonitorStateWrite,writeMonitorState,monitorErrorCode,STATE_BRANCH} from '../../scripts/ops/discord-monitor.mjs';
const meta=()=>({full_name:'sustynats/wirkungsoekonomie-produktiv',size:104869655});
test('monitor checks the exact state payload and fresh metadata before its one Contents write',async()=>{
 const calls=[],state={outbox:[{id:'fixture'}],incidents:{}};const sha='a'.repeat(40);
 const written=await writeMonitorState({state,sha,api:async(route,options)=>{calls.push({route,options});return route===''?meta():{content:{sha:'b'.repeat(40)}};}});
 assert.equal(written,'b'.repeat(40));assert.deepEqual(calls.map(x=>x.route),['','contents/monitor-state.json']);const body=JSON.parse(calls[1].options.body);assert.equal(body.branch,STATE_BRANCH);assert.equal(body.sha,sha);assert.deepEqual(JSON.parse(Buffer.from(body.content,'base64')),state);
});
test('an oversized monitor outbox cannot create a branch or write Contents',async()=>{
 const calls=[];await assert.rejects(writeMonitorState({state:{outbox:['x'.repeat(524288)]},api:async(route)=>{calls.push(route);return meta();}}),/API_STATE_TOO_LARGE/);assert.equal(calls.length,0);
});
test('monitor read failure stops before mutation and does not retry',async()=>{
 let calls=0;await assert.rejects(writeMonitorState({state:{outbox:[]},api:async()=>{calls++;throw Error('READ_FAILED');}}),/READ_FAILED/);assert.equal(calls,1);
});
test('a missing write acknowledgement is an explicit uncertain stop, without retry',async()=>{
 const calls=[];await assert.rejects(writeMonitorState({state:{outbox:[]},api:async(route)=>{calls.push(route);return route===''?meta():{};}}),/MONITOR_STATE_WRITE_ACK_INVALID/);assert.deepEqual(calls,['','contents/monitor-state.json']);
});
test('branch admission uses the same payload gate before a Ref could be created',async()=>{
 let writes=0;await assert.rejects((async()=>{await guardMonitorStateWrite({state:{outbox:[]},api:async()=>({size:null})});writes++;})(),/REPOSITORY_SIZE_INVALID/);assert.equal(writes,0);
});
test('monitor logs only bounded error codes instead of payloads or private paths',()=>{
 assert.equal(monitorErrorCode(Error('GIT_STORAGE_RAW_PART_FORBIDDEN:private payload')),'GIT_STORAGE_RAW_PART_FORBIDDEN');assert.equal(monitorErrorCode(Error('private secret text')),'MONITOR_EXECUTION_FAILED');assert.equal(monitorErrorCode(Error('MONITOR_STATE_HTTP_403')),'MONITOR_STATE_HTTP_403');
});
