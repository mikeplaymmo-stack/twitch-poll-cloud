import html from '../public/index.html';
import css from '../public/style.css';
import client from '../public/app.txt';
import { CloudBrowser } from './browser.js';
import { Engine } from './engine.js';
import { UserError, need, publicError } from './core.js';
import { passwordOK, issueSession, session, sameOrigin, body } from './security.js';

const headers={ 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
const json=(data,status=200,extra={})=>new Response(JSON.stringify(data),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8',...extra}});
const cookie=token=>`__Host-panel=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${token?43200:0}`;

export default {
  async fetch(request,env){
    try {
      const u=new URL(request.url);
      if(request.method==='GET'&&['/','/app.js','/style.css'].includes(u.pathname))return new Response(u.pathname==='/'?html:u.pathname==='/app.js'?client:css,
        {headers:{...headers,'Content-Type':u.pathname==='/'?'text/html; charset=utf-8':u.pathname==='/app.js'?'text/javascript; charset=utf-8':'text/css; charset=utf-8'}});
      if(!u.pathname.startsWith('/api/'))return new Response('Not found',{status:404,headers});
      need(typeof env.PANEL_PASSWORD==='string'&&env.PANEL_PASSWORD.length>=16&&/^[a-f0-9]{64}$/i.test(env.SESSION_KEY||''),'Добавь секреты PANEL_PASSWORD (от 16 символов) и SESSION_KEY (64 hex-символа) в Cloudflare.',503);
      if(request.method==='POST')sameOrigin(request);
      if(u.pathname==='/api/login'&&request.method==='POST')return env.PANEL.get(env.PANEL.idFromName('main')).fetch(request);
      const auth=await session(request,env);need(auth,'Войди в панель.',401);
      if(request.method==='POST')need(request.headers.get('x-csrf-token')===auth.csrf,'Обнови страницу и повтори действие.',403);
      if(u.pathname==='/api/logout'&&request.method==='POST')return json({ok:true},200,{'Set-Cookie':cookie('')});
      if(u.pathname==='/api/session'&&request.method==='GET')return json({csrf:auth.csrf});
      return env.PANEL.get(env.PANEL.idFromName('main')).fetch(request);
    }catch(e){return json({error:publicError(e)},e instanceof UserError?e.status:500);}
  }
};

export class PollPanel {
  constructor(ctx,env){this.ctx=ctx;this.env=env;this.engine=new Engine(ctx.storage,env,(meta,save)=>new CloudBrowser(env,meta,save));this.loginQueue=Promise.resolve();}
  async fetch(request){
    try {
      const u=new URL(request.url);await this.engine.ready;
      if(u.pathname==='/api/login'&&request.method==='POST'){
        const data=await body(request);
        const run=this.loginQueue.then(async()=>{
          // Durable, per-IP rate limiting. A failed password never appears in a log or stored record.
          const ip=request.headers.get('cf-connecting-ip')||'unknown';
          const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip)))).map(b=>b.toString(16).padStart(2,'0')).join('');
          const key='login-rate:'+hash;const previous=await this.ctx.storage.get(key);const rate=previous&&previous.until>Date.now()?previous:{attempts:0,until:Date.now()+15*60000};
          need(rate.attempts<8,'Слишком много попыток. Повтори через 15 минут.',429);
          if(!await passwordOK(data.password,this.env.PANEL_PASSWORD)){rate.attempts++;await this.ctx.storage.put(key,rate);throw new UserError('Неверный пароль.',401);}
          await this.ctx.storage.delete(key);return json({ok:true},200,{'Set-Cookie':cookie(await issueSession(this.env))});
        });this.loginQueue=run.catch(()=>{});return await run;
      }
      // Defense in depth: only signed panel sessions can invoke the Durable Object API.
      const auth=await session(request,this.env);need(auth,'Войди в панель.',401);
      if(request.method==='GET'&&u.pathname==='/api/state')return json(this.engine.state());
      need(request.method==='POST','Метод не поддерживается.',405);sameOrigin(request);need(request.headers.get('x-csrf-token')===auth.csrf,'Неверный CSRF-токен.',403);
      const data=await body(request);const op=u.pathname.slice('/api/'.length);
      if(op==='stop')return json(await this.engine.stop());
      const actions={add:'add',remove:'remove','account/login':'login','account/save':'saveLogin','account/close':'closeLogin','account/inspect':'inspect',diagnostic:'diagnostic',start:'start'};
      need(Object.hasOwn(actions,op),'Неизвестное действие.',404);
      return json(await this.engine.serial(()=>this.engine[actions[op]](data)));
    }catch(e){return json({error:publicError(e)},e instanceof UserError?e.status:500);}
  }
  async alarm(){await this.engine.serial(()=>this.engine.tick());}
}
