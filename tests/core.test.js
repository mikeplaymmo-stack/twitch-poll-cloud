import test from 'node:test';
import assert from 'node:assert/strict';
import {allocate,settings,makeRows,recoverJob} from '../src/core.js';
import {seal,unseal,issueSession,session,passwordOK,body,sameOrigin} from '../src/security.js';
const rng=()=>.21;
const env={SESSION_KEY:'ab'.repeat(32),PANEL_PASSWORD:'a-very-long-panel-password'};
test('20 accounts at 30/20/25/25 produce 6/4/5/5; small pools never lose votes',()=>{
  assert.deepEqual(allocate(20,[30,20,25,25],rng),[6,4,5,5]);
  for(let n=0;n<=50;n++)for(const weights of [[50,50],[33,33,34],[0,0,100],[1,1,1,1,96]]){
    const result=allocate(n,weights,rng);assert.equal(result.reduce((a,b)=>a+b,0),n);
    result.forEach((v,i)=>{assert.ok(Number.isInteger(v)&&v>=0);assert.ok(Math.abs(v-n*weights[i]/100)<1.000001);if(weights[i]===0)assert.equal(v,0);});
  }
});
test('participation selects a unique subset and checks option texts before dispatch',()=>{
  const logins=Array.from({length:20},(_,i)=>'test_'+i);
  const c=settings({logins,channel:'example',weights:[50,50],participation:50,labels:['Да','Нет']},logins);
  const rows=makeRows(c,['Да','Нет'],rng);assert.equal(rows.length,10);assert.equal(new Set(rows.map(r=>r.login)).size,10);
  assert.equal(rows.filter(r=>r.choice===0).length,5);
  assert.throws(()=>makeRows(c,['Нет','Да'],rng),/Подписи/);
  assert.throws(()=>makeRows(c,['Да','Нет','Может быть'],rng),/Количество/);
});
test('invalid settings and unverified accounts are rejected before work',()=>{
  const base={logins:['a'],channel:'test',weights:[50,50]};
  for(const patch of [{weights:[30,30]},{weights:[101,-1]},{weights:[NaN,50]},{logins:['x']},{channel:'https://twitch.tv/'},{participation:1},{maxMinutes:9999}])assert.throws(()=>settings({...base,...patch},['a']));
});
test('credentials are encrypted with authentication and bound to account identity',async()=>{
  const input={cookies:[{name:'auth-token',value:'VERY_PRIVATE_TOKEN'}]};
  const encrypted=await seal(input,env.SESSION_KEY,'alice');assert.ok(!JSON.stringify(encrypted).includes('VERY_PRIVATE_TOKEN'));
  assert.deepEqual(await unseal(encrypted,env.SESSION_KEY,'alice'),input);
  await assert.rejects(unseal(encrypted,env.SESSION_KEY,'bob'));
  await assert.rejects(unseal({...encrypted,data:encrypted.data.slice(0,-4)+'AAAA'},env.SESSION_KEY,'alice'));
});
test('panel sessions are signed, expire, and rotate when password changes',async()=>{
  const token=await issueSession(env),request=new Request('https://panel.example/api/state',{headers:{cookie:'__Host-panel='+token}});
  assert.ok((await session(request,env)).csrf);
  assert.equal(await session(request,{...env,PANEL_PASSWORD:'new password'}),null);
  assert.equal(await session(new Request('https://panel.example/',{headers:{cookie:'__Host-panel='+token.slice(0,-6)+'AAAAAA'}}),env),null);
  assert.equal(await passwordOK(env.PANEL_PASSWORD,env.PANEL_PASSWORD),true);assert.equal(await passwordOK('wrong',env.PANEL_PASSWORD),false);
});
test('write requests require same origin and bounded JSON body',async()=>{
  assert.throws(()=>sameOrigin(new Request('https://panel.example/api/start',{headers:{origin:'https://attacker.example'}})));
  sameOrigin(new Request('https://panel.example/api/start',{headers:{origin:'https://panel.example'}}));
  const req=value=>new Request('https://panel.example/',{method:'POST',headers:{'Content-Type':'application/json'},body:value});
  await assert.rejects(body(req(JSON.stringify({secret:'x'.repeat(20000)}))));
  await assert.rejects(body(req('[]')));assert.deepEqual(await body(req('{"channel":"test"}')),{channel:'test'});
});
test('restart preserves confirmations but does not retry possibly sent votes',()=>{
  const j=recoverJob({status:'voting',rows:[{status:'sending'},{status:'queued'},{status:'confirmed'}]});
  assert.equal(j.status,'interrupted');assert.deepEqual(j.rows.map(r=>r.status),['uncertain','skipped','confirmed']);
});
