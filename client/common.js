/* Solhustle Shared Client Library */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// --- Base58 Encoding / Decoding ---
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

// --- API Client ---
async function api(method, path, body, token, opts) {
  const headers = { "content-type": "application/json", ...(opts && opts.headers) };
  if (token) headers["authorization"] = "Bearer " + token;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const errMsg = (json && (json.error || json.message)) || text || `${res.status} ${res.statusText}`;
    const err = new Error(errMsg);
    err.status = res.status;
    throw err;
  }
  return json !== null ? json : text;
}

// --- Toast Notifications ---
function toast(msg, kind = "") {
  let container = $("#toasts");
  if (!container) {
    container = document.createElement("div");
    container.id = "toasts";
    document.body.appendChild(container);
  }
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 7000);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const fmtSol = (lamports) => (Number(lamports || 0) / 1e9).toFixed(6);
const short = (s, n = 10) => (s ? String(s).slice(0, n) + "…" : "");
const fmtDate = (v) => {
  if (!v) return "";
  const d = new Date(String(v).replace(" ", "T") + (String(v).includes("Z") || String(v).includes("+") ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

const explorerCluster = "devnet";
const txLink = (sig) =>
  `<a href="https://solscan.io/tx/${esc(sig)}?cluster=${explorerCluster}" target="_blank" rel="noopener" class="link">` +
  `${esc(short(sig, 12))}</a>`;

const acctLink = (addr) =>
  `<a href="https://solscan.io/account/${esc(addr)}?cluster=${explorerCluster}" target="_blank" rel="noopener" class="link mono">` +
  `${esc(short(addr, 12))}</a>`;

const STATUS_PILL = {
  released: "ok", closed_no_payout: "dim", funded: "warn", agreed: "warn",
  in_progress: "warn", delivered: "info", rejected: "err", disputed: "err", held_detached: "err",
  created: "dim", negotiating: "warn",
};
const pill = (status) => {
  const label = String(status || "").replace(/_/g, " ");
  return `<span class="pill ${STATUS_PILL[status] || ""}">${esc(label)}</span>`;
};

// ---------------------------------------------------------------------------
// Session
//
// One session for the whole product. The old build kept a separate
// `solhustle.auth.<portal>` entry per portal, which is exactly why switching
// between Buyer and Seller felt like logging in twice. The legacy keys are
// still read once, so nobody gets signed out by the move.
// ---------------------------------------------------------------------------
const SESSION_KEY = "solhustle.session";
const LEGACY_SESSION_KEYS = [
  "solhustle.auth.global",
  "solhustle.auth.buyer",
  "solhustle.auth.client",
  "solhustle.auth.seller",
  "solhustle.auth.freelancer",
  "solhustle.auth.admin",
];

function readSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  for (const key of LEGACY_SESSION_KEYS) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.token) {
        writeSession(parsed);
        for (const k of LEGACY_SESSION_KEYS) sessionStorage.removeItem(k);
        return parsed;
      }
    } catch {}
  }
  return null;
}

function writeSession(payload) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload)); } catch {}
  return payload;
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  for (const k of LEGACY_SESSION_KEYS) {
    try { sessionStorage.removeItem(k); } catch {}
  }
}

/** Roles the account may switch into. Falls back to the single active role. */
function sessionRoles(session) {
  const roles = session && session.user && Array.isArray(session.user.roles) ? session.user.roles : null;
  if (roles && roles.length) return roles;
  return session && session.user && session.user.role ? [session.user.role] : [];
}

const isStaff = (session) => {
  const r = session && session.user ? session.user.role : null;
  return r === "dev" || r === "support";
};

const ROLE_LABEL = { client: "Client", freelancer: "Freelancer", dev: "Operator", support: "Support" };
const roleLabel = (role) => ROLE_LABEL[role] || role || "";
const roleHome = (role) =>
  role === "dev" || role === "support" ? "/app#/operator" : "/app#/";

