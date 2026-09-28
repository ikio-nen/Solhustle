# The operator console

The operator console is the staff surface of Solhustle: system health, vault reconciliation,
accounts, every contract, the dispute queue, and the audit trail. It is one hash route inside the
normal app shell — `/app#/operator`, also reachable at `/operator` — so staff use the same
sign-in and the same nav as everyone else.

## Who gets in

| Role | Access |
| --- | --- |
| `dev` (**Operator**) | Everything: health, reconciliation, users, jobs, disputes, audit. |
| `support` | The same console except **System health** and **Reconciliation**, which call endpoints restricted to `dev`. |
| everyone else | The route renders an access notice; the endpoints answer `403`, so hiding the nav link is not what protects it. |

Every `/admin/*` route is guarded server-side with `requireAuth` + `requireRole(...)`; roles are
read from the `users` row on each request, not from the token, so a suspension or a role change
takes effect on the caller's very next request.

### Getting a staff account

* **Seeded, easiest:** the `admin` demo account (`admin` / `admin123`) is a `dev`. Sign in as
  **Operator** from the demo personas.
* **Self-service:** set `ADMIN_SETUP_SECRET` in `.env`, then:

  ```bash
  curl -s -X POST http://localhost:8787/auth/admin-signup \
    -H 'Content-Type: application/json' \
    -H "x-admin-setup-secret: $ADMIN_SETUP_SECRET" \
    -d '{"username":"ops","password":"…","email":"ops@example.com"}'
  ```

  In production this route refuses to run when the variable is unset, and the first-account
  bootstrap checks that the instance is empty.
* **Promotion:** staff roles are not self-service. `POST /auth/roles` only ever grants `client` or
  `freelancer`; `support`/`dev` are granted out of band (DB or the setup secret).

## The panels

### System health
Live chain + ledger counters: the RPC endpoint and its reported Solana version, the finalized
slot, and counts of users, jobs, open disputes, open helpdesk tickets and recorded escrow
transactions. If `rpc.ok` is false the panel shows the RPC error — that is the fastest way to tell
"our code is broken" from "devnet is unreachable". *(dev only)*

### Reconciliation
Compares each contract's recorded state against the **live devnet balance** of its escrow account
and reports the drift. This is the safety net for the money path: it is how you spot a release that
was recorded but never confirmed, or a vault that was topped up outside the app. *(dev only)*

### Disputes
The arbitration queue. Every dispute shows the job it belongs to, the reason the freelancer filed,
and — while it is open — two ruling buttons.

**How a dispute happens at all:**

1. The freelancer submits a delivery.
2. The client **requests a revision** (`POST /jobs/:id/reject`) — the contract moves to `rejected`.
3. The freelancer **escalates** (`POST /jobs/:id/escalate`) with a written reason. The contract
   moves to `disputed`, a `disputes` row is opened, and a helpdesk ticket is auto-opened so the
   item lands in the support queue rather than in someone's memory.

**Ruling.** Pick an outcome and write notes; the notes are stored with the ruling and are what the
audit trail shows later.

| Outcome | What the server does |
| --- | --- |
| **Release to freelancer** | Signs and broadcasts a real transfer from the contract's vault to the freelancer's wallet, records it as a `release` escrow transaction, and moves the job to `released`. |
| **Hold funds** | Moves nothing on-chain. The vault keeps the money, the freelancer is detached from the job (`held_detached`, `freelancer_id = null`), and the client can later refund it in full. |

A ruling is final: the dispute moves to `ruled`, the linked ticket is closed, and a second ruling
returns `409 dispute already ruled`. Rulings are audited as `dispute_ruled` with the outcome and
the notes.

**Releasing a held vault.** A job in `held_detached` is the client's to close: `POST
/jobs/:id/close-held` (the **Close & refund** action on the contract page) refunds the entire vault
balance to the buyer, records a `refund` transaction, and moves the job to `closed_no_payout`.
Nothing is stranded: every state has an exit that moves the money somewhere real.

### Jobs
Every contract on the instance with its status, USD budget and locked SOL amount. Read-only — it is
the "where is this thing" view, not an editing surface.

### Accounts
Every account with its wallet, active role, entitled roles (`client,freelancer`, …) and status.
Support can **suspend** and reactivate accounts from the account detail endpoint; an actor cannot
change their own status (that guard exists so a compromised staff session cannot lock out its
colleagues and so you cannot accidentally suspend yourself mid-investigation). Suspension takes
effect immediately because authorization reads the `users` row, and login refuses suspended
accounts on the password, wallet and Auth0 paths alike.

### Audit trail
The append-only log behind every consequential action: logins and role switches, job rejection,
status changes, dispute rulings, admin actions. Entries record actor, action type, target and
before/after state. **When a payout looks wrong, read this first** — it is ordered and does not
depend on the application remembering to explain itself.

## Staff in the rest of the app

Staff are ordinary accounts with extra reach, so the console is not the only door:

* `GET /admin/jobs` and the console's job list overlap with what `#/jobs` shows staff (all
  contracts, not just their own).
* Anyone staff can read any contract's detail page (`applications`, `deliveries`, the job thread,
  the dispute) — the participant check explicitly allow-lists `support` and `dev`.
* Staff can open a direct message thread with any account, so an adjudication can be discussed
  without a contract being the carrier.
