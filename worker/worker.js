import { ROLES, PANELS } from './roles.js';

// ---------- helpers (archivist) ----------
const now = () => new Date().toISOString();
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const run = (env, s, ...b) => env.DB.prepare(s).bind(...b).run();
const all = async (env, s, ...b) => (await env.DB.prepare(s).bind(...b).all()).results;
const one = async (env, s, ...b) => (await all(env, s, ...b))[0];
const parse = (t) => {
  const m = (t || '').match(/[\[{][\s\S]*[\]}]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
};
const ghHeaders = (env) => ({
  authorization: `Bearer ${env.GH_TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'evo-company',
});

// ---------- secretary ----------
async function tg(env, text) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return;
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT, text: text.slice(0, 4000), disable_web_page_preview: true }),
  });
}

// ---------- LLM (Dahl, OpenAI-compatible chat/completions assumed) ----------
async function llm(env, system, user) {
  const r = await fetch(`${env.DAHL_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.DAHL_KEY}` },
    body: JSON.stringify({
      model: env.DAHL_MODEL,
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`llm ${r.status}`);
  const d = await r.json();
  await run(env, `INSERT INTO ledger(ts,kind,amount,note) VALUES(?,?,?,?)`, now(), 'tokens', d.usage?.total_tokens ?? 0, '');
  return d.choices?.[0]?.message?.content ?? '';
}

// ---------- panel: many roles judge in ONE llm call ----------
async function panel(env, name, task, items) {
  const ids = PANELS[name];
  const rows = await all(env, `SELECT id,votes,hits FROM roles WHERE active=1 AND id IN (${ids.map(() => '?').join()})`, ...ids);
  const sys = `You are a panel of independent specialists. Judge every item ONLY from your own role. Be skeptical: most items deserve low scores.
Reply with JSON only: {"<item id>":{"<role id>":{"s":0-10,"n":"max 12 words"}}}
Task: ${task}
Roles:
${rows.map((r) => `- ${r.id}: ${ROLES[r.id].p}`).join('\n')}`;
  const out = parse(await llm(env, sys, JSON.stringify(items))) || {};
  const res = {};
  for (const it of items) {
    const v = out[it.id] || {};
    let sum = 0, w = 0, veto = false;
    const raw = {};
    for (const r of rows) {
      const s = Number(v[r.id]?.s);
      if (Number.isNaN(s)) continue;
      raw[r.id] = s;
      const wt = ((r.hits + 1) / (r.votes + 2)) * 2; // accuracy-weighted vote
      sum += s * wt; w += wt;
      if (ROLES[r.id].v && s < ROLES[r.id].v) veto = true;
    }
    res[it.id] = { score: w ? sum / w : 0, veto, raw };
  }
  return res;
}

async function mergeVerdicts(env, id, raw) {
  const j = await one(env, `SELECT verdicts FROM jobs WHERE id=?`, id);
  const merged = { ...JSON.parse(j?.verdicts || '{}'), ...raw };
  await run(env, `UPDATE jobs SET verdicts=? WHERE id=?`, JSON.stringify(merged), id);
}

const setStatus = (env, id, status, extra = null) =>
  run(env, `UPDATE jobs SET status=?, result=COALESCE(?,result), updated_at=? WHERE id=?`, status, extra, now(), id);

// ---------- scout ----------
async function scout(env) {
  const cutoff = new Date(Date.now() - num(env.MIN_AGE_DAYS, 14) * 864e5).toISOString().slice(0, 10);
  const base = env.BOUNTY_QUERY || 'label:"💎 Bounty" is:issue is:open no:assignee';
  const url = `https://api.github.com/search/issues?per_page=30&sort=created&order=desc&q=${encodeURIComponent(`${base} created:<${cutoff}`)}`;
  const r = await fetch(url, { headers: ghHeaders(env) });
  if (!r.ok) throw new Error(`github search ${r.status}`);
  const { items = [] } = await r.json();
  if (!items.length) return 0;
  const known = new Set((await all(env, `SELECT url FROM jobs WHERE url IN (${items.map(() => '?').join()})`,
    ...items.map((i) => i.html_url))).map((x) => x.url));
  const DOLLAR = /\$\s?(\d[\d,]*)/;
  let lookups = 0;
  const stmts = [];
  for (const i of items.filter((x) => !known.has(x.html_url))) {
    // Algora puts the amount in a bot comment ("💎 $50 bounty"), usually not in the title.
    let m = `${i.title} ${i.labels.map((l) => l.name).join(' ')}`.match(DOLLAR);
    if (!m && lookups < 12) { // stay far below the 50-subrequest limit
      lookups++;
      const c = await fetch(`${i.comments_url}?per_page=5`, { headers: ghHeaders(env) });
      if (c.ok) m = (await c.json()).map((x) => x.body || '').join('\n').match(DOLLAR);
    }
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO jobs(url,repo,title,body,amount,created_gh,comments,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'found',?,?)`
    ).bind(i.html_url, i.repository_url.split('/repos/')[1], i.title, (i.body || '').slice(0, 1500),
      m ? Number(m[1].replace(/,/g, '')) : 0, i.created_at, i.comments, now(), now()));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

const brief = (j, extra = {}) => ({
  id: String(j.id), repo: j.repo, title: j.title, amount_usd: j.amount,
  age_days: Math.round((Date.now() - Date.parse(j.created_gh)) / 864e5),
  comments: j.comments, body: (j.body || '').slice(0, 600), ...extra,
});

// ---------- intel panel ----------
async function vet(env) {
  const jobs = await all(env, `SELECT * FROM jobs WHERE status='found' LIMIT 8`);
  if (!jobs.length) return false;
  const res = await panel(env, 'intel',
    'Can an AI coding agent with a sandbox that runs tests realistically win this open-source bounty? Penalize honeypot signs, unclear payout, many competitors, huge scope, dead maintainers.',
    jobs.map((j) => brief(j)));
  for (const j of jobs) {
    const p = res[String(j.id)];
    const ok = !p.veto && p.score >= 6 && j.amount > 0;
    await mergeVerdicts(env, j.id, p.raw);
    await run(env, `UPDATE jobs SET status=?,score=?,updated_at=? WHERE id=?`, ok ? 'vetted' : 'dropped', p.score, now(), j.id);
  }
  return true;
}

// ---------- strategy panel (CEO) ----------
async function choose(env) {
  const jobs = await all(env, `SELECT * FROM jobs WHERE status='vetted' ORDER BY score DESC LIMIT 5`);
  if (!jobs.length) return false;
  const res = await panel(env, 'strategy',
    'Which job is worth spending automated compute on right now? Score each job independently.',
    jobs.map((j) => brief(j, { vet_score: j.score })));
  let best = null;
  for (const j of jobs) {
    const p = res[String(j.id)];
    await mergeVerdicts(env, j.id, p.raw);
    const ev = p.veto ? 0 : j.amount * (p.score / 10) * num(env.BASE_P, 0.25);
    if (ev < num(env.MIN_EV, 3)) await setStatus(env, j.id, 'dropped', 'low expected value');
    else if (!best || ev > best.ev) best = { j, ev };
  }
  if (best) await setStatus(env, best.j.id, 'chosen');
  return true;
}

// ---------- dispatch to GitHub Actions (rate_limiter: one at a time) ----------
async function dispatch(env) {
  if (await one(env, `SELECT id FROM jobs WHERE status='dispatched'`)) return false;
  const j = await one(env, `SELECT * FROM jobs WHERE status='chosen' LIMIT 1`);
  if (!j) return false;
  const r = await fetch(`https://api.github.com/repos/${env.FACTORY_REPO}/actions/workflows/worker.yml/dispatches`, {
    method: 'POST', headers: ghHeaders(env),
    body: JSON.stringify({ ref: 'main', inputs: { job_id: String(j.id), repo: j.repo, issue_url: j.url } }),
  });
  if (!r.ok) throw new Error(`dispatch ${r.status}`);
  await setStatus(env, j.id, 'dispatched');
  await tg(env, `🛠 Job #${j.id} started ($${j.amount})\n${j.repo}\n${j.title}`);
  return true;
}

// ---------- quality panel ----------
async function review(env) {
  const j = await one(env, `SELECT * FROM jobs WHERE status='built' LIMIT 1`);
  if (!j) return false;
  const res = JSON.parse(j.result || '{}');
  const p = (await panel(env, 'quality', 'Review this AI-written patch for the issue. Judge strictly.',
    [{ id: String(j.id), issue: j.title, body: (j.body || '').slice(0, 500), diff: (res.diff || '').slice(0, 7000) }]))[String(j.id)];
  await mergeVerdicts(env, j.id, p.raw);
  if (p.veto || p.score < 7) {
    await setStatus(env, j.id, 'dropped', JSON.stringify({ ...res, why: `review ${p.score.toFixed(1)}` }));
    await tg(env, `🗑 Job #${j.id} rejected by inspectors (${p.score.toFixed(1)}).`);
  } else {
    await setStatus(env, j.id, 'ready');
    await tg(env, `✅ Job #${j.id} READY ($${j.amount}, quality ${p.score.toFixed(1)})\nIssue: ${j.url}\nBranch: ${res.compare}\n\nOpen the PR yourself (read the bounty rules first). After that:\nsent ${j.id}\nWhen paid: paid ${j.id} <amount>\nIf rejected: rejected ${j.id}`);
  }
  return true;
}

// ---------- evolution ----------
async function evolve(env, job, won) {
  for (const [role, s] of Object.entries(JSON.parse(job.verdicts || '{}'))) {
    const hit = (Number(s) >= 6) === won ? 1 : 0;
    await run(env, `UPDATE roles SET votes=votes+1, hits=hits+? WHERE id=?`, hit, role);
  }
  const vetoIds = Object.keys(ROLES).filter((r) => ROLES[r].v);
  await run(env, `UPDATE roles SET active=0 WHERE votes>=15 AND hits*1.0/votes<0.4 AND id NOT IN (${vetoIds.map(() => '?').join()})`, ...vetoIds);
}

async function autopsy(env, job, note) {
  const t = await llm(env,
    'You are a coroner for failed open-source bounty attempts. In at most 2 sentences give ONE concrete reusable lesson for the next attempt.',
    JSON.stringify({ repo: job.repo, title: job.title, result: (job.result || '').slice(0, 3000), note }));
  await run(env, `INSERT INTO lessons(ts,text) VALUES(?,?)`, now(), t.slice(0, 400));
}

// ---------- cashier / Telegram commands ----------
async function command(env, text) {
  const [c0, a, b] = text.trim().split(/\s+/);
  const cmd = c0.replace(/^\//, '').replace(/@.*$/, '').toLowerCase();
  if (cmd === 'status') return report(env);
  const job = Number.isInteger(Number(a)) && a ? await one(env, `SELECT * FROM jobs WHERE id=?`, Number(a)) : null;
  if (!job) return 'Commands: status | sent <id> | paid <id> <usd> | rejected <id> [note]';
  if (cmd === 'sent') { await setStatus(env, job.id, 'submitted'); return `Job ${job.id}: submitted ✔`; }
  if (cmd === 'paid') {
    await run(env, `INSERT INTO ledger(ts,kind,amount,note) VALUES(?,?,?,?)`, now(), 'income', Number(b) || job.amount, `job ${job.id}`);
    await setStatus(env, job.id, 'paid'); await evolve(env, job, true);
    return `💰 Job ${job.id} paid. Roles that predicted it were rewarded.`;
  }
  if (cmd === 'rejected') {
    await setStatus(env, job.id, 'rejected'); await evolve(env, job, false);
    await autopsy(env, job, text.split(/\s+/).slice(2).join(' '));
    return `Job ${job.id} rejected. The coroner wrote a lesson.`;
  }
  return 'Unknown command.';
}

// ---------- forecaster / daily report ----------
async function report(env) {
  const m = now().slice(0, 7);
  const inc = await one(env, `SELECT COALESCE(SUM(amount),0) a FROM ledger WHERE kind='income' AND ts LIKE ?`, `${m}%`);
  const tok = await one(env, `SELECT COALESCE(SUM(amount),0) a FROM ledger WHERE kind='tokens' AND ts LIKE ?`, `${m}%`);
  const st = await all(env, `SELECT status, COUNT(*) n FROM jobs GROUP BY status`);
  const bench = await all(env, `SELECT id FROM roles WHERE active=0`);
  return `📊 ${m}\nIncome: $${inc.a} / $${env.MONTHLY_TARGET}\nTokens: ${tok.a}\nJobs: ${st.map((s) => `${s.status}=${s.n}`).join(' ') || '-'}\nBenched roles: ${bench.map((b) => b.id).join(', ') || 'none'}`;
}

// ---------- the heartbeat ----------
async function tick(env) {
  await env.DB.batch(Object.keys(ROLES).map((id) => env.DB.prepare(`INSERT OR IGNORE INTO roles(id) VALUES(?)`).bind(id)));
  await run(env, `UPDATE jobs SET status='dropped',result='runner timeout',updated_at=? WHERE status='dispatched' AND updated_at<?`,
    now(), new Date(Date.now() - 3 * 36e5).toISOString());
  const t = await one(env, `SELECT COALESCE(SUM(amount),0) a FROM ledger WHERE kind='tokens' AND ts LIKE ?`, `${now().slice(0, 10)}%`);
  if (t.a > num(env.TOKEN_CAP, 2e6)) return;
  if (await review(env)) return;
  if (await dispatch(env)) return;
  if (await choose(env)) return;
  if (await vet(env)) return;
  await scout(env);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        if (event.cron === '0 15 * * *') await tg(env, await report(env));
        else await tick(env);
      } catch (e) { await tg(env, `⚠️ ${e.message}`); }
    })());
  },

  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === '/tg' && req.method === 'POST') {
      if (req.headers.get('x-telegram-bot-api-secret-token') !== env.TG_SECRET) return new Response('no', { status: 403 });
      const m = (await req.json()).message;
      if (m?.text && String(m.chat.id) === String(env.TG_CHAT)) await tg(env, await command(env, m.text));
      return new Response('ok');
    }
    if (req.headers.get('x-secret') !== env.CB_SECRET) return new Response('no', { status: 403 });
    if (u.pathname === '/lessons') {
      const rows = await all(env, `SELECT text FROM lessons ORDER BY id DESC LIMIT 5`);
      return Response.json(rows.map((r) => r.text));
    }
    if (u.pathname === '/callback' && req.method === 'POST') {
      const b = await req.json();
      const j = await one(env, `SELECT * FROM jobs WHERE id=?`, Number(b.job_id));
      if (!j) return new Response('404', { status: 404 });
      if (b.ok) await setStatus(env, j.id, 'built', JSON.stringify({ compare: b.compare_url, diff: (b.diff || '').slice(0, 8000), tries: b.tries }));
      else await setStatus(env, j.id, 'dropped', JSON.stringify({ log: (b.log || '').slice(0, 3000), tries: b.tries }));
      return new Response('ok');
    }
    return new Response('evo-company alive');
  },
};
