/* SealDeal dev frontend — vanilla JS, no build step. Talks to the real API; nothing is mocked. */
const $ = (sel) => document.querySelector(sel);

// --- base58 (browser-side signing helper; no external deps) --------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(bytes) {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  let out = "";
  while (x > 0n) { out = B58[Number(x % 58n)] + out; x /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out || "1";
}
function b58decode(str) {
  let x = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58 char");
    x = x * 58n + BigInt(i);
  }
  const bytes = [];
  while (x > 0n) { bytes.unshift(Number(x & 255n)); x >>= 8n; }
  for (const c of str) { if (c === "1") bytes.unshift(0); else break; }
  return new Uint8Array(bytes);
}

// --- state ----------------------------------------------------------------------
const state = {
  token: null, user: null, actorName: null, wallet: null, secretKeyB58: null,
  actors: [], taxonomy: [], net: null,
  tab: "dashboard", openJobId: null, openTicketId: null, openDisputeId: null,
};

// --- tiny API client --------------------------------------------------------------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(state.token ? { authorization: "Bearer " + state.token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  if (!res.ok) throw new Error(`${res.status} ${(json && json.error) || path}`);
  return json;
}

// --- UI helpers ---------------------------------------------------------------------
function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 7000);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const fmtSol = (lamports) => (Number(lamports || 0) / 1e9).toFixed(6);
const short = (s, n = 10) => (s ? String(s).slice(0, n) + "…" : "");
const txLink = (sig) => `<a href="https://solscan.io/tx/${esc(sig)}?cluster=devnet" target="_blank" rel="noopener" style="font-weight:600; text-decoration:underline;">${esc(short(sig, 12))} <span style="font-size:11px; opacity:0.85;">[Solscan ↗]</span></a>`;
const acctLink = (addr) => `<a href="https://solscan.io/account/${esc(addr)}?cluster=devnet" target="_blank" rel="noopener">${esc(short(addr, 12))} <span style="font-size:11px; opacity:0.85;">[Solscan ↗]</span></a>`;

const STATUS_PILL = {
  released: "ok", closed_no_payout: "dim", funded: "warn", agreed: "warn",
  in_progress: "warn", delivered: "warn", rejected: "err", disputed: "err", held_detached: "err",
};
const pill = (status) => `<span class="pill ${STATUS_PILL[status] || ""}">${esc(status)}</span>`;

// --- session ---------------------------------------------------------------------------
const SESSION_KEY = "sealdeal.session";
function saveSession() {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    token: state.token, user: state.user, actorName: state.actorName, wallet: state.wallet, secretKeyB58: state.secretKeyB58,
  }));
}
function restoreSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (s && s.token) {
      state.token = s.token; state.user = s.user; state.actorName = s.actorName; state.wallet = s.wallet; state.secretKeyB58 = s.secretKeyB58;
    }
  } catch { /* ignore */ }
}
function logout() {
  state.token = state.user = state.actorName = state.wallet = state.secretKeyB58 = null;
  localStorage.removeItem(SESSION_KEY);
  renderAll();
}

async function login(actor) {
  try {
    const ch = await api("POST", "/auth/challenge", { wallet: actor.wallet });
    const secret = b58decode(actor.secret_key_b58);
    const sig = b58encode(nacl.sign.detached(new TextEncoder().encode(ch.message), secret));
    const v = await api("POST", "/auth/verify", { wallet: actor.wallet, signature: sig, nonce: ch.nonce, role: actor.role });
    state.token = v.token; state.user = v.user; state.actorName = actor.name; state.wallet = actor.wallet;
    state.secretKeyB58 = actor.secret_key_b58;
    saveSession();
    toast(`Signed in as ${actor.name} (${v.user.role})`, "ok");
    renderAll();
  } catch (err) {
    toast("Sign-in failed: " + err.message, "err");
  }
}

// --- chrome --------------------------------------------------------------------------
function renderHeader() {
  const net = state.net;
  $("#net-info").textContent = net ? `chain: ${net.chain} · rpc live` : "loading network…";
  $("#session-info").textContent = state.user
    ? `${state.actorName} · ${state.user.role} · wallet ${short(state.wallet, 8)}`
    : "not signed in";
}

function tabDefs() {
  const role = state.user?.role;
  const tabs = [["dashboard", "Dashboard"], ["jobs", "Jobs"]];
  if (role === "freelancer") tabs.push(["profile", "My profile"], ["directory", "Directory"]);
  if (role === "client") tabs.push(["directory", "Find freelancers"]);
  if (role === "support" || role === "dev") tabs.push(["support", "Support desk"]);
  tabs.push(["leaderboard", "Leaderboard"]);
  if (role === "dev") tabs.push(["dev", "Dev console"]);
  return tabs;
}

function renderTabs() {
  const nav = $("#tabs");
  nav.innerHTML = "";
  if (!state.user) return;
  for (const [key, label] of tabDefs()) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = state.tab === key ? "on" : "";
    b.onclick = () => { state.tab = key; renderAll(); };
    nav.appendChild(b);
  }
}

// --- boot -------------------------------------------------------------------------------
async function init() {
  try {
    const [net, actors, tax] = await Promise.all([
      api("GET", "/meta/network"),
      api("GET", "/demo/actors"),
      api("GET", "/meta/taxonomy"),
    ]);
    state.net = net; state.actors = actors.actors; state.taxonomy = tax.domains;
  } catch (err) {
    toast("Cannot reach backend: " + err.message, "err");
  }
  restoreSession();
  renderAll();
  if (state.token) refreshMe();
}

async function refreshMe() {
  try {
    const me = await api("GET", "/auth/me");
    state.user = me.user;
    saveSession();
    renderHeader();
  } catch (err) {
    if (String(err.message).startsWith("401")) logout();
  }
}

function renderAll() {
  renderHeader();
  if (!state.user) {
    $("#login-panel").style.display = "";
    $("#app").style.display = "none";
    renderActors();
    return;
  }
  $("#login-panel").style.display = "none";
  $("#app").style.display = "";
  renderTabs();
  renderBalance();
  renderView();
}

function renderActors() {
  const box = $("#actors");
  box.innerHTML = "";
  if (!state.actors.length) {
    box.innerHTML = `<span class="dim">No demo actors — start the backend (npm run dev).</span>`;
    return;
  }
  for (const a of state.actors) {
    const b = document.createElement("button");
    b.className = "btn sec";
    b.innerHTML = `${esc(a.name)} <span class="dim">(${esc(a.role)})</span>`;
    b.title = a.wallet;
    b.onclick = () => login(a);
    box.appendChild(b);
  }
}

