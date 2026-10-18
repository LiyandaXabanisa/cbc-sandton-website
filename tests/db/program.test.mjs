// Weekly Program permission matrix (phase 2, step 3).
import test from "node:test";
import assert from "node:assert/strict";
import { boot, as, fails } from "./harness.mjs";

const FILES = ["01-churchhub-schema.sql", "02-website-integration.sql", "06-services-reminders.sql", "07-sermons.sql", "08-roles.sql", "09-sermon-desk.sql", "11-weekly-program.sql"];
const id = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const CH = id(900), OTHER = id(901);
const U = { pastor: id(1), nomsa: id(2), media: id(3), r1: id(4), r2: id(5), member: id(6), outsider: id(7), inactive: id(8) };
const refused = /row-level security|policy|permission|violates/i;
const manager = /Only the Senior Pastor or a Platform Manager/;

let db, PROG, A, B, C;   // program id and three item ids
const rpc = (uid, fn, args = []) => as(db, uid, async () => (await db.query(`select ${fn}(${args.map((_, i) => "$" + (i + 1)).join(",")}) as v`, args)).rows[0].v);
const q = (uid, sql, params = []) => as(db, uid, async () => (await db.query(sql, params)).rows);
const items = (list) => JSON.stringify(list);
const item = (title, extra = {}) => Object.assign({ title, duration_minutes: 5 }, extra);
const tomorrow = () => new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const itemIds = async () => (await db.query("select id, title from program_items where program_id=$1 order by position", [PROG])).rows;
const grantsFor = async (itemId) => (await db.query("select user_id, expires_at, revoked_at from role_grants where role='item_renderer' and scope_id=$1 order by granted_at", [itemId])).rows;
const notifCount = async () => (await db.query("select count(*)::int as n from notifications where kind='program'")).rows[0].n;

test.before(async () => {
  db = await boot(FILES);
  await db.query("insert into churches (id, name) values ($1,'Church A'), ($2,'Church B')", [CH, OTHER]);
  for (const [n, uid] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1,$2)", [uid, n + "@example.com"]);
  for (const n of ["pastor", "nomsa", "media", "r1", "r2", "member"]) {
    await db.query("insert into members (church_id, full_name, email, is_active, user_id) values ($1,$2,$3,true,$4)", [CH, n, n + "@example.com", U[n]]);
  }
  await db.query("insert into members (church_id, full_name, email, is_active, user_id) values ($1,'outsider','o@example.com',true,$2)", [OTHER, U.outsider]);
  await db.query("insert into members (church_id, full_name, email, is_active, user_id) values ($1,'inactive','i@example.com',false,$2)", [CH, U.inactive]);
  await db.query("insert into role_grants (church_id, user_id, role) values ($1,$2,'senior_pastor'), ($1,$3,'platform_manager'), ($1,$4,'media_team'), ($5,$6,'platform_manager')", [CH, U.pastor, U.nomsa, U.media, OTHER, U.outsider]);
});

test("only managers can create programs, and they validate their input", async () => {
  await fails(rpc(U.member, "create_program", ["Sunday", tomorrow()]), manager);
  await fails(rpc(U.media, "create_program", ["Sunday", tomorrow()]), manager);
  await fails(rpc(U.nomsa, "create_program", ["", tomorrow()]), /title/);
  await fails(rpc(U.nomsa, "create_program", ["Sunday", null]), /when the service starts/);
  await fails(rpc(U.nomsa, "create_program", ["Sunday", tomorrow(), id(555)]), /service was not found/);
  PROG = await rpc(U.nomsa, "create_program", ["Sunday 25 October", tomorrow()]);
  assert.equal((await db.query("select version from programs where id=$1", [PROG])).rows[0].version, 1);
});

