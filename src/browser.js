import puppeteer from '@cloudflare/puppeteer';
import domSource from './poll-dom.txt';
import { need, loginOf, UserError } from './core.js';
const pause = ms => new Promise(r => setTimeout(r, ms));
const twitchCookie = c => /(^|\.)twitch\.tv$/.test(c.domain.replace(/^\./,''));

export class CloudBrowser {
  constructor(env, metadata, saveMetadata) {
    this.env=env;this.meta=metadata;this.saveMetadata=saveMetadata;this.browser=null;this.entries=new Map();this.pending=null;
  }
  async ensure() {
    if(this.browser?.connected)return this.browser;
    if(this.pending)return this.pending;
    this.pending=this.connect().finally(()=>{this.pending=null;});return this.pending;
  }
  async connect() {
    if(this.meta?.id) {
      try {this.browser=await puppeteer.connect(this.env.BROWSER,this.meta.id);return this.browser;}
      catch {
        const sessions=await puppeteer.sessions(this.env.BROWSER);
        need(!sessions.some(s=>s.sessionId===this.meta.id),'Предыдущий браузер ещё работает, но связь с ним недоступна. Новый браузер не запущен.',502);
        this.meta=null;this.entries.clear();await this.saveMetadata(null);
      }
    }
    this.browser=await puppeteer.launch(this.env.BROWSER,{keep_alive:60000});
    this.meta={id:this.browser.sessionId(),startedAt:Date.now()};await this.saveMetadata(this.meta);return this.browser;
  }
  async entry(login, saved) {
    await this.ensure();
    const previous=this.entries.get(login);if(previous && !previous.page.isClosed())return previous;
    const context=await this.browser.createBrowserContext();
    try {
      const page=await context.newPage();
      await page.setViewport({width:1100,height:820});
      page.setDefaultTimeout(3500);page.setDefaultNavigationTimeout(18000);
      await page.evaluateOnNewDocument(domSource);
      if(saved) {
        const cookies=(saved.cookies||[]).filter(c=>twitchCookie(c) && (!c.expires || c.expires<0 || c.expires>Date.now()/1000));
        if(cookies.length)await page.setCookie(...cookies.map(({name,value,domain,path,expires,httpOnly,secure,sameSite})=>({name,value,domain,path,expires,httpOnly,secure,sameSite})));
        await page.evaluateOnNewDocument(storage=>{
          if(location.origin==='https://www.twitch.tv')for(const [k,v] of Object.entries(storage||{}))localStorage.setItem(k,v);
        },saved.localStorage||{});
      }
      const entry={context,page};this.entries.set(login,entry);return entry;
    }catch(e){await context.close().catch(()=>{});throw e;}
  }
  async openLogin(login,saved) {
    const {page}=await this.entry(login,saved);
    await page.goto('https://www.twitch.tv/login',{waitUntil:'domcontentloaded'});
    return this.live(login);
  }
  async live(login) {
    const e=this.entries.get(login);need(e && !e.page.isClosed(),'Облачное окно закрыто. Открой вход заново.');
    const cdp=await e.page.createCDPSession();
    try {
      const result=await cdp.send('Cloudflare.getLiveView',{mode:'tab',expiresInMs:300000});
      const u=new URL(result.devtoolsFrontendUrl);
      need(u.protocol==='https:' && u.hostname==='live.browser.run','Cloudflare вернул неподходящую ссылку.',502);
      return {url:u.href,expiresAt:Date.now()+300000};
    }finally{await cdp.detach().catch(()=>{});}
  }
  async identity(login) {
    const e=this.entries.get(login);need(e && !e.page.isClosed(),'Сначала открой вход для этого аккаунта.');
    const token=(await e.page.cookies('https://www.twitch.tv/')).find(c=>c.name==='auth-token')?.value;
    need(token,'В облачном окне ещё не выполнен вход в Twitch.');
    let r;try{r=await fetch('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:'OAuth '+token},redirect:'error',signal:AbortSignal.timeout(8000)});}catch{throw new UserError('Twitch не ответил на проверку входа.');}
    need(r.ok,'Сессия Twitch недействительна. Выполни вход заново.');
    const info=await r.json();need(String(info.login).toLowerCase()===login,'В окне открыт другой аккаунт. Нужен '+login+'.');
    return {id:String(info.user_id),login};
  }
  async snapshot(login) {
    await this.identity(login);const {page}=this.entries.get(login);
    if(new URL(page.url()).origin!=='https://www.twitch.tv')await page.goto('https://www.twitch.tv/',{waitUntil:'domcontentloaded'});
    return {cookies:(await page.cookies('https://www.twitch.tv/','https://id.twitch.tv/')).filter(twitchCookie),
      localStorage:await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage)))};
  }
  async watch(login,channel,saved) {
    const {page}=await this.entry(login,saved);
    await page.goto('https://www.twitch.tv/popout/'+loginOf(channel)+'/chat',{waitUntil:'domcontentloaded'});
    await page.evaluate(domSource);await this.identity(login);
    // Give Twitch's asynchronous chat/poll widget time to mount before the initial baseline.
    await pause(2000);
  }
  async read(login) {
    const e=this.entries.get(login);need(e && !e.page.isClosed(),'Облачное окно закрыто.');
    return e.page.evaluate(()=>{
      const D=globalThis.PollTrialDOM,p=D?.find();if(!p)return null;
      return {channel:D.channel(location.href),title:p.title,signature:D.signature(p),choices:p.options.map(o=>o.label),
        block:D.blocker(p)||(p.title==='Опрос Twitch'?'Текст вопроса не распознан. Нужна проверка окна.':'')};
    });
  }
  async diagnostic(login) {
    const e=this.entries.get(login);need(e && !e.page.isClosed(),'Нет открытого облачного окна.');
    await e.page.evaluate(domSource);return e.page.evaluate(()=>PollTrialDOM.diagnostic());
  }
  async vote(login,target,answer,allowed,beforeSend) {
    const e=this.entries.get(login);need(e && !e.page.isClosed(),'Окно аккаунта закрыто.');
    const {page}=e;let poll;
    for(let i=0;i<10&&allowed();i++){poll=await this.read(login);if(poll)break;await pause(300);}
    if(!allowed())return {status:'skipped',message:'Остановлено или время истекло.'};
    if(!poll)return {status:'skipped',message:'Опрос не найден: закончился, свёрнут или разметка изменилась.'};
    if(poll.signature!==target.signature||poll.channel!==target.channel)return {status:'skipped',message:'Опрос или канал изменился.'};
    if(poll.block)return {status:'skipped',message:poll.block};
    const option=await page.evaluateHandle(({signature,answer,channel})=>{
      const D=PollTrialDOM,p=D.find();if(!p||D.signature(p)!==signature||D.channel(location.href)!==channel||D.blocker(p))return null;
      const matches=p.options.filter(o=>D.norm(o.label)===D.norm(answer));return matches.length===1?matches[0].target:null;
    },{signature:target.signature,channel:target.channel,answer});
    try{if(!option.asElement()||!allowed())return {status:'skipped',message:'Ответ недоступен.'};await option.asElement().click();}finally{await option.dispose();}
    try {
      await page.waitForFunction(({signature,answer})=>{
        const D=PollTrialDOM,p=D.find(),o=p?.options.find(o=>D.norm(o.label)===D.norm(answer));
        return p&&D.signature(p)===signature&&o&&D.selected(o)&&!D.disabled(p.button);
      },{timeout:2500},{signature:target.signature,answer});
    }catch{return {status:'failed',message:'Не удалось выбрать ответ.'};}
    await this.identity(login);
    const button=await page.evaluateHandle(({signature,channel,answer})=>{
      const D=PollTrialDOM,p=D.find();if(!p||D.signature(p)!==signature||D.channel(location.href)!==channel||D.blocker(p)||D.disabled(p.button))return null;
      const o=p.options.find(o=>D.norm(o.label)===D.norm(answer));if(!o||!D.selected(o))return null;
      globalThis.__pollCloudResult=p.root;return p.button;
    },{signature:target.signature,channel:target.channel,answer});
    try {
      if(!button.asElement()||!allowed())return {status:'skipped',message:'Отправка отменена.'};
      await beforeSend(); // Durable attempt marker MUST be committed before any vote click.
      if(!allowed())return {status:'skipped',message:'Остановлено до отправки.'};
      await button.asElement().click();
    }finally{await button.dispose();}
    for(let i=0;i<16;i++){
      await pause(250);
      const yes=await page.evaluate(()=>{
        const root=globalThis.__pollCloudResult,D=PollTrialDOM;
        return !!root?.isConnected&&Array.from(root.querySelectorAll('p,span,div,[role="status"]')).some(el=>!el.children.length&&D.visible(el)&&D.voted.test(D.text(el.textContent)));
      });
      if(yes)return {status:'confirmed',message:'Twitch показал подтверждение голоса.'};
    }
    return {status:'uncertain',message:'Кнопка нажата, явного подтверждения нет. Повтора не будет.'};
  }
  async closeAccount(login){const e=this.entries.get(login);this.entries.delete(login);if(e)await e.context.close().catch(()=>{});}
  async close() {
    let browser=this.browser?.connected?this.browser:null;
    if(!browser&&this.meta?.id){
      try{browser=await puppeteer.connect(this.env.BROWSER,this.meta.id);}
      catch{
        const sessions=await puppeteer.sessions(this.env.BROWSER);
        need(!sessions.some(s=>s.sessionId===this.meta.id),'Cloudflare пока не подтвердил закрытие браузера.',502);
      }
    }
    if(browser)await browser.close();
    this.browser=null;this.entries.clear();this.meta=null;await this.saveMetadata(null);
  }
  async ping(){if(this.browser?.connected)await this.browser.version();}
}