function initials(session) {
  const name = (session && (session.username || session.actorName)) || "";
  const cleaned = String(name).replace(/[^a-zA-Z0-9 ]/g, " ").trim();
  if (!cleaned) return "SH";
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

async function logout() {
  const session = readSession();
  clearSession();
  if (session && session.provider === "auth0") {
    window.location.href = "/auth/auth0/logout";
    return;
  }
  if (session && session.token) {
    try { await api("POST", "/auth/logout", {}, session.token); } catch {}
  }
  window.location.href = "/login";
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
/**
 * The brand mark: two vault halves that hook together around a lime gem.
 *
 * Inline rather than an <img> so the strokes inherit `currentColor` — the same
 * file then works on the light nav, the dark footer and the auth card without a
 * second asset, and it costs nothing extra to load.
 */
function brandMark(extraClass = "") {
  return `<span class="brand-mark${extraClass ? " " + extraClass : ""}" aria-hidden="true">
    <svg viewBox="0 0 32 32" fill="none">
      <path d="M14.6 4.2 5.6 9.6v12.8l9 5.4" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M17.4 4.2 26.4 9.6v12.8l-9 5.4" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M16 12.4 19.1 16 16 19.6 12.9 16Z" class="brand-gem"/>
    </svg>
  </span>`;
}

const BRAND_HTML = `
  <a href="/" class="brand">
    ${brandMark()}
    <span class="brand-word">Solhustle</span>
  </a>`;

/**
 * Unread count for the nav badge. One COUNT(*) server-side, so polling it every
 * half-minute is cheaper than the request that renders the page it sits on.
 */
async function refreshUnreadBadge(session) {
  const s = session || readSession();
  if (!s || !s.token) return 0;
  let unread = 0;
  try {
    unread = Number((await api("GET", "/me/unread", undefined, s.token)).unread || 0);
  } catch {
    return 0;
  }
  const badge = document.querySelector("[data-unread]");
  if (badge) {
    badge.textContent = unread > 99 ? "99+" : String(unread);
    badge.hidden = unread === 0;
  }
  const link = document.querySelector("[data-messages-link]");
  if (link) link.classList.toggle("has-unread", unread > 0);
  return unread;
}

/**
 * Marketing / auth nav. Deliberately thin: the landing page carries its own
 * in-page anchors, and the auth pages only need a way home.
 */
function renderNavbar(activePage) {
  const marketing = activePage === "landing";
  const onAuth = activePage === "login" || activePage === "signup";

  const links = onAuth
    ? []
    : marketing
      ? [["#product", "Product"], ["#how", "How it works"], ["#why", "Why escrow"], ["#faq", "FAQ"], ["/browse", "Browse talent"], ["#creators", "Creators"]]
      : [];

  const navLinks = links
    .map(([href, label]) => `<a href="${href}" class="nav-link">${label}</a>`)
    .join("");
  const navHtml = navLinks ? `<nav class="nav-links">${navLinks}</nav>` : "";

  const session = readSession();
  const rightSlot = session
    ? `<a href="/app" class="btn btn-pill btn-sm">Open app</a>`
    : `<a href="/login" class="nav-link">Sign in</a>
       <a href="/signup" class="btn btn-pill btn-sm">Get started</a>`;

  const header = document.createElement("header");
  header.className = "app-nav";
  header.innerHTML = `${BRAND_HTML}${navHtml}<div class="row nav-right" id="nav-right-slot">${rightSlot}</div>`;
  document.body.prepend(header);
  bindNavScroll(header);
}

/** Elevate the nav once the page has scrolled (ported from the reference site). */
function bindNavScroll(header) {
  const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 8);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

const APP_NAV_LINKS = {
  client: [
    ["/app#/", "Dashboard"],
    ["/app#/messages", "Messages"],
    ["/app#/jobs", "My jobs"],
    ["/app#/browse", "Find freelancers"],
    ["/app#/jobs/new", "Post a job"],
  ],
  freelancer: [
    ["/app#/", "Dashboard"],
    ["/app#/messages", "Messages"],
    // `#/work` (open contracts), not `#/browse` (the talent directory).
    ["/app#/work", "Find work"],
    ["/app#/jobs", "My contracts"],
    ["/app#/me", "My profile"],
  ],
  dev: [
    ["/app#/", "Dashboard"],
    ["/app#/messages", "Messages"],
    ["/app#/jobs", "Jobs"],
    ["/app#/browse", "Freelancers"],
    ["/app#/operator", "Operator"],
  ],
  support: [
    ["/app#/", "Dashboard"],
    ["/app#/messages", "Messages"],
    ["/app#/jobs", "Jobs"],
    ["/app#/browse", "Freelancers"],
    ["/app#/operator", "Operator"],
  ],
};

/** The signed-in nav: brand, role-appropriate links, and an account menu. */
function renderAppNav(session, active) {
  const mount = $("#app-nav");
  if (!mount) return;
  const role = session && session.user ? session.user.role : "client";
  const links = (APP_NAV_LINKS[role] || APP_NAV_LINKS.client)
    .map(([href, label]) => {
      const key = href.replace("/app#", "");
      const on = key === active || (key !== "/" && active.startsWith(key));
      // Messages carries the unread badge, filled in by refreshUnreadBadge().
      if (href === "/app#/messages") {
        return `<a href="${href}" class="nav-link${on ? " active" : ""}" data-messages-link>${label}<span class="nav-badge" data-unread hidden></span></a>`;
      }
      return `<a href="${href}" class="nav-link${on ? " active" : ""}">${label}</a>`;
    })
    .join("");

  const roles = sessionRoles(session);
  const other = roles.filter((r) => r !== role && (r === "client" || r === "freelancer"));
  const missing = ["client", "freelancer"].filter((r) => !roles.includes(r));

  const menuItem = (action, label, hint) =>
    `<button class="menu-item" data-menu-action="${action}" type="button">` +
    `<span>${label}</span>${hint ? `<small>${hint}</small>` : ""}</button>`;

  const switchItems = other
    .map((r) => menuItem(`switch:${r}`, `Switch to ${roleLabel(r).toLowerCase()}`, "Keep the same account"))
    .join("");
  const grantItems = missing
    .map((r) =>
      menuItem(
        `grant:${r}`,
        r === "freelancer" ? "Become a freelancer" : "Start hiring",
        r === "freelancer" ? "Offer your own services" : "Post your own contracts",
      ),
    )
    .join("");

  mount.innerHTML = `
    ${BRAND_HTML}
    <nav class="nav-links">${links}</nav>
    <div class="row nav-right">
      <button class="avatar-btn" id="account-btn" type="button" aria-haspopup="menu" aria-expanded="false">
        <span class="avatar">${esc(initials(session))}</span>
        <span class="avatar-meta">
          <b>${esc(session.username || session.actorName || "Account")}</b>
          <small>${esc(roleLabel(role))}</small>
        </span>
        <span class="chev" aria-hidden="true">▾</span>
      </button>
      <div class="menu" id="account-menu" role="menu" hidden>
        <div class="menu-head">
          <b>${esc(session.username || session.actorName || "Account")}</b>
          <small class="mono">${esc(short(session.wallet, 14))}</small>
        </div>
        <a class="menu-item" href="/app#/me" role="menuitem"><span>My profile</span><small>Edit how you appear</small></a>
        ${switchItems}
        ${grantItems}
        ${isStaff(session) ? `<a class="menu-item" href="/app#/operator" role="menuitem"><span>Operator console</span><small>Staff only</small></a>` : ""}
        <a class="menu-item" href="https://solscan.io/account/${esc(session.wallet)}?cluster=${explorerCluster}" target="_blank" rel="noopener" role="menuitem"><span>Wallet on Solscan</span><small>Opens in a new tab</small></a>
        <button class="menu-item danger" data-menu-action="logout" type="button" role="menuitem"><span>Sign out</span></button>
      </div>
    </div>`;

  bindNavScroll(mount);

  const btn = $("#account-btn");
  const menu = $("#account-menu");
  btn.onclick = (e) => {
    e.stopPropagation();
    const open = !menu.hidden;
    menu.hidden = open;
    btn.setAttribute("aria-expanded", String(!open));
  };
  document.addEventListener("click", () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); });
  menu.addEventListener("click", (e) => e.stopPropagation());

  menu.querySelectorAll("[data-menu-action]").forEach((el) => {
    el.onclick = () => handleMenuAction(el.getAttribute("data-menu-action"), session);
  });

  refreshUnreadBadge(session);
}

