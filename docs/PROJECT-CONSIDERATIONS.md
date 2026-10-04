# Church website: what to think about

A working checklist for the Change Bible Church Sandton website. Items marked [x] are already handled in this project. Items marked [ ] are open and need a decision or some work from the church.

This is a planning aid, not legal or tax advice. Where the law is involved, check with a lawyer, your accountant or the official regulator before launch.


## 1. Purpose and audience

The website has a few jobs. Decide which matter most, because that decides what goes at the top of the home page.

* [x] Tell visitors when and where Sunday services happen
* [x] Share the vision and the yearly theme
* [x] Let new people register their details
* [x] Let people give tithes and offerings
* [x] Give leaders a simple way to manage members
* [ ] Agree who the main audience is: first time visitors, existing members, or both
* [ ] Agree what one action you most want a visitor to take (visit on Sunday, register, or give)
* [ ] Decide whether this site speaks for CBC Sandton only or for the whole Change Bible Church

## 2. Content and who owns it

Websites go stale when nobody is responsible for them.

* [ ] Name one person who owns the content and one backup
* [ ] Decide how often Sunday times, announcements and the theme are reviewed
* [x] Real street address added to the Visit section, with a directions link
* [ ] Confirm the address is complete (it reads "76 Bevan", so check whether it needs Road, Street or Avenue)
* [ ] Add the church phone number and email address (also needed in the privacy notice)
* [ ] Add a map link or directions, plus parking and accessibility information
* [ ] Confirm the Bible translation used for the theme verses and add the correct attribution
* [ ] Check the translation publisher's rules for quoting scripture on a website
* [ ] Get permission from the main church before using its name and logo on a separate site
* [ ] Decide whether leaders' names appear publicly (they were removed from the Sunday order for now)
* [ ] Get written consent before publishing photos or videos of people, and extra care with children
* [ ] Prepare an "About us" section: leadership, beliefs, history, the link to the main church

## 3. Brand and design

* [x] Logo cut out cleanly from the order of service, with navy and gold versions
* [x] Colours taken from the logo (navy) with gold as the accent
* [x] Light and dark appearance both work
* [ ] Ask the church for the original logo files (vector or high resolution) to replace the extracted one
* [ ] Agree the tone of voice: warm, plain language, no jargon
* [ ] Keep the written copy human: avoid stock phrases and heavy punctuation that reads as machine written

## 4. Mobile, accessibility and speed

Most members will open this on a phone, often on mobile data, which is expensive in South Africa.

* [x] Designed mobile first, tested at phone width
* [x] Large tap targets and a simple menu
* [x] Keyboard focus is visible, there is a skip link, and motion respects the reduced motion setting
* [x] No heavy images or video on the home page
* [ ] Test on a low cost Android phone and on a slow connection
* [ ] Check text contrast on every colour combination before launch
* [ ] Consider hosting the fonts yourself (the page currently loads them from Google, which is an extra request and shares visitor IP addresses with Google)
* [ ] Add descriptive text for any new photos you add
* [ ] Decide on languages: English only, or also isiZulu, Sesotho or others used in the congregation

## 5. Members, registration and personal data (POPIA)

The Protection of Personal Information Act (POPIA) applies as soon as the site collects names, emails or phone numbers. A church's membership list can also reveal religious belief, which POPIA treats with extra care.

* [x] Registration asks only for what is needed: name and an email or phone number
* [x] A consent box is required, with the date and time recorded
* [x] A draft privacy notice page exists and is linked from the form
* [x] Registrations arrive as "pending" so a leader reviews them before they become members
* [x] The form does not reveal whether an email is already on the list
* [ ] Complete the privacy notice and have it reviewed
* [ ] Appoint an Information Officer and check whether they must be registered with the Information Regulator
* [ ] Check the rules for religious organisations processing information about their members
* [ ] Decide how long personal information is kept and how someone asks to be removed
* [ ] Make sure a parent or guardian registers anyone under 18
* [ ] If you will send newsletters or WhatsApp broadcasts, get separate opt in consent for that
* [ ] Decide where data is stored and whether it leaves South Africa (see hosting below)
* [ ] Keep a short written record of who can see member data and why
* [ ] Know what to do if data is lost or exposed (who is told, and how quickly)

