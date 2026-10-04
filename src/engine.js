import { active, need, loginOf, settings, makeRows, recoverJob, publicError, fingerprint } from './core.js';
import { seal, unseal } from './security.js';

export class Engine {
  constructor(storage,env,makeBrowser) {
    this.storage=storage;this.env=env;this.makeBrowser=makeBrowser;this.queue=Promise.resolve();this.job=null;this.accounts=[];this.browser=null;this.loginWindow=null;
    this.ready=this.init();
  }
  async init() {
    this.accounts=(await this.storage.get('accounts'))||[];
    const old=await this.storage.get('job');this.job=recoverJob(old)||null;
    if(old&&this.job!==old)await this.storage.put('job',this.job);
    const metadata=await this.storage.get('browser');
    this.browser=this.makeBrowser(metadata,async m=>{if(m)await this.storage.put('browser',m);else await this.storage.delete('browser');});
    // On process replacement, retire the old browser. Never resend ambiguous attempts.
    if(metadata){await this.storage.setAlarm(Date.now()+1000);await this.retire();}
  }
  serial(fn) { const result=this.queue.then(()=>this.ready).then(fn);this.queue=result.catch(()=>{});return result; }
  state() {
    return {version:'0.3.0',accounts:this.accounts.map(({login,verifiedAt})=>({login,verifiedAt})),job:this.job,
      loginWindow:this.loginWindow?{login:this.loginWindow.login,expiresAt:this.loginWindow.expiresAt}:null,
      browserStartedAt:this.browser?.meta?.startedAt||null};
  }
  idle(){need(!active(this.job),'Сначала останови текущий запуск.',409);}
  async saveJob(){if(this.job)await this.storage.put('job',this.job);}
  async retire(){
    try{await this.browser.close();await this.storage.deleteAlarm();return true;}
    catch{await this.storage.setAlarm(Date.now()+10000);return false;}
  }
  async account(login){login=loginOf(login);const a=this.accounts.find(a=>a.login===login);need(a,'Добавь этот аккаунт в панель.');return a;}
  async saved(login){const s=await this.storage.get('session:'+login);return s?unseal(s,this.env.SESSION_KEY,login):null;}
  async add(input){
    this.idle();need(Array.isArray(input.logins)&&input.logins.length<=50,'Добавляй не больше 50 логинов.');
    const values=[...new Set(input.logins.map(loginOf))];
    need(new Set([...this.accounts.map(a=>a.login),...values]).size<=50,'В этой версии максимум 50 аккаунтов.');
    for(const login of values)if(!this.accounts.some(a=>a.login===login))this.accounts.push({login,verifiedAt:null});
    await this.storage.put('accounts',this.accounts);return this.state();
  }
  async remove(input){
    this.idle();const {login}=await this.account(input.login);if(this.loginWindow?.login===login)await this.closeLogin();
    this.accounts=this.accounts.filter(a=>a.login!==login);await this.storage.delete('session:'+login);await this.storage.put('accounts',this.accounts);return this.state();
  }
  async login(input){
    this.idle();const {login}=await this.account(input.login);
    // Retire the previous context; one manual login at a time.
    if(this.loginWindow)await this.browser.closeAccount(this.loginWindow.login);
    this.loginWindow={login,expiresAt:Date.now()+10*60000};
    await this.storage.setAlarm(Date.now()+30000);
    try {const link=await this.browser.openLogin(login,await this.saved(login));return {...link,login};}
    catch(e){this.loginWindow=null;await this.retire();throw e;}
  }
  async saveLogin(input){
    this.idle();const a=await this.account(input.login);need(this.loginWindow?.login===a.login,'Открой вход для этого аккаунта.');
    const saved=await this.browser.snapshot(a.login);
    await this.storage.put('session:'+a.login,await seal(saved,this.env.SESSION_KEY,a.login));
    a.verifiedAt=Date.now();await this.storage.put('accounts',this.accounts);
    await this.closeLogin();return this.state();
  }
  async closeLogin(){this.idle();this.loginWindow=null;need(await this.retire(),'Закрытие браузера пока не подтверждено. Повторная попытка запланирована.',502);return this.state();}
  async inspect(input){
    this.idle();const a=await this.account(input.login);const saved=await this.saved(a.login);need(saved,'Сначала сохрани вход.');
    if(this.loginWindow)await this.browser.closeAccount(this.loginWindow.login);
    this.loginWindow={login:a.login,expiresAt:Date.now()+10*60000};await this.storage.setAlarm(Date.now()+30000);
    await this.browser.watch(a.login,loginOf(input.channel),saved);
    return {...await this.browser.live(a.login),login:a.login};
  }
  async diagnostic(input){await this.account(input.login);return this.browser.diagnostic(loginOf(input.login));}
  async start(input){
    this.idle();const config=settings(input,this.accounts.filter(a=>a.verifiedAt).map(a=>a.login));
    // All selected credentials must actually still exist before charging for a browser.
    for(const login of config.logins)need(await this.saved(login),'Нет сохранённого входа для '+login+'.');
    if(this.loginWindow)await this.closeLogin();
    const monitor=config.logins[0];
    this.job={id:crypto.randomUUID(),status:'watching',message:'Подключаемся к каналу…',createdAt:Date.now(),
      deadline:Date.now()+config.maxMinutes*60000,config,monitor,prepared:false,seen:[],rows:[],history:[],poll:null};
    await this.saveJob();await this.storage.setAlarm(Date.now()+1000);return this.state();
  }
  async stop(){
    await this.ready;
    if(active(this.job)){
      this.job.status='stopped';this.job.finishedAt=Date.now();this.job.message='Остановлено. Уже отправленные голоса отменить нельзя.';
      for(const r of this.job.rows){if(r.status==='sending'){r.status='uncertain';r.message='Остановка во время отправки. Проверь голос вручную.';}else if(['queued','preparing'].includes(r.status)){r.status='skipped';r.message='Остановлено.';}}
      await this.saveJob();
    }
    this.loginWindow=null;
    // Schedule cleanup even if the current request disconnects. The in-flight tick checks status before every send.
    await this.storage.setAlarm(Date.now()+1000);return this.state();
  }
  allowed(job){return this.job===job && active(job) && Date.now()<job.deadline && (job.status!=='voting'||Date.now()<job.voteDeadline);}
  async finish(status,message){if(this.job){this.job.status=status;this.job.message=message;this.job.finishedAt=Date.now();
    for(const r of this.job.rows)if(['queued','preparing'].includes(r.status)){r.status='skipped';r.message=message;}
    await this.saveJob();}if(!await this.retire()&&this.job){this.job.message+=' Закрытие браузера будет повторено.';await this.saveJob();}}
  async tick(){
    await this.ready;
    if(!active(this.job)){
      if(this.loginWindow&&Date.now()<this.loginWindow.expiresAt){await this.browser.ping();await this.storage.setAlarm(Date.now()+30000);return;}
      this.loginWindow=null;await this.retire();return;
    }
    const job=this.job;
    // An alarm exists before every network operation, including an unexpectedly killed invocation.
    await this.storage.setAlarm(Date.now()+30000);
    try {
      if(Date.now()>=job.deadline){await this.finish('expired','Достигнут лимит времени. Браузер закрыт.');return;}
      if(!job.prepared){
        await this.browser.watch(job.monitor,job.config.channel,await this.saved(job.monitor));
        if(!this.allowed(job)){await this.retire();return;}
        if(!job.config.current){const existing=await this.browser.read(job.monitor);if(existing)job.seen.push(await fingerprint(existing.signature));}
        job.prepared=true;job.message='Ждём подходящий опрос на '+job.config.channel+'.';await this.saveJob();
      }
      if(job.status==='watching'){
        const poll=await this.browser.read(job.monitor);
        const pollKey=poll?await fingerprint(poll.signature):null;
        if(!this.allowed(job))return;
        if(poll&&poll.channel===job.config.channel&&!job.seen.includes(pollKey)){
          if(job.config.title&&poll.title!==job.config.title){job.message='Ждём вопрос: '+job.config.title;}
          else if(poll.block){job.message=poll.block;}
          else {
            job.seen.push(pollKey);
            try {job.rows=makeRows(job.config,poll.choices);}
            catch(e){job.message=publicError(e);if(!job.config.repeat){await this.finish('skipped',job.message);return;}await this.saveJob();await this.storage.setAlarm(Date.now()+3000);return;}
            job.poll=poll;job.voteDeadline=Math.min(job.deadline,Date.now()+job.config.voteSeconds*1000);job.status='voting';job.message='Опрос найден. Отправляем голоса.';
            await this.saveJob();
          }
        }
      }
      if(job.status==='voting'){
        if(Date.now()>=job.voteDeadline){for(const r of job.rows)if(r.status==='queued'){r.status='skipped';r.message='Время очереди истекло.';}}
        const batch=job.rows.filter(r=>r.status==='queued').slice(0,job.config.concurrency);
        for(const row of batch){row.status='preparing';row.message='Открываем сессию аккаунта.';}
        await this.saveJob();
        await Promise.all(batch.map(row=>this.processRow(job,row)));
        if(!active(job)){await this.saveJob();await this.retire();return;}
        if(!job.rows.some(r=>r.status==='queued')){
          job.history.push({title:job.poll.title,at:Date.now(),confirmed:job.rows.filter(r=>r.status==='confirmed').length,
            uncertain:job.rows.filter(r=>r.status==='uncertain').length,total:job.rows.length});
          job.history=job.history.slice(-20);
          if(!job.config.repeat){await this.finish('finished','Очередь завершена. Смотри результат каждого аккаунта.');return;}
          if(job.seen.length>=100){await this.finish('finished','Достигнут лимит 100 разных опросов за запуск.');return;}
          job.status='watching';job.message='Ждём следующий опрос с новым вопросом или вариантами.';
        }
      }
      await this.saveJob();
      if(active(job))await this.storage.setAlarm(Date.now()+3000);
    }catch(e){
      for(const r of job.rows||[])if(r.status==='sending'){r.status='uncertain';r.message='Связь прервалась после начала отправки. Автоповтора нет.';}
      if(active(job))await this.finish('error',publicError(e));else await this.retire();
    }
  }
  async processRow(job,row){
    try {
      if(!this.allowed(job))return;
      if(row.login!==job.monitor)await this.browser.watch(row.login,job.config.channel,await this.saved(row.login));
      if(!this.allowed(job))return;
      const result=await this.browser.vote(row.login,job.poll,row.answer,()=>this.allowed(job),async()=>{
        need(this.allowed(job),'Запуск остановлен.');row.status='sending';row.attemptedAt=Date.now();row.message='Отправляем голос…';await this.saveJob();
      });
      // A positive confirmation may arrive after stop. It remains valuable and must not be hidden.
      if(active(job)||result.status==='confirmed')Object.assign(row,result);
    }catch(e){
      if(active(job)){row.status=row.attemptedAt?'uncertain':'failed';row.message=row.attemptedAt?'Отправка могла завершиться. Автоповтора нет.':publicError(e);}
    }finally{
      if(row.status==='preparing'){row.status='skipped';row.message='Остановлено или время истекло.';}
      if(row.login!==job.monitor)await this.browser.closeAccount(row.login);
      await this.saveJob();
    }
  }
}
