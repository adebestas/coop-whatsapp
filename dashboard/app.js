/* ============================================================
   Coop Admin Dashboard — App Logic
   ============================================================ */

(function () {
  'use strict';

  // ---- Config ----
  const API_BASE = '/api/admin';
  const STORAGE_TOKEN = 'coop_token'; // NOTE: In production, use httpOnly cookies instead of localStorage for JWT storage
  const STORAGE_MEMBER = 'coop_member';
  const STORAGE_THEME = 'coop_theme';

  // ---- State ----
  let currentPage = 'dashboard';
  let overviewData = null;
  let membersData = [];
  let loansData = [];
  let contributionsData = [];
  let payoutsData = [];
  let charts = {};

  // ---- Init ----
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    if (!getToken()) {
      window.location.href = 'login.html';
      return;
    }
    loadUserInfo();
    applyTheme(localStorage.getItem(STORAGE_THEME) || 'light');
    navigateTo('dashboard');
  }

  // ---- Auth ----
  function getToken() {
    return localStorage.getItem(STORAGE_TOKEN);
  }

  function getMember() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_MEMBER));
    } catch {
      return null;
    }
  }

  function getMemberRole() {
    return getMember()?.role || null;
  }

  function isSuperAdmin() {
    return getMemberRole() === 'superadmin';
  }

  function loadUserInfo() {
    const member = getMember();
    if (!member) return;
    document.getElementById('userName').textContent = member.name || 'Admin';
    document.getElementById('userAvatar').textContent = (member.name || 'A').charAt(0).toUpperCase();
    document.getElementById('coopName').textContent = member.cooperative?.name || 'Cooperative';
    const roleText = member.role === 'superadmin' ? 'Super Admin' : member.role === 'admin' ? 'Administrator' : 'Member';
    const roleEl = document.querySelector('.user-role');
    if (roleEl) roleEl.textContent = roleText;
    const navElections = document.getElementById('navElections');
    if (navElections) navElections.hidden = !isSuperAdmin();
    const navPosts = document.getElementById('navPosts');
    if (navPosts) navPosts.hidden = !isSuperAdmin();
    const navPayroll = document.getElementById('navPayroll');
    if (navPayroll) navPayroll.hidden = !isSuperAdmin();
    const navFunds = document.getElementById('navFunds');
    if (navFunds) navFunds.hidden = !isSuperAdmin();
  }

  window.logout = async function () {
    try {
      await api('/logout', { method: 'POST' });
    } catch { /* ignore */ }
    localStorage.removeItem(STORAGE_TOKEN);
    localStorage.removeItem(STORAGE_MEMBER);
    window.location.href = 'login.html';
  };

  // ---- API helper ----
  async function api(path, opts = {}) {
    const token = getToken();
    const headers = { ...(opts.headers || {}) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
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
      const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
      if (res.status === 401) {
        localStorage.removeItem(STORAGE_TOKEN);
        localStorage.removeItem(STORAGE_MEMBER);
        window.location.href = 'login.html';
        throw new Error('Unauthorized');
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    } finally {
      hideLoader();
    }
  }

  // ---- Theme ----
  window.toggleTheme = function () {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(STORAGE_THEME, next);
  };

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    updateThemeIcon(theme);
  }

  function updateThemeIcon(theme) {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.innerHTML = theme === 'dark'
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  }

  // ---- Sidebar / Mobile ----
  window.toggleSidebar = function () {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebarOverlay').classList.toggle('open');
  };

  document.getElementById('sidebarOverlay')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('open');
  });

  // ---- Navigation ----
  window.navigateTo = function (page) {
    currentPage = page;
    // Update nav active states
    document.querySelectorAll('.nav-item, .bottom-nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.page === page);
    });
    // Close mobile sidebar
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('open');
    // Render
    renderPage(page);
  };

  function renderPage(page) {
    const content = document.getElementById('pageContent');
    const titles = {
      dashboard: 'Dashboard',
      members: 'Members',
      loans: 'Loans',
      contributions: 'Contributions',
      payouts: 'Payouts',
      withdrawals: 'Withdrawals',
      polls: 'Buy Polls',
      elections: 'Elections',
      grievances: 'Grievances',
      tickets: 'Support Tickets',
      posts: 'Executive Posts',
      payroll: 'Payroll',
      funds: 'Funds / Reserves',
      reports: 'Annual Report',
      str: 'STR / AML',
      paye: 'PAYE'
    };
    document.getElementById('pageTitle').textContent = titles[page] || 'Dashboard';

    // Destroy old charts
    Object.values(charts).forEach(c => c.destroy());
    charts = {};

    switch (page) {
      case 'dashboard': renderDashboard(content); break;
      case 'members': renderMembers(content); break;
      case 'loans': renderLoans(content); break;
      case 'contributions': renderContributions(content); break;
      case 'payouts': renderPayouts(content); break;
      case 'withdrawals': renderWithdrawals(content); break;
      case 'polls': renderPolls(content); break;
      case 'elections': renderElections(content); break;
      case 'grievances': renderGrievances(content); break;
      case 'tickets': renderTickets(content); break;
      case 'posts': renderPosts(content); break;
      case 'payroll': renderPayroll(content); break;
      case 'funds': renderFunds(content); break;
      case 'reports': renderReports(content); break;
      case 'str': renderSTR(content); break;
      case 'paye': renderPAYE(content); break;
      default: renderDashboard(content);
    }
  }

  // ---- Dashboard ----
  async function renderDashboard(el) {
    el.innerHTML = `
      <div class="stats-grid" id="statsGrid">
        ${skeletonCards(4)}
      </div>
      <div class="chart-grid" style="display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin-bottom:24px;">
        <div class="card" style="grid-column: span 1;">
          <div class="card-header"><span class="card-title">Savings Trend</span></div>
          <div class="card-body"><div class="chart-container"><canvas id="savingsChart"></canvas></div></div>
        </div>
        <div class="card" style="grid-column: span 1;">
          <div class="card-header"><span class="card-title">Loan Status</span></div>
          <div class="card-body"><div class="chart-container"><canvas id="loanChart"></canvas></div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">Recent Contributions</span>
          <button class="btn btn-secondary btn-sm" onclick="navigateTo('contributions')">View All</button>
        </div>
        <div class="card-body flush" id="recentContributions">
          <div class="empty-state"><p class="text-muted">Loading...</p></div>
        </div>
      </div>
    `;

    try {
      const [overview, contributions, loans] = await Promise.all([
        api('/overview'),
        api('/contributions'),
        api('/loans')
      ]);
      overviewData = overview;
      contributionsData = contributions;
      loansData = loans;

      // Stats
      document.getElementById('statsGrid').innerHTML = `
        <div class="stat-card">
          <div class="stat-icon green">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <div class="stat-label">Total Members</div>
          <div class="stat-value">${fmt(overview.memberCount)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon gold">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>
          </div>
          <div class="stat-label">Total Saved</div>
          <div class="stat-value">${currency(overview.totalSaved)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon blue">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          </div>
          <div class="stat-label">Active Loans</div>
          <div class="stat-value">${fmt(overview.activeLoans)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon purple">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
          </div>
          <div class="stat-label">Wallet Balance</div>
          <div class="stat-value">${currency(overview.walletBalance)}</div>
        </div>
      `;

      // Pending loans badge
      const pendingCount = loans.filter(l => l.status === 'pending' || l.status === 'guaranteed').length;
      const badge = document.getElementById('pendingLoansBadge');
      if (pendingCount > 0) {
        badge.textContent = pendingCount;
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }

      // Savings chart
      renderSavingsChart(contributions);

      // Loan chart
      renderLoanChart(loans);

      // Recent contributions table
      renderRecentContributions(contributionsData.slice(0, 5));

    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load dashboard</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function renderSavingsChart(contributions) {
    const ctx = document.getElementById('savingsChart');
    if (!ctx) return;

    // Group by month
    const monthly = {};
    contributions.filter(c => c.status === 'confirmed').forEach(c => {
      const d = new Date(c.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthly[key] = (monthly[key] || 0) + c.amount;
    });

    const labels = Object.keys(monthly).sort().slice(-6);
    const values = labels.map(k => monthly[k]);

    charts.savings = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels.map(l => {
          const [y, m] = l.split('-');
          return new Date(y, m - 1).toLocaleDateString('en-NG', { month: 'short' });
        }),
        datasets: [{
          label: 'Savings',
          data: values,
          backgroundColor: 'rgba(0, 135, 81, 0.7)',
          borderColor: '#008751',
          borderWidth: 1,
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { callback: v => '₦' + fmtNum(v / 100) } },
          x: { grid: { display: false } }
        }
      }
    });
  }

  function renderLoanChart(loans) {
    const ctx = document.getElementById('loanChart');
    if (!ctx) return;

    const statusCounts = {};
    loans.forEach(l => {
      statusCounts[l.status] = (statusCounts[l.status] || 0) + 1;
    });

    const statusColors = {
      pending: '#F59E0B',
      guaranteed: '#3B82F6',
      approved: '#22C55E',
      disbursed: '#8B5CF6',
      repaid: '#6B7280',
      rejected: '#EF4444',
      defaulted: '#DC2626'
    };

    const labels = Object.keys(statusCounts);
    const values = Object.values(statusCounts);
    const colors = labels.map(s => statusColors[s] || '#94A3B8');

    charts.loans = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels.map(s => s.charAt(0).toUpperCase() + s.slice(1)),
        datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { padding: 12, usePointStyle: true, pointStyle: 'circle' } }
        },
        cutout: '65%'
      }
    });
  }

  function renderRecentContributions(items) {
    const el = document.getElementById('recentContributions');
    if (!items.length) {
      el.innerHTML = '<div class="empty-state"><h3>No contributions yet</h3><p>Contributions will appear here.</p></div>';
      return;
    }
    el.innerHTML = `
      <div class="table-wrapper">
        <table>
          <thead><tr>
            <th>Member</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Date</th>
          </tr></thead>
          <tbody>
            ${items.map(c => `<tr>
              <td>${esc(c.member?.name || '—')}</td>
              <td class="font-mono">${currency(c.amount)}</td>
              <td>${statusBadge(c.status)}</td>
              <td class="text-muted text-sm">${date(c.createdAt)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // ---- Members ----
  async function renderMembers(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">All Members</span>
          <div class="flex gap-2">
            <input type="search" id="memberSearch" placeholder="Search members..." style="padding:8px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:0.8125rem; background:var(--bg-card); color:var(--text); width:200px;">
            <button class="btn btn-secondary" onclick="document.getElementById('importFileInput').click()">Import CSV/Excel</button>
            <input type="file" id="importFileInput" accept=".csv,.xlsx,.xls" style="display:none;" onchange="importMembers(this)">
            <button class="btn btn-primary" onclick="openMessageModal()">Send Message</button>
          </div>
        </div>
        <div class="card-body flush" id="membersTable">
          <div class="empty-state"><p class="text-muted">Loading members...</p></div>
        </div>
      </div>
      <div id="messageModalHost"></div>`;

    try {
      membersData = await api('/members');
      renderMembersTable(membersData);
      document.getElementById('memberSearch').addEventListener('input', function () {
        const q = this.value.toLowerCase();
        const filtered = membersData.filter(m =>
          (m.name || '').toLowerCase().includes(q) ||
          (m.phone || '').includes(q)
        );
        renderMembersTable(filtered);
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load members</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function renderMembersTable(members) {
    const el = document.getElementById('membersTable');
    if (!members.length) {
      el.innerHTML = '<div class="empty-state"><h3>No members found</h3></div>';
      return;
    }
    el.innerHTML = `
      <div class="table-wrapper">
        <table>
          <thead><tr>
            <th style="width:36px;"></th>
            <th>Name</th>
            <th>File No / Code</th>
            <th>Phone</th>
            <th>Role</th>
            <th>Balance</th>
            <th>Total Saved</th>
            <th>Joined</th>
            <th></th>
          </tr></thead>
          <tbody>
            ${members.map(m => `<tr>
              <td><input type="checkbox" class="member-select" value="${esc(m.id)}" data-name="${esc(m.name || '')}"></td>
              <td class="font-bold">${esc(m.name || '—')}</td>
              <td class="font-mono text-sm">${esc(m.code || '—')}</td>
              <td class="font-mono text-sm">${esc(formatPhone(m.phone))}</td>
              <td>${roleBadge(m.role)}</td>
              <td class="font-mono">${currency(m.wallet?.balance || 0)}</td>
              <td class="font-mono">${currency(m.wallet?.totalSaved || 0)}</td>
              <td class="text-muted text-sm">${date(m.createdAt)}</td>
              <td><button class="btn btn-outline btn-xs" onclick="openMessageModal('${esc(m.id)}')">Message</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // ---- Message Members ----
  window.openMessageModal = function (preselectId) {
    const host = document.getElementById('messageModalHost');
    if (!host) return;
    const members = Array.isArray(membersData) ? membersData : [];
    const checkboxes = members.map(m => `
      <label class="msg-member">
        <input type="checkbox" value="${esc(m.id)}" ${m.id === preselectId ? 'checked' : ''}>
        <span class="msg-member-name">${esc(m.name || '—')}</span>
        <span class="msg-member-code">${esc(m.code || '')}</span>
      </label>`).join('');

    host.innerHTML = `
      <div class="modal-overlay" onclick="if(event.target===this)closeMessageModal()">
        <div class="modal modal-lg" role="dialog" aria-modal="true">
          <div class="modal-header">
            <span class="card-title">Message Members</span>
            <button class="btn btn-ghost btn-xs" onclick="closeMessageModal()">&times;</button>
          </div>
          <div class="modal-body">
            <label class="msg-broadcast"><input type="checkbox" id="msgToAll" onchange="toggleMsgAll()"> <strong>Broadcast to all active members</strong></label>
            <div id="msgMemberList" class="msg-member-list">
              <div class="msg-select-all"><label><input type="checkbox" id="msgCheckAll" onchange="toggleMsgCheckAll()"> Select all</label></div>
              ${checkboxes}
            </div>
            <div class="form-group" style="margin-top:14px;">
              <label for="msgSubject">Subject (optional)</label>
              <input type="text" id="msgSubject" placeholder="e.g. Annual General Meeting" style="width:100%; padding:10px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--bg-card); color:var(--text);">
            </div>
            <div class="form-group">
              <label for="msgBody">Message *</label>
              <textarea id="msgBody" rows="5" maxlength="3500" placeholder="Type your message here..." style="width:100%; padding:10px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--bg-card); color:var(--text); resize:vertical;"><\/textarea>
            </div>
            <div id="msgResult" class="text-muted text-sm" style="margin-top:8px;"></div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" onclick="closeMessageModal()">Cancel</button>
            <button class="btn btn-primary" id="msgSendBtn" onclick="sendMessage()">Send</button>
          </div>
        </div>
      </div>`;
    if (preselectId) {
      const all = document.getElementById('msgToAll');
      if (all) all.checked = false;
      toggleMsgAll();
    }
  };

  window.toggleMsgAll = function () {
    const all = document.getElementById('msgToAll');
    const list = document.getElementById('msgMemberList');
    if (list) list.style.display = all && all.checked ? 'none' : '';
    const checkAll = document.getElementById('msgCheckAll');
    if (checkAll) checkAll.checked = false;
    document.querySelectorAll('#msgMemberList .msg-member input[type=checkbox]').forEach(b => b.checked = false);
  };

  window.toggleMsgCheckAll = function () {
    const c = document.getElementById('msgCheckAll');
    document.querySelectorAll('#msgMemberList .msg-member input[type=checkbox]').forEach(b => b.checked = c.checked);
  };

  window.closeMessageModal = function () {
    const host = document.getElementById('messageModalHost');
    if (host) host.innerHTML = '';
  };

  window.sendMessage = async function () {
    const toAll = document.getElementById('msgToAll').checked;
    const subject = document.getElementById('msgSubject').value.trim();
    const body = document.getElementById('msgBody').value.trim();
    const result = document.getElementById('msgResult');

    let memberIds = [];
    if (!toAll) {
      memberIds = Array.from(document.querySelectorAll('#msgMemberList .msg-member input[type=checkbox]:checked')).map(c => c.value);
    }
    if (!body) { result.textContent = 'Please enter a message body.'; result.style.color = 'var(--danger)'; return; }
    if (!toAll && memberIds.length === 0) { result.textContent = 'Select at least one member or enable broadcast.'; result.style.color = 'var(--danger)'; return; }

    const btn = document.getElementById('msgSendBtn');
    btn.disabled = true;
    btn.textContent = 'Sending...';
    result.textContent = '';
    try {
      const res = await api('/messages/send', {
        method: 'POST',
        body: { memberIds, toAll, subject, body },
      });
      result.style.color = '';
      result.innerHTML = `Sent to <strong>${esc(String(res.sent))}</strong> of ${esc(String(res.targeted))} targeted member(s). ` +
        (res.skipped ? `${esc(String(res.skipped))} skipped (opted out). ` : '') +
        (res.failed ? `<span style="color:var(--danger)">${esc(String(res.failed))} failed${res.failures && res.failures.length ? ': ' + esc(res.failures.join(', ')) : ''}.</span>` : '');
      if (res.sent > 0) toast(`Message sent to ${res.sent} member(s)`, 'success');
    } catch (err) {
      result.textContent = err.message;
      result.style.color = 'var(--danger)';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send';
    }
  };

  // ---- Bulk Import Members ----
  window.importMembers = async function (input) {
    const file = input.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext !== 'csv' && ext !== 'xlsx' && ext !== 'xls') {
      toast('Please select a .csv or .xlsx file', 'error');
      input.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast('File too large (max 5MB)', 'error');
      input.value = '';
      return;
    }
    toast('Importing members...', 'info');
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          const base64 = typeof result === 'string' ? result.split(',')[1] : '';
          resolve(base64);
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
      const result = await api('/members/import', {
        method: 'POST',
        body: { filename: file.name, data: base64 },
      });
      if (result.ok) {
        toast(result.message, 'success');
        renderMembers(document.getElementById('pageContent'));
      } else {
        const errText = (result.errors || []).slice(0, 3).join('; ');
        toast(result.message + (errText ? ' — ' + errText : ''), 'error');
      }
    } catch (err) {
      toast(err.message || 'Import failed', 'error');
    } finally {
      input.value = '';
    }
  };

  // ---- Loans ----
  async function renderLoans(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Loans</span>
          <div class="flex gap-2">
            <select id="loanFilter" style="padding:8px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:0.8125rem; background:var(--bg-card); color:var(--text);">
              <option value="">All Status</option>
              <option value="pending">Pending</option>
              <option value="guaranteed">Guaranteed</option>
              <option value="approved">Approved</option>
              <option value="disbursed">Disbursed</option>
              <option value="repaid">Repaid</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
        </div>
        <div class="card-body flush" id="loansTable">
          <div class="empty-state"><p class="text-muted">Loading loans...</p></div>
        </div>
      </div>`;

    document.getElementById('loanFilter').addEventListener('change', async function () {
      const status = this.value;
      const el2 = document.getElementById('loansTable');
      el2.innerHTML = '<div class="empty-state"><p class="text-muted">Loading...</p></div>';
      try {
        loansData = await api('/loans' + (status ? `?status=${status}` : ''));
        renderLoansTable(loansData);
      } catch (err) {
        el2.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${esc(err.message)}</p></div>`;
      }
    });

    try {
      loansData = await api('/loans');
      renderLoansTable(loansData);
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load loans</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function renderLoansTable(loans) {
    const el = document.getElementById('loansTable');
    if (!loans.length) {
      el.innerHTML = '<div class="empty-state"><h3>No loans found</h3></div>';
      return;
    }
    el.innerHTML = `
      <div class="table-wrapper">
        <table>
          <thead><tr>
            <th>Member</th>
            <th>Amount</th>
            <th>Rate</th>
            <th>Tenure</th>
            <th>Status</th>
            <th>Guarantors</th>
            <th>Actions</th>
          </tr></thead>
          <tbody>
            ${loans.map(l => `<tr>
              <td class="font-bold">${esc(l.member?.name || '—')}</td>
              <td class="font-mono">${currency(l.amount)}</td>
              <td class="font-mono">${l.interestRate}%</td>
              <td>${l.tenureMonths} mo</td>
              <td>${statusBadge(l.status)}</td>
              <td class="text-sm">${(l.guarantors || []).map(g => esc(g.member?.name || '?')).join(', ') || '—'}</td>
              <td>
                <div class="loan-actions">
                  ${l.status === 'guaranteed' ? `<button class="btn btn-success btn-xs" onclick="approveLoan('${l.id}')">Approve</button>` : ''}
                  ${l.status === 'pending' ? `<button class="btn btn-danger btn-xs" onclick="rejectLoan('${l.id}')">Reject</button>` : ''}
                </div>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  window.approveLoan = async function (id) {
    if (!confirm('Approve this loan?')) return;
    try {
      await api(`/loans/${id}/approve`, { method: 'POST' });
      toast('Loan approved', 'success');
      renderPage('loans');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  window.rejectLoan = async function (id) {
    if (!confirm('Reject this loan?')) return;
    try {
      await api(`/loans/${id}/reject`, { method: 'POST' });
      toast('Loan rejected', 'success');
      renderPage('loans');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  // ---- Contributions ----
  async function renderContributions(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">All Contributions</span>
        </div>
        <div class="card-body flush" id="contributionsTable">
          <div class="empty-state"><p class="text-muted">Loading contributions...</p></div>
        </div>
      </div>`;

    try {
      contributionsData = await api('/contributions');
      renderContributionsTable(contributionsData);
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load contributions</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function renderContributionsTable(items) {
    const el = document.getElementById('contributionsTable');
    if (!items.length) {
      el.innerHTML = '<div class="empty-state"><h3>No contributions yet</h3></div>';
      return;
    }
    el.innerHTML = `
      <div class="table-wrapper">
        <table>
          <thead><tr>
            <th>Member</th>
            <th>Amount</th>
            <th>Reference</th>
            <th>Status</th>
            <th>Date</th>
          </tr></thead>
          <tbody>
            ${items.map(c => `<tr>
              <td class="font-bold">${esc(c.member?.name || '—')}</td>
              <td class="font-mono">${currency(c.amount)}</td>
              <td class="text-sm font-mono">${esc(c.reference || '—')}</td>
              <td>${statusBadge(c.status)}</td>
              <td class="text-muted text-sm">${date(c.createdAt)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // ---- Payouts ----
  async function renderPayouts(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Payout History</span>
        </div>
        <div class="card-body flush" id="payoutsTable">
          <div class="empty-state"><p class="text-muted">Loading payouts...</p></div>
        </div>
      </div>`;

    try {
      payoutsData = await api('/payouts');
      renderPayoutsTable(payoutsData);
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load payouts</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function renderPayoutsTable(items) {
    const el = document.getElementById('payoutsTable');
    if (!items.length) {
      el.innerHTML = '<div class="empty-state"><h3>No payouts yet</h3></div>';
      return;
    }
    el.innerHTML = `
      <div class="table-wrapper">
        <table>
          <thead><tr>
            <th>Member</th>
            <th>Amount</th>
            <th>Type</th>
            <th>Status</th>
            <th>Date</th>
          </tr></thead>
          <tbody>
            ${items.map(p => `<tr>
              <td class="font-bold">${esc(p.member?.name || '—')}</td>
              <td class="font-mono">${currency(p.amount)}</td>
              <td class="text-sm">${esc(p.type || '—')}</td>
              <td>${statusBadge(p.status || 'completed')}</td>
              <td class="text-muted text-sm">${date(p.createdAt)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // ---- Reports ----
  async function renderReports(el) {
    const year = new Date().getFullYear();
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Annual Report</span>
          <div class="flex gap-2">
            <select id="reportYear" style="padding:8px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:0.8125rem; background:var(--bg-card); color:var(--text);">
              ${Array.from({ length: 5 }, (_, i) => year - i).map(y => `<option value="${y}" ${y === year ? 'selected' : ''}>${y}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="card-body" id="reportContent">
          <div class="empty-state"><p class="text-muted">Select a year to generate report.</p></div>
        </div>
      </div>`;

    document.getElementById('reportYear').addEventListener('change', function () {
      loadReport(this.value);
    });

    loadReport(year);
  }

  async function loadReport(year) {
    const el = document.getElementById('reportContent');
    el.innerHTML = '<div class="empty-state"><p class="text-muted">Generating report...</p></div>';
    try {
      const report = await api(`/annualreport/${year}`);
      el.innerHTML = `
        <div class="stats-grid" style="margin-bottom:24px;">
          <div class="stat-card">
            <div class="stat-label">Total Members</div>
            <div class="stat-value">${fmt(report.memberCount || 0)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Total Contributions</div>
            <div class="stat-value">${currency(report.totalContributions || 0)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Total Loans Issued</div>
            <div class="stat-value">${currency(report.totalLoans || 0)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Total Repayments</div>
            <div class="stat-value">${currency(report.totalRepayments || 0)}</div>
          </div>
        </div>
        ${report.funds ? `
        <h3 class="card-title mb-4">Fund Balances</h3>
        <div class="stats-grid" style="margin-bottom:24px;">
          <div class="stat-card">
            <div class="stat-label">Reserve Fund</div>
            <div class="stat-value">${currency(report.funds.reserve || 0)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Education Fund</div>
            <div class="stat-value">${currency(report.funds.education || 0)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Development Fund</div>
            <div class="stat-value">${currency(report.funds.development || 0)}</div>
          </div>
        </div>` : ''}
        ${report.dividends ? `
        <h3 class="card-title mb-4">Dividends</h3>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Total Dividends</div>
            <div class="stat-value">${currency(report.dividends.total || 0)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Per Member</div>
            <div class="stat-value">${currency(report.dividends.perMember || 0)}</div>
          </div>
        </div>` : ''}
      `;
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load report</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  // ---- Withdrawals ----
  async function renderWithdrawals(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Withdrawal Requests</span>
        </div>
        <div class="card-body flush" id="withdrawalsTable">
          <div class="empty-state"><p class="text-muted">Loading withdrawals...</p></div>
        </div>
      </div>`;

    try {
      const items = await api('/withdrawals');
      const table = document.getElementById('withdrawalsTable');
      if (!items.length) {
        table.innerHTML = '<div class="empty-state"><h3>No withdrawal requests</h3></div>';
        return;
      }
      table.innerHTML = `
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Member</th><th>Amount</th><th>Status</th><th>Requested</th></tr></thead>
            <tbody>
              ${items.map(w => `<tr>
                <td class="font-bold">${esc(w.member?.name || '—')}<div class="text-muted text-sm">${esc(formatPhone(w.member?.phone))}</div></td>
                <td class="font-mono">${currency(w.amount)}</td>
                <td>${statusBadge(w.status)}</td>
                <td class="text-muted text-sm">${date(w.createdAt)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load withdrawals</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  // ---- Buy Polls ----
  async function renderPolls(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Buy Polls</span>
        </div>
        <div class="card-body" id="pollsContent">
          <div class="empty-state"><p class="text-muted">Loading polls...</p></div>
        </div>
      </div>`;

    try {
      const polls = await api('/polls');
      const content = document.getElementById('pollsContent');
      if (!polls.length) {
        content.innerHTML = '<div class="empty-state"><h3>No buy polls yet</h3><p class="text-muted">Admins create polls via WhatsApp: <code>startbuyvote &lt;title&gt;</code></p></div>';
        return;
      }
      content.innerHTML = polls.map(p => `
        <div class="card" style="margin-bottom:16px;">
          <div class="card-header">
            <span class="card-title">${esc(p.title)}</span>
            ${statusBadge(p.status)}
          </div>
          <div class="card-body">
            <p class="text-muted text-sm" style="margin-bottom:12px;">Created ${date(p.createdAt)} by ${esc(p.creator?.name || '—')}</p>
            <table>
              <thead><tr><th>#</th><th>Item</th><th>Est. Cost</th><th>Votes</th></tr></thead>
              <tbody>
                ${(p.options || []).map((o, i) => `<tr>
                  <td>${i + 1}</td>
                  <td>${esc(o.name)}</td>
                  <td class="font-mono">${currency(o.estimatedCost)}</td>
                  <td>${o._count?.ballots ?? 0}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>`).join('');
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load polls</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  // ---- Elections ----
  async function renderElections(el) {
    if (!isSuperAdmin()) {
      el.innerHTML = '<div class="empty-state"><h3>Access denied</h3><p class="text-muted">Only the super admin can manage elections.</p></div>';
      return;
    }
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Elections</span>
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('newElectionCard').hidden = false">New Election</button>
        </div>
        <div class="card-body" id="electionsContent">
          <div class="empty-state"><p class="text-muted">Loading elections...</p></div>
        </div>
      </div>

      <div class="card" id="newElectionCard" hidden>
        <div class="card-header">
          <span class="card-title">Start a new election</span>
        </div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:10px;">
          <label class="text-sm text-muted">Election type
            <select id="electionKind" style="padding:8px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:0.8125rem; background:var(--bg-card); color:var(--text); width:100%;">
              <option value="exec">Executive / Cooperative-wide</option>
              <option value="unit">Workplace (per unit)</option>
            </select>
          </label>
          <label class="text-sm text-muted">Unit code (only for workplace elections, e.g. LAG01)
            <input id="electionUnit" style="padding:8px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:0.8125rem; background:var(--bg-card); color:var(--text); width:100%;" placeholder="Optional">
          </label>
          <label class="text-sm text-muted">Title
            <input id="electionTitle" style="padding:8px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:0.8125rem; background:var(--bg-card); color:var(--text); width:100%;" placeholder="e.g. 2026 Executive Committee Election">
          </label>
          <div class="flex gap-2">
            <button class="btn btn-primary btn-sm" onclick="startElection()">Start Election</button>
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('newElectionCard').hidden = true">Cancel</button>
          </div>
        </div>
      </div>`;

    try {
      const votes = await api('/votes');
      const content = document.getElementById('electionsContent');
      if (!votes.length) {
        content.innerHTML = '<div class="empty-state"><h3>No elections yet</h3><p class="text-muted">Start one above. Members vote in WhatsApp/Telegram with: <code>vote &lt;election id&gt; &lt;candidate code&gt;</code></p></div>';
        return;
      }
      content.innerHTML = votes.map(v => `
        <div class="card" style="margin-bottom:16px;">
          <div class="card-header">
            <span class="card-title">${esc(v.title)}</span>
            ${electionStatusBadge(v.status)}
          </div>
          <div class="card-body">
            <p class="text-muted text-sm" style="margin-bottom:8px;">
              ${esc(v.electionType)}${v.position ? ' — ' + esc(v.position) : ''} · Total votes: ${v._count?.ballots ?? 0} · Quorum: ${v.quorumRequired}% · Started ${date(v.createdAt)} ${v.closedAt ? '· Closed ' + date(v.closedAt) : ''}
            </p>
            <table>
              <thead><tr><th>Candidate</th><th>Code</th><th>Votes</th></tr></thead>
              <tbody>
                ${(v.candidates || []).map(c => `<tr>
                  <td>${esc(c.member?.name || '—')}</td>
                  <td class="font-mono">${esc(c.member?.code || '—')}</td>
                  <td>${c._count?.ballots ?? 0}</td>
                </tr>`).join('')}
              </tbody>
            </table>
            <div class="flex gap-2" style="margin-top:12px;">
              ${v.status === 'open' ? `
                <button class="btn btn-secondary btn-sm" onclick="addElectionCandidate('${v.id}')">Add candidate</button>
                <button class="btn btn-primary btn-sm" onclick="closeElection('${v.id}')">Close & tally</button>` : ''}
              <button class="btn btn-secondary btn-sm" onclick="showElectionResults('${v.id}')">Live results</button>
              ${v.status === 'closed' ? `<button class="btn btn-secondary btn-sm" onclick="exportElectionPdf('${v.id}')">Results PDF</button>` : ''}
            </div>
          </div>
        </div>`).join('');
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load elections</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function electionStatusBadge(status) {
    if (status === 'open') return '<span class="badge badge-green">Open</span>';
    return '<span class="badge badge-gray">Closed</span>';
  }

  window.startElection = async function () {
    try {
      const kind = document.getElementById('electionKind').value;
      const scope = document.getElementById('electionUnit').value.trim();
      const title = document.getElementById('electionTitle').value.trim();
      if (!title) { toast('Please enter a title', 'error'); return; }
      const result = await api('/votes/start', {
        method: 'POST',
        body: { kind, scope: scope || undefined, title },
      });
      toast(result.message || 'Election started', 'success');
      document.getElementById('newElectionCard').hidden = true;
      renderElections(document.getElementById('pageContent'));
    } catch (err) {
      toast(err.message || 'Failed to start election', 'error');
    }
  };

  window.addElectionCandidate = async function (id) {
    const memberCode = prompt('Enter the candidate\'s member code:');
    if (!memberCode) return;
    try {
      const result = await api(`/votes/${id}/candidate`, { method: 'POST', body: { memberCode } });
      toast(result.message || 'Candidate added', 'success');
      renderElections(document.getElementById('pageContent'));
    } catch (err) {
      toast(err.message || 'Failed to add candidate', 'error');
    }
  };

  window.closeElection = async function (id) {
    if (!confirm('Close this election and tally the final results?')) return;
    try {
      const result = await api(`/votes/${id}/close`, { method: 'POST' });
      toast(result.message || 'Election closed', 'success');
      renderElections(document.getElementById('pageContent'));
    } catch (err) {
      toast(err.message || 'Failed to close election', 'error');
    }
  };

  window.showElectionResults = async function (id) {
    try {
      const result = await api(`/votes/${id}/results`);
      toast(result.results || result.message || 'No results', 'info');
    } catch (err) {
      toast(err.message || 'Failed to load results', 'error');
    }
  };

  window.exportElectionPdf = async function (id) {
    try {
      toast('Generating election results PDF...', 'info');
      const result = await api(`/votes/${id}/export-pdf`, { method: 'POST' });
      const pdf = (result.files || []).find(f => f.endsWith('.pdf'));
      toast('PDF ready', 'success');
      if (pdf) setTimeout(async () => {
        try {
          await downloadExport('/api/export/' + encodeURIComponent(pdf), pdf);
        } catch (err) {
          toast(err.message || 'Download failed', 'error');
        }
      }, 300);
    } catch (err) {
      toast(err.message || 'Export failed', 'error');
    }
  };

  // ---- Grievances (member complaints) ----
  async function renderGrievances(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Member Grievances</span>
          <div class="flex gap-2">
            <select id="grievanceFilter" style="padding:8px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:0.8125rem; background:var(--bg-card); color:var(--text);">
              <option value="">All</option>
              <option value="open">Open</option>
              <option value="resolved">Resolved</option>
            </select>
          </div>
        </div>
        <div class="card-body flush" id="grievancesTable">
          <div class="empty-state"><p class="text-muted">Loading grievances...</p></div>
        </div>
      </div>`;

    document.getElementById('grievanceFilter').addEventListener('change', function () {
      loadGrievances(this.value);
    });
    loadGrievances('');
  }

  async function loadGrievances(status) {
    const el = document.getElementById('grievancesTable');
    el.innerHTML = '<div class="empty-state"><p class="text-muted">Loading...</p></div>';
    try {
      const rows = await api('/grievances');
      const filtered = status ? rows.filter(r => r.status === status) : rows;
      if (!filtered.length) {
        el.innerHTML = '<div class="empty-state"><h3>No grievances</h3><p class="text-muted">Member complaints will appear here.</p></div>';
        return;
      }
      el.innerHTML = `
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Member</th><th>Complaint</th><th>Status</th><th>Date</th><th></th></tr></thead>
            <tbody>
              ${filtered.map(g => `<tr>
                <td class="font-bold">${esc(g.member?.name || '—')}<div class="text-muted text-sm">${esc(formatPhone(g.member?.phone))}</div></td>
                <td class="text-sm">${esc(g.message)}</td>
                <td>${statusBadge(g.status)}</td>
                <td class="text-muted text-sm">${date(g.createdAt)}</td>
                <td>${g.status === 'open' ? `<button class="btn btn-primary btn-xs" onclick="resolveGrievance('${g.id}')">Resolve</button>` : '<span class="text-muted text-sm">By ' + esc(g.resolvedBy?.name || '—') + '</span>'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  window.resolveGrievance = async function (id) {
    const response = prompt('Resolution response for the member:');
    if (response === null) return;
    if (!response.trim()) { toast('A response is required', 'error'); return; }
    try {
      const result = await api(`/grievances/${id}/resolve`, { method: 'POST', body: { response: response.trim() } });
      toast(result.message || 'Grievance resolved', 'success');
      renderGrievances(document.getElementById('pageContent'));
    } catch (err) {
      toast(err.message || 'Failed to resolve', 'error');
    }
  };

  // ---- Support Tickets ----
  async function renderTickets(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Support Tickets</span>
          <div class="flex gap-2">
            <select id="ticketFilter" style="padding:8px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:0.8125rem; background:var(--bg-card); color:var(--text);">
              <option value="">All</option>
              <option value="open">Open</option>
              <option value="in_progress">In Progress</option>
              <option value="resolved">Resolved</option>
            </select>
          </div>
        </div>
        <div class="card-body flush" id="ticketsTable">
          <div class="empty-state"><p class="text-muted">Loading tickets...</p></div>
        </div>
      </div>`;

    document.getElementById('ticketFilter').addEventListener('change', function () {
      loadTickets(this.value);
    });
    loadTickets('');
  }

  async function loadTickets(status) {
    const el = document.getElementById('ticketsTable');
    el.innerHTML = '<div class="empty-state"><p class="text-muted">Loading...</p></div>';
    try {
      const rows = await api('/tickets');
      const filtered = status ? rows.filter(r => r.status === status) : rows;
      if (!filtered.length) {
        el.innerHTML = '<div class="empty-state"><h3>No tickets</h3><p class="text-muted">Member support requests will appear here.</p></div>';
        return;
      }
      el.innerHTML = `
        <div class="table-wrapper">
          <table>
            <thead><tr><th>ID</th><th>Member</th><th>Issue</th><th>Priority</th><th>Status</th><th>Date</th><th></th></tr></thead>
            <tbody>
              ${filtered.map(t => `<tr>
                <td class="font-mono text-sm">#${esc(t.id.slice(-6))}</td>
                <td class="font-bold">${esc(t.member?.name || '—')}<div class="text-muted text-sm">${esc(formatPhone(t.member?.phone))}</div></td>
                <td class="text-sm">${esc(t.message)}</td>
                <td>${priorityBadge(t.priority)}</td>
                <td>${statusBadge(t.status)}</td>
                <td class="text-muted text-sm">${date(t.createdAt)}</td>
                <td>${t.status !== 'resolved' ? `<button class="btn btn-primary btn-xs" onclick="resolveTicket('${t.id}')">Resolve</button>` : '<span class="text-muted text-sm">By ' + esc(t.assignedTo?.name || '—') + '</span>'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function priorityBadge(p) {
    const c = { urgent: 'red', high: 'red', normal: 'blue', low: 'gray' }[p] || 'gray';
    return `<span class="badge badge-${c}">${esc(p)}</span>`;
  }

  window.resolveTicket = async function (id) {
    const note = prompt('Resolution note (optional):') || '';
    try {
      const result = await api(`/tickets/${id}/resolve`, { method: 'POST', body: { note } });
      toast(result.message || 'Ticket resolved', 'success');
      renderTickets(document.getElementById('pageContent'));
    } catch (err) {
      toast(err.message || 'Failed to resolve', 'error');
    }
  };

  // ---- Executive Posts ----
  async function renderPosts(el) {
    if (!isSuperAdmin()) {
      el.innerHTML = '<div class="empty-state"><h3>Access denied</h3><p class="text-muted">Only the super admin can manage executive posts.</p></div>';
      return;
    }
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Executive Posts (Organogram)</span>
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('newPostCard').hidden = false">New Post</button>
        </div>
        <div class="card-body flush" id="postsTable">
          <div class="empty-state"><p class="text-muted">Loading posts...</p></div>
        </div>
      </div>

      <div class="card" id="newPostCard" hidden>
        <div class="card-header"><span class="card-title">Add an executive post</span></div>
        <div class="card-body" style="display:flex; gap:10px; align-items:center;">
          <input id="newPostTitle" placeholder="e.g. Financial Secretary" style="flex:1; padding:10px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--bg-card); color:var(--text);">
          <button class="btn btn-primary btn-sm" onclick="createPost()">Create</button>
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('newPostCard').hidden = true">Cancel</button>
        </div>
      </div>`;

    try {
      const posts = await api('/posts');
      const table = document.getElementById('postsTable');
      if (!posts.length) {
        table.innerHTML = '<div class="empty-state"><h3>No posts yet</h3><p class="text-muted">Create executive posts above, then assign incumbents.</p></div>';
        return;
      }
      table.innerHTML = `
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Post</th><th>Incumbent</th><th>Appointed</th><th></th></tr></thead>
            <tbody>
              ${posts.map(p => `<tr>
                <td class="font-bold">${esc(titleCase(p.title))}</td>
                <td>${p.incumbent ? `<span class="font-semibold">${esc(p.incumbent.name)}</span><div class="text-muted text-sm">${esc(p.incumbent.code)}</div>` : '<span class="text-muted">Vacant</span>'}</td>
                <td class="text-muted text-sm">${p.appointedAt ? date(p.appointedAt) : '—'}</td>
                <td><button class="btn btn-outline btn-xs" onclick="assignPost('${p.id}')">${p.incumbent ? 'Reassign' : 'Assign'}</button></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function titleCase(s) {
    return (s || '').replace(/\b\w/g, c => c.toUpperCase());
  }

  window.createPost = async function () {
    const title = document.getElementById('newPostTitle').value.trim();
    if (!title) { toast('Enter a post title', 'error'); return; }
    try {
      const result = await api('/posts', { method: 'POST', body: { title } });
      toast(result.message || 'Post created', 'success');
      document.getElementById('newPostCard').hidden = true;
      renderPosts(document.getElementById('pageContent'));
    } catch (err) {
      toast(err.message || 'Failed to create post', 'error');
    }
  };

  window.assignPost = async function (id) {
    const answer = prompt('Enter the member code to assign (blank to vacate):');
    if (answer === null) return;
    const memberCode = answer.trim();
    try {
      const result = await api(`/posts/${id}/assign`, { method: 'POST', body: { memberCode: memberCode || undefined } });
      toast(result.message || 'Assigned', 'success');
      renderPosts(document.getElementById('pageContent'));
    } catch (err) {
      toast(err.message || 'Failed to assign', 'error');
    }
  };

  // ---- Payroll ----
  async function renderPayroll(el) {
    if (!isSuperAdmin()) {
      el.innerHTML = '<div class="empty-state"><h3>Access denied</h3><p class="text-muted">Only the super admin can manage payroll.</p></div>';
      return;
    }
    el.innerHTML = `
      <div class="stats-grid" id="payrollStats" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));">
        <div class="stat-card"><div class="stat-label">Configured Payees</div><div class="stat-value skeleton" style="height:28px;width:60px;"></div></div>
        <div class="stat-card"><div class="stat-label">Monthly Salary Pool</div><div class="stat-value skeleton" style="height:28px;width:120px;"></div></div>
      </div>
      <div class="card" style="margin-top:16px;">
        <div class="card-header">
          <span class="card-title">Payroll Configuration</span>
          <div class="flex gap-2">
            <button class="btn btn-secondary btn-sm" onclick="setSalary()">Set Salary</button>
            <button class="btn btn-primary btn-sm" onclick="runPayroll()">Run Payroll</button>
          </div>
        </div>
        <div class="card-body flush" id="payrollTable">
          <div class="empty-state"><p class="text-muted">Loading payroll...</p></div>
        </div>
      </div>
      <div class="card" style="margin-top:16px;">
        <div class="card-header"><span class="card-title">PAYE / Remittance History</span></div>
        <div class="card-body flush" id="payrollHistory">
          <div class="empty-state"><p class="text-muted">Loading history...</p></div>
        </div>
      </div>`;

    try {
      const [payroll, history] = await Promise.all([
        api('/payroll'),
        api('/payroll/history'),
      ]);
      const participants = payroll.participants || [];
      const pool = participants.reduce((a, p) => a + (p.salaryAmount || 0), 0);
      document.getElementById('payrollStats').innerHTML = `
        <div class="stat-card"><div class="stat-label">Configured Payees</div><div class="stat-value">${fmt(participants.filter(p => p.salaryAmount > 0).length)}</div></div>
        <div class="stat-card"><div class="stat-label">Monthly Salary Pool</div><div class="stat-value">${currency(pool)}</div></div>`;

      const table = document.getElementById('payrollTable');
      if (!participants.length) {
        table.innerHTML = '<div class="empty-state"><h3>No super admins</h3><p class="text-muted">Salaries are paid to super admin bank accounts. Set one with "Set Salary".</p></div>';
      } else {
        table.innerHTML = `
          <div class="table-wrapper">
            <table>
              <thead><tr><th>Name</th><th>Salary</th><th>Bank Account</th></tr></thead>
              <tbody>
                ${participants.map(p => `<tr>
                  <td class="font-bold">${esc(p.name)}</td>
                  <td class="font-mono">${p.salaryAmount > 0 ? currency(p.salaryAmount) : '<span class="text-muted">—</span>'}</td>
                  <td>${p.bankAccountNumber ? '<span class="font-mono text-sm">' + esc(p.bankName || '') + ' ••••' + esc(String(p.bankAccountNumber).slice(-4)) + '</span>' : '<span class="text-muted">No bank on file</span>'}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>`;
      }

      const hist = document.getElementById('payrollHistory');
      const paye = history.paye || [];
      if (!paye.length) {
        hist.innerHTML = '<div class="empty-state"><h3>No PAYE records yet</h3><p class="text-muted">PAYE is calculated at source when payroll runs.</p></div>';
      } else {
        hist.innerHTML = `
          <div class="table-wrapper">
            <table>
              <thead><tr><th>Member</th><th>Period</th><th>Gross</th><th>Tax</th><th>Net</th><th>Status</th></tr></thead>
              <tbody>
                ${paye.map(r => `<tr>
                  <td class="font-bold">${esc(r.member?.name || '—')}</td>
                  <td>${String(r.month).padStart(2, '0')}/${r.year}</td>
                  <td class="font-mono">${currency(r.grossAmount)}</td>
                  <td class="font-mono">${currency(r.taxAmount)}</td>
                  <td class="font-mono">${currency(r.netAmount)}</td>
                  <td>${statusBadge(r.status)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>`;
      }
    } catch (err) {
      document.getElementById('payrollStats').innerHTML = '';
      el.innerHTML += `<div class="card"><div class="empty-state"><h3>Failed to load</h3><p>${esc(err.message)}</p></div></div>`;
    }
  }

  window.setSalary = async function () {
    const memberCode = prompt('Member code of the super admin (or "off" to stop salary)?');
    if (memberCode === null) return;
    const code = memberCode.trim();
    if (code.toLowerCase() === 'off') {
      const code2 = prompt('Member code to stop salary for:');
      if (!code2) return;
      try {
        const result = await api('/payroll/set', { method: 'POST', body: { memberCode: code2.trim(), amount: 'off' } });
        toast(result.message || 'Salary stopped', 'success');
        renderPayroll(document.getElementById('pageContent'));
      } catch (err) { toast(err.message || 'Failed', 'error'); }
      return;
    }
    const amountStr = prompt('Monthly salary amount in naira (e.g. 100000):');
    if (!amountStr) return;
    const amount = Math.round(parseFloat(amountStr) * 100);
    if (!(amount > 0)) { toast('Invalid amount', 'error'); return; }
    try {
      const result = await api('/payroll/set', { method: 'POST', body: { memberCode: code, amount } });
      toast(result.message || 'Salary set', 'success');
      renderPayroll(document.getElementById('pageContent'));
    } catch (err) { toast(err.message || 'Failed', 'error'); }
  };

  window.runPayroll = async function () {
    const narration = prompt('Payroll narration (e.g. October stipends):');
    if (!narration) return;
    if (!confirm('Run payroll now? Money goes to the super admins\' bank accounts. You cannot be paid by your own run.')) return;
    try {
      const result = await api('/payroll/run', { method: 'POST', body: { narration: narration.trim() } });
      toast(result.message || 'Payroll run complete', 'success');
      renderPayroll(document.getElementById('pageContent'));
    } catch (err) { toast(err.message || 'Failed', 'error'); }
  };

  // ---- Funds / Reserves ----
  async function renderFunds(el) {
    if (!isSuperAdmin()) {
      el.innerHTML = '<div class="empty-state"><h3>Access denied</h3><p class="text-muted">Only the super admin can manage funds and reserves.</p></div>';
      return;
    }
    el.innerHTML = `
      <div class="stats-grid" id="fundsStats" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));">
        <div class="stat-card"><div class="stat-label skeleton" style="height:14px;width:80px;"></div><div class="stat-value skeleton" style="height:28px;width:120px;margin-top:12px;"></div></div>
        <div class="stat-card"><div class="stat-label skeleton" style="height:14px;width:80px;"></div><div class="stat-value skeleton" style="height:28px;width:120px;margin-top:12px;"></div></div>
        <div class="stat-card"><div class="stat-label skeleton" style="height:14px;width:80px;"></div><div class="stat-value skeleton" style="height:28px;width:120px;margin-top:12px;"></div></div>
      </div>
      <div class="card" style="margin-top:16px;">
        <div class="card-header">
          <span class="card-title">Reserve Allocations</span>
          <button class="btn btn-secondary btn-sm" onclick="allocateReserve()">Allocate to Reserve</button>
        </div>
        <div class="card-body flush" id="fundsReserve">
          <div class="empty-state"><p class="text-muted">Loading...</p></div>
        </div>
      </div>
      <div class="card" style="margin-top:16px;">
        <div class="card-header"><span class="card-title">Education & Development Funds</span></div>
        <div class="card-body flush" id="fundsTable">
          <div class="empty-state"><p class="text-muted">Loading...</p></div>
        </div>
      </div>`;

    try {
      const f = await api('/funds');
      document.getElementById('fundsStats').innerHTML = `
        <div class="stat-card"><div class="stat-label">Reserve Fund</div><div class="stat-value">${currency(f.reserveBalance)}</div></div>
        <div class="stat-card"><div class="stat-label">Education Fund</div><div class="stat-value">${currency(f.educationBalance)}</div></div>
        <div class="stat-card"><div class="stat-label">Development Fund</div><div class="stat-value">${currency(f.developmentBalance)}</div></div>`;

      const reserve = document.getElementById('fundsReserve');
      if (!f.allocations.length) {
        reserve.innerHTML = '<div class="empty-state"><h3>No reserve allocations yet</h3><p class="text-muted">Allocate to the statutory reserve fund above.</p></div>';
      } else {
        reserve.innerHTML = `
          <div class="table-wrapper"><table>
            <thead><tr><th>Amount</th><th>Source</th><th>Note</th><th>Date</th></tr></thead>
            <tbody>
              ${f.allocations.map(a => `<tr>
                <td class="font-mono">${currency(a.amount)}</td>
                <td>${esc(a.source)}</td>
                <td class="text-sm">${esc(a.note || '—')}</td>
                <td class="text-muted text-sm">${date(a.createdAt)}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>`;
      }

      const table = document.getElementById('fundsTable');
      const rows = [
        ...f.education.map(e => ({ kind: 'Education', ...e })),
        ...f.development.map(d => ({ kind: 'Development', ...d })),
      ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      if (!rows.length) {
        table.innerHTML = '<div class="empty-state"><h3>No fund activity yet</h3><p class="text-muted">Education and development fund entries will appear here.</p></div>';
      } else {
        table.innerHTML = `
          <div class="table-wrapper"><table>
            <thead><tr><th>Fund</th><th>Amount</th><th>Source</th><th>Note</th><th>Date</th></tr></thead>
            <tbody>
              ${rows.map(r => `<tr>
                <td><span class="badge badge-${r.kind === 'Education' ? 'blue' : 'purple'}">${r.kind}</span></td>
                <td class="font-mono">${currency(r.amount)}</td>
                <td>${esc(r.source)}</td>
                <td class="text-sm">${esc(r.note || '—')}</td>
                <td class="text-muted text-sm">${date(r.createdAt)}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>`;
      }
    } catch (err) {
      el.innerHTML += `<div class="card"><div class="empty-state"><h3>Failed to load</h3><p>${esc(err.message)}</p></div></div>`;
    }
  }

  window.allocateReserve = async function () {
    const amountStr = prompt('Amount to allocate to the reserve fund (naira):');
    if (!amountStr) return;
    const amount = Math.round(parseFloat(amountStr) * 100);
    if (!(amount > 0)) { toast('Invalid amount', 'error'); return; }
    const note = prompt('Note (optional):') || '';
    try {
      const result = await api('/funds/reserve/allocate', { method: 'POST', body: { amount, note } });
      toast(result.message || 'Allocated', 'success');
      renderFunds(document.getElementById('pageContent'));
    } catch (err) { toast(err.message || 'Failed', 'error'); }
  };

  // ---- STR / AML ----
  async function renderSTR(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Suspicious Transaction Reports (STR / AML)</span>
          <button class="btn btn-primary btn-sm" onclick="exportCompliance('str')">Export STR</button>
        </div>
        <div class="card-body flush" id="strTable">
          <div class="empty-state"><p class="text-muted">Loading STRs...</p></div>
        </div>
      </div>`;

    try {
      const rows = await api('/compliance/str');
      const table = document.getElementById('strTable');
      if (!rows.length) {
        table.innerHTML = '<div class="empty-state"><h3>No STRs filed</h3><p class="text-muted">No transactions broke the CBN ₦5,000,000 threshold.</p></div>';
        return;
      }
      table.innerHTML = `
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Date</th><th>Member</th><th>Amount</th><th>Reason</th><th>Status</th></tr></thead>
            <tbody>
              ${rows.map(s => `<tr>
                <td class="text-muted text-sm">${date(s.createdAt)}</td>
                <td class="font-bold">${esc(s.member?.name || '—')}<div class="text-muted text-sm">${esc(formatPhone(s.member?.phone))}</div></td>
                <td class="font-mono">${currency(s.amount)}</td>
                <td class="text-sm">${esc(s.reason)}</td>
                <td>${statusBadge(s.status)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load STRs</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  // ---- PAYE ----
  async function renderPAYE(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">PAYE (State IRS) Records</span>
          <button class="btn btn-primary btn-sm" onclick="exportCompliance('paye')">Export PAYE</button>
        </div>
        <div class="card-body flush" id="payeTable">
          <div class="empty-state"><p class="text-muted">Loading PAYE records...</p></div>
        </div>
      </div>`;

    try {
      const rows = await api('/compliance/paye');
      const table = document.getElementById('payeTable');
      if (!rows.length) {
        table.innerHTML = '<div class="empty-state"><h3>No PAYE records</h3><p class="text-muted">PAYE is recorded when salaries are paid, or via <code>paye add</code> on WhatsApp.</p></div>';
        return;
      }
      table.innerHTML = `
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Member</th><th>Period</th><th>Gross</th><th>Tax</th><th>Net</th><th>Status</th></tr></thead>
            <tbody>
              ${rows.map(r => `<tr>
                <td class="font-bold">${esc(r.member?.name || '—')}<div class="text-muted text-sm">${esc(r.member?.code || '')}</div></td>
                <td>${String(r.month).padStart(2, '0')}/${r.year}</td>
                <td class="font-mono">${currency(r.grossAmount)}</td>
                <td class="font-mono">${currency(r.taxAmount)}</td>
                <td class="font-mono">${currency(r.netAmount)}</td>
                <td>${statusBadge(r.status)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load PAYE</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  // Download an export file with the Authorization header (top-level window.open
  // sends no headers, so the Bearer-protected endpoint would 401). Fetch the
  // bytes as a blob and trigger a save instead.
  async function downloadExport(url, fallbackName) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Download failed');
    }
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fallbackName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  window.exportCompliance = async function (kind) {
    try {
      toast('Generating ' + kind.toUpperCase() + ' export...', 'info');
      const result = await api(`/compliance/export/${kind}`, { method: 'POST' });
      const excel = (result.files || []).find(f => f.endsWith('.xlsx'));
      const pdf = (result.files || []).find(f => f.endsWith('.pdf'));
      toast('Export ready', 'success');
      setTimeout(async () => {
        try {
          if (excel) await downloadExport('/api/export/' + encodeURIComponent(excel), excel);
          if (pdf) await downloadExport('/api/export/' + encodeURIComponent(pdf), pdf);
        } catch (err) {
          toast(err.message || 'Download failed', 'error');
        }
      }, 300);
    } catch (err) {
      toast(err.message || 'Export failed', 'error');
    }
  }

  // ---- Helpers ----
  function fmt(n) {
    return Number(n).toLocaleString('en-NG');
  }

  function fmtNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toString();
  }

  // Amounts come from the API in KOB0 (integer). Display as naira with 2 dp
  // so values are always round/consistent (e.g. 150000 kobo -> ₦1,500.00).
  function currency(n) {
    const kobo = Number(n) || 0;
    const naira = kobo / 100;
    return '₦' + naira.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function date(str) {
    if (!str) return '—';
    return new Date(str).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function formatPhone(p) {
    if (!p) return '';
    const clean = p.replace(/[^0-9]/g, '');
    if (clean.length > 10) {
      return '+' + clean.slice(0, 3) + ' ' + clean.slice(3, 7) + ' ' + clean.slice(7);
    }
    return clean;
  }

  function statusBadge(status) {
    const map = {
      confirmed: 'green', completed: 'green', approved: 'green', repaid: 'green',
      pending: 'gold', guaranteed: 'blue', processing: 'blue',
      rejected: 'red', defaulted: 'red', failed: 'red',
      disbursed: 'purple'
    };
    const color = map[status] || 'gray';
    return `<span class="badge badge-${color}"><span class="status-dot ${color}"></span>${esc(status)}</span>`;
  }

  function roleBadge(role) {
    if (role === 'superadmin') return '<span class="badge badge-purple">Super Admin</span>';
    if (role === 'admin') return '<span class="badge badge-gold">Admin</span>';
    return '<span class="badge badge-gray">Member</span>';
  }

  function skeletonCards(n) {
    return Array.from({ length: n }, () =>
      `<div class="stat-card"><div class="skeleton" style="height:14px;width:80px;margin-bottom:12px;"></div><div class="skeleton" style="height:28px;width:120px;"></div></div>`
    ).join('');
  }

  function showLoader() {
    const el = document.getElementById('globalLoader');
    if (el) el.style.display = 'flex';
  }

  function hideLoader() {
    const el = document.getElementById('globalLoader');
    if (el) el.style.display = 'none';
  }

  function toast(msg, type = 'info') {
    const container = document.getElementById('toastContainer');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(() => { t.remove(); }, 3500);
  }
})();
