export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const need = (condition, message, status = 400) => { if (!condition) throw new UserError(message, status); };
export const now = () => Date.now();
export const active = job => ['watching', 'voting'].includes(job?.status);
export async function fingerprint(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join(''); }
export function loginOf(value) {
  const s = String(value || '').trim().replace(/^@/, '').toLowerCase();
  need(/^[a-z0-9_]{1,25}$/.test(s), 'Нужен логин Twitch: латинские буквы, цифры или _.');
  return s;
}
export function number(value, min, max, name) {
  const n = Number(value);
  need(Number.isFinite(n) && n >= min && n <= max, `${name}: от ${min} до ${max}.`);
  return n;
}
export function random() { return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296; }
export function shuffle(values, rng = random) {
  const a = [...values];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// Largest-remainder allocation: exact number of participating accounts, no lost votes.
export function allocate(total, weights, rng = random) {
  const exact = weights.map(w => total * w / 100);
  const counts = exact.map(Math.floor);
  const ranked = shuffle(exact.map((n, i) => ({ i, remainder: n - counts[i] })), rng)
    .sort((a, b) => b.remainder - a.remainder);
  for (let i = 0, left = total - counts.reduce((a, b) => a + b, 0); i < left; i++) counts[ranked[i].i]++;
  return counts;
}
export function settings(input, verified) {
  need(Array.isArray(input.logins) && input.logins.length > 0 && input.logins.length <= 50, 'Выбери от 1 до 50 аккаунтов.');
  const logins = [...new Set(input.logins.map(loginOf))];
  need(logins.every(l => verified.includes(l)), 'Сначала выполни и сохрани вход для всех выбранных аккаунтов.');
  const weights = input.weights;
  need(Array.isArray(weights) && weights.length >= 2 && weights.length <= 5, 'Нужно от 2 до 5 вариантов ответа.');
  const parsed = weights.map(w => number(w, 0, 100, 'Процент'));
  need(Math.abs(parsed.reduce((a, b) => a + b, 0) - 100) < 0.00001, 'Сумма процентов должна быть 100.');
  const participation = number(input.participation ?? 100, 1, 100, 'Доля участников');
  const count = Math.round(logins.length * participation / 100);
  need(count > 0, 'При такой доле получается 0 аккаунтов. Увеличь долю.');
  const labels = Array.isArray(input.labels) ? input.labels.map(v => String(v || '').trim().slice(0, 200)) : [];
  need(!labels.length || labels.length === parsed.length, 'Количество подписей должно совпадать с вариантами.');
  return { channel: loginOf(input.channel), logins, weights: parsed, labels, participation, count,
    concurrency: Math.floor(number(input.concurrency ?? 2, 1, 3, 'Одновременно активных аккаунтов')),
    maxMinutes: number(input.maxMinutes ?? 5, 1, 240, 'Лимит работы в минутах'),
    voteSeconds: number(input.voteSeconds ?? 60, 10, 180, 'Время очереди в секундах'),
    current: input.current === true, repeat: input.repeat === true,
    title: String(input.title || '').trim().slice(0, 200) };
}
export function makeRows(config, choices, rng = random) {
  need(choices.length === config.weights.length, 'Количество вариантов в опросе не совпало с настройкой.');
  need(choices.every(v=>typeof v==='string'&&v.length>0&&v.length<=200),'Не удалось надёжно распознать текст вариантов.');
  const norm = s => String(s).normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
  if (config.labels.some(Boolean)) need(config.labels.every((v, i) => !v || norm(v) === norm(choices[i])), 'Подписи вариантов не совпали. Голосование пропущено.');
  const selected = shuffle(config.logins, rng).slice(0, config.count);
  const counts = allocate(selected.length, config.weights, rng);
  const answers = shuffle(counts.flatMap((n, i) => Array(n).fill(i)), rng);
  return selected.map((login, i) => ({ login, choice: answers[i], answer: choices[answers[i]], status: 'queued', message: 'В очереди' }));
}
export function recoverJob(job) {
  if (!active(job)) return job;
  return { ...job, status: 'interrupted', message: 'Облачный обработчик перезапустился. Автоповтор голосов отключён.',
    finishedAt: now(), rows: (job.rows || []).map(r => ({ ...r,
      status: r.status === 'sending' ? 'uncertain' : ['queued','preparing'].includes(r.status) ? 'skipped' : r.status,
      message: r.status === 'sending' ? 'Отправка могла завершиться. Повторять автоматически нельзя.' : ['queued','preparing'].includes(r.status) ? 'Перезапуск обработчика.' : r.message })) };
}
export function publicError(error) {
  return error instanceof UserError ? error.message : 'Облачный браузер не ответил. Проверь Browser Run в Cloudflare и повтори проверку входа.';
}
