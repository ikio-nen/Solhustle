# Security review — Solhustle

A red-team pass over the authorization surface, run with the **firebase-security-rules-auditor**
checklist. The project has no Firebase, and its "rules" are not declarative — they are the Express
handlers, the `requireAuth` / `requireRole` middleware and the SQL that backs them. So the checklist
is applied to the real thing: the equivalent question for each item, what was probed, and what the
probe returned.

Every probe below was run against a live server (`NODE_ENV=development`, devnet) with three real
sessions: an anonymous client, an ordinary freelancer, and a client account.

**Score: 4 / 5.** Comprehensive server-side validation, ownership checks on every resource and
role checks that read the row rather than the token. The gap that keeps it off 5 started as a
genuine critical (a dev-only route that handed out wallet private keys) — it is fixed and verified
closed, but it was reachable in a deployment that never set `NODE_ENV=production`.

---

## Mandatory checklist, item by item

### 1. The update bypass (create → update into an invalid state)

*Equivalent: can an account reach a privileged state by a sequence of allowed calls?*

| Probe | Result |
| --- | --- |
| `POST /auth/verify` (wallet sign-in) asking for `role: "dev"` on a client+freelancer account | `200`, but the active role **stays the previous one** — the requested mode is only applied when the account already holds it. |
| Same probe with `role: "support"` | Ignored the same way. No escalation. |
| `POST /auth/roles` with `role: "dev"` / `"support"` | `400` — only the self-service pair (`client`, `freelancer`) is accepted. |
| `POST /auth/mode` targeting a mode the account is not entitled to | `403 this account is not set up for <role> yet`. |
| Second ruling on an already-ruled dispute | `409 dispute already ruled`. |
| Suspending your own account via `/admin/users/:id/status` | `400 cannot change your own status`. |

No create-then-update path to a role, a suspension reversal or a double payout was found.

### 2. Authority source

The app never trusts the caller's copy of its own privileges:

* `requireAuth` re-reads the `users` row per request, so the active role and `status` come from the
  database — a token minted before a suspension cannot be used to act after it.
* `issueToken` signs `token_version` **read from the row**, not from whatever partial object the
  caller passed. (This was a real bug: password sign-in's join projection omitted `token_version`,
  minting `tv:0` tokens that `requireAuth` rejected on the next request — a permanent lockout.)
* Role checks are `parseRoles(user)` off the row, on both the middleware and the handler.

Request bodies are never the source of a role, an owner id or a price: `usd_budget` is priced by the
server from Gemini at creation time, and the escrow destination/amount are read from the job row.

### 3. Business logic actually supports the app

* A freelancer can list open contracts (`GET /jobs?open=1`) **and open one to apply** — the second
  half was broken (`403 not a participant in this job` on a job the board had just advertised), now
  fixed with participant-only sub-resources redacted.
* An outsider reading a contract sees the job and their own application; applications by other
  people, the negotiation, deliveries, the job thread, the dispute and the rating stay hidden.
* A ruled "hold" does not strand money: the client has a refund path (`close-held`), verified
  end-to-end on-chain.
* Staff reach is deliberate: `support`/`dev` are allow-listed on participant checks, and the
  checks live in the handlers, not only in the UI.

### 4. Storage abuse / resource exhaustion

| Surface | Bound |
| --- | --- |
| Direct message body | 2000 chars (`MAX_MESSAGE_LEN`), shared with the composer's counter |
| Job title / requirements | 200 / 10 000 chars |
| Delivery note | 5000 chars |
| Delivery attachments | max 10, each URL ≤ 1000 chars and http(s) or a server-issued upload path |
| Uploads | 10 MB, MIME allow-list, **no SVG**, generated filenames, served `nosniff` + sandboxed CSP |
| Pagination | messages 200 per thread; applications/deliveries bounded by the job |
| Rate limits | auth endpoints, chat 60/min, uploads 40/min, global limiter |

Type coercions that matter are explicit: `requireString` / `requireNumber` / `requireArray`, and the
escrow confirm route rejects non-hex or odd-length transaction bytes before they reach the chain
layer. Probe: `{"wallet":"2 OR 1=1"}` → `400`, `2001`-char message → `400 body too long`, blank body
→ `400`.

### 5. Type safety

Every field that crosses the boundary is checked by kind, not just by presence, and a malformed
value fails with a `400` naming the field instead of reaching SQL or the RPC.

### 6. Field-level vs identity-level security

The classic trap — *limiting which fields can be written while forgetting to limit who may write
them* — is the shape this codebase is built to avoid. Access is identity-based:

* Conversations: `assertMember(conversationId, userId)` on every read and write. A non-member gets
  **404, not 403**, so a guessed thread id cannot even confirm the thread exists.
* Contracts: `assertParticipant` on fund, negotiate, accept, deliver, approve, escalate.
* Escrow: `/escrow/:id/*` re-checks `job.buyer_id === user.id` inside each handler.
* Existence probes: message-yourself → `400`, unknown user → `404`, unknown job → `404`.

Probes run as an outsider: read a thread → `404`; post to a thread → `404`; anonymous → `401`.

---

## Findings

### Critical — fixed: demo helpers exposed wallet keys and would sign transfers for anyone

`GET /demo/actors`, `POST /demo/airdrop`, `GET /demo/balance/:wallet` and
`POST /demo/sign-transfer` were registered in **every** environment and had no authentication.
`/demo/actors` returned each seeded wallet's `secret_key_b58`, and `/demo/sign-transfer` would build
and sign a transfer **from any demo wallet that had SOL**, with no session required. On any
internet-exposed deployment that was not explicitly labelled production, that is a key disclosure
plus an unauthenticated signing oracle over the platform's funded demo wallets.

*Fix:* the `/demo/*` routes now sit behind a `demoOnly` guard that is **not registered at all** when
`NODE_ENV=production` (they answer `404`), and `/demo/actors` only includes `secret_key_b58` when
`EXPOSE_DEMO_SECRET_KEYS` is on.

*Verified:* with `NODE_ENV=production` on a spare port, `/demo/actors`, `/demo/airdrop` and
`/demo/sign-transfer` all return `404`; in development the persona flow still works unchanged.

*Residual:* the demo personas are the reason these routes exist, so a devnet deployment of the demo
is still open by design — never run it with real SOL, and keep `NODE_ENV` accurate.

### Major — fixed: a failed balance read silently paid the wrong party's money

Found by walking the money path rather than reading it. `getEscrowAccountInfo` caught every RPC
error and returned `{ exists: false, lamports: 0 }` — the same answer it gives for a genuinely
empty vault. `releaseEscrow` read "empty vault" as "pay the freelancer out of the platform wallet
instead", so any transient RPC failure during an approval or an arbiter's release:

* paid a flat, capped 10,000,000 lamports (≈0.01 SOL) from the **platform** wallet instead of the
  contract's deposit,
* left the buyer's deposit sitting untouched in escrow,
* and wrote a ledger row claiming the contract had settled.

Observed on devnet: one arbitration release recorded `release: 10000000` against
`fund: 41727868`, with 0.041728 SOL still in the vault afterwards — the freelancer was underpaid by
75 % and the money was stranded, while the audit trail said otherwise.

*Fix:* `getEscrowAccountInfo` now distinguishes a failed read (`error`) from an empty account; the
release and refund paths turn a read failure into a `502` with nothing moved; and a **priced**
contract whose vault is empty is refused with a `409` that names the mismatch instead of minting a
platform-funded payout. Only a job with no recorded deposit (an unpriced legacy contract) still
falls back to the platform, where there is no escrow balance to strand. The reconcile report also
skips failed reads rather than inventing a missing-vault incident on every RPC hiccup.

*Verified:* approving a priced contract with an empty vault now returns `409 … reconcile before
settling`, leaves the status untouched and writes **no** ledger row; a fully funded contract still
releases end-to-end with the full deposit paid out (0.016693 SOL, status `released`).

### Moderate — fixed: an advertised contract could not be opened

`GET /jobs/:id` required participation, so a freelancer clicking a contract on the marketplace board
got `403 not a participant` — the board could advertise work nobody could apply to. The read is now
allowed for freelancers on `funded` jobs, with every participant-only sub-resource redacted (an
applicant sees only their own application). Outsiders on non-open jobs still get `403`.

### Minor — fixed: the ledger recorded no amount for releases and refunds

`escrow_transactions.amount_lamports` was written as `null` for everything except deposits, so the
audit trail — and the admin panel that reads it — showed a release with no value attached.
`sendAndRecord` now takes the moved amount and release/refund rows carry it.

### Minor — fixed: incorrect role entered on wallet sign-in

Wallet sign-in applied the requested role only to brand-new accounts, so a returning account landed
in whatever mode was last active (the demo "Client" persona entered as a freelancer). It now
switches to the requested mode when the account holds it, and ignores the request otherwise —
verified with `dev`/`support` escalation probes.