async function renderBalance() {
  if (!state.wallet) return;
  try {
    const b = await api("GET", `/demo/balance/${state.wallet}`);
    const el = $("#me-balance");
    el.textContent = `${b.sol.toFixed(4)} SOL`;
    el.title = b.explorer_url;
  } catch { $("#me-balance").textContent = "balance n/a"; }
}
// --- view router ---------------------------------------------------------------------
function renderView() {
  const v = $("#view");
  const role = state.user?.role;
  if (state.tab === "dashboard") return renderDashboard(v);
  if (state.tab === "jobs") return renderJobs(v);
  if (state.tab === "profile") return renderProfile(v);
  if (state.tab === "directory") return renderDirectory(v);
  if (state.tab === "support") return renderSupport(v);
  if (state.tab === "leaderboard") return renderLeaderboard(v);
  if (state.tab === "dev") return renderDev(v);
  v.innerHTML = `<div class="card dim">Nothing here.</div>`;
}

// --- dashboard ------------------------------------------------------------------------
function singleJobCard(j) {
  return `<div class="job"><div class="top"><div><strong>#${j.id} ${esc(j.title)}</strong><div class="dim">budget $${j.usd_budget} · ${j.sol_amount ?? "?"} SOL · ${esc(j.created_at || "")}</div></div><div>${pill(j.status)}</div></div></div>`;
}

