// The role permission matrix as executable tests (phase 2, step 1).
import test from "node:test";
import assert from "node:assert/strict";
import { boot, as, fails } from "./harness.mjs";

const FILES = ["01-churchhub-schema.sql", "02-website-integration.sql", "06-services-reminders.sql", "07-sermons.sql", "08-roles.sql"];
const id = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const U = { pastor: id(1), nomsa: id(2), media: id(3), renderer: id(4), member: id(5), leader: id(6), otherChurchManager: id(7), minister: id(8) };
const ITEM_A = id(101), ITEM_B = id(102), KITCHEN = id(201), PW = id(202);
const soon = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString();

let db;
const grant = (uid, target, role, st = null, sid = null, exp = null) =>
  as(db, uid, () => db.query("select grant_role($1,$2,$3,$4,$5) as id", [target, role, st, sid, exp]));
const roleOf = (uid, role, st = null, sid = null) =>
  as(db, uid, async () => (await db.query("select has_role($1,$2,$3) as ok", [role, st, sid])).rows[0].ok);
const refused = /row-level security|policy|permission|violates/i;

test.before(async () => {
  db = await boot(FILES);
  await db.exec(`insert into churches (id, name) values ('${id(900)}', 'Church A'), ('${id(901)}', 'Church B');`);
  for (const [name, uid] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1, $2)", [uid, name + "@example.com"]);
  // everyone except the existing ChurchHub leader and the other church's manager is an active member of Church A
  for (const name of ["pastor", "nomsa", "media", "renderer", "member", "minister"]) {
    await db.query("insert into members (church_id, full_name, email, is_active, user_id) values ($1,$2,$3,true,$4)", [id(900), name, name + "@example.com", U[name]]);
  }
  await db.query("insert into profiles (id, church_id, full_name, role) values ($1,$2,'Church leader','admin')", [U.leader, id(900)]);
  await db.query("insert into members (church_id, full_name, email, is_active, user_id) values ($1,'Other manager','o@example.com',true,$2)", [id(901), U.otherChurchManager]);
  // bootstrap: the first Senior Pastor and Platform Manager are set by the database owner
  await db.query("insert into role_grants (church_id, user_id, role) values ($1,$2,'senior_pastor'), ($1,$3,'platform_manager')", [id(900), U.pastor, U.nomsa]);
  await db.query("insert into role_grants (church_id, user_id, role) values ($1,$2,'platform_manager')", [id(901), U.otherChurchManager]);
});

test("hierarchy: pastor can do anything, managers everything but pastor only actions", async () => {
  assert.equal(await roleOf(U.pastor, "senior_pastor"), true);
  assert.equal(await roleOf(U.pastor, "platform_manager"), true);
  assert.equal(await roleOf(U.pastor, "media_team"), true);
  assert.equal(await roleOf(U.nomsa, "platform_manager"), true);
  assert.equal(await roleOf(U.nomsa, "media_team"), true);
  assert.equal(await roleOf(U.nomsa, "senior_pastor"), false);
});

test("an ordinary member holds no extra roles", async () => {
  for (const r of ["senior_pastor", "platform_manager", "media_team"]) assert.equal(await roleOf(U.member, r), false);
});

test("existing ChurchHub admin leaders still count as platform managers, never as the pastor", async () => {
  assert.equal(await roleOf(U.leader, "platform_manager"), true);
  assert.equal(await roleOf(U.leader, "senior_pastor"), false);
});

test("someone not signed in can not even ask about roles, and sees no grants", async () => {
  await fails(roleOf(null, "media_team"), /permission denied/);
  let rows = [];
  try { rows = (await as(db, null, () => db.query("select * from role_grants"))).rows; } catch (e) { assert.match(String(e.message), /permission denied/); }
  assert.equal(rows.length, 0);
});

test("only the pastor and managers can grant roles", async () => {
  await fails(grant(U.member, U.media, "media_team"), /Only the Senior Pastor or a Platform Manager/);
  await fails(grant(U.media, U.member, "media_team"), /Only the Senior Pastor or a Platform Manager/);
  await grant(U.nomsa, U.media, "media_team");
  assert.equal(await roleOf(U.media, "media_team"), true);
  assert.equal(await roleOf(U.media, "platform_manager"), false);
});

