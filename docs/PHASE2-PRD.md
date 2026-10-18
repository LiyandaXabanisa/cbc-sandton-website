# Phase 2 product spec: roles, ministry workspaces and the church hub

Branch: `phase2-platform`. Nothing here is on the live site until it is merged into `main`.

## 1. Goal

One place where authority is clear, the pastor's teaching lives digitally, the weekly program runs without email or WhatsApp chains, and each ministry has a workspace shaped to how it works. It replaces sending the Order of Service (OOS) to the media team by hand.

## 2. How it is built (and why it differs from the first draft)

The first draft named React, tRPC, Drizzle and a custom backend. The church site is hosted on xneelo as static files, which cannot run that kind of server. The platform therefore keeps the stack that already works:

* Pages: plain HTML, CSS and JavaScript in `public/` (fast on mobile data, no build step).
* Data, logins, files, scheduled jobs: Supabase (Postgres, Auth, Storage, scheduled jobs).
* Permissions: Postgres row level security and security definer functions, so every rule is enforced by the database, not by the page. The page only hides buttons.
* Tests: the permission matrix is written as executable SQL tests (section 9) and run against a throwaway Supabase project or local Postgres.
* Email and reminders: a scheduled job plus a mail service (Resend free tier) once the church has a sending address.

## 3. Roles

Highest authority first.

| Role | Who | Can do |
|---|---|---|
| Senior Pastor | Pastor FJK Khoza | Everything. Publishes sermon content. Oversees all workspaces. |
| Platform Manager | Nomsa Dlamini plus three delegates (names to be confirmed) | Builds and edits the weekly program, reorders items, assigns presenters, manages reminders and ministry rotations. |
| Media Team | Multimedia ministry members | Read and download everything published for upcoming services. |
| Item Renderer | Anyone scheduled to present on a date | Upload to their own item only, from when they are scheduled until the end of that service date. |
| Ministry Team Member | Members of a ministry | Their own ministry workspace only, under its rules. May belong to several ministries. |
| Member | Everyone else | Public and member content. Interacts where allowed. |

Notes:

* A person can hold several roles at once, for example Member, Media Team and Item Renderer.
* Roles are assigned only by the Senior Pastor and Platform Managers.
* Existing leaders (ChurchHub profiles with the admin role) are treated as Platform Managers until the new roles are in place.

## 4. Permission records (foundation, Must have)

Every grant is a row: `user_id`, `role`, `scope_type`, `scope_id`, `granted_at`, `expires_at`, `granted_by`. Time limited access, such as an Item Renderer, is a row with an `expires_at`. Expiry is checked inside the database on every read and write, so a missing cleanup job can never leave access open.

An audit table records every grant, revocation and expiry: who, what, when, and why.

User stories and acceptance criteria:

* As a Platform Manager, I assign Thandi to the 15:00 testimony slot so that she can upload her slides for that item.
  * Thandi can upload to that item only.
  * After the service date ends, her upload attempts are refused, even with a saved link.
  * The grant and its expiry appear in the audit log.
* As the Senior Pastor, I make someone a Platform Manager so that the program can be run in my absence.
  * Only the Senior Pastor or an existing Platform Manager can do this.
  * A normal Member cannot, even by calling the database directly.

## 5. Features, priority and acceptance criteria

Priorities use MoSCoW: Must, Should, Could.

### 5.1 Sermon Desk and Teaching Library (Must)

* Pastor posts one entry per sermon: title, date, speaker, series, scripture, topic, rich text notes, attachments (PowerPoint, PDF, images), YouTube link for the recording.
* Searchable by date, series, scripture reference and topic.
* Visibility per post: Media and Managers only, all members, or public. Default: all members. Only the Senior Pastor changes it to public.
* Media Team and Platform Managers are notified when sermon material is published.

Acceptance:

* A Member cannot open a media only file by direct address.
* Publishing a sermon for an upcoming service makes it appear for the Media Team without any email.
* Search for "John 3" finds sermons whose scripture field contains John 3.

### 5.2 Weekly Program and OOS calendar (Must)

* Managers build each service as time slotted items with presenter, duration and departments.
* Drag and drop reordering. Every change is saved as a version (who, what, when), can be compared and rolled back.
* Changes notify the media team, presenters and affected ministries.
* Assigning a presenter creates their time limited Item Renderer access.
* Presenters see their items on their dashboard with an upload panel.
* Print and PDF export of the OOS.

Acceptance:

* Reordering two items creates one new version with an author and time.
* Rolling back restores the earlier order and records a new version.
* A renderer whose date has passed cannot upload.

### 5.3 Praise and Worship workspace (Must)

* Song library with lyrics, keys and versions. Set list per service linked to OOS items.
* Lyrics reach the media team automatically.
* Weekly colour planner shown on team dashboards and sent as a reminder.
* Mid week changes notify everyone tagged.

### 5.4 Soup Kitchen workspace (Must)