async function renderDashboard(v) {
  const role = state.user.role;
  v.innerHTML = `<div class="card dim">Loading dashboard…</div>`;
  let jobs = [], disputes = [], tickets = [];
  try {
    const r = await api("GET", "/jobs?mine=1");
    jobs = r.jobs;
  } catch { /* ignore */ }
  const byStatus = {};
  for (const j of jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
  let extra = "";
  if (role === "support" || role === "dev") {
    try { disputes = (await api("GET", "/disputes")).disputes.filter((d) => d.status === "open"); } catch {}
    try { tickets = (await api("GET", "/tickets")).tickets.filter((t) => t.status !== "resolved"); } catch {}
  }
  if (role === "freelancer") {
    try {
      const p = await api("GET", "/me/profile");
      extra = p.portfolio_ready
        ? `<div class="ok-text">Portfolio published — marketplace-visible. ${p.portfolio.length} item(s), ${p.subdomains.length} subdomain(s).</div>`
        : `<div class="err-text">Portfolio NOT published — you cannot apply to jobs yet. Go to “My profile”.</div>`;
    } catch {}
  }
  if (role === "client") {
    try {
      const price = await api("GET", "/meta/price");
      extra = `<div class="dim">Live Gemini SOL/USD: <strong>${price.rate}</strong> (${price.live ? "live" : "cached"}, ${esc(price.fetched_at || "")})</div>`;
    } catch {}
  }
  v.innerHTML = `
    <div class="grid">
      <div class="card"><h3>Your wallet</h3>
        <div class="kv"><span class="k">address</span><span class="mono">${acctLink(state.wallet)}</span>
        <span class="k">role</span><span>${esc(role)}</span>
        <span class="k">user id</span><span>${state.user.id}</span></div>
        <div style="margin-top:10px">${extra}</div>
      </div>
      <div class="card"><h3>Your jobs</h3>
        ${jobs.length ? Object.entries(byStatus).map(([k, n]) => `<div>${pill(k)} × ${n}</div>`).join("") : `<div class="dim">No jobs yet.</div>`}
        <div class="dim" style="margin-top:8px">Total: ${jobs.length}</div>
      </div>
      ${role === "support" || role === "dev" ? `
      <div class="card"><h3>Open work queues</h3>
        <div>${disputes.length} open dispute(s)</div>
        <div>${tickets.length} open ticket(s)</div>
      </div>` : ""}
    </div>
    ${jobs.length ? `<div class="card"><h3>Recent jobs</h3>${jobs.slice(0, 5).map(singleJobCard).join("")}</div>` : ""}
  `;
}

// --- jobs ---------------------------------------------------------------------------------
const JOB_ACTIONS = {
  initEscrow: "Init escrow", fund: "Fund escrow", apply: "Apply", accept: "Accept", decline: "Decline",
  negotiate: "Send offer", agree: "Agree", start: "Start work", deliver: "Submit delivery",
  approve: "Approve & release", reject: "Reject", backoff: "Back off (refund buyer)", escalate: "Escalate to support",
  relist: "Re-list job", closeHeld: "Close & refund", rate: "Rate freelancer", message: "Send message",
};

async function renderJobs(v) {
  const role = state.user.role;
  const mine = document.createElement("div");
  v.innerHTML = `<div class="card dim">Loading jobs…</div>`;
  let jobs = [];
  try { jobs = (await api("GET", "/jobs?mine=1")).jobs; } catch (err) { toast(err.message, "err"); }
  let marketplace = [];
  if (role === "freelancer") {
    try { marketplace = (await api("GET", "/jobs")).jobs.filter((j) => j.status === "funded"); } catch {}
  }
  const createForm = role === "client" ? `
    <div class="card"><h3>Post a job (funds escrow after posting)</h3>
      <label>Title</label><input id="j-title" placeholder="e.g. Product launch video edit" />
      <label>Requirements</label><textarea id="j-req" placeholder="Describe the deliverable, formats, deadline…"></textarea>
      <label>Budget (USD — quoted live to SOL via Gemini)</label><input id="j-usd" type="number" min="1" value="10" />
      <div class="actions"><button class="btn" data-act="createJob">Create job + get SOL quote</button></div>
      <div id="create-result" class="muted-box" style="display:none"></div>
    </div>` : "";
  v.innerHTML = `
    ${createForm}
    <div class="card"><h3>${esc(role === "freelancer" ? "Jobs I work on" : "My jobs")}</h3>
      ${jobs.length ? jobs.map(jobRow).join("") : `<div class="dim">No jobs yet.</div>`}
    </div>
    ${role === "freelancer" ? `
    <div class="card"><h3>Marketplace — funded jobs open for applications</h3>
      ${marketplace.length ? marketplace.map(jobRow).join("") : `<div class="dim">No funded jobs open right now.</div>`}
    </div>` : ""}
    <div id="job-detail"></div>
  `;
  if (state.openJobId) openJob(state.openJobId);
}

function jobRow(j) {
  return `<div class="job" data-job="${j.id}">
    <div class="top"><div><strong>#${j.id} ${esc(j.title)}</strong>
      <div class="dim">budget $${j.usd_budget} ≈ ${j.sol_amount ?? "?"} SOL · round ${j.round} · ${esc(j.created_at || "")}</div></div>
      <div>${pill(j.status)}</div></div>
    <div class="actions"><button class="btn sec" data-act="openJob" data-id="${j.id}">Open detail</button></div>
  </div>`;
}

function renderJobDetail(d) {
  const j = d.job;
  const role = state.user.role;
  const isBuyer = j.buyer_id === state.user.id;
  const isFreelancer = j.freelancer_id === state.user.id;
  const apps = d.applications || [];
  const neg = d.negotiation;
  const txs = d.escrow_transactions || [];
  const myApp = apps.find((a) => a.freelancer_id === state.user.id && a.status === "pending");

  const actions = [];
  if (isBuyer && j.status === "created" && !j.escrow_address) actions.push(["initEscrow", "Init escrow account (on-chain)"]);
  if (isBuyer && j.status === "created" && j.escrow_address) actions.push(["fund", "Fund escrow with " + fmtSol(j.sol_amount * 1e9) + " SOL"]);
  if (role === "freelancer" && j.status === "funded" && !myApp) actions.push(["apply", "Apply to this job"]);
  if (isBuyer && j.status === "funded") actions.push(["accept", "Accept an applicant"], ["decline", "Decline an applicant"]);
  if ((isBuyer || isFreelancer) && j.status === "negotiating") actions.push(["negotiate", "Send offer / counter-offer"], ["agree", "I agree to the current offer"]);
  if (isFreelancer && j.status === "agreed") actions.push(["start", "Start work"]);
  if (isFreelancer && j.status === "in_progress") actions.push(["deliver", "Submit delivery"]);
  if (isBuyer && j.status === "delivered") actions.push(["approve", "Approve → release SOL on-chain"], ["reject", "Reject with reason"]);
  if (isFreelancer && j.status === "rejected") actions.push(["backoff", "Back off → refund buyer"], ["escalate", "Escalate to support"]);
  if ((isBuyer || role === "support" || role === "dev") && j.status === "held_detached") actions.push(["relist", "Re-list for a new freelancer"], ["closeHeld", "Close & refund buyer"]);
  if (isBuyer && j.status === "released" && !d.rating) actions.push(["rate", "Rate freelancer"]);
  if (isBuyer || isFreelancer || role === "support" || role === "dev") actions.push(["message", "Send message"]);

  const actionButtons = actions.map(([k, label]) =>
    `<button class="btn sec" data-act="${k}" data-id="${j.id}">${esc(label)}</button>`).join("");

  return `<div class="card"><h3>Job #${j.id} — ${esc(j.title)} ${pill(j.status)}</h3>
    <div class="kv">
      <span class="k">requirements</span><span>${esc(j.requirements)}</span>
      <span class="k">budget</span><span>$${j.usd_budget} ≈ ${j.sol_amount ?? "?"} SOL</span>
      <span class="k">escrow account</span><span>${j.escrow_address ? acctLink(j.escrow_address) : `<span class="dim">not initialized</span>`}</span>
      <span class="k">buyer</span><span>user #${j.buyer_id}${isBuyer ? " (you)" : ""}</span>
      <span class="k">freelancer</span><span>${j.freelancer_id ? `user #${j.freelancer_id}${isFreelancer ? " (you)" : ""}` : `<span class="dim">none</span>`}</span>
      <span class="k">round</span><span>${j.round}</span>
    </div>
    <div class="actions">${actionButtons || `<span class="dim">No actions available for your role/state.</span>`}</div>
    <div id="job-action-form" class="muted-box" style="display:none"></div>
    ${apps.length ? `<h3 style="margin-top:14px">Applicants</h3><table><tr><th>id</th><th>freelancer</th><th>headline</th><th>offer</th><th>status</th><th>message</th></tr>
      ${apps.map((a) => `<tr><td>${a.id}</td><td class="mono">${esc(short(a.wallet_address, 10))}</td><td>${esc(a.headline || "")}</td><td>${a.offered_price_sol ?? "—"}</td><td>${esc(a.status)}</td><td>${esc(a.message || "")}</td></tr>`).join("")}</table>` : ""}
    ${neg ? `<h3 style="margin-top:14px">Negotiation (latest)</h3><div class="kv">
      <span class="k">price</span><span>${neg.price_sol} SOL</span>
      <span class="k">scope</span><span>${esc(neg.scope)}</span>
      <span class="k">status</span><span>${esc(neg.status)} (client_agreed=${neg.client_agreed}, freelancer_agreed=${neg.freelancer_agreed})</span></div>` : ""}
    ${d.deliveries && d.deliveries.length ? `<h3 style="margin-top:14px">Deliveries</h3>${d.deliveries.map((x) => `<div class="muted-box">v${x.version} · ${esc(x.note || "")} · ${esc((JSON.parse(x.attachment_urls || "[]") || []).join(", "))}</div>`).join("")}` : ""}
    ${d.dispute ? `<h3 style="margin-top:14px">Dispute #${d.dispute.id}</h3><div class="kv"><span class="k">status</span><span>${esc(d.dispute.status)}</span><span class="k">reason</span><span>${esc(d.dispute.reason)}</span><span class="k">ruling</span><span>${esc(d.dispute.ruling || "pending")}</span></div>` : ""}
    ${txs.length ? `<h3 style="margin-top:14px">Escrow transactions (real signatures)</h3><table><tr><th>type</th><th>amount</th><th>signature</th><th>confirmed</th></tr>
      ${txs.map((t) => `<tr><td>${esc(t.instruction_type)}</td><td>${fmtSol(t.amount_lamports)}</td><td>${t.explorer_url ? `<a href="${esc(t.explorer_url)}" target="_blank" rel="noopener">${esc(short(t.tx_signature, 20))}</a>` : esc(short(t.tx_signature, 20))}</td><td class="dim">${esc(t.confirmed_at || "")}</td></tr>`).join("")}</table>` : ""}
    ${d.messages && d.messages.length ? `<h3 style="margin-top:14px">Messages</h3>${d.messages.map((m) => `<div class="muted-box">user #${m.sender_id}: ${esc(m.body)}</div>`).join("")}` : ""}
  </div>`;
}

async function openJob(id) {
  state.openJobId = id;
  const box = $("#job-detail");
  if (!box) return;
  box.innerHTML = `<div class="card dim">Loading job #${id}…</div>`;
  try {
    const d = await api("GET", `/jobs/${id}`);
    box.innerHTML = renderJobDetail(d);
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    box.innerHTML = `<div class="card err-text">${esc(err.message)}</div>`;
  }
}
// --- job actions ----------------------------------------------------------------------------
const NEEDS_FORM = new Set(["apply", "accept", "decline", "negotiate", "deliver", "reject", "escalate", "rate", "message"]);

function showActionForm(act, jobId) {
  const box = $("#job-action-form");
  if (!box) return;
  const fields = {
    apply: `<label>Message to buyer</label><input id="f-message" value="I can do this" />
            <label>Offered price (SOL, optional)</label><input id="f-price" type="number" step="0.001" placeholder="leave empty to accept the quote" />`,
    accept: `<label>Application id</label><input id="f-appid" type="number" />`,
    decline: `<label>Application id</label><input id="f-appid" type="number" />`,
    negotiate: `<label>Price (SOL)</label><input id="f-price" type="number" step="0.001" />
                <label>Scope</label><input id="f-scope" value="Same as posted requirements" />
                <label>Deadline (optional, ISO date)</label><input id="f-deadline" placeholder="2026-10-01" />`,
    deliver: `<label>Note</label><input id="f-note" value="v1 delivery" />
              <label>Attachment URLs (one per line)</label><textarea id="f-urls">https://example.com/delivery.zip</textarea>`,
    reject: `<label>Rejection reason (required)</label><textarea id="f-reason">Deliverable does not match the brief.</textarea>`,
    escalate: `<label>Why the rejection is wrong</label><textarea id="f-reason">Work followed the agreed brief exactly.</textarea>`,
    rate: `<label>Stars (1-5)</label><input id="f-stars" type="number" min="1" max="5" value="5" />
           <label>Comment</label><input id="f-comment" value="Great work, delivered as agreed." />`,
    message: `<label>Message</label><textarea id="f-body">Quick question about the job…</textarea>`,
  }[act] || "";
  box.style.display = "";
  box.innerHTML = `<div><strong>${esc(JOB_ACTIONS[act] || act)}</strong></div>${fields}
    <div class="actions"><button class="btn" data-act="submit" data-id="${jobId}" data-sub="${act}">Submit</button></div>`;
}

function promptSignFundingModal(jobId, built) {
  return new Promise((resolve, reject) => {
    const overlay = $("#tx-modal-overlay");
    const mFrom = $("#m-from");
    const mTo = $("#m-to");
    const mAmount = $("#m-amount");
    const mStatus = $("#m-status-box");
    const btnCancel = $("#m-btn-cancel");
    const btnSign = $("#m-btn-sign");
    const btnSolscan = $("#m-btn-solscan");

    mFrom.textContent = short(state.wallet, 16);
    mTo.textContent = short(built.to, 16);
    mAmount.textContent = fmtSol(built.lamports) + " SOL";

    mStatus.style.display = "none";
    mStatus.innerHTML = "";
    btnCancel.style.display = "";
    btnCancel.textContent = "Cancel";
    btnSign.style.display = "";
    btnSign.disabled = false;
    btnSolscan.style.display = "none";

    overlay.style.display = "flex";

    btnCancel.onclick = () => {
      overlay.style.display = "none";
      reject(new Error("Transaction cancelled by user"));
    };

    btnSign.onclick = async () => {
      try {
        btnSign.disabled = true;
        btnCancel.style.display = "none";
        mStatus.style.display = "block";
        mStatus.style.background = "#131a22";
        mStatus.style.border = "1px solid #3b82f6";
        mStatus.style.color = "#6ea8fe";
        mStatus.innerHTML = `✍️ <strong>Step 1/2:</strong> Signing transaction client-side with Ed25519 keypair...`;

        let rawTxHex = "";
        let signature = "";

        if (state.secretKeyB58 && window.solanaWeb3) {
          let blockhash = built.blockhash;
          if (!blockhash) {
            const tempConn = new solanaWeb3.Connection("https://api.devnet.solana.com", "confirmed");
            const latest = await tempConn.getLatestBlockhash();
            blockhash = latest.blockhash;
          }
          const secret = b58decode(state.secretKeyB58);
          const kp = solanaWeb3.Keypair.fromSecretKey(secret);
          const tx = new solanaWeb3.Transaction();
          tx.recentBlockhash = blockhash;
          tx.feePayer = kp.publicKey;
          tx.add(solanaWeb3.SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: new solanaWeb3.PublicKey(built.to),
            lamports: Number(built.lamports),
          }));
          tx.sign(kp);
          const serialized = tx.serialize();
          rawTxHex = Array.from(serialized).map((b) => b.toString(16).padStart(2, "0")).join("");
          signature = b58encode(tx.signatures[0].signature);
        } else {
          const signed = await api("POST", "/demo/sign-transfer", { wallet: state.wallet, to: built.to, lamports: built.lamports });
          rawTxHex = signed.raw_tx_hex;
          signature = signed.signature;
        }

        mStatus.innerHTML = `📡 <strong>Step 2/2:</strong> Broadcasting to Solana Devnet & awaiting confirmation...<br/><span class="mono dim" style="font-size:11px;">Sig: ${short(signature, 16)}</span>`;

        const confirmed = await api("POST", `/escrow/${jobId}/fund/confirm`, {
          raw_tx_hex: rawTxHex,
          signature: signature,
        });

        const solscanUrl = `https://solscan.io/tx/${confirmed.signature}?cluster=devnet`;
        mStatus.style.background = "#052e16";
        mStatus.style.border = "1px solid #22c55e";
        mStatus.style.color = "#4ade80";
        mStatus.innerHTML = `✅ <strong>Confirmed on Solana Devnet!</strong><br/><span class="mono" style="font-size:11px;">Sig: ${short(confirmed.signature, 16)}</span>`;

        btnSign.style.display = "none";
        btnCancel.style.display = "";
        btnCancel.textContent = "Done";
        btnCancel.onclick = () => {
          overlay.style.display = "none";
          resolve(confirmed);
        };

        btnSolscan.href = solscanUrl;
        btnSolscan.style.display = "inline-flex";
      } catch (err) {
        btnSign.disabled = false;
        btnCancel.style.display = "";
        mStatus.style.background = "#450a0a";
        mStatus.style.border = "1px solid #ef4444";
        mStatus.style.color = "#f87171";
        mStatus.innerHTML = `❌ <strong>Error:</strong> ${esc(err.message)}`;
      }
    };
  });
}

