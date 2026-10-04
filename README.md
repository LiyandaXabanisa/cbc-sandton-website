# Change Bible Church Sandton website

A simple, mobile first website for Change Bible Church Sandton (CBC Sandton), a branch of Change Bible Church.

* Vision, 2026 theme (Open Doors) and Sunday order of service
* New member registration with consent
* Tithes and offering (payment gateway links go in one config file)
* Members area for church leaders: approve, edit, deactivate, delete, search, export CSV
* Connects to ChurchHub (Supabase) so registrations land in the church's member list

Planning notes and a launch checklist are in [docs/PROJECT-CONSIDERATIONS.md](docs/PROJECT-CONSIDERATIONS.md).

## How it is put together

```
public/                 The website (static files, this is what gets hosted)
  index.html            Home page
  admin.html            Members area
  privacy.html          Privacy notice (draft, needs completing)
  site.config.js        The one file you edit: giving links + ChurchHub connection
  api.js                Talks to either the local server or Supabase
server.js               Local server for demos (saves to data/members.json)
supabase/               SQL to run once on the ChurchHub Supabase project
.github/workflows/      Publishes /public to GitHub Pages
```

There are two ways to run it:

| Mode | When | Where members are stored |
| --- | --- | --- |
| Local | Demos and development on your computer | `data/members.json` (not committed) |
| ChurchHub (Supabase) | The live site on GitHub Pages | ChurchHub's `members` table |

The site picks the mode automatically: if `site.config.js` has Supabase details it uses ChurchHub, otherwise it uses the local server.

## Run it on your computer

```bash
npm install
cp .env.example .env     # then open .env and set ADMIN_PASSWORD
npm start
```

Open http://localhost:3000. The members area is at http://localhost:3000/admin.html and signs in with the password from `.env`.

Use `npm run dev` if you want the server to restart when you change `server.js`.

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

1. In the Supabase dashboard for the ChurchHub project, open the SQL editor and run `supabase/website-integration.sql` once.
2. In the `churches` table, copy the `id` of your church.
3. In Project Settings > API, copy the Project URL and the `anon` (publishable) key.
4. Put the three values in `public/site.config.js` under `supabase`.

Never paste the `service_role` or secret key into this project. The anon key is meant to be public, because row level security stops visitors from reading anything.

How it behaves once connected:

* A visitor registers on the website and a pending member appears in ChurchHub.
* A leader signs in at `admin.html` with their ChurchHub email and password, approves the member, and they become an active member in the app.

## Put it on GitHub Pages

GitHub Pages only hosts static files, which is why the live version uses Supabase as its back end instead of `server.js`.

1. Create a new empty repository on GitHub (no README). GitHub Pages on a free account needs a public repository, so keep secrets out of it. This project already ignores `.env` and `data/`.
2. Connect this folder to it and push:

   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
   git branch -M main
   git push -u origin main
   ```

3. In the repository, go to Settings > Pages and set Source to GitHub Actions.
4. Every push to `main` now republishes the site. The address will be `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

All links in the site are relative, so it works from that sub folder address and from a custom domain.

## Security notes

* The local members area is protected by `ADMIN_PASSWORD`, a rate limit and an HttpOnly session cookie. Use a long password.
* Member details are shown as plain text only, and CSV exports neutralise spreadsheet formulas.
* Registration needs consent, has a hidden spam trap and is rate limited.
* `data/members.json` and `.env` are never served by the website and are ignored by git.
* Before going live, complete `public/privacy.html` and read the launch checklist.