async function handleMenuAction(action, session) {
  if (action === "logout") return void logout();
  const [kind, role] = action.split(":");
  try {
    if (kind === "switch") {
      const r = await api("POST", "/auth/mode", { role }, session.token);
      writeSession({ ...session, token: r.token, user: r.user });
      toast(`Switched to ${roleLabel(r.user.role).toLowerCase()}`, "ok");
      window.location.hash = roleHome(r.user.role).replace("/app", "");
      window.location.reload();
    } else if (kind === "grant") {
      const r = await api("POST", "/auth/roles", { role, activate: true }, session.token);
      writeSession({ ...session, token: r.token, user: r.user });
      toast(`You can now work as a ${roleLabel(r.user.role).toLowerCase()}`, "ok");
      window.location.reload();
    }
  } catch (err) {
    toast(err.message, "err");
  }
}

// Fallback for demo auto-sessions: signs the SIWS challenge for a seeded actor.
async function ensureSession(targetActorName) {
  const sessionKey = "solhustle.actor." + targetActorName;
  try {
    const cached = JSON.parse(sessionStorage.getItem(sessionKey) || "null");
    if (cached && cached.token && cached.wallet) {
      const me = await api("GET", "/auth/me", undefined, cached.token);
      if (me?.user) return cached;
    }
  } catch {}

  const actors = (await api("GET", "/demo/actors")).actors;
  const actor = actors.find((a) => a.name === targetActorName) || actors[0];

  const ch = await api("POST", "/auth/challenge", { wallet: actor.wallet });
  const secret = b58decode(actor.secret_key_b58);
  const sig = b58encode(nacl.sign.detached(new TextEncoder().encode(ch.message), secret));
  const v = await api("POST", "/auth/verify", {
    wallet: actor.wallet,
    signature: sig,
    nonce: ch.nonce,
    role: actor.role,
  });

  const session = {
    token: v.token,
    user: v.user,
    actorName: actor.name,
    username: actor.name,
    provider: "demo",
    wallet: actor.wallet,
    secretKeyB58: actor.secret_key_b58,
  };
  sessionStorage.setItem(sessionKey, JSON.stringify(session));
  return session;
}