async function runAction(act, jobId) {
  const val = (id) => { const el = $(id); return el ? el.value.trim() : ""; };
  switch (act) {
    case "initEscrow": {
      const r = await api("POST", `/escrow/${jobId}/init`, {});
      toast(`Escrow account ${r.address}\nRent paid by platform — now fund it.`, "ok");
      break;
    }
    case "fund": {
      const built = await api("POST", `/escrow/${jobId}/fund/build-tx`, {});
      const confirmed = await promptSignFundingModal(jobId, built);
      toast(`Funded on-chain!\nSolscan: https://solscan.io/tx/${confirmed.signature}?cluster=devnet`, "ok");
      renderAll();
      break;
    }
    case "apply": {
      const body = { message: val("#f-message") };
      if (val("#f-price")) body.offered_price_sol = Number(val("#f-price"));
      await api("POST", `/jobs/${jobId}/apply`, body);
      toast("Application submitted.", "ok");
      break;
    }
    case "accept":
      await api("POST", `/jobs/${jobId}/applications/${val("#f-appid")}/accept`, {});
      toast("Applicant accepted — job moved to negotiating.", "ok");
      break;
    case "decline":
      await api("POST", `/jobs/${jobId}/applications/${val("#f-appid")}/decline`, {});
      toast("Applicant declined.", "ok");
      break;
    case "negotiate": {
      const body = { price_sol: Number(val("#f-price")), scope: val("#f-scope") };
      if (val("#f-deadline")) body.deadline = val("#f-deadline");
      await api("POST", `/jobs/${jobId}/negotiate`, body);
      toast("Offer sent (counter-offers supersede).", "ok");
      break;
    }
    case "agree": {
      const r = await api("POST", `/jobs/${jobId}/agree`, {});
      toast(r.job.status === "agreed" ? "Both sides agreed — work can start." : "Agreement recorded; waiting for the other side.", "ok");
      break;
    }
    case "start":
      await api("POST", `/jobs/${jobId}/start`, {});
      toast("Work started.", "ok");
      break;
    case "deliver": {
      const urls = val("#f-urls").split("\n").map((s) => s.trim()).filter(Boolean);
      const r = await api("POST", `/jobs/${jobId}/deliveries`, { note: val("#f-note"), attachment_urls: urls });
      toast(`Delivery v${r.version} submitted — awaiting buyer decision.`, "ok");
      break;
    }
    case "approve": {
      const r = await api("POST", `/jobs/${jobId}/approve`, {});
      toast(`Approved — on-chain release tx:\n${r.release.signature}`, "ok");
      break;
    }
    case "reject":
      await api("POST", `/jobs/${jobId}/reject`, { reason: val("#f-reason") });
      toast("Job rejected — freelancer may back off or escalate.", "ok");
      break;
    case "backoff": {
      const r = await api("POST", `/jobs/${jobId}/backoff`, {});
      toast(`Backed off — buyer refunded on-chain:\n${r.refund.signature}`, "ok");
      break;
    }
    case "escalate": {
      const r = await api("POST", `/jobs/${jobId}/escalate`, { reason: val("#f-reason") });
      toast(`Escalated — dispute #${r.dispute_id} opened in the support queue.`, "ok");
      break;
    }
    case "relist":
      await api("POST", `/jobs/${jobId}/relist`, {});
      toast("Job re-listed (same escrow funds, new round).", "ok");
      break;
    case "closeHeld": {
      const r = await api("POST", `/jobs/${jobId}/close-held`, {});
      toast(`Held job closed — buyer refunded on-chain:\n${r.refund.signature}`, "ok");
      break;
    }
    case "rate":
      await api("POST", `/jobs/${jobId}/rating`, { stars: Number(val("#f-stars")), comment: val("#f-comment") });
      toast("Rating submitted.", "ok");
      break;
    case "message":
      await api("POST", `/jobs/${jobId}/messages`, { body: val("#f-body") });
      toast("Message sent.", "ok");
      break;
    default:
      throw new Error("unknown action " + act);
  }
  await openJob(jobId);
  if (state.tab === "jobs") renderView();
}