test("a manager saves items; order, times and ids are kept, and each save is a version", async () => {
  const v = await rpc(U.nomsa, "save_program", [PROG, null, null, items([item("Welcome", { duration_minutes: 5 }), item("Worship", { duration_minutes: 25, department: "Praise and Worship", notes: "Key of G" }), item("Offering")]), "First draft"]);
  assert.equal(v, 2);
  const rows = await itemIds();
  assert.deepEqual(rows.map((r) => r.title), ["Welcome", "Worship", "Offering"]);
  [A, B, C] = rows.map((r) => r.id);
  const hist = await q(U.nomsa, "select version, summary, changed_by_name from program_history($1)", [PROG]);
  assert.deepEqual(hist.map((h) => h.version), [2, 1]);
  assert.equal(hist[0].summary, "First draft");
  assert.equal(hist[0].changed_by_name, "nomsa");
});

test("reordering keeps the same item ids and records a new version", async () => {
  const v = await rpc(U.nomsa, "save_program", [PROG, null, null, items([{ id: B, title: "Worship", duration_minutes: 25, department: "Praise and Worship", notes: "Key of G" }, { id: A, title: "Welcome", duration_minutes: 5 }, { id: C, title: "Offering", duration_minutes: 5 }]), "Worship first"]);
  assert.equal(v, 3);
  assert.deepEqual((await itemIds()).map((r) => r.id), [B, A, C]);
});

test("restoring an old version brings the old order back and counts as a new version", async () => {
  const hist = await q(U.nomsa, "select id, version from program_history($1)", [PROG]);
  const first = hist.find((h) => h.version === 2).id;
  const v = await rpc(U.nomsa, "restore_program_version", [first]);
  assert.equal(v, 4);
  assert.deepEqual((await itemIds()).map((r) => r.id), [A, B, C]);
  const top = (await q(U.nomsa, "select summary from program_history($1) limit 1", [PROG]))[0];
  assert.equal(top.summary, "Restored version 2");
});

test("only managers can save, publish, delete, or read history; other churches get nothing", async () => {
  for (const uid of [U.member, U.media, U.r1]) {
    await fails(rpc(uid, "save_program", [PROG, null, null, "[]"]), manager);
    await fails(rpc(uid, "publish_program", [PROG, true]), manager);
    await fails(rpc(uid, "delete_program", [PROG]), manager);
    await fails(q(uid, "select * from program_history($1)", [PROG]), manager);
  }
  await fails(rpc(U.outsider, "save_program", [PROG, null, null, "[]"]), /not found/);
  await fails(rpc(U.outsider, "publish_program", [PROG, true]), /not found/);
  await fails(rpc(U.outsider, "delete_program", [PROG]), /not found/);
});

test("items are validated", async () => {
  await fails(rpc(U.nomsa, "save_program", [PROG, null, null, items([item("")])]), /needs a title/);
  await fails(rpc(U.nomsa, "save_program", [PROG, null, null, items([item("x", { duration_minutes: 0 })])]), /length/);
  await fails(rpc(U.nomsa, "save_program", [PROG, null, null, items([item("x", { duration_minutes: 601 })])]), /length/);
  await fails(rpc(U.nomsa, "save_program", [PROG, null, null, items([item("x", { presenter_id: U.outsider })])]), /active member with a login/);
  await fails(rpc(U.nomsa, "save_program", [PROG, null, null, items([item("x", { presenter_id: U.inactive })])]), /active member with a login/);
  await fails(rpc(U.nomsa, "save_program", [PROG, null, null, items(Array.from({ length: 61 }, (_, i) => item("i" + i)))]), /at most 60/);
  await fails(rpc(U.nomsa, "save_program", [PROG, null, null, '"not a list"']), /must be a list/);
  assert.equal((await itemIds()).length, 3);   // none of the bad saves changed anything
});

