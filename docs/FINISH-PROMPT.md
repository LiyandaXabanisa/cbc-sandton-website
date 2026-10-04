# Prompt: finish the CBC Sandton website as a fast, mobile first app

Paste everything below the line into a new Claude Code session opened in this project folder.

---

You are finishing the website and member platform for Change Bible Church Sandton (CBC Sandton), a branch of Change Bible Church. The goal is a launch at https://cbcsandton.co.za as a very fast, simple, mobile first web app that members can install on their phone, with registration, member logins, a leaders area, notices and giving, backed by the church's own database.

## Read first
README.md, docs/PROJECT-CONSIDERATIONS.md, public/site.config.js, .github/workflows/pages.yml and .github/workflows/xneelo.yml, supabase/website-integration.sql, scripts/import_members.py. Check the project memory notes if you have them.

## Current state (treat as fact, verify before relying on it)
* Static site in public/: plain HTML, CSS and vanilla JS, no build step. Pages: index, login, member (members), admin (leaders), privacy, 404.
* public/api.js hides two back ends behind one interface: a local Express server (server.js, for demos only) and Supabase (the real database, shared with the church's ChurchHub app). public/demo.js is a temporary sample database that runs only on github.io and must be deleted before launch.
* Live preview: https://liyandaxabanisa.github.io/cbc-sandton-website/ (GitHub repo LiyandaXabanisa/cbc-sandton-website, GitHub Pages from main).
* Production target: xneelo Standard web hosting for cbcsandton.co.za. Apache, SFTP on port 22, hosting server www524.jnb1.host-h.net, web root public_html. The workflow .github/workflows/xneelo.yml uploads public/ once the repository secrets XNEELO_FTP_USER and XNEELO_FTP_PASSWORD exist. The server key is pinned in .github/xneelo_known_hosts. The domain already points at xneelo and serves xneelo's placeholder index.html.
* Not done yet: the Supabase project does not exist; the church phone number and email are missing; the street name is incomplete ("76 Bevan"); public/privacy.html still has [bracketed] placeholders; all three giving buttons use one SnapScan link; 89 existing members are ready to import with scripts/import_members.py.

## Rules that never bend
1. Look and copy: light theme with a white background, navy text, gold accents, sentence case headings. No em dashes, en dashes or spaced hyphens in any copy, comment or document. No exclamation marks in messages.
2. Mobile first. Design and test at 360 and 375 px wide first, then tablet and desktop. Tap targets at least 44 px. Inputs at least 16 px so iOS does not zoom. No sideways scrolling.
3. Keep it simple. No framework or build step unless a measurement proves it is needed. Every new dependency needs a written reason.
4. Personal data (POPIA): the repository is public. Never commit, print, paste or log member details, passwords, keys, the membership spreadsheet or import files. Use only the Supabase anon key, never the service_role key. Secrets are set by me in my own terminal with `gh secret set` and never typed to you.
5. Ask before anything outward or irreversible: publishing, creating accounts, sending messages, deleting data, changing DNS. I type all passwords myself. Do not try to get past bot checks or CAPTCHAs.
6. Verify, do not assume. Run the tests, measure in a real browser at phone width, and say plainly what you could not test.

## Do the work in this order (small steps: do, verify, commit, push)

### A. Make it an installable mobile app (PWA)
* Add manifest.webmanifest (name, short_name "CBC Sandton", start_url and scope relative so it works at the domain root and at the GitHub preview sub path, display standalone, white theme and background, 192 and 512 icons plus a maskable icon made from the emblem).
* Add a small service worker with relative paths: versioned cache, cache first for static assets, network first for HTML and site.config.js, never cache /api, Supabase requests or anything with a login. Add an offline page. Make sure a new release replaces the old cache cleanly.
* Add iOS tags (apple-touch-icon, apple-mobile-web-app-capable, status bar) and a gentle "Add to home screen" hint for Android (beforeinstallprompt) and iOS (instructions). No push notifications unless I ask.

### B. Speed and efficiency
* Self host the fonts as subsetted Latin woff2 files (drop unused weights, font-display swap, preload the critical one) so the site makes no third party requests. If needed, cut to two families.
* Convert the logo to SVG or WebP, add width and height to images, lazy load anything below the fold, defer scripts, remove unused CSS and JS.
* In public/.htaccess add compression (mod_deflate) and sensible cache headers: long for versioned assets, short for HTML and site.config.js. Keep every block wrapped in IfModule.
* Targets on a mid range Android phone with slow 4G emulation: Lighthouse mobile Performance 95 or more, Accessibility 100, Best Practices 95 or more, SEO 100, installable as a PWA; LCP under 2.0 s; CLS 0; home page under 250 KB transferred; under 30 KB of JavaScript.

### C. Mobile polish
* Tap to call, email and WhatsApp links once I give you the numbers. Keep "Get directions".
* Consider one small sticky action bar on the home page for phones (Directions, Give, Register) only if it does not crowd the page. Judge it on a real phone width.
* Respect safe area insets and reduced motion. Add an "Add to calendar" file for Sunday service.
* Leaders area and member area must be comfortable one handed on a phone.

### D. The real database (needs me for the account steps)
* Walk me through creating the Supabase project with a church email address (Cape Town region if offered). I create the account.
* Then: run supabase/website-integration.sql, fill url, anonKey and churchId in public/site.config.js, set the Auth site URL to https://cbcsandton.co.za, help me choose email confirmation and set up SMTP.
* Import the 89 members: run scripts/import_members.py with --write and --church-id, run the generated SQL in the Supabase editor, fix the 3 flagged records (incomplete email, doubtful phone, two people on one email), then tell me to delete the import files.
* Test the whole journey with real accounts on a real phone: register, leader approves, invite, activate, login, edit details, read a notice, sign out. Prove a member cannot see other members.
* Remove the demo: delete public/demo.js and its script tags, and set demo to false.

### E. Content
* Add the church phone, email and the full street name once I provide them. Finish public/privacy.html (Information Officer, retention, provider and region). Add social links I provide.
* Update the structured data and the sharing tags to match.

### F. Launch on xneelo
* Tell me exactly which two `gh secret set` commands to run. After I run them, run the xneelo workflow, watch it, and confirm https://cbcsandton.co.za shows the new site, http redirects to https, the 404 page works, and there are no redirect loops.
* Check the certificate covers the bare domain and www, and add a www to bare domain redirect only if it does.
* Help me create the church mailboxes in xneelo and use them in the privacy notice.
* Switch on two step sign in for xneelo, GitHub and Supabase.

### G. Handover
* One page for leaders (non technical): approve a registration, invite a member, post a notice, export the list.
* One page for the church office: how to update text, Sunday times and the theme, how uploads work, where backups are, and the yearly tasks (theme update, domain renewal in May 2027).
* Move the repository into a church owned GitHub organization if I have created one, and list who owns each account.

## Done means
* Every measurable target above is met and shown with evidence.
* A member can complete the full journey on a real phone. Keyboard and basic screen reader checks pass. No console errors.
* A search of the repository finds no secrets or member details. The demo is gone from cbcsandton.co.za.
* The tests pass (npm start then the existing API tests, plus new tests for anything you add).

## How to report
After each step give a short summary: what changed, how you verified it, what was not tested, and what you need from me. End with a launch checklist showing done, waiting on me, or blocked.