* Teams of three, rotating monthly, defined by a Platform Manager.
* Only the team leader admits or removes people for that month.
* Task delegation with checklists, assignees and due dates.
* Reminders before each month changes, to the outgoing and incoming teams.

Acceptance: a Soup Kitchen member cannot see another team's workspace.

### 5.5 Youth Community feed (Must, built last)

* Open to everyone aged 15 and over. Date of birth is declared at registration. A youth leader approves access.
* Feed of text, photos, scripture and questions, with reactions and threaded comments. Topic rooms with pinned posts.
* Moderation: hide or remove posts, mute users, a report queue with resolution tracking.

### 5.6 Benevolence Ministry (Should)

* Private workspace. Requests are visible only to the ministry team, who triage, assign and mark them fulfilled.
* Pledge and contribution tracking and delivery logistics.
* Could: a discreet contribute link that never identifies the recipient.

### 5.7 Grief and Bereavement Ministry (Should)

* Members submit a notice. The ministry verifies it before it is published.
* Family contact details and visit schedules are limited to the ministry team and Platform Managers. The congregation sees only the published announcement.

### 5.8 Intercessors Prayer Hub (Should)

* Prayer wall with categories (healing, family, church, nation), a counter of how many are covering each request, and testimonies.
* Prayer chains for urgent requests with one tap "I'm praying".
* Intercession rota with reminders.
* Privacy per request: public, members only, or intercessors only. Anonymous posting allowed.
* Our original feature: a "Still praying" check in, where the requester can mark a request answered and the people who prayed are told, which turns the wall into a record of answered prayer.

### 5.9 Teens Ministry (Should)

* Safe, moderated learning space: lessons, memory verses, quizzes and discussion questions posted by teens leaders only.
* Every comment is checked by a leader before it shows.
* Ages: 13 to 17. People aged 15 to 17 can also request the Youth Community.

### 5.10 Notifications (Must)

* In app notification centre and email, with per user preferences. WhatsApp and push are Could.
* Powers: program changes, colour planner, rotations, new sermon material, prayer chains.

## 6. Safeguarding (Must)

* Users under 18 are flagged. There are no private one to one messages in the platform at all.
* Anything involving minors happens only in public, moderated spaces. Every moderation action is logged.
* Youth leaders and Platform Managers must be adults who have been vetted by the church before they get moderation rights.

## 7. Data protection and POPIA (Must)

* Consent at registration (already in place). Collect only what is needed.
* Benevolence, bereavement and prayer data is restricted to the ministry team and Platform Managers.
* Members can view and delete their own data.
* Storing the date of birth is needed for the 15 plus rule. It is shown only to the youth leaders and managers.
* Recommended: a short legal review of the privacy notice before the youth feed, benevolence and bereavement features go live.

## 8. Data model (outline)

Existing: churches, profiles, members, notices, services, reminders, sermons.

New: `roles_grants` (the permission records above), `audit_log`, `ministries`, `ministry_members`, `sermon_files`, `oos_services`, `oos_items`, `oos_versions`, `item_uploads`, `songs`, `set_lists`, `colour_plans`, `kitchen_teams`, `kitchen_tasks`, `benevolence_requests`, `bereavement_notices`, `prayer_requests`, `prayer_responses`, `intercession_rota`, `teen_lessons`, `feed_posts`, `feed_comments`, `feed_reports`, `notifications`, `notification_prefs`.

All files live in Supabase Storage in private buckets. Downloads use short lived signed links that are issued only after a permission check.

## 9. Tests (the permission matrix is mandatory)

Each role is exercised against each feature, and the expected result is written as an executable test. Examples:

* A Member cannot read a media only sermon file by its storage address.
* A renderer cannot upload to an item after its service date, and cannot upload to someone else's item.
* A Soup Kitchen member of team A cannot read team B's tasks.
* Only the Senior Pastor and Platform Managers can create or revoke grants.
* A minor cannot create a private message, because the feature does not exist.
* Every grant, revoke and expiry writes an audit row.

## 10. Build order

1. Roles, time scoped permissions, audit log and the permission tests.
2. Sermon Desk and library (extends the sermon library already built).
3. Weekly program and OOS with versions, then presenter uploads.
4. Praise and Worship, linked to the program.
5. Soup Kitchen, Intercessors and Teens.
6. Benevolence and Grief and Bereavement.
7. Youth Community.

Each step is released on its own, after the permission tests for it pass.

## 11. Decisions

Settled:

* Nomsa Dlamini is a Platform Manager. Title to be confirmed.
* Sermon visibility default: members only, public set by the Senior Pastor.
* Teens 13 to 17. Youth Community 15 and over. Ages 15 to 17 may use both.
* Stack: Supabase and the existing pages, not React and tRPC.

Still needed from the church:

* Names of the three Platform Manager delegates.
* Nomsa's official title.
* The church sending address for email notifications.
* Who the vetted youth leaders will be.