test("naming a presenter gives them the item role until the end of the service day, and only for that item", async () => {
  await rpc(U.nomsa, "save_program", [PROG, null, null, items([{ id: A, title: "Welcome" }, { id: B, title: "Worship", presenter_id: U.r1, duration_minutes: 25 }, { id: C, title: "Offering", presenter_id: U.r2 }]), "Assigned presenters"]);
  const g = await grantsFor(B);
  assert.equal(g.length, 1);
  assert.equal(g[0].user_id, U.r1);
  const end = (await db.query("select service_day_end(starts_at) as e from programs where id=$1", [PROG])).rows[0].e;
  assert.equal(new Date(g[0].expires_at).getTime(), new Date(end).getTime());
  const has = (uid, it) => as(db, uid, async () => (await db.query("select has_role('item_renderer','oos_item',$1) as ok", [it])).rows[0].ok);
  assert.equal(await has(U.r1, B), true);
  assert.equal(await has(U.r1, C), false);
  assert.equal(await has(U.r2, C), true);
  assert.equal(await has(U.member, B), false);
  assert.equal((await db.query("select count(*)::int as n from audit_log where action='granted' and role='item_renderer' and target_user=$1", [U.r1])).rows[0].n, 1);
});

test("changing or removing a presenter takes the role away at once", async () => {
  await rpc(U.nomsa, "save_program", [PROG, null, null, items([{ id: A, title: "Welcome" }, { id: B, title: "Worship", presenter_id: U.r2, duration_minutes: 25 }, { id: C, title: "Offering" }])]);
  const gb = await grantsFor(B);
  assert.equal(gb.find((x) => x.user_id === U.r1).revoked_at !== null, true);
  assert.equal(gb.find((x) => x.user_id === U.r2).revoked_at, null);
  assert.equal((await grantsFor(C))[0].revoked_at !== null, true);
  // taking the item out of the program removes the role too
  await rpc(U.nomsa, "save_program", [PROG, null, null, items([{ id: A, title: "Welcome" }, { id: C, title: "Offering" }])]);
  assert.equal((await grantsFor(B)).every((x) => x.revoked_at !== null), true);
  // put it back for the next tests
  await rpc(U.nomsa, "save_program", [PROG, null, null, items([{ id: A, title: "Welcome" }, { title: "Worship", presenter_id: U.r1, duration_minutes: 25 }, { id: C, title: "Offering", presenter_id: U.r2 }]), "Back again"]);
  [A, B, C] = (await itemIds()).map((r) => r.id);
});

test("moving the service date moves the end of access, and a date in the past gives no access", async () => {
  const later = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
  await rpc(U.nomsa, "save_program", [PROG, null, later, items([{ id: A, title: "Welcome" }, { id: B, title: "Worship", presenter_id: U.r1, duration_minutes: 25 }, { id: C, title: "Offering", presenter_id: U.r2 }])]);
  const end = (await db.query("select service_day_end(starts_at) as e from programs where id=$1", [PROG])).rows[0].e;
  const active = (await grantsFor(B)).filter((x) => x.revoked_at === null);
  assert.equal(new Date(active[0].expires_at).getTime(), new Date(end).getTime());
  // a brand new program for last week: presenters get nothing
  const past = await rpc(U.nomsa, "create_program", ["Old service", new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()]);
  await rpc(U.nomsa, "save_program", [past, null, null, items([item("Old item", { presenter_id: U.r1 })])]);
  const oldItem = (await db.query("select id from program_items where program_id=$1", [past])).rows[0].id;
  assert.equal((await grantsFor(oldItem)).length, 0);
  await rpc(U.nomsa, "delete_program", [past]);
});

test("members see a published program without notes; drafts are invisible to them", async () => {
  assert.equal((await q(U.member, "select * from list_programs()")).length, 0);
  assert.equal(await rpc(U.member, "get_program", [PROG]), null);
  assert.equal((await q(U.nomsa, "select * from list_programs()")).length, 1);
  await rpc(U.nomsa, "publish_program", [PROG, true]);
  assert.equal((await q(U.member, "select * from list_programs()")).length, 1);
  const prog = await rpc(U.member, "get_program", [PROG]);
  assert.equal(prog.items.length, 3);
  assert.equal(prog.items.every((i) => i.notes === null), true);
  assert.equal(prog.items.every((i) => i.presenter_id === null), true);       // user ids stay private
  assert.equal(prog.items.find((i) => i.title === "Worship").presenter_name, "r1");
  assert.equal((await q(U.inactive, "select * from list_programs()")).length, 0);
  assert.equal((await q(U.outsider, "select * from list_programs()")).length, 0);
  assert.equal(await rpc(U.outsider, "get_program", [PROG]), null);
});

