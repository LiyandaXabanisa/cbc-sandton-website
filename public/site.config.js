// Site settings you can edit without touching any other code.
// This file is PUBLIC (it is sent to every visitor's browser), so never put
// passwords or secret keys in it.

window.SITE_CONFIG = {
  // ---------- Tithes & offering ----------
  // Paste the https:// payment links from your payment gateway between the quotes.
  // titheLink and offeringLink: a separate link for each button.
  // generalLink: used for any button whose own link is left blank.
  // If a button has no link at all, visitors see a disabled "Link coming soon" button.
  giving: {
    generalLink: "https://pos.snapscan.io/qr/PXMP9891",
    titheLink: "https://pos.snapscan.io/qr/PXMP9891",
    offeringLink: "https://pos.snapscan.io/qr/PXMP9891",
  },

  // ---------- Demo database ----------
  // While no real database is connected, true shows a built in sample database
  // (fake members, notices and demo logins stored in the visitor's own browser) so
  // the whole site can be tried out. A banner on every page says it is a demo.
  // It switches itself off as soon as the Supabase details below are filled in.
  // demoHosts lists the addresses that get the demo. The default is only the GitHub
  // preview. On the real domain (cbcsandton.co.za) there is no demo, so until the real
  // database is connected the registration section, Login links, "Become a member"
  // buttons and the privacy link are hidden (see env.js). They appear by themselves
  // once the Supabase details below are filled in. Add ?demo=1 to any page address to
  // try the demo anywhere.
  demo: true,
  demoHosts: ["github.io"],

  // ---------- ChurchHub (Supabase) ----------
  // Fill these in to connect the site to the same Supabase project that ChurchHub uses.
  // Registrations then land in ChurchHub's members list, and the members area
  // signs in with your ChurchHub login. Leave blank to run in local mode.
  //   url      : Project URL            (Supabase > Project Settings > API)
  //   anonKey  : the "anon" / "publishable" key. It is safe to publish, because
  //              row-level security protects the data. NEVER paste the
  //              "service_role" / "secret" key here.
  //   churchId : the id of your church row in the `churches` table
  supabase: {
    url: "",
    anonKey: "",
    churchId: "",
  },
};
