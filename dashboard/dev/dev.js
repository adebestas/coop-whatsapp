/* ============================================================
   Platform Console — App Logic (dashboard/dev/dev.js)
   Consumes /api/developer/*. Session is an httpOnly cookie; every
   non-GET carries X-Requested-With: XMLHttpRequest, and a 401 sends
   the operator back to dev-login.html.
   ============================================================ */

(function () {
  'use strict';

  // ---- Config ----
  const API_BASE = '/api/developer';
  const STORAGE_ADMIN = 'coop_dev_admin';
  const STORAGE_THEME = 'coop_theme';

  // ---- State ----
  let me = null;
  let readOnly = false; // support role: GETs only
  let isOwner = false;
  let needsPinChange = false; // temporary PIN: show the change-PIN view and stop navigating
  let currentPage = 'overview';
  let currentArg = null;
  let currentCoopTab = 'health';
  let coopDetail = null;
  let coopActivityEntries = [];
  let coopsData = [];
  let policiesData = [];
  let ruleByKey = {};
  let loaderCount = 0;

  // ---- Init ----
  document.addEventListener('DOMContentLoaded', init);

  // ---- Delegated handlers (CSP: no inline scripts) ----
  function runAction(el, event) {
    const fn = window[el.dataset.action];
    if (typeof fn === 'function') fn(el.dataset.arg, event, el);
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el) runAction(el, e);
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-action-change]');
    if (el) runAction(el, e);
  });

  async function init() {
    applyTheme(localStorage.getItem(STORAGE_THEME) || 'light');
    // Verify the session with the server (the cookie is unreadable here).
    try {
      const res = await api('/me');
      me = res.admin;
      localStorage.setItem(STORAGE_ADMIN, JSON.stringify(me));
    } catch {
      return; // api() redirected on 401
    }
    readOnly = me.role === 'support';
    isOwner = me.role === 'owner';
    loadUserInfo();
    try {
      const p = await api('/policies');
      policiesData = p.policies || [];
      policiesData.forEach((row) => {
        if (row.rule) ruleByKey[row.key] = row.rule;
      });
    } catch {
      /* page still works without the rule catalogue */
    }
    navigateTo('overview');
  }

  function loadUserInfo() {
    if (!me) return;
    const name = me.name || 'Operator';
    setText('meName', name);
    setText('userName', name);
    setText('userAvatar', name.charAt(0).toUpperCase());
    setText('userRole', roleLabel(me.role));
    const navAdmins = document.getElementById('navAdmins');
    if (navAdmins) navAdmins.hidden = !isOwner;
    const navCreate = document.getElementById('navCreate');
    if (navCreate) navCreate.hidden = readOnly;
    if (readOnly) {
      const navPolicies = document.getElementById('navPolicies');
      if (navPolicies) navPolicies.title = 'Read-only (support role)';
    }
  }

  // ---- API helper ----
  async function tryRefresh() {
    try {
      const res = await fetch(`${API_BASE}/refresh`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const method = (opts.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    showLoader();
    try {
      let res = await fetch(`${API_BASE}${path}`, { ...opts, headers, credentials: 'same-origin' });
      if (res.status === 401 && path !== '/refresh' && (await tryRefresh())) {
        res = await fetch(`${API_BASE}${path}`, { ...opts, headers, credentials: 'same-origin' });
      }
      if (res.status === 401) {
        localStorage.removeItem(STORAGE_ADMIN);
        window.location.href = 'dev-login.html';
        throw new Error('Unauthorized');
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && data.error === 'pin_change_required') {
        needsPinChange = true;
        showChangePinView();
        throw new Error('PIN change required');
      }
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return data;
    } finally {
      hideLoader();
    }
  }

  function showLoader() {
    loaderCount++;
    const el = document.getElementById('globalLoader');
    if (el) el.style.display = 'flex';
  }
  function hideLoader() {
    loaderCount = Math.max(0, loaderCount - 1);
    if (loaderCount === 0) {
      const el = document.getElementById('globalLoader');
      if (el) el.style.display = 'none';
    }
  }

  // ---- Theme / layout ----
  window.toggleTheme = function () {
    const next =
      document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(STORAGE_THEME, next);
  };
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.innerHTML =
      theme === 'dark'
        ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
        : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  }
  window.toggleSidebar = function () {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebarOverlay').classList.toggle('open');
  };
  document.getElementById('sidebarOverlay')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('open');
  });

  window.logout = async function () {
    try {
      await api('/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    localStorage.removeItem(STORAGE_ADMIN);
    window.location.href = 'dev-login.html';
  };

  // ---- Navigation ----
  window.navigateTo = function (page, arg) {
    if (needsPinChange) return; // the change-PIN view owns #pageContent
    if (typeof arg !== 'string') arg = null;
    currentPage = page;
    currentArg = arg || null;
    document.querySelectorAll('.nav-item[data-page]').forEach((el) => {
      const on =
        el.dataset.page === page || (page === 'coop' && el.dataset.page === 'coops');
      el.classList.toggle('active', on);
    });
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('open');
    if (page === 'coop') currentCoopTab = 'health';
    renderPage(page, arg);
  };

  window.refreshPage = function () {
    if (needsPinChange) return; // the change-PIN view owns #pageContent
    if (currentPage === 'coop') renderCoopDetail(currentArg);
    else renderPage(currentPage, currentArg);
  };

  window.openCoop = function (id) {
    navigateTo('coop', id);
  };
  window.backToCoops = function () {
    navigateTo('coops');
  };

  function renderPage(page, arg) {
    if (needsPinChange) return; // the change-PIN view owns #pageContent
    const titles = {
      overview: 'Overview',
      coops: 'Cooperatives',
      coop: 'Cooperative',
      create: 'Create Cooperative',
      policies: 'Platform Policies',
      admins: 'Platform Admins',
    };
    setText('pageTitle', titles[page] || 'Platform Console');
    const content = document.getElementById('pageContent');
    switch (page) {
      case 'overview':
        renderOverview(content);
        break;
      case 'coops':
        renderCoops(content);
        break;
      case 'coop':
        renderCoopDetail(arg);
        break;
      case 'create':
        readOnly ? renderDenied(content) : renderCreateCoop(content);
        break;
      case 'policies':
        renderPolicies(content);
        break;
      case 'admins':
        isOwner ? renderAdmins(content) : renderDenied(content);
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
    const content = document.getElementById('pageContent');
    if (!content || content.dataset.pinChange === 'true') return;
    content.dataset.pinChange = 'true';
    setText('pageTitle', 'Change PIN');
    content.innerHTML = `
      <div class="card" style="max-width:480px;">
        <div class="card-header"><span class="card-title">Set a new PIN</span></div>
        <div class="card-body">
          <p class="text-muted">Your account is still on a temporary PIN. Set a new 6-digit PIN to continue.</p>
          <div class="form-field mt-4">
            <label>New 6-digit PIN</label>
            <input id="newPin" class="policy-input" inputmode="numeric" maxlength="6" autocomplete="off">
          </div>
          <div id="changePinResult" class="mt-4"></div>
          <div class="flex gap-2 mt-4">
            <button class="btn btn-primary" data-action="changePinSubmit">Set PIN &amp; Continue</button>
          </div>
        </div>
      </div>`;
  }

  window.changePinSubmit = async function () {
    const input = document.getElementById('newPin');
    const result = document.getElementById('changePinResult');
    const newPin = (input?.value || '').trim();
    if (!/^\d{6}$/.test(newPin)) {
      if (result) result.innerHTML = '<span class="text-red">New PIN must be exactly 6 digits.</span>';
      return;
    }
    try {
      await api('/change-pin', { method: 'POST', body: { newPin } });
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
      const data = await api('/overview');
      const t = data.totals || {};
      el.innerHTML = `
        <div class="stats-grid">
          ${statCard('indigo', 'Cooperatives', fmt(t.coopCount))}
          ${statCard('green', 'Members', fmt(t.memberCount))}
          ${statCard('gold', 'Total Savings', currency(t.savingsTotal))}
          ${statCard('purple', 'Wallet Float', currency(t.walletFloat))}
          ${statCard('blue', 'Loan Book Outstanding', currency(t.loanOutstanding))}
          ${statCard('green', 'Loan Principal', currency(t.loanPrincipal))}
          ${statCard('red', 'Overdue', currency(t.overdueAmount) + ` <span class="text-sm text-muted">(${fmt(t.overdueCount)})</span>`)}
          ${statCard('gold', 'Pending Withdrawals', fmt(t.pendingWithdrawals))}
          ${statCard('gold', 'Pending Payouts', fmt(t.pendingPayouts))}
          ${statCard('red', 'Failed Payouts', fmt(t.failedPayouts))}
          ${statCard('red', 'AML Awaiting Filing', fmt(t.pendingAmlCount))}
          ${statCard('blue', 'Active Loans', fmt(t.loanCount))}
        </div>
        <div class="card">
          <div class="card-header">
            <span class="card-title">Alerts</span>
            <span class="badge badge-${(data.alerts || []).length ? 'red' : 'green'}">${(data.alerts || []).length}</span>
          </div>
          <div class="card-body flush" id="overviewAlerts">
            ${renderAlertList(data.alerts || [])}
          </div>
        </div>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load overview</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function renderAlertList(alerts) {
    if (!alerts.length) {
      return '<div class="empty-state"><h3>No alerts</h3><p>Every cooperative looks healthy.</p></div>';
    }
    return `<div class="alert-list">${alerts
      .map(
        (a) => `<div class="alert-row">
          <span class="alert-dot ${a.severity === 'critical' ? 'critical' : 'warning'}"></span>
          <div class="alert-body">
            <div class="alert-msg">${esc(a.message)}</div>
            <div class="alert-meta">${esc(a.type)}${a.cooperativeName ? ' · ' + esc(a.cooperativeName) : ''}</div>
          </div>
          ${a.cooperativeId ? `<button class="btn btn-secondary btn-xs" data-action="openCoop" data-arg="${esc(a.cooperativeId)}">View</button>` : ''}
        </div>`,
      )
      .join('')}</div>`;
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
      const data = await api('/coops');
      coopsData = data.coops || [];
      const alerts = data.alerts || [];
      if (alerts.length) {
        el.insertAdjacentHTML(
          'afterbegin',
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
      const search = document.getElementById('coopSearch');
      search?.addEventListener('input', function () {
        const q = this.value.trim().toLowerCase();
        renderCoopsTable(
          coopsData.filter(
            (c) =>
              (c.name || '').toLowerCase().includes(q) ||
              (c.code || '').toLowerCase().includes(q),
          ),
        );
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load cooperatives</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function renderCoopsTable(coops) {
    const host = document.getElementById('coopsTable');
    if (!host) return;
    if (!coops.length) {
      host.innerHTML = '<div class="empty-state"><h3>No cooperatives</h3><p>Provision one from “Create Coop”.</p></div>';
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
                <td class="font-bold">${esc(c.name || '—')}<div class="text-muted text-sm font-mono">${esc(c.code || '')}</div></td>
                <td>${esc(c.plan || 'free')}</td>
                <td>${coopStatusBadge(c.status)}</td>
                <td class="font-mono">${fmt(c.memberCount)}</td>
                <td class="font-mono">${currency(c.savingsTotal)}</td>
                <td class="font-mono">${currency(c.loanOutstanding)}</td>
                <td class="font-mono ${c.overdueCount ? 'text-red' : ''}">${c.delinquencyPct ? c.delinquencyPct + '%' : '—'}</td>
                <td class="text-muted text-sm">${date(c.lastActivityAt)}</td>
                <td><button class="btn btn-outline btn-xs" data-action="openCoop" data-arg="${esc(c.id)}">View</button></td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>`;
  }

  // ============================================================
  //  Coop detail (tabs: Health · Activity · Rules · Admins)
  // ============================================================
  async function renderCoopDetail(id) {
    const el = document.getElementById('pageContent');
    if (!id) {
      renderDenied(el);
      return;
    }
    el.innerHTML = '<div class="card"><div class="empty-state"><p class="text-muted">Loading cooperative…</p></div></div>';
    try {
      coopDetail = await api(`/coops/${id}`);
      coopActivityEntries = [];
      try {
        const a = await api(`/coops/${id}/activity?take=25`);
        coopActivityEntries = a.entries || [];
      } catch {
        /* activity is optional */
      }
      renderCoopShell();
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load cooperative</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function renderCoopShell() {
    const el = document.getElementById('pageContent');
    if (!coopDetail) return;
    const coop = coopDetail.cooperative || {};
    setText('pageTitle', coop.name || 'Cooperative');

    el.innerHTML = `
      <div class="card mb-6">
        <div class="card-header">
          <div class="coop-heading">
            <button class="btn btn-ghost btn-sm" data-action="backToCoops">← Back</button>
            <span class="card-title">${esc(coop.name || '—')}</span>
            <span class="dev-code">${esc(coop.code || '')}</span>
            ${coopStatusBadge(coop.status)}
            <span class="badge badge-gray">${esc((coopDetail.stats || {}).plan || '—')}</span>
          </div>
          <span class="text-muted text-xs font-mono">${esc(coop.id || '')}</span>
        </div>
      </div>

      <div class="tabs">
        ${tabButton('health', 'Health')}
        ${tabButton('activity', 'Activity')}
        ${tabButton('rules', 'Rules')}
        ${tabButton('admins', 'Admins')}
      </div>
      <div id="coopTabPanel"></div>`;

    renderCoopTabPanel();
  }

  function tabButton(key, label) {
    return `<button class="tab ${currentCoopTab === key ? 'active' : ''}" data-action="coopTab" data-arg="${key}">${label}</button>`;
  }

  window.coopTab = function (key) {
    currentCoopTab = key;
    renderCoopShell();
  };

  function renderCoopTabPanel() {
    const panel = document.getElementById('coopTabPanel');
    if (!panel) return;
    if (currentCoopTab === 'activity') panel.innerHTML = renderActivityPanel();
    else if (currentCoopTab === 'rules') panel.innerHTML = renderRulesPanel();
    else if (currentCoopTab === 'admins') panel.innerHTML = renderAdminsPanel();
    else panel.innerHTML = renderHealthPanel();
  }

  function renderHealthPanel() {
    const coop = coopDetail.cooperative || {};
    const s = coopDetail.stats || {};
    const dis = readOnly ? 'disabled' : '';
    const control = readOnly
      ? '<span class="text-muted text-sm">Support role is read-only.</span>'
      : coop.status === 'suspended'
        ? `<button class="btn btn-success btn-sm" data-action="reactivateCoop" data-arg="${esc(coop.id)}">Reactivate</button>`
        : `<button class="btn btn-danger btn-sm" data-action="suspendCoop" data-arg="${esc(coop.id)}">Suspend</button>
           <button class="btn btn-secondary btn-sm" data-action="revokeSessions" data-arg="${esc(coop.id)}">Revoke sessions</button>`;
    return `
      <div class="stats-grid">
        ${statCard('indigo', 'Members', fmt(s.memberCount))}
        ${statCard('gold', 'Savings total', currency(s.savingsTotal))}
        ${statCard('purple', 'Wallet float', currency(s.walletFloat))}
        ${statCard('blue', 'Loan book', currency(s.loanOutstanding) + ` <span class="text-sm text-muted">(${fmt(s.loanCount)})</span>`)}
        ${statCard('red', 'Overdue', currency(s.overdueAmount) + ` <span class="text-sm text-muted">(${fmt(s.overdueCount)})</span>`)}
        ${statCard('green', 'Reserve fund', currency(s.reserveFundBalance))}
        ${statCard('green', 'Loan loss provision', currency(s.loanLossProvisionBalance))}
        ${statCard('gold', 'Pending withdrawals', fmt(s.pendingWithdrawals))}
        ${statCard('gold', 'Pending payouts', fmt(s.pendingPayouts))}
        ${statCard('red', 'Failed payouts', fmt(s.failedPayouts))}
        ${statCard('red', 'AML awaiting filing', fmt(s.pendingAmlCount))}
        ${statCard('blue', 'Delinquency', (s.delinquencyPct || 0) + '%')}
      </div>

      <div class="card mb-6">
        <div class="card-header"><span class="card-title">Details</span></div>
        <div class="card-body">
          <table>
            <tbody>
              <tr><td class="text-muted">Status</td><td>${coopStatusBadge(coop.status)}</td></tr>
              <tr><td class="text-muted">Plan</td><td>${esc((coopDetail.stats || {}).plan || '—')}</td></tr>
              <tr><td class="text-muted">State</td><td>${esc(coop.state || '—')}</td></tr>
              <tr><td class="text-muted">Created</td><td>${date(coop.createdAt)}</td></tr>
              <tr><td class="text-muted">Last activity</td><td>${date(s.lastActivityAt)}</td></tr>
              <tr><td class="text-muted">Members by status</td><td>${renderMembersByStatus(s.membersByStatus)}</td></tr>
              <tr><td class="text-muted">Reg. number</td><td>${esc(coop.registrationNumber || '—')}</td></tr>
              <tr><td class="text-muted">TIN</td><td>${esc(coop.tin || '—')}</td></tr>
              <tr><td class="text-muted">CVN</td><td>${esc(coop.cvn || '—')}</td></tr>
              <tr><td class="text-muted">SCUML</td><td>${esc(coop.scumlStatus || '—')}</td></tr>
              <tr><td class="text-muted">DPO</td><td>${esc([coop.dpoName, coop.dpoPhone, coop.dpoEmail].filter(Boolean).join(' · ') || '—')}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card mb-6">
        <div class="card-header"><span class="card-title">Compliance metadata</span></div>
        <div class="card-body">
          <div class="form-inline">
            <div class="form-field"><label>Registration number</label><input id="cmpReg" value="${esc(coop.registrationNumber || '')}" ${dis}></div>
            <div class="form-field"><label>TIN</label><input id="cmpTin" value="${esc(coop.tin || '')}" ${dis}></div>
            <div class="form-field"><label>CVN</label><input id="cmpCvn" value="${esc(coop.cvn || '')}" ${dis}></div>
            <div class="form-field"><label>SCUML status</label><input id="cmpScuml" value="${esc(coop.scumlStatus || '')}" ${dis}></div>
            <div class="form-field"><label>DPO name</label><input id="cmpDpoName" value="${esc(coop.dpoName || '')}" ${dis}></div>
            <div class="form-field"><label>DPO phone</label><input id="cmpDpoPhone" value="${esc(coop.dpoPhone || '')}" ${dis}></div>
            <div class="form-field"><label>DPO email</label><input id="cmpDpoEmail" value="${esc(coop.dpoEmail || '')}" ${dis}></div>
            ${readOnly ? '' : `<button class="btn btn-primary btn-sm" data-action="saveCoopCompliance" data-arg="${esc(coop.id)}">Save</button>`}
          </div>
        </div>
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
      .join(' ');
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
                  <td class="font-bold">${esc(e.action || '—')}</td>
                  <td class="text-sm">${esc(e.actorPhone || '—')}${e.actorRole ? `<div class="text-muted text-xs">${esc(e.actorRole)}</div>` : ''}</td>
                  <td class="text-sm font-mono">${e.targetType ? esc(e.targetType) : '—'}${e.targetId ? `<div class="text-muted text-xs mono-sm">${esc(e.targetId)}</div>` : ''}</td>
                  <td class="text-sm">${esc(truncate(e.detail, 80) || '—')}</td>
                  <td class="text-muted text-sm">${date(e.createdAt)}</td>
                </tr>`,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  function renderRulesPanel() {
    const config = coopDetail.config || {};
    const meta = coopDetail.meta || {};
    // Always list every effective key from the resolved config; `meta` only holds
    // platform-override keys, so it cannot drive the list once an override exists.
    const keys = Object.keys(config);
    if (!keys.length) {
      return '<div class="card"><div class="empty-state"><h3>No rules</h3><p>No effective configuration is available for this cooperative.</p></div></div>';
    }
    return `
      <div class="card">
        <div class="card-header"><span class="card-title">Effective rules</span>
          <span class="text-muted text-sm">Platform values apply unless the coop overrides an unlocked key.</span>
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
                      <td>${m.source === 'coop' ? '<span class="badge badge-blue">coop</span>' : '<span class="badge badge-gray">platform</span>'}</td>
                      <td>${m.locked ? '<span class="badge badge-red">locked</span>' : '<span class="text-muted">—</span>'}</td>
                    </tr>`;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  function renderAdminsPanel() {
    const admins = coopDetail.admins || [];
    const coopId = (coopDetail.cooperative || {}).id;
    const dis = readOnly ? 'disabled' : '';
    const table = admins.length
      ? `<div class="table-wrapper"><table>
          <thead><tr><th>Name</th><th>Phone</th><th>Role</th><th>Status</th><th>Added</th><th>Contact</th></tr></thead>
          <tbody>
            ${admins
              .map(
                (a) => `<tr>
              <td class="font-bold">${esc(a.name || '—')}<div class="text-muted text-xs font-mono">${esc(a.id)}</div></td>
              <td class="font-mono text-sm">${esc(formatPhone(a.phone))}</td>
              <td>
                <select class="toolbar-select" data-action-change="setCoopAdminRole" data-arg="${esc(a.id)}" ${dis}>
                  <option value="admin" ${a.role === 'admin' ? 'selected' : ''}>admin</option>
                  <option value="superadmin" ${a.role === 'superadmin' ? 'selected' : ''}>superadmin</option>
                </select>
              </td>
              <td>${statusBadge(a.status || 'active')}</td>
              <td class="text-muted text-sm">${date(a.createdAt)}</td>
              <td><span class="text-muted text-xs">${a.contactPhone ? esc(a.contactPhone) : ''}</span></td>
            </tr>`,
              )
              .join('')}
          </tbody>
        </table></div>`
      : '<div class="empty-state"><h3>No admins</h3><p>This cooperative has no admins yet.</p></div>';

    return `
      <div class="card mb-6">
        <div class="card-header"><span class="card-title">Coop admins</span></div>
        <div class="card-body flush">${table}</div>
      </div>
      ${readOnly ? '' : `
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
      </div>`}`;
  }

  window.addCoopAdmin = async function (coopId) {
    const phone = (document.getElementById('newAdminPhone')?.value || '').replace(/[^0-9]/g, '');
    const name = (document.getElementById('newAdminName')?.value || '').trim();
    const role = document.getElementById('newAdminRole')?.value || 'admin';
    const result = document.getElementById('newAdminResult');
    if (!phone) {
      if (result) result.innerHTML = '<span class="text-red">Enter a phone number.</span>';
      return;
    }
    const fullPhone = phone.startsWith('234') ? phone : '234' + phone;
    try {
      const res = await api(`/coops/${coopId}/admins`, {
        method: 'POST',
        body: { phone: fullPhone, name: name || undefined, role },
      });
      toast(res.created ? 'Admin created' : 'Admin promoted', 'success');
      if (result) {
        result.innerHTML = res.created && res.tempPin
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
      await api(`/coops/${coopId}/admins/${memberId}`, { method: 'PATCH', body: { role } });
      toast('Role updated', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  window.suspendCoop = async function (id) {
    if (!confirm('Suspend this cooperative? Members will be blocked from operations.')) return;
    try {
      await api(`/coops/${id}/suspend`, { method: 'POST' });
      toast('Cooperative suspended', 'success');
      renderCoopDetail(id);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  window.reactivateCoop = async function (id) {
    try {
      await api(`/coops/${id}/reactivate`, { method: 'POST' });
      toast('Cooperative reactivated', 'success');
      renderCoopDetail(id);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  window.revokeSessions = async function (id) {
    if (!confirm('Revoke all coop-admin sessions for this cooperative?')) return;
    try {
      await api(`/coops/${id}/revoke-sessions`, { method: 'POST' });
      toast('Sessions revoked', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  window.saveCoopCompliance = async function (id) {
    const val = (elId) => {
      const v = (document.getElementById(elId)?.value || '').trim();
      return v === '' ? null : v;
    };
    try {
      await api(`/coops/${id}`, {
        method: 'PATCH',
        body: {
          registrationNumber: val('cmpReg'),
          tin: val('cmpTin'),
          cvn: val('cmpCvn'),
          scumlStatus: val('cmpScuml'),
          dpoName: val('cmpDpoName'),
          dpoPhone: val('cmpDpoPhone'),
          dpoEmail: val('cmpDpoEmail'),
        },
      });
      toast('Compliance metadata saved', 'success');
      renderCoopDetail(id);
    } catch (err) {
      toast(err.message, 'error');
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
    const name = (document.getElementById('coopName')?.value || '').trim();
    const code = (document.getElementById('coopCode')?.value || '').trim().toUpperCase();
    const state = (document.getElementById('coopState')?.value || '').trim();
    const registrationNumber = (document.getElementById('coopReg')?.value || '').trim();
    const saName = (document.getElementById('saName')?.value || '').trim();
    const saPhoneRaw = (document.getElementById('saPhone')?.value || '').replace(/[^0-9]/g, '');
    const result = document.getElementById('createCoopResult');

    if (!name || !code) {
      if (result) result.innerHTML = '<span class="text-red">Name and code are required.</span>';
      return;
    }
    if (!saPhoneRaw) {
      if (result) result.innerHTML = '<span class="text-red">Super-admin phone is required.</span>';
      return;
    }
    const saPhone = saPhoneRaw.startsWith('234') ? saPhoneRaw : '234' + saPhoneRaw;

    try {
      const res = await api('/coops', {
        method: 'POST',
        body: {
          name,
          code,
          state: state || undefined,
          registrationNumber: registrationNumber || undefined,
          superAdmin: { name: saName || undefined, phone: saPhone },
        },
      });
      toast('Cooperative created', 'success');
      if (result) {
        result.innerHTML = `
          <div class="callout success"><div>
            <div>Cooperative <strong>${esc(name)}</strong> provisioned.</div>
            <div class="mt-4">Code: <span class="dev-code">${esc(res.code || code)}</span></div>
            <div class="mt-4">Super-admin phone: <span class="font-mono">${esc(formatPhone(saPhone))}</span></div>
            <div class="mt-4">Temporary PIN — share securely, it must be changed on first login:
              <div class="temp-pin" id="newCoopPin">${esc(res.tempPin || '—')}</div>
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
    el.innerHTML = '<div class="card"><div class="card-body"><div class="empty-state"><p class="text-muted">Loading policies…</p></div></div></div>';
    try {
      const data = await api('/policies');
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
            <span class="text-muted text-sm">${readOnly ? 'Support role is read-only.' : 'Values are platform-level; locked keys cannot be overridden by a coop. Blank value uses the registry default.'}</span>
          </div>
          <div class="card-body flush">
            <div class="table-wrapper">
              <table>
                <thead><tr><th>Rule</th><th>Value</th><th>Min</th><th>Max</th><th>Locked</th><th></th></tr></thead>
                <tbody>
                  ${policiesData.map(policyRow).join('')}
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
    const dis = readOnly ? 'disabled' : '';
    let valueControl;
    if (rule.type === 'bool') {
      const v = p.value === undefined ? rule.default : p.value;
      valueControl = `<select id="pol-val-${p.key}" class="toolbar-select" ${dis}>
        <option value="true" ${v === true ? 'selected' : ''}>true</option>
        <option value="false" ${v === false ? 'selected' : ''}>false</option>
      </select>`;
    } else {
      const v =
        p.value === undefined || p.value === null
          ? rule.default === undefined || rule.default === null
            ? ''
            : rule.default
          : p.value;
      valueControl = `<input id="pol-val-${p.key}" class="policy-input" value="${esc(v)}" ${dis}>`;
    }
    const unit = rule.unit ? ` <span class="text-muted text-xs">${esc(rule.unit)}</span>` : '';
    return `<tr>
      <td class="font-bold">${esc(rule.label || p.key)}
        <div class="text-muted text-xs font-mono">${esc(p.key)}</div>
        <div class="text-muted text-xs">${esc(rule.category || '')}${rule.type ? ' · ' + esc(rule.type) : ''}</div>
        <div class="text-muted text-xs">default: ${esc(rule.default === undefined ? '—' : rule.default)}</div>
      </td>
      <td>${valueControl}${unit}</td>
      <td><input id="pol-min-${p.key}" class="policy-input" value="${p.min === null || p.min === undefined ? '' : esc(p.min)}" ${dis}></td>
      <td><input id="pol-max-${p.key}" class="policy-input" value="${p.max === null || p.max === undefined ? '' : esc(p.max)}" ${dis}></td>
      <td><label class="policy-switch"><input type="checkbox" id="pol-lock-${p.key}" ${p.locked ? 'checked' : ''} ${dis}> locked</label></td>
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

    if (rule.type === 'bool') {
      body.value = valEl ? valEl.value === 'true' : undefined;
    } else if (rule.type === 'int' || rule.type === 'float' || rule.type === 'money' || rule.type === 'percent') {
      if (valEl && valEl.value !== '') {
        const n = Number(valEl.value);
        if (Number.isNaN(n)) {
          toast('Value must be a number', 'error');
          return;
        }
        body.value = n;
      }
    } else if (valEl && valEl.value !== '') {
      body.value = valEl.value;
    }

    if (minEl && minEl.value !== '') body.min = Number(minEl.value);
    if (maxEl && maxEl.value !== '') body.max = Number(maxEl.value);

    try {
      await api(`/policies/${encodeURIComponent(key)}`, { method: 'PUT', body });
      toast('Policy saved', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  // ============================================================
  //  Platform admins (owner-only)
  // ============================================================
  async function renderAdmins(el) {
    el.innerHTML = '<div class="card"><div class="card-body"><div class="empty-state"><p class="text-muted">Loading admins…</p></div></div></div>';
    try {
      const data = await api('/admins');
      const admins = data.admins || [];
      el.innerHTML = `
        <div class="card mb-6">
          <div class="card-header"><span class="card-title">Platform admins</span></div>
          <div class="card-body flush">
            ${admins.length
              ? `<div class="table-wrapper"><table>
                  <thead><tr><th>Name</th><th>Phone</th><th>Role</th><th>Status</th><th>2FA</th><th>PIN changed</th><th>Last login</th></tr></thead>
                  <tbody>
                    ${admins
                      .map(
                        (a) => `<tr>
                      <td class="font-bold">${esc(a.name || '—')}</td>
                      <td class="font-mono text-sm">${esc(formatPhone(a.phone))}</td>
                      <td>
                        <select class="toolbar-select" data-action-change="setPlatformAdminRole" data-arg="${esc(a.id)}">
                          ${['owner', 'developer', 'support']
                            .map((r) => `<option value="${r}" ${a.role === r ? 'selected' : ''}>${r}</option>`)
                            .join('')}
                        </select>
                      </td>
                      <td>${a.active ? '<span class="badge badge-green">active</span>' : '<span class="badge badge-red">disabled</span>'}</td>
                      <td>${a.totpEnabled ? '<span class="badge badge-blue">on</span>' : '<span class="text-muted">—</span>'}</td>
                      <td>${a.mustChangePin ? '<span class="badge badge-gold">pending</span>' : '<span class="text-muted">done</span>'}</td>
                      <td class="text-muted text-sm">${date(a.lastLoginAt)}</td>
                      <td>
                        <button class="btn ${a.active ? 'btn-danger' : 'btn-success'} btn-xs" data-action="togglePlatformAdminActive" data-arg="${esc(a.id)}" data-active="${a.active}">${a.active ? 'Disable' : 'Enable'}</button>
                      </td>
                    </tr>`,
                      )
                      .join('')}
                  </tbody>
                </table></div>`
              : '<div class="empty-state"><h3>No platform admins</h3></div>'}
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
    const name = (document.getElementById('paName')?.value || '').trim();
    const phoneRaw = (document.getElementById('paPhone')?.value || '').replace(/[^0-9]/g, '');
    const role = document.getElementById('paRole')?.value || 'developer';
    const result = document.getElementById('paResult');
    if (!name || !phoneRaw) {
      if (result) result.innerHTML = '<span class="text-red">Name and phone are required.</span>';
      return;
    }
    const phone = phoneRaw.startsWith('234') ? phoneRaw : '234' + phoneRaw;
    try {
      const res = await api('/admins', { method: 'POST', body: { name, phone, role } });
      toast('Platform admin created', 'success');
      if (result) {
        result.innerHTML = `<div class="callout success"><div>
          Created <strong>${esc(name)}</strong> (${esc(role)}). Temporary PIN — share securely:
          <div class="temp-pin" id="newPaPin">${esc(res.tempPin || '—')}</div>
          <button class="btn btn-secondary btn-xs mt-4" data-action="copyText" data-arg="newPaPin">Copy PIN</button>
        </div></div>`;
      }
      renderAdmins(document.getElementById('pageContent'));
    } catch (err) {
      if (result) result.innerHTML = `<span class="text-red">${esc(err.message)}</span>`;
    }
  };

  window.setPlatformAdminRole = async function (id, _event, el) {
    try {
      await api(`/admins/${id}`, { method: 'PATCH', body: { role: el.value } });
      toast('Role updated', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  window.togglePlatformAdminActive = async function (id, _event, el) {
    const active = el.dataset.active !== 'true';
    try {
      await api(`/admins/${id}`, { method: 'PATCH', body: { active } });
      toast(active ? 'Admin enabled' : 'Admin disabled', 'success');
      renderAdmins(document.getElementById('pageContent'));
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  window.copyText = function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    const text = el.value || el.textContent || '';
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast('Copied', 'success'),
        () => toast('Copy failed', 'error'),
      );
    } else {
      toast('Clipboard unavailable', 'error');
    }
  };

  // ============================================================
  //  Helpers
  // ============================================================
  function statCard(tone, label, value) {
    return `<div class="stat-card stat-${esc(tone || 'indigo')}">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${value}</div>
    </div>`;
  }

  function skeletonCards(n) {
    return Array.from(
      { length: n },
      () =>
        '<div class="stat-card"><div class="skeleton" style="height:14px;width:80px;margin-bottom:12px;"></div><div class="skeleton" style="height:28px;width:120px;"></div></div>',
    ).join('');
  }

  function coopStatusBadge(status) {
    const s = status || 'unknown';
    if (s === 'active') return '<span class="badge badge-green"><span class="status-dot green"></span>active</span>';
    if (s === 'suspended') return '<span class="badge badge-red"><span class="status-dot red"></span>suspended</span>';
    return `<span class="badge badge-gray"><span class="status-dot gray"></span>${esc(s)}</span>`;
  }

  function statusBadge(status) {
    const s = status || 'unknown';
    if (s === 'active') return '<span class="badge badge-green">active</span>';
    if (s === 'suspended' || s === 'inactive') return '<span class="badge badge-red">' + esc(s) + '</span>';
    return `<span class="badge badge-gray">${esc(s)}</span>`;
  }

  function roleLabel(role) {
    return { owner: 'Owner', developer: 'Developer', support: 'Support' }[role] || role || '—';
  }

  function formatRuleValue(value, rule) {
    if (value === undefined || value === null) {
      return '<span class="text-muted">—</span>';
    }
    if (rule && rule.type === 'bool') return value ? 'true' : 'false';
    if (rule && rule.type === 'money') return currency(value);
    let out = esc(value);
    if (rule && rule.unit) out += ` <span class="text-muted text-xs">${esc(rule.unit)}</span>`;
    return out;
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString('en-NG');
  }

  // Money fields are integer kobo -> display as naira with 2 dp.
  function currency(n) {
    const naira = (Number(n) || 0) / 100;
    return '₦' + naira.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function date(str) {
    if (!str) return '—';
    const d = new Date(str);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatPhone(p) {
    if (!p) return '';
    const clean = String(p).replace(/[^0-9]/g, '');
    if (clean.length > 10) {
      return '+' + clean.slice(0, 3) + ' ' + clean.slice(3, 7) + ' ' + clean.slice(7);
    }
    return clean;
  }

  function truncate(str, max) {
    if (!str) return '';
    const s = String(str);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function toast(msg, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }
})();