async function createJob() {
  const title = $("#j-title").value.trim();
  const requirements = $("#j-req").value.trim();
  const usd = Number($("#j-usd").value);
  if (!title || !requirements || !usd) { toast("Title, requirements and budget are required.", "err"); return; }
  const r = await api("POST", "/jobs", { title, requirements, usd_budget: usd });
  $("#create-result").style.display = "";
  $("#create-result").innerHTML = `Job #${r.job.id} created. Real Gemini quote: 1 SOL = $${r.quote.rate} → escrow target <strong>${fmtSol(r.sol_lamports)} SOL</strong> (source: ${esc(r.quote.source)}, ${esc(r.quote.fetchedAt)}).<br/>Open the job and press “Init escrow account” → “Fund escrow”.`;
  toast(`Job #${r.job.id} posted.`, "ok");
  renderView();
  if (state.openJobId === null) state.openJobId = r.job.id;
}

// --- profile (freelancer onboarding + portfolio) ----------------------------------------
async function renderProfile(v) {
  v.innerHTML = `<div class="card dim">Loading profile…</div>`;
  let p = null, items = { items: [] };
  try { p = await api("GET", "/me/profile"); } catch {}
  try { items = await api("GET", "/me/portfolio"); } catch {}
  const tax = state.taxonomy;
  const selected = new Set((p?.subdomains || []).map((s) => s.id));
  v.innerHTML = `
    <div class="card"><h3>Onboarding — pick your domains and subdomains</h3>
      <label>Headline</label><input id="p-headline" value="${esc(p?.profile?.headline || "")}" placeholder="e.g. Motion designer — product videos" />
      <label>Bio</label><textarea id="p-bio">${esc(p?.profile?.bio || "")}</textarea>
      <div id="p-tax">
        ${tax.map((d) => `<div style="margin-top:8px"><div class="dim">${esc(d.name)}</div>
          ${d.subdomains.map((s) => `<label style="display:inline-block;margin:2px 10px 2px 0"><input type="checkbox" style="width:auto" value="${s.id}" ${selected.has(s.id) ? "checked" : ""} /> ${esc(s.name)}</label>`).join("")}</div>`).join("")}
      </div>
      <div class="actions"><button class="btn" data-act="saveOnboarding">Save onboarding</button></div>
    </div>
    <div class="card"><h3>Portfolio ${p?.portfolio_ready ? `<span class="pill ok">published</span>` : `<span class="pill err">not published — applications blocked</span>`}</h3>
      ${items.items.length ? items.items.map((i) => `<div class="muted-box">${esc(i.title || "(untitled)")} — <a href="${esc(i.media_url)}" target="_blank" rel="noopener">${esc(short(i.media_url, 40))}</a> · ${esc(i.media_type || "link")}</div>`).join("") : `<div class="dim">No items yet — add at least one to publish.</div>`}
      <label>Title</label><input id="pf-title" placeholder="Showreel 2026" />
      <label>Media URL</label><input id="pf-url" placeholder="https://…" />
      <label>Media type</label><select id="pf-type"><option>video</option><option>image</option><option>link</option><option>document</option></select>
      <div class="actions">
        <button class="btn sec" data-act="addPortfolio">Add item</button>
        <button class="btn" data-act="publishPortfolio">Publish profile (marketplace-visible)</button>
      </div>
    </div>`;
}