test("only the Senior Pastor can grant the Senior Pastor role", async () => {
  await fails(grant(U.nomsa, U.member, "senior_pastor"), /Only the Senior Pastor/);
  await fails(grant(U.leader, U.member, "senior_pastor"), /Only the Senior Pastor/);
  await grant(U.pastor, U.member, "senior_pastor");
  assert.equal(await roleOf(U.member, "senior_pastor"), true);
  const g = (await db.query("select id from role_grants where user_id=$1 and role='senior_pastor'", [U.member])).rows[0].id;
  await as(db, U.pastor, () => db.query("select revoke_role($1)", [g]));
  assert.equal(await roleOf(U.member, "senior_pastor"), false);
});

test("a manager can only grant to people in their own church", async () => {
  await fails(grant(U.nomsa, U.otherChurchManager, "media_team"), /not in this church/);
  await fails(grant(U.otherChurchManager, U.member, "media_team"), /not in this church/);
});

test("item renderer: needs an end date and a program item, works only for that item", async () => {
  await fails(grant(U.nomsa, U.renderer, "item_renderer", "oos_item", ITEM_A, null), refused);
  await fails(grant(U.nomsa, U.renderer, "item_renderer"), refused);
  await fails(grant(U.nomsa, U.renderer, "item_renderer", "oos_item", ITEM_A, new Date(Date.now() - 1000).toISOString()), /future/);
  await grant(U.nomsa, U.renderer, "item_renderer", "oos_item", ITEM_A, soon());
  assert.equal(await roleOf(U.renderer, "item_renderer", "oos_item", ITEM_A), true);
  assert.equal(await roleOf(U.renderer, "item_renderer", "oos_item", ITEM_B), false);
  assert.equal(await roleOf(U.renderer, "media_team"), false);
});

test("item renderer access ends by itself after the service date", async () => {
  await db.query("update role_grants set granted_at = now() - interval '2 days', expires_at = now() - interval '1 day' where user_id=$1 and role='item_renderer'", [U.renderer]);
  assert.equal(await roleOf(U.renderer, "item_renderer", "oos_item", ITEM_A), false);
  const mine = await as(db, U.renderer, async () => (await db.query("select * from my_roles()")).rows);
  assert.equal(mine.filter((r) => r.role === "item_renderer").length, 0);
});

test("expiry writes one audit row, even if the job runs twice", async () => {
  const first = (await db.query("select expire_grants() as n")).rows[0].n;
  const second = (await db.query("select expire_grants() as n")).rows[0].n;
  assert.equal(first >= 1, true);
  assert.equal(second, 0);
  const rows = (await db.query("select * from audit_log where action='expired' and target_user=$1", [U.renderer])).rows;
  assert.equal(rows.length, 1);
});

test("ministry leader counts as a member of that ministry only", async () => {
  await grant(U.nomsa, U.minister, "ministry_leader", "ministry", KITCHEN);
  assert.equal(await roleOf(U.minister, "ministry_leader", "ministry", KITCHEN), true);
  assert.equal(await roleOf(U.minister, "ministry_member", "ministry", KITCHEN), true);
  assert.equal(await roleOf(U.minister, "ministry_member", "ministry", PW), false);
  assert.equal(await roleOf(U.minister, "ministry_leader", "ministry", PW), false);
});

test("ministry roles need a ministry", async () => {
  await fails(grant(U.nomsa, U.member, "ministry_member"), refused);
  await fails(grant(U.nomsa, U.member, "ministry_member", "oos_item", ITEM_A), refused);
});

test("granting the same role twice does not create a second row", async () => {
  const count = async () => (await db.query("select count(*)::int as n from role_grants where user_id=$1 and role='media_team'", [U.media])).rows[0].n;
  const before = await count();
  await grant(U.nomsa, U.media, "media_team");
  assert.equal(await count(), before);
});

