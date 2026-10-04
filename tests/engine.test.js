import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/engine.js';
import {seal} from '../src/security.js';
const env={SESSION_KEY:'cd'.repeat(32)};
class Storage{
  constructor(){this.data=new Map();this.writes=[];this.alarm=null;}
  async get(k){return structuredClone(this.data.get(k));}
  async put(k,v){this.data.set(k,structuredClone(v));this.writes.push({k,v:structuredClone(v)});}
  async delete(k){return this.data.delete(k);}
  async setAlarm(n){this.alarm=n;}
  async deleteAlarm(){this.alarm=null;}
}
const poll={channel:'example',title:'Спите?',signature:'poll-1',choices:['Да','Нет'],block:''};
class FakeBrowser {
  constructor(meta,save){this.meta=meta;this.save=save;this.poll=structuredClone(poll);this.votes=[];this.opens=[];this.closed=0;this.inflight=0;this.peak=0;this.voteHook=null;this.watchHook=null;}
  async watch(login){this.opens.push(login);this.meta={id:'one-browser',startedAt:Date.now()};await this.save(this.meta);if(this.watchHook)await this.watchHook(login);}
  async read(){return this.poll;}
  async vote(login,target,answer,allowed,before){this.inflight++;this.peak=Math.max(this.peak,this.inflight);try{if(this.voteHook)return await this.voteHook({login,allowed,before});assert.ok(allowed());await before();if(allowed())this.votes.push({login,target,answer});return {status:'confirmed',message:'ok'};}finally{this.inflight--;}}
  async closeAccount(){}
  async close(){this.closed++;this.meta=null;await this.save(null);}
  async ping(){}
}
async function setup(n=20){
  const s=new Storage();let b;const e=new Engine(s,env,(meta,save)=>b=new FakeBrowser(meta,save));await e.ready;
  const logins=Array.from({length:n},(_,i)=>'user_'+i);e.accounts=logins.map(login=>({login,verifiedAt:Date.now()}));await s.put('accounts',e.accounts);
  for(const login of logins)await s.put('session:'+login,await seal({cookies:[]},env.SESSION_KEY,login));
  return {s,b,e,logins,config:{logins,channel:'example',weights:[50,50],participation:100,current:true,concurrency:2,maxMinutes:5}};
}
test('20 accounts use bounded groups; attempt records precede clicks; browser closes at end',async()=>{
  const {e,b,s,config}=await setup();await e.start(config);
  while(['watching','voting'].includes(e.job.status))await e.tick();
  assert.equal(b.votes.length,20);assert.equal(new Set(b.votes.map(v=>v.login)).size,20);assert.ok(b.peak<=2);
  assert.equal(b.votes.filter(v=>v.answer==='Да').length,10);assert.equal(e.job.status,'finished');assert.equal(b.meta,null);assert.equal(s.alarm,null);
  for(const vote of b.votes)assert.ok(s.writes.some(w=>w.k==='job'&&w.v.rows.some(r=>r.login===vote.login&&r.status==='sending'&&r.attemptedAt)));
});
test('stop during preparation prevents sends and all remaining accounts',async()=>{
  const {e,b,config}=await setup(3);let prepared=false;
  b.watchHook=async()=>{if(!prepared){prepared=true;await e.stop();}};
  await e.start(config);await e.tick();assert.equal(b.votes.length,0);assert.equal(e.job.status,'stopped');assert.equal(b.meta,null);
});
test('stop after durable attempt marker cannot cause an automatic resend',async()=>{
  const {e,b,config}=await setup(3);b.voteHook=async({before,allowed})=>{await before();await e.stop();assert.equal(allowed(),false);return {status:'uncertain',message:'stopped'};};
  await e.start({...config,concurrency:1});await e.tick();await e.tick();assert.equal(e.job.status,'stopped');assert.equal(e.job.rows.filter(r=>r.attemptedAt).length,1);assert.equal(b.votes.length,0);
});
test('uncertain send is not retried and private browser errors are redacted',async()=>{
  const {e,b,config}=await setup(1);let calls=0;b.voteHook=async({before})=>{calls++;await before();throw new Error('TOKEN_SECRET_FROM_REMOTE');};
  await e.start(config);await e.tick();await e.tick();assert.equal(calls,1);assert.equal(e.job.rows[0].status,'uncertain');assert.ok(!JSON.stringify(e.state()).includes('TOKEN_SECRET'));
});
test('next-poll mode excludes the current poll and repeat mode excludes identical polls',async()=>{
  const {e,b,config}=await setup(2);await e.start({...config,current:false,repeat:true});await e.tick();assert.equal(b.votes.length,0);
  b.poll={...poll,signature:'poll-2',title:'Другой вопрос'};await e.tick();assert.equal(b.votes.length,2);assert.equal(e.job.status,'watching');
  await e.tick();b.poll=null;await e.tick();b.poll={...poll,signature:'poll-2'};await e.tick();assert.equal(b.votes.length,2);
  await e.stop();await e.tick();assert.equal(b.meta,null);
});
test('deadline closes browser and rejects overlapping starts',async()=>{
  const {e,b,config}=await setup(2);await e.start(config);await assert.rejects(e.start(config),/останови/);
  e.job.deadline=Date.now()-1;await e.tick();assert.equal(e.job.status,'expired');assert.equal(b.votes.length,0);assert.equal(b.meta,null);
});
test('new handler recovers sending rows as uncertain and never resumes the queue',async()=>{
  const {e,s,config}=await setup(2);await e.start(config);e.job.status='voting';e.job.rows=[{login:'user_0',status:'sending'},{login:'user_1',status:'queued'}];await e.saveJob();
  let browser;const replacement=new Engine(s,env,(meta,save)=>browser=new FakeBrowser(meta,save));await replacement.ready;await replacement.tick();
  assert.equal(replacement.job.status,'interrupted');assert.equal(replacement.job.rows[0].status,'uncertain');assert.equal(replacement.job.rows[1].status,'skipped');assert.equal(browser.votes.length,0);
});
test('question/answer mismatch blocks sends',async()=>{
  const {e,b,config}=await setup(2);await e.start({...config,labels:['Нет','Да']});await e.tick();assert.equal(e.job.status,'skipped');assert.equal(b.votes.length,0);
});