test("notes: managers and the media team see all; a presenter sees only their own item's", async () => {
  await rpc(U.nomsa, "save_program", [PROG, null, null, items([{ id: A, title: "Welcome", notes: "Greeters at doors" }, { id: B, title: "Worship", presenter_id: U.r1, duration_minutes: 25, notes: "Key of G" }, { id: C, title: "Offering", presenter_id: U.r2, notes: "Ushers ready" }]), "Notes added"]);
  const notes = async (uid) => Object.fromEntries((await rpc(uid, "get_program", [PROG])).items.map((i) => [i.title, i.notes]));
  assert.deepEqual(await notes(U.nomsa), { Welcome: "Greeters at doors", Worship: "Key of G", Offering: "Ushers ready" });
  assert.deepEqual(await notes(U.media), { Welcome: "Greeters at doors", Worship: "Key of G", Offering: "Ushers ready" });
  assert.deepEqual(await notes(U.r1), { Welcome: null, Worship: "Key of G", Offering: null });
  assert.deepEqual(await notes(U.member), { Welcome: null, Worship: null, Offering: null });
});

test("my items lists only my own, only for published programs, only upcoming", async () => {
  const mine = await q(U.r1, "select item_title, can_upload from my_items()");
  assert.deepEqual(mine.map((r) => r.item_title), ["Worship"]);
  assert.equal(mine[0].can_upload, true);
  assert.equal((await q(U.member, "select * from my_items()")).length, 0);
  await rpc(U.nomsa, "publish_program", [PROG, false]);
  assert.equal((await q(U.r1, "select * from my_items()")).length, 0);
  await rpc(U.nomsa, "publish_program", [PROG, true]);
});

const upload = (uid, itemId, name = "slides.pdf") => {
  const path = `${CH}/${itemId}/abc${Math.random().toString(16).slice(2, 8)}/${name}`;
  return as(db, uid, async () => {
    await db.query("insert into storage.objects (bucket_id, name) values ('program-files', $1)", [path]);
    await db.query("insert into program_item_files (church_id, item_id, file_name, content_type, size_bytes, storage_path, uploaded_by) values ($1,$2,$3,'application/pdf',1000,$4,$5)", [CH, itemId, name, path, uid]);
    return path;
  });
};

test("a presenter can upload to their own item, and only theirs", async () => {
  const path = await upload(U.r1, B);
  assert.match(path, new RegExp(B));
  await fails(upload(U.r1, C), refused);          // someone else's item
  await fails(upload(U.r1, A), refused);          // an item with no presenter
  await fails(upload(U.member, B), refused);
  await fails(upload(U.media, B), refused);       // the media team reads, it does not upload
  await fails(as(db, U.r1, () => db.query("insert into program_item_files (church_id,item_id,file_name,size_bytes,storage_path,uploaded_by) values ($1,$2,'x',1,'p-forged',$3)", [CH, C, U.r1])), refused);
  await fails(as(db, U.r1, () => db.query("insert into program_item_files (church_id,item_id,file_name,size_bytes,storage_path,uploaded_by) values ($1,$2,'x',1,'p-forged2',$3)", [CH, B, U.r2])), refused);  // cannot upload in someone else's name
});

test("a presenter whose service day has passed can no longer upload", async () => {
  await db.query("update role_grants set granted_at = now() - interval '3 days', expires_at = now() - interval '1 day' where user_id=$1 and role='item_renderer' and scope_id=$2", [U.r1, B]);
  await fails(upload(U.r1, B), refused);
  // and the item is no longer on their list or readable by them
  assert.equal((await q(U.r1, "select * from item_files_for($1)", [B])).length, 0);
  // put the grant back for the next tests
  await db.query("update role_grants set granted_at = now() - interval '1 hour', expires_at = now() + interval '2 days' where user_id=$1 and role='item_renderer' and scope_id=$2", [U.r1, B]);
});