// --- In-Browser Signing Modal ---
function promptSignFundingModal(jobId, built, session) {
  return new Promise((resolve, reject) => {
    let overlay = $("#tx-modal-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "tx-modal-overlay";
      overlay.className = "tx-overlay";
      overlay.innerHTML = `
        <div class="card tx-card">
          <div class="row between">
            <h3 class="tx-title">Confirm escrow deposit</h3>
            <span class="pill ok">Solana devnet</span>
          </div>
          <p class="dim tx-sub">Signed in your browser with Ed25519. No extension, no seed phrase prompt.</p>
          <div class="tx-kv">
            <div class="kv">
              <span class="k">From (you)</span><span class="mono" id="m-from">…</span>
              <span class="k">To escrow vault</span><span class="mono" id="m-to">…</span>
              <span class="k">Deposit</span><span id="m-amount">…</span>
              <span class="k">Network fee</span><span class="dim">~0.000005 SOL</span>
            </div>
          </div>
          <div id="m-status-box" class="tx-status" hidden></div>
          <div class="row end gap-8">
            <button class="btn sec" id="m-btn-cancel">Cancel</button>
            <button class="btn" id="m-btn-sign">Sign and broadcast</button>
            <a class="btn sec" id="m-btn-solscan" href="#" target="_blank" rel="noopener" hidden>View on Solscan ↗</a>
          </div>
        </div>`;
      document.body.appendChild(overlay);
    }

    const mFrom = $("#m-from");
    const mTo = $("#m-to");
    const mAmount = $("#m-amount");
    const mStatus = $("#m-status-box");
    const btnCancel = $("#m-btn-cancel");
    const btnSign = $("#m-btn-sign");
    const btnSolscan = $("#m-btn-solscan");

    mFrom.textContent = short(session.wallet, 16);
    mTo.textContent = short(built.to, 16);
    mAmount.innerHTML = `<strong>${fmtSol(built.lamports)} SOL</strong>`;

    mStatus.hidden = true;
    mStatus.innerHTML = "";
    btnCancel.hidden = false;
    btnCancel.textContent = "Cancel";
    btnSign.hidden = false;
    btnSign.disabled = false;
    btnSolscan.hidden = true;
    overlay.classList.add("open");

    btnCancel.onclick = () => {
      overlay.classList.remove("open");
      reject(new Error("Transaction cancelled by user"));
    };

    btnSign.onclick = async () => {
      try {
        btnSign.disabled = true;
        btnCancel.hidden = true;
        mStatus.hidden = false;
        mStatus.className = "tx-status";
        // No balance gate here on purpose: /escrow/:id/fund/build-tx already
        // topped this wallet up and returned a fresh blockhash, so this modal
        // only signs and broadcasts what the server prepared.
        mStatus.innerHTML = `<strong>Step 1 of 2:</strong> signing with your Ed25519 keypair…`;

        let rawTxHex = "";
        let signature = "";

        if (session.secretKeyB58 && window.solanaWeb3) {
          let blockhash = built.blockhash;
          if (!blockhash) {
            const tempConn = new solanaWeb3.Connection("https://api.devnet.solana.com", "confirmed");
            blockhash = (await tempConn.getLatestBlockhash()).blockhash;
          }
          const secret = b58decode(session.secretKeyB58);
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
          rawTxHex = Array.from(tx.serialize()).map((b) => b.toString(16).padStart(2, "0")).join("");
          signature = b58encode(tx.signatures[0].signature);
        } else {
          const signed = await api("POST", "/demo/sign-transfer", { wallet: session.wallet, to: built.to, lamports: built.lamports }, session.token);
          rawTxHex = signed.raw_tx_hex;
          signature = signed.signature;
        }

        mStatus.innerHTML = `<strong>Step 2 of 2:</strong> broadcasting to devnet…<br><span class="mono dim">${short(signature, 16)}</span>`;
        const confirmed = await api("POST", `/escrow/${jobId}/fund/confirm`, { raw_tx_hex: rawTxHex, signature }, session.token);

        mStatus.className = "tx-status ok";
        mStatus.innerHTML = `<strong>Confirmed on devnet.</strong><br><span class="mono">${short(confirmed.signature, 16)}</span>`;
        btnSign.hidden = true;
        btnCancel.hidden = false;
        btnCancel.textContent = "Done";
        btnCancel.onclick = () => {
          overlay.classList.remove("open");
          resolve(confirmed);
        };
        btnSolscan.href = `https://solscan.io/tx/${confirmed.signature}?cluster=${explorerCluster}`;
        btnSolscan.hidden = false;
        if (typeof onEscrowFunded === "function") onEscrowFunded(jobId, confirmed);
      } catch (err) {
        btnSign.disabled = false;
        btnCancel.hidden = false;
        mStatus.className = "tx-status err";
        mStatus.innerHTML = `<strong>Failed:</strong> ${esc(err.message)}`;
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Dialogs
//
// Everything that used to be a native `prompt()` or `confirm()` goes through
// here instead. Native dialogs are unstyled, block the whole tab, cannot show a
// screenshot preview, and look nothing like the product.
// ---------------------------------------------------------------------------
let __modalSubmitHooks = [];

function rndId() {
  return "m" + Math.random().toString(36).slice(2, 9);
}

function fieldHtml(f) {
  const id = "f_" + f.name + "_" + rndId();
  const label = `<span>${esc(f.label)}${f.required ? " *" : ""}</span>`;
  if (f.type === "textarea") {
    return `<label class="field" for="${id}">${label}<textarea id="${id}" name="${esc(f.name)}" rows="${f.rows || 5}"
      placeholder="${esc(f.placeholder || "")}" maxlength="${f.maxlength || 4000}">${esc(f.value || "")}</textarea></label>`;
  }
  if (f.type === "select") {
    return `<label class="field" for="${id}">${label}<select id="${id}" name="${esc(f.name)}">${(f.options || [])
      .map((o) => `<option value="${esc(o.value)}"${o.value === f.value ? " selected" : ""}>${esc(o.label)}</option>`)
      .join("")}</select></label>`;
  }
  if (f.type === "stars") {
    const v = Number(f.value) || 5;
    return `<div class="field"><span>${esc(f.label)}</span>
      <div class="stars-input" data-stars="${esc(f.name)}" data-value="${v}" role="radiogroup" aria-label="${esc(f.label)}">
      ${[1, 2, 3, 4, 5]
        .map(
          (n) =>
            `<button type="button" class="star${n <= v ? " on" : ""}" data-star="${n}"
              role="radio" aria-checked="${n === v}" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`,
        )
        .join("")}
      <span class="stars-out dim">${v} of 5</span></div></div>`;
  }
  return `<label class="field" for="${id}">${label}<input id="${id}" name="${esc(f.name)}" type="${f.type || "text"}"
    value="${esc(f.value || "")}" placeholder="${esc(f.placeholder || "")}"${f.required ? " required" : ""}
    ${f.min !== undefined ? `min="${f.min}"` : ""}${f.max !== undefined ? ` max="${f.max}"` : ""}
    ${f.maxlength ? ` maxlength="${f.maxlength}"` : ""}${f.autofocus ? " data-autofocus" : ""} /></label>`;
}

/**
 * Modal form. Resolves with the collected values, or `null` if dismissed.
 * `onSubmit` may throw — the message is shown inline and the dialog stays open,
 * so a failed API call never loses what the person typed.
 */
function openFormModal(spec) {
  const { title, subtitle = "", fields = [], html = "", submitLabel = "Save", cancelLabel = "Cancel", onSubmit, onReady, wide = false } = spec;
  // Hooks are per-dialog: never let one modal's validator leak into the next.
  resetModalHooks();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-card${wide ? " wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          ${subtitle ? `<p class="dim modal-sub">${esc(subtitle)}</p>` : ""}
        </div>
        <form class="modal-body" novalidate>
          ${fields.map(fieldHtml).join("")}
          ${html}
          <div class="modal-error err-text" hidden></div>
          <div class="modal-foot">
            <button type="button" class="btn sec" data-cancel>${esc(cancelLabel)}</button>
            <button type="submit" class="btn btn-pill" data-submit>${esc(submitLabel)}</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("open"));

    const form = overlay.querySelector("form");
    const errBox = overlay.querySelector(".modal-error");
    const submitBtn = form.querySelector("[data-submit]");
    const previousFocus = document.activeElement;
    // Widgets built by `onReady` (dropzones, pickers) may attach listeners
    // outside the dialog; they hand back a `destroy` so nothing outlives it.
    let ready = null;

    const collect = () => {
      const values = {};
      for (const f of fields) {
        if (f.type === "stars") {
          const el = form.querySelector(`[data-stars="${f.name}"]`);
          values[f.name] = Number(el?.getAttribute("data-value") || 5);
        } else {
          const el = form.querySelector(`[name="${f.name}"]`);
          values[f.name] = el ? String(el.value).trim() : "";
        }
      }
      return values;
    };

    const showError = (msg) => {
      errBox.textContent = msg;
      errBox.hidden = false;
    };

    const close = (result) => {
      overlay.classList.remove("open");
      document.removeEventListener("keydown", onKey, true);
      if (ready && typeof ready.destroy === "function") {
        try { ready.destroy(); } catch {}
      }
      setTimeout(() => overlay.remove(), 180);
      if (previousFocus && previousFocus.focus) previousFocus.focus();
      resolve(result);
    };

    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
        return;
      }
      if (e.key === "Tab") {
        // Keep focus inside the dialog.
        const focusables = Array.from(
          overlay.querySelectorAll("button, input, select, textarea, a[href]"),
        ).filter((el) => !el.disabled && el.offsetParent !== null);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close(null);
    });
    overlay.querySelector("[data-cancel]").onclick = () => close(null);

    // Star pickers
    form.querySelectorAll("[data-stars]").forEach((group) => {
      const paint = (v) => {
        group.setAttribute("data-value", String(v));
        group.querySelectorAll(".star").forEach((s) => {
          const n = Number(s.getAttribute("data-star"));
          s.classList.toggle("on", n <= v);
          s.setAttribute("aria-checked", String(n === v));
        });
        const out = group.querySelector(".stars-out");
        if (out) out.textContent = `${v} of 5`;
      };
      group.querySelectorAll(".star").forEach((s) => {
        s.onclick = () => paint(Number(s.getAttribute("data-star")));
        s.onmouseenter = () => {
          const n = Number(s.getAttribute("data-star"));
          group.querySelectorAll(".star").forEach((x) =>
            x.classList.toggle("on", Number(x.getAttribute("data-star")) <= n),
          );
        };
      });
      group.onmouseleave = () => paint(Number(group.getAttribute("data-value")));
    });

    form.onsubmit = async (e) => {
      e.preventDefault();
      errBox.hidden = true;
      const values = collect();
      for (const f of fields) {
        if (f.required && !values[f.name]) {
          showError(`${f.label} is required.`);
          return;
        }
      }
      // Views can attach extra validation (attachment rows, for example).
      for (const hook of __modalSubmitHooks) {
        const problem = hook(values, form);
        if (problem) {
          showError(problem);
          return;
        }
      }
      submitBtn.disabled = true;
      const original = submitBtn.textContent;
      submitBtn.textContent = "Working…";
      try {
        if (onSubmit) await onSubmit(values, form);
        close(values);
      } catch (err) {
        showError(err && err.message ? err.message : "Something went wrong.");
        submitBtn.disabled = false;
        submitBtn.textContent = original;
      }
    };

    // Let the caller attach richer widgets (attachment editors, pickers) now
    // that the form exists in the DOM.
    ready = onReady ? onReady(form) : null;

    const auto = form.querySelector("[data-autofocus]") || form.querySelector("input, textarea, select");
    if (auto) setTimeout(() => auto.focus(), 40);
  });
}

/** Confirmation dialog — the styled replacement for native `confirm()`. */
function openConfirmModal({ title, body, confirmLabel = "Confirm", danger = false }) {
  return openFormModal({
    title,
    html: `<p class="modal-text">${esc(body)}</p>`,
    submitLabel: confirmLabel,
    fields: [],
    onSubmit: () => {},
  }).then((v) => v !== null);
}

// ---------------------------------------------------------------------------
// File uploads
//
// There is no multipart dependency in this project, so a file goes up as base64
// in a JSON body on its own route (which carries a larger body limit than the
// rest of the API). No new packages, at the cost of ~33% wire overhead — which is
// why the size cap is enforced on both sides.
// ---------------------------------------------------------------------------
const UPLOAD_ACCEPT_MIME = /^image\/(png|jpeg|jpg|gif|webp|avif)$|^video\/(mp4|webm|quicktime)$/i;
let uploadLimits = { maxBytes: 10 * 1024 * 1024, maxMb: 10 };

function mb(bytes) {
  return (Number(bytes || 0) / 1048576).toFixed(1) + " MB";
}

/** True for a path this server handed back from `POST /uploads`. */
function isUploadRef(url) {
  return /^\/uploads\/[A-Za-z0-9_-]+\.[a-z0-9]{2,5}$/i.test(String(url || ""));
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function uploadFile(file, token) {
  const data_base64 = await fileToBase64(file);
  return api(
    "POST",
    "/uploads",
    { mime: file.type || "application/octet-stream", data_base64, filename: file.name },
    token,
  );
}

function dropzoneHtml(opts = {}) {
  const heading = opts.label || "Drag & drop images or video";
  return `<div class="dropzone" data-dropzone>
    <span class="dz-glyph" aria-hidden="true">⇪</span>
    <span class="dz-copy">
      <b>${esc(heading)}</b>
      <span class="dim small" data-dz-sub>or click to browse</span>
    </span>
    <input type="file" data-dz-input hidden multiple
      accept="image/png,image/jpeg,image/gif,image/webp,image/avif,video/mp4,video/webm,video/quicktime" />
  </div>`;
}

/**
 * Wire a dropzone: click-to-browse, real drag & drop, and clipboard paste.
 * `onUploaded(attachment, file, placeholder)` runs once per accepted file, so the
 * caller decides whether it becomes a row, or fills a field.
 */
function wireDropzone(root, opts = {}) {
  const dz = (root.querySelector && root.querySelector("[data-dropzone]")) || null;
  if (!dz) return { destroy() {} };
  const input = dz.querySelector("[data-dz-input]");
  const sub = dz.querySelector("[data-dz-sub]");
  let busy = false;

  const say = (txt, isErr) => {
    if (!sub) return;
    sub.textContent = txt;
    sub.className = isErr ? "err-text small" : "dim small";
  };

  const fail = (msg) => {
    if (opts.onError) opts.onError(msg);
    else if (typeof toast === "function") toast(msg, "err");
  };

  // Take the real limit from the server so the copy can't drift from the API.
  api("GET", "/meta/uploads")
    .then((m) => {
      if (m && m.maxBytes) {
        uploadLimits = { maxBytes: m.maxBytes, maxMb: m.maxMb };
        say(`or click to browse · up to ${m.maxMb} MB each · paste with Ctrl+V`);
      }
    })
    .catch(() => {
      /* keep the conservative default */
    });

  async function handle(files) {
    const list = Array.from(files || []);
    if (!list.length || busy) return;
    busy = true;
    dz.classList.add("busy");
    try {
      for (const file of list) {
        if (!UPLOAD_ACCEPT_MIME.test(file.type || "")) {
          fail(`${file.name}: images and video only`);
          continue;
        }
        if (file.size > uploadLimits.maxBytes) {
          fail(`${file.name} is ${mb(file.size)} — the limit is ${uploadLimits.maxMb} MB`);
          continue;
        }
        const placeholder = opts.onStart ? opts.onStart(file) : null;
        say(`uploading ${file.name}…`);
        try {
          const res = await uploadFile(file, opts.token);
          const attachment = {
            type: res.type,
            url: res.url,
            label: String(file.name).replace(/\.[a-z0-9]+$/i, ""),
            bytes: res.bytes,
          };
          if (opts.onUploaded) opts.onUploaded(attachment, file, placeholder);
          say(`added ${file.name}`);
        } catch (err) {
          if (opts.onFail) opts.onFail(placeholder, err);
          else fail(`${file.name}: ${err.message}`);
        }
      }
    } finally {
      busy = false;
      dz.classList.remove("busy");
    }
  }

  dz.addEventListener("click", (e) => {
    if (e.target === input) return;
    input.click();
  });
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener("change", () => {
    const files = input.files;
    input.value = "";
    handle(files);
  });
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.add("over");
    }),
  );
  ["dragleave", "dragend"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove("over");
    }),
  );
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dz.classList.remove("over");
    const dt = e.dataTransfer;
    if (!dt) return;
    if (dt.files && dt.files.length) return void handle(dt.files);
    // A URL dragged in from another tab is a link, not a file.
    const url = (dt.getData("text/uri-list") || dt.getData("text/plain") || "").trim();
    if (url && /^https?:\/\//i.test(url) && opts.onUrl) opts.onUrl(url);
  });

  // Pasting a screenshot is the fastest path there is; scoped to this dialog.
  const onPaste = (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) {
      e.preventDefault();
      handle(files);
    }
  };
  document.addEventListener("paste", onPaste);

  // A drop that misses the zone by a few pixels must not make the browser
  // navigate away to the file. While an editor is open, the page swallows
  // stray drops — except into the text fields, where inserting text is right.
  const swallow = (e) => {
    const t = e.target;
    if (t && t.closest && t.closest("[data-dropzone]")) return;
    if (t && t.matches && t.matches("input, textarea")) return;
    e.preventDefault();
  };
  document.addEventListener("dragover", swallow);
  document.addEventListener("drop", swallow);

  return {
    destroy() {
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("dragover", swallow);
      document.removeEventListener("drop", swallow);
    },
  };
}

