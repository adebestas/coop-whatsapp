/* ============================================================
   Platform Console — Login
   POST /api/developer/login, then /api/developer/change-pin when the
   account is still on its temporary PIN, then /api/developer/setup-2fa
   when an owner/developer has not enrolled yet. The session is an
   httpOnly cookie (coop_dev_token) set by the server; JS only stores
   the non-sensitive admin profile for header display.
   ============================================================ */

(function () {
  'use strict';

  const API_BASE = '/api/developer';
  const STORAGE_ADMIN = 'coop_dev_admin';

  const loginForm = document.getElementById('loginForm');
  const changePinForm = document.getElementById('changePinForm');
  const setup2faForm = document.getElementById('setup2faForm');
  const phoneInput = document.getElementById('phone');
  const pinInput = document.getElementById('pin');
  const totpGroup = document.getElementById('totpGroup');
  const totpInput = document.getElementById('totp');
  const toggle2fa = document.getElementById('toggle2fa');
  const newPinInput = document.getElementById('newPin');
  const secretEl = document.getElementById('totpSecret');
  const copySecretBtn = document.getElementById('copySecret');
  const setupCodeInput = document.getElementById('setupCode');
  const errorEl = document.getElementById('loginError');
  const changeErrorEl = document.getElementById('changePinError');
  const setupErrorEl = document.getElementById('setup2faError');
  const loginBtn = document.getElementById('loginBtn');
  const changePinBtn = document.getElementById('changePinBtn');
  const setup2faBtn = document.getElementById('setup2faBtn');

  // Needed again for the step-up checks on change-pin and setup-2fa.
  let knownPin = '';
  let knownTotp = '';
  let pendingSecret = '';

  // A logged-in operator who opens this page simply sees the form; we do NOT
  // auto-redirect to index.html (a temporary-PIN session would bounce back here
  // in a loop and the change-PIN step would be unreachable on re-entry).

  toggle2fa.addEventListener('click', function () {
    const showing = !totpGroup.hidden;
    totpGroup.hidden = showing;
    toggle2fa.textContent = showing ? 'Use a 2FA code' : 'Hide 2FA code';
    if (!showing) totpInput.focus();
  });

  copySecretBtn.addEventListener('click', function () {
    if (!pendingSecret) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(pendingSecret).then(
        () => {
          copySecretBtn.textContent = 'Copied';
        },
        () => {},
      );
    }
  });

  loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    errorEl.hidden = true;

    const phone = phoneInput.value.replace(/[^0-9]/g, '');
    const pin = pinInput.value.trim();
    const totp = totpInput.value.trim();

    if (!phone || phone.length < 10) {
      showError('Enter a valid phone number');
      return;
    }
    if (!/^\d{4,6}$/.test(pin)) {
      showError('Enter your PIN (4–6 digits)');
      return;
    }

    setLoading(loginBtn, true, 'Sign In');

    try {
      const fullPhone = phone.startsWith('234') ? phone : '234' + phone;
      const res = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ phone: fullPhone, pin, totp: totp || undefined }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (/2fa|totp/i.test(data.error || '')) {
          totpGroup.hidden = false;
          toggle2fa.textContent = 'Hide 2FA code';
          showError(data.error || 'Enter your 2FA code');
          return;
        }
        showError(data.error || 'Login failed');
        return;
      }

      knownPin = pin;
      knownTotp = totp;

      if (data.mustChangePin) {
        // Temporary PIN: the server set the cookie, now force a reset.
        loginForm.hidden = true;
        changePinForm.hidden = false;
        newPinInput.focus();
        return;
      }

      if (data.mustSetup2fa) {
        beginSetup2fa();
        return;
      }

      localStorage.setItem(STORAGE_ADMIN, JSON.stringify(data.admin));
      window.location.href = 'index.html';
    } catch {
      showError('Network error. Please try again.');
    } finally {
      setLoading(loginBtn, false, 'Sign In');
    }
  });

  changePinForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    changeErrorEl.hidden = true;

    const newPin = newPinInput.value.trim();
    if (!/^\d{6}$/.test(newPin)) {
      showChangeError('New PIN must be exactly 6 digits');
      return;
    }

    setLoading(changePinBtn, true, 'Set PIN & Continue');
    try {
      const res = await fetch(`${API_BASE}/change-pin`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          currentPin: knownPin,
          newPin,
          totp: knownTotp || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showChangeError(data.error || 'Could not set PIN');
        return;
      }
      knownPin = newPin;
      knownTotp = '';
      if (data.mustSetup2fa) {
        beginSetup2fa();
        return;
      }
      window.location.href = 'index.html';
    } catch {
      showChangeError('Network error. Please try again.');
    } finally {
      setLoading(changePinBtn, false, 'Set PIN & Continue');
    }
  });

  setup2faForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    setupErrorEl.hidden = true;
    const code = setupCodeInput.value.trim();
    if (!/^\d{6}$/.test(code)) {
      showSetupError('Enter the 6-digit code from your authenticator app');
      return;
    }

    setLoading(setup2faBtn, true, 'Enable 2FA & Continue');
    try {
      const res = await fetch(`${API_BASE}/setup-2fa`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          secret: pendingSecret,
          code,
          currentPin: knownPin,
          totp: knownTotp || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showSetupError(data.error || 'Could not enable 2FA');
        return;
      }
      window.location.href = 'index.html';
    } catch {
      showSetupError('Network error. Please try again.');
    } finally {
      setLoading(setup2faBtn, false, 'Enable 2FA & Continue');
    }
  });

  function beginSetup2fa() {
    pendingSecret = generateBase32Secret();
    secretEl.textContent = pendingSecret;
    copySecretBtn.textContent = 'Copy key';
    loginForm.hidden = true;
    changePinForm.hidden = true;
    setup2faForm.hidden = false;
    setupCodeInput.focus();
  }

  // 20 random bytes encoded as RFC 4648 base32 (matches the server's decoder).
  function generateBase32Secret() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bytes = new Uint8Array(20);
    window.crypto.getRandomValues(bytes);
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        out += alphabet[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
    return out;
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
  function showChangeError(msg) {
    changeErrorEl.textContent = msg;
    changeErrorEl.hidden = false;
  }
  function showSetupError(msg) {
    setupErrorEl.textContent = msg;
    setupErrorEl.hidden = false;
  }
  function setLoading(btn, loading, label) {
    btn.disabled = loading;
    const text = btn.querySelector('.btn-text');
    const loader = btn.querySelector('.btn-loader');
    if (text) text.hidden = loading;
    if (loader) loader.hidden = !loading;
    if (!loading && text) text.textContent = label;
  }
})();
