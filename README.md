# evo-company — 40-role bounty company

Worker (Cloudflare, free) = employer/accountant/secretary. GitHub Actions = builder. Dahl = brain.

## Setup (once)
1. Push this folder to a GitHub repo named evo-company (branch main).
2. `cd worker && npx wrangler d1 create evo-company` -> put the id in wrangler.toml
3. `npx wrangler d1 execute evo-company --remote --file=schema.sql`
4. Edit vars in wrangler.toml (DAHL_MODEL, FACTORY_REPO).
5. Secrets: `npx wrangler secret put` for DAHL_KEY, GH_TOKEN (PAT: repo + workflow scopes), TG_TOKEN, TG_CHAT, TG_SECRET (random), CB_SECRET (random)
6. `npx wrangler deploy`
7. Telegram webhook: https://api.telegram.org/bot<TOKEN>/setWebhook?url=<worker-url>/tg&secret_token=<TG_SECRET>
8. GitHub repo -> Settings: secrets GH_PAT, DAHL_KEY, CB_SECRET, WORKER_URL; variables DAHL_BASE, DAHL_MODEL.

## Telegram commands
status | sent <id> | paid <id> <usd> | rejected <id> [note]

## Notes
- The workflow creates an unprivileged `tester` user; repo tests run as that user so they cannot read your secrets.
- Workflow file must be on the default branch named `main` (the Worker dispatches ref `main`).
- Only repos with a runnable test suite are attempted. PRs are never opened automatically: you get a branch link on Telegram.
- Roles only learn from outcomes you report (`paid` / `rejected`), so evolution is slow at low volume.
