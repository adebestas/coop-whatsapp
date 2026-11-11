/* ============================================================
   Platform Console — App Logic (dashboard/dev/dev.js)
   Consumes /api/developer/*. Session is an httpOnly cookie; every
   non-GET carries X-Requested-With: XMLHttpRequest, and a 401 sends
   the operator back to dev-login.html.
   ============================================================ */

(function () {
  "use strict";

  // ---- Config ----
  const API_BASE = "/api/developer";
  const STORAGE_ADMIN = "coop_dev_admin";
  const STORAGE_THEME = "coop_theme";

  // ---- State ----
  let me = null;
  let readOnly = false; // support role: GETs only
  let isOwner = false;
  let needsPinChange = false; // temporary PIN: show the change-PIN view and stop navigating
  let currentPage = "overview";
  let currentArg = null;
  let currentCoopTab = "health";
  let coopDetail = null;
  let coopRegulator = { profile: null, reports: [] };
  let coopRegisters = { breaches: [], dpias: [], crossBorderTransfers: [], breachSummary: {} };
  let regulatorFileTarget = null;
  let regulatorFilingDraft = null;
  let coopActivityEntries = [];
  let coopsData = [];
  let policiesData = [];
  let ruleByKey = {};
  let loaderCount = 0;
  let sandboxOverview = null;
  let sandboxPersonaId = "active_saver";
  let sandboxState = null;
  let sandboxAiEnabled = true;
  const sandboxTranscripts = {};
  const sandboxTurnMeta = {};

  // ---- Init ----
  document.addEventListener("DOMContentLoaded", init);

  // ---- Delegated handlers (CSP: no inline scripts) ----
  function runAction(el, event) {
    const fn = window[el.dataset.action || el.dataset.actionChange];
    if (typeof fn !== "function") return;
    if (el.dataset.arg1 !== undefined || el.dataset.arg2 !== undefined) {
      fn(el.dataset.arg1, el.dataset.arg2, event, el);
    } else {
      fn(el.dataset.arg, event, el);
    }
  }
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (el) runAction(el, e);
  });
  document.addEventListener("change", (e) => {
    const el = e.target.closest("[data-action-change]");
    if (el) runAction(el, e);
  });
  document.addEventListener("input", (e) => {
    const id = e.target.id;
    if (regulatorFilingDraft && (id === "regAck" || id === "regNote")) {
      if (id === "regAck") regulatorFilingDraft.ack = e.target.value;
      else regulatorFilingDraft.note = e.target.value;
    }
  });

  async function init() {
    applyTheme(localStorage.getItem(STORAGE_THEME) || "light");
    // Verify the session with the server (the cookie is unreadable here).
    try {
      const res = await api("/me");
      me = res.admin;
      localStorage.setItem(STORAGE_ADMIN, JSON.stringify(me));
    } catch {
      return; // api() redirected on 401
    }
    readOnly = me.role === "support";
    isOwner = me.role === "owner";
    loadUserInfo();
    try {
      const p = await api("/policies");
      policiesData = p.policies || [];
      policiesData.forEach((row) => {
        if (row.rule) ruleByKey[row.key] = row.rule;
      });
    } catch {
      /* page still works without the rule catalogue */
    }
    navigateTo("overview");
  }

  function loadUserInfo() {
    if (!me) return;
    const name = me.name || "Operator";
    setText("meName", name);
    setText("userName", name);
    setText("userAvatar", name.charAt(0).toUpperCase());
    setText("userRole", roleLabel(me.role));
    const navAdmins = document.getElementById("navAdmins");
    if (navAdmins) navAdmins.hidden = !isOwner;
    const navCreate = document.getElementById("navCreate");
    if (navCreate) navCreate.hidden = readOnly;
    if (readOnly) {
      const navPolicies = document.getElementById("navPolicies");
      if (navPolicies) navPolicies.title = "Read-only (support role)";
    }
  }

  // ---- API helper ----
  async function tryRefresh() {
    try {
      const res = await fetch(`${API_BASE}/refresh`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const method = (opts.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      headers["X-Requested-With"] = "XMLHttpRequest";
    }
    if (opts.body && typeof opts.body === "object" && !(opts.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    showLoader();
    try {
      let res = await fetch(`${API_BASE}${path}`, { ...opts, headers, credentials: "same-origin" });
      if (res.status === 401 && path !== "/refresh" && (await tryRefresh())) {
        res = await fetch(`${API_BASE}${path}`, { ...opts, headers, credentials: "same-origin" });
      }
      if (res.status === 401) {
        localStorage.removeItem(STORAGE_ADMIN);
        window.location.href = "dev-login.html";
        throw new Error("Unauthorized");
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && data.error === "pin_change_required") {
        needsPinChange = true;
        showChangePinView();
        throw new Error("PIN change required");
      }
      if (res.status === 403 && data.error === "two_factor_setup_required") {
        window.location.href = "dev-login.html";
        throw new Error("Two-factor enrolment required");
      }
      if (!res.ok) {
        const error = new Error(data.error || `Request failed (${res.status})`);
        error.code = data.code;
        error.status = res.status;
        throw error;
      }
      return data;
    } finally {
      hideLoader();
    }
  }

  function showLoader() {
    loaderCount++;
    const el = document.getElementById("globalLoader");
    if (el) el.style.display = "flex";
  }
  function hideLoader() {
    loaderCount = Math.max(0, loaderCount - 1);
    if (loaderCount === 0) {
      const el = document.getElementById("globalLoader");
      if (el) el.style.display = "none";
    }
  }

  // ---- Theme / layout ----
  window.toggleTheme = function () {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
    localStorage.setItem(STORAGE_THEME, next);
  };
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const btn = document.getElementById("themeToggle");
    if (!btn) return;
    btn.innerHTML =
      theme === "dark"
        ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
        : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  }
  window.toggleSidebar = function () {
    document.getElementById("sidebar").classList.toggle("open");
    document.getElementById("sidebarOverlay").classList.toggle("open");
  };
  document.getElementById("sidebarOverlay")?.addEventListener("click", () => {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("sidebarOverlay").classList.remove("open");
  });

  window.logout = async function () {
    try {
      await api("/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    localStorage.removeItem(STORAGE_ADMIN);
    window.location.href = "dev-login.html";
  };

  // ---- Navigation ----
  window.navigateTo = function (page, arg) {
    if (needsPinChange) return; // the change-PIN view owns #pageContent
    if (typeof arg !== "string") arg = null;
    currentPage = page;
    currentArg = arg || null;
    document.querySelectorAll(".nav-item[data-page]").forEach((el) => {
      const on = el.dataset.page === page || (page === "coop" && el.dataset.page === "coops");
      el.classList.toggle("active", on);
      if (on) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    });
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("sidebarOverlay").classList.remove("open");
    if (page === "coop") currentCoopTab = "health";
    renderPage(page, arg);
  };

  window.refreshPage = function () {
    if (needsPinChange) return; // the change-PIN view owns #pageContent
    if (currentPage === "coop") renderCoopDetail(currentArg);
    else renderPage(currentPage, currentArg);
  };

  window.openCoop = function (id) {
    navigateTo("coop", id);
  };
  window.backToCoops = function () {
    navigateTo("coops");
  };

  function renderPage(page, arg) {
    if (needsPinChange) return; // the change-PIN view owns #pageContent
    const titles = {
      overview: "Overview",
      coops: "Cooperatives",
      coop: "Cooperative",
      create: "Create Cooperative",
      policies: "Platform Policies",
      admins: "Platform Admins",
      liquidity: "Liquidity",
      jobs: "Scheduler",
      diagnostics: "API & Gateway Diagnostics",
      webhooks: "Webhook Monitor",
      sandbox: "Bot Sandbox",
    };
    setText("pageTitle", titles[page] || "Platform Console");
    const content = document.getElementById("pageContent");
    switch (page) {
      case "overview":
        renderOverview(content);
        break;
      case "coops":
        renderCoops(content);
        break;
      case "coop":
        renderCoopDetail(arg);
        break;
      case "create":
        readOnly ? renderDenied(content) : renderCreateCoop(content);
        break;
      case "policies":
        renderPolicies(content);
        break;
      case "admins":
        isOwner ? renderAdmins(content) : renderDenied(content);
        break;
      case "liquidity":
        renderLiquidity(content);
        break;
      case "jobs":
        renderJobs(content);
        break;
      case "diagnostics":
        renderDiagnostics(content);
        break;
      case "webhooks":
        renderWebhooks(content);
        break;
      case "sandbox":
        renderSandbox(content);
        break;
      default:
        renderOverview(content);
    }
  }

  function renderDenied(el) {
    el.innerHTML = `<div class="empty-state"><h3>Access denied</h3><p>You do not have permission to view this page.</p></div>`;
  }

  // Temporary-PIN accounts are blocked from every non-auth endpoint, so instead
  // of bouncing to dev-login.html we render the change-PIN form in place.
  function showChangePinView() {
    const content = document.getElementById("pageContent");
    if (!content || content.dataset.pinChange === "true") return;
    content.dataset.pinChange = "true";
    setText("pageTitle", "Change PIN");
    content.innerHTML = `
      <div class="card" style="max-width:480px;">
        <div class="card-header"><span class="card-title">Set a new PIN</span></div>
        <div class="card-body">
          <p class="text-muted">Your account is still on a temporary PIN. Confirm the current PIN and set a new 6-digit PIN to continue.</p>
          <div class="form-field mt-4">
            <label>Current PIN</label>
            <input id="currentPin" class="policy-input" inputmode="numeric" maxlength="6" autocomplete="current-password">
          </div>
          <div class="form-field mt-4">
            <label>New 6-digit PIN</label>
            <input id="newPin" class="policy-input" inputmode="numeric" maxlength="6" autocomplete="new-password">
          </div>
          ${me?.totpEnabled ? `<div class="form-field mt-4">
            <label>Authenticator code</label>
            <input id="changePinTotp" class="policy-input" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
          </div>` : ""}
          <div id="changePinResult" class="mt-4"></div>
          <div class="flex gap-2 mt-4">
            <button class="btn btn-primary" data-action="changePinSubmit">Set PIN &amp; Continue</button>
          </div>
        </div>
      </div>`;
  }

  window.changePinSubmit = async function () {
    const newPin = (document.getElementById("newPin")?.value || "").trim();
    const currentPin = (document.getElementById("currentPin")?.value || "").trim();
    const totp = (document.getElementById("changePinTotp")?.value || "").trim();
    const result = document.getElementById("changePinResult");
    if (!/^\d{4,6}$/.test(currentPin)) {
      if (result) result.innerHTML = '<span class="text-red">Enter your current PIN.</span>';
      return;
    }
    if (!/^\d{6}$/.test(newPin)) {
      if (result)
        result.innerHTML = '<span class="text-red">New PIN must be exactly 6 digits.</span>';
      return;
    }
    try {
      await api("/change-pin", { method: "POST", body: { currentPin, newPin, totp } });
      window.location.reload();
    } catch (err) {
      if (result) result.innerHTML = `<span class="text-red">${esc(err.message)}</span>`;
    }
  };

  // ============================================================
  //  Overview
  // ============================================================
  async function renderOverview(el) {
    el.innerHTML = `<div class="stats-grid">${skeletonCards(12)}</div>
      <div class="card"><div class="card-header"><span class="card-title">Alerts</span></div>
      <div class="card-body flush"><div class="empty-state"><p class="text-muted">Loading…</p></div></div></div>`;

    try {
      const [data, sanctions] = await Promise.all([api("/overview"), api("/sanctions")]);
      const t = data.totals || {};
      el.innerHTML = `
        <div class="stats-grid">
          ${statCard("indigo", "Cooperatives", fmt(t.coopCount))}
          ${statCard("green", "Members", fmt(t.memberCount))}
          ${statCard("gold", "Total Savings", currency(t.savingsTotal))}
          ${statCard("purple", "Wallet Float", currency(t.walletFloat))}
          ${statCard("blue", "Loan Book Outstanding", currency(t.loanOutstanding))}
          ${statCard("green", "Loan Principal", currency(t.loanPrincipal))}
          ${statCard("red", "Overdue", currency(t.overdueAmount) + ` <span class="text-sm text-muted">(${fmt(t.overdueCount)})</span>`)}
          ${statCard("gold", "Pending Withdrawals", fmt(t.pendingWithdrawals))}
          ${statCard("gold", "Pending Payouts", fmt(t.pendingPayouts))}
          ${statCard("red", "Failed Payouts", fmt(t.failedPayouts))}
          ${statCard("red", "AML Awaiting Filing", fmt(t.pendingAmlCount))}
          ${statCard("blue", "Active Loans", fmt(t.loanCount))}
        </div>
        <div class="card">
          <div class="card-header">
            <span class="card-title">Alerts</span>
            <span class="badge badge-${(data.alerts || []).length ? "red" : "green"}">${(data.alerts || []).length}</span>
          </div>
          <div class="card-body flush" id="overviewAlerts">
            ${renderAlertList(data.alerts || [])}
          </div>
        </div>
        ${renderSanctionsCard(sanctions)}`;
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load overview</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function renderSanctionsCard(sanctions) {
    const s = sanctions || {};
    const refresh = s.refresh || {};
    const status = refresh.status || "never";
    const badge = status === "ok" ? "green" : status === "failed" ? "red" : "gold";
    const label = status === "ok" ? "Healthy" : status === "failed" ? "Failed" : "Never run";
    const lastRun = refresh.finishedAt || refresh.startedAt || refresh.updatedAt;
    const rows = [
      ["List source configured", s.configured ? "Yes" : "No (SANCTIONS_LIST_URL unset)"],
      ["Source", refresh.source || "—"],
      ["Last refresh", lastRun ? date(lastRun) : "Never"],
      ["Entries fetched", fmt(refresh.fetched || 0)],
      ["Created / updated", `${fmt(refresh.created || 0)} / ${fmt(refresh.updated || 0)}`],
      ["Deactivated", fmt(refresh.deactivated || 0)],
    ];
    const errorRow = refresh.error
      ? `<p class="text-red text-sm mt-2">${esc(refresh.error)}</p>`
      : "";
    const button = isOwner
      ? `<button class="btn btn-secondary btn-sm" data-action="refreshSanctionsList">Refresh now</button>`
      : "";
    return `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Sanctions &amp; PEP watchlist</span>
          <span class="badge badge-${badge}">${label}</span>
        </div>
        <div class="card-body">
          <table>
            <tbody>
              ${rows.map(([k, v]) => `<tr><td class="text-muted">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}
            </tbody>
          </table>
          ${errorRow}
          <div class="flex gap-2 mt-4">
            ${button}
            <button class="btn btn-ghost btn-sm" data-action="navigateTo" data-arg="coops">View cooperatives</button>
          </div>
        </div>
      </div>`;
  }

  window.refreshSanctionsList = async function () {
    const btn = document.querySelector('[data-action="refreshSanctionsList"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Refreshing…";
    }
    try {
      const result = await api("/sanctions/refresh", { method: "POST" });
      toast(
        result.ok
          ? `Watchlist refreshed: +${result.created || 0} / ~${result.updated || 0}`
          : `Refresh failed: ${result.error || "unknown error"}`,
        result.ok ? "success" : "error",
      );
      renderOverview(document.getElementById("pageContent"));
    } catch (err) {
      toast(err.message, "error");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Refresh now";
      }
    }
  };

  function renderAlertList(alerts) {
    if (!alerts.length) {
      return '<div class="empty-state"><h3>No alerts</h3><p>Every cooperative looks healthy.</p></div>';
    }
    return `<div class="alert-list">${alerts
      .map(
        (a) => `<div class="alert-row">
          <span class="alert-dot ${a.severity === "critical" ? "critical" : "warning"}"></span>
          <div class="alert-body">
            <div class="alert-msg">${esc(a.message)}</div>
            <div class="alert-meta">${esc(a.type)}${a.cooperativeName ? " · " + esc(a.cooperativeName) : ""}</div>
          </div>
          ${a.cooperativeId ? `<button class="btn btn-secondary btn-xs" data-action="openCoop" data-arg="${esc(a.cooperativeId)}">View</button>` : ""}
        </div>`,
      )
      .join("")}</div>`;
  }

  // ============================================================
  //  Cooperatives list
  // ============================================================
  async function renderCoops(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Cooperatives</span>
          <input type="search" id="coopSearch" class="toolbar-input" placeholder="Search name or code…">
        </div>
        <div class="card-body flush" id="coopsTable">
          <div class="empty-state"><p class="text-muted">Loading…</p></div>
        </div>
      </div>`;

    try {
      const data = await api("/coops");
      coopsData = data.coops || [];
      const alerts = data.alerts || [];
      if (alerts.length) {
        el.insertAdjacentHTML(
          "afterbegin",
          `<div class="card mb-6">
            <div class="card-header">
              <span class="card-title">Alerts</span>
              <span class="badge badge-red">${alerts.length}</span>
            </div>
            <div class="card-body flush">${renderAlertList(alerts)}</div>
          </div>`,
        );
      }
      renderCoopsTable(coopsData);
      const search = document.getElementById("coopSearch");
      search?.addEventListener("input", function () {
        const q = this.value.trim().toLowerCase();
        renderCoopsTable(
          coopsData.filter(
            (c) =>
              (c.name || "").toLowerCase().includes(q) || (c.code || "").toLowerCase().includes(q),
          ),
        );
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load cooperatives</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function renderCoopsTable(coops) {
    const host = document.getElementById("coopsTable");
    if (!host) return;
    if (!coops.length) {
      host.innerHTML =
        '<div class="empty-state"><h3>No cooperatives</h3><p>Provision one from “Create Coop”.</p></div>';
      return;
    }
    host.innerHTML = `
      <div class="table-wrapper">
        <table>
          <thead><tr>
            <th>Cooperative</th>
            <th>Plan</th>
            <th>Status</th>
            <th>Members</th>
            <th>Savings</th>
            <th>Outstanding</th>
            <th>Overdue</th>
            <th>Last activity</th>
            <th></th>
          </tr></thead>
          <tbody>
            ${coops
              .map(
                (c) => `<tr class="row-link" data-action="openCoop" data-arg="${esc(c.id)}">
                <td class="font-bold">${esc(c.name || "—")}${c.isSandbox ? '<span class="sandbox-list-tag">Sandbox</span>' : ""}<div class="text-muted text-sm font-mono">${esc(c.code || "")}</div></td>
                <td>${esc(c.plan || "free")}</td>
                <td>${coopStatusBadge(c.status)}</td>
                <td class="font-mono">${fmt(c.memberCount)}</td>
                <td class="font-mono">${currency(c.savingsTotal)}</td>
                <td class="font-mono">${currency(c.loanOutstanding)}</td>
                <td class="font-mono ${c.overdueCount ? "text-red" : ""}">${c.delinquencyPct ? c.delinquencyPct + "%" : "—"}</td>
                <td class="text-muted text-sm">${date(c.lastActivityAt)}</td>
                <td><button class="btn btn-outline btn-xs" data-action="openCoop" data-arg="${esc(c.id)}">View</button></td>
              </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>`;
  }

  // ============================================================
  //  Coop detail (tabs: Health · Activity · Rules · Admins)
  // ============================================================
  async function renderCoopDetail(id) {
    const el = document.getElementById("pageContent");
    if (!id) {
      renderDenied(el);
      return;
    }
    el.innerHTML =
      '<div class="card"><div class="empty-state"><p class="text-muted">Loading cooperative…</p></div></div>';
    try {
      coopDetail = await api(`/coops/${id}`);
      coopActivityEntries = [];
      try {
        const a = await api(`/coops/${id}/activity?take=25`);
        coopActivityEntries = a.entries || [];
      } catch {
        /* activity is optional */
      }
      regulatorFileTarget = null;
      regulatorFilingDraft = null;
      try {
        coopRegulator = await api(`/coops/${id}/regulator-reports`);
      } catch {
        coopRegulator = { profile: null, reports: [] };
      }
      try {
        coopRegisters = await api(`/coops/${id}/compliance-registers`);
      } catch {
        coopRegisters = { breaches: [], dpias: [], crossBorderTransfers: [], breachSummary: {} };
      }
      renderCoopShell();
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load cooperative</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function renderCoopShell() {
    const el = document.getElementById("pageContent");
    if (!coopDetail) return;
    const coop = coopDetail.cooperative || {};
    setText("pageTitle", coop.name || "Cooperative");

    el.innerHTML = `
      <div class="card mb-6">
        <div class="card-header">
          <div class="coop-heading">
            <button class="btn btn-ghost btn-sm" data-action="backToCoops">← Back</button>
            <span class="card-title">${esc(coop.name || "—")}</span>
            <span class="dev-code">${esc(coop.code || "")}</span>
            ${coopDetail.stats?.isSandbox ? '<span class="sandbox-list-tag">Sandbox</span>' : ""}
            ${coopStatusBadge(coop.status)}
            <span class="badge badge-gray">${esc((coopDetail.stats || {}).plan || "—")}</span>
          </div>
          <span class="text-muted text-xs font-mono">${esc(coop.id || "")}</span>
        </div>
      </div>

      <div class="tabs">
        ${tabButton("health", "Health")}
        ${tabButton("activity", "Activity")}
        ${tabButton("rules", "Features & Rules")}
        ${tabButton("admins", "Admins")}
      </div>
      <div id="coopTabPanel"></div>`;

    renderCoopTabPanel();
  }

  function tabButton(key, label) {
    return `<button class="tab ${currentCoopTab === key ? "active" : ""}" data-action="coopTab" data-arg="${key}">${label}</button>`;
  }

  window.coopTab = function (key) {
    currentCoopTab = key;
    renderCoopShell();
  };

  function renderCoopTabPanel() {
    const panel = document.getElementById("coopTabPanel");
    if (!panel) return;
    if (currentCoopTab === "activity") panel.innerHTML = renderActivityPanel();
    else if (currentCoopTab === "rules") panel.innerHTML = renderRulesPanel();
    else if (currentCoopTab === "admins") panel.innerHTML = renderAdminsPanel();
    else panel.innerHTML = renderHealthPanel();
  }

  function renderHealthPanel() {
    const coop = coopDetail.cooperative || {};
    const s = coopDetail.stats || {};
    const dis = readOnly ? "disabled" : "";
    const control = readOnly
      ? '<span class="text-muted text-sm">Support role is read-only.</span>'
      : coop.status === "suspended"
        ? `<button class="btn btn-success btn-sm" data-action="reactivateCoop" data-arg="${esc(coop.id)}">Reactivate</button>`
        : `<button class="btn btn-danger btn-sm" data-action="suspendCoop" data-arg="${esc(coop.id)}" data-name="${esc(coop.name || "")}">Suspend</button>
           <button class="btn btn-secondary btn-sm" data-action="revokeSessions" data-arg="${esc(coop.id)}">Revoke sessions</button>`;
    return `
      <div class="stats-grid">
        ${statCard("indigo", "Members", fmt(s.memberCount))}
        ${statCard("gold", "Savings total", currency(s.savingsTotal))}
        ${statCard("purple", "Wallet float", currency(s.walletFloat))}
        ${statCard("blue", "Loan book", currency(s.loanOutstanding) + ` <span class="text-sm text-muted">(${fmt(s.loanCount)})</span>`)}
        ${statCard("red", "Overdue", currency(s.overdueAmount) + ` <span class="text-sm text-muted">(${fmt(s.overdueCount)})</span>`)}
        ${statCard("green", "Reserve fund", currency(s.reserveFundBalance))}
        ${statCard("green", "Loan loss provision", currency(s.loanLossProvisionBalance))}
        ${statCard("gold", "Pending withdrawals", fmt(s.pendingWithdrawals))}
        ${statCard("gold", "Pending payouts", fmt(s.pendingPayouts))}
        ${statCard("red", "Failed payouts", fmt(s.failedPayouts))}
        ${statCard("red", "AML awaiting filing", fmt(s.pendingAmlCount))}
        ${statCard("blue", "Delinquency", (s.delinquencyPct || 0) + "%")}
      </div>

      <div class="card mb-6">
        <div class="card-header"><span class="card-title">Details</span></div>
        <div class="card-body">
          <table>
            <tbody>
              <tr><td class="text-muted">Status</td><td>${coopStatusBadge(coop.status)}</td></tr>
              <tr><td class="text-muted">Plan</td><td>${esc((coopDetail.stats || {}).plan || "—")}</td></tr>
              <tr><td class="text-muted">State</td><td>${esc(coop.state || "—")}</td></tr>
              <tr><td class="text-muted">Created</td><td>${date(coop.createdAt)}</td></tr>
              <tr><td class="text-muted">Last activity</td><td>${date(s.lastActivityAt)}</td></tr>
              <tr><td class="text-muted">Members by status</td><td>${renderMembersByStatus(s.membersByStatus)}</td></tr>
              <tr><td class="text-muted">Reg. number</td><td>${esc(coop.registrationNumber || "—")}</td></tr>
              <tr><td class="text-muted">TIN</td><td>${esc(coop.tin || "—")}</td></tr>
              <tr><td class="text-muted">CVN</td><td>${esc(coop.cvn || "—")}</td></tr>
              <tr><td class="text-muted">SCUML</td><td>${esc(coop.scumlStatus || "—")}</td></tr>
              <tr><td class="text-muted">SCUML number</td><td>${esc(coop.scumlNumber || "—")}</td></tr>
              <tr><td class="text-muted">SCUML expiry</td><td>${coop.scumlExpiresAt ? date(coop.scumlExpiresAt) : "—"}</td></tr>
              <tr><td class="text-muted">NDPC number</td><td>${esc(coop.ndpcRegistrationNumber || "—")}</td></tr>
              <tr><td class="text-muted">NDPC registered</td><td>${coop.ndpcRegisteredAt ? date(coop.ndpcRegisteredAt) : "—"}</td></tr>
              <tr><td class="text-muted">DPO</td><td>${esc([coop.dpoName, coop.dpoPhone, coop.dpoEmail].filter(Boolean).join(" · ") || "—")}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card mb-6">
        <div class="card-header"><span class="card-title">Compliance metadata</span></div>
        <div class="card-body">
          <div class="form-inline">
            <div class="form-field"><label>Registration number</label><input id="cmpReg" value="${esc(coop.registrationNumber || "")}" ${dis}></div>
            <div class="form-field"><label>TIN</label><input id="cmpTin" value="${esc(coop.tin || "")}" ${dis}></div>
            <div class="form-field"><label>CVN</label><input id="cmpCvn" value="${esc(coop.cvn || "")}" ${dis}></div>
            <div class="form-field"><label>SCUML status</label><input id="cmpScuml" value="${esc(coop.scumlStatus || "")}" ${dis}></div>
            <div class="form-field"><label>SCUML number</label><input id="cmpScumlNo" value="${esc(coop.scumlNumber || "")}" ${dis}></div>
            <div class="form-field"><label>SCUML filed</label><input type="date" id="cmpScumlFiled" value="${esc((coop.scumlFiledAt || "").slice(0, 10))}" ${dis}></div>
            <div class="form-field"><label>SCUML expires</label><input type="date" id="cmpScumlExp" value="${esc((coop.scumlExpiresAt || "").slice(0, 10))}" ${dis}></div>
            <div class="form-field"><label>NDPC number</label><input id="cmpNdpcNo" value="${esc(coop.ndpcRegistrationNumber || "")}" ${dis}></div>
            <div class="form-field"><label>NDPC registered</label><input type="date" id="cmpNdpcAt" value="${esc((coop.ndpcRegisteredAt || "").slice(0, 10))}" ${dis}></div>
            <div class="form-field"><label>DPO name</label><input id="cmpDpoName" value="${esc(coop.dpoName || "")}" ${dis}></div>
            <div class="form-field"><label>DPO phone</label><input id="cmpDpoPhone" value="${esc(coop.dpoPhone || "")}" ${dis}></div>
            <div class="form-field"><label>DPO email</label><input id="cmpDpoEmail" value="${esc(coop.dpoEmail || "")}" ${dis}></div>
            ${readOnly ? "" : `<button class="btn btn-primary btn-sm" data-action="saveCoopCompliance" data-arg="${esc(coop.id)}">Save</button>`}
          </div>
        </div>
      </div>

      <div class="card mb-6" id="regulatorCard">
        ${renderRegulatorCard(coop)}
      </div>

      <div class="card mb-6" id="complianceRegistersCard">
        ${renderComplianceRegistersCard(coop)}
      </div>

      <div class="card">
        <div class="card-header"><span class="card-title">Controls</span></div>
        <div class="card-body">
          <div class="flex gap-2">${control}</div>
        </div>
      </div>`;
  }

  function renderMembersByStatus(byStatus) {
    const entries = Object.entries(byStatus || {});
    if (!entries.length) return '<span class="text-muted">—</span>';
    return entries
      .map(([k, v]) => `<span class="badge badge-gray">${esc(k)}: ${fmt(v)}</span>`)
      .join(" ");
  }

  function renderComplianceRegistersCard(coop) {
    const dis = readOnly ? "disabled" : "";
    const summary = coopRegisters.breachSummary || {};
    const breaches = coopRegisters.breaches || [];
    const dpias = coopRegisters.dpias || [];
    const transfers = coopRegisters.crossBorderTransfers || [];
    const breachRows = breaches
      .slice(0, 6)
      .map((b) => {
        const overdue = b.overdue
          ? '<span class="badge badge-red">overdue</span>'
          : b.status === "notified" || b.status === "closed"
            ? '<span class="badge badge-green">closed</span>'
            : '<span class="badge badge-gold">open</span>';
        const action =
          readOnly || b.status === "notified" || b.status === "closed"
            ? ""
            : `<button class="btn btn-ghost btn-sm" data-action="markBreachNotified" data-arg="${esc(coop.id)}:${esc(b.id)}">Mark NDPC notified</button>`;
        return `<tr>
        <td class="font-mono text-xs">${esc(b.reference)}</td>
        <td>${esc(b.title)}<div class="text-muted text-xs">${esc(b.status)} · ${esc(String(b.affectedCount ?? "—"))} affected</div></td>
        <td>${new Date(b.notificationDueAt).toISOString().slice(0, 16).replace("T", " ")} UTC ${overdue}</td>
        <td>${action}</td>
      </tr>`;
      })
      .join("");
    const dpiaRows = dpias
      .slice(0, 4)
      .map((d) => `<li>${esc(d.title)} — <span class="text-muted">${esc(d.status)}</span></li>`)
      .join("");
    const transferRows = transfers
      .slice(0, 4)
      .map(
        (t) =>
          `<li>${esc(t.country)} · ${esc(t.recipient)} — <span class="text-muted">${esc(t.status)}</span></li>`,
      )
      .join("");

    return `
      <div class="card-header"><span class="card-title">Compliance registers</span></div>
      <div class="card-body">
        <p class="text-muted text-sm">
          Breaches: <strong>${esc(String(summary.open ?? 0))}</strong> open ·
          <strong>${esc(String(summary.overdue ?? 0))}</strong> overdue ·
          <strong>${esc(String(summary.dueWithin24h ?? 0))}</strong> due within 24h |
          DPIAs: <strong>${dpias.length}</strong> |
          Cross-border transfers: <strong>${transfers.length}</strong>
        </p>
        ${breaches.length ? `<table class="mb-4"><thead><tr><th>Ref</th><th>Incident</th><th>NDPC deadline</th><th></th></tr></thead><tbody>${breachRows}</tbody></table>` : '<p class="text-muted text-sm">No breaches recorded.</p>'}
        <div class="form-inline mb-4">
          <div class="form-field"><label>Breach title</label><input id="brTitle" ${dis}></div>
          <div class="form-field"><label>What happened</label><input id="brDesc" ${dis}></div>
          <div class="form-field"><label>Discovered</label><input type="date" id="brDate" ${dis}></div>
          <div class="form-field"><label>Affected</label><input type="number" min="0" id="brCount" ${dis}></div>
          ${readOnly ? "" : `<button class="btn btn-primary btn-sm" data-action="createBreach" data-arg="${esc(coop.id)}">Record breach</button>`}
        </div>
        <div class="form-inline mb-4">
          <div class="form-field"><label>DPIA title</label><input id="dpTitle" ${dis}></div>
          <div class="form-field"><label>Processing activity</label><input id="dpActivity" ${dis}></div>
          ${readOnly ? "" : `<button class="btn btn-primary btn-sm" data-action="createDpia" data-arg="${esc(coop.id)}">Add DPIA</button>`}
        </div>
        ${dpiaRows ? `<ul class="text-sm">${dpiaRows}</ul>` : '<p class="text-muted text-sm">No DPIAs recorded.</p>'}
        <div class="form-inline mb-4">
          <div class="form-field"><label>Country</label><input id="xbCountry" ${dis}></div>
          <div class="form-field"><label>Recipient</label><input id="xbRecipient" ${dis}></div>
          <div class="form-field"><label>Purpose</label><input id="xbPurpose" ${dis}></div>
          <div class="form-field"><label>Safeguard</label>
            <select id="xbSafeguard" ${dis}>
              <option value="scc">SCC</option>
              <option value="adequacy">Adequacy</option>
              <option value="bcr">BCR</option>
              <option value="consent">Consent</option>
              <option value="contract">Contract</option>
            </select>
          </div>
          ${readOnly ? "" : `<button class="btn btn-primary btn-sm" data-action="createCrossBorder" data-arg="${esc(coop.id)}">Add transfer</button>`}
        </div>
        ${transferRows ? `<ul class="text-sm">${transferRows}</ul>` : '<p class="text-muted text-sm">No cross-border transfers recorded.</p>'}
      </div>`;
  }

  function renderRegulatorCard(coop) {
    const profile = coopRegulator.profile;
    const reports = coopRegulator.reports || [];
    const filing = reports.find((r) => r.id === regulatorFileTarget);
    const draft =
      filing && regulatorFilingDraft && regulatorFilingDraft.reportId === filing.id
        ? regulatorFilingDraft
        : null;
    const thisYear = new Date().getUTCFullYear();
    const due = profile
      ? `Monthly day ${profile.monthlyDueDay} | Quarterly day ${profile.quarterlyDueDay} | Annual ${profile.annualDueMonth}/${profile.annualDueDay}`
      : "No regulator configured (set it with the chat command regulatorconfig)";
    const rows = reports.length
      ? reports
          .map(
            (r) => `
        <tr>
          <td>${esc(r.period)}</td>
          <td>${esc(r.periodType)}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${r.dueAt ? date(r.dueAt) : "-"}</td>
          <td>${r.filedAt ? date(r.filedAt) : "-"}</td>
          <td>${esc(r.acknowledgementId || "-")}</td>
          <td>
            ${r.files ? `<a href="${API_BASE}/coops/${esc(coop.id)}/regulator-reports/${esc(r.id)}/download/xlsx" target="_blank" rel="noopener">XLSX</a> | <a href="${API_BASE}/coops/${esc(coop.id)}/regulator-reports/${esc(r.id)}/download/pdf" target="_blank" rel="noopener">PDF</a> | <a href="${API_BASE}/coops/${esc(coop.id)}/regulator-reports/${esc(r.id)}/download/csv" target="_blank" rel="noopener">CSV</a>` : "-"}
          </td>
          <td>
            ${
              readOnly
                ? ""
                : `<button class="btn btn-secondary btn-sm" data-action="toggleRegulatorFile" data-arg="${esc(r.id)}">${r.status === "filed" ? "Update filing" : "Mark filed"}</button>`
            }
          </td>
        </tr>`,
          )
          .join("")
      : '<tr><td colspan="8" class="text-muted">No regulator returns generated yet.</td></tr>';

    return `
      <div class="card-header">
        <span class="card-title">Regulator returns</span>
        <span class="text-muted text-xs">${esc(profile ? profile.label : "Not configured")}</span>
      </div>
      <div class="card-body">
        <p class="text-muted text-sm mb-4">${esc(due)}</p>
        ${
          readOnly
            ? ""
            : `<div class="form-inline mb-4">
                 <div class="form-field"><label for="regYear">Year</label><input type="number" id="regYear" min="2000" max="${thisYear}" value="${thisYear}"></div>
                 <div class="form-field"><label for="regPack">Pack</label>
                   <select id="regPack">
                     <option value="statutory">Statutory</option>
                     <option value="both">Statutory + NFIU</option>
                     <option value="nfiu">NFIU</option>
                   </select>
                 </div>
                 <button class="btn btn-primary btn-sm" data-action="generateAnnualReport" data-arg="${esc(coop.id)}">Generate annual pack</button>
               </div>`
        }
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Period</th><th>Type</th><th>Status</th><th>Due</th><th>Filed</th><th>Ack</th><th>Files</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${
          filing
            ? `<div class="form-inline mt-4" id="regulatorFileForm">
                 <div class="form-field"><label for="regAck">Acknowledgement</label>
                   <input id="regAck" maxlength="80" value="${esc(draft ? draft.ack : filing.acknowledgementId || "")}" placeholder="Optional, max 80">
                 </div>
                 <div class="form-field"><label for="regNote">Note</label>
                   <input id="regNote" maxlength="500" value="${esc(draft ? draft.note : filing.notes || "")}" placeholder="Optional, max 500">
                 </div>
                 <button class="btn btn-primary btn-sm" data-action="fileRegulatorReport" data-arg1="${esc(coop.id)}" data-arg2="${esc(filing.id)}">Save filing</button>
                 <button class="btn btn-secondary btn-sm" data-action="cancelRegulatorFile">Cancel</button>
               </div>`
            : ""
        }
      </div>`;
  }

  function renderActivityPanel() {
    if (!coopActivityEntries.length) {
      return '<div class="card"><div class="empty-state"><h3>No activity</h3><p>No audit entries recorded for this cooperative.</p></div></div>';
    }
    return `
      <div class="card">
        <div class="card-header"><span class="card-title">Recent activity</span></div>
        <div class="card-body flush">
          <div class="table-wrapper">
            <table>
              <thead><tr><th>Action</th><th>Actor</th><th>Target</th><th>Detail</th><th>When</th></tr></thead>
              <tbody>
                ${coopActivityEntries
                  .map(
                    (e) => `<tr>
                  <td class="font-bold">${esc(e.action || "—")}</td>
                  <td class="text-sm">${esc(e.actorPhone || "—")}${e.actorRole ? `<div class="text-muted text-xs">${esc(e.actorRole)}</div>` : ""}</td>
                  <td class="text-sm font-mono">${e.targetType ? esc(e.targetType) : "—"}${e.targetId ? `<div class="text-muted text-xs mono-sm">${esc(e.targetId)}</div>` : ""}</td>
                  <td class="text-sm">${esc(truncate(e.detail, 80) || "—")}</td>
                  <td class="text-muted text-sm">${date(e.createdAt)}</td>
                </tr>`,
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  function renderRulesPanel() {
    const coop = coopDetail.cooperative || {};
    const config = coopDetail.config || {};
    const raw = coopDetail.rawConfig || {};
    const meta = coopDetail.meta || {};
    const dis = readOnly ? "disabled" : "";

    // 1. Feature activation toggles
    const features = [
      {
        key: "autoApproveLoans",
        title: "Auto-Approve Loans",
        desc: "Bypasses credit committee routing and automatically approves eligible member loans.",
        value: Boolean(config.autoApproveLoans),
      },
      {
        key: "requireGuarantors",
        title: "Guarantor Enforcement",
        desc: "Requires verified member guarantors before loan disbursement.",
        value: Boolean(config.requireGuarantors),
      },
      {
        key: "statusEnabled",
        title: "Automated Status Broadcasts",
        desc: "Publishes automated WhatsApp status updates and community announcements.",
        value: Boolean(raw.statusEnabled ?? true),
      },
      {
        key: "loanProtectionEnabled",
        title: "Loan Protection Scheme",
        desc: "Deducts protection reserve premium at disbursement to guard against default.",
        value: Boolean(raw.loanProtectionEnabled ?? true),
      },
      {
        key: "directDebitEnabled",
        title: "Direct Debit Ingestion",
        desc: "Automates monthly salary and bank check-off deductions.",
        value: Boolean(raw.directDebitEnabled ?? false),
      },
      {
        key: "regulatorReportingEnabled",
        title: "Automated Regulator Returns",
        desc: "Enables statutory and NFIU compliance pack compilation.",
        value: Boolean(raw.regulatorReportingEnabled ?? false),
      },
      {
        key: "referralEnabled",
        title: "Member Referral Rewards",
        desc: "Enables member referral link tracking and wallet incentive payouts.",
        value: Boolean(raw.referralEnabled ?? false),
      },
      {
        key: "literacyCertificationEnabled",
        title: "Financial Literacy Certification",
        desc: "Grants borrowing limit boosts to members completing the financial literacy quiz.",
        value: Boolean(config.literacyCertificationEnabled),
      },
      {
        key: "allowShareRedemption",
        title: "Share Capital Redemption",
        desc: "Permits cooperative members to redeem or transfer their share units.",
        value: Boolean(raw.allowShareRedemption ?? false),
      },
    ];

    const featureCards = features
      .map((f) => {
        const isLocked = meta[f.key]?.locked;
        const badge = f.value
          ? '<span class="badge badge-green">Active</span>'
          : '<span class="badge badge-gray">Disabled</span>';
        const lockBadge = isLocked ? '<span class="badge badge-red ml-2">Locked</span>' : "";
        const btn =
          readOnly || isLocked
            ? ""
            : f.value
              ? `<button class="btn btn-secondary btn-sm" data-action="toggleCoopFeature" data-arg1="${esc(coop.id)}" data-arg2="${f.key}:false">Deactivate</button>`
              : `<button class="btn btn-primary btn-sm" data-action="toggleCoopFeature" data-arg1="${esc(coop.id)}" data-arg2="${f.key}:true">Activate</button>`;

        return `
          <div class="card p-4 feature-card">
            <div class="flex items-center justify-between mb-2">
              <span class="font-bold text-sm">${esc(f.title)}</span>
              <div>${badge}${lockBadge}</div>
            </div>
            <p class="text-muted text-xs mb-3">${esc(f.desc)}</p>
            <div class="flex justify-end">${btn}</div>
          </div>
        `;
      })
      .join("");

    const keys = Object.keys(config);

    return `
      <!-- Feature activation section -->
      <div class="card mb-6">
        <div class="card-header">
          <div>
            <span class="card-title">Feature Activation & Capabilities</span>
            <div class="text-muted text-xs mt-1">Activate or deactivate platform features specifically for this cooperative.</div>
          </div>
        </div>
        <div class="card-body">
          <div class="feature-grid">
            ${featureCards}
          </div>
        </div>
      </div>

      <!-- Configurable parameters form -->
      <div class="card mb-6">
        <div class="card-header">
          <div>
            <span class="card-title">Lending, Risk & Financial Limits</span>
            <div class="text-muted text-xs mt-1">Tune business parameters, interest rates, and statutory reserves.</div>
          </div>
        </div>
        <div class="card-body">
          <h4 class="text-sm font-bold text-muted mb-3 uppercase tracking-wider">Lending & Credit Engine</h4>
          <div class="param-grid mb-4">
            <div class="form-field">
              <label for="cfgLoanInterest">Monthly Interest (%)</label>
              <input type="number" id="cfgLoanInterest" value="${esc(config.loanInterestRate ?? 10)}" min="0" max="60" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgMaxLoanMultiplier">Max Loan Multiplier (x)</label>
              <input type="number" id="cfgMaxLoanMultiplier" value="${esc(config.maxLoanMultiplier ?? 3)}" min="1" max="10" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgLoanDuration">Max Repayment Tenure (months)</label>
              <input type="number" id="cfgLoanDuration" value="${esc(config.loanDurationMonths ?? 12)}" min="1" max="60" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgMinLoanTerm">Min Repayment Tenure (months)</label>
              <input type="number" id="cfgMinLoanTerm" value="${esc(config.minLoanTermMonths ?? 1)}" min="1" max="60" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgMinGuarantors">Min Guarantors Required</label>
              <input type="number" id="cfgMinGuarantors" value="${esc(config.minGuarantors ?? 2)}" min="0" max="10" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgServiceCharge">Service Charge (%)</label>
              <input type="number" id="cfgServiceCharge" value="${esc(config.serviceChargePercent ?? 2)}" min="0" max="25" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgLateFine">Late Fine (%)</label>
              <input type="number" id="cfgLateFine" value="${esc(config.lateFinePercent ?? 5)}" min="0" max="25" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgLoanProtection">Protection Reserve (%)</label>
              <input type="number" id="cfgLoanProtection" value="${esc(raw.loanProtectionPercent ?? 1)}" min="0" max="20" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgMaxLoanPerMember">Max Single Loan Cap (₦)</label>
              <input type="number" id="cfgMaxLoanPerMember" value="${esc((config.maxLoanPerMember || 0) / 100)}" min="0" placeholder="0 = unlimited" ${dis}>
            </div>
          </div>

          <h4 class="text-sm font-bold text-muted mb-3 uppercase tracking-wider mt-6">Savings, Float & Withdrawals</h4>
          <div class="param-grid mb-4">
            <div class="form-field">
              <label for="cfgDailyPayout">Daily Payout Limit (₦)</label>
              <input type="number" id="cfgDailyPayout" value="${esc((coop.dailyPayoutLimit || 0) / 100)}" min="0" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgMinContribution">Min Monthly Contribution (₦)</label>
              <input type="number" id="cfgMinContribution" value="${esc((config.minContribution || 0) / 100)}" min="0" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgMinSavings">Min Savings Balance (₦)</label>
              <input type="number" id="cfgMinSavings" value="${esc((config.minSavings || 0) / 100)}" min="0" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgMinWithdrawal">Min Withdrawal (₦)</label>
              <input type="number" id="cfgMinWithdrawal" value="${esc((config.minWithdrawal || 0) / 100)}" min="0" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgMaxWithdrawal">Max Withdrawal (₦)</label>
              <input type="number" id="cfgMaxWithdrawal" value="${esc((config.maxWithdrawal || 0) / 100)}" min="0" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgWithdrawalCooldown">Withdrawal Cooldown (months)</label>
              <input type="number" id="cfgWithdrawalCooldown" value="${esc(config.withdrawalCooldownMonths ?? 6)}" min="0" max="24" ${dis}>
            </div>
          </div>

          <h4 class="text-sm font-bold text-muted mb-3 uppercase tracking-wider mt-6">Statutory & Governance Rules</h4>
          <div class="param-grid mb-4">
            <div class="form-field">
              <label for="cfgReserveFund">Reserve Fund Appropriation (%, min 25%)</label>
              <input type="number" id="cfgReserveFund" value="${esc(config.reserveFundPercent ?? 25)}" min="25" max="100" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgEducationFund">Education Fund (%, max 10%)</label>
              <input type="number" id="cfgEducationFund" value="${esc(config.educationFundPercent ?? 10)}" min="0" max="10" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgDividendCap">Dividend Cap (%, max 5%)</label>
              <input type="number" id="cfgDividendCap" value="${esc(config.dividendCapPercent ?? 5)}" min="0" max="5" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgSharePrice">Share Capital Unit Price (₦)</label>
              <input type="number" id="cfgSharePrice" value="${esc((raw.sharePrice || 100000) / 100)}" min="1" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgOmbudsmanSla">Ombudsman Resolution SLA (days)</label>
              <input type="number" id="cfgOmbudsmanSla" value="${esc(raw.ombudsmanSlaDays ?? 7)}" min="1" max="30" ${dis}>
            </div>
            <div class="form-field">
              <label for="cfgAgmQuorum">AGM Quorum Requirement (%)</label>
              <input type="number" id="cfgAgmQuorum" value="${esc(raw.agmQuorumPercent ?? 25)}" min="5" max="100" ${dis}>
            </div>
          </div>

          ${
            readOnly
              ? ""
              : `<div class="mt-6 flex justify-end">
                   <button class="btn btn-primary" data-action="saveCoopConfig" data-arg="${esc(coop.id)}">Save Configuration</button>
                 </div>`
          }
        </div>
      </div>

      <!-- Effective rules audit table -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Effective Rules Audit</span>
          <span class="text-muted text-sm">Platform values apply unless overridden at cooperative level.</span>
        </div>
        <div class="card-body flush">
          <div class="table-wrapper">
            <table>
              <thead><tr><th>Rule</th><th>Value</th><th>Source</th><th>Locked</th></tr></thead>
              <tbody>
                ${keys
                  .map((k) => {
                    const m = meta[k] || {};
                    const rule = ruleByKey[k];
                    return `<tr>
                      <td class="font-bold">${esc(rule?.label || k)}<div class="text-muted text-xs font-mono">${esc(k)}</div></td>
                      <td class="font-mono">${formatRuleValue(config[k], rule)}</td>
                      <td>${m.source === "coop" ? '<span class="badge badge-blue">coop</span>' : '<span class="badge badge-gray">platform</span>'}</td>
                      <td>${m.locked ? '<span class="badge badge-red">locked</span>' : '<span class="text-muted">—</span>'}</td>
                    </tr>`;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  function renderAdminsPanel() {
    const admins = coopDetail.admins || [];
    const coopId = (coopDetail.cooperative || {}).id;
    const dis = readOnly ? "disabled" : "";
    const table = admins.length
      ? `<div class="table-wrapper"><table>
          <thead><tr><th>Name</th><th>Phone</th><th>Role</th><th>Status</th><th>Added</th><th>Contact</th></tr></thead>
          <tbody>
            ${admins
              .map(
                (a) => `<tr>
              <td class="font-bold">${esc(a.name || "—")}<div class="text-muted text-xs font-mono">${esc(a.id)}</div></td>
              <td class="font-mono text-sm">${esc(formatPhone(a.phone))}</td>
              <td>
                <select class="toolbar-select" data-action-change="setCoopAdminRole" data-arg="${esc(a.id)}" ${dis}>
                  <option value="admin" ${a.role === "admin" ? "selected" : ""}>admin</option>
                  <option value="superadmin" ${a.role === "superadmin" ? "selected" : ""}>superadmin</option>
                </select>
              </td>
              <td>${statusBadge(a.status || "active")}</td>
              <td class="text-muted text-sm">${date(a.createdAt)}</td>
              <td><span class="text-muted text-xs">${a.contactPhone ? esc(a.contactPhone) : ""}</span></td>
            </tr>`,
              )
              .join("")}
          </tbody>
        </table></div>`
      : '<div class="empty-state"><h3>No admins</h3><p>This cooperative has no admins yet.</p></div>';

    return `
      <div class="card mb-6">
        <div class="card-header"><span class="card-title">Coop admins</span></div>
        <div class="card-body flush">${table}</div>
      </div>
      ${
        readOnly
          ? ""
          : `
      <div class="card">
        <div class="card-header"><span class="card-title">Add admin</span></div>
        <div class="card-body">
          <div class="form-inline">
            <div class="form-field"><label>Phone</label><input id="newAdminPhone" placeholder="0801 234 5678" inputmode="numeric"></div>
            <div class="form-field"><label>Name (optional)</label><input id="newAdminName" placeholder="Full name"></div>
            <div class="form-field"><label>Role</label>
              <select id="newAdminRole">
                <option value="admin">admin</option>
                <option value="superadmin">superadmin</option>
              </select>
            </div>
            <button class="btn btn-primary btn-sm" data-action="addCoopAdmin" data-arg="${esc(coopId)}">Add admin</button>
          </div>
          <div id="newAdminResult" class="mt-4"></div>
        </div>
      </div>`
      }`;
  }

  window.addCoopAdmin = async function (coopId) {
    const phone = (document.getElementById("newAdminPhone")?.value || "").replace(/[^0-9]/g, "");
    const name = (document.getElementById("newAdminName")?.value || "").trim();
    const role = document.getElementById("newAdminRole")?.value || "admin";
    const result = document.getElementById("newAdminResult");
    if (!phone) {
      if (result) result.innerHTML = '<span class="text-red">Enter a phone number.</span>';
      return;
    }
    const fullPhone = phone.startsWith("234") ? phone : "234" + phone;
    try {
      const res = await api(`/coops/${coopId}/admins`, {
        method: "POST",
        body: { phone: fullPhone, name: name || undefined, role },
      });
      toast(res.created ? "Admin created" : "Admin promoted", "success");
      if (result) {
        result.innerHTML =
          res.created && res.tempPin
            ? `<div class="callout success"><div><div>Admin created. Share this temporary PIN securely — it must be changed on first login.</div>
             <div class="temp-pin mt-4" id="coopAdminPin">${esc(res.tempPin)}</div>
             <button class="btn btn-secondary btn-xs mt-4" data-action="copyText" data-arg="coopAdminPin">Copy PIN</button></div></div>`
            : `<div class="callout">Existing member promoted to <strong>${esc(role)}</strong>.</div>`;
      }
      const detail = await api(`/coops/${coopId}`);
      coopDetail = detail;
      renderCoopShell();
    } catch (err) {
      if (result) result.innerHTML = `<span class="text-red">${esc(err.message)}</span>`;
    }
  };

  window.setCoopAdminRole = async function (memberId, _event, el) {
    if (!coopDetail) return;
    const coopId = (coopDetail.cooperative || {}).id;
    const role = el.value;
    try {
      await api(`/coops/${coopId}/admins/${memberId}`, { method: "PATCH", body: { role } });
      toast("Role updated", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  };

  window.suspendCoop = async function (id, _event, el) {
    const name = el?.dataset.name || "";
    const expected = name || "SUSPEND";
    const typed = prompt(
      `Suspending blocks all member operations for this cooperative.\n\nType ${expected} to confirm:`,
    );
    if (typed === null) return;
    if (typed.trim() !== expected) {
      toast("Suspension cancelled: confirmation did not match", "error");
      return;
    }
    const reason = prompt("Reason for suspension (recorded in the audit log):") || "";
    try {
      await api(`/coops/${id}/suspend`, { method: "POST", body: { reason } });
      toast("Cooperative suspended", "success");
      renderCoopDetail(id);
    } catch (err) {
      toast(err.message, "error");
    }
  };
  window.reactivateCoop = async function (id) {
    try {
      await api(`/coops/${id}/reactivate`, { method: "POST" });
      toast("Cooperative reactivated", "success");
      renderCoopDetail(id);
    } catch (err) {
      toast(err.message, "error");
    }
  };
  window.revokeSessions = async function (id) {
    if (!confirm("Revoke all coop-admin sessions for this cooperative?")) return;
    try {
      await api(`/coops/${id}/revoke-sessions`, { method: "POST" });
      toast("Sessions revoked", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  };

  window.saveCoopCompliance = async function (id) {
    const val = (elId) => {
      const v = (document.getElementById(elId)?.value || "").trim();
      return v === "" ? null : v;
    };
    try {
      await api(`/coops/${id}`, {
        method: "PATCH",
        body: {
          registrationNumber: val("cmpReg"),
          tin: val("cmpTin"),
          cvn: val("cmpCvn"),
          scumlStatus: val("cmpScuml"),
          scumlNumber: val("cmpScumlNo"),
          scumlFiledAt: val("cmpScumlFiled"),
          scumlExpiresAt: val("cmpScumlExp"),
          ndpcRegistrationNumber: val("cmpNdpcNo"),
          ndpcRegisteredAt: val("cmpNdpcAt"),
          dpoName: val("cmpDpoName"),
          dpoPhone: val("cmpDpoPhone"),
          dpoEmail: val("cmpDpoEmail"),
        },
      });
      toast("Compliance metadata saved", "success");
      renderCoopDetail(id);
    } catch (err) {
      toast(err.message, "error");
    }
  };

  window.toggleCoopFeature = async function (id, flagArg) {
    if (!flagArg) return;
    const colonIdx = flagArg.indexOf(":");
    if (colonIdx === -1) return;
    const key = flagArg.slice(0, colonIdx);
    const val = flagArg.slice(colonIdx + 1) === "true";
    try {
      await api(`/coops/${id}/config`, {
        method: "PATCH",
        body: { [key]: val },
      });
      toast(`Feature ${val ? "activated" : "deactivated"}`, "success");
      renderCoopDetail(id);
    } catch (err) {
      toast(err.message, "error");
    }
  };

  window.saveCoopConfig = async function (id) {
    const num = (elId, toKobo = false) => {
      const el = document.getElementById(elId);
      if (!el || el.value === "") return undefined;
      const v = Number(el.value);
      if (Number.isNaN(v)) return undefined;
      return toKobo ? Math.round(v * 100) : v;
    };

    const payload = {};
    const assign = (key, val) => {
      if (val !== undefined) payload[key] = val;
    };

    assign("loanInterestRate", num("cfgLoanInterest"));
    assign("maxLoanMultiplier", num("cfgMaxLoanMultiplier"));
    assign("loanDurationMonths", num("cfgLoanDuration"));
    assign("minLoanTermMonths", num("cfgMinLoanTerm"));
    assign("minGuarantors", num("cfgMinGuarantors"));
    assign("serviceChargePercent", num("cfgServiceCharge"));
    assign("lateFinePercent", num("cfgLateFine"));
    assign("loanProtectionPercent", num("cfgLoanProtection"));
    assign("maxLoanPerMember", num("cfgMaxLoanPerMember", true));

    assign("dailyPayoutLimit", num("cfgDailyPayout", true));
    assign("minContribution", num("cfgMinContribution", true));
    assign("minSavings", num("cfgMinSavings", true));
    assign("minWithdrawal", num("cfgMinWithdrawal", true));
    assign("maxWithdrawal", num("cfgMaxWithdrawal", true));
    assign("withdrawalCooldownMonths", num("cfgWithdrawalCooldown"));

    assign("reserveFundPercent", num("cfgReserveFund"));
    assign("educationFundPercent", num("cfgEducationFund"));
    assign("dividendCapPercent", num("cfgDividendCap"));
    assign("sharePrice", num("cfgSharePrice", true));
    assign("ombudsmanSlaDays", num("cfgOmbudsmanSla"));
    assign("agmQuorumPercent", num("cfgAgmQuorum"));

    try {
      await api(`/coops/${id}/config`, {
        method: "PATCH",
        body: payload,
      });
      toast("Cooperative configuration saved", "success");
      renderCoopDetail(id);
    } catch (err) {
      toast(err.message, "error");
    }
  };

  async function reloadRegisters(id) {
    coopRegisters = await api(`/coops/${id}/compliance-registers`);
    renderCoopShell();
  }

  window.createBreach = async function (id) {
    const title = (document.getElementById("brTitle")?.value || "").trim();
    const description = (document.getElementById("brDesc")?.value || "").trim();
    const discoveredAt = (document.getElementById("brDate")?.value || "").trim();
    const affectedCount = (document.getElementById("brCount")?.value || "").trim();
    if (!title || !description) return toast("Title and description are required", "error");
    try {
      await api(`/coops/${id}/breaches`, {
        method: "POST",
        body: {
          title,
          description,
          discoveredAt: discoveredAt || undefined,
          affectedCount: affectedCount === "" ? null : Number(affectedCount),
        },
      });
      toast("Breach recorded", "success");
      await reloadRegisters(id);
    } catch (err) {
      toast(err.message, "error");
    }
  };

  window.markBreachNotified = async function (arg) {
    const [id, breachId] = String(arg).split(":");
    const reference = prompt("NDPC acknowledgement / reference (optional):") || "";
    try {
      await api(`/coops/${id}/breaches/${breachId}`, {
        method: "PATCH",
        body: {
          ndpcNotifiedAt: new Date().toISOString(),
          ndpcReference: reference.trim() || null,
          status: "notified",
        },
      });
      toast("NDPC notification recorded", "success");
      await reloadRegisters(id);
    } catch (err) {
      toast(err.message, "error");
    }
  };

  window.createDpia = async function (id) {
    const title = (document.getElementById("dpTitle")?.value || "").trim();
    const activity = (document.getElementById("dpActivity")?.value || "").trim();
    if (!title || !activity) return toast("Title and activity are required", "error");
    try {
      await api(`/coops/${id}/dpias`, { method: "POST", body: { title, activity } });
      toast("DPIA added", "success");
      await reloadRegisters(id);
    } catch (err) {
      toast(err.message, "error");
    }
  };

  window.createCrossBorder = async function (id) {
    const country = (document.getElementById("xbCountry")?.value || "").trim();
    const recipient = (document.getElementById("xbRecipient")?.value || "").trim();
    const purpose = (document.getElementById("xbPurpose")?.value || "").trim();
    const safeguard = document.getElementById("xbSafeguard")?.value || "scc";
    if (!country || !recipient || !purpose) {
      return toast("Country, recipient and purpose are required", "error");
    }
    try {
      await api(`/coops/${id}/cross-border-transfers`, {
        method: "POST",
        body: { country, recipient, purpose, safeguard },
      });
      toast("Cross-border transfer added", "success");
      await reloadRegisters(id);
    } catch (err) {
      toast(err.message, "error");
    }
  };

  window.generateAnnualReport = async function (id) {
    const year = Number(document.getElementById("regYear")?.value);
    const packType = document.getElementById("regPack")?.value || "statutory";
    try {
      const res = await api(`/coops/${id}/regulator-reports`, {
        method: "POST",
        body: { year, packType },
      });
      toast("Regulator pack generated");
      coopRegulator = await api(`/coops/${id}/regulator-reports`);
      renderCoopShell();
      return res;
    } catch (err) {
      toast(err.message, "error");
    }
  };

  window.toggleRegulatorFile = function (reportId) {
    if (regulatorFileTarget === reportId) {
      regulatorFileTarget = null;
      regulatorFilingDraft = null;
    } else {
      const report = (coopRegulator.reports || []).find((r) => r.id === reportId);
      regulatorFileTarget = reportId;
      regulatorFilingDraft = {
        reportId,
        ack: report?.acknowledgementId || "",
        note: report?.notes || "",
      };
    }
    renderCoopShell();
  };

  window.cancelRegulatorFile = function () {
    regulatorFileTarget = null;
    regulatorFilingDraft = null;
    renderCoopShell();
  };

  window.fileRegulatorReport = async function (coopId, reportId) {
    const id = coopId;
    const acknowledgementId = document.getElementById("regAck")?.value || "";
    const note = document.getElementById("regNote")?.value || "";
    try {
      const res = await api(`/coops/${id}/regulator-reports/${reportId}/file`, {
        method: "POST",
        body: { acknowledgementId, note },
      });
      toast(res.message || "Filing saved");
      regulatorFileTarget = null;
      regulatorFilingDraft = null;
      coopRegulator = await api(`/coops/${id}/regulator-reports`);
      renderCoopShell();
    } catch (err) {
      toast(err.message, "error");
    }
  };

  // ============================================================
  //  Create coop
  // ============================================================
  function renderCreateCoop(el) {
    el.innerHTML = `
      <div class="card" style="max-width:720px;">
        <div class="card-header"><span class="card-title">Provision a new cooperative</span></div>
        <div class="card-body">
          <div class="form-inline">
            <div class="form-field" style="flex:1; min-width:220px;"><label>Cooperative name</label><input id="coopName" placeholder="e.g. Lagos Teachers Coop"></div>
            <div class="form-field"><label>Code</label><input id="coopCode" placeholder="e.g. LTC01" style="text-transform:uppercase;"></div>
            <div class="form-field"><label>State</label><input id="coopState" placeholder="e.g. Lagos"></div>
            <div class="form-field"><label>Reg. number (optional)</label><input id="coopReg" placeholder="e.g. EK/12345"></div>
          </div>
          <h3 class="card-title mt-4 mb-4">Super-admin</h3>
          <div class="form-inline">
            <div class="form-field" style="flex:1; min-width:220px;"><label>Name</label><input id="saName" placeholder="Full name"></div>
            <div class="form-field"><label>Phone</label><input id="saPhone" placeholder="0801 234 5678" inputmode="numeric"></div>
          </div>
          <div class="flex gap-2 mt-4">
            <button class="btn btn-primary" data-action="createCoop">Create cooperative</button>
          </div>
          <div id="createCoopResult" class="mt-4"></div>
        </div>
      </div>`;
  }

  window.createCoop = async function () {
    const name = (document.getElementById("coopName")?.value || "").trim();
    const code = (document.getElementById("coopCode")?.value || "").trim().toUpperCase();
    const state = (document.getElementById("coopState")?.value || "").trim();
    const registrationNumber = (document.getElementById("coopReg")?.value || "").trim();
    const saName = (document.getElementById("saName")?.value || "").trim();
    const saPhoneRaw = (document.getElementById("saPhone")?.value || "").replace(/[^0-9]/g, "");
    const result = document.getElementById("createCoopResult");

    if (!name || !code) {
      if (result) result.innerHTML = '<span class="text-red">Name and code are required.</span>';
      return;
    }
    if (!saPhoneRaw) {
      if (result) result.innerHTML = '<span class="text-red">Super-admin phone is required.</span>';
      return;
    }
    const saPhone = saPhoneRaw.startsWith("234") ? saPhoneRaw : "234" + saPhoneRaw;

    try {
      const res = await api("/coops", {
        method: "POST",
        body: {
          name,
          code,
          state: state || undefined,
          registrationNumber: registrationNumber || undefined,
          superAdmin: { name: saName || undefined, phone: saPhone },
        },
      });
      toast("Cooperative created", "success");
      if (result) {
        result.innerHTML = `
          <div class="callout success"><div>
            <div>Cooperative <strong>${esc(name)}</strong> provisioned.</div>
            <div class="mt-4">Code: <span class="dev-code">${esc(res.code || code)}</span></div>
            <div class="mt-4">Super-admin phone: <span class="font-mono">${esc(formatPhone(saPhone))}</span></div>
            <div class="mt-4">Temporary PIN — share securely, it must be changed on first login:
              <div class="temp-pin" id="newCoopPin">${esc(res.tempPin || "—")}</div>
              <button class="btn btn-secondary btn-xs mt-4" data-action="copyText" data-arg="newCoopPin">Copy PIN</button>
            </div>
            <div class="mt-4"><button class="btn btn-primary btn-sm" data-action="openCoop" data-arg="${esc(res.cooperativeId)}">Open cooperative</button></div>
          </div></div>`;
      }
    } catch (err) {
      if (result) result.innerHTML = `<span class="text-red">${esc(err.message)}</span>`;
    }
  };

  // ============================================================
  //  Policies
  // ============================================================
  async function renderPolicies(el) {
    el.innerHTML =
      '<div class="card"><div class="card-body"><div class="empty-state"><p class="text-muted">Loading policies…</p></div></div></div>';
    try {
      const data = await api("/policies");
      policiesData = data.policies || [];
      policiesData.forEach((row) => {
        if (row.rule) ruleByKey[row.key] = row.rule;
      });
      if (!policiesData.length) {
        el.innerHTML = `<div class="card"><div class="empty-state">
          <h3>No platform rules</h3>
          <p>The rule registry is empty.</p>
        </div></div>`;
        return;
      }
      el.innerHTML = `
        <div class="card">
          <div class="card-header">
            <span class="card-title">Platform rules</span>
            <span class="text-muted text-sm">${readOnly ? "Support role is read-only." : "Values are platform-level; locked keys cannot be overridden by a coop. Blank value uses the registry default."}</span>
          </div>
          <div class="card-body flush">
            <div class="table-wrapper">
              <table>
                <thead><tr><th>Rule</th><th>Value</th><th>Min</th><th>Max</th><th>Locked</th><th></th></tr></thead>
                <tbody>
                  ${policiesData.map(policyRow).join("")}
                </tbody>
              </table>
            </div>
          </div>
        </div>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load policies</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function policyRow(p) {
    const rule = p.rule || ruleByKey[p.key] || {};
    const dis = readOnly ? "disabled" : "";
    let valueControl;
    if (rule.type === "bool") {
      const v = p.value === undefined ? rule.default : p.value;
      valueControl = `<select id="pol-val-${p.key}" class="toolbar-select" ${dis}>
        <option value="true" ${v === true ? "selected" : ""}>true</option>
        <option value="false" ${v === false ? "selected" : ""}>false</option>
      </select>`;
    } else {
      const v =
        p.value === undefined || p.value === null
          ? rule.default === undefined || rule.default === null
            ? ""
            : rule.default
          : p.value;
      valueControl = `<input id="pol-val-${p.key}" class="policy-input" value="${esc(v)}" ${dis}>`;
    }
    const unit = rule.unit ? ` <span class="text-muted text-xs">${esc(rule.unit)}</span>` : "";
    return `<tr>
      <td class="font-bold">${esc(rule.label || p.key)}
        <div class="text-muted text-xs font-mono">${esc(p.key)}</div>
        <div class="text-muted text-xs">${esc(rule.category || "")}${rule.type ? " · " + esc(rule.type) : ""}</div>
        <div class="text-muted text-xs">default: ${esc(rule.default === undefined ? "—" : rule.default)}</div>
      </td>
      <td>${valueControl}${unit}</td>
      <td><input id="pol-min-${p.key}" class="policy-input" value="${p.min === null || p.min === undefined ? "" : esc(p.min)}" ${dis}></td>
      <td><input id="pol-max-${p.key}" class="policy-input" value="${p.max === null || p.max === undefined ? "" : esc(p.max)}" ${dis}></td>
      <td><label class="policy-switch"><input type="checkbox" id="pol-lock-${p.key}" ${p.locked ? "checked" : ""} ${dis}> locked</label></td>
      <td><button class="btn btn-primary btn-xs" data-action="savePolicy" data-arg="${esc(p.key)}" ${dis}>Save</button></td>
    </tr>`;
  }

  window.savePolicy = async function (key) {
    const rule = ruleByKey[key] || {};
    const valEl = document.getElementById(`pol-val-${key}`);
    const minEl = document.getElementById(`pol-min-${key}`);
    const maxEl = document.getElementById(`pol-max-${key}`);
    const lockEl = document.getElementById(`pol-lock-${key}`);
    const body = { locked: !!(lockEl && lockEl.checked) };

    if (rule.type === "bool") {
      body.value = valEl ? valEl.value === "true" : undefined;
    } else if (
      rule.type === "int" ||
      rule.type === "float" ||
      rule.type === "money" ||
      rule.type === "percent"
    ) {
      if (valEl && valEl.value !== "") {
        const n = Number(valEl.value);
        if (Number.isNaN(n)) {
          toast("Value must be a number", "error");
          return;
        }
        body.value = n;
      }
    } else if (valEl && valEl.value !== "") {
      body.value = valEl.value;
    }

    if (minEl && minEl.value !== "") body.min = Number(minEl.value);
    if (maxEl && maxEl.value !== "") body.max = Number(maxEl.value);

    try {
      await api(`/policies/${encodeURIComponent(key)}`, { method: "PUT", body });
      toast("Policy saved", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  };

  // ============================================================
  //  Platform admins (owner-only)
  // ============================================================
  async function renderAdmins(el) {
    el.innerHTML =
      '<div class="card"><div class="card-body"><div class="empty-state"><p class="text-muted">Loading admins…</p></div></div></div>';
    try {
      const data = await api("/admins");
      const admins = data.admins || [];
      el.innerHTML = `
        <div class="card mb-6">
          <div class="card-header"><span class="card-title">Platform admins</span></div>
          <div class="card-body flush">
            ${
              admins.length
                ? `<div class="table-wrapper"><table>
                  <thead><tr><th>Name</th><th>Phone</th><th>Role</th><th>Status</th><th>2FA</th><th>PIN changed</th><th>Last login</th></tr></thead>
                  <tbody>
                    ${admins
                      .map(
                        (a) => `<tr>
                      <td class="font-bold">${esc(a.name || "—")}</td>
                      <td class="font-mono text-sm">${esc(formatPhone(a.phone))}</td>
                      <td>
                        <select class="toolbar-select" data-action-change="setPlatformAdminRole" data-arg="${esc(a.id)}">
                          ${["owner", "developer", "support"]
                            .map(
                              (r) =>
                                `<option value="${r}" ${a.role === r ? "selected" : ""}>${r}</option>`,
                            )
                            .join("")}
                        </select>
                      </td>
                      <td>${a.active ? '<span class="badge badge-green">active</span>' : '<span class="badge badge-red">disabled</span>'}</td>
                      <td>${a.totpEnabled ? '<span class="badge badge-blue">on</span>' : '<span class="text-muted">—</span>'}</td>
                      <td>${a.mustChangePin ? '<span class="badge badge-gold">pending</span>' : '<span class="text-muted">done</span>'}</td>
                      <td class="text-muted text-sm">${date(a.lastLoginAt)}</td>
                      <td>
                        <button class="btn ${a.active ? "btn-danger" : "btn-success"} btn-xs" data-action="togglePlatformAdminActive" data-arg="${esc(a.id)}" data-active="${a.active}">${a.active ? "Disable" : "Enable"}</button>
                        ${
                          a.totpEnabled && a.id !== me?.id
                            ? `<button class="btn btn-secondary btn-xs" data-action="resetPlatformAdmin2fa" data-arg="${esc(a.id)}" data-name="${esc(a.name || a.phone)}">Reset 2FA</button>`
                            : ""
                        }
                      </td>
                    </tr>`,
                      )
                      .join("")}
                  </tbody>
                </table></div>`
                : '<div class="empty-state"><h3>No platform admins</h3></div>'
            }
          </div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Add platform admin</span></div>
          <div class="card-body">
            <div class="form-inline">
              <div class="form-field" style="flex:1; min-width:220px;"><label>Name</label><input id="paName" placeholder="Full name"></div>
              <div class="form-field"><label>Phone</label><input id="paPhone" placeholder="0801 234 5678" inputmode="numeric"></div>
              <div class="form-field"><label>Role</label>
                <select id="paRole">
                  <option value="developer">developer</option>
                  <option value="support">support</option>
                  <option value="owner">owner</option>
                </select>
              </div>
              <button class="btn btn-primary btn-sm" data-action="createPlatformAdmin">Add admin</button>
            </div>
            <div id="paResult" class="mt-4"></div>
          </div>
        </div>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load admins</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  window.createPlatformAdmin = async function () {
    const name = (document.getElementById("paName")?.value || "").trim();
    const phoneRaw = (document.getElementById("paPhone")?.value || "").replace(/[^0-9]/g, "");
    const role = document.getElementById("paRole")?.value || "developer";
    const result = document.getElementById("paResult");
    if (!name || !phoneRaw) {
      if (result) result.innerHTML = '<span class="text-red">Name and phone are required.</span>';
      return;
    }
    const phone = phoneRaw.startsWith("234") ? phoneRaw : "234" + phoneRaw;
    try {
      const res = await api("/admins", { method: "POST", body: { name, phone, role } });
      toast("Platform admin created", "success");
      if (result) {
        result.innerHTML = `<div class="callout success"><div>
          Created <strong>${esc(name)}</strong> (${esc(role)}). Temporary PIN — share securely:
          <div class="temp-pin" id="newPaPin">${esc(res.tempPin || "—")}</div>
          <button class="btn btn-secondary btn-xs mt-4" data-action="copyText" data-arg="newPaPin">Copy PIN</button>
        </div></div>`;
      }
      renderAdmins(document.getElementById("pageContent"));
    } catch (err) {
      if (result) result.innerHTML = `<span class="text-red">${esc(err.message)}</span>`;
    }
  };

  window.setPlatformAdminRole = async function (id, _event, el) {
    try {
      await api(`/admins/${id}`, { method: "PATCH", body: { role: el.value } });
      toast("Role updated", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  };

  window.togglePlatformAdminActive = async function (id, _event, el) {
    const active = el.dataset.active !== "true";
    try {
      await api(`/admins/${id}`, { method: "PATCH", body: { active } });
      toast(active ? "Admin enabled" : "Admin disabled", "success");
      renderAdmins(document.getElementById("pageContent"));
    } catch (err) {
      toast(err.message, "error");
    }
  };

  window.resetPlatformAdmin2fa = async function (id, _event, el) {
    const name = el?.dataset.name || "this admin";
    const confirmPin = prompt(`Confirm your own PIN to reset 2FA for ${name}:`);
    if (!confirmPin) return;
    const totp = me?.totpEnabled ? prompt("Enter your authenticator code to confirm:") || "" : "";
    if (me?.totpEnabled && !totp) return;
    try {
      await api(`/admins/${id}/reset-2fa`, {
        method: "POST",
        body: { confirmPin, totp: totp || undefined },
      });
      toast("2FA reset; the admin must re-enrol at next sign-in", "success");
      renderAdmins(document.getElementById("pageContent"));
    } catch (err) {
      toast(err.message, "error");
    }
  };

  window.copyText = function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    const text = el.value || el.textContent || "";
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast("Copied", "success"),
        () => toast("Copy failed", "error"),
      );
    } else {
      toast("Clipboard unavailable", "error");
    }
  };

  // ============================================================
  //  Developer operations
  // ============================================================
  async function renderSandbox(el) {
    el.innerHTML = `<div class="card"><div class="card-body"><div class="skeleton" style="height:320px;"></div></div></div>`;
    try {
      sandboxOverview = await api("/sandbox");
      if (!sandboxOverview.personas.some((persona) => persona.id === sandboxPersonaId)) {
        sandboxPersonaId = sandboxOverview.personas[0]?.id || "active_saver";
      }
      const state = await api(`/sandbox/state?personaId=${encodeURIComponent(sandboxPersonaId)}`);
      sandboxState = state.state;
      renderSandboxContent(el);
    } catch (err) {
      if (err.code === "sandbox_not_provisioned") {
        el.innerHTML = `<div class="empty-state">
          <h3>Sandbox not provisioned</h3>
          <p>Provisioning creates a dedicated sandbox cooperative with synthetic personas.</p>
          <button class="btn btn-primary btn-sm" data-action="provisionSandbox">Provision sandbox</button>
        </div>`;
        return;
      }
      el.innerHTML = `<div class="empty-state"><h3>Sandbox unavailable</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  window.provisionSandbox = async function () {
    try {
      await api("/sandbox/ensure", { method: "POST", body: {} });
      toast("Sandbox provisioned", "success");
      renderSandbox(document.getElementById("pageContent"));
    } catch (err) {
      toast(err.message, "error");
    }
  };

  function renderSandboxContent(el) {
    if (!sandboxOverview) return;
    const personas = sandboxOverview.personas || [];
    const selected = personas.find((persona) => persona.id === sandboxPersonaId);
    if (!selected) return;
    const writable = me && (me.role === "owner" || me.role === "developer");
    const transcript = sandboxTranscripts[sandboxPersonaId] || [];
    const meta = sandboxTurnMeta[sandboxPersonaId];
    const state = sandboxState || { session: null, wallet: null, loans: [] };
    const loans = state.loans || [];
    const sessionData = state.session?.data
      ? JSON.stringify(state.session.data, null, 2)
      : "No active session data";

    el.innerHTML = `
      <div class="sandbox-banner">
        <div><strong>Isolated bot environment</strong><span>Messages, payments, insurance, email and storage are simulated. Only the optional Groq AI request can use the network.</span></div>
        <div class="sandbox-health"><span class="sandbox-health-dot ${sandboxOverview.cooperative?.status === "active" ? "online" : ""}"></span>${esc(sandboxOverview.cooperative?.code || "SANDBOX")}</div>
      </div>
      <div class="sandbox-layout">
        <aside class="card sandbox-personas">
          <div class="card-header"><div><span class="card-title">Test identities</span><small>${esc(sandboxOverview.cooperative?.name || "Sandbox Cooperative")}</small></div></div>
          <div class="sandbox-persona-list">
            ${personas.map((persona) => {
              const isSelected = persona.id === sandboxPersonaId;
              const balance = isSelected && state.wallet
                ? state.wallet.balanceKobo
                : persona.walletKobo;
              return `<button class="sandbox-persona ${isSelected ? "active" : ""}" data-action="selectSandboxPersona" data-arg="${esc(persona.id)}">
                <span class="sandbox-avatar">${esc(persona.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2))}</span>
                <span class="sandbox-persona-info"><strong>${esc(persona.name)}</strong><small>${esc(persona.label)} · ${esc(persona.role)}</small><small>${esc(formatPhone(persona.phone))}</small></span>
                <span class="sandbox-persona-balance">${balance == null ? "—" : currency(balance)}</span>
              </button>`;
            }).join("")}
          </div>
          <div class="sandbox-persona-footer">
            <button class="btn btn-secondary btn-sm" data-action="resetSandbox" ${writable ? "" : "disabled"}>Reset sandbox</button>
            ${writable ? "" : '<small>Read-only access</small>'}
          </div>
        </aside>

        <section class="card sandbox-chat">
          <div class="card-header sandbox-chat-header">
            <div><span class="card-title">${esc(selected.name)}</span><small>${esc(selected.description)}</small></div>
            <span class="sandbox-safe-tag">SIMULATED</span>
          </div>
          <div class="sandbox-quick-actions">
            ${["menu", "balance", "save 2000", "loan 50000 3", "myloans", "trend", "help"].map((command) =>
              `<button class="sandbox-quick" data-action="sendSandboxQuick" data-arg="${esc(command)}" ${writable ? "" : "disabled"}>${esc(command)}</button>`,
            ).join("")}
          </div>
          <div class="sandbox-transcript" id="sandboxTranscript">
            ${transcript.length
              ? transcript.map((message) => renderSandboxMessage(message, selected)).join("")
              : '<div class="sandbox-empty"><span>↗</span><strong>Start a conversation</strong><small>Send a message as this persona. The bot runs its regular state machine against isolated fixtures.</small></div>'}
          </div>
          <div class="sandbox-composer">
            <textarea id="sandboxComposer" rows="2" maxlength="500" placeholder="${writable ? "Type a WhatsApp message…" : "Support access is read-only"}" ${writable ? "" : "disabled"}></textarea>
            <div class="sandbox-composer-actions">
              <label class="sandbox-ai-toggle" title="Allow the real Groq API for this turn">
                <input type="checkbox" data-action-change="toggleSandboxAi" ${sandboxAiEnabled ? "checked" : ""} ${sandboxOverview.ai?.available && writable ? "" : "disabled"}>
                <span>Groq AI ${sandboxOverview.ai?.available ? "" : "(not configured)"}</span>
              </label>
              <span class="sandbox-char-count">500 char max</span>
              <button class="btn btn-primary" data-action="sendSandboxMessage" ${writable ? "" : "disabled"}>Send <span aria-hidden="true">↗</span></button>
            </div>
          </div>
        </section>

        <aside class="card sandbox-inspector">
          <div class="card-header"><span class="card-title">Live state</span></div>
          <div class="sandbox-inspector-body">
            <div class="sandbox-state-block">
              <span class="sandbox-label">Conversation</span>
              <strong>${esc(state.session?.state || "Not started")}</strong>
              <pre>${esc(sessionData)}</pre>
            </div>
            <div class="sandbox-state-block">
              <span class="sandbox-label">Wallet</span>
              <strong>${state.wallet ? currency(state.wallet.balanceKobo) : "Not provisioned"}</strong>
              <small>Total saved ${state.wallet ? currency(state.wallet.totalSavedKobo) : "—"}</small>
            </div>
            <div class="sandbox-state-block">
              <span class="sandbox-label">Loans (${loans.length})</span>
              ${loans.length ? `<div class="sandbox-loans">${loans.map((loan) => `<div><span>${esc(loan.status)}${loan.dueDate && new Date(loan.dueDate) < new Date() ? '<i class="sandbox-overdue">OVERDUE</i>' : ""}</span><strong>${currency(loan.balanceKobo)}</strong><small>Principal ${currency(loan.amountKobo)} · due ${date(loan.dueDate)}</small></div>`).join("")}</div>` : '<small>No loans</small>'}
            </div>
            <div class="sandbox-state-block">
              <span class="sandbox-label">Last turn</span>
              ${meta ? `<strong class="sandbox-ai-path ${esc(meta.path)}">${esc(meta.path === "ai" ? "Live AI" : meta.path === "guardrail" ? "Guardrail" : "Deterministic")}</strong><small>${fmt(meta.durationMs)} ms · ${esc(dateTime(meta.at))}</small>` : "<small>No turns yet</small>"}
            </div>
            <div class="sandbox-inspector-foot">Sandbox fixtures are excluded from platform totals and scheduled jobs.</div>
          </div>
        </aside>
      </div>`;
    const transcriptEl = document.getElementById("sandboxTranscript");
    if (transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function renderSandboxMessage(message, selected) {
    if (message.kind === "inbound") {
      return `<div class="sandbox-message-row inbound"><div class="sandbox-message"><span class="sandbox-message-author">${esc(selected.name)} · ${esc(selected.role)}</span><p>${esc(message.text)}</p><time>${esc(dateTime(message.timestamp))}</time></div></div>`;
    }
    const isCrossPersona = message.to && message.to !== selected.phone;
    const content = message.type === "document"
      ? `<div class="sandbox-file"><span>▤</span><div><strong>${esc(message.filename || "Document")}</strong><small>${esc(message.mimeType || "File")}</small></div></div>${message.caption ? `<p>${esc(message.caption)}</p>` : ""}`
      : message.type === "buttons"
        ? `${message.text ? `<p>${esc(message.text)}</p>` : ""}<div class="sandbox-button-chips">${(message.buttons || []).map((button) => `<span>${esc(button.title)}</span>`).join("")}</div>`
        : message.type === "flow"
          ? `<strong>${esc(message.header || "Secure form")}</strong>${message.text ? `<p>${esc(message.text)}</p>` : ""}${message.footer ? `<small>${esc(message.footer)}</small>` : ""}`
          : `<p>${esc(message.text || "")}</p>`;
    return `<div class="sandbox-message-row outbound ${isCrossPersona ? "cross-persona" : ""}"><div class="sandbox-message">
      ${isCrossPersona ? `<span class="sandbox-cross-tag">To ${esc(message.toName || message.to)}</span>` : ""}
      ${content}<time>${esc(dateTime(message.timestamp))}</time></div></div>`;
  }

  function dateTime(value) {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? "—"
      : parsed.toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
  }

  async function loadSandboxPersona(personaId) {
    sandboxPersonaId = personaId;
    try {
      const result = await api(`/sandbox/state?personaId=${encodeURIComponent(personaId)}`);
      sandboxState = result.state;
      renderSandboxContent(document.getElementById("pageContent"));
    } catch (err) {
      toast(err.message, "error");
    }
  }

  window.selectSandboxPersona = function (personaId) {
    if (personaId) loadSandboxPersona(personaId);
  };

  window.toggleSandboxAi = function (arg, event, el) {
    sandboxAiEnabled = Boolean(el.checked);
  };

  async function sendSandboxText(text, composer) {
    if (!sandboxOverview || !text.trim()) return;
    const value = text.trim();
    if (composer) composer.disabled = true;
    try {
      const result = await api("/sandbox/message", {
        method: "POST",
        body: { personaId: sandboxPersonaId, text: value, aiEnabled: sandboxAiEnabled },
      });
      const history = sandboxTranscripts[sandboxPersonaId] || (sandboxTranscripts[sandboxPersonaId] = []);
      history.push({ kind: "inbound", text: value, timestamp: new Date().toISOString() });
      history.push(...(result.messages || []));
      sandboxState = result.state;
      sandboxTurnMeta[sandboxPersonaId] = { ...result.ai, durationMs: result.durationMs, at: new Date().toISOString() };
      if (composer) composer.value = "";
      renderSandboxContent(document.getElementById("pageContent"));
    } catch (err) {
      toast(err.message, "error");
    } finally {
      const currentComposer = document.getElementById("sandboxComposer");
      if (currentComposer) {
        currentComposer.disabled = false;
        currentComposer.focus();
      }
    }
  }

  window.sendSandboxMessage = function () {
    const composer = document.getElementById("sandboxComposer");
    if (composer) sendSandboxText(composer.value, composer);
  };

  window.sendSandboxQuick = function (text) {
    if (text) sendSandboxText(text);
  };

  window.resetSandbox = async function () {
    if (!window.confirm("Reset all sandbox conversations and fixtures? This cannot be undone.")) return;
    try {
      await api("/sandbox/reset", { method: "POST", body: {} });
      Object.keys(sandboxTranscripts).forEach((key) => delete sandboxTranscripts[key]);
      Object.keys(sandboxTurnMeta).forEach((key) => delete sandboxTurnMeta[key]);
      toast("Sandbox reset and fixtures reseeded", "success");
      await renderSandbox(document.getElementById("pageContent"));
    } catch (err) {
      toast(err.message, "error");
    }
  };

  document.addEventListener("keydown", (event) => {
    if (event.target?.id === "sandboxComposer" && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      window.sendSandboxMessage();
    }
  });

  async function renderLiquidity(el) {
    el.innerHTML = `<div class="stats-grid">${skeletonCards(6)}</div>
      <div class="card"><div class="card-header"><span class="card-title">Cooperative exposure</span></div>
      <div class="card-body"><div class="skeleton" style="height:180px;"></div></div></div>`;
    try {
      const { totals, coops, reserveTargetConfigured } = await api("/ops/liquidity");
      el.innerHTML = `
        <div class="ops-note">All amounts are shown in naira. PAR estimates use the recorded loan due date and full outstanding balance. Validate against installment-level schedules before using them for regulatory reporting.</div>
        <div class="stats-grid ops-stats">
          ${statCard("indigo", "Cooperatives", fmt(totals.cooperativeCount))}
          ${statCard("green", "Member deposits", currency(totals.savingsTotal))}
          ${statCard("blue", "Loans outstanding", currency(totals.loanOutstanding))}
          ${statCard("gold", "Pending outflows", currency(totals.pendingOutflows))}
          ${statCard("red", "PAR 30 estimate", `${currency(totals.par30Amount)} <small>${fmt(totals.par30Pct)}%</small>`)}
          ${statCard("red", "PAR 90 estimate", `${currency(totals.par90Amount)} <small>${fmt(totals.par90Pct)}%</small>`)}
          ${statCard("green", "Reserve funds", currency(totals.reserveFundBalance))}
          ${statCard("indigo", "Reserve / deposits", `${fmt(totals.reserveToSavingsPct)}%`)}
        </div>
        <div class="callout ops-callout">
          ${reserveTargetConfigured
            ? "Reserve levels can be compared with the configured statutory target."
            : "Reserve balances are reported from cooperative records. No statutory reserve threshold is configured, so this is not a compliance assessment."}
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Cooperative cash flow</span><span class="text-muted text-sm">${fmt(coops.length)} cooperatives</span></div>
          <div class="card-body flush ops-table-wrap">
            ${coops.length ? `<table class="ops-table"><thead><tr><th>Cooperative</th><th>Members</th><th>Deposits</th><th>Loan book</th><th>Pending outflows</th><th>Reserve</th></tr></thead>
              <tbody>${coops.map((coop) => `<tr>
                <td><strong>${esc(coop.name)}</strong><small>${esc(coop.code)}</small></td>
                <td>${fmt(coop.memberCount)}</td><td>${currency(coop.savingsTotal)}</td>
                <td>${currency(coop.loanOutstanding)}</td><td>${currency(coop.pendingOutflows)}</td>
                <td>${currency(coop.reserveFundBalance)}</td>
              </tr>`).join("")}</tbody></table>` : '<div class="empty-state"><h3>No cooperative data</h3><p>Platform aggregates will appear when cooperatives are active.</p></div>'}
          </div>
        </div>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Liquidity data unavailable</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  async function renderJobs(el) {
    el.innerHTML = `<div class="card"><div class="card-header"><span class="card-title">Background jobs</span></div>
      <div class="card-body"><div class="skeleton" style="height:220px;"></div></div></div>`;
    try {
      const [data, liquidity] = await Promise.all([api("/ops/jobs"), api("/ops/liquidity")]);
      if (!data.connected) {
        el.innerHTML = `<div class="empty-state"><h3>Scheduler unavailable</h3>
          <p>${data.configured ? "Redis is configured but not connected." : "Redis is not configured, so BullMQ jobs cannot be inspected or queued."}</p></div>`;
        return;
      }
      const labels = {
        tick: ["Scheduler tick", "Runs reminders, retention, compliance follow-ups and other scheduled workflows."],
        backup: ["Database backup", "Creates the scheduled backup."],
        reconcile: ["Payment reconciliation", "Checks provider transfers and settlement records."],
        digest: ["Savings digests", "Sends scheduled movement and savings summaries."],
        poller: ["Transfer status poller", "Checks pending provider transfer statuses."],
      };
      const schedulers = data.schedulers || [];
      const cooperativeOptions = (liquidity.coops || []).map((coop) =>
        `<option value="${esc(coop.id)}">${esc(coop.name)} (${esc(coop.code)})</option>`,
      ).join("");
      el.innerHTML = `
        <div class="callout ops-callout">
          Manual execution is limited to loan reminders for one cooperative. The full scheduler tick can initiate direct-debit collections and other external actions.
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Recurring schedules</span><span class="badge badge-green">Redis connected</span></div>
          <div class="card-body flush ops-table-wrap">${schedulers.length ? `<table class="ops-table">
            <thead><tr><th>Job</th><th>Cadence</th><th>Next run</th><th>Control</th></tr></thead><tbody>
              ${schedulers.map((job) => {
                const [label, description] = labels[job.name] || [job.name, "Registered BullMQ scheduler"];
                const runnable = job.name === "loan_reminders" && isOwner;
                return `<tr><td><strong>${esc(label)}</strong><small>${esc(description)}</small></td>
                  <td>${job.everyMs ? esc(formatInterval(job.everyMs)) : esc(job.pattern || "Configured")}</td>
                  <td>${job.nextAt ? esc(new Date(job.nextAt).toLocaleString()) : "Not reported"}</td>
                  <td>${runnable ? '<button class="btn btn-secondary btn-sm" data-action="runManualJob">Run reminders</button>' : '<span class="text-muted text-sm">Scheduled only</span>'}</td></tr>`;
              }).join("")}
            </tbody></table>` : '<div class="empty-state"><h3>No recurring schedules found</h3><p>Check that the application registered its BullMQ schedulers.</p></div>'}</div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Run loan reminders now</span></div>
          <div class="card-body">
            <p class="text-muted">This sends due and overdue repayment notices to members and guarantors in one cooperative. Existing reminder claims prevent duplicate sends.</p>
            <div class="form-inline ops-run-form">
              <div class="form-field"><label for="jobCooperative">Cooperative</label><select id="jobCooperative" class="toolbar-select">${cooperativeOptions || '<option value="">No cooperatives available</option>'}</select></div>
              <button class="btn btn-primary" data-action="runManualJob" ${!isOwner || !cooperativeOptions ? "disabled" : ""}>Queue reminder run</button>
            </div>
            ${!isOwner ? '<p class="text-muted text-sm mt-2">Only platform owners can queue a manual run.</p>' : ""}
          </div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Recent runs</span></div>
          <div class="card-body flush ops-table-wrap">${(data.recentRuns || []).length ? `<table class="ops-table">
            <thead><tr><th>Job</th><th>Scope</th><th>Status</th><th>Finished</th></tr></thead><tbody>
              ${data.recentRuns.map((run) => `<tr><td>${esc(run.job)}</td><td>${esc(run.cooperativeId || "Platform")}</td>
                <td>${statusBadge(run.status)}</td><td>${run.finishedAt ? esc(new Date(run.finishedAt).toLocaleString()) : "In progress"}</td></tr>`).join("")}
            </tbody></table>` : '<div class="empty-state"><p>No recent scheduler runs are retained in the queue.</p></div>'}</div>
        </div>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Scheduler data unavailable</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function formatInterval(milliseconds) {
    if (milliseconds % 86400000 === 0) return `${milliseconds / 86400000} day${milliseconds === 86400000 ? "" : "s"}`;
    if (milliseconds % 3600000 === 0) return `${milliseconds / 3600000} hour${milliseconds === 3600000 ? "" : "s"}`;
    if (milliseconds % 60000 === 0) return `${milliseconds / 60000} minutes`;
    return `${Math.round(milliseconds / 1000)} seconds`;
  }

  window.runManualJob = async function () {
    if (!isOwner) return toast("Only platform owners can queue manual jobs", "error");
    const cooperativeId = document.getElementById("jobCooperative")?.value;
    if (!cooperativeId) return toast("Choose a cooperative first", "error");
    if (!window.confirm("Queue loan reminders for this cooperative? Members and guarantors may receive WhatsApp messages.")) return;
    try {
      const result = await api("/ops/jobs/run", {
        method: "POST",
        body: { job: "loan_reminders", cooperativeId },
      });
      toast(`Reminder run queued: ${result.jobId}`, "success");
      renderJobs(document.getElementById("pageContent"));
    } catch (err) {
      toast(err.message, "error");
    }
  };

  async function renderDiagnostics(el) {
    el.innerHTML = `
      <div class="ops-intro"><h2>Check service connections</h2>
        <p>Checks use read-only provider endpoints where available. Responses and credentials are never displayed or stored.</p>
        ${isOwner
          ? '<button class="btn btn-primary" data-action="runDiagnostics">Run checks</button>'
          : '<p class="text-muted text-sm">Only platform owners can send credential validation requests.</p>'}
      </div>
      <div id="diagnosticResults" class="diagnostic-grid">
        <div class="empty-state"><h3>No recent check</h3><p>Run checks to inspect database, Redis and configured provider connectivity.</p></div>
      </div>`;
  }

  window.runDiagnostics = async function () {
    if (!isOwner) return toast("Only platform owners can run diagnostics", "error");
    const results = document.getElementById("diagnosticResults");
    if (results) results.innerHTML = `<div class="card"><div class="card-body"><div class="skeleton" style="height:170px;"></div></div></div>`;
    try {
      const data = await api("/ops/diagnostics/check", { method: "POST", body: {} });
      const entries = Object.entries(data.results || {});
      if (results) {
        results.innerHTML = entries.map(([name, result]) => `
          <div class="diagnostic-row">
            <div><strong>${esc(name)}</strong><small>${esc(result.message)}</small></div>
            <span class="badge badge-${result.status === "healthy" ? "green" : result.status === "error" ? "red" : "gray"}">${esc(result.status.replace("_", " "))}</span>
            <small>${result.durationMs == null ? "" : `${fmt(result.durationMs)} ms`}</small>
          </div>`).join("") || '<div class="empty-state"><p>No checks returned.</p></div>';
      }
      toast("Diagnostics completed", "success");
    } catch (err) {
      if (results) results.innerHTML = `<div class="empty-state"><h3>Diagnostics failed</h3><p>${esc(err.message)}</p></div>`;
      toast(err.message, "error");
    }
  };

  async function renderWebhooks(el) {
    el.innerHTML = `<div class="card"><div class="card-header"><span class="card-title">Recent webhook events</span></div>
      <div class="card-body"><div class="skeleton" style="height:240px;"></div></div></div>`;
    try {
      const data = await api("/ops/webhooks?take=50");
      el.innerHTML = `
        <div class="callout ops-callout">${esc(data.replayDisabledReason)}</div>
        <div class="card">
          <div class="card-header"><span class="card-title">Webhook deliveries</span><span class="text-muted text-sm">${fmt((data.events || []).length)} records</span></div>
          <div class="card-body flush ops-table-wrap">${data.events?.length ? `<table class="ops-table">
            <thead><tr><th>Source</th><th>Event</th><th>Status</th><th>Reference</th><th>Received</th><th>Replay</th></tr></thead>
            <tbody>${data.events.map((event) => `<tr>
              <td><strong>${esc(event.source)}</strong></td><td>${esc(event.kind)}</td>
              <td>${statusBadge(event.status)}</td>
              <td><code>${esc(truncate(event.reference, 28))}</code>${event.payloadHash ? `<small>Payload hash: ${esc(truncate(event.payloadHash, 18))}</small>` : ""}
                ${event.detail ? `<small class="ops-event-detail">${esc(event.detail)}</small>` : ""}
              </td>
              <td>${esc(new Date(event.receivedAt).toLocaleString())}</td>
              <td><button class="btn btn-secondary btn-sm" disabled title="Raw payloads are not retained">Unavailable</button></td>
            </tr>`).join("")}</tbody></table>` : '<div class="empty-state"><h3>No webhook events</h3><p>Failed inbound deliveries and provider webhook events will appear here.</p></div>'}</div>
        </div>
        <p class="text-muted text-sm ops-footnote">For failed WhatsApp inbound messages, ask the member to resend. Payment webhook reprocessing needs an audited, idempotent recovery workflow.</p>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Webhook events unavailable</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  // ============================================================
  //  Helpers
  // ============================================================
  function statCard(tone, label, value) {
    return `<div class="stat-card stat-${esc(tone || "indigo")}">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${value}</div>
    </div>`;
  }

  function skeletonCards(n) {
    return Array.from(
      { length: n },
      () =>
        '<div class="stat-card"><div class="skeleton" style="height:14px;width:80px;margin-bottom:12px;"></div><div class="skeleton" style="height:28px;width:120px;"></div></div>',
    ).join("");
  }

  function coopStatusBadge(status) {
    const s = status || "unknown";
    if (s === "active")
      return '<span class="badge badge-green"><span class="status-dot green"></span>active</span>';
    if (s === "suspended")
      return '<span class="badge badge-red"><span class="status-dot red"></span>suspended</span>';
    return `<span class="badge badge-gray"><span class="status-dot gray"></span>${esc(s)}</span>`;
  }

  function statusBadge(status) {
    const s = status || "unknown";
    if (s === "active") return '<span class="badge badge-green">active</span>';
    if (s === "filed") return '<span class="badge badge-green">filed</span>';
    if (s === "suspended" || s === "inactive")
      return '<span class="badge badge-red">' + esc(s) + "</span>";
    return `<span class="badge badge-gray">${esc(s)}</span>`;
  }

  function roleLabel(role) {
    return { owner: "Owner", developer: "Developer", support: "Support" }[role] || role || "—";
  }

  function formatRuleValue(value, rule) {
    if (value === undefined || value === null) {
      return '<span class="text-muted">—</span>';
    }
    if (rule && rule.type === "bool") return value ? "true" : "false";
    if (rule && rule.type === "money") return currency(value);
    let out = esc(value);
    if (rule && rule.unit) out += ` <span class="text-muted text-xs">${esc(rule.unit)}</span>`;
    return out;
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString("en-NG");
  }

  // Money fields are integer kobo -> display as naira with 2 dp.
  function currency(n) {
    const naira = (Number(n) || 0) / 100;
    return (
      "₦" + naira.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    );
  }

  function date(str) {
    if (!str) return "—";
    const d = new Date(str);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });
  }

  function formatPhone(p) {
    if (!p) return "";
    const clean = String(p).replace(/[^0-9]/g, "");
    if (clean.length > 10) {
      return "+" + clean.slice(0, 3) + " " + clean.slice(3, 7) + " " + clean.slice(7);
    }
    return clean;
  }

  function truncate(str, max) {
    if (!str) return "";
    const s = String(str);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function toast(msg, type = "info") {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const t = document.createElement("div");
    t.className = `toast ${type}`;
    // Service messages use WhatsApp *bold* markers; the console renders plain text.
    t.textContent = String(msg).replace(/\*([^*]+)\*/g, "$1");
    container.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }
})();