async function saveOnboarding() {
  const headline = $("#p-headline").value.trim();
  const bio = $("#p-bio").value.trim();
  const ids = Array.from(document.querySelectorAll("#p-tax input:checked")).map((c) => Number(c.value));
  await api("POST", "/me/onboarding", { headline, bio, subdomain_ids: ids });
  toast("Onboarding saved.", "ok");
  renderView();
}

async function addPortfolio() {
  await api("POST", "/me/portfolio", { title: $("#pf-title").value.trim(), media_url: $("#pf-url").value.trim(), media_type: $("#pf-type").value });
  toast("Portfolio item added.", "ok");
  renderView();
}

async function publishPortfolio() {
  await api("POST", "/me/portfolio/publish", {});
  toast("Profile published — you are marketplace-visible.", "ok");
  renderView();
}

// --- directory (client discovery) ----------------------------------------------------------
async function renderDirectory(v) {
  v.innerHTML = `<div class="card dim">Loading freelancers…</div>`;
  const tax = state.taxonomy;
  const opts = tax.map((d) => `<optgroup label="${esc(d.name)}">${d.subdomains.map((s) => `<option value="${s.id}">${esc(d.name)} / ${esc(s.name)}</option>`).join("")}</optgroup>`).join("");
  let list = [];
  try { list = (await api("GET", "/freelancers")).freelancers; } catch (err) { toast(err.message, "err"); }
  v.innerHTML = `
    <div class="card"><h3>Search freelancers</h3>
      <div class="row">
        <div style="flex:1 1 220px"><label>Subdomain</label><select id="d-sub"><option value="">any</option>${opts}</select></div>
        <div style="flex:0 1 120px"><label>Min rating</label><input id="d-rating" type="number" min="0" max="5" value="0" /></div>
        <div style="flex:0 0 auto"><label>&nbsp;</label><button class="btn" data-act="searchFreelancers">Search</button></div>
      </div>
      <div id="d-results">${freelancerTable(list)}</div>
    </div>`;
}

function freelancerTable(list) {
  if (!list.length) return `<div class="dim">No published freelancers match.</div>`;
  return `<table><tr><th>id</th><th>headline</th><th>skills</th><th>rating</th><th>wallet</th></tr>
    ${list.map((f) => `<tr><td>${f.id}</td><td>${esc(f.headline || "")}</td><td>${esc(f.skills || "")}</td><td>${f.avg_rating ?? "—"} (${f.rating_count})</td><td class="mono">${esc(short(f.wallet_address, 10))}</td></tr>`).join("")}</table>`;
}

async function searchFreelancers() {
  const sub = $("#d-sub").value;
  const min = $("#d-rating").value || 0;
  const qs = `?min_rating=${min}` + (sub ? `&subdomain=${sub}` : "");
  const r = await api("GET", `/freelancers${qs}`);
  $("#d-results").innerHTML = freelancerTable(r.freelancers);
}
// --- support desk (disputes + tickets) ----------------------------------------------------------
async function renderSupport(v) {
  v.innerHTML = `<div class="card dim">Loading support queues…</div>`;
  let disputes = [], tickets = [];
  try { disputes = (await api("GET", "/disputes")).disputes; } catch (err) { toast(err.message, "err"); }
  try { tickets = (await api("GET", "/tickets")).tickets; } catch {}
  v.innerHTML = `
    <div class="card"><h3>Dispute queue (${disputes.filter((d) => d.status === "open").length} open)</h3>
      ${disputes.length ? `<table><tr><th>id</th><th>job</th><th>raised by</th><th>reason</th><th>status</th><th></th></tr>
        ${disputes.map((d) => `<tr><td>${d.id}</td><td>#${d.job_id} ${esc(d.job_title)} ${pill(d.job_status)}</td><td class="mono">${esc(short(d.raised_by_wallet, 10))}</td><td>${esc(d.reason)}</td><td>${esc(d.status)}</td><td><button class="btn sec" data-act="openDispute" data-id="${d.id}">Open evidence + rule</button></td></tr>`).join("")}</table>` : `<div class="dim">No disputes.</div>`}
      <div id="dispute-detail"></div>
    </div>
    <div class="card"><h3>Help desk (${tickets.filter((t) => t.status !== "resolved").length} unresolved)</h3>
      ${tickets.length ? `<table><tr><th>id</th><th>subject</th><th>from</th><th>status</th><th></th></tr>
        ${tickets.map((t) => `<tr><td>${t.id}</td><td>${esc(t.subject)}</td><td class="mono">${esc(short(t.wallet_address, 10))} (${esc(t.user_role)})</td><td>${esc(t.status)}</td><td><button class="btn sec" data-act="openTicket" data-id="${t.id}">Open</button></td></tr>`).join("")}</table>` : `<div class="dim">No tickets.</div>`}
      <div id="ticket-detail"></div>
    </div>`;
  if (state.openDisputeId) openDispute(state.openDisputeId);
  if (state.openTicketId) openTicket(state.openTicketId);
}

