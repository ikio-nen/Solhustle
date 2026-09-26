/* SealDeal Shared Client Library */
const $ = (sel) => document.querySelector(sel);

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
async function api(method, path, body, token) {
  const headers = { "content-type": "application/json" };
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
    throw new Error(errMsg);
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

const txLink = (sig) =>
  `<a href="https://solscan.io/tx/${esc(sig)}?cluster=devnet" target="_blank" rel="noopener" style="font-weight:600; text-decoration:underline;">` +
  `${esc(short(sig, 12))} <span style="font-size:10px; opacity:0.85;">[Solscan ↗]</span></a>`;

const acctLink = (addr) =>
  `<a href="https://solscan.io/account/${esc(addr)}?cluster=devnet" target="_blank" rel="noopener">` +
  `${esc(short(addr, 12))} <span style="font-size:10px; opacity:0.85;">[Solscan ↗]</span></a>`;

const STATUS_PILL = {
  released: "ok", closed_no_payout: "dim", funded: "warn", agreed: "warn",
  in_progress: "warn", delivered: "warn", rejected: "err", disputed: "err", held_detached: "err",
};
const pill = (status) => `<span class="pill ${STATUS_PILL[status] || ""}">${esc(status)}</span>`;

// --- Shared Navigation Bar (Crafting Brands Aesthetic) ---
function renderNavbar(activePage) {
  const header = document.createElement("header");
  header.className = "app-nav";
  header.innerHTML = `
    <a href="/landing" class="brand">
      <span style="font-size:18px;">⛓️</span>
      <h1>SEALDEAL<span class="dot">.</span></h1>
    </a>
    <nav class="nav-links">
      <a href="/landing" class="nav-link ${activePage === 'landing' ? 'active' : ''}">Overview</a>
      <a href="/buyer" class="nav-link ${activePage === 'buyer' ? 'active' : ''}">Buyer</a>
      <a href="/seller" class="nav-link ${activePage === 'seller' ? 'active' : ''}">Seller</a>
      <a href="/admin" class="nav-link ${activePage === 'admin' ? 'active' : ''}">Admin</a>
    </nav>
    <div class="row" id="nav-right-slot">
      <span class="net-badge"><span class="dot"></span>Devnet</span>
      <span class="net-badge" style="color:var(--txt); border-color:var(--line);"><span class="dot" style="background:#4ade80; box-shadow:0 0 8px #4ade80;"></span>Neon DB</span>
      <a href="https://solscan.io/?cluster=devnet" target="_blank" rel="noopener" class="btn" style="padding:6px 14px; font-size:11px;">Solscan ↗</a>
    </div>
  `;
  document.body.prepend(header);
}

function updateNavbarSession(session, portalKey) {
  const slot = $("#nav-right-slot");
  if (!slot || !session) return;
  const roleName = session.role === "client" ? "Buyer" : session.role === "freelancer" ? "Seller" : "Admin";
  slot.innerHTML = `
    <span class="pill ok" style="font-weight:600; font-size:11px; text-transform:uppercase;">👤 ${esc(session.username)} (${roleName})</span>
    <button class="btn sec" id="nav-btn-logout" style="padding:4px 10px; font-size:11px; border-color:rgba(239,68,68,0.4); color:#f87171;" title="Sign out of ${esc(portalKey)}">Sign Out</button>
    <a href="https://solscan.io/account/${esc(session.wallet)}?cluster=devnet" target="_blank" rel="noopener" class="btn sec" style="padding:4px 10px; font-size:11px;">Wallet ↗</a>
  `;
  const btnLogout = $("#nav-btn-logout");
  if (btnLogout) {
    btnLogout.onclick = () => logoutPortal(portalKey);
  }
}

function logoutPortal(portalKey) {
  sessionStorage.removeItem("sealdeal.auth." + portalKey);
  window.location.reload();
}

// --- Portal Authentication Gate (Crafting Brands Aesthetic) ---
async function requirePortalAuth(targetRole, portalTitle, defaultUsername, defaultPassword, portalKey = targetRole) {
  const sessionKey = "sealdeal.auth." + portalKey;

  // 1. Check existing session
  try {
    const cached = JSON.parse(sessionStorage.getItem(sessionKey) || "null");
    if (cached && cached.token && cached.wallet) {
      const me = await api("GET", "/auth/me", undefined, cached.token);
      if (me?.user) {
        const userRole = me.user.role;
        const isMatch =
          targetRole === "client" ? userRole === "client" :
          targetRole === "freelancer" ? userRole === "freelancer" :
          (targetRole === "dev" || targetRole === "admin") ? (userRole === "dev" || userRole === "support") :
          true;
        if (isMatch) {
          updateNavbarSession(cached, portalKey);
          return cached;
        }
      }
    }
  } catch {}

  // 2. Render Login Gate Overlay
  return new Promise((resolve) => {
    let overlay = $("#portal-login-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "portal-login-overlay";
      overlay.style.cssText = `
        position: fixed; inset: 0; background: rgba(12, 11, 10, 0.94);
        backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
        display: flex; align-items: center; justify-content: center;
        z-index: 10000; padding: 20px;
      `;
      document.body.appendChild(overlay);
    }

    const roleIcon = targetRole === "client" ? "🛒" : targetRole === "freelancer" ? "💼" : "🛡️";

    overlay.innerHTML = `
      <div class="card" style="width: 100%; max-width: 440px; margin: 0; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.85); border: 1px solid var(--line); border-radius: 8px;">
        <div style="text-align:center; margin-bottom: 20px;">
          <div style="font-size: 36px; margin-bottom: 6px;">${roleIcon}</div>
          <h2 style="margin: 0 0 6px; font-size: 24px; font-family: var(--font-display); letter-spacing:.04em; color: #fff;">${esc(portalTitle)}</h2>
          <span class="tag-label accent">
            [ Access Verification Required ]
          </span>
        </div>

        <div style="background: #100d0a; border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; margin-bottom: 18px; font-size: 12px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
            <span class="tag-label accent">01 Default Credentials</span>
            <button type="button" id="btn-login-autofill" class="btn sec" style="padding: 3px 8px; font-size: 10px; cursor:pointer;">
              Auto-Fill
            </button>
          </div>
          <div class="mono" style="color: var(--txt); line-height: 1.6; font-size: 12px;">
            <div>Username: <strong style="color:var(--acc);">${esc(defaultUsername)}</strong></div>
            <div>Password: <strong style="color:var(--acc);">${esc(defaultPassword)}</strong></div>
          </div>
        </div>

        <form id="portal-login-form">
          <div style="margin-bottom: 14px;">
            <label>Username</label>
            <input id="login-input-username" type="text" value="${esc(defaultUsername)}" required autocomplete="username" />
          </div>

          <div style="margin-bottom: 16px;">
            <label>Password</label>
            <input id="login-input-password" type="password" value="${esc(defaultPassword)}" required autocomplete="current-password" />
          </div>

          <div id="login-error-msg" style="display:none; color: #f87171; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 4px; padding: 10px; font-size: 12px; margin-bottom: 14px;"></div>

          <button type="submit" id="btn-login-submit" class="btn" style="width: 100%; padding: 12px; font-size: 15px; margin-bottom: 10px;">
            Sign In to ${esc(portalTitle)} →
          </button>

          <a href="/landing" class="btn sec" style="display:block; text-align:center; padding: 9px; font-size: 12px; text-decoration:none;">
            ← Back to Overview
          </a>
        </form>
      </div>
    `;

    overlay.style.display = "flex";

    const form = $("#portal-login-form");
    const uInput = $("#login-input-username");
    const pInput = $("#login-input-password");
    const errMsg = $("#login-error-msg");
    const btnSubmit = $("#btn-login-submit");
    const btnAutofill = $("#btn-login-autofill");

    btnAutofill.onclick = () => {
      uInput.value = defaultUsername;
      pInput.value = defaultPassword;
      errMsg.style.display = "none";
    };

    form.onsubmit = async (e) => {
      e.preventDefault();
      errMsg.style.display = "none";
      btnSubmit.disabled = true;
      btnSubmit.textContent = "Authenticating…";

      try {
        const u = uInput.value.trim();
        const p = pInput.value;
        const res = await api("POST", "/auth/login", { username: u, password: p });

        const userRole = res.user.role;
        const isMatch =
          targetRole === "client" ? userRole === "client" :
          targetRole === "freelancer" ? userRole === "freelancer" :
          (targetRole === "dev" || targetRole === "admin") ? (userRole === "dev" || userRole === "support") :
          true;

        if (!isMatch) {
          throw new Error(`Access Denied: Account '${res.username}' has role '${userRole}', but this portal requires '${targetRole}'.`);
        }

        const session = {
          token: res.token,
          user: res.user,
          username: res.username,
          role: userRole,
          wallet: res.user.wallet_address,
          secretKeyB58: res.secret_key_b58,
        };

        sessionStorage.setItem(sessionKey, JSON.stringify(session));
        overlay.style.display = "none";
        toast(`Signed in as ${session.username}`, "ok");
        updateNavbarSession(session, portalKey);
        resolve(session);
      } catch (err) {
        errMsg.textContent = err.message || "Invalid credentials";
        errMsg.style.display = "block";
        btnSubmit.disabled = false;
        btnSubmit.textContent = `Sign In to ${portalTitle}`;
      }
    };
  });
}

// Fallback for demo auto-sessions if needed
async function ensureSession(targetActorName) {
  const sessionKey = "sealdeal.actor." + targetActorName;
  try {
    const cached = JSON.parse(sessionKey ? sessionStorage.getItem(sessionKey) || "null" : "null");
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
      overlay.style.cssText = "display:flex; position:fixed; inset:0; background:rgba(12,11,10,0.92); z-index:200; align-items:center; justify-content:center; backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);";
      overlay.innerHTML = `
        <div class="card" style="width:100%; max-width:500px; margin:20px; box-shadow:0 25px 50px rgba(0,0,0,0.8); border:1px solid var(--line); border-radius:8px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <h3 style="margin:0; font-family:var(--font-display); font-size:20px; letter-spacing:.04em; color:#fff;">🔐 In-Browser Signer</h3>
            <span class="pill ok">Solana Devnet</span>
          </div>
          <p class="dim" style="margin:0 0 14px; font-size:12px;">Client-side Ed25519 cryptographic signing directly in browser. No extensions needed.</p>
          <div style="background:#100d0a; padding:14px; border-radius:6px; border:1px solid var(--line); margin-bottom:14px; font-size:13px;">
            <div class="kv">
              <span class="k">Program:</span><span><strong>SystemProgram.transfer</strong></span>
              <span class="k">From (You):</span><span class="mono" id="m-from">...</span>
              <span class="k">To Escrow:</span><span class="mono" id="m-to">...</span>
              <span class="k">Deposit:</span><span><strong style="color:var(--acc); font-size:14px;" id="m-amount">... SOL</strong></span>
              <span class="k">Network Fee:</span><span class="dim">~0.000005 SOL</span>
            </div>
          </div>
          <div id="m-status-box" style="margin-bottom:14px; font-size:12px; display:none; padding:10px 12px; border-radius:4px;"></div>
          <div class="row" style="justify-content:flex-end; gap:8px;">
            <button class="btn sec" id="m-btn-cancel">Cancel</button>
            <button class="btn" id="m-btn-sign">✍️ Sign & Broadcast</button>
            <a class="btn bone" id="m-btn-solscan" href="#" target="_blank" rel="noopener" style="display:none; text-decoration:none; font-weight:700;">🔍 View on Solscan ↗</a>
          </div>
        </div>
      `;
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

        if (session.secretKeyB58 && window.solanaWeb3) {
          let blockhash = built.blockhash;
          if (!blockhash) {
            const tempConn = new solanaWeb3.Connection("https://api.devnet.solana.com", "confirmed");
            const latest = await tempConn.getLatestBlockhash();
            blockhash = latest.blockhash;
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
          const serialized = tx.serialize();
          rawTxHex = Array.from(serialized).map((b) => b.toString(16).padStart(2, "0")).join("");
          signature = b58encode(tx.signatures[0].signature);
        } else {
          const signed = await api("POST", "/demo/sign-transfer", { wallet: session.wallet, to: built.to, lamports: built.lamports }, session.token);
          rawTxHex = signed.raw_tx_hex;
          signature = signed.signature;
        }

        mStatus.innerHTML = `📡 <strong>Step 2/2:</strong> Broadcasting to Solana Devnet & awaiting confirmation...<br/><span class="mono dim" style="font-size:11px;">Sig: ${short(signature, 16)}</span>`;

        const confirmed = await api(
          "POST",
          `/escrow/${jobId}/fund/confirm`,
          { raw_tx_hex: rawTxHex, signature: signature },
          session.token
        );

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


// Compatibility stubs
function showOrbitalSpinner(msg) { if (typeof toast === "function") toast(msg || "Processing..."); }
function hideOrbitalSpinner() {}
function initConstellationGrid() {}