test("files are readable by managers, the media team and the presenter of that item only", async () => {
  await upload(U.r2, C, "lyrics.pdf");
  const names = (uid) => q(uid, "select name from storage.objects where bucket_id='program-files' order by name").then((r) => r.length);
  assert.equal(await names(U.nomsa), 2);
  assert.equal(await names(U.media), 2);
  assert.equal(await names(U.r1), 1);
  assert.equal(await names(U.r2), 1);
  assert.equal(await names(U.member), 0);
  assert.equal(await names(U.outsider), 0);
  assert.equal((await q(U.r1, "select * from item_files_for($1)", [B])).length, 1);
  assert.equal((await q(U.r1, "select * from item_files_for($1)", [C])).length, 0);
  assert.equal((await q(U.media, "select * from item_files_for($1)", [C])).length, 1);
  assert.equal((await q(U.member, "select * from item_files_for($1)", [B])).length, 0);
});

test("a presenter can remove their own file while their access lasts, nobody else can", async () => {
  const f = (await db.query("select id from program_item_files where item_id=$1", [B])).rows[0].id;
  assert.equal((await as(db, U.member, () => db.query("delete from program_item_files where id=$1", [f]))).affectedRows, 0);
  assert.equal((await as(db, U.media, () => db.query("delete from program_item_files where id=$1", [f]))).affectedRows, 0);
  assert.equal((await as(db, U.r2, () => db.query("delete from program_item_files where id=$1", [f]))).affectedRows, 0);
  assert.equal((await as(db, U.r1, () => db.query("delete from program_item_files where id=$1", [f]))).affectedRows, 1);
});

test("the program tables cannot be read or written directly except by managers", async () => {
  for (const uid of [U.member, U.media, U.r1, U.outsider]) {
    for (const t of ["programs", "program_items", "program_versions"]) assert.equal((await q(uid, `select * from ${t}`)).length, 0);
    await fails(as(db, uid, () => db.query("insert into programs (church_id,title,starts_at) values ($1,'x',now())", [CH])), refused);
    await fails(as(db, uid, () => db.query("insert into program_items (program_id,church_id,position,title) values ($1,$2,9,'x')", [PROG, CH])), refused);
    assert.equal((await as(db, uid, () => db.query("update program_items set title='hacked'"))).affectedRows, 0);
    assert.equal((await as(db, uid, () => db.query("delete from programs"))).affectedRows, 0);
  }
  assert.equal((await q(U.nomsa, "select * from programs")).length, 1);
  assert.equal((await q(U.outsider, "select * from programs")).length, 0);
});

test("notifications: publishing and later changes reach the media team, managers and presenters, never ordinary members or the author", async () => {
  await db.query("delete from notifications");
  await rpc(U.nomsa, "publish_program", [PROG, false]);
  await rpc(U.nomsa, "publish_program", [PROG, true]);
  const who = (await db.query("select user_id from notifications where kind='program'")).rows.map((r) => r.user_id).sort();
  assert.deepEqual(who, [U.pastor, U.media, U.r1, U.r2].sort());        // not Nomsa (the author), not the member
  await db.query("delete from notifications");
  await rpc(U.nomsa, "save_program", [PROG, null, null, items([{ id: A, title: "Welcome", notes: "Greeters at doors" }, { id: B, title: "Worship!", presenter_id: U.r1, duration_minutes: 25, notes: "Key of G" }, { id: C, title: "Offering", presenter_id: U.r2, notes: "Ushers ready" }]), "Renamed worship"]);
  const after = (await db.query("select user_id, title, body from notifications where kind='program'")).rows;
  assert.deepEqual(after.map((r) => r.user_id).sort(), [U.pastor, U.media, U.r1, U.r2].sort());
  assert.match(after[0].title, /Program updated/);
  assert.equal(after[0].body, "Renamed worship");
  // saving without any change tells nobody
  await db.query("delete from notifications");
  await rpc(U.nomsa, "save_program", [PROG, null, null, items([{ id: A, title: "Welcome", notes: "Greeters at doors" }, { id: B, title: "Worship!", presenter_id: U.r1, duration_minutes: 25, notes: "Key of G" }, { id: C, title: "Offering", presenter_id: U.r2, notes: "Ushers ready" }])]);
  assert.equal(await notifCount(), 0);
});

