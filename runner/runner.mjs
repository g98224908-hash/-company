// Runs inside GitHub Actions. Builds a patch for one bounty issue and reports back to the Worker.
//
// SECURITY MODEL
// - Untrusted repo code (install + tests) runs as a separate OS user ("tester") with an empty env.
//   A process of the same user could read our secrets from /proc/<ppid>/environ, so a different user is required.
// - The clone is anonymous (no token in .git/config). The PAT is used only for the final push.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROLES, BUILD_ROLES } from '../worker/roles.js';

const E = process.env;
const { JOB_ID, REPO, ISSUE_URL } = E;
const MAX_TRIES = 5;
const dir = '/tmp/work';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const ME = sh('id', ['-un']).trim();
const parse = (t) => { try { return JSON.parse((t || '').match(/[\[{][\s\S]*[\]}]/)[0]); } catch { return null; } };

async function llm(system, user) {
  const body = { model: E.DAHL_MODEL, temperature: 0.2, max_tokens: 8000, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  const call = (extra) => fetch(`${E.DAHL_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${E.DAHL_KEY}` },
    body: JSON.stringify({ ...body, ...extra }),
  });
  let r = await call({ thinking: { type: 'disabled' }, chat_template_kwargs: { enable_thinking: false } });
  if (r.status === 400 || r.status === 422) r = await call({});
  if (!r.ok) throw new Error(`llm ${r.status}`);
  const m = (await r.json()).choices?.[0]?.message || {};
  return m.content || m.reasoning_content || '';
}

const callback = (body) => fetch(`${E.WORKER_URL}/callback`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-secret': E.CB_SECRET },
  body: JSON.stringify({ job_id: JOB_ID, ...body }),
});

async function fail(log, tries = 0) {
  console.log('FAIL:', log);
  try { await callback({ ok: false, log, tries }); } catch { /* worker will time the job out */ }
  process.exit(0);
}

const BUILDER = `You are one engineer who works as these specialists in order:
${BUILD_ROLES.map((r) => `- ${r}: ${ROLES[r].p}`).join('\n')}
Fix the GitHub issue. Reply with JSON only:
{"files":[{"path":"relative/path","content":"FULL new file content"}],"note":"one sentence"}
Rules: max 4 files, always full file contents, no changes under .github/, no new dependencies unless unavoidable.
If previous_test_output is given, your last attempt failed: fix the real cause.`;

function detectTests() {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('package.json')) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {};
      if (s.test && !/no test specified/.test(s.test)) return '(npm ci --ignore-scripts || npm install --ignore-scripts) && npm test';
    } catch { /* fall through */ }
  }
  if (has('pytest.ini') || has('pyproject.toml') || has('setup.py') || has('requirements.txt'))
    return 'python -m venv ~/venv && . ~/venv/bin/activate && (pip install -q -r requirements.txt || true) && (pip install -q -e . || true) && pip install -q pytest && pytest -x -q';
  if (has('go.mod')) return 'go test ./...';
  if (has('Cargo.toml')) return 'cargo test';
  return null;
}

function runTests(cmd) {
  sh('sudo', ['-n', 'chown', '-R', 'tester', dir]);
  const t = spawnSync('sudo', ['-n', '-u', 'tester', 'env', '-i', `PATH=${E.PATH}`, 'HOME=/home/tester', 'CI=true', 'bash', '-c', cmd],
    { cwd: dir, timeout: 15 * 60e3, encoding: 'utf8', maxBuffer: 1 << 26 });
  sh('sudo', ['-n', 'chown', '-R', ME, dir]);
  return t;
}

