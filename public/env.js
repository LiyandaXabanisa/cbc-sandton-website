// Decides, once and as early as possible, which parts of the site can work on this address.
// It runs before the page is drawn, so nothing flashes or jumps.
//
// window.CBC_ENV.accounts is true when registration, login, the member area and the leaders
// area can work:
//   * a real database is connected (Supabase details in site.config.js), or
//   * the sample demo database is on (the GitHub preview, or ?demo=1 on any page), or
//   * the site is running on your own computer with the local server (localhost).
// When it is false (the live domain before the database is connected), everything marked
// data-accounts is hidden, and login pages send visitors back to the home page.
// It switches on by itself once the Supabase details are filled in.
(function () {
  var cfg = window.SITE_CONFIG || {};
  var sb = cfg.supabase || {};
  var loc = window.location || {};
  var host = (loc.hostname || "").toLowerCase();

  var database = !!(sb.url && sb.anonKey && sb.churchId);
  var local = host === "" || host === "localhost" || host === "127.0.0.1";

  var demoHosts = Array.isArray(cfg.demoHosts) ? cfg.demoHosts : ["github.io"];
  var onDemoHost = demoHosts.some(function (h) {
    h = String(h).toLowerCase();
    return host === h || host.slice(-(h.length + 1)) === "." + h;
  });
  var demo = !database && (/[?&]demo=1(&|$)/.test(loc.search || "") || (cfg.demo === true && onDemoHost));

  var env = { database: database, local: local, demo: demo, accounts: database || demo || local };
  window.CBC_ENV = env;
  document.documentElement.classList.add(env.accounts ? "accounts" : "no-accounts");
})();
