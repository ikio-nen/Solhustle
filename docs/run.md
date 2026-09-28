# Run doc — Solhustle (Solana escrow freelance marketplace)

The app lives in this thread's workspace — `D:\kaizo\.freebuff`.

Layout:

| Path | What lives there |
| --- | --- |
| `client/` | The frontend — static HTML, CSS, JS and `vendor/`. Previously `public/`. |
| `server/` | The backend — Express + TypeScript. Previously `src/`. |
| `server/tests/` | Tests, next to the code they cover. Previously `tests/`. |
| `docs/` | README, decision records and this run doc. |
| `data/`, `keys/` | Runtime state, gitignored, created on first run. |

`package.json`, `tsconfig.json`, the lockfiles and `.env` stay at the root on purpose — npm/pnpm/Node/tsc all resolve them from the package root, so moving them into a `config/` folder would break tooling for no navigation gain.

The backend serves the frontend itself: static `client/` (directory index disabled) + `/` → `client/landing.html`.
The old dev panel is retired: `/index.html` 301-redirects to `/`, alongside the other legacy `.html` paths.
Other pages: `/login` + `/signup` (hosted-auth entry point), `/app` (the single signed-in shell — every
screen inside it is a hash route, listed in `docs/how-to-run.md`), `/browse` (public freelancer
directory), `/freelancer/<id>` (public profile) and `/operator` (staff console). The old portal paths
(`/buyer`, `/seller`, `/admin`, `/talent`, `/dashboard`, `/messages`, `/me`, `*.html`) are 301s into
the shell.

> **Starting from scratch, or configuring `.env` and Auth0?** Read `docs/how-to-run.md` first — this
document is the agent/CI runbook and assumes the workspace is already set up.

### `/login` is hosted-Auth0-first

Auth0 Universal Login is the front door. `GET /meta/auth` decides what the page renders:

- `auth0.configured: true` (i.e. `AUTH0_ISSUER_BASE_URL` + `AUTH0_CLIENT_ID` + `AUTH0_CLIENT_SECRET` all set)
  → one lime **Continue with Auth0** button that 302s to `https://<tenant>/authorize` (PKCE `S256`, HttpOnly state cookie).
- `auth0.configured: false` → a notice naming the three env vars and the callback URL that must be whitelisted.

The seeded demo personas and the email/password form are an *escape hatch*, not a front door: they live behind a
collapsed **Use local demo sign-in →** link, and the link disappears once Auth0 is configured. Deep links
(`?mode=signup|admin|forgot|reset`) or `?demo=1` open it directly.

## Reproduce the artifacts (fresh checkout)

> **Comparing against the primary checkout.** This thread's workspace is a separate clone that can lag
> the primary checkout at `D:\backend` (different `origin`, different commit). When files here are missing
> recent work, sync the sources across (procedure only — never copy secret *values* into docs and never
> symlink, since ports/paths differ per worktree):
>
>     cp -f D:/backend/server/*.ts server/ && cp -f D:/backend/server/tests/*.ts server/tests/ && cp -f D:/backend/client/*.html D:/backend/client/*.js D:/backend/client/*.css client/ && cp -f D:/backend/docs/* docs/ && cp -f D:/backend/package.json D:/backend/tsconfig.json D:/backend/pnpm-lock.yaml D:/backend/.env .
>
> then restart the server.

1. `cd D:\kaizo\.freebuff` (this thread's workspace)
2. Install dependencies with the project's package manager:
   - `corepack pnpm install` (pnpm 12.6.0 via corepack)
   - Plain `npm` is broken on this machine (its bundled `minipass-flush` package is corrupt), so use `corepack pnpm` for install/test/run.
   - A Windows-incompatible `postinstall` was removed from `package.json` for the same reason.
   - Note: the `npm` in the agent's PATH is `D:\nodejs\npm` (npm 11.16.0); prefer `corepack pnpm` so the lockfile is honored.
3. Copy `.env` from the main checkout into this workspace (it already lives here as `.env` after a fresh copy, but confirm it is present — see below). No `.env.local` exists in the main checkout to copy.
   - Required `.env` keys: `PORT=8787`, `JWT_SECRET`, `CHAIN=devnet`, `DATABASE_URL` (Neon PostgreSQL).
   - Auth hardening keys (see `.env.example`): `JWT_SECRET` must be random and ≥32 chars — the app refuses to
     boot with the dev default when `NODE_ENV=production`; `ADMIN_SETUP_SECRET` gates `POST /auth/admin-signup`
     (disabled entirely in production when unset). Optional: `REQUIRE_EMAIL_VERIFICATION`, `EXPOSE_DEMO_SECRET_KEYS`,
     `SEED_DEMO_ACCOUNTS`, `ACCESS_TOKEN_TTL`, `LOCKOUT_THRESHOLD`/`LOCKOUT_MINUTES`, `CORS_ORIGIN`, `APP_ORIGIN`.
   - Demo logins seeded in dev: `buyer`/`buyer123`, `seller`/`seller123`, `admin`/`admin123`.
   - The `keys/` directory (keypairs: `platform.json`, `demo_*.json`, `escrow_<jobId>.json`) and `data/` (SQLite DB) are created on first run and are gitignored.
4. Node 24+ (`node --experimental-strip-types --experimental-transform-types`).
5. Devnet SOL: demo actors start at 0 SOL. Use the UI's "Request devnet airdrop" button, or `corepack pnpm run seed`, which airdrops the platform wallet + all demo actors (subject to faucet rate limits). The **platform wallet needs a little SOL** (~0.001 SOL per job) to pay escrow account rent — top it up via `seed` or a transfer from a funded demo wallet.

## Run the server

The agent shell has `PORT=0` in its environment. Node's `--env-file-if-exists=.env` does **not** override `process.env.PORT` when it already exists, so the server would bind to a random ephemeral port unless `PORT` is set explicitly to `8787` before starting.

### Detached start (PowerShell, for the registered preview)

Use the preview state's detach recipe with `PORT=8787` set inline:

    cd D:\kaizo\.freebuff
    powershell -NoProfile -Command "$env:PORT='8787'; (Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','dev' -RedirectStandardOutput '<log>' -RedirectStandardError '<log>.err' -WindowStyle Hidden -PassThru).Id"

- Port: **8787** (the app's default; free at setup time).
- Log files: stdout → `<log>`, stderr → `<log>.err` (different files — PowerShell fails if both point at one path).
- After starting, confirm the pid survived: `powershell -NoProfile -Command "Get-Process -Id <pid>"`.
- Verify: `curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/` → `200`, and confirm `netstat -ano | grep ":8787" | grep LISTENING` shows the node pid that was registered.

### Heads-up on `npm run dev`

`npm run dev` adds `--watch`, so the process restarts on every file change. That's fine for a dev preview, but if you restart and the previous node process didn't exit cleanly, you can hit EADDRINUSE. If that happens, kill the old `node.exe` listening on 8787 first (find it via `netstat -ano | grep ":8787"`), then restart.

### Heads-up on the agent shell's `PORT=0`

The agent shell's environment sets `PORT=0`. If you start the server from that shell without overriding `PORT`, the server binds to `localhost:0` (random) and the preview URL is unreachable. Always set `PORT=8787` (or another free port) before starting.

## Other commands

- Typecheck: `corepack pnpm exec tsc --noEmit`
- E2E suite (real devnet transactions): `corepack pnpm test`
- Scripted lifecycle demo (acts out the full escrow flow on devnet): `corepack pnpm run demo-story`
