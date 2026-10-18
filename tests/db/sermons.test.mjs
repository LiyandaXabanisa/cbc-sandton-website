// Sermon Desk permission matrix (phase 2, step 2).
import test from "node:test";
import assert from "node:assert/strict";
import { boot, as, fails } from "./harness.mjs";

const FILES = ["01-churchhub-schema.sql", "02-website-integration.sql", "06-services-reminders.sql", "07-sermons.sql", "08-roles.sql", "09-sermon-desk.sql"];
const id = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const CH = id(900), OTHER = id(901);
const U = { pastor: id(1), nomsa: id(2), media: id(3), member: id(5), outsider: id(7), inactive: id(9), leader: id(6) };
const S = { members: id(301), mediaOnly: id(302), draft: id(303), pub: id(304), otherChurch: id(305), forService: id(306) };
const SERVICE = id(401);
const refused = /row-level security|policy|permission|violates/i;

let db;
const list = (uid, q = null, series = null) =>
  as(db, uid, async () => (await db.query("select id, title from search_sermons($1,$2)", [q, series])).rows.map((r) => r.id));
const q1 = (uid, sql, params = []) => as(db, uid, async () => (await db.query(sql, params)).rows);

test.before(async () => {
  db = await boot(FILES);
  await db.query("insert into churches (id, name) values ($1,'Church A'), ($2,'Church B')", [CH, OTHER]);
  for (const [n, uid] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1,$2)", [uid, n + "@example.com"]);
  for (const n of ["pastor", "nomsa", "media", "member"]) {
    await db.query("insert into members (church_id, full_name, email, is_active, user_id) values ($1,$2,$3,true,$4)", [CH, n, n + "@example.com", U[n]]);
  }
  await db.query("insert into members (church_id, full_name, email, is_active, user_id) values ($1,'inactive','i@example.com',false,$2)", [CH, U.inactive]);
  await db.query("insert into members (church_id, full_name, email, is_active, user_id) values ($1,'outsider','o@example.com',true,$2)", [OTHER, U.outsider]);
  await db.query("insert into profiles (id, church_id, full_name, role) values ($1,$2,'Leader','admin')", [U.leader, CH]);
  await db.query("insert into role_grants (church_id, user_id, role) values ($1,$2,'senior_pastor'), ($1,$3,'platform_manager'), ($1,$4,'media_team')", [CH, U.pastor, U.nomsa, U.media]);
  await db.query("insert into services (id, church_id, title, starts_at) values ($1,$2,'Sunday Service', now() + interval '2 days')", [SERVICE, CH]);
  const ins = (sid, church, title, vis, pub, extra = {}) =>
    db.query("insert into sermons (id, church_id, title, preached_on, visibility, is_published, speaker, scripture, series, topic, notes, service_id, video_url) values ($1,$2,$3,'2026-10-11',$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [sid, church, title, vis, pub, extra.speaker ?? null, extra.scripture ?? null, extra.series ?? null, extra.topic ?? null, extra.notes ?? null, extra.service ?? null, extra.video ?? null]);
  await ins(S.members, CH, "Open Doors", "members", true, { speaker: "Pastor Khoza", scripture: "Revelation 3:8", series: "Doors", topic: "Opportunity", notes: "We walk through doors." });
  await ins(S.mediaOnly, CH, "Slides for Sunday", "managers_media", true, { scripture: "John 3:16", service: SERVICE });
  await ins(S.draft, CH, "Draft message", "members", false);
  await ins(S.otherChurch, OTHER, "Other church sermon", "members", true);
});

test("members see members-only sermons, not media-only ones, not drafts", async () => {
  const ids = await list(U.member);
  assert.deepEqual(ids, [S.members]);
});

test("the media team sees members and media-only sermons, not drafts", async () => {
  const ids = (await list(U.media)).sort();
  assert.deepEqual(ids, [S.members, S.mediaOnly].sort());
});

test("managers and the pastor see everything in their church, including drafts, never another church's", async () => {
  for (const uid of [U.nomsa, U.pastor, U.leader]) {
    const ids = (await list(uid)).sort();
    assert.deepEqual(ids, [S.members, S.mediaOnly, S.draft].sort());
  }
});

test("another church's member sees only their own church", async () => {
  assert.deepEqual(await list(U.outsider), [S.otherChurch]);
});

test("an inactive member sees nothing", async () => {
  assert.deepEqual(await list(U.inactive), []);
});

test("members cannot read the sermons table directly, and cannot write it", async () => {
  assert.equal((await q1(U.member, "select * from sermons")).length, 0);
  assert.equal((await q1(U.media, "select * from sermons")).length, 0);
  await fails(as(db, U.member, () => db.query("insert into sermons (church_id, title, preached_on) values ($1,'x','2026-10-01')", [CH])), refused);
  await fails(as(db, U.media, () => db.query("insert into sermons (church_id, title, preached_on) values ($1,'x','2026-10-01')", [CH])), refused);
  assert.equal((await as(db, U.member, () => db.query("update sermons set title = 'hacked'"))).affectedRows, 0);
  assert.equal((await as(db, U.member, () => db.query("delete from sermons"))).affectedRows, 0);
});

test("a Platform Manager without a ChurchHub profile can post and edit sermons", async () => {
  await as(db, U.nomsa, () => db.query("insert into sermons (church_id, title, preached_on, visibility, is_published) values ($1,'Posted by Nomsa','2026-10-18','members',true)", [CH]));
  assert.equal((await q1(U.nomsa, "select * from sermons where title = 'Posted by Nomsa'")).length, 1);
  await as(db, U.nomsa, () => db.query("update sermons set topic = 'Faith' where title = 'Posted by Nomsa'"));
  assert.equal((await q1(U.member, "select topic from search_sermons('Posted by Nomsa')"))[0].topic, "Faith");
});

test("a manager cannot post into another church", async () => {
  await fails(as(db, U.nomsa, () => db.query("insert into sermons (church_id, title, preached_on) values ($1,'x','2026-10-01')", [OTHER])), refused);
});

test("only the Senior Pastor can make a sermon public", async () => {
  await fails(as(db, U.nomsa, () => db.query("insert into sermons (id, church_id, title, preached_on, visibility, is_published) values ($1,$2,'Public try','2026-10-01','public',true)", [S.pub, CH])), /Only the Senior Pastor/);
  await fails(as(db, U.leader, () => db.query("update sermons set visibility='public' where id=$1", [S.members])), /Only the Senior Pastor/);
  await as(db, U.pastor, () => db.query("insert into sermons (id, church_id, title, preached_on, visibility, is_published, video_url) values ($1,$2,'Public message','2026-10-01','public',true,'https://youtu.be/dQw4w9WgXcQ')", [S.pub, CH]));
  const pub = await q1(null, "select * from public_sermons($1)", [CH]);
  assert.deepEqual(pub.map((r) => r.id), [S.pub]);
  // a manager may still edit other fields of a public sermon, but not publish more sermons publicly
  await as(db, U.nomsa, () => db.query("update sermons set topic='Grace' where id=$1", [S.pub]));
});

test("public sermons list never exposes other visibilities or other churches", async () => {
  const pub = await q1(null, "select * from public_sermons($1)", [CH]);
  assert.equal(pub.every((r) => r.id === S.pub), true);
  assert.equal((await q1(null, "select * from public_sermons($1)", [OTHER])).length, 0);
});

test("search finds scripture, topic and notes, ignores case, and respects visibility", async () => {
  assert.deepEqual(await list(U.member, "revelation 3"), [S.members]);
  assert.deepEqual(await list(U.member, "OPPORTUNITY"), [S.members]);
  assert.deepEqual(await list(U.member, "walk through doors"), [S.members]);
  assert.deepEqual(await list(U.member, "john 3"), []);           // media-only
  assert.deepEqual(await list(U.media, "john 3"), [S.mediaOnly]);
  assert.deepEqual(await list(U.member, "Doors", "Doors"), [S.members]);
  assert.deepEqual(await list(U.member, "100%"), []);              // wildcards are plain characters
  assert.deepEqual(await list(U.member, "%"), []);
});

test("series list only contains series the person may read", async () => {
  assert.deepEqual((await q1(U.member, "select series from sermon_series()")).map((r) => r.series), ["Doors"]);
  assert.deepEqual((await q1(U.outsider, "select series from sermon_series()")).map((r) => r.series), []);
});

test("attachments follow the sermon's visibility", async () => {
  const addFile = (sermon, path) =>
    db.query("insert into sermon_files (church_id, sermon_id, file_name, content_type, size_bytes, storage_path) values ($1,$2,'notes.pdf','application/pdf',1000,$3)", [CH, sermon, path]);
  await addFile(S.members, CH + "/a/notes.pdf");
  await addFile(S.mediaOnly, CH + "/b/slides.pdf");
  for (const p of ["a/notes.pdf", "b/slides.pdf"]) await db.query("insert into storage.objects (bucket_id, name) values ('sermon-files', $1)", [CH + "/" + p]);
  const names = async (uid) => (await q1(uid, "select name from storage.objects where bucket_id='sermon-files' order by name")).map((r) => r.name);
  assert.deepEqual(await names(U.member), [CH + "/a/notes.pdf"]);                       // a member cannot open the media-only file by its address
  assert.deepEqual(await names(U.media), [CH + "/a/notes.pdf", CH + "/b/slides.pdf"]);
  assert.deepEqual(await names(U.nomsa), [CH + "/a/notes.pdf", CH + "/b/slides.pdf"]);
  assert.deepEqual(await names(U.outsider), []);
  assert.deepEqual(await names(null).catch(() => []), []);
  assert.equal((await q1(U.member, "select * from sermon_files_for($1)", [S.members])).length, 1);
  assert.equal((await q1(U.member, "select * from sermon_files_for($1)", [S.mediaOnly])).length, 0);
  assert.equal((await q1(U.media, "select * from sermon_files_for($1)", [S.mediaOnly])).length, 1);
  assert.equal((await q1(U.member, "select file_count from search_sermons('Open Doors')"))[0].file_count, 1);
});

test("only managers can upload or delete sermon files, and only inside their own church folder", async () => {
  const put = (uid, name) => as(db, uid, () => db.query("insert into storage.objects (bucket_id, name) values ('sermon-files', $1)", [name]));
  await fails(put(U.member, CH + "/c/x.pdf"), refused);
  await fails(put(U.media, CH + "/c/x.pdf"), refused);
  await fails(put(U.nomsa, OTHER + "/c/x.pdf"), refused);
  await put(U.nomsa, CH + "/c/x.pdf");
  const del = (uid) => as(db, uid, () => db.query("delete from storage.objects where name = $1", [CH + "/c/x.pdf"]));
  assert.equal((await del(U.member)).affectedRows, 0);
  assert.equal((await del(U.media)).affectedRows, 0);
  assert.equal((await del(U.nomsa)).affectedRows, 1);
});

test("file records can only be written by managers", async () => {
  await fails(as(db, U.member, () => db.query("insert into sermon_files (church_id, sermon_id, file_name, size_bytes, storage_path) values ($1,$2,'x',1,'p1')", [CH, S.members])), refused);
  await fails(as(db, U.media, () => db.query("insert into sermon_files (church_id, sermon_id, file_name, size_bytes, storage_path) values ($1,$2,'x',1,'p2')", [CH, S.members])), refused);
  await as(db, U.nomsa, () => db.query("insert into sermon_files (church_id, sermon_id, file_name, size_bytes, storage_path) values ($1,$2,'x',1,'p3')", [CH, S.members]));
});

test("the file bucket is private, limited in size and in file types", async () => {
  const b = (await db.query("select * from storage.buckets where id='sermon-files'")).rows[0];
  assert.equal(b.public, false);
  assert.equal(Number(b.file_size_limit), 26214400);
  assert.equal(b.allowed_mime_types.includes("application/pdf"), true);
  assert.equal(b.allowed_mime_types.some((t) => /javascript|html|svg|executable/.test(t)), false);
});

test("publishing for the first time notifies the media team and managers, once", async () => {
  await db.query("delete from notifications");
  await as(db, U.nomsa, () => db.query("insert into sermons (id, church_id, title, preached_on, visibility, is_published, speaker, service_id) values ($1,$2,'Notify me','2026-10-25','managers_media',true,'Pastor Khoza',$3)", [S.forService, CH, SERVICE]));
  const who = (await db.query("select user_id from notifications order by user_id")).rows.map((r) => r.user_id).sort();
  // the media team member, the senior pastor and the church leader; not the author (Nomsa), not ordinary members
  assert.deepEqual(who, [U.pastor, U.media, U.leader].sort());
  const n = (await db.query("select * from notifications where user_id=$1", [U.media])).rows[0];
  assert.match(n.title, /New sermon material: Notify me/);
  assert.match(n.body, /Pastor Khoza/);
  assert.match(n.body, /For the service on/);
  // editing it later does not notify again
  await as(db, U.nomsa, () => db.query("update sermons set topic = 'Updated' where id = $1", [S.forService]));
  assert.equal((await db.query("select count(*)::int as n from notifications")).rows[0].n, 3);
});

test("drafts do not notify, and publishing a draft later does", async () => {
  await db.query("delete from notifications");
  await as(db, U.nomsa, () => db.query("update sermons set topic='draft edit' where id=$1", [S.draft]));
  assert.equal((await db.query("select count(*)::int as n from notifications")).rows[0].n, 0);
  await as(db, U.nomsa, () => db.query("update sermons set is_published = true where id=$1", [S.draft]));
  assert.equal((await db.query("select count(*)::int as n from notifications")).rows[0].n > 0, true);
});

test("each person sees only their own notifications and can mark them read", async () => {
  const mine = await q1(U.media, "select * from my_notifications()");
  assert.equal(mine.length > 0, true);
  assert.equal((await q1(U.member, "select * from my_notifications()")).length, 0);
  assert.equal((await q1(U.member, "select * from notifications")).length, 0);
  await as(db, U.media, () => db.query("select mark_notifications_read()"));
  assert.equal((await q1(U.media, "select * from my_notifications() where read_at is null")).length, 0);
  await fails(as(db, U.member, () => db.query("insert into notifications (church_id, user_id, kind, title) values ($1,$2,'x','forged')", [CH, U.member])), refused);
});

test("anonymous visitors can only call the public sermon list", async () => {
  for (const c of ["search_sermons()", "my_sermons()", "sermon_series()", "my_notifications()", "can_read_sermon('" + S.members + "')", "sermon_files_for('" + S.members + "')"]) {
    await fails(as(db, null, () => db.query("select * from " + c)), /permission denied/);
  }
});
