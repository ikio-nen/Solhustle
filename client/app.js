/* Solhustle application shell.
 *
 * One app for the whole product. The account's role decides which links and
 * panels appear — there is deliberately no portal switcher, because the old
 * Buyer/Seller split meant two sessions and the same person logging in twice.
 *
 * Every view is hash-routed (`#/jobs/12`), so adding a screen never adds a
 * server route.
 */
const state = {
  session: null,
  me: null,
  profile: null, // freelancer profile row for the signed-in account
  portfolio: [],
  skills: [],
  taxonomy: null,
  route: { name: "dashboard" },
};

// ---------------------------------------------------------------------------
// View registry.
//
// Declared up here on purpose. `render()` is reached synchronously on the one
// anonymous path (a signed-out visitor opening /browse), so a table declared at
// the bottom of the file would still be in its temporal dead zone and throw
// "Cannot access 'VIEWS' before initialization". Every entry is a hoisted
// function declaration, so the order is safe.
// ---------------------------------------------------------------------------
const VIEWS = {
  dashboard: viewDashboard,
  jobs: viewJobs,
  jobNew: viewJobNew,
  job: viewJob,
  messages: viewMessages,
  work: viewOpenWork,
  browse: viewPublicBrowse,
  profile: viewProfile,
  me: viewMe,
  operator: viewOperator,
};

const AFTER = {
  dashboard: afterDashboard,
  jobNew: afterJobNew,
  job: afterJob,
  messages: afterMessages,
  browse: afterPublicBrowse,
  profile: afterProfile,
  me: afterMe,
  operator: afterOperator,
};

const ent = () => sessionRoles(state.session);
const can = (role) => ent().includes(role);
const uid = () => (state.me && state.me.user ? state.me.user.id : null);
const TOKEN = () => state.session && state.session.token;

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
function parseHash(hash) {
  const h = hash.replace(/^#/, "").replace(/\?.*$/, "");
  const parts = h.split("/").filter(Boolean);
  if (!parts.length) return { name: "dashboard" };
  if (parts[0] === "jobs") {
    if (parts[1] === "new") return { name: "jobNew" };
    if (parts[1]) return { name: "job", id: Number(parts[1]) };
    return { name: "jobs" };
  }
  if (parts[0] === "messages") return parts[1] ? { name: "messages", id: Number(parts[1]) } : { name: "messages" };
  if (parts[0] === "browse") return { name: "browse" };
  if (parts[0] === "work") return { name: "work" };
  if (parts[0] === "freelancer") return { name: "profile", id: Number(parts[1]) };
  if (parts[0] === "me") return { name: "me" };
  if (parts[0] === "operator") return { name: "operator" };
  return { name: "dashboard" };
}

function resolveRoute() {
  if (location.hash) return parseHash(location.hash);
  const p = location.pathname;
  if (p === "/messages") return { name: "messages" };
  if (p === "/browse") return { name: "browse" };
  if (p === "/work") return { name: "work" };
  if (p.startsWith("/freelancer/")) return { name: "profile", id: Number(p.split("/")[2]) };
  if (p === "/operator") return { name: "operator" };
  if (p === "/me") return { name: "me" };
  return { name: "dashboard" };
}

const PUBLIC_ROUTES = ["browse", "profile"];
const isPublic = (r) => PUBLIC_ROUTES.includes(r.name);

function go(path) {
  location.hash = path;
}

/** Active nav key, derived from the route rather than passed in by each page. */
function activeKey(r) {
  if (r.name === "jobNew") return "/jobs/new";
  if (r.name === "job" || r.name === "jobs") return "/jobs";
  if (r.name === "messages") return "/messages";
  if (r.name === "profile" || r.name === "browse") return "/browse";
  if (r.name === "work") return "/work";
  if (r.name === "me") return "/me";
  if (r.name === "operator") return "/operator";
  return "/";
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  state.session = readSession();
  const initial = resolveRoute();

  if (!state.session && !isPublic(initial)) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = `/login?next=${next}`;
    return;
  }

  if (state.session) {
    try {
      const me = await api("GET", "/auth/me", undefined, TOKEN());
      state.me = me;
      // Refresh the cached user so nav links follow role switches immediately.
      state.session.user = me.user;
      if (me.username) state.session.username = me.username;
      writeSession(state.session);
    } catch (err) {
      if (err.status === 401) {
        clearSession();
        if (!isPublic(initial)) return void (location.href = "/login");
        state.session = null;
      }
    }
  }

  state.route = initial;
  mountNav();
  const foot = $("#foot-signout");
  if (foot) foot.onclick = (e) => { e.preventDefault(); logout(); };
  window.addEventListener("hashchange", render);
  render();

  // Unread badge. Refreshed on every nav mount, then on a slow interval while the
  // tab is visible — the chat view refreshes it eagerly after anything happens.
  setInterval(() => {
    if (document.visibilityState === "visible" && state.session) refreshUnreadBadge(state.session);
  }, 30000);
})();

