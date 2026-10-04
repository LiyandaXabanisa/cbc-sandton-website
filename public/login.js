(function () {
  var API = window.CBC_API;
  var auth = API.auth;

  function $(sel) {
    return document.querySelector(sel);
  }

  var views = {
    loading: $("#loading-view"),
    notice: $("#notice-view"),
    signin: $("#signin-view"),
    activate: $("#activate-view"),
    claim: $("#claim-view"),
  };

  function show(name) {
    Object.keys(views).forEach(function (k) {
      views[k].hidden = k !== name;
    });
  }

  function setError(id, message) {
    var el = $(id);
    el.textContent = message || "";
    el.className = message ? "form-status show error" : "form-status";
  }

  function go(role) {
    window.location.replace(role === "admin" ? "admin.html" : "member.html");
  }

  function afterAuth(result) {
    if (result.role === "unlinked") {
      show("claim");
      $("#cl-email").focus();
      return;
    }
    go(result.role);
  }

  function friendly(err, fallback) {
    if (err && err.unavailable) return "Member login is opening soon. Please check back shortly.";
    var msg = err && err.message;
    if (!msg || /failed to fetch|networkerror|load failed/i.test(msg)) return "Couldn't reach the server. Please try again.";
    return msg || fallback;
  }

  // Run a form action with a disabled button and a single error line.
  function submit(form, button, errorId, job) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      setError(errorId, "");
      button.disabled = true;
      job()
        .catch(function (err) {
          setError(errorId, friendly(err, "Something went wrong. Please try again."));
        })
        .then(function () {
          button.disabled = false;
        });
    });
  }

  // ----- sign in -----
  submit($("#signin-form"), $("#si-submit"), "#si-error", function () {
    var email = $("#si-email").value.trim();
    var password = $("#si-password").value;
    if (!email && !auth.emailOptional) return Promise.reject(new Error("Please enter your email address."));
    if (!password) return Promise.reject(new Error("Please enter your password."));
    return auth.login({ email: email, password: password }).then(afterAuth);
  });

  // ----- activate -----
  submit($("#activate-form"), $("#ac-submit"), "#ac-error", function () {
    var c = { email: $("#ac-email").value.trim(), code: $("#ac-code").value.trim(), password: $("#ac-password").value };
    if (!c.email || !c.code) return Promise.reject(new Error("Enter your email and your invite code."));
    if (c.password.length < 8) return Promise.reject(new Error("Choose a password of at least 8 characters."));
    return auth.activate(c).then(afterAuth);
  });

  // ----- connect an existing login to a member record (hosted mode) -----
  submit($("#claim-form"), $("#cl-submit"), "#cl-error", function () {
    var c = { email: $("#cl-email").value.trim(), code: $("#cl-code").value.trim() };
    if (!c.email || !c.code) return Promise.reject(new Error("Enter your email and your invite code."));
    return auth.claim(c).then(afterAuth);
  });

  $("#cl-signout").addEventListener("click", function () {
    auth.logout().then(function () {
      show("signin");
    });
  });

  $("#to-activate").addEventListener("click", function () {
    show("activate");
    $("#ac-email").focus();
  });
  $("#to-signin").addEventListener("click", function () {
    show("signin");
    $("#si-email").focus();
  });

  // ----- start -----
  if (auth.emailOptional) {
    $("#signin-intro").textContent =
      "Members sign in with their email and password. Demo mode only: church leaders leave the email empty and use the admin password.";
  } else {
    $("#si-email").required = true;
    $("#signin-intro").textContent = "Members and church leaders sign in with their email and password.";
  }

  auth
    .session()
    .then(function (s) {
      if (!s) {
        show("signin");
        return;
      }
      afterAuth(s);
    })
    .catch(function (err) {
      if (err && err.unavailable) {
        $("#notice-title").textContent = "Member login is opening soon";
        $("#notice-body").textContent =
          "Logins aren't switched on yet. Please check back soon, or speak to someone at the church on Sunday.";
        show("notice");
      } else {
        show("signin");
      }
    });
})();