// ---------------------------------------------------------------------------
// Deliverable attachments
//
// A delivery is a small bundle — a repo, a video walkthrough, screenshots, a live
// URL — so each link carries a kind and renders as a preview instead of a bare
// anchor. Types are inferred from the URL when not given, so old plain-string
// deliveries still display correctly.
// ---------------------------------------------------------------------------
const ATTACHMENT_KINDS = [
  ["image", "Image / screenshot"],
  ["repo", "GitHub repo"],
  ["video", "Video walkthrough"],
  ["live", "Live site / demo"],
  ["design", "Design file"],
  ["other", "Other link"],
];

function inferAttachmentType(rawUrl) {
  const u = String(rawUrl || "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|svg|bmp)($|[?#])/.test(u)) return "image";
  if (/(youtube\.com|youtu\.be|vimeo\.com|loom\.com|wistia\.com|\.mp4|\.webm|\.mov)($|[?#])/.test(u)) return "video";
  if (/(github\.com|gitlab\.com|bitbucket\.org)/.test(u)) return "repo";
  if (/(figma\.com|dribbble\.com|behance\.net|\.fig|\.sketch|\.xd)($|[?#])/.test(u)) return "design";
  return "live";
}

const ATTACHMENT_GLYPH = { image: "▤", repo: "⌥", video: "▶", live: "◈", design: "✦", other: "↗" };
const ATTACHMENT_WORD = { image: "Image", repo: "Repo", video: "Video", live: "Live", design: "Design", other: "Link" };

/** Stable-ish JSON parsing: accepts the new object form and the legacy string form. */
function parseAttachments(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw || "[]");
    } catch {
      parsed = raw ? [raw] : [];
    }
  }
  if (!Array.isArray(parsed)) parsed = parsed ? [parsed] : [];
  return parsed
    .map((entry) => {
      if (typeof entry === "string") {
        return { type: inferAttachmentType(entry), url: entry, label: "" };
      }
      if (entry && typeof entry === "object" && typeof entry.url === "string") {
        return {
          type: entry.type || inferAttachmentType(entry.url),
          url: entry.url,
          label: entry.label || "",
        };
      }
      return null;
    })
    .filter(Boolean);
}

function youtubeId(url) {
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}

function repoLabel(url) {
  const m = String(url).match(/(?:github|gitlab|bitbucket)\.[a-z]+\/([^/]+\/([^/?#]+))/i);
  if (!m) return null;
  return m[1].replace(/\.git$/, "");
}

/** A thumbnail or badge for one attachment, used in lists and in the live preview. */
function attachmentThumbHtml(a) {
  const kind = a.type || inferAttachmentType(a.url);
  if (kind === "image") {
    return `<img class="thumb" src="${esc(a.url)}" alt="" loading="lazy" decoding="async" />`;
  }
  if (kind === "video") {
    const yt = youtubeId(a.url);
    if (yt) {
      return `<span class="thumb-video"><img class="thumb" src="https://img.youtube.com/vi/${esc(yt)}/hqdefault.jpg" alt="" loading="lazy" decoding="async" /><span class="play" aria-hidden="true">▶</span></span>`;
    }
    // An uploaded clip gets a real frame from the file itself, not a badge.
    if (isUploadRef(a.url)) {
      return `<span class="thumb-video"><video class="thumb" src="${esc(a.url)}#t=0.1" muted playsinline preload="metadata"></video><span class="play" aria-hidden="true">▶</span></span>`;
    }
    return `<span class="thumb-badge thumb-badge--video" aria-hidden="true">▶</span>`;
  }
  return `<span class="thumb-badge" aria-hidden="true">${ATTACHMENT_GLYPH[kind] || "↗"}</span>`;
}

/** Full presentation of one attachment: preview, type, label and the link itself. */
function attachmentCardHtml(a) {
  const kind = a.type || inferAttachmentType(a.url);
  const repo = kind === "repo" ? repoLabel(a.url) : null;
  const isImage = kind === "image";
  const title = a.label || repo || a.url.replace(/^https?:\/\//, "");
  const inner = `
    <div class="attach-preview">${attachmentThumbHtml({ type: kind, url: a.url })}</div>
    <div class="attach-meta">
      <span class="chip">${esc(ATTACHMENT_WORD[kind] || "Link")}</span>
      <b class="attach-title">${esc(title)}</b>
      ${isImage ? "" : `<span class="dim small mono">${esc(short(a.url.replace(/^https?:\/\//, ""), 52))}</span>`}
    </div>`;
  return `<a class="attach-card${isImage ? " attach-card--image" : ""}" href="${esc(a.url)}" target="_blank" rel="noopener">${inner}</a>`;
}

function attachmentRowHtml(kind = "repo", url = "", label = "") {
  return `<div class="attach-row">
    <select class="attach-kind" aria-label="Attachment type">${ATTACHMENT_KINDS.map(
      ([v, t]) => `<option value="${v}"${v === kind ? " selected" : ""}>${esc(t)}</option>`,
    ).join("")}</select>
    <div class="attach-inputs">
      <input class="attach-url" type="url" placeholder="https://…" value="${esc(url)}" aria-label="Attachment URL" />
      <input class="attach-label" type="text" placeholder="Short label (optional)" maxlength="120" value="${esc(label)}" aria-label="Attachment label" />
      <div class="attach-mini" hidden></div>
    </div>
    <button type="button" class="btn sec danger-sec btn-sm attach-remove" aria-label="Remove this attachment">✕</button>
  </div>`;
}

/**
 * Wire up a list of attachment rows inside a modal: live thumbnails as a URL is
 * typed, add/remove rows, and a validator the modal runs on submit.
 * Returns nothing — it installs itself onto the form.
 */
function wireAttachmentEditor(form, opts = {}) {
  const list = form.querySelector("[data-attach-list]");
  if (!list) return { destroy() {} };
  const min = opts.min ?? 1;
  const valid = (url) => /^https?:\/\//i.test(url) || /^\/uploads\//i.test(url);

  const refresh = () => {
    list.querySelectorAll(".attach-row").forEach((row) => {
      const url = row.querySelector(".attach-url").value.trim();
      const kind = row.querySelector(".attach-kind").value;
      const mini = row.querySelector(".attach-mini");
      if (!url || !valid(url)) {
        mini.hidden = true;
        mini.innerHTML = "";
        return;
      }
      mini.hidden = false;
      mini.innerHTML = attachmentThumbHtml({ type: kind, url });
    });
    const count = list.querySelectorAll(".attach-row").length;
    const addBtn = form.querySelector("[data-attach-add]");
    if (addBtn) addBtn.disabled = count >= 10;
  };

  const bind = (row) => {
    row.querySelector(".attach-url").oninput = refresh;
    row.querySelector(".attach-kind").onchange = refresh;
    row.querySelector(".attach-remove").onclick = () => {
      if (list.querySelectorAll(".attach-row").length <= min) {
        // Never let the last row vanish — that is how a form gets stuck.
        row.querySelector(".attach-url").value = "";
        row.querySelector(".attach-label").value = "";
      } else {
        row.remove();
      }
      refresh();
    };
  };

  /** Append a fully-formed row — used by both "+ Add link" and uploads. */
  const addRow = (attachment = {}, opts2 = {}) => {
    const kind = attachment.type || "repo";
    list.insertAdjacentHTML(
      "beforeend",
      attachmentRowHtml(kind, attachment.url || "", attachment.label || ""),
    );
    const rows = list.querySelectorAll(".attach-row");
    const row = rows[rows.length - 1];
    bind(row);
    refresh();
    if (opts2.focus) row.querySelector(".attach-url").focus();
    return row;
  };

  list.querySelectorAll(".attach-row").forEach(bind);
  const add = form.querySelector("[data-attach-add]");
  if (add) add.onclick = () => addRow({ type: "repo" }, { focus: true });
  refresh();

  // Uploads land as new rows, so a dropped file is treated exactly like a typed
  // link from here on — same preview, same validation, same payload.
  const dropzone = opts.token
    ? wireDropzone(form, {
        token: opts.token,
        onUploaded: (attachment) => addRow(attachment),
        // A link dragged in from another tab is a deliverable too.
        onUrl: (url) => addRow({ type: inferAttachmentType(url), url }),
      })
    : { destroy() {} };

  __modalSubmitHooks = [
    (values, f) => {
      const rows = Array.from(f.querySelectorAll(".attach-row"))
        .map((row) => ({
          type: row.querySelector(".attach-kind").value,
          url: row.querySelector(".attach-url").value.trim(),
          label: row.querySelector(".attach-label").value.trim(),
        }))
        .filter((a) => a.url);
      if (!rows.length) return "Add at least one file or link so the client can review your work.";
      const bad = rows.find((a) => !valid(a.url));
      if (bad) return `"${bad.url}" is not a valid link. Use an https:// URL or drag a file in.`;
      return null;
    },
  ];

  return { refresh, addRow, destroy: () => dropzone.destroy() };
}

function readAttachmentRows(form) {
  return Array.from(form.querySelectorAll(".attach-row"))
    .map((row) => ({
      type: row.querySelector(".attach-kind").value,
      url: row.querySelector(".attach-url").value.trim(),
      label: row.querySelector(".attach-label").value.trim(),
    }))
    .filter((a) => a.url);
}

function resetModalHooks() {
  __modalSubmitHooks = [];
}

// Compatibility stubs
function showOrbitalSpinner(msg) { if (typeof toast === "function") toast(msg || "Processing…"); }
function hideOrbitalSpinner() {}
function initConstellationGrid() {}
