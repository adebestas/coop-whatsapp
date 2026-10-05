(function () {
  // Redirect if already logged in
  if (localStorage.getItem('coop_token')) {
    window.location.href = 'index.html';
    return;
  }

  const form = document.getElementById('loginForm');
  const phoneInput = document.getElementById('phone');
  const pinInput = document.getElementById('pin');
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

    setLoading(true);

    try {
      const fullPhone = phone.startsWith('234') ? phone : '234' + phone;
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: fullPhone, pin }),
      });

      const data = await res.json();

      if (!res.ok) {
        showError(data.error || 'Login failed');
        return;
      }

      localStorage.setItem('coop_token', data.token);
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
    loginBtn.querySelector('.btn-text').hidden = loading;
    loginBtn.querySelector('.btn-loader').hidden = !loading;
  }
})();
