# How to run Solhustle

Solhustle is one Express + TypeScript process that serves a no-build-step frontend out of
`client/` and talks to SQLite, Solana devnet and — optionally — Neon Postgres and Auth0.

There is **no bundler and no frontend build step**: edit a file in `client/`, reload the page.

---

## 1. Requirements

| Need | Why |
| --- | --- |
| **Node 24+** | The server runs TypeScript directly via `--experimental-strip-types --experimental-transform-types`. No `tsc` build to remember. |
| **pnpm** (`corepack pnpm`) | The committed lockfile is a pnpm lockfile. |
| **Devnet SOL** | Escrow deposits are real (if tiny) transactions on Solana devnet. The faucet is rate-limited, so keep a little SOL on the demo wallets. |
| *Optional* Neon `DATABASE_URL` | The SQLite ledger is mirrored to Postgres when configured. Without it the app is fully functional, it just skips the mirror. |
| *Optional* Auth0 tenant | Hosted sign-in. Without it the login page stays on local email/password and the one-click demo personas. |

> On the machine this project was developed on, plain `npm` is broken (a corrupt
> `minipass-flush` in the global cache). Use `corepack pnpm` for everything.

```bash
corepack pnpm install
```

## 2. Configure `.env`

```bash
cp .env.example .env
```

`.env.example` documents every variable. The ones that matter to get going:

| Variable | Notes |
| --- | --- |
| `PORT` | `8787` — the port every link in the app and the Auth0 whitelist assumes. |
| `JWT_SECRET` | Any random string ≥ 32 chars. `NODE_ENV=production` refuses to boot with the dev default. |
| `CHAIN` | `devnet`. |
| `DATABASE_URL` | Optional Neon mirror. Blank = SQLite only. |
| `AUTH0_*` | Optional hosted sign-in — see §6. |
| `ADMIN_SETUP_SECRET` | Only needed to self-service a staff account (§5). |

## 3. Run it

```bash
corepack pnpm run start     # run once
corepack pnpm run dev       # same, with --watch
```

Then open **http://localhost:8787**.

> **The `PORT=0` trap.** Node's `--env-file-if-exists=.env` does not override a variable that
> already exists in the environment. If your shell exports `PORT=0`, the server binds to a
> random port and the URL above will not answer. Start it explicitly instead:
>
> ```bash
> PORT=8787 corepack pnpm run start
> ```

On first run the server creates:

* `data/app.db` — the SQLite ledger (jobs, users, messages, escrow transactions).
* `keys/` — keypairs: `platform.json` (escrow authority + fee payer), `escrow_<jobId>.json`
  (one per contract), and `demo_*.json` for the seeded personas.

Both are gitignored. Delete them to start from a clean slate.

### Other scripts

| Command | What it does |
| --- | --- |
| `corepack pnpm run typecheck` | `tsc --noEmit` over the whole project. |
| `corepack pnpm run test` | The node:test suite in `server/tests/`. |
| `corepack pnpm run test:auth` | Just the auth suite (fast, self-contained). |
| `corepack pnpm run seed` | Seeds the taxonomy, the demo personas and airdrops SOL to them. |
| `corepack pnpm run demo-story` | Acts out the whole lifecycle on devnet with real transactions: post → fund → apply → accept → deliver → approve → release, then a second contract that ends in a dispute. |

## 4. Sign in

The login page (`/login`) offers, in order of prominence:

1. **Continue with Auth0** — once the `AUTH0_*` values are set (§6).
2. **Use local demo sign-in** — one click per seeded persona. Add `?demo=1` to open it directly.

| Demo account | Password | Label in the UI | Roles |
| --- | --- | --- | --- |
| `buyer` | `buyer123` | Client | `client` + `freelancer` |
| `seller` | `seller123` | Freelancer | `freelancer` |
| `admin` | `admin123` | Operator | `dev` |

The persona buttons use wallet sign-in (SIWS) with the keys in `keys/demo_*.json`, so no password
is typed and no wallet extension is needed. Every seeded wallet starts at 0 SOL: use the
**Request devnet airdrop** button in the app, or `corepack pnpm run seed`.

> **The platform wallet needs a little SOL.** It pays the rent deposit for each escrow account
> (~0.001 SOL per job). If deposits start failing with *"the funding wallet ran out of SOL"*,
> top up the platform wallet (published at `GET /demo/balance/<wallet>`) via `seed` or an airdrop.

## 5. First 10 minutes

1. Sign in as **Client** (or `buyer`/`buyer123`).
2. **Post a job** — the budget is quoted in SOL at the live Gemini rate and stored with the job.
3. Open the job and **Fund escrow** — the app signs a transfer to the contract's own vault
   account, and the job flips to `funded`.
4. Switch to **Freelancer** (same dual-role account, via the account menu, or sign in as
   `seller`). **Find work** lists exactly the funded contracts — open one and **Apply**.
5. Back as the client: accept the application, then watch the freelancer deliver, and approve to
   release the vault on-chain. Every step writes an `escrow_transactions` row with a Solscan link.

