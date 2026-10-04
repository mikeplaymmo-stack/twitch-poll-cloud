import { UserError, need } from './core.js';
const te = new TextEncoder();
const td = new TextDecoder();
export const b64 = a => {
  const bytes=new Uint8Array(a);let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(text).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
};
export const unb64 = s => Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')), x => x.charCodeAt(0));
const hmac = key => crypto.subtle.importKey('raw', te.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign','verify']);
async function aes(secret) {
  need(typeof secret === 'string' && /^[a-f0-9]{64}$/i.test(secret), 'Добавь SESSION_KEY: 64 шестнадцатеричных символа в Secrets Cloudflare.', 503);
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g), h => parseInt(h,16)), 'AES-GCM', false, ['encrypt','decrypt']);
}
export async function seal(value, secret, login) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = te.encode(JSON.stringify(value));
  need(bytes.length <= 80000, 'Сессия слишком большая для сохранения.');
  const data = await crypto.subtle.encrypt({ name:'AES-GCM', iv, additionalData:te.encode(login) }, await aes(secret), bytes);
  return { version:1, iv:b64(iv), data:b64(data) };
}
export async function unseal(value, secret, login) {
  try { return JSON.parse(td.decode(await crypto.subtle.decrypt({ name:'AES-GCM', iv:unb64(value.iv), additionalData:te.encode(login) }, await aes(secret), unb64(value.data)))); }
  catch { throw new UserError('Не удалось открыть сохранённую сессию. Проверь SESSION_KEY или выполни вход заново.'); }
}
export async function passwordOK(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected.length < 16 || given.length > 256) return false;
  const k = await hmac('panel-password-comparison');
  const signature = await crypto.subtle.sign('HMAC', k, te.encode(expected));
  return crypto.subtle.verify('HMAC', k, signature, te.encode(given));
}
export async function issueSession(env) {
  const payload = b64(te.encode(JSON.stringify({ exp:Date.now()+12*60*60*1000, csrf:b64(crypto.getRandomValues(new Uint8Array(24))) })));
  const sig = b64(await crypto.subtle.sign('HMAC', await hmac(env.SESSION_KEY + env.PANEL_PASSWORD), te.encode(payload)));
  return `${payload}.${sig}`;
}
export async function session(request, env) {
  try {
    const token = request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-panel='))?.slice(13);
    const parts = token?.split('.'); if (parts?.length !== 2) return null;
    const [data,sig] = parts;
    if (!await crypto.subtle.verify('HMAC', await hmac(env.SESSION_KEY+env.PANEL_PASSWORD), unb64(sig), te.encode(data))) return null;
    const p=JSON.parse(td.decode(unb64(data))); return p.exp>Date.now() && typeof p.csrf === 'string' ? p : null;
  } catch { return null; }
}
export function sameOrigin(request) {
  need(request.headers.get('origin') === new URL(request.url).origin, 'Запрос с другого сайта запрещён.', 403);
}
export async function body(request) {
  need((request.headers.get('content-type') || '').startsWith('application/json'), 'Нужен JSON.', 415);
  need(Number(request.headers.get('content-length') || 0) <= 16384, 'Слишком большой запрос.', 413);
  const reader = request.body?.getReader(); need(reader, 'Пустой запрос.');
  const chunks=[]; let n=0;
  for (;;) { const {value,done}=await reader.read(); if(done)break; n+=value.length; if(n>16384){await reader.cancel();throw new UserError('Слишком большой запрос.',413);}chunks.push(value); }
  const bytes=new Uint8Array(n);let p=0;for(const chunk of chunks){bytes.set(chunk,p);p+=chunk.length;}
  try { const data=JSON.parse(td.decode(bytes));need(data && typeof data==='object' && !Array.isArray(data),'Нужен объект JSON.');return data; } catch(e) {if(e instanceof UserError)throw e;throw new UserError('Некорректный JSON.');}
}