async function openDispute(id) {
  state.openDisputeId = id;
  const box = $("#dispute-detail");
  if (!box) return;
  box.innerHTML = `<div class="muted-box dim">Loading dispute #${id}…</div>`;
  try {
    const { dispute, evidence } = await api("GET", `/disputes/${id}`);
    const ev = evidence;
    box.innerHTML = `<div class="muted-box">
      <h3>Dispute #${dispute.id} — job #${ev.job.id} “${esc(ev.job.title)}” ${pill(dispute.status)}</h3>
      <div class="kv">
        <span class="k">buyer</span><span class="mono">${esc(short(ev.buyer?.wallet_address, 14))} ${esc(ev.buyer?.organization || "")}</span>
        <span class="k">freelancer</span><span class="mono">${ev.freelancer ? esc(short(ev.freelancer.wallet_address, 14)) : "detached"} ${esc(ev.freelancer?.headline || "")}</span>
        <span class="k">escrow</span><span>${ev.job.escrow_address ? acctLink(ev.job.escrow_address) : "—"}</span>
        <span class="k">reason</span><span>${esc(dispute.reason)}</span>
      </div>
      <div style="margin-top:10px"><strong>Negotiation log</strong>${(ev.negotiation || []).map((n) => `<div class="dim">offer_by #${n.offer_by} · ${n.price_sol} SOL · ${esc(n.scope)} · ${esc(n.status)}</div>`).join("") || `<div class="dim">none</div>`}</div>
      <div style="margin-top:10px"><strong>Deliveries</strong>${(ev.deliveries || []).map((x) => `<div class="dim">v${x.version} · ${esc(x.note || "")} · ${esc((JSON.parse(x.attachment_urls || "[]") || []).join(", "))}</div>`).join("") || `<div class="dim">none</div>`}</div>
      <div style="margin-top:10px"><strong>Messages</strong>${(ev.messages || []).map((m) => `<div class="dim">user #${m.sender_id}: ${esc(m.body)}</div>`).join("") || `<div class="dim">none</div>`}</div>
      <div style="margin-top:10px"><strong>Escrow txs</strong>${(ev.escrow_transactions || []).map((t) => `<div class="dim">${esc(t.instruction_type)} · ${fmtSol(t.amount_lamports)} SOL · ${txLink(t.tx_signature)}</div>`).join("") || `<div class="dim">none</div>`}</div>
      ${dispute.status === "open" ? `
        <label>Ruling</label><select id="dr-outcome"><option value="release_freelancer">Release funds to freelancer (buyer was wrong)</option><option value="hold_buyer">Keep funds held, detach freelancer (buyer was right)</option></select>
        <label>Notes (required, immutable once issued)</label><textarea id="dr-notes">Reviewed negotiation log, deliveries and escrow history.</textarea>
        <div class="actions"><button class="btn danger" data-act="ruleDispute" data-id="${dispute.id}">Issue binding ruling</button></div>` : `<div class="ok-text">Ruled already — immutable. ${esc(dispute.ruling || "")}</div>`}
    </div>`;
  } catch (err) {
    box.innerHTML = `<div class="muted-box err-text">${esc(err.message)}</div>`;
  }
}

async function ruleDispute(id) {
  const outcome = $("#dr-outcome").value;
  const notes = $("#dr-notes").value.trim();
  const r = await api("POST", `/disputes/${id}/rule`, { outcome, notes });
  const chain = r.chainResult ? `\nrelease tx: ${r.chainResult.signature}` : "\nfunds remain held on-chain, freelancer detached";
  toast(`Ruling issued: ${outcome}${chain}`, "ok");
  renderView();
}

async function openTicket(id) {
  state.openTicketId = id;
  const box = $("#ticket-detail");
  if (!box) return;
  box.innerHTML = `<div class="muted-box dim">Loading ticket #${id}…</div>`;
  try {
    const { ticket, replies } = await api("GET", `/tickets/${id}`);
    box.innerHTML = `<div class="muted-box">
      <h3>Ticket #${ticket.id} — ${esc(ticket.subject)} ${pill(ticket.status)}${ticket.dispute_id ? ` (dispute #${ticket.dispute_id})` : ""}</h3>
      ${replies.map((r) => `<div class="muted-box"><strong>${esc(r.sender_role)}</strong> <span class="mono dim">${esc(short(r.wallet_address, 10))}</span>: ${esc(r.body)}</div>`).join("")}
      <label>Reply as staff</label><textarea id="tk-reply">Thanks — a support agent is reviewing this.</textarea>
      <div class="actions">
        <button class="btn sec" data-act="replyTicket" data-id="${ticket.id}">Send reply</button>
        <button class="btn ok" data-act="resolveTicket" data-id="${ticket.id}">Mark resolved</button>
      </div>
    </div>`;
  } catch (err) {
    box.innerHTML = `<div class="muted-box err-text">${esc(err.message)}</div>`;
  }
}

async function replyTicket(id) {
  await api("POST", `/tickets/${id}/reply`, { body: $("#tk-reply").value.trim() });
  toast("Reply sent.", "ok");
  openTicket(id);
}

async function resolveTicket(id) {
  await api("POST", `/tickets/${id}/resolve`, {});
  toast("Ticket resolved.", "ok");
  renderView();
}

// --- leaderboard ------------------------------------------------------------------------------------
async function renderLeaderboard(v) {
  v.innerHTML = `<div class="card dim">Loading leaderboard…</div>`;
  let rows = [];
  try { rows = (await api("GET", "/leaderboard")).leaderboard; } catch (err) { toast(err.message, "err"); }
  v.innerHTML = `<div class="card"><h3>Freelancer leaderboard</h3>
    <div class="dim" style="margin-bottom:8px">Composite score: completion 0.4 + rating 0.3 + on-time 0.15 − dispute-loss 0.15</div>
    ${rows.length ? `<table><tr><th>#</th><th>freelancer</th><th>headline</th><th>score</th><th>completed</th><th>rating</th><th>computed</th></tr>
      ${rows.map((r, i) => `<tr><td>${i + 1}</td><td>#${r.freelancer_id} <span class="mono dim">${esc(short(r.wallet_address, 8))}</span></td><td>${esc(r.headline || "")}</td><td><strong>${r.score}</strong></td><td>${r.breakdown.completed_jobs ?? 0}/${r.breakdown.total_jobs ?? 0}</td><td>${r.breakdown.avg_rating ?? "—"}</td><td class="dim">${esc(r.computed_at || "")}</td></tr>`).join("")}</table>` : `<div class="dim">No scores yet — complete a job to appear here.</div>`}
  </div>`;
}

// --- dev console ---------------------------------------------------------------------------------------
async function renderDev(v) {
  v.innerHTML = `<div class="card dim">Loading dev console…</div>`;
  let health = null, recon = null, audit = null, users = null, jobs = null;
  try { health = await api("GET", "/admin/health"); } catch (err) { toast(err.message, "err"); }
  try { recon = (await api("GET", "/admin/reconciliation")).reconciliations; } catch {}
  try { audit = (await api("GET", "/admin/audit?limit=50")).actions; } catch {}
  try { users = (await api("GET", "/admin/users")).users; } catch {}
  try { jobs = (await api("GET", "/admin/jobs")).jobs; } catch {}
  v.innerHTML = `
    <div class="card"><h3>System health</h3>
      ${health ? `<div class="kv">
        <span class="k">chain</span><span>${esc(health.chain)}</span>
        <span class="k">rpc</span><span>${health.rpc.ok ? `<span class="ok-text">live · slot ${health.rpc.slot} · solana-core ${esc(health.rpc.solanaVersion)}</span>` : `<span class="err-text">unreachable: ${esc(health.rpc.error)}</span>`}</span>
        <span class="k">endpoint</span><span class="mono">${esc(health.rpc.endpoint || "")}</span>
        <span class="k">counts</span><span>users ${health.counts.users} · jobs ${health.counts.jobs} · escrow txs ${health.counts.escrow_txs} · open disputes ${health.counts.disputes_open} · open tickets ${health.counts.tickets_open}</span></div>` : `<div class="err-text">health unavailable</div>`}
      <div class="actions"><button class="btn sec" data-act="reload">Refresh</button></div>
    </div>
    <div class="card"><h3>Escrow reconciliation (DB vs chain)</h3>
      ${recon && recon.length ? `<table><tr><th>job</th><th>status</th><th>on-chain lamports</th><th>db funded</th><th>ok</th></tr>
        ${recon.map((r) => `<tr><td>#${r.jobId} <span class="mono dim">${esc(short(r.address, 8))}</span></td><td>${esc(r.status)}</td><td>${r.onChainLamports}</td><td>${r.dbNetLamports}</td><td>${r.ok ? `<span class="ok-text">✓</span>` : `<span class="err-text">mismatch</span>`}</td></tr>`).join("")}</table>` : `<div class="dim">No escrow accounts yet.</div>`}
    </div>
    <div class="card"><h3>Users (support + dev read, status writes audited)</h3>
      ${users ? `<table><tr><th>id</th><th>role</th><th>status</th><th>wallet</th><th>posted</th><th>completed</th><th>funded (SOL)</th><th>actions</th></tr>
        ${users.map((u) => `<tr><td>${u.id}</td><td>${esc(u.role)}</td><td>${esc(u.status)}</td><td class="mono">${esc(short(u.wallet_address, 8))}</td><td>${u.jobs_posted}</td><td>${u.jobs_completed}</td><td>${fmtSol(u.sol_funded_lamports)}</td><td><button class="btn sec" data-act="toggleUser" data-id="${u.id}" data-status="${u.status === "active" ? "suspended" : "active"}">${u.status === "active" ? "Suspend" : "Reactivate"}</button></td></tr>`).join("")}</table>` : `<div class="dim">unavailable</div>`}
    </div>
    <div class="card"><h3>Audit trail (last 50 privileged actions)</h3>
      ${audit ? `<table><tr><th>id</th><th>actor</th><th>action</th><th>target</th><th>before → after</th><th>when</th></tr>
        ${audit.map((a) => `<tr><td>${a.id}</td><td>#${a.actor_id}</td><td>${esc(a.action_type)}</td><td>${esc(a.target_entity)} #${a.target_id ?? ""}</td><td class="mono">${esc(short(a.before_state, 40))} → ${esc(short(a.after_state, 60))}</td><td class="dim">${esc(a.created_at)}</td></tr>`).join("")}</table>` : `<div class="dim">empty</div>`}
    </div>
    <div class="card"><h3>All jobs</h3>
      ${jobs && jobs.length ? `<table><tr><th>id</th><th>title</th><th>status</th><th>buyer</th><th>freelancer</th><th>round</th><th>escrow</th></tr>
        ${jobs.map((j) => `<tr><td>${j.id}</td><td>${esc(j.title)}</td><td>${pill(j.status)}</td><td>#${j.buyer_id}</td><td>${j.freelancer_id ? "#" + j.freelancer_id : "—"}</td><td>${j.round}</td><td class="mono">${j.escrow_address ? acctLink(j.escrow_address) : "—"}</td></tr>`).join("")}</table>` : `<div class="dim">no jobs</div>`}
    </div>`;
}

async function toggleUser(id, status) {
  await api("POST", `/admin/users/${id}/status`, { status });
  toast(`User #${id} → ${status} (audited).`, "ok");
  renderView();
}

// --- global click routing --------------------------------------------------------------------------------
document.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id ? Number(btn.dataset.id) : null;
  try {
    if (act === "openJob") return openJob(id);
    if (act === "submit") return runAction(btn.dataset.sub, id);
    if (act === "createJob") return createJob();
    if (act === "saveOnboarding") return saveOnboarding();
    if (act === "addPortfolio") return addPortfolio();
    if (act === "publishPortfolio") return publishPortfolio();
    if (act === "searchFreelancers") return searchFreelancers();
    if (act === "openDispute") return openDispute(id);
    if (act === "ruleDispute") return ruleDispute(id);
    if (act === "openTicket") return openTicket(id);
    if (act === "replyTicket") return replyTicket(id);
    if (act === "resolveTicket") return resolveTicket(id);
    if (act === "toggleUser") return toggleUser(id, btn.dataset.status);
    if (act === "reload") return renderView();
    if (NEEDS_FORM.has(act)) return showActionForm(act, id);
  } catch (err) {
    toast(err.message, "err");
  }
});

$("#btn-logout").onclick = () => logout();
$("#btn-airdrop").onclick = async () => {
  try {
    const r = await api("POST", "/demo/airdrop", { wallet: state.wallet });
    toast(`Airdrop requested: ${r.signature}`, "ok");
    setTimeout(renderBalance, 2500);
  } catch (err) { toast("Airdrop failed (devnet faucet rate limit?): " + err.message, "err"); }
};
$("#btn-copy").onclick = () => { navigator.clipboard.writeText(state.wallet); toast("Wallet address copied.", "ok"); };

init();