### Minor — fixed: password sign-in dropped the entitled-roles list

The join projection omitted `u.roles`, so an account that can switch modes came back with a single
role and lost the switcher until the next request. Same class as the earlier `token_version`
omission; both columns are now in the projection with a comment explaining why they must stay.

### Open / accepted

| Item | Severity | Note |
| --- | --- | --- |
| Auth0 `pending`/`handoffs` state is in-process | minor | Single-instance only; a multi-instance deploy needs shared state (Redis) — deliberately deferred. |
| Uploads are base64 in JSON | minor | ~33 % wire overhead, no multipart dependency; size and type are enforced server-side. |
| Escrow custody is an account-based MVP | design | The vault keypair is server-held until the Anchor program owns the vault; the interface is built for that swap. |
| `/meta/auth` publishes the tenant domain and callback path | informational | Needed by the login page; not a secret. |
| Bearer tokens in `sessionStorage` | informational | Not a CSRF target (no cookie auth), and XSS is mitigated by CSP `script-src 'self'`; a same-origin XSS would still read it, which is why every rendered field is escaped. |

---

## Assessment (auditor format)

```json
{
  "score": 4,
  "summary": "Authorization is identity-based and enforced server-side: membership checks on conversations and contracts, role checks read from the users row per request, JWT revocation via token_version, and explicit bounds on every user-supplied field. One critical finding (unauthenticated dev-only routes that disclosed seeded wallet private keys and signed transfers) was found, fixed and verified closed under NODE_ENV=production; several moderate data-integrity and business-logic gaps (open contracts unreadable to applicants, mode not applied on wallet sign-in, roles dropped from the password-login projection, missing release/refund amounts in the ledger) were also fixed. Remaining items are minor or accepted design trade-offs for a devnet MVP.",
  "findings": [
    {
      "check": "Authority Source",
      "severity": "critical",
      "issue": "GET /demo/actors returned each seeded wallet's private key and POST /demo/sign-transfer would sign a transfer from any funded demo wallet, with no authentication and in every environment.",
      "recommendation": "Register the /demo/* helpers in development only (404 under NODE_ENV=production) and gate secret_key_b58 behind EXPOSE_DEMO_SECRET_KEYS. DONE, verified 404 in production."
    },
    {
      "check": "Business Logic vs Rules",
      "severity": "major",
      "issue": "getEscrowAccountInfo folded RPC failure into 'empty vault', and releaseEscrow treated an empty vault as 'pay from the platform wallet' — so a flaky balance read paid a flat 0.01 SOL from the wrong account, stranded the buyer's deposit, and recorded the contract as settled.",
      "recommendation": "Distinguish read failure from empty, fail the release/refund loudly on a read error, and refuse to settle a priced contract with an empty vault (409, nothing moved). DONE, verified both the refusal and the normal funded release."
    },
    {
      "check": "Business Logic vs Rules",
      "severity": "moderate",
      "issue": "GET /jobs/:id required participation, so the marketplace board advertised funded contracts that no freelancer could open or apply to.",
      "recommendation": "Allow freelancers to read open (status=funded) jobs, redacting applications beyond the caller's own, plus negotiations, deliveries, thread, dispute and rating. DONE."
    },
    {
      "check": "The Update Bypass",
      "severity": "minor",
      "issue": "Wallet sign-in applied the requested role only to new accounts, so returning accounts entered whatever mode was previously active.",
      "recommendation": "Apply the requested mode when the account already holds it; ignore it otherwise. Verified dev/support requests are ignored. DONE."
    },
    {
      "check": "Type Safety / Field-level vs Identity-level",
      "severity": "minor",
      "issue": "Password sign-in's join projection omitted u.roles (and previously u.token_version), degrading the session to a single role and, before that fix, rejecting freshly minted tokens.",
      "recommendation": "Keep both columns in the projection with a comment on why they are load-bearing. DONE."
    },
    {
      "check": "Storage Abuse",
      "severity": "minor",
      "issue": "Release and refund rows in escrow_transactions recorded no amount, weakening the audit trail staff rely on when a payout looks wrong.",
      "recommendation": "Pass the moved lamport amount through sendAndRecord for release and refund. DONE."
    },
    {
      "check": "Field-level vs Identity-level Security",
      "severity": "minor",
      "issue": "Auth0 authorization state is kept in process memory, so a multi-instance deployment would fail handoffs rather than degrade securely.",
      "recommendation": "Move pending/handoff state to shared storage before scaling horizontally."
    }
  ]
}
```