## 5B. The existing membership list

* [x] The 2026 spreadsheet (89 members) has been checked and import files prepared outside the project
* [x] Three rows need a leader's attention: one incomplete email, one doubtful phone number, and two people sharing one email
* [ ] Fix those three records after the import (they carry a note)
* [ ] Decide whether home addresses are needed at all; if yes, add an address field first and treat it as more sensitive than a phone number
* [ ] Tell current members how their details are used and where they are kept, because they did not tick the website's consent box
* [ ] Keep the spreadsheet and the import files private; delete the import files from Downloads once the import is done
* [ ] Two people sharing one email can only have one member login between them, so one of them needs a different email
* [ ] Never put member details in GitHub, the website folder or a chat

## 5A. Member logins and notices

* [x] One Login page for members and leaders, each sent to the right area
* [x] Members get a login only through a one time invite code from a leader, so a stranger cannot claim someone else's record
* [x] Codes expire after 14 days and lock after 5 wrong tries
* [x] Members can change only their own name and phone, never their status or anyone else's details
* [x] Deactivating or deleting a member cuts off their access straight away
* [x] Leaders can post, hide and delete notices that only signed-in members can read
* [ ] Decide who is allowed to invite members and post notices (every ChurchHub staff login can)
* [ ] Decide what belongs in notices: nothing about named individuals, no medical or counselling details
* [ ] Agree what happens when someone loses their password (a leader can issue a new invite today; a password reset email needs your own email sending set up)
* [ ] Set up an email sender (SMTP) for the Supabase project before launch, because the built in sender is heavily limited
* [ ] Decide whether email confirmation should be on for new logins
* [ ] Tell members how to activate: ask a leader for a code, then use Login > Activate
* [ ] Later: members updating their own email, prayer requests, event sign up, giving history

## 6. Tithes and offerings

The site does not take payments itself. It sends people to your payment gateway's page, which keeps card details off the church website.

* [x] Separate Tithe and Offering buttons, plus a general fallback link
* [x] Links live in `public/site.config.js`, only secure https links are accepted
* [x] Buttons show "Link coming soon" until a link is added
* [ ] Add the payment links when ready
* [ ] Confirm the gateway account belongs to the church, with named signatories on the bank account
* [ ] Understand the gateway fees and how long settlement takes
* [ ] Decide whether you want once off giving only, or recurring giving too
* [ ] Check that the gateway page shows the church name, so givers trust it
* [ ] Agree how tithes and offerings are told apart so finance can reconcile them (separate links help)
* [ ] Decide how givers get receipts
* [ ] Ask your accountant whether the church is approved to issue Section 18A tax certificates, and how that works with the gateway
* [ ] Test a small real payment in test mode first, then once live
* [ ] Decide who watches for failed or suspicious payments
* [ ] Consider adding bank (EFT) details as an alternative for people who prefer it

## 7. Using the church platform (ChurchHub on Supabase)

* [x] Registrations can flow into ChurchHub's members list through one safe database function
* [x] Visitors cannot read or change member records directly
* [x] The members area signs in with ChurchHub logins, so there is no second password to manage
* [x] Approving a registration makes it a normal active member in the app
* [ ] Confirm the ChurchHub Supabase project exists and the original schema has been run
* [ ] Run `supabase/website-integration.sql` once
* [ ] Copy the church id, project URL and anon key into `public/site.config.js`
* [ ] Never use the service role (secret) key anywhere in the website
* [ ] Decide whether website sign ups should be members or visitors in ChurchHub
* [ ] Decide whether giving should be recorded in ChurchHub's finance screen, and who enters it
* [ ] Choose the Supabase region carefully for data location
* [ ] Check what the free Supabase plan does when a project is idle, because a paused project would make registration fail
* [ ] Check whether leaders need different permissions (ChurchHub currently has admin and staff roles)

## 8. Security

