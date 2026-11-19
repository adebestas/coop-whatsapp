/* Platform Console - consume an emailed sign-in link. */
(function () {
  "use strict";

  var API_BASE = "/api/developer";
  var STORAGE_ADMIN = "coop_dev_admin";
  var NEXT_PAGE = "dev-login.html";

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
    var res = await fetch(API_BASE + "/magic-link/consume", {
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
    if (data.admin) localStorage.setItem(STORAGE_ADMIN, JSON.stringify(data.admin));
    if (data.mustChangePin) {
      window.location.replace(NEXT_PAGE + "?change=1");
      return;
    }
    if (data.mustSetup2fa) {
      window.location.replace(NEXT_PAGE + "?setup2fa=1");
      return;
    }
    window.location.replace("index.html");
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errorEl.hidden = true;
    consume(totpInput.value.replace(/[^0-9]/g, "")).catch(function (err) {
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