Need a staff account? Set `ADMIN_SETUP_SECRET` and `POST /auth/admin-signup` with
`x-admin-setup-secret`. In production, admin signup is disabled entirely when that variable is
unset. See `docs/admin-panel.md`.

## 6. Turning on Auth0 (optional)

1. In the Auth0 dashboard create a **Regular Web Application** (not an API).
2. Under *Settings*, whitelist three URLs — the login page prints the exact strings it wants when
   Auth0 is half-configured, so copy them from there:
   * **Allowed Callback URLs** `http://localhost:8787/callback`
   * **Allowed Logout URLs** `http://localhost:8787/login`
   * **Allowed Web Origins** `http://localhost:8787`
   * (Putting the login page's origin in *Allowed Web Origins* is what makes the
     `/auth/auth0/logout` redirect back work.)
3. Copy three values into `.env`:

   ```env
   AUTH0_ISSUER_BASE_URL=https://<your-tenant>.us.auth0.com
   AUTH0_CLIENT_ID=<client id>
   AUTH0_CLIENT_SECRET=<client secret>
   AUTH0_CALLBACK_URL=http://localhost:8787/callback
   AUTH0_LOGOUT_RETURN_TO=http://localhost:8787/login
   ```

4. Restart. `GET /meta/auth` should now report `"configured": true`, the login page swaps the
   warning notice for a lime **Continue with Auth0** button, and the redirect uses PKCE (`S256`)
   with a short-lived `HttpOnly` state cookie.

**If the callback fails**, the two errors Auth0 returns are worth knowing apart:

* *Unknown client* — the `AUTH0_CLIENT_ID` does not belong to that `AUTH0_ISSUER_BASE_URL`.
* *Callback URL mismatch* — the URI in `AUTH0_CALLBACK_URL` is not in the application's Allowed
  Callback URLs list. The value must match **character for character**, including the path.

## 7. What lives where

| Route | What it is |
| --- | --- |
| `/` | The landing page (product, pricing, FAQ, the team under `#creators`). |
| `/login`, `/signup` | Auth entry point: Auth0 first, local form and personas behind a toggle. |
| `/app` | The whole signed-in app. Every screen is a hash route inside this one shell. |
| `/browse` | Public freelancer directory. |
| `/work` | The freelancer's job board (open funded contracts). |
| `/messages`, `/me` | Direct messages, and the profile/portfolio editor. |
| `/freelancer/<id>` | Public profile. |
| `/operator` | Staff console (support + dev only). |
| `/work`, `/messages`, `/jobs`, `/me` | Legacy paths that redirect into the app shell. |
| `/index.html`, `/buyer`, `/seller`, `/talent`, … | 301s to their replacements. |

The in-app hash routes are worth knowing because they are linkable and deep-linkable:

```
/app#/            dashboard (role aware)
/app#/work        open contracts, i.e. the freelancer's "Find work"
/app#/browse      talent directory
/app#/jobs        my contracts          /app#/jobs/new   post a job
/app#/jobs/<id>   one contract          /app#/messages/<id>  one conversation
/app#/me          my profile & portfolio
/app#/operator    staff console
```

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| The URL doesn't answer, but the server logged "listening" | `PORT=0` in your shell — start with `PORT=8787` explicitly (§3). |
| `EADDRINUSE :8787` | An older process is still listening: `netstat -ano \| grep ':8787'` then kill that PID. |
| "devnet faucet rate-limited" | The public faucet is per-IP and impatient. Wait a minute, or set `AIRDROP_URL` to a paid faucet, or use the transfer helper below. |
| "the escrow deposit was rejected … ran out of SOL" | The buyer's wallet cannot cover the deposit. Fund it (airdrop, `seed`, or any devnet transfer) and retry — the state is unchanged, so a retry is safe. |
| Signing out in one tab signs me out everywhere | By design: the session is a `sessionStorage` JWT and logout revokes the token server-side (`token_version`). |
| A session survives a reload but not a new tab | Also by design — `sessionStorage` is per tab. Use Auth0 or password sign-in if you want cross-tab sessions. |
| Uploads are rejected | 10 MB cap, image/video/PDF-ish MIME allow-list, **no SVG**, generated filenames. Uploads are sent as base64 JSON (no multipart dependency), so payloads are ~33 % larger than the file. |
| `npm install` blows up | Known-broken `npm` on the dev machine — use `corepack pnpm`. |

Moving demo SOL between seeded wallets by hand, without a wallet app:

```bash
# 1. ask the server to build + sign a transfer from a seeded wallet
curl -s -X POST http://localhost:8787/demo/sign-transfer \
  -H 'Content-Type: application/json' \
  -d '{"wallet":"<from>","to":"<to>","lamports":250000000}'
# 2. broadcast raw_tx_hex yourself (e.g. sendTransaction on https://api.devnet.solana.com)
```

`/demo/*` exists for this kind of thing. It is **development only** — with
`NODE_ENV=production` every `/demo/*` route answers 404.
