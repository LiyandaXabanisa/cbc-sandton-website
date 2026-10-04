# Change Bible Church Sandton website

A simple, mobile first website for Change Bible Church Sandton (CBC Sandton), a branch of Change Bible Church.

* Vision, 2026 theme (Open Doors) and Sunday order of service
* New member registration with consent
* Tithes and offering (payment gateway links go in one config file)
* One Login page: members go to their member area, leaders go to the leaders area
* Member area: update your own details and read church notices
* Leaders area: approve, edit, deactivate, delete, search and export members, invite members to log in, post notices
* Connects to ChurchHub (Supabase) so everything lands in the church's own member list

Planning notes and a launch checklist are in [docs/PROJECT-CONSIDERATIONS.md](docs/PROJECT-CONSIDERATIONS.md).

## How it is put together

```
public/                 The website (static files, this is what gets hosted)
  index.html            Home page
  login.html            Login for members and leaders (also first time activation)
  member.html           Member area
  admin.html            Leaders area (members and notices)
  privacy.html          Privacy notice (draft, needs completing)
  site.config.js        The one file you edit: giving links + ChurchHub connection
  api.js                Talks to either the local server or Supabase
server.js               Local server for demos (saves to the data folder)
supabase/               SQL to run once on the ChurchHub Supabase project
.github/workflows/      Publishes /public to GitHub Pages
```

There are two ways to run it:

| Mode | When | Where data is stored |
| --- | --- | --- |
| Local | Demos and development on your computer | `data/` folder (not committed) |
| ChurchHub (Supabase) | The live site on GitHub Pages | ChurchHub's database |

The site picks the mode automatically: if `site.config.js` has Supabase details it uses ChurchHub, otherwise it uses the local server.

## How logins work

1. Someone registers on the website. They appear as pending.
2. A leader approves them in the leaders area.
3. The leader presses Invite and gets a one time code, and passes it to the member.
4. The member opens the Login page, chooses Activate, and enters their email, the code and a new password.
5. From then on they sign in with email and password and see the member area.

Codes work once, expire after 14 days and lock after 5 wrong tries. Deactivating or deleting a member removes their access straight away.

Leaders sign in with their ChurchHub email and password on the hosted site. In local demo mode, a leader leaves the email empty on the Login page and uses `ADMIN_PASSWORD` from `.env`.

## The demo database (temporary)

GitHub Pages cannot run a database, so until the real ChurchHub database is connected, `public/demo.js` provides a built in **demo database** with sample members, notices and logins. It lives only in the visitor's own browser, and a banner on every page says so.

Demo logins (also available as buttons on the Login page):

| Who | Email | Password |
| --- | --- | --- |
| Leader | `leader@demo.example` | `demo1234` |
| Member | `grace.tau@example.com` | `demo1234` |

Everything works in the demo: registering, approving, inviting a member with a code, activating that login, posting notices, and the member area. In the leaders area, "Reset demo data" puts the sample data back.

When to switch it off:

* It turns itself off as soon as the Supabase details are filled in `site.config.js`.
* Or set `demo: false` in `site.config.js` (visitors then see "opening soon" messages).
* To remove it for good, delete `public/demo.js` and its `<script>` lines.
* It never runs on `localhost`; there you get the real local server. Add `?demo=1` to a page address to try it locally.

Do not leave the demo on for the real launch, because details people type into it are not sent to the church.

## Run it on your computer

```bash
npm install
cp .env.example .env     # then open .env and set ADMIN_PASSWORD
npm start
```

Open http://localhost:3000. Use `npm run dev` if you want the server to restart when you change `server.js`.

## Add your payment links

Open `public/site.config.js` and paste your gateway links between the quotes:

```js
giving: {
  generalLink: "",   // used when a button has no link of its own
  titheLink: "",     // the Tithe button
  offeringLink: "",  // the Offering button
},
```

Only `https://` links are accepted. While a link is blank, visitors see a disabled "Link coming soon" button.

## Connect to ChurchHub (Supabase)

1. In the Supabase dashboard for the ChurchHub project, open the SQL editor and run `supabase/website-integration.sql` once. It is safe to run again.
2. In the `churches` table, copy the `id` of your church.
3. In Project Settings > API, copy the Project URL and the `anon` (publishable) key.
4. Put the three values in `public/site.config.js` under `supabase`.

Never paste the `service_role` or secret key into this project. The anon key is meant to be public, because row level security stops visitors from reading anything.

Supabase settings worth checking (Authentication section):

* Email confirmation: if it is on, new members must click a confirmation email before they can finish activating. Supabase's built in email sender is heavily limited, so for the live site set up your own SMTP provider. If it is off, activation finishes in one step and the invite code is what proves who the person is.
* Leaders need a ChurchHub account that belongs to your church. Anyone else who signs up gets no access to any data.

## Put it on GitHub Pages

GitHub Pages only hosts static files, which is why the live version uses Supabase as its back end instead of `server.js`.

The workflow in `.github/workflows/pages.yml` publishes `public/` on every push to `main`. In the repository, go to Settings > Pages and set Source to GitHub Actions. All links are relative, so the site works from `https://USERNAME.github.io/REPO/` and from a custom domain.

GitHub Pages on a free account needs a public repository, so keep secrets out of it. This project already ignores `.env` and `data/`.

## Security notes

* Passwords are stored as salted scrypt hashes, invite codes as hashes, and neither is ever sent to the browser.
* Login, activation and registration are rate limited. Session cookies are HttpOnly and SameSite Strict.
* Member details are shown as plain text only, and CSV exports neutralise spreadsheet formulas.
* Registration needs consent and has a hidden spam trap.
* On the hosted site, members can only call functions that return their own record and their church's published notices. They cannot read other members.
* `data/` and `.env` are never served by the website and are ignored by git.
* Before going live, complete `public/privacy.html` and read the launch checklist.
