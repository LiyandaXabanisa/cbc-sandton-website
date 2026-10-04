// Registers the service worker and offers a gentle "add to home screen" hint on phones.
(function () {
  var secure = window.isSecureContext || location.hostname === "localhost" || location.hostname === "127.0.0.1";

  if ("serviceWorker" in navigator && secure) {
    window.addEventListener("load", function () {
      // wait until the browser is idle so the first screen is never slowed down
      var go = function () {
        navigator.serviceWorker.register("sw.js").catch(function () {
          /* the site works fine without it */
        });
      };
      if (window.requestIdleCallback) window.requestIdleCallback(go, { timeout: 4000 });
      else setTimeout(go, 2000);
    });
  }

  // ---------- install hint (home page only, phones only) ----------
  var isHome = !!document.getElementById("main") && !!document.querySelector(".hero");
  var onPhone = window.matchMedia("(max-width: 820px)").matches;
  var installed = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (!isHome || !onPhone || installed) return;

  var KEY = "cbc_install_hint_until";
  function snoozed() {
    try {
      return Number(localStorage.getItem(KEY) || 0) > Date.now();
    } catch (_) {
      return false;
    }
  }
  function snooze(days) {
    try {
      localStorage.setItem(KEY, String(Date.now() + days * 86400000));
    } catch (_) {}
  }
  if (snoozed()) return;

  var bar;
  function show(message, actionLabel, onAction) {
    if (bar) return;
    bar = document.createElement("div");
    bar.className = "install-hint";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Install the app");

    var text = document.createElement("p");
    text.textContent = message;
    bar.append(text);

    var row = document.createElement("div");
    row.className = "install-actions";
    if (actionLabel) {
      var go = document.createElement("button");
      go.type = "button";
      go.className = "btn btn-gold";
      go.textContent = actionLabel;
      go.addEventListener("click", onAction);
      row.append(go);
    }
    var later = document.createElement("button");
    later.type = "button";
    later.className = "btn btn-ghost-dark";
    later.textContent = actionLabel ? "Not now" : "Got it";
    later.addEventListener("click", function () {
      snooze(30);
      bar.remove();
    });
    row.append(later);
    bar.append(row);
    document.body.append(bar);
  }

  // Android and desktop Chrome
  var deferred;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    setTimeout(function () {
      show("Add Change Bible Church Sandton to your home screen for quick access.", "Install", function () {
        deferred.prompt();
        deferred.userChoice.then(function () {
          snooze(90);
          if (bar) bar.remove();
          deferred = null;
        });
      });
    }, 4000);
  });
  window.addEventListener("appinstalled", function () {
    snooze(3650);
    if (bar) bar.remove();
  });

  // iPhone and iPad: Safari has no install button, so explain the steps.
  var ua = navigator.userAgent;
  var iOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var safari = /safari/i.test(ua) && !/crios|fxios|edgios|opios/i.test(ua);
  if (iOS && safari) {
    setTimeout(function () {
      show("To install this app, tap the Share button, then choose Add to Home Screen.", null, null);
    }, 4000);
  }
})();