function mountNav() {
  if (state.session) {
    renderAppNav(state.session, activeKey(state.route));
    return;
  }
  // Anonymous visitors can still browse talent, so give them a way in.
  const mount = $("#app-nav");
  mount.innerHTML = `
    <a href="/" class="brand"><span class="brand-mark" aria-hidden="true">⛓</span><span class="brand-word">Solhustle</span></a>
    <nav class="nav-links">
      <a href="/browse" class="nav-link${state.route.name === "browse" ? " active" : ""}">Browse talent</a>
      <a href="/#how" class="nav-link">How it works</a>
    </nav>
    <div class="row nav-right">
      <a href="/login" class="nav-link">Sign in</a>
      <a href="/signup" class="btn btn-pill btn-sm">Get started</a>
    </div>`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
async function render() {
  state.route = resolveRoute();
  mountNav();
  // Any chat polling belongs to the view being replaced, not the new one.
  clearInterval(chatTimer);
  chatTimer = null;

  if (!state.session && !isPublic(state.route)) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    return;
  }
  if (state.route.name === "operator" && !isStaff(state.session)) {
    $("#view").innerHTML = pageHeader("Operator console", "Staff only") +
      `<div class="card"><p class="dim">This console is limited to staff accounts. If you need access, ask an operator to grant it.</p>
       <a class="btn sec" href="/app#/">Back to dashboard</a></div>`;
    return;
  }

  const view = $("#view");
  view.innerHTML = `<div class="card dim">Loading…</div>`;
  try {
    const html = await (VIEWS[state.route.name] || VIEWS.dashboard)();
    view.innerHTML = html;
    // Re-trigger the fade: a class that is already present would not replay, so
    // drop it, force a reflow, then put it back.
    view.classList.remove("view-enter");
    void view.offsetWidth;
    view.classList.add("view-enter");
    if (window.SolhustleMotion) window.SolhustleMotion.refresh();
    const after = AFTER[state.route.name];
    if (after) after();
    window.scrollTo({ top: 0 });
  } catch (err) {
    view.innerHTML = `<div class="card">
      <h2 class="h-sec">Something went wrong</h2>
      <p class="err-text">${esc(err.message)}</p>
      <a class="btn sec" href="/app#/">Back to dashboard</a>
    </div>`;
  }
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------
function pageHeader(title, subtitle, actions = "") {
  return `<div class="page-head" data-reveal>
    <div>
      <h1 class="page-title">${esc(title)}</h1>
      ${subtitle ? `<p class="page-sub">${esc(subtitle)}</p>` : ""}
    </div>
    ${actions ? `<div class="row gap-8">${actions}</div>` : ""}
  </div>`;
}

const stat = (label, value, hint = "") =>
  `<div class="card stat-card" data-reveal>
     <span class="stat-label">${esc(label)}</span>
     <b class="stat-value">${value}</b>
     ${hint ? `<span class="stat-hint">${esc(hint)}</span>` : ""}
   </div>`;

/** True only for things a browser can actually paint in an <img>. */
function isImageUrl(url) {
  if (!url) return false;
  return /^\/|^https?:\/\/[^\s]+\.(png|jpe?g|gif|webp|avif|svg|bmp)($|[?#])/i.test(String(url));
}

const avatarFor = (id, name) =>
  `<span class="avatar avatar-lg" aria-hidden="true">${esc(initials({ username: name || String(id) }))}</span>`;

const skillChips = (skills, max = 4) => {
  const list = String(skills || "").split(",").map((s) => s.trim()).filter(Boolean);
  const shown = list.slice(0, max);
  return shown.map((s) => `<span class="chip">${esc(s.split("/").pop())}</span>`).join("") +
    (list.length > max ? `<span class="chip dim">+${list.length - max}</span>` : "");
};

const stars = (avg) => {
  if (!avg) return `<span class="dim">No ratings yet</span>`;
  const full = Math.round(Number(avg));
  return `<span class="stars" title="${avg} of 5">${"★".repeat(full)}${"☆".repeat(5 - full)}</span> <b>${Number(avg).toFixed(1)}</b>`;
};

/** One portfolio entry, rendered as a real card with its preview image. */
function portfolioItemHtml(it) {
  const a = {
    type: it.media_type && it.media_type !== "link" ? it.media_type : inferAttachmentType(it.media_url),
    url: it.media_url,
    label: it.title || "",
  };
  const repo = a.type === "repo" ? repoLabel(a.url) : null;
  return `<a class="work-item" href="${esc(a.url)}" target="_blank" rel="noopener">
    <div class="work-preview">${attachmentThumbHtml(a)}</div>
    <div class="work-body">
      <span class="chip">${esc(ATTACHMENT_WORD[a.type] || "Link")}</span>
      <h3 class="work-title">${esc(a.label || repo || "Untitled")}</h3>
      <span class="dim small mono">${esc(short(a.url.replace(/^https?:\/\//, ""), 44))} ↗</span>
    </div>
  </a>`;
}

const emptyState = (title, body, cta = "") =>
  `<div class="card empty" data-reveal><h3>${esc(title)}</h3><p class="dim">${esc(body)}</p>${cta}</div>`;

const jobCard = (j, me) => {
  const isBuyer = j.buyer_id === me;
  const side = isBuyer ? "Hiring" : j.freelancer_id === me ? "Working" : "Open";
  return `<a class="card job-card" href="/app#/jobs/${j.id}" data-reveal>
    <div class="row between">
      <span class="pill ghost">${side}</span>
      ${pill(j.status)}
    </div>
    <h3 class="job-title">${esc(j.title)}</h3>
    <p class="dim job-sub">${esc((j.requirements || "").slice(0, 140))}${(j.requirements || "").length > 140 ? "…" : ""}</p>
    <div class="row between job-foot">
      <span><b>$${esc(j.usd_budget)}</b> <span class="dim">≈ ${Number(j.sol_amount || 0).toFixed(4)} SOL</span></span>
      <span class="dim">#${j.id} · ${esc(fmtDate(j.created_at))}</span>
    </div>
  </a>`;
};

const money = (j) =>
  `<b>$${esc(j.usd_budget)}</b> <span class="dim">≈ ${Number(j.sol_amount || 0).toFixed(4)} SOL</span>`;

// Attachment parsing lives in common.js (`parseAttachments`) so the job view, the
// portfolio editor and the public profile all read stored links the same way.

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
async function viewDashboard() {
  if (!state.session) return viewPublicBrowse();
  const [mine, open, prof] = await Promise.all([
    api("GET", "/jobs?mine=1", undefined, TOKEN()),
    can("freelancer") ? api("GET", "/jobs?open=1", undefined, TOKEN()).catch(() => ({ jobs: [] })) : Promise.resolve({ jobs: [] }),
    can("freelancer") ? loadMyProfile().catch(() => null) : Promise.resolve(null),
  ]);
  const myJobs = mine.jobs || [];
  const hiring = myJobs.filter((j) => j.buyer_id === uid());
  const working = myJobs.filter((j) => j.freelancer_id === uid());
  const inEscrow = hiring.filter((j) => ["funded", "in_progress", "delivered"].includes(j.status));
  const released = working.filter((j) => j.status === "released");
  const name = state.session.username || state.session.actorName || "there";
  const mode = roleLabel(state.session.user.role);
  const comp = prof ? completeness(prof) : null;

  const hiringPanel = `
    <section data-reveal>
      <div class="row between sec-head">
        <h2 class="h-sec">Hiring</h2>
        <a class="btn btn-pill btn-sm" href="/app#/jobs/new">Post a job</a>
      </div>
      <div class="grid-3">
        ${stat("Open contracts", hiring.filter((j) => j.status === "funded").length, "Waiting for applicants")}
        ${stat("In escrow", inEscrow.length, "Funds locked on devnet")}
        ${stat("Released", hiring.filter((j) => j.status === "released").length, "Paid to freelancers")}
      </div>
      <div class="stack">
        ${hiring.slice(0, 3).map((j) => jobCard(j, uid())).join("") ||
          emptyState("No contracts posted yet", "Post your first job and the budget is quoted and locked in a Solana vault.", `<a class="btn btn-pill" href="/app#/jobs/new">Post a job</a>`)}
      </div>
    </section>`;

  const workingPanel = `
    <section data-reveal>
      <div class="row between sec-head">
        <h2 class="h-sec">Freelancing</h2>
        <a class="btn sec btn-sm" href="/app#/work">Find work</a>
      </div>
      <div class="grid-3">
        ${stat("Open work", (open.jobs || []).length, "Funded and taking applications")}
        ${stat("Active contracts", working.filter((j) => ["in_progress", "funded", "delivered"].includes(j.status)).length, "In progress or in review")}
        ${stat("Settled", released.length, "Released to you")}
      </div>
      ${comp ? `
      <div class="card" data-reveal>
        <div class="row between">
          <h3 class="h-sub">Profile completeness</h3>
          <b>${comp.percent}%</b>
        </div>
        <div class="meter"><span style="width:${comp.percent}%"></span></div>
        <p class="dim">${esc(comp.hint)}</p>
        <a class="btn sec btn-sm" href="/app#/me">Edit profile</a>
      </div>` : ""}
      <div class="stack">
        ${working.slice(0, 3).map((j) => jobCard(j, uid())).join("") ||
          emptyState("No contracts yet", "Browse funded work and apply once your portfolio is published.")}
      </div>
    </section>`;

  const missing = ["client", "freelancer"].filter((r) => !can(r));
  const dualCta = missing.length
    ? `<div class="card accent-soft" data-reveal>
         <div class="row between">
           <div>
             <h3 class="h-sub">${missing[0] === "freelancer" ? "Also offer your own services" : "Also hire on Solhustle"}</h3>
             <p class="dim">One account can do both. Add the ${missing[0]} side and switch whenever you like.</p>
           </div>
           <button class="btn btn-pill" id="btn-add-role" data-role="${missing[0]}">
             ${missing[0] === "freelancer" ? "Become a freelancer" : "Start hiring"}
           </button>
         </div>
       </div>`
    : "";

  const panels = state.session.user.role === "freelancer" ? workingPanel + hiringPanel : hiringPanel + workingPanel;

  return `
    ${pageHeader(`Welcome back, ${name}`, `You're using Solhustle as a ${mode.toLowerCase()}.`)}
    ${dualCta}
    ${panels}`;
}

function afterDashboard() {
  const btn = $("#btn-add-role");
  if (!btn) return;
  btn.onclick = async () => {
    try {
      btn.disabled = true;
      const r = await api("POST", "/auth/roles", { role: btn.dataset.role, activate: true }, TOKEN());
      state.session.token = r.token;
      state.session.user = r.user;
      writeSession(state.session);
      toast(`You can now use Solhustle as a ${roleLabel(r.user.role).toLowerCase()}`, "ok");
      location.reload();
    } catch (err) {
      toast(err.message, "err");
      btn.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------------
// My jobs
// ---------------------------------------------------------------------------
async function viewJobs() {
  const { jobs } = await api("GET", "/jobs?mine=1", undefined, TOKEN());
  const all = jobs || [];
  const me = uid();
  const hiring = all.filter((j) => j.buyer_id === me);
  const working = all.filter((j) => j.freelancer_id === me);

  const listBlock = (title, rows, emptyBody, cta) => `
    <section data-reveal>
      <h2 class="h-sec">${esc(title)} <span class="dim">(${rows.length})</span></h2>
      <div class="stack">
        ${rows.map((j) => jobCard(j, me)).join("") ||
          emptyState(`Nothing here yet`, emptyBody, cta)}
      </div>
    </section>`;

  return `
    ${pageHeader("My contracts", "Every job you're on, on both sides of the table.",
      can("client") ? `<a class="btn btn-pill btn-sm" href="/app#/jobs/new">Post a job</a>` : `<a class="btn btn-pill btn-sm" href="/app#/work">Find work</a>`)}
    ${hiring.length || can("client") ? listBlock("Hiring", hiring, "You haven't posted a contract yet.",
      `<a class="btn sec" href="/app#/jobs/new">Post a job</a>`) : ""}
    ${working.length || can("freelancer") ? listBlock("Freelancing", working, "You aren't on any contracts yet.",
      `<a class="btn sec" href="/app#/work">Browse open work</a>`) : ""}`;
}

/**
 * The freelancer's job board: funded contracts that are not already mine.
 *
 * This is its own route rather than a filter on `#/browse`, because `#/browse`
 * is the talent directory — clients looking for people. Pointing "Find work"
 * there showed freelancers a list of other freelancers and left the whole open
 * marketplace unreachable from the UI, even though `/jobs?open=1` already fed
 * the dashboard's "Open work" counter.
 *
 * Jobs only ever appear here once the client's budget is locked in escrow
 * (`status = 'funded'`), which is what makes the number on each card a promise
 * rather than a wish.
 */
async function viewOpenWork() {
  const [open, prof] = await Promise.all([
    api("GET", "/jobs?open=1", undefined, TOKEN()).catch(() => ({ jobs: [] })),
    can("freelancer") ? loadMyProfile().catch(() => null) : Promise.resolve(null),
  ]);
  const rows = open.jobs || [];
  const me = uid();
  const ready = !!(prof && (prof.portfolio_ready || (prof.profile && prof.profile.portfolio_ready === 1)));

  // Applying needs a published portfolio (the server enforces it), so say so
  // here rather than letting the button fail at the last moment.
  const gate = can("freelancer") && !ready
    ? `<div class="card accent-soft" data-reveal>
         <div class="row between">
           <div>
             <h3 class="h-sub">Publish your portfolio first</h3>
             <p class="dim">Every application carries your portfolio, so it has to be published before you can apply. One item and one skill is enough.</p>
           </div>
           <a class="btn btn-pill" href="/app#/me">Open my profile</a>
         </div>
       </div>`
    : "";

  return `
    ${pageHeader("Find work", "Contracts with the budget already locked in escrow. Your portfolio travels with every application.")}
    ${gate}
    <section data-reveal>
      <h2 class="h-sec">Open contracts <span class="dim">(${rows.length})</span></h2>
      <div class="stack">
        ${rows.map((j) => jobCard(j, me)).join("") ||
          emptyState("No open work right now", "Funded contracts appear here the moment a client locks a budget in escrow.",
            `<a class="btn sec" href="/app#/">Back to dashboard</a>`)}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Post a job
// ---------------------------------------------------------------------------
async function viewJobNew() {
  if (!can("client")) {
    return `${pageHeader("Post a job", "Client side not enabled")}
      <div class="card"><p class="dim">Your account isn't set up to post contracts yet.</p>
      <button class="btn btn-pill" data-grant="client">Enable hiring</button></div>`;
  }
  const price = await api("GET", "/meta/price").catch(() => null);
  return `
    ${pageHeader("Post a job", "The budget is quoted in SOL and locked in a vault. Money moves only when you approve the work.")}
    <div class="grid-2">
      <form class="card" id="job-form" data-reveal>
        <label class="field"><span>What do you need done?</span>
          <input id="j-title" required maxlength="200" placeholder="e.g. Ship an Anchor escrow program" />
        </label>
        <label class="field"><span>Requirements</span>
          <textarea id="j-req" rows="7" required placeholder="Scope, deliverables, acceptance criteria, deadline…"></textarea>
        </label>
        <label class="field"><span>Budget in USD</span>
          <input id="j-usd" type="number" min="1" step="1" value="250" required />
        </label>
        <button class="btn btn-pill" type="submit" id="j-submit">Create contract</button>
      </form>
      <aside class="card side-card" data-reveal>
        <h3 class="h-sub">Live quote</h3>
        <p id="live-quote" class="dim">${price ? `1 SOL = $${Number(price.rate).toFixed(2)}` : "Fetching Gemini rate…"}</p>
        <hr class="rule" />
        <h3 class="h-sub">What happens next</h3>
        <ol class="steps">
          <li>You create the contract — nothing is charged.</li>
          <li>You fund the escrow vault; the SOL leaves your wallet for a vault only this job can unlock.</li>
          <li>A freelancer applies, you accept, they deliver.</li>
          <li>You approve, the vault releases to them. Or you request a revision — the funds stay locked.</li>
        </ol>
      </aside>
    </div>`;
}

function afterJobNew() {
  const grant = document.querySelector("[data-grant]");
  if (grant) {
    grant.onclick = async () => {
      const r = await api("POST", "/auth/roles", { role: grant.dataset.grant, activate: true }, TOKEN());
      state.session.token = r.token;
      state.session.user = r.user;
      writeSession(state.session);
      location.reload();
    };
  }
  const form = $("#job-form");
  if (!form) return;
  const usdEl = $("#j-usd");
  const quoteEl = $("#live-quote");
  let rate = null;
  api("GET", "/meta/price").then((p) => { rate = p.rate; updateQuote(); }).catch(() => {});
  function updateQuote() {
    if (!rate) return;
    const usd = Number(usdEl.value) || 0;
    quoteEl.innerHTML = `1 SOL = $${Number(rate).toFixed(2)} · this job locks <b>${(usd / rate).toFixed(6)} SOL</b> in escrow`;
  }
  usdEl.addEventListener("input", updateQuote);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#j-submit");
    btn.disabled = true;
    try {
      const r = await api("POST", "/jobs", {
        title: $("#j-title").value.trim(),
        requirements: $("#j-req").value.trim(),
        usd_budget: Number(usdEl.value),
      }, TOKEN());
      toast(`Contract #${r.job.id} created. Next: fund the escrow vault.`, "ok");
      go(`/jobs/${r.job.id}`);
    } catch (err) {
      toast(err.message, "err");
      btn.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------------
// Job detail
// ---------------------------------------------------------------------------
async function viewJob() {
  const id = state.route.id;
  const d = await api("GET", `/jobs/${id}`, undefined, TOKEN());
  const j = d.job;
  const me = uid();
  const isBuyer = j.buyer_id === me;
  const isWorker = j.freelancer_id === me;
  const apps = d.applications || [];
  const myApp = apps.find((a) => a.freelancer_id === me);

  const actions = [];
  if (isBuyer && j.status === "created") actions.push(`<button class="btn btn-pill" data-act="fund">Fund escrow · ${Number(j.sol_amount || 0).toFixed(4)} SOL</button>`);
  if (!isBuyer && can("freelancer") && j.status === "funded" && !myApp) actions.push(`<button class="btn btn-pill" data-act="apply">Apply for this work</button>`);
  if (isWorker && ["funded", "agreed", "negotiating"].includes(j.status)) actions.push(`<button class="btn btn-pill" data-act="start">Start work</button>`);
  if (isWorker && j.status === "in_progress") actions.push(`<button class="btn btn-pill" data-act="deliver">Submit delivery</button>`);
  if (isBuyer && j.status === "delivered") {
    actions.push(`<button class="btn btn-pill ok" data-act="approve">Approve and release</button>`);
    actions.push(`<button class="btn sec" data-act="reject">Request revision</button>`);
  }
  if (j.status === "released" && !d.rating && (isBuyer || isWorker)) actions.push(`<button class="btn sec" data-act="rate">Leave a rating</button>`);
  // Settle details in a direct thread instead of the contract log — handy long
  // before there is a delivery to talk about.
  const counterpart = isBuyer ? j.freelancer_id : j.buyer_id;
  if (counterpart && counterpart !== me) {
    actions.push(`<button class="btn sec" data-message-user="${counterpart}">Message ${isBuyer ? "freelancer" : "client"}</button>`);
  }

  const appsBlock = isBuyer && apps.length
    ? `<div class="card" data-reveal>
         <h3 class="h-sub">Applicants <span class="dim">(${apps.length})</span></h3>
         <div class="stack-sm">
           ${apps.map((a) => `
             <div class="row between list-row">
               <div>
                 <a class="link" href="/app#/freelancer/${a.freelancer_id}">${esc(a.headline || short(a.wallet_address, 14))}</a>
                 <div class="dim small">${esc(a.message || "Ready to deliver.")}</div>
               </div>
               ${a.status === "pending" && j.status === "funded"
                 ? `<div class="row gap-8">
                      <button class="btn btn-pill btn-sm" data-accept="${a.id}">Accept</button>
                      <button class="btn sec btn-sm" data-decline="${a.id}">Decline</button>
                    </div>`
                 : pill(a.status)}
             </div>`).join("")}
         </div>
       </div>`
    : isBuyer && j.status === "funded"
      ? `<div class="card dim" data-reveal>No applicants yet. The job is live in the marketplace and funded in escrow.</div>`
      : "";

  const deliveries = (d.deliveries || []).map((del) => {
    const files = parseAttachments(del.attachment_urls);
    const hasImage = files.some((a) => (a.type || inferAttachmentType(a.url)) === "image");
    return `<div class="card delivery-card" data-reveal>
      <div class="row between">
        <h3 class="h-sub">Delivery v${del.version}</h3>
        <div class="row gap-8">${pill("delivered")}<span class="dim small">${esc(fmtDate(del.submitted_at))}</span></div>
      </div>
      ${del.note ? `<p class="delivery-note">${esc(del.note)}</p>` : ""}
      ${files.length ? `<div class="attach-grid${hasImage ? " has-images" : ""}">${files.map(attachmentCardHtml).join("")}</div>` : ""}
    </div>`;
  }).join("");

  const txs = (d.escrow_transactions || []).length
    ? `<div class="card" data-reveal>
        <h3 class="h-sub">On-chain activity</h3>
        <div class="stack-sm">
          ${d.escrow_transactions.map((t) => `
            <div class="row between list-row">
              <span>${esc(t.instruction_type.replace(/_/g, " "))}</span>
              <span>${t.amount_lamports ? fmtSol(t.amount_lamports) + " SOL · " : ""}${txLink(t.tx_signature)}</span>
            </div>`).join("")}
        </div>
      </div>` : "";

  const messages = (d.messages || []).map((m) => `
    <div class="msg ${m.sender_id === me ? "mine" : ""}">
      <div class="msg-body">${esc(m.body)}</div>
      <div class="msg-meta">${m.sender_id === me ? "You" : "Them"} · ${esc(fmtDate(m.created_at))}</div>
    </div>`).join("");

  return `
    ${pageHeader(j.title, `Contract #${j.id} · ${esc(fmtDate(j.created_at))}`,
      `<a class="btn sec btn-sm" href="/app#/jobs">All contracts</a>`)}
    <div class="card hero-card" data-reveal>
      <div class="row between wrap gap-12">
        <div class="row gap-12">${pill(j.status)}<span>${money(j)}</span></div>
        <div class="row gap-8 wrap">${actions.join("") || `<span class="dim">No action available on this contract right now.</span>`}</div>
      </div>
      ${j.escrow_address ? `<div class="dim small mono">Vault ${acctLink(j.escrow_address)}</div>` : ""}
    </div>
    <div class="grid-detail">
      <div class="col">
        <div class="card" data-reveal>
          <h3 class="h-sub">Requirements</h3>
          <p class="pre">${esc(j.requirements)}</p>
        </div>
        ${deliveries}
        ${txs}
        <div class="card" data-reveal>
          <h3 class="h-sub">Messages</h3>
          <div class="msgs" id="msgs">${messages || `<p class="dim">No messages yet.</p>`}</div>
          <div class="row gap-8 msg-send">
            <input id="msg-input" placeholder="Write a message…" maxlength="2000" />
            <button class="btn" id="msg-send" type="button">Send</button>
          </div>
        </div>
      </div>
      <aside class="col">
        ${appsBlock}
        ${j.status === "released" && d.rating ? `<div class="card" data-reveal><h3 class="h-sub">Rating</h3>${stars(d.rating.stars)}<p class="dim">${esc(d.rating.comment || "")}</p></div>` : ""}
        ${d.dispute ? `<div class="card" data-reveal><h3 class="h-sub">Dispute</h3>${pill(d.dispute.status)}<p class="dim">${esc(d.dispute.reason || "")}</p></div>` : ""}
      </aside>
    </div>`;
}

function afterJob() {
  const id = state.route.id;
  wireMessageButtons();
  const run = async (fn, label) => {
    try { await fn(); toast(`${label} done`, "ok"); render(); }
    catch (err) { toast(err.message, "err"); }
  };

  // --- the delivery composer -------------------------------------------------
  // A delivery is a bundle, so this is a real form: a note, then as many typed
  // links as the work needs, each with a live preview as you paste the URL.
  function openDeliveryModal() {
    return openFormModal({
      title: "Submit your delivery",
      subtitle: "Add a repo, a walkthrough, screenshots and a live link. The client reviews before anything is released.",
      wide: true,
      submitLabel: "Submit for review",
      fields: [
        {
          name: "note",
          label: "What did you deliver?",
          type: "textarea",
          rows: 4,
          maxlength: 5000,
          placeholder: "Scope covered, anything the client should look at first, and how to run it…",
        },
      ],
      html: `
        <div class="attach-editor">
          ${dropzoneHtml({ label: "Drag in screenshots or a walkthrough video" })}
          <div class="attach-head">
            <span>Deliverables</span>
            <button type="button" class="btn sec btn-sm" data-attach-add>+ Add link</button>
          </div>
          <div data-attach-list>
            ${attachmentRowHtml("repo")}
            ${attachmentRowHtml("image")}
          </div>
          <p class="dim small">Dropped files upload straight into the delivery. Images show as thumbnails, video shows its own first frame, YouTube links show a poster, and repository links show the owner and project.</p>
        </div>`,
      onReady: (form) => wireAttachmentEditor(form, { min: 1, token: TOKEN() }),
      onSubmit: async (values, form) => {
        const attachments = readAttachmentRows(form);
        await api(
          "POST",
          `/jobs/${id}/deliveries`,
          { note: values.note || "", attachment_urls: attachments },
          TOKEN(),
        );
      },
    });
  }

  document.querySelectorAll("[data-act]").forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.act;
      btn.disabled = true;
      try {
        if (act === "fund") {
          const built = await api("POST", `/escrow/${id}/fund/build-tx`, {}, TOKEN());
          const confirmed = await promptSignFundingModal(id, built, state.session);
          toast(`Escrow funded · ${short(confirmed.signature || "", 14)}`, "ok");
          render();
          return;
        }
        if (act === "apply") {
          const v = await openFormModal({
            title: "Apply for this work",
            subtitle: "The client sees this alongside your public profile and portfolio.",
            submitLabel: "Send application",
            fields: [
              {
                name: "message",
                label: "Your pitch",
                type: "textarea",
                rows: 5,
                maxlength: 2000,
                placeholder: "How you'd approach it, relevant work, and when you can start.",
                autofocus: true,
              },
            ],
            onSubmit: async (values) => {
              await api("POST", `/jobs/${id}/apply`, { message: values.message || "" }, TOKEN());
            },
          });
          btn.disabled = false;
          if (v) { toast("Application sent", "ok"); render(); }
          return;
        }
        if (act === "start") { btn.disabled = false; return run(() => api("POST", `/jobs/${id}/start`, {}, TOKEN()), "Work started"); }
        if (act === "deliver") {
          btn.disabled = false;
          const v = await openDeliveryModal();
          if (v) { toast("Delivery submitted for review", "ok"); render(); }
          return;
        }
        if (act === "approve") {
          btn.disabled = false;
          const ok = await openConfirmModal({
            title: "Release the escrow funds?",
            body: "This settles the vault on Solana and pays the freelancer. It cannot be undone — if anything is wrong, request a revision instead.",
            confirmLabel: "Approve and release",
          });
          if (ok) return run(() => api("POST", `/jobs/${id}/approve`, {}, TOKEN()), "Funds released");
          return;
        }
        if (act === "reject") {
          const v = await openFormModal({
            title: "Request a revision",
            subtitle: "The funds stay locked in the vault while the freelancer revises.",
            submitLabel: "Request revision",
            fields: [
              {
                name: "reason",
                label: "What needs changing?",
                type: "textarea",
                rows: 5,
                maxlength: 3000,
                placeholder: "Be specific about what is missing or wrong and what done looks like.",
                required: true,
                autofocus: true,
              },
            ],
            onSubmit: async (values) => {
              await api("POST", `/jobs/${id}/reject`, { reason: values.reason }, TOKEN());
            },
          });
          btn.disabled = false;
          if (v) { toast("Revision requested", "ok"); render(); }
          return;
        }
        if (act === "rate") {
          const v = await openFormModal({
            title: "Rate this contract",
            subtitle: "Your rating is the freelancer's public reputation in the directory.",
            submitLabel: "Submit rating",
            fields: [
              { name: "stars", label: "How did it go?", type: "stars", value: 5 },
              { name: "comment", label: "Comment (optional)", type: "textarea", rows: 3, maxlength: 1000, placeholder: "What stood out?" },
            ],
            onSubmit: async (values) => {
              await api("POST", `/jobs/${id}/rating`, { stars: Number(values.stars), comment: values.comment || "" }, TOKEN());
            },
          });
          btn.disabled = false;
          if (v) { toast("Rating saved", "ok"); render(); }
          return;
        }
      } catch (err) {
        toast(err.message, "err");
        btn.disabled = false;
      }
    };
  });

  document.querySelectorAll("[data-accept]").forEach((b) => {
    b.onclick = async () => {
      const ok = await openConfirmModal({
        title: "Accept this applicant?",
        body: "They become the assigned freelancer on this contract. You can still message them before they start.",
        confirmLabel: "Accept and assign",
      });
      if (ok) run(() => api("POST", `/jobs/${id}/applications/${b.dataset.accept}/accept`, {}, TOKEN()), "Applicant accepted");
    };
  });
  document.querySelectorAll("[data-decline]").forEach((b) => {
    b.onclick = () => run(() => api("POST", `/jobs/${id}/applications/${b.dataset.decline}/decline`, {}, TOKEN()), "Applicant declined");
  });

  const send = $("#msg-send");
  if (send) {
    const doSend = () => {
      const input = $("#msg-input");
      const body = input.value.trim();
      if (!body) return;
      run(() => api("POST", `/jobs/${id}/messages`, { body }, TOKEN()), "Message sent");
    };
    send.onclick = doSend;
    $("#msg-input").addEventListener("keydown", (e) => { if (e.key === "Enter") doSend(); });
  }
}

// ---------------------------------------------------------------------------
// Freelancer directory
// ---------------------------------------------------------------------------
async function viewPublicBrowse() {
  const [dir, tax] = await Promise.all([
    api("GET", "/freelancers"),
    api("GET", "/meta/taxonomy").catch(() => ({ domains: [] })),
  ]);
  state.taxonomy = tax;
  state.people = dir.freelancers || [];
  const asGuest = !state.session;
  return `
    ${pageHeader(asGuest ? "Escrow-backed freelance work on Solana" : "Find freelancers",
      asGuest
        ? "Browse published profiles, then sign in to post a contract. Every job's budget is locked in a vault before work starts."
        : "Every profile here has skills and a published portfolio.",
      asGuest ? `<a class="btn btn-pill btn-sm" href="/signup">Get started</a>` : "")}
    ${asGuest ? anonymousPitch() : ""}
    <div class="card filters" data-reveal>
      <input id="dir-search" placeholder="Search by name, headline or skill…" />
      <select id="dir-domain">
        <option value="">All categories</option>
        ${(tax.domains || []).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}
      </select>
    </div>
    <div id="dir-grid" class="grid-cards"></div>`;
}

function afterPublicBrowse() {
  const people = state.people || [];
  const grid = $("#dir-grid");
  const search = $("#dir-search");
  const domainSel = $("#dir-domain");
  if (!grid) return;

  const renderCards = () => {
    const q = (search.value || "").toLowerCase();
    const domainId = domainSel.value;
    const domName = domainId
      ? ((state.taxonomy.domains || []).find((d) => String(d.id) === domainId) || {}).name || ""
      : "";
    const rows = people.filter((p) => {
      const hay = `${p.headline || ""} ${p.skills || ""} ${p.bio || ""} ${p.id}`.toLowerCase();
      if (q && !hay.includes(q)) return false;
      if (domName && !String(p.skills || "").toLowerCase().includes(domName.toLowerCase())) return false;
      return true;
    });
    grid.innerHTML = rows.length
      ? rows.map((p) => `
        <a class="card person-card" href="/app#/freelancer/${p.id}" data-reveal>
          ${isImageUrl(p.cover_url) ? `<div class="person-cover"><img src="${esc(p.cover_url)}" alt="" loading="lazy" decoding="async" /></div>` : ""}
          <div class="row gap-12">
            ${avatarFor(p.id, (p.skills || "").split(",")[0] || String(p.id))}
            <div>
              <h3 class="person-name">Freelancer #${p.id}</h3>
              <p class="dim small">${esc(p.headline || "Freelancer")}</p>
            </div>
          </div>
          <p class="dim person-bio">${esc((p.bio || "").slice(0, 120))}${(p.bio || "").length > 120 ? "…" : ""}</p>
          <div class="chips">${skillChips(p.skills, 4)}</div>
          <div class="row between person-foot">
            <span>${stars(p.avg_rating)}</span>
            <span class="dim">${p.settled_jobs || 0} settled · ${p.portfolio_count || 0} items</span>
          </div>
          <div class="row between person-foot dim small">
            <span>${Number(p.hourly_rate_sol || 0).toFixed(2)} SOL/hr</span>
            <span>${p.years_experience || 0} yrs experience</span>
          </div>
        </a>`).join("")
      : emptyState("No freelancers match", "Try a different search term or category.");
    if (window.SolhustleMotion) window.SolhustleMotion.refresh();
  };
  search.addEventListener("input", renderCards);
  domainSel.addEventListener("change", renderCards);
  renderCards();
}

function anonymousPitch() {
  return `<div class="grid-3">
    ${stat("Locked, not promised", "Escrow vault", "The budget leaves the client's wallet up front")}
    ${stat("Release on approval", "1 click", "Or a revision request holds the funds")}
    ${stat("Verifiable", "Solscan", "Every deposit and release is a real transaction")}
  </div>`;
}

// ---------------------------------------------------------------------------
// Public freelancer profile
// ---------------------------------------------------------------------------
async function viewProfile() {
  const id = state.route.id;
  const d = await api("GET", `/freelancer/profile/${id}`);
  const p = d.profile || {};
  const stats = d.stats || {};
  const items = d.portfolio || [];
  const skills = d.skills || [];
  const displayName = p.headline || `Freelancer #${id}`;

  return `
    ${pageHeader(`Freelancer profile`, `Account #${id}`)}
    <div class="card profile-hero" data-reveal>
      <div class="row gap-16 wrap">
        ${avatarFor(id, displayName)}
        <div class="grow">
          <h2 class="profile-name">${esc(p.headline || "Freelancer")}</h2>
          <p class="dim">${esc(p.bio || "No bio yet.")}</p>
          <div class="chips">${skills.map((s) => `<span class="chip">${esc(s.name)}</span>`).join("") || `<span class="dim small">No skills listed</span>`}</div>
        </div>
        <div class="profile-cta">
          ${state.session && uid() !== id
            ? `<button class="btn sec" type="button" data-message-user="${id}">Message</button>`
            : ""}
          ${state.session
            ? (can("client")
              ? `<a class="btn btn-pill" href="/app#/jobs/new">Invite to a job</a>`
              : `<span class="dim small">Enable hiring to post a contract</span>`)
            : `<a class="btn btn-pill" href="/signup">Sign up to hire</a>`}
        </div>
      </div>
    </div>
    <div class="grid-3">
      ${stat("Rating", stats.avg_rating ? `${Number(stats.avg_rating).toFixed(1)} ★` : "—", `${stats.rating_count || 0} reviews`)}
      ${stat("Settled contracts", stats.settled_jobs || 0, "Released through escrow")}
      ${stat("Rate", p.hourly_rate_sol ? `${Number(p.hourly_rate_sol).toFixed(2)} SOL/hr` : "—", `${p.years_experience || 0} yrs experience`)}
    </div>
    ${p.degrees || p.languages ? `<div class="card" data-reveal>
      ${p.degrees ? `<h3 class="h-sub">Education</h3><p>${esc(p.degrees)}</p>` : ""}
      ${p.languages ? `<h3 class="h-sub">Languages</h3><p>${esc(p.languages)}</p>` : ""}
    </div>` : ""}
    <section data-reveal>
      <h2 class="h-sec">Portfolio <span class="dim">(${items.length})</span></h2>
      <div class="work-grid">
        ${items.length
          ? items.map((it) => portfolioItemHtml(it)).join("")
          : emptyState("No portfolio items yet", "This freelancer hasn't published work yet.")}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// My profile
// ---------------------------------------------------------------------------
async function loadMyProfile() {
  if (!can("freelancer")) return null;
  const d = await api("GET", "/me/profile", undefined, TOKEN());
  state.profile = d.profile || {};
  state.portfolio = d.portfolio || [];
  state.skills = d.subdomains || [];
  return d;
}

function completeness(d) {
  const p = d.profile || {};
  const checks = [
    ["Headline", !!p.headline],
    ["Bio", !!p.bio],
    ["Skills", (d.subdomains || []).length > 0],
    ["Portfolio item", (d.portfolio || []).length > 0],
    ["Published", p.portfolio_ready === 1],
    ["Hourly rate", Number(p.hourly_rate_sol) > 0],
  ];
  const done = checks.filter(([, ok]) => ok).length;
  const percent = Math.round((done / checks.length) * 100);
  const next = checks.find(([, ok]) => !ok);
  return {
    percent,
    checks,
    hint: next ? `Next: add your ${next[0].toLowerCase()} to reach 100%.` : "Your profile is complete and visible in the directory.",
  };
}

async function viewMe() {
  if (!can("freelancer")) {
    return `${pageHeader("My profile", "Freelancer side not enabled")}
      <div class="card">
        <p class="dim">Add the freelancer side to publish a profile, skills and a portfolio that clients can find.</p>
        <button class="btn btn-pill" data-grant="freelancer">Become a freelancer</button>
      </div>`;
  }
  const [d, tax] = await Promise.all([
    api("GET", "/me/profile", undefined, TOKEN()),
    api("GET", "/meta/taxonomy").catch(() => ({ domains: [] })),
  ]);
  state.profile = d.profile || {};
  state.portfolio = d.portfolio || [];
  state.skills = d.subdomains || [];
  state.taxonomy = tax;
  const comp = completeness(d);
  const p = state.profile;
  const chosen = new Set(state.skills.map((s) => s.id));

  return `
    ${pageHeader("My profile", "This is what clients see in the directory and on your public page.",
      `<a class="btn sec btn-sm" href="/app#/freelancer/${uid()}">View public page</a>`)}
    <div class="card" data-reveal>
      <div class="row between"><h3 class="h-sub">Profile completeness</h3><b>${comp.percent}%</b></div>
      <div class="meter"><span style="width:${comp.percent}%"></span></div>
      <div class="chips">${comp.checks.map(([label, ok]) => `<span class="chip ${ok ? "ok" : ""}">${ok ? "✓" : "○"} ${esc(label)}</span>`).join("")}</div>
      <p class="dim">${esc(comp.hint)}</p>
    </div>
    <div class="grid-2">
      <form class="card" id="fp-form" data-reveal>
        <h3 class="h-sub">Profile</h3>
        <label class="field"><span>Headline</span>
          <input id="fp-headline" maxlength="200" value="${esc(p.headline || "")}" placeholder="Solana core developer & Anchor specialist" /></label>
        <label class="field"><span>Bio</span>
          <textarea id="fp-bio" rows="6" maxlength="4000" placeholder="What you build, how you work, what you're best at.">${esc(p.bio || "")}</textarea></label>
        <div class="row gap-12">
          <label class="field grow"><span>Hourly rate (SOL)</span>
            <input id="fp-rate" type="number" min="0" step="0.05" value="${esc(p.hourly_rate_sol ?? 0.75)}" /></label>
          <label class="field grow"><span>Years of experience</span>
            <input id="fp-years" type="number" min="0" max="60" value="${esc(p.years_experience ?? 0)}" /></label>
        </div>
        <label class="field"><span>Education / certifications</span>
          <input id="fp-degrees" maxlength="500" value="${esc(p.degrees || "")}" /></label>
        <label class="field"><span>Languages</span>
          <input id="fp-languages" maxlength="500" value="${esc(p.languages || "")}" /></label>
        <button class="btn btn-pill" type="submit" id="fp-submit">Save profile</button>
      </form>
      <div class="col">
        <div class="card" data-reveal>
          <h3 class="h-sub">Skills <span class="dim">(max 12)</span></h3>
          <div class="chips">
            ${(tax.domains || []).map((dom) => `
              <div class="skill-group">
                <span class="skill-dom">${esc(dom.name)}</span>
                <div class="chips">
                  ${(dom.subdomains || []).map((s) =>
                    `<button type="button" class="chip toggle ${chosen.has(s.id) ? "on" : ""}" data-skill="${s.id}">${esc(s.name)}</button>`).join("")}
                </div>
              </div>`).join("")}
          </div>
          <button class="btn sec" id="skills-save" type="button">Save skills</button>
        </div>
        <div class="card" data-reveal>
          <h3 class="h-sub">Portfolio <span class="dim">(${state.portfolio.length})</span></h3>
          <div class="portfolio-editor" id="portfolio-list">
            ${state.portfolio.map((it) => {
              const a = {
                type: it.media_type && it.media_type !== "link" ? it.media_type : inferAttachmentType(it.media_url),
                url: it.media_url,
                label: it.title || "",
              };
              return `<div class="portfolio-row">
                <div class="portfolio-thumb">${attachmentThumbHtml(a)}</div>
                <div class="grow">
                  <b>${esc(it.title || "Untitled")}</b>
                  <div class="dim small mono">${esc(short(it.media_url.replace(/^https?:\/\//, ""), 46))}</div>
                </div>
                <span class="chip">${esc(ATTACHMENT_WORD[a.type] || "Link")}</span>
                <button class="btn sec danger-sec btn-sm" data-del-portfolio="${it.id}" aria-label="Remove this item">Remove</button>
              </div>`;
            }).join("") || `<p class="dim">No items yet. Add a screenshot, a repo, or a video walkthrough.</p>`}
          </div>
          <div class="row gap-8">
            <button class="btn sec" id="pf-add" type="button">+ Add portfolio item</button>
            <button class="btn btn-pill" id="pf-publish" type="button">Publish profile</button>
          </div>
          ${p.portfolio_ready === 1 ? `<p class="ok-text small">Published — you appear in the directory.</p>` : `<p class="dim small">Publish once you have at least one item and one skill.</p>`}
        </div>
      </div>
    </div>`;
}

function afterMe() {
  const grant = document.querySelector("[data-grant]");
  if (grant) {
    grant.onclick = async () => {
      const r = await api("POST", "/auth/roles", { role: grant.dataset.grant, activate: true }, TOKEN());
      state.session.token = r.token;
      state.session.user = r.user;
      writeSession(state.session);
      location.reload();
    };
  }
  const form = $("#fp-form");
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("#fp-submit");
      btn.disabled = true;
      try {
        await api("POST", "/me/freelancer/profile", {
          headline: $("#fp-headline").value.trim(),
          bio: $("#fp-bio").value.trim(),
          hourly_rate_sol: Number($("#fp-rate").value),
          years_experience: Number($("#fp-years").value),
          degrees: $("#fp-degrees").value.trim(),
          languages: $("#fp-languages").value.trim(),
        }, TOKEN());
        toast("Profile saved", "ok");
        render();
      } catch (err) { toast(err.message, "err"); btn.disabled = false; }
    };
  }
  document.querySelectorAll("[data-skill]").forEach((el) => {
    el.onclick = () => el.classList.toggle("on");
  });
  const skillsSave = $("#skills-save");
  if (skillsSave) {
    skillsSave.onclick = async () => {
      const ids = Array.from(document.querySelectorAll("[data-skill].on")).map((el) => Number(el.dataset.skill));
      try {
        await api("POST", "/me/freelancer/skills", { subdomain_ids: ids }, TOKEN());
        toast(`${ids.length} skills saved`, "ok");
        render();
      } catch (err) { toast(err.message, "err"); }
    };
  }
  const pfAdd = $("#pf-add");
  if (pfAdd) {
    pfAdd.onclick = async () => {
      const v = await openFormModal({
        title: "Add a portfolio item",
        subtitle: "Clients see this on your public page. Images show as a cover on your directory card.",
        submitLabel: "Add to portfolio",
        fields: [
          { name: "title", label: "Title", type: "text", maxlength: 200, placeholder: "Escrow flow — on-chain settlement", autofocus: true },
          {
            name: "type",
            label: "What is it?",
            type: "select",
            value: "image",
            options: ATTACHMENT_KINDS.map(([value, label]) => ({ value, label })),
          },
          { name: "url", label: "Link", type: "url", maxlength: 1000, placeholder: "https://…", required: true },
        ],
        html: `${dropzoneHtml({ label: "Drag in a cover image or video" })}
          <div class="attach-preview-box" data-preview hidden></div>`,
        onReady: (form) => {
          const urlEl = form.querySelector('[name="url"]');
          const typeEl = form.querySelector('[name="type"]');
          const titleEl = form.querySelector('[name="title"]');
          const box = form.querySelector("[data-preview]");
          const okUrl = (url) => /^https?:\/\//i.test(url) || isUploadRef(url);
          const paint = () => {
            const url = urlEl.value.trim();
            if (!okUrl(url)) { box.hidden = true; return; }
            box.hidden = false;
            box.innerHTML = `<span class="dim small">Preview</span>${attachmentThumbHtml({ type: typeEl.value, url })}`;
          };
          urlEl.addEventListener("input", paint);
          typeEl.addEventListener("change", paint);
          // The same dropzone as the delivery composer: a file dropped here
          // fills the form in, so the item is created straight from the upload.
          return wireDropzone(form, {
            token: TOKEN(),
            onUploaded: (a) => {
              urlEl.value = a.url;
              typeEl.value = a.type === "video" ? "video" : "image";
              if (!titleEl.value.trim() && a.label) titleEl.value = a.label;
              paint();
            },
          });
        },
        onSubmit: async (values) => {
          await api("POST", "/me/portfolio", { title: values.title, media_url: values.url, media_type: values.type }, TOKEN());
        },
      });
      if (v) { toast("Portfolio item added", "ok"); render(); }
    };
  }
  const pfPub = $("#pf-publish");
  if (pfPub) {
    pfPub.onclick = async () => {
      try {
        await api("POST", "/me/portfolio/publish", {}, TOKEN());
        toast("Profile published — you're in the directory", "ok");
        render();
      } catch (err) { toast(err.message, "err"); }
    };
  }
  document.querySelectorAll("[data-del-portfolio]").forEach((b) => {
    b.onclick = async () => {
      const ok = await openConfirmModal({
        title: "Remove this portfolio item?",
        body: "It disappears from your public profile and directory card straight away.",
        confirmLabel: "Remove",
      });
      if (!ok) return;
      try {
        await api("DELETE", `/me/portfolio/${b.dataset.delPortfolio}`, undefined, TOKEN());
        toast("Removed", "ok");
        render();
      } catch (err) { toast(err.message, "err"); }
    };
  });
}

// ---------------------------------------------------------------------------
// Operator console (staff only)
// ---------------------------------------------------------------------------
async function viewOperator() {
  const [health, recon, users, jobs, disputes, audit] = await Promise.all([
    api("GET", "/admin/health", undefined, TOKEN()).catch((e) => ({ error: e.message })),
    api("GET", "/admin/reconciliation", undefined, TOKEN()).catch((e) => ({ error: e.message })),
    api("GET", "/admin/users", undefined, TOKEN()).catch((e) => ({ users: [] })),
    api("GET", "/admin/jobs", undefined, TOKEN()).catch((e) => ({ jobs: [] })),
    api("GET", "/admin/disputes", undefined, TOKEN()).catch((e) => ({ disputes: [] })),
    api("GET", "/admin/audit", undefined, TOKEN()).catch((e) => ({ actions: [] })),
  ]);
  const rows = (arr) => (Array.isArray(arr) ? arr : []);
  const userList = rows(users.users || users);
  const jobList = rows(jobs.jobs);
  const disputeList = rows(disputes.disputes);
  const auditList = rows(audit.actions || audit.entries);

  const kvTable = (obj, depth = 0) => {
    if (obj === null || typeof obj !== "object") return esc(String(obj));
    return `<div class="kv">${Object.entries(obj)
      .map(([k, v]) =>
        `<span class="k">${esc(k.replace(/_/g, " "))}</span><span>${
          v !== null && typeof v === "object" ? kvTable(v, depth + 1) : esc(String(v))
        }</span>`)
      .join("")}</div>`;
  };

  return `
    ${pageHeader("Operator console", "Health, reconciliation, users, jobs and disputes.")}
    <div class="grid-2">
      <div class="card" data-reveal><h3 class="h-sub">System health</h3>${kvTable(health)}</div>
      <div class="card" data-reveal><h3 class="h-sub">Reconciliation</h3>${kvTable(recon)}</div>
    </div>
    <div class="card" data-reveal>
      <h3 class="h-sub">Disputes <span class="dim">(${disputeList.length})</span></h3>
      <p class="dim small">
        A ruling is final and reaches the chain: releasing pays the freelancer out of the vault,
        holding keeps the money in escrow and detaches them from the job.
      </p>
      ${disputeList.length
        ? `<div class="stack-sm">${disputeList.map((dp) => `
            <div class="row between list-row">
              <div>
                <b>Job #${dp.job_id}</b> <span class="dim">${esc(dp.job_title || "")}</span>
                <p class="dim small">${esc(String(dp.reason || "").slice(0, 200))}</p>
              </div>
              ${dp.status === "open"
                ? `<div class="row gap-8">
                     <button class="btn sec btn-sm" data-rule-dispute="${dp.id}" data-outcome="hold_buyer">Hold funds</button>
                     <button class="btn btn-pill btn-sm" data-rule-dispute="${dp.id}" data-outcome="release_freelancer">Release to freelancer</button>
                   </div>`
                : pill(dp.status)}
            </div>`).join("")}</div>`
        : `<p class="dim">No disputes open.</p>`}
    </div>
    <div class="card" data-reveal>
      <h3 class="h-sub">Jobs <span class="dim">(${jobList.length})</span></h3>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>#</th><th>Title</th><th>Status</th><th>USD</th><th>SOL</th></tr></thead>
        <tbody>${jobList.slice(0, 25).map((j) => `
          <tr><td>${j.id}</td><td>${esc(j.title)}</td><td>${pill(j.status)}</td>
          <td>$${esc(j.usd_budget)}</td><td>${Number(j.sol_amount || 0).toFixed(4)}</td></tr>`).join("")}
        </tbody></table></div>
    </div>
    <div class="card" data-reveal>
      <h3 class="h-sub">Accounts <span class="dim">(${userList.length})</span></h3>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>#</th><th>Wallet</th><th>Role</th><th>Entitled</th><th>Status</th></tr></thead>
        <tbody>${userList.slice(0, 30).map((u) => `
          <tr><td>${u.id}</td><td class="mono">${esc(short(u.wallet_address, 14))}</td>
          <td>${esc(roleLabel(u.role))}</td><td class="dim">${esc(u.roles || u.role || "")}</td><td>${esc(u.status)}</td></tr>`).join("")}
        </tbody></table></div>
    </div>
    <div class="card" data-reveal>
      <h3 class="h-sub">Audit trail <span class="dim">(${auditList.length})</span></h3>
      ${auditList.length
        ? `<div class="stack-sm">${auditList.slice(0, 20).map((a) => `
            <div class="row between list-row">
              <span>${esc(a.action_type || a.event || "")} · ${esc(a.target_entity || "")}${a.target_id ? " #" + a.target_id : ""}</span>
              <span class="dim small">${esc(fmtDate(a.created_at))}</span>
            </div>`).join("")}</div>`
        : `<p class="dim">No audit entries.</p>`}
    </div>`;
}

// ---------------------------------------------------------------------------
// Messages — direct chat between clients and freelancers.
//
// Two panes: the inbox on the left, one conversation on the right. The open
// thread lives in the URL (#/messages/12), so a conversation is linkable, and
// polling is scoped to whichever thread is actually on screen.
// ---------------------------------------------------------------------------
let chatTimer = null;

const dateOf = (ts) => String(ts || "").slice(0, 10);
const clockOf = (ts) => String(ts || "").slice(11, 16);
const isoDay = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;

/** Compact stamp for a list row: the time if it is today, else a short date. */
function chatStamp(ts) {
  const d = dateOf(ts);
  if (!d) return "";
  const now = new Date();
  if (d === isoDay(now)) return clockOf(ts);
  if (d === isoDay(new Date(now.getTime() - 86400000))) return "Yesterday";
  return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function chatDayLabel(ts) {
  const d = dateOf(ts);
  const now = new Date();
  if (d === isoDay(now)) return "Today";
  if (d === isoDay(new Date(now.getTime() - 86400000))) return "Yesterday";
  return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

const personAvatar = (p) => `<span class="avatar" aria-hidden="true">${esc(initials({ username: p.name }))}</span>`;

/** One bubble, prefixed by a day separator when the date changes. */
function messageHtml(m, day) {
  const sep = day !== dateOf(m.created_at)
    ? `<div class="chat-day"><span>${esc(chatDayLabel(m.created_at))}</span></div>`
    : "";
  return `${sep}<div class="bubble ${m.mine ? "out" : "in"}" data-msg="${m.id}" data-day="${esc(dateOf(m.created_at))}">${esc(m.body)}<span class="bubble-meta">${esc(clockOf(m.created_at))}</span></div>`;
}

function threadHtml(messages) {
  let day = "";
  return messages.map((m) => {
    const html = messageHtml(m, day);
    day = dateOf(m.created_at);
    return html;
  }).join("");
}

function threadRowHtml(t, activeId) {
  const preview = t.last_message
    ? `${t.last_message.mine ? "You: " : ""}${String(t.last_message.body).replace(/\s+/g, " ")}`
    : "No messages yet";
  return `<button class="thread${t.id === activeId ? " on" : ""}${t.unread ? " unread" : ""}" data-thread="${t.id}" type="button">
    ${personAvatar(t.other)}
    <span class="thread-body">
      <span class="thread-top">
        <span class="thread-name">${esc(t.other.name)}</span>
        <span class="thread-time">${esc(t.last_message ? chatStamp(t.last_message.created_at) : "")}</span>
      </span>
      <span class="thread-preview">${esc(short(preview, 48))}</span>
    </span>
    ${t.unread ? `<span class="unread-pill">${t.unread > 9 ? "9+" : t.unread}</span>` : ""}
  </button>`;
}

function personRowHtml(p) {
  return `<button class="person-row" data-person="${p.id}" type="button">
    ${personAvatar(p)}
    <span class="grow">
      <b>${esc(p.name)}</b>
      <span class="dim small">${esc(p.headline || roleLabel(p.role))}</span>
    </span>
    <span class="chip">Message</span>
  </button>`;
}

async function viewMessages() {
  const convId = state.route.id;
  const inbox = await api("GET", "/conversations", undefined, TOKEN());
  const threads = inbox.threads || [];
  const people = inbox.people || [];

  let active = null;
  let messages = [];
  if (convId) {
    // Full history on open; the poll below asks only for what is newer than the
    // last bubble, which usually comes back empty.
    const thread = await api("GET", `/conversations/${convId}/messages`, undefined, TOKEN());
    active = thread;
    messages = thread.messages || [];
  }
  refreshUnreadBadge(state.session);

  const listHtml = threads.length
    ? threads.map((t) => threadRowHtml(t, convId)).join("")
    : people.length
      ? people.map(personRowHtml).join("")
      : `<div class="chat-empty"><div>
           <h3>No conversations yet</h3>
           <p class="dim small">Open a freelancer from Browse talent and hit Message to start one.</p>
         </div></div>`;

  const side = `
    <aside class="chat-side">
      <div class="chat-side-head">
        <div class="row">
          <h2>Messages</h2>
          ${threads.length ? `<span class="chip dim">${threads.length}</span>` : ""}
        </div>
        ${threads.length ? `<input class="chat-search" id="chat-search" type="search" placeholder="Search conversations" aria-label="Search conversations" />` : ""}
      </div>
      <div class="chat-list" id="chat-list">${listHtml}</div>
    </aside>`;

  const main = active
    ? `
    <section class="chat-main">
      <header class="chat-head">
        ${personAvatar(active.other)}
        <div class="grow">
          <b>${esc(active.other.name)}</b>
          <span class="dim">${esc(active.other.headline || roleLabel(active.other.role))}</span>
        </div>
        <a class="btn sec btn-sm" href="/app#/freelancer/${active.other.id}">View profile</a>
      </header>
      <div class="chat-scroll" id="chat-scroll">
        <div class="chat-thread" id="chat-thread">${threadHtml(messages)}</div>
      </div>
      <form class="chat-composer" id="chat-form">
        <textarea id="chat-input" rows="1" maxlength="2000" placeholder="Write a message — Enter sends, Shift+Enter adds a line" aria-label="Write a message"></textarea>
        <span class="chat-count" id="chat-count">0/2000</span>
        <button class="btn btn-pill btn-sm" type="submit">Send</button>
      </form>
    </section>`
    : `
    <section class="chat-main">
      <div class="chat-empty"><div>
        <h3>${threads.length ? "Pick a conversation" : "Your inbox is empty"}</h3>
        <p class="dim small">${threads.length
          ? "Messages here are between the two of you — they are not the contract log."
          : "Start with a freelancer from Browse talent, or from any profile."}</p>
        <a class="btn sec btn-sm" href="/app#/browse">Browse talent</a>
      </div></div>
    </section>`;

  return pageHeader("Messages", "Talk directly with clients and freelancers — before, during and after a contract.")
    + `<div class="chat" data-reveal>${side}${main}</div>`;
}

function afterMessages() {
  const convId = state.route.id;
  const list = $("#chat-list");

  if (list) {
    list.querySelectorAll("[data-thread]").forEach((btn) => {
      btn.onclick = () => go(`/messages/${btn.dataset.thread}`);
    });
    list.querySelectorAll("[data-person]").forEach((btn) => {
      btn.onclick = () => openThreadWith(Number(btn.dataset.person), btn);
    });
    const search = $("#chat-search");
    if (search) {
      search.oninput = () => {
        const q = search.value.trim().toLowerCase();
        list.querySelectorAll("[data-thread]").forEach((btn) => {
          btn.hidden = q.length > 0 && !btn.textContent.toLowerCase().includes(q);
        });
      };
    }
  }

  const scroll = $("#chat-scroll");
  if (scroll) scroll.scrollTop = scroll.scrollHeight;

  const form = $("#chat-form");
  if (!form) return;
  const input = $("#chat-input");
  const count = $("#chat-count");

  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  };
  const paintCount = () => {
    count.textContent = `${input.value.length}/2000`;
    count.classList.toggle("over", input.value.length > 2000);
  };
  input.addEventListener("input", () => { grow(); paintCount(); });
  input.addEventListener("keydown", (e) => {
    // Enter sends, Shift+Enter adds a line — the keys every chat already uses.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.onsubmit = (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.value = "";
    grow();
    paintCount();
    sendChatMessage(convId, body);
  };
  grow();

  // Poll while this thread is on screen and the tab is visible.
  clearInterval(chatTimer);
  chatTimer = setInterval(async () => {
    if (document.visibilityState !== "visible" || !$("#chat-thread")) return;
    const bubbles = document.querySelectorAll("#chat-thread [data-msg]");
    const lastId = bubbles.length ? Number(bubbles[bubbles.length - 1].dataset.msg) : 0;
    try {
      const r = await api("GET", `/conversations/${convId}/messages?after=${lastId}`, undefined, TOKEN());
      const fresh = r.messages || [];
      if (!fresh.length) return;
      appendBubbles(fresh);
      // Painting them is what makes them read, which is why the poll itself does
      // not mark anything read server-side.
      await api("POST", `/conversations/${convId}/read`, {}, TOKEN());
      refreshUnreadBadge(state.session);
    } catch {
      /* a dropped poll is not worth a toast; the next tick retries */
    }
  }, 4000);
}

function appendBubbles(messages) {
  const thread = $("#chat-thread");
  const scroll = $("#chat-scroll");
  if (!thread || !messages.length) return;
  const bubbles = thread.querySelectorAll("[data-msg]");
  let day = bubbles.length ? bubbles[bubbles.length - 1].getAttribute("data-day") : "";
  const html = messages.map((m) => {
    const out = messageHtml(m, day);
    day = dateOf(m.created_at);
    return out;
  }).join("");
  thread.insertAdjacentHTML("beforeend", html);
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

/**
 * Send with the bubble already on screen. A slow network should feel like a slow
 * bubble, not a dead composer — so it goes up dimmed and is reconciled (or marked
 * failed, with the text still visible) when the server answers.
 */
async function sendChatMessage(convId, body) {
  const thread = $("#chat-thread");
  const scroll = $("#chat-scroll");
  if (!thread) return;
  const el = document.createElement("div");
  el.className = "bubble out pending";
  el.innerHTML = `${esc(body)}<span class="bubble-meta">Sending…</span>`;
  thread.appendChild(el);
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
  try {
    const r = await api("POST", `/conversations/${convId}/messages`, { body }, TOKEN());
    el.classList.remove("pending");
    el.setAttribute("data-msg", String(r.message.id));
    el.setAttribute("data-day", dateOf(r.message.created_at));
    el.innerHTML = `${esc(r.message.body)}<span class="bubble-meta">${esc(clockOf(r.message.created_at))}</span>`;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  } catch (err) {
    el.classList.remove("pending");
    el.classList.add("failed");
    el.innerHTML = `${esc(body)}<span class="bubble-meta">Not sent — ${esc(err.message)}</span>`;
    toast(err.message, "err");
  }
}

/**
 * Adjudication. `POST /disputes/:id/rule` settles a disputed contract and, for a
 * release, moves the money out of the vault on-chain — the one operator action
 * that spends funds, so it asks for written notes first and the ruling is stored
 * with them in the audit trail.
 */
function afterOperator() {
  document.querySelectorAll("[data-rule-dispute]").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.ruleDispute;
      const outcome = btn.dataset.outcome;
      const releasing = outcome === "release_freelancer";
      btn.disabled = true;
      const v = await openFormModal({
        title: releasing ? "Release the vault to the freelancer" : "Hold the funds",
        subtitle: releasing
          ? "This settles the contract and pays the freelancer from escrow."
          : "The money stays in the vault and the freelancer is detached from the job.",
        submitLabel: releasing ? "Release and settle" : "Hold and detach",
        fields: [
          {
            name: "notes",
            label: "Ruling notes",
            type: "textarea",
            rows: 4,
            maxlength: 3000,
            autofocus: true,
            placeholder: "What you checked, and why the vault should go this way.",
          },
        ],
        onSubmit: async (values) => {
          await api("POST", `/disputes/${id}/rule`, { outcome, notes: values.notes }, TOKEN());
        },
      });
      btn.disabled = false;
      if (v) {
        toast(releasing ? "Released to the freelancer" : "Funds held, freelancer detached", "ok");
        render();
      }
    };
  });
}

/** Open (or reuse) the thread with someone, then show it. */
async function openThreadWith(userId, btn) {
  if (!userId) return;
  if (btn) btn.disabled = true;
  try {
    const r = await api("POST", "/conversations", { user_id: userId }, TOKEN());
    go(`/messages/${r.id}`);
  } catch (err) {
    toast(err.message, "err");
    if (btn) btn.disabled = false;
  }
}

/** Every "Message" button in the app, wherever it was rendered. */
function wireMessageButtons() {
  document.querySelectorAll("[data-message-user]").forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.onclick = () => openThreadWith(Number(btn.dataset.messageUser), btn);
  });
}

function afterProfile() {
  wireMessageButtons();
}

