(function () {
  // ---------- mobile menu ----------
  var toggle = document.querySelector(".menu-toggle");
  var panel = document.getElementById("mobile-panel");
  toggle.addEventListener("click", function () {
    var open = panel.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
  panel.querySelectorAll("a").forEach(function (a) {
    a.addEventListener("click", function () {
      panel.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });

  // ---------- scroll reveal ----------
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var items = document.querySelectorAll(".reveal");
  if (reduced || !("IntersectionObserver" in window)) {
    items.forEach(function (el) {
      el.classList.add("in");
    });
  } else {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );
    items.forEach(function (el) {
      io.observe(el);
    });
  }

  // ---------- giving links (set in site.config.js) ----------
  var giving = (window.SITE_CONFIG && window.SITE_CONFIG.giving) || {};

  function safeHttpsUrl(raw) {
    try {
      var u = new URL(String(raw || "").trim());
      return u.protocol === "https:" ? u.href : null;
    } catch (_) {
      return null;
    }
  }

  document.querySelectorAll("[data-give]").forEach(function (slot) {
    var kind = slot.getAttribute("data-give");
    var url = safeHttpsUrl(giving[kind + "Link"]) || safeHttpsUrl(giving.generalLink);
    if (!url) return; // keep the "Link coming soon" placeholder
    var a = document.createElement("a");
    a.className = "btn btn-gold";
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = slot.getAttribute("data-label") || "Give";
    slot.replaceChildren(a);
  });

  // ---------- registration form ----------
  var form = document.getElementById("register-form");
  var status = document.getElementById("register-status");
  var submitBtn = document.getElementById("register-submit");

  function showStatus(kind, message) {
    status.textContent = message;
    status.className = "form-status show " + kind;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    status.className = "form-status";

    var payload = {
      firstName: form.firstName.value.trim(),
      lastName: form.lastName.value.trim(),
      email: form.email.value.trim(),
      phone: form.phone.value.trim(),
      notes: form.notes.value.trim(),
      consent: form.consent.checked,
      hp_company: form.hp_company.value.trim(),
    };

    if (!payload.firstName || !payload.lastName) {
      return showStatus("error", "Please enter your first and last name.");
    }
    if (!payload.email && !payload.phone) {
      return showStatus("error", "Provide an email address or a phone number so we can reach you.");
    }
    if (!payload.consent) {
      return showStatus("error", "Please tick the box to let us store your details.");
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";

    window.CBC_API.register(payload)
      .then(function (message) {
        showStatus("ok", message);
        form.reset();
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : "";
        if (err && err.unavailable) {
          msg = "Online registration isn't switched on yet. Please see us on Sunday and we'll add your details.";
        } else if (!msg || /fetch|network/i.test(msg)) {
          msg = "Couldn't reach the server. Please try again in a moment.";
        }
        showStatus("error", msg);
      })
      .then(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = "Register";
      });
  });
})();
