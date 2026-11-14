(function () {
  // Redirect if already logged in
  if (localStorage.getItem('coop_member')) {
    window.location.href = 'index.html';
    return;
  }

  const form = document.getElementById('loginForm');
  const phoneInput = document.getElementById('phone');
  const pinInput = document.getElementById('pin');
  const totpGroup = document.getElementById('totpGroup');
  const totpInput = document.getElementById('totp');
  const errorEl = document.getElementById('loginError');
  const loginBtn = document.getElementById('loginBtn');

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    errorEl.hidden = true;

    const phone = phoneInput.value.replace(/[^0-9]/g, '');
    const pin = pinInput.value.trim();

    if (!phone || phone.length < 10) {
      showError('Enter a valid phone number');
      return;
    }
    if (!pin || pin.length !== 4) {
      showError('Enter your 4-digit PIN');
      return;
    }
    const totp = totpInput.value.replace(/[^0-9]/g, '');
    if (!totpGroup.hidden && totp.length !== 6) {
      showError('Enter the 6-digit code from your authenticator app');
      return;
    }

    setLoading(true);

    try {
      const fullPhone = phone.startsWith('234') ? phone : '234' + phone;
      const payload = { phone: fullPhone, pin };
      if (!totpGroup.hidden) payload.totp = totp;
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.code === 'totp_required' || data.code === 'totp_reused') {
          totpGroup.hidden = false;
          if (data.code === 'totp_reused') totpInput.value = '';
          totpInput.focus();
          showError(data.error || 'Enter the 6-digit code from your authenticator app');
          return;
        }
        showError(data.error || 'Login failed');
        return;
      }

      // The token is set as an httpOnly cookie by the server; only the
      // non-sensitive member profile is stored client-side.
      localStorage.setItem('coop_member', JSON.stringify(data.member));
      window.location.href = 'index.html';
    } catch (err) {
      showError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  });

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  function setLoading(loading) {
    loginBtn.disabled = loading;
    loginBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
    loginBtn.querySelector('.btn-text').hidden = loading;
    loginBtn.querySelector('.btn-loader').hidden = !loading;
  }
})();