test("nobody can write role_grants or the audit log directly", async () => {
  for (const uid of [U.member, U.media, U.nomsa, U.leader, U.pastor]) {
    await fails(as(db, uid, () => db.query("insert into role_grants (church_id,user_id,role) values ($1,$2,'platform_manager')", [id(900), uid])), refused);
    assert.equal((await as(db, uid, () => db.query("update role_grants set expires_at = null"))).affectedRows, 0);
    assert.equal((await as(db, uid, () => db.query("delete from role_grants"))).affectedRows, 0);
    await fails(as(db, uid, () => db.query("insert into audit_log (church_id, action) values ($1,'forged')", [id(900)])), refused);
  }
});

test("members see only their own grants, managers see the church's", async () => {
  const mine = await as(db, U.media, async () => (await db.query("select user_id from role_grants")).rows);
  assert.equal(mine.every((r) => r.user_id === U.media), true);
  const ordinary = await as(db, U.member, async () => (await db.query("select * from role_grants where user_id <> $1", [U.member])).rows);
  assert.equal(ordinary.length, 0);
  const seen = await as(db, U.nomsa, async () => (await db.query("select distinct church_id from role_grants")).rows);
  assert.deepEqual(seen.map((r) => r.church_id), [id(900)]);
});

test("only managers can list grants and read the audit log", async () => {
  await fails(as(db, U.member, () => db.query("select * from list_role_grants()")), /Only the Senior Pastor or a Platform Manager/);
  assert.equal((await as(db, U.member, () => db.query("select * from audit_log"))).rows.length, 0);
  const list = await as(db, U.nomsa, async () => (await db.query("select * from list_role_grants()")).rows);
  assert.equal(list.length > 0, true);
  assert.equal(list.every((r) => r.full_name), true);
  assert.equal((await as(db, U.nomsa, () => db.query("select * from audit_log"))).rows.length > 0, true);
  assert.equal((await as(db, U.otherChurchManager, () => db.query("select * from audit_log where church_id = $1", [id(900)]))).rows.length, 0);
});

test("revoking: managers can, members cannot, only the pastor revokes the pastor", async () => {
  const g = (await db.query("select id from role_grants where user_id=$1 and role='media_team'", [U.media])).rows[0].id;
  await fails(as(db, U.member, () => db.query("select revoke_role($1)", [g])), /Only the Senior Pastor or a Platform Manager/);
  await as(db, U.nomsa, () => db.query("select revoke_role($1)", [g]));
  assert.equal(await roleOf(U.media, "media_team"), false);
  const pastorGrant = (await db.query("select id from role_grants where user_id=$1 and role='senior_pastor'", [U.pastor])).rows[0].id;
  await fails(as(db, U.nomsa, () => db.query("select revoke_role($1)", [pastorGrant])), /Only the Senior Pastor/);
  await fails(as(db, U.otherChurchManager, () => db.query("select revoke_role($1)", [pastorGrant])), /not found/);
});

test("every grant and revoke is in the audit log with who did it", async () => {
  const rows = (await db.query("select action, actor_id, target_user, role from audit_log where action in ('granted','revoked') order by id")).rows;
  assert.equal(rows.some((r) => r.action === "granted" && r.actor_id === U.nomsa && r.target_user === U.media && r.role === "media_team"), true);
  assert.equal(rows.some((r) => r.action === "revoked" && r.actor_id === U.nomsa && r.target_user === U.media), true);
  assert.equal(rows.every((r) => r.actor_id), true);
});

test("anonymous visitors cannot call any member or role function", async () => {
  const calls = [
    "my_member()", "my_notices()", "my_services()", "my_reminders()", "my_sermons()", "my_roles()", "list_role_grants()",
    "has_role('media_team')", "my_church_id()", "revoke_role('00000000-0000-4000-8000-000000000001')",
    "grant_role('00000000-0000-4000-8000-000000000001','media_team')", "create_member_invite('00000000-0000-4000-8000-000000000001')",
  ];
  for (const c of calls) await fails(as(db, null, () => db.query("select * from " + c)), /permission denied/);
  // the public registration form must still work for visitors
  await fails(as(db, null, () => db.query("select submit_website_registration($1,'','','','',false)", [id(900)])), /tick the box/);
});

test("regular signed in people cannot run the expiry job", async () => {
  await fails(as(db, U.member, () => db.query("select expire_grants()")), /permission denied/);
});
