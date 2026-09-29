# Deploying Solhustle

Solhustle is one Express + TypeScript process that serves the frontend out of `client/`,
so a deployment is configuration rather than a build pipeline. This covers what differs
from a laptop, and the two ways a hosted deploy goes wrong quietly.

---

## 1. It will not boot without a JWT secret

`NODE_ENV=production` refuses to start unless `JWT_SECRET` is set to a random value of at
least 32 characters:

```
Error: JWT_SECRET must be set to a random value of at least 32 characters in production.
Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

That is the guard working, not a bug: a predictable signing key means anyone can mint a
session for any account. Generate a value and set it on the host:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The process exits rather than falling back to the development default, so the failure is
loud and immediate instead of a deploy that runs with a known key.

---

## 2. Variables

Set these on the host. Do **not** set `PORT` — the platform injects it and the app reads it.

| Variable | Needed | Notes |
| --- | --- | --- |
| `JWT_SECRET` | yes | 32+ random characters. See above. |
| `APP_ORIGIN` | yes | The public URL, e.g. `https://your-app.up.railway.app`. Used for SIWS messages, links and the Auth0 callback. Left unset it stays `http://localhost:PORT`, which no visitor can reach. |
| `DATA_DIR` | yes | Where the SQLite ledger lives. Point it at the mounted volume. |
| `KEYS_DIR` | yes | Where the generated Solana keypairs live — including the platform wallet. Same volume. |
| `SEED_DEMO_ACCOUNTS` | demo | Off by default in production. Turn it on to get the seeded accounts below. |
| `STAFF_INVITE_CODE` | staff | Authorises creating `support`/`dev` accounts. See §4. |
| `AUTO_FUND_BUYER_WALLET` | demo | Off by default in production. On lets checkout top up a short deposit from the platform wallet so a demo never stalls on a devnet faucet. |
| `ADMIN_SETUP_SECRET` | optional | Gates `POST /auth/admin-signup`. Unset in production disables that route. |
| `CHAIN` | optional | `devnet` (default) or `mainnet-beta`. |
| `SOLANA_RPC_URL` | optional | Defaults to the public devnet endpoint. |
| `DATABASE_URL` | optional | Neon/Postgres mirror. Without it the app runs on SQLite alone. |
| `LLM_API_KEY` | for Nyaya | The case engine needs a model. Without a key it can only replay a ruling it has already cached for identical input, and reports itself unavailable otherwise. `LLM_BASE_URL` and `LLM_MODEL` select any OpenAI-compatible endpoint. |
| `AUTH0_ISSUER_BASE_URL`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` | optional | Hosted sign-in. Without them the login page stays on local email/password. |

At boot in production the app prints a `Deployment notes:` block for any of these that look
wrong — a relative data directory, a localhost `APP_ORIGIN`, no staff invite code, demo
seeding left on, or a missing model key. None of them stop the process; all of them are
worth reading in the deploy log.

---

## 3. Give it a volume, or lose the ledger on every deploy

`DATA_DIR` and `KEYS_DIR` default to `data` and `keys` — paths inside the project. That is
correct locally and destructive on a container host, because the deploy directory is
replaced whenever the image is rebuilt. Every case, ruling, contract and user goes with it,
and `KEYS_DIR` is worse than that: the platform wallet is generated there, so a redeploy
issues a *new* platform address and the old escrow authority is gone.

Mount a volume and point both at it. On Railway: **Service → Settings → Volumes → New
Volume**, mount path `/data`, then set:

```
DATA_DIR=/data
KEYS_DIR=/data/keys
```

The Postgres mirror does not replace this. It is a mirror: SQLite is the source of truth, and
the app is designed to run with no `DATABASE_URL` at all.

---

## 4. Reaching the staff console

Only `support` and `dev` roles can open the operator console and the Nyaya case docket, and
neither can be self-service — `client` and `freelancer` are the roles anyone may create.

Two ways to get in:

**For a hosted demo — seed the accounts.** Set `SEED_DEMO_ACCOUNTS=true` and sign in on the
login page with email/password:

| Username | Password | Role |
| --- | --- | --- |
| `admin` | `admin123` | `dev` — operator console and case docket |
| `buyer` | `buyer123` | `client` |
| `seller` | `seller123` | `freelancer` |

Be clear-eyed about this one: those passwords are published in this repository, so anyone who
has read it can sign in as staff on that deployment. It is a hackathon affordance, not a
configuration to leave running on anything real.

**For anything real — set an invite code.** With `STAFF_INVITE_CODE` set, staff signup
requires the caller to present that code in the `x-staff-invite` header:

```bash
# 1. ask for a challenge
curl -sX POST "$APP_ORIGIN/auth/challenge" \
  -H 'content-type: application/json' \
  -d '{"wallet":"<BASE58_PUBLIC_KEY>"}'

# 2. sign the returned message with that wallet, then:
curl -sX POST "$APP_ORIGIN/auth/verify" \
  -H 'content-type: application/json' \
  -H "x-staff-invite: $STAFF_INVITE_CODE" \
  -d '{"wallet":"<BASE58_PUBLIC_KEY>","signature":"<BASE58_SIG>","nonce":"<NONCE>","role":"support"}'
```

With no code set, production refuses staff signup outright, and the boot log says so.

Note that the sign-in page has no field for the invite code: the browser cannot create a
staff account. That is deliberate — bootstrapping staff is an operator action — but it does
mean a hosted demo wants the seeded `admin` account instead.

---

## 5. Health check

Point the platform's health check at `GET /meta/network`. It is unauthenticated, needs no
database, and answers `200` as soon as the process is serving — the same probe the test
suite waits on.

---

## 6. What changes in production, by design

- `/demo/*` helpers (seeded wallets, airdrop, sign-transfer, fast-forward) are registered in
  development only and answer `404` in production.
- The one-click personas on the login page are therefore unavailable; sign in with
  credentials instead.
- `EXPOSE_DEMO_SECRET_KEYS` defaults to false, so generated signing keys stay on the server.
- `AUTO_FUND_BUYER_WALLET` defaults to false, so a short deposit fails loudly rather than
  being quietly topped up from the platform balance.

---

## 7. Railway, start to finish

1. Deploy the repo. Nixpacks detects Node and runs `pnpm install` (the lockfile is pnpm) then
   `npm start`; there is no build step.
2. Add the volume mounted at `/data` (§3).
3. Set `JWT_SECRET`, `APP_ORIGIN` (your public URL), `DATA_DIR=/data`, `KEYS_DIR=/data/keys`.
4. For a demo, also set `SEED_DEMO_ACCOUNTS=true` and `AUTO_FUND_BUYER_WALLET=true`.
5. To have a case engine, set `LLM_API_KEY`.
6. Redeploy and check the log: the `Deployment notes:` block should be gone or explain
   itself. If the process still exits on `JWT_SECRET`, the variable is set on a different
   environment than the one serving the deploy.
