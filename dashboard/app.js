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

  function loadUserInfo() {
    const member = getMember();
    if (!member) return;
    document.getElementById('userName').textContent = member.name || 'Admin';
    document.getElementById('userAvatar').textContent = (member.name || 'A').charAt(0).toUpperCase();
    document.getElementById('coopName').textContent = member.cooperative?.name || 'Cooperative';
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
      el.innerHTML = `<div class="empty-state"><h3>Failed to load dashboard</h3><p>${err.message}</p></div>`;
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
      el.innerHTML = `<div class="empty-state"><h3>Failed to load members</h3><p>${err.message}</p></div>`;
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
      result.innerHTML = `Sent to <strong>${res.sent}</strong> of ${res.targeted} targeted member(s). ` +
        (res.skipped ? `${res.skipped} skipped (opted out). ` : '') +
        (res.failed ? `<span style="color:var(--danger)">${res.failed} failed${res.failures && res.failures.length ? ': ' + esc(res.failures.join(', ')) : ''}.</span>` : '');
      if (res.sent > 0) toast(`Message sent to ${res.sent} member(s)`, 'success');
    } catch (err) {
      result.textContent = err.message;
      result.style.color = 'var(--danger)';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send';
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
        el2.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${err.message}</p></div>`;
      }
    });

    try {
      loansData = await api('/loans');
      renderLoansTable(loansData);
    } catch (err) {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load loans</h3><p>${err.message}</p></div>`;
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
      el.innerHTML = `<div class="empty-state"><h3>Failed to load contributions</h3><p>${err.message}</p></div>`;
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
      el.innerHTML = `<div class="empty-state"><h3>Failed to load payouts</h3><p>${err.message}</p></div>`;
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
      el.innerHTML = `<div class="empty-state"><h3>Failed to load report</h3><p>${err.message}</p></div>`;
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
      el.innerHTML = `<div class="empty-state"><h3>Failed to load withdrawals</h3><p>${err.message}</p></div>`;
    }
  }

  // ---- Buy Polls ----
  async function renderPolls(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Buy Polls</span>
          <div class="flex gap-2">
            <button class="btn btn-secondary btn-sm" onclick="exportCompliance('str')">Export STR</button>
            <button class="btn btn-secondary btn-sm" onclick="exportCompliance('paye')">Export PAYE</button>
          </div>
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
      el.innerHTML = `<div class="empty-state"><h3>Failed to load polls</h3><p>${err.message}</p></div>`;
    }
  }

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
      el.innerHTML = `<div class="empty-state"><h3>Failed to load STRs</h3><p>${err.message}</p></div>`;
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
      el.innerHTML = `<div class="empty-state"><h3>Failed to load PAYE</h3><p>${err.message}</p></div>`;
    }
  }

  window.exportCompliance = async function (kind) {
    try {
      toast('Generating ' + kind.toUpperCase() + ' export...', 'info');
      const result = await api(`/compliance/export/${kind}`, { method: 'POST' });
      const excel = (result.files || []).find(f => f.endsWith('.xlsx'));
      const pdf = (result.files || []).find(f => f.endsWith('.pdf'));
      toast('Export ready', 'success');
      setTimeout(() => {
        if (excel) window.open('/api/export/' + encodeURIComponent(excel), '_blank');
        if (pdf) window.open('/api/export/' + encodeURIComponent(pdf), '_blank');
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