async function main() {
  // ---- 1. fork + anonymous clone
  const ghEnv = { ...E, GH_TOKEN: E.GH_PAT };
  const me = sh('gh', ['api', 'user', '-q', '.login'], { env: ghEnv }).trim();
  const name = REPO.split('/')[1];
  try { sh('gh', ['repo', 'fork', REPO, '--clone=false'], { env: ghEnv }); } catch { /* already forked */ }
  await sleep(6000);
  for (let k = 0; ; k++) {
    try { sh('git', ['clone', '--depth', '50', `https://github.com/${me}/${name}.git`, dir]); break; }
    catch (e) { if (k >= 4) throw e; await sleep(6000); }
  }
  try { sh('gh', ['repo', 'sync', `${me}/${name}`], { env: ghEnv }); sh('git', ['pull', '--ff-only'], { cwd: dir }); } catch { /* fresh fork is already current */ }
  const base = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).trim();

  // ---- 2. quality gate: only repos that have a runnable test suite
  const testCmd = detectTests();
  if (!testCmd) await fail('no test suite detected');

  // ---- 3. issue + context
  const num = ISSUE_URL.split('/').pop();
  const issue = JSON.parse(sh('gh', ['api', `repos/${REPO}/issues/${num}`], { env: ghEnv }));
  const comments = JSON.parse(sh('gh', ['api', `repos/${REPO}/issues/${num}/comments?per_page=5`], { env: ghEnv })).map((c) => c.body.slice(0, 800));
  let lessons = [];
  try { lessons = await (await fetch(`${E.WORKER_URL}/lessons`, { headers: { 'x-secret': E.CB_SECRET } })).json(); } catch { /* optional */ }

  const tree = sh('git', ['ls-files'], { cwd: dir }).split('\n').slice(0, 400);
  const pick = parse(await llm('You are the repo_analyst. Pick at most 6 files most relevant to fixing the issue. JSON only: {"files":["path"]}',
    JSON.stringify({ title: issue.title, body: (issue.body || '').slice(0, 3000), tree })));
  const ctx = {};
  let total = 0;
  for (const f of (pick?.files || []).slice(0, 6)) {
    const p = path.resolve(dir, f);
    if (!p.startsWith(dir + '/') || !fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
    const c = fs.readFileSync(p, 'utf8').slice(0, 12000);
    if ((total += c.length) > 40000) break;
    ctx[f] = c;
  }
  if (!Object.keys(ctx).length) await fail('could not find relevant files');

  // ---- 4. build / test / fix loop
  let feedback = '';
  let ok = false;
  let used = 0;
  for (let t = 1; t <= MAX_TRIES && !ok; t++) {
    used = t;
    const out = parse(await llm(BUILDER, JSON.stringify({
      issue: { title: issue.title, body: (issue.body || '').slice(0, 4000), comments },
      files: ctx, lessons, previous_test_output: feedback,
    })));
    if (!out?.files?.length) { feedback = 'Your reply was not valid JSON with a non-empty files array.'; continue; }
    sh('git', ['reset', '--hard'], { cwd: dir });
    sh('git', ['clean', '-fd'], { cwd: dir });
    for (const f of out.files.slice(0, 4)) {
      const p = path.resolve(dir, String(f.path));
      if (!p.startsWith(dir + '/') || String(f.path).startsWith('.github') || typeof f.content !== 'string') continue;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.content);
    }
    if (!sh('git', ['status', '--porcelain'], { cwd: dir }).trim()) { feedback = 'Your answer produced no file changes.'; continue; }
    const r = runTests(testCmd);
    if (r.status === 0) ok = true;
    else feedback = `${r.stdout || ''}\n${r.stderr || ''}`.slice(-4000);
  }
  if (!ok) await fail(`no passing patch after ${MAX_TRIES} tries:\n${feedback}`, MAX_TRIES);

  // ---- 5. push to the fork and report
  const branch = `fix-${num}-${JOB_ID}`;
  sh('git', ['checkout', '-b', branch], { cwd: dir });
  sh('git', ['add', '-A'], { cwd: dir });
  sh('git', ['-c', 'user.name=evo-bot', '-c', 'user.email=evo-bot@users.noreply.github.com', 'commit', '-m', `Fix #${num}: ${issue.title}`.slice(0, 200)], { cwd: dir });
  sh('git', ['push', `https://x-access-token:${E.GH_PAT}@github.com/${me}/${name}.git`, branch], { cwd: dir });
  const diff = sh('git', ['show', '-p', 'HEAD'], { cwd: dir });
  await callback({ ok: true, tries: used, diff, compare_url: `https://github.com/${REPO}/compare/${base}...${me}:${branch}` });
  console.log('done');
}

main().catch((e) => fail(String(e?.message || e).slice(0, 1500)));
