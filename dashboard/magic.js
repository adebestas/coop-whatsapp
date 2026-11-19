(function () {
  var params = new URLSearchParams(window.location.search);
  var token = params.get("token") || "";
  var statusEl = document.getElementById("magicConsumeStatus");
  var form = document.getElementById("magicConsume");
  var totpGroup = document.getElementById("magicTotpGroup");
  var totpInput = document.getElementById("magicTotp");
  var errorEl = document.getElementById("magicConsumeError");

  function fail(msg) {
    statusEl.textContent = msg;
    statusEl.hidden = false;
  }

  if (!token) {
    fail("This link is missing its token. Request a new one from the sign-in page.");
    return;
  }

  async function consume(totp) {
    var payload = { token: token };
    if (totp) payload.totp = totp;
    var res = await fetch("/api/admin/magic-link/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    var data = await res.json();
    if (!res.ok) {
      if (data.code === "totp_required") {
        totpGroup.hidden = false;
        statusEl.hidden = true;
        form.hidden = false;
        totpInput.focus();
        return;
      }
      throw new Error(data.error || "This sign-in link is invalid or has expired.");
    }
    localStorage.setItem("coop_member", JSON.stringify(data.member));
    window.location.replace("index.html");
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errorEl.hidden = true;
    var totp = totpInput.value.replace(/[^0-9]/g, "");
    consume(totp).catch(function (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      statusEl.hidden = true;
      form.hidden = false;
    });
  });

  consume("").catch(function (err) {
    fail(err.message + " Request a fresh link from the sign-in page.");
  });
})();
