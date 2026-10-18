// Shared behaviour for the member and leaders areas: dark mode, the avatar, and switching views.
// The theme itself is applied by a tiny inline script in each page's head so there is no flash.
(function () {
  var KEY = "cbc_theme";

  function stored() {
    try {
      return localStorage.getItem(KEY);
    } catch (_) {
      return null;
    }
  }

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  var toggle = document.getElementById("theme-toggle");

  function paintToggle() {
    if (!toggle) return;
    var dark = currentTheme() === "dark";
    toggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    toggle.querySelector(".i-moon").hidden = dark;
    toggle.querySelector(".i-sun").hidden = !dark;
  }

  function setTheme(mode) {
    document.documentElement.setAttribute("data-theme", mode);
    try {
      localStorage.setItem(KEY, mode);
    } catch (_) {}
    paintToggle();
  }

  if (toggle) {
    toggle.addEventListener("click", function () {
      setTheme(currentTheme() === "dark" ? "light" : "dark");
    });
    paintToggle();
  }

  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }

  // views: panels marked data-view-panel="name", buttons marked data-view="name" inside .app-nav
  function views(onShow) {
    var panels = Array.prototype.slice.call(document.querySelectorAll("[data-view-panel]"));
    var buttons = Array.prototype.slice.call(document.querySelectorAll(".app-nav [data-view]"));

    function names() {
      return buttons.filter(function (b) { return !b.hidden; }).map(function (b) { return b.getAttribute("data-view"); });
    }

    function show(name, keepScroll) {
      if (names().indexOf(name) === -1) name = names()[0];
      panels.forEach(function (p) {
        p.hidden = p.getAttribute("data-view-panel") !== name;
      });
      buttons.forEach(function (b) {
        if (b.getAttribute("data-view") === name) b.setAttribute("aria-current", "page");
        else b.removeAttribute("aria-current");
      });
      try {
        window.history.replaceState(null, "", "#" + name);
      } catch (_) {}
      if (!keepScroll) window.scrollTo(0, 0);
      if (onShow) onShow(name);
    }

    buttons.forEach(function (b) {
      b.addEventListener("click", function () {
        show(b.getAttribute("data-view"));
      });
    });

    return {
      show: show,
      start: function (fallback) {
        var want = window.location.hash.replace("#", "");
        show(names().indexOf(want) !== -1 ? want : fallback, true);
      },
    };
  }

  window.CBC_APP = {
    initials: initials,
    views: views,
    setUser: function (name) {
      var a = document.getElementById("avatar");
      if (a) a.textContent = initials(name);
    },
  };
})();
