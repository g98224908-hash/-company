// 40 roles. d=department, k=kind:
//   panel = judges inside an LLM panel call
//   build = prompt injected into the GitHub Actions builder
//   code  = plain code module (no LLM)
// v = veto threshold: the role kills a job by scoring below it.
export const ROLES = {
  // ---- INTEL (8)
  scout:            { d: 'intel', k: 'code', p: 'Finds candidate bounties through GitHub search.' },
  age_analyst:      { d: 'intel', k: 'panel', p: 'Judge staleness: bounties open 2-8 weeks with no winner are best; brand new (crowded) or years old (abandoned) are bad.' },
  competition:      { d: 'intel', k: 'panel', p: 'Judge competition: comments, "I am working on this", linked PRs. Many competitors = low score.' },
  trap_detector:    { d: 'intel', k: 'panel', v: 3, p: 'Detect honeypot/scam bounties: vague payout, no real maintainer, token rewards, brand-new repo, spammy text. Score 0-2 if suspicious.' },
  payout_verifier:  { d: 'intel', k: 'panel', p: 'Judge payout credibility: named platform (Algora, TaskBounty, Sponsors), stated amount, clear terms.' },
  maintainer_pulse: { d: 'intel', k: 'panel', p: 'Judge whether maintainers look alive and merge community PRs, from the info given.' },
  scope_estimator:  { d: 'intel', k: 'panel', p: 'Judge scope: small, well-defined, testable fix = high; vague, huge or design-heavy = low.' },
  lang_fit:         { d: 'intel', k: 'panel', p: 'Judge whether an LLM agent can solve it in a mainstream language (JS/TS/Python/Go/Rust) without special hardware.' },
  // ---- STRATEGY (5)
  ceo:              { d: 'strategy', k: 'panel', p: 'CEO: is this the best use of limited compute right now? Think expected profit.' },
  roi_analyst:      { d: 'strategy', k: 'panel', p: 'ROI: payout vs likely effort and merge probability. Low payout for high effort = low score.' },
  scheduler:        { d: 'strategy', k: 'panel', p: 'Scheduler: can this finish in one automated run (<40 min)? Long or multi-step = low score.' },
  portfolio:        { d: 'strategy', k: 'panel', p: 'Portfolio: favor variety of repos/languages and avoid repeating a recent failure pattern.' },
  devils_advocate:  { d: 'strategy', k: 'panel', p: "Devil's advocate: find the single strongest reason this will fail and score accordingly." },
  // ---- PRODUCTION (8)
  repo_analyst:     { d: 'production', k: 'build', p: 'Repo analyst: find the few files that really matter for the issue.' },
  architect:        { d: 'production', k: 'build', p: 'Solution architect: pick the smallest correct change that satisfies the issue.' },
  coder:            { d: 'production', k: 'build', p: 'Coder: write complete, idiomatic code that matches the project style.' },
  test_writer:      { d: 'production', k: 'build', p: 'Test writer: add or update a test proving the fix when the project has a test suite.' },
  debugger:         { d: 'production', k: 'build', p: 'Debugger: read failing test output carefully and fix the real cause, not the symptom.' },
  minimalist:       { d: 'production', k: 'build', p: 'Minimalist: touch as few files and lines as possible; never refactor unrelated code.' },
  doc_writer:       { d: 'production', k: 'build', p: 'Doc writer: update docs/changelog only if the project clearly expects it.' },
  localizer:        { d: 'production', k: 'build', p: 'Localizer: for i18n/translation issues keep terminology consistent with existing strings.' },
  // ---- QUALITY (6)
  code_reviewer:    { d: 'quality', k: 'panel', p: 'Code reviewer: correctness, edge cases; does the diff really solve the issue?' },
  security_reviewer:{ d: 'quality', k: 'panel', v: 4, p: 'Security reviewer: secrets, network calls, obfuscation, dependency changes, backdoors? Score 0-3 if anything is suspicious.' },
  license_checker:  { d: 'quality', k: 'panel', p: 'License checker: any copied code or license problems?' },
  style_checker:    { d: 'quality', k: 'panel', p: 'Style checker: formatting and naming consistent with surrounding code?' },
  pr_size_judge:    { d: 'quality', k: 'panel', p: 'PR size judge: small focused diffs score high; sprawling diffs score low.' },
  final_inspector:  { d: 'quality', k: 'panel', v: 6, p: 'Final inspector with veto: would a maintainer merge this without complaint? Be strict.' },
  // ---- FINANCE (4)
  accountant:       { d: 'finance', k: 'code', p: 'Records income and token usage in the ledger.' },
  token_auditor:    { d: 'finance', k: 'code', p: 'Enforces the daily token cap.' },
  cashier:          { d: 'finance', k: 'code', p: 'Records payouts from Telegram commands.' },
  forecaster:       { d: 'finance', k: 'code', p: 'Reports month-to-date income against the monthly target.' },
  // ---- OPS (5)
  secretary:        { d: 'ops', k: 'code', p: 'Sends Telegram notifications and the daily report.' },
  monitor:          { d: 'ops', k: 'code', p: 'Catches errors and reports them to Telegram.' },
  archivist:        { d: 'ops', k: 'code', p: 'Stores jobs, verdicts and results in D1.' },
  timekeeper:       { d: 'ops', k: 'code', p: 'Times out stuck runner jobs after 3 hours.' },
  rate_limiter:     { d: 'ops', k: 'code', p: 'Allows only one active runner job at a time.' },
  // ---- EVOLUTION (4)
  coroner:          { d: 'evolution', k: 'code', p: 'Writes a lesson after each rejected attempt (one LLM call).' },
  prompt_smith:     { d: 'evolution', k: 'code', p: 'Feeds the latest lessons into the builder prompt.' },
  experimenter:     { d: 'evolution', k: 'code', p: 'Tracks every verdict against the real outcome.' },
  hr_chief:         { d: 'evolution', k: 'code', p: 'Benches panel roles whose predictions keep failing (never veto roles).' },
};

export const PANELS = {
  intel: ['age_analyst', 'competition', 'trap_detector', 'payout_verifier', 'maintainer_pulse', 'scope_estimator', 'lang_fit'],
  strategy: ['ceo', 'roi_analyst', 'scheduler', 'portfolio', 'devils_advocate'],
  quality: ['code_reviewer', 'security_reviewer', 'license_checker', 'style_checker', 'pr_size_judge', 'final_inspector'],
};

export const BUILD_ROLES = Object.keys(ROLES).filter((r) => ROLES[r].k === 'build');