* [x] Members area needs a login; the local version uses a password from `.env`
* [x] Rate limits on registration and sign in
* [x] Member details are displayed as plain text only, and CSV exports neutralise spreadsheet formulas
* [x] `.env` and the member data file are never served and never committed
* [x] Basic security headers on the local server
* [ ] Use long, unique passwords for every leader account, and turn on two step sign in where offered (GitHub, Supabase, the domain registrar)
* [ ] Never share one login between several people
* [ ] Remove access promptly when a leader steps down
* [ ] Consider a CAPTCHA or similar if spam registrations start to appear
* [ ] Keep dependencies updated (`npm audit` now and then)
* [ ] Keep recovery emails and phone numbers for all accounts up to date

## 9. Hosting, domain and email

* [x] Repository and automatic publishing to GitHub Pages are set up
* [x] All links are relative, so the site works under a repository address or a custom domain
* [ ] Create the GitHub repository and push (see README)
* [ ] Remember that GitHub Pages on a free account needs a public repository, so nothing private can be inside it
* [ ] Register a proper domain, for example a .co.za or .org.za name, in the church's name, not a personal one
* [ ] Point the domain at GitHub Pages and switch on HTTPS
* [ ] Set up church email addresses on the domain (info@ and an Information Officer address)
* [ ] Decide who holds the registrar, GitHub and Supabase accounts, and record this somewhere safe

## 10. Visibility and sharing

* [x] Page titles and a description for search results
* [ ] Add a Google Business Profile so the church shows on maps
* [ ] Add social media and WhatsApp channel links
* [ ] Add a social sharing image (the logo on navy works well)
* [ ] Decide whether analytics is wanted; if so choose a privacy friendly one and mention it in the privacy notice
* [x] Structured data added for search engines (church name, address, website); add service times later

## 11. Running it week to week

* [ ] Who approves new registrations, and how fast should someone be contacted?
* [ ] Who follows up with first time visitors, and how is that tracked?
* [ ] Export the member list regularly as a backup (the Export CSV button does this)
* [ ] Check what backups Supabase provides on your plan
* [ ] Agree how Sunday times and announcements get updated, and who has permission to edit the code
* [ ] Keep the footer year and the yearly theme current

## 12. Costs to expect

* [ ] Domain name: yearly
* [ ] GitHub Pages: free for public repositories
* [ ] Supabase: free tier first, paid plan if you need backups or no pausing
* [ ] Payment gateway: per transaction fees
* [ ] Email hosting if you want church addresses on your own domain
* [ ] Someone's time for updates

## 13. Testing before launch

* [x] Registration, validation, duplicate handling and spam trap tested
* [x] Members area tested: sign in, approve, edit, deactivate, delete, search, export
* [x] Giving links tested with and without a link set
* [x] Phone width layout checked
* [ ] Test the live Supabase connection with a real registration and a real leader login
* [ ] Test on iPhone Safari and Android Chrome
* [ ] Test the payment links end to end
* [ ] Ask two or three members who are not technical to try it and watch where they hesitate

## 13A. Demo database

* [x] A temporary demo database lets the whole site be tried out on GitHub Pages
* [x] A banner on every page says it is sample data and nothing is sent to the church
* [ ] Connect the real database (this switches the demo off by itself)
* [ ] Confirm the demo banner is gone on the live site before telling anyone to register
* [ ] Delete `public/demo.js` and its script lines once the real database is in use

## 14. Launch checklist

1. Content: real address, phone, email, directions, leadership information
2. Giving: payment links added and tested
3. Platform: Supabase SQL run, three config values added, test registration appears in ChurchHub
4. Privacy: notice completed and reviewed, Information Officer named
5. Domain and HTTPS working, church email working
6. Two step sign in switched on for every account
7. Test registration deleted from the member list
8. A named person owns updates, and a backup person knows how

## 15. Ideas for later

* Events and announcements that leaders can edit without touching code
* Sermon archive, audio or livestream link
* Small groups and ministries, with sign up
* Prayer request form (treat as sensitive and decide who can read it)
* Newsletter or WhatsApp broadcast sign up with proper opt in
* Online check in using the QR codes ChurchHub already supports
* Giving reports for leadership
* A second language
