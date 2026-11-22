import test from 'node:test';
import assert from 'node:assert/strict';
import { callOpenAiDirect } from '../../scripts/news/openai-transport.mjs';
import { providerOutcomeUncertain } from '../../scripts/news/provider-outcome.mjs';

const options = fetchImpl => ({apiKey:'fake-only',prompt:'synthetic request',schema:false,repair:false,
  attempts:2,fetchImpl,retryDelayImpl:async()=>{}});

for (const [label,fail] of [
  ['TypeError after simulated acceptance',()=>{throw new TypeError('synthetic lost response');}],
  ['abort after simulated acceptance',()=>{throw Object.assign(Error('synthetic abort'),{name:'AbortError'});}],
  ['server 503 after simulated acceptance',()=>Response.json({}, {status:503})],
]) test(label+' cannot trigger a duplicate POST and remains uncertain',async()=>{
  let calls=0;
  await assert.rejects(callOpenAiDirect([],options(async()=>{calls++;return fail();})),e=>{
    assert.equal(e.requestAttempts,1);
    assert.equal(providerOutcomeUncertain(e,{started:true,costRecorded:false}),true);
    return true;
  });
  assert.equal(calls,1);
});
for (const status of [307,308]) test(`synthetic HTTP ${status} refuses redirect without another POST`,async()=>{
  let calls=0;
  await assert.rejects(callOpenAiDirect([],options(async(_url,init)=>{
    calls++;assert.equal(init.redirect,'error');
    // Fake fetch models the browser's error-on-redirect behavior.
    throw new TypeError('synthetic redirect refused');
  })),e=>e.requestAttempts===1 && providerOutcomeUncertain(e,{started:true,costRecorded:false}));
  assert.equal(calls,1);
});
for (const payload of [
  {},
  {error:{code:'slow_down'}},
  {error:{code:'rate_limit_exceeded'},usage:{input_tokens:10}},
  {error:{code:'rate_limit_exceeded'},output:[]},
]) test('ambiguous 429 '+JSON.stringify(payload)+' is not replayed and holds',async()=>{
  let calls=0;
  await assert.rejects(callOpenAiDirect([],options(async()=>{calls++;return Response.json(payload,{status:429});})),e=>{
    assert.equal(e.requestAttempts,1);assert.notEqual(e.providerNotCalled,true);
    assert.equal(providerOutcomeUncertain(e,{started:true,costRecorded:false}),true);return true;
  });
  assert.equal(calls,1);
});
test('even a structured, output-free rate refusal does not trigger a second POST',async()=>{
  let calls=0;
  await assert.rejects(callOpenAiDirect([],options(async()=>{
    calls++;
    if(calls===1) return Response.json({error:{code:'rate_limit_exceeded'}},{status:429});
    return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"analyses":[]}'}]}]});
  })),e=>e.message==='AI_PROVIDER_ERROR:429' && e.requestAttempts===1 &&
    providerOutcomeUncertain(e,{started:true,costRecorded:false}));
  assert.equal(calls,1);
});
for (const status of [401,403,429]) test(`status ${status} with contradictory provider evidence remains uncertain`,async()=>{
  let calls=0;
  const payload={id:'synthetic-response',status:'completed',error:{code:status===429?'credit_balance_exhausted':'invalid_api_key'},
    output:[{type:'message'}],usage:{input_tokens:2}};
  await assert.rejects(callOpenAiDirect([],options(async()=>{calls++;return Response.json(payload,{status});})),e=>{
    assert.equal(e.requestAttempts,1);assert.notEqual(e.providerNotCalled,true);
    assert.equal(providerOutcomeUncertain(e,{started:true,costRecorded:false}),true);return true;
  });
  assert.equal(calls,1);
});
