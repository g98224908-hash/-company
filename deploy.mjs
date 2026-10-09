import fs from 'node:fs';

const S = {};
for (const l of fs.readFileSync('.secrets', 'utf8').split('\n')) {
  const m = l.match(/^(\w+)='(.*)'$/);
  if (m) S[m[1]] = m[2];
}
const need = ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'D1_ID', 'DAHL_KEY', 'DAHL_BASE', 'DAHL_MODEL', 'GH_TOKEN', 'TG_TOKEN', 'TG_CHAT', 'FACTORY_REPO', 'CB_SECRET', 'TG_SECRET'];
const miss = need.filter((k) => !S[k]);
if (miss.length) { console.log('خالی:', miss.join(' ')); process.exit(1); }

const NAME = 'evo-company';
const api = `https://api.cloudflare.com/client/v4/accounts/${S.CF_ACCOUNT_ID}/workers`;
const H = { authorization: `Bearer ${S.CF_API_TOKEN}` };
const cf = async (path, method, body) => {
  const r = await fetch(api + path, { method, headers: body instanceof FormData ? H : { ...H, 'content-type': 'application/json' }, body: body instanceof FormData ? body : body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.success) { console.log(`خطا در ${method} ${path}:`, JSON.stringify(j.errors || r.status)); process.exit(1); }
  return j.result;
};

const plain = { DAHL_BASE: S.DAHL_BASE, DAHL_MODEL: S.DAHL_MODEL, FACTORY_REPO: S.FACTORY_REPO, TG_CHAT: S.TG_CHAT, MONTHLY_TARGET: '50', MIN_AGE_DAYS: '14', MIN_EV: '3', BASE_P: '0.25', TOKEN_CAP: '2000000' };
const secret = { DAHL_KEY: S.DAHL_KEY, GH_TOKEN: S.GH_TOKEN, TG_TOKEN: S.TG_TOKEN, TG_SECRET: S.TG_SECRET, CB_SECRET: S.CB_SECRET };
const meta = {
  main_module: 'worker.js',
  compatibility_date: '2026-01-01',
  bindings: [
    { type: 'd1', name: 'DB', id: S.D1_ID },
    ...Object.entries(plain).map(([name, text]) => ({ type: 'plain_text', name, text })),
    ...Object.entries(secret).map(([name, text]) => ({ type: 'secret_text', name, text })),
  ],
};
const form = new FormData();
form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
form.append('worker.js', new Blob([fs.readFileSync('worker-single.js', 'utf8')], { type: 'application/javascript+module' }), 'worker.js');

await cf(`/scripts/${NAME}`, 'PUT', form);
console.log('1) کد آپلود شد');
await cf(`/scripts/${NAME}/schedules`, 'PUT', [{ cron: '*/2 * * * *' }, { cron: '0 15 * * *' }]);
console.log('2) زمان‌بندی تنظیم شد');
await cf(`/scripts/${NAME}/subdomain`, 'POST', { enabled: true });
const sub = (await cf('/subdomain', 'GET')).subdomain;
const url = `https://${NAME}.${sub}.workers.dev`;
console.log('3) آدرس Worker:', url);

const w = await fetch(url, { headers: { 'x-secret': S.CB_SECRET } }).then((r) => r.text()).catch((e) => 'خطا ' + e.message);
console.log('4) تست Worker:', w.slice(0, 60));

const t = await fetch(`https://api.telegram.org/bot${S.TG_TOKEN}/setWebhook`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: `${url}/tg`, secret_token: S.TG_SECRET }),
}).then((r) => r.json()).catch((e) => ({ ok: false, description: e.message }));
console.log('5) وب‌هوک تلگرام:', t.ok ? 'وصل شد' : 'خطا: ' + t.description);
console.log('\nاین آدرس رو نگه دارید (WORKER_URL):', url);