test("a draft program changes without telling anyone", async () => {
  await rpc(U.nomsa, "publish_program", [PROG, false]);
  await db.query("delete from notifications");
  await rpc(U.nomsa, "save_program", [PROG, "Sunday renamed", null, items([{ id: A, title: "Welcome" }, { id: B, title: "Worship!", presenter_id: U.r1, duration_minutes: 25 }, { id: C, title: "Offering", presenter_id: U.r2 }])]);
  assert.equal(await notifCount(), 0);
  await rpc(U.nomsa, "publish_program", [PROG, true]);
});

test("copying a program keeps the order but not the presenters", async () => {
  const copy = await rpc(U.nomsa, "create_program", ["Next Sunday", new Date(Date.now() + 8 * 24 * 3600 * 1000).toISOString(), null, PROG]);
  const rows = (await db.query("select title, presenter_id, presenter_name from program_items where program_id=$1 order by position", [copy])).rows;
  assert.deepEqual(rows.map((r) => r.title), ["Welcome", "Worship!", "Offering"]);
  assert.equal(rows.every((r) => r.presenter_id === null), true);
  await fails(rpc(U.outsider, "create_program", ["Steal", tomorrow(), null, PROG]).then(() => q(U.nomsa, "select 1")).then(async () => { const n = (await db.query("select count(*)::int as n from program_items i join programs p on p.id=i.program_id where p.church_id=$1", [OTHER])).rows[0].n; if (n === 0) throw new Error("nothing copied across churches"); }), /nothing copied/);
  await rpc(U.nomsa, "delete_program", [copy]);
});

test("deleting a program takes the presenters' roles away", async () => {
  const p = await rpc(U.nomsa, "create_program", ["Temp", tomorrow()]);
  await rpc(U.nomsa, "save_program", [p, null, null, items([item("Solo", { presenter_id: U.member })])]);
  const it = (await db.query("select id from program_items where program_id=$1", [p])).rows[0].id;
  assert.equal((await grantsFor(it)).filter((g) => g.revoked_at === null).length, 1);
  await rpc(U.nomsa, "delete_program", [p]);
  assert.equal((await grantsFor(it)).every((g) => g.revoked_at !== null), true);
});

test("anonymous visitors cannot call any program function", async () => {
  const calls = ["list_programs()", "my_items()", "get_program('" + PROG + "')", "program_history('" + PROG + "')", "item_files_for('" + A + "')",
    "create_program('x', now())", "save_program('" + PROG + "', null, null, '[]')", "publish_program('" + PROG + "', true)", "delete_program('" + PROG + "')",
    "can_read_program('" + PROG + "')", "can_read_item_details('" + A + "')", "notify_program('" + PROG + "','x','y',null)", "sync_item_grants('" + PROG + "')", "require_manager()"];
  for (const c of calls) await fails(as(db, null, () => db.query("select * from " + c)), /permission denied/);
});

test("signed in people cannot call the internal helpers", async () => {
  for (const c of ["notify_program('" + PROG + "','x','y',null)", "sync_item_grants('" + PROG + "')", "require_manager()", "program_audience('" + CH + "')", "snapshot_program('" + PROG + "')"]) {
    await fails(as(db, U.nomsa, () => db.query("select * from " + c)), /permission denied/);
  }
});
