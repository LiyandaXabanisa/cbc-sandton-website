// Soup Kitchen workspace permission matrix (phase 2, step 5).
import test from "node:test";
import assert from "node:assert/strict";
import { boot, as, fails } from "./harness.mjs";

const FILES = ["01-churchhub-schema.sql", "02-website-integration.sql", "06-services-reminders.sql", "07-sermons.sql", "08-roles.sql", "09-sermon-desk.sql", "11-weekly-program.sql", "12-praise-worship.sql", "13-soup-kitchen.sql"];
const id = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const CH = id(900), OTHER = id(901);
const U = { nomsa: id(2), lead: id(3), v1: id(4), v2: id(5), v3: id(6), v4: id(7), lead2: id(8), plain: id(9), outsider: id(10), outVol: id(11) };
const refused = /row-level security|policy|permission|violates/i;
const leaderOnly = /Only the team leader/;
const manager = /Only the Senior Pastor or a Platform Manager/;

let db, SOUP, M0, M1, M2;     // soup kitchen ministry id, month ids (this month, next, the one after)
const rpc = (uid, fn, args = []) => as(db, uid, async () => (await db.query(`select ${fn}(${args.map((_, i) => "$" + (i + 1) + (typeof args[i] === "object" && args[i] !== null ? "::jsonb" : "")).join(",")}) as v`, args.map((a) => (typeof a === "object" && a !== null ? JSON.stringify(a) : a)))).rows[0].v);
const q = (uid, sql, params = []) => as(db, uid, async () => (await db.query(sql, params)).rows);
const notifs = async (uid) => (await db.query("select title, body from notifications where kind='kitchen' and user_id=$1 order by created_at", [uid])).rows;
const iso = (d) => d.toISOString().slice(0, 10);
const monthStart = async (offset) => iso((await db.query("select (kitchen_current_month() + ($1 || ' months')::interval)::date as d", [offset])).rows[0].d);

test.before(async () => {
  db = await boot(FILES);
  await db.query("insert into churches (id, name) values ($1,'Church A'), ($2,'Church B')", [CH, OTHER]);
  for (const [n, uid] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1,$2)", [uid, n + "@example.com"]);
  for (const n of ["nomsa", "lead", "v1", "v2", "v3", "v4", "lead2", "plain"]) {
    await db.query("insert into members (church_id, full_name, email, is_active, user_id) values ($1,$2,$3,true,$4)", [CH, n, n + "@example.com", U[n]]);
  }
  for (const n of ["outsider", "outVol"]) await db.query("insert into members (church_id, full_name, email, is_active, user_id) values ($1,$2,$3,true,$4)", [OTHER, n, n + "@example.com", U[n]]);
  await db.exec(`insert into ministries (church_id, slug, name, colour, description)
    select c.id, 'soup-kitchen', 'Soup Kitchen', '#c26a1a', 'x' from churches c on conflict (church_id, slug) do nothing;`);
  SOUP = (await db.query("select id from ministries where church_id=$1 and slug='soup-kitchen'", [CH])).rows[0].id;
  const OSOUP = (await db.query("select id from ministries where church_id=$1 and slug='soup-kitchen'", [OTHER])).rows[0].id;
  await db.query("insert into role_grants (church_id, user_id, role) values ($1,$2,'platform_manager'), ($3,$4,'platform_manager')", [CH, U.nomsa, OTHER, U.outsider]);
  for (const n of ["lead", "v1", "v2", "v3", "v4", "lead2"]) {
    await db.query("insert into role_grants (church_id, user_id, role, scope_type, scope_id) values ($1,$2,'ministry_member','ministry',$3)", [CH, U[n], SOUP]);
  }
  await db.query("insert into role_grants (church_id, user_id, role, scope_type, scope_id) values ($1,$2,'ministry_member','ministry',$3)", [OTHER, U.outVol, OSOUP]);
});

test("only managers set the rotation, and the leader must be a Soup Kitchen volunteer", async () => {
  const m0 = await monthStart(0), m1 = await monthStart(1);
  for (const uid of [U.lead, U.v1, U.plain]) await fails(rpc(uid, "save_kitchen_month", [m0, U.lead, "Team A"]), manager);
  await fails(rpc(U.nomsa, "save_kitchen_month", [m0, U.plain, "Team A"]), /Soup Kitchen ministry role/);   // a member, but not a volunteer
  await fails(rpc(U.nomsa, "save_kitchen_month", [m0, U.outVol, "Team A"]), /active member with a login/);   // another church
  await fails(rpc(U.nomsa, "save_kitchen_month", [m0, null, "Team A"]), /active member with a login/);
  await fails(rpc(U.nomsa, "save_kitchen_month", [null, U.lead, "Team A"]), /Choose the month/);
  await fails(rpc(U.nomsa, "save_kitchen_month", [await monthStart(-1), U.lead, "Old"]), /already passed/);
  M0 = await rpc(U.nomsa, "save_kitchen_month", [m0.slice(0, 8) + "17", U.lead, "Team A"]);   // a date in the middle of the month is normalised
  assert.equal((await db.query("select month from kitchen_months where id=$1", [M0])).rows[0].month.toISOString().slice(0, 10), m0);
  M1 = await rpc(U.nomsa, "save_kitchen_month", [m1, U.lead2, "Team B"]);
  M2 = await rpc(U.nomsa, "save_kitchen_month", [await monthStart(2), U.v4, null]);
  assert.equal(await rpc(U.nomsa, "save_kitchen_month", [m0, U.lead, "Team A renamed"]), M0);              // the same month updates, it does not duplicate
  assert.equal((await db.query("select count(*)::int as n from kitchen_months")).rows[0].n, 3);
  assert.equal((await db.query("select count(*)::int as n from kitchen_members where month_id=$1", [M0])).rows[0].n, 1);   // the leader is on the team
  assert.equal((await notifs(U.lead)).length, 1);        // told once, not again when the same leader was saved
});

test("each team sees only its own month; managers see all; others see nothing", async () => {
  assert.notEqual(await rpc(U.lead, "get_kitchen_month", [M0]), null);
  assert.equal(await rpc(U.lead, "get_kitchen_month", [M1]), null);            // not their month
  assert.equal(await rpc(U.lead2, "get_kitchen_month", [M0]), null);
  assert.equal(await rpc(U.v1, "get_kitchen_month", [M0]), null);               // a volunteer not on that team
  assert.equal(await rpc(U.plain, "get_kitchen_month", [M0]), null);
  assert.equal(await rpc(U.outsider, "get_kitchen_month", [M0]), null);         // a manager of another church
  assert.equal(await rpc(U.outVol, "get_kitchen_month", [M0]), null);
  for (const m of [M0, M1, M2]) assert.notEqual(await rpc(U.nomsa, "get_kitchen_month", [m]), null);
  for (const uid of [U.v1, U.plain, U.outsider, U.outVol]) {
    assert.equal((await q(uid, "select * from kitchen_months")).length, 0);
    assert.equal((await q(uid, "select * from kitchen_members")).length, 0);
    assert.equal((await q(uid, "select * from kitchen_tasks")).length, 0);
  }
  assert.deepEqual((await q(U.lead, "select month_id from kitchen_schedule()")).map((r) => r.month_id), [M0]);
  assert.deepEqual((await q(U.lead2, "select month_id from kitchen_schedule()")).map((r) => r.month_id), [M1]);
  assert.equal((await q(U.nomsa, "select * from kitchen_schedule()")).length, 3);
  assert.equal((await q(U.v1, "select * from kitchen_schedule()")).length, 0);
  assert.equal((await q(U.outsider, "select * from kitchen_schedule()")).length, 0);
});

test("only the month's leader can see the volunteer list and admit people", async () => {
  await fails(q(U.v1, "select * from kitchen_pool($1)", [M0]), leaderOnly);
  await fails(q(U.plain, "select * from kitchen_pool($1)", [M0]), leaderOnly);
  await fails(q(U.lead2, "select * from kitchen_pool($1)", [M0]), leaderOnly);       // leader of another month
  const names = (await q(U.lead, "select full_name from kitchen_pool($1)", [M0])).map((r) => r.full_name);
  assert.deepEqual(names, ["lead2", "v1", "v2", "v3", "v4"]);                            // volunteers only, not the plain member, not the leader
  assert.equal((await q(U.nomsa, "select * from kitchen_pool($1)", [M0])).length, 5);     // managers may look
  await fails(rpc(U.nomsa, "admit_kitchen_member", [M0, U.v1]), leaderOnly);            // but managers do not admit
  await fails(rpc(U.v1, "admit_kitchen_member", [M0, U.v1]), leaderOnly);                // nobody lets themselves in
  await fails(rpc(U.lead2, "admit_kitchen_member", [M0, U.v1]), leaderOnly);
});

test("the leader admits up to three people in all, from the volunteers only", async () => {
  await fails(rpc(U.lead, "admit_kitchen_member", [M0, U.plain]), /Soup Kitchen ministry role/);
  await fails(rpc(U.lead, "admit_kitchen_member", [M0, U.outVol]), /active member with a login/);
  await rpc(U.lead, "admit_kitchen_member", [M0, U.v1]);
  await fails(rpc(U.lead, "admit_kitchen_member", [M0, U.v1]), /already on the team/);
  await rpc(U.lead, "admit_kitchen_member", [M0, U.v2]);
  await fails(rpc(U.lead, "admit_kitchen_member", [M0, U.v3]), /three people/);
  assert.equal((await notifs(U.v1)).length, 1);
  assert.match((await notifs(U.v1))[0].title, /You are on the Soup Kitchen team/);
  assert.notEqual(await rpc(U.v1, "get_kitchen_month", [M0]), null);                    // now they can see it
  assert.equal(await rpc(U.v3, "get_kitchen_month", [M0]), null);
  const view = await rpc(U.v1, "get_kitchen_month", [M0]);
  assert.deepEqual(view.members.map((m) => m.name), ["lead", "v1", "v2"]);
  assert.equal(view.members[0].is_leader, true);
  assert.equal(view.is_leader, false);
});

test("only the leader removes people, never the leader, and a removal clears their tasks", async () => {
  await fails(rpc(U.v1, "remove_kitchen_member", [M0, U.v2]), leaderOnly);
  await fails(rpc(U.nomsa, "remove_kitchen_member", [M0, U.v2]), leaderOnly);
  await fails(rpc(U.lead, "remove_kitchen_member", [M0, U.lead]), /cannot be removed/);
  await fails(rpc(U.lead, "remove_kitchen_member", [M0, U.v3]), /not on the team/);
  const task = await rpc(U.lead, "save_kitchen_task", [M0, null, "Shopping", "shopping", U.v2, null, null, []]);
  await rpc(U.lead, "remove_kitchen_member", [M0, U.v2]);
  assert.equal((await db.query("select assignee_id from kitchen_tasks where id=$1", [task])).rows[0].assignee_id, null);
  assert.equal(await rpc(U.v2, "get_kitchen_month", [M0]), null);                       // access ends with the membership
  assert.match((await notifs(U.v2)).slice(-1)[0].title, /no longer on the Soup Kitchen team/);
  await rpc(U.lead, "admit_kitchen_member", [M0, U.v2]);                                // put them back
  await rpc(U.lead, "delete_kitchen_task", [task]);
});

test("changing the leader moves the team and the old leader's tasks come loose", async () => {
  const m = await monthStart(2);
  await rpc(U.v4, "save_kitchen_task", [M2, null, "Plan menu", "cooking", U.v4, null, null, []]);
  await rpc(U.nomsa, "save_kitchen_month", [m, U.v3, "Team C"]);
  assert.deepEqual((await db.query("select user_id from kitchen_members where month_id=$1", [M2])).rows.map((r) => r.user_id), [U.v3]);
  assert.equal((await db.query("select assignee_id from kitchen_tasks where month_id=$1", [M2])).rows[0].assignee_id, null);
  assert.equal(await rpc(U.v4, "get_kitchen_month", [M2]), null);
  assert.equal((await notifs(U.v3)).length, 1);
  await fails(rpc(U.v4, "save_kitchen_task", [M2, null, "x", "other", null, null, null, []]), leaderOnly);
});

test("only the leader plans tasks, for people on the team, with dates inside the month", async () => {
  const day = (await monthStart(0)).slice(0, 8) + "15";
  for (const uid of [U.v1, U.nomsa, U.plain, U.lead2]) await fails(rpc(uid, "save_kitchen_task", [M0, null, "Cook", "cooking", null, null, null, []]), leaderOnly);
  await fails(rpc(U.lead, "save_kitchen_task", [M0, null, "", "cooking", null, null, null, []]), /title/);
  await fails(rpc(U.lead, "save_kitchen_task", [M0, null, "x", "dancing", null, null, null, []]), /shopping, cooking/);
  await fails(rpc(U.lead, "save_kitchen_task", [M0, null, "x", "cooking", U.v3, null, null, []]), /this month's team/);        // not on the team
  await fails(rpc(U.lead, "save_kitchen_task", [M0, null, "x", "cooking", null, await monthStart(1), null, []]), /inside the month/);
  await fails(rpc(U.lead, "save_kitchen_task", [M0, null, "x", "cooking", null, await monthStart(-1), null, []]), /inside the month/);
  await fails(rpc(U.lead, "save_kitchen_task", [M0, null, "x", "cooking", null, null, null, Array.from({ length: 16 }, () => ({ text: "i" }))]), /at most 15/);
  await fails(rpc(U.lead, "save_kitchen_task", [M0, null, "x", "cooking", null, null, null, [{ text: "" }]]), /needs some text/);
  const t = await rpc(U.lead, "save_kitchen_task", [M0, null, "Cook Saturday", "cooking", U.v1, day, "Soup for 80", [{ text: "Onions" }, { text: "Stock" }]]);
  const view = await rpc(U.v2, "get_kitchen_month", [M0]);
  const task = view.tasks.find((x) => x.id === t);
  assert.equal(task.assignee_name, "v1");
  assert.deepEqual(task.checklist.map((c) => c.text), ["Onions", "Stock"]);
  // editing keeps the checklist item ids and drops the ones left out
  const ids = task.checklist.map((c) => c.id);
  await rpc(U.lead, "save_kitchen_task", [M0, t, "Cook Saturday", "cooking", U.v1, day, "Soup for 80", [{ id: ids[1], text: "Stock cubes" }, { text: "Salt" }]]);
  const after = (await rpc(U.lead, "get_kitchen_month", [M0])).tasks.find((x) => x.id === t);
  assert.deepEqual(after.checklist.map((c) => c.text), ["Stock cubes", "Salt"]);
  assert.equal(after.checklist[0].id, ids[1]);
  assert.equal(await rpc(U.v3, "get_kitchen_month", [M0]), null);
});

test("the person a task is given to, or the leader, ticks it off; any teammate ticks checklist items; outsiders nothing", async () => {
  const view = await rpc(U.lead, "get_kitchen_month", [M0]);
  const t = view.tasks[0].id, item = view.tasks[0].checklist[0].id;
  await fails(rpc(U.v2, "set_kitchen_task_done", [t, true]), /Only the person the task is given to/);   // a teammate who is not the assignee
  await fails(rpc(U.nomsa, "set_kitchen_task_done", [t, true]), /Only the person the task is given to/);
  await fails(rpc(U.v3, "set_kitchen_task_done", [t, true]), /Only the person the task is given to/);
  await fails(rpc(U.outsider, "set_kitchen_task_done", [t, true]), /not found/);
  await rpc(U.v1, "set_kitchen_task_done", [t, true]);
  assert.equal((await rpc(U.lead, "get_kitchen_month", [M0])).tasks.find((x) => x.id === t).done, true);
  await rpc(U.lead, "set_kitchen_task_done", [t, false]);
  await rpc(U.v2, "set_kitchen_check", [item, true]);
  assert.equal((await rpc(U.lead, "get_kitchen_month", [M0])).tasks[0].checklist[0].done, true);
  await fails(rpc(U.v3, "set_kitchen_check", [item, false]), /Only the team/);
  await fails(rpc(U.nomsa, "set_kitchen_check", [item, false]), /Only the team/);
  await fails(rpc(U.outsider, "set_kitchen_check", [item, false]), /not found/);
});

test("direct table access is closed to everyone, including the leader and managers", async () => {
  for (const uid of [U.lead, U.v1, U.nomsa, U.plain]) {
    await fails(as(db, uid, () => db.query("insert into kitchen_months (church_id, month) values ($1, date '2031-01-01')", [CH])), refused);
    await fails(as(db, uid, () => db.query("insert into kitchen_members (month_id, user_id, church_id) values ($1,$2,$3)", [M0, uid, CH])), refused);
    await fails(as(db, uid, () => db.query("insert into kitchen_tasks (church_id, month_id, title) values ($1,$2,'x')", [CH, M0])), refused);
    assert.equal((await as(db, uid, () => db.query("update kitchen_tasks set done = true"))).affectedRows, 0);
    assert.equal((await as(db, uid, () => db.query("update kitchen_checks set done = true"))).affectedRows, 0);
    assert.equal((await as(db, uid, () => db.query("delete from kitchen_members"))).affectedRows, 0);
    assert.equal((await as(db, uid, () => db.query("delete from kitchen_months"))).affectedRows, 0);
  }
});

test("a month that has passed is a record: nothing about it can change", async () => {
  const past = (await db.query("insert into kitchen_months (church_id, month, leader_id) values ($1, (kitchen_current_month() - interval '1 month')::date, $2) returning id", [CH, U.lead])).rows[0].id;
  await db.query("insert into kitchen_members (month_id, user_id, church_id) values ($1,$2,$3)", [past, U.lead, CH]);
  await fails(rpc(U.lead, "admit_kitchen_member", [past, U.v1]), /already passed/);
  await fails(rpc(U.lead, "remove_kitchen_member", [past, U.v1]), /already passed/);
  await fails(rpc(U.lead, "save_kitchen_task", [past, null, "x", "other", null, null, null, []]), /already passed/);
  await fails(rpc(U.nomsa, "delete_kitchen_month", [past]), /kept as a record/);
  assert.notEqual(await rpc(U.lead, "get_kitchen_month", [past]), null);              // still readable by the team
  await db.query("delete from kitchen_months where id=$1", [past]);
});

test("managers can delete an upcoming month; others cannot", async () => {
  const m = await rpc(U.nomsa, "save_kitchen_month", [await monthStart(5), U.v4, null]);
  await fails(rpc(U.lead, "delete_kitchen_month", [m]), manager);
  await fails(rpc(U.outsider, "delete_kitchen_month", [m]), /not found/);
  await rpc(U.nomsa, "delete_kitchen_month", [m]);
  assert.equal((await db.query("select count(*)::int as n from kitchen_months where id=$1", [m])).rows[0].n, 0);
});

test("my kitchen: on the team now, with my open tasks, or when my next turn is", async () => {
  const mine = await rpc(U.v1, "my_kitchen", []);
  assert.equal(mine.on_team, true);
  assert.deepEqual(mine.tasks.map((t) => t.title), ["Cook Saturday"]);
  const lead2 = await rpc(U.lead2, "my_kitchen", []);
  assert.equal(lead2.on_team, false);
  assert.equal(lead2.next_turn, await monthStart(1));
  const plain = await rpc(U.plain, "my_kitchen", []);
  assert.equal(plain.on_team, false);
  assert.equal(plain.next_turn, null);
});

test("rotation reminders go to the outgoing and the incoming team, once, in the last days of the month", async () => {
  await db.query("delete from notifications");
  const m1 = await monthStart(1);
  const threeBefore = iso(new Date(new Date(m1 + "T12:00:00Z").getTime() - 3 * 24 * 3600 * 1000));
  const tooEarly = iso(new Date(new Date(m1 + "T12:00:00Z").getTime() - 10 * 24 * 3600 * 1000));
  assert.equal((await db.query("select send_rotation_reminders($1) as n", [tooEarly])).rows[0].n, 0);
  assert.equal((await notifs(U.lead2)).length, 0);
  assert.equal((await db.query("select send_rotation_reminders($1) as n", [threeBefore])).rows[0].n, 1);
  const outgoing = [U.lead, U.v1, U.v2];
  const incoming = [U.lead2];
  for (const uid of outgoing) assert.match((await notifs(uid))[0].title, /your month ends soon/);
  for (const uid of incoming) assert.match((await notifs(uid))[0].title, /your month starts on/);
  assert.equal((await notifs(U.v3)).length, 0);              // not on either team
  assert.equal((await notifs(U.plain)).length, 0);
  assert.equal((await db.query("select send_rotation_reminders($1) as n", [threeBefore])).rows[0].n, 0);    // not twice
});

test("a task reminder goes to the assignee the day before, once, and not for finished tasks", async () => {
  await db.query("delete from notifications");
  const due = (await rpc(U.lead, "get_kitchen_month", [M0])).tasks[0].due_date;
  const dayBefore = iso(new Date(new Date(due + "T12:00:00Z").getTime() - 24 * 3600 * 1000));
  assert.equal((await db.query("select send_kitchen_task_reminders($1) as n", [dayBefore])).rows[0].n, 1);
  assert.match((await notifs(U.v1))[0].title, /task due tomorrow/);
  assert.equal((await db.query("select send_kitchen_task_reminders($1) as n", [dayBefore])).rows[0].n, 0);
  await db.query("update kitchen_tasks set reminded_at = null, done = true");
  assert.equal((await db.query("select send_kitchen_task_reminders($1) as n", [dayBefore])).rows[0].n, 0);
});

test("people cannot run the reminder jobs or the internal helpers", async () => {
  await fails(as(db, U.lead, () => db.query("select send_rotation_reminders()")), /permission denied/);
  await fails(as(db, U.lead, () => db.query("select send_kitchen_task_reminders()")), /permission denied/);
  for (const c of ["kitchen_in_pool('" + U.v1 + "')", "kitchen_is_member('" + M0 + "')", "kitchen_is_leader('" + M0 + "')", "kitchen_person_name('" + U.v1 + "')", "kitchen_require_leader('" + M0 + "')"]) {
    await fails(as(db, U.nomsa, () => db.query("select * from " + c)), /permission denied/);
  }
});

test("anonymous visitors cannot call any soup kitchen function", async () => {
  const calls = ["kitchen_schedule()", "get_kitchen_month('" + M0 + "')", "kitchen_pool('" + M0 + "')", "my_kitchen()", "kitchen_current_month()",
    "save_kitchen_month(current_date, null, null)", "admit_kitchen_member('" + M0 + "','" + U.v1 + "')", "remove_kitchen_member('" + M0 + "','" + U.v1 + "')",
    "save_kitchen_task('" + M0 + "', null, 'x', 'other', null, null, null, '[]')", "delete_kitchen_task(null)", "set_kitchen_task_done(null, true)", "set_kitchen_check(null, true)", "kitchen_can_see('" + M0 + "')"];
  for (const c of calls) await fails(as(db, null, () => db.query("select * from " + c)), /permission denied/);
});

test("only managers can list all volunteers when choosing a leader", async () => {
  await fails(q(U.lead, "select * from kitchen_volunteers()"), manager);
  await fails(q(U.plain, "select * from kitchen_volunteers()"), manager);
  assert.deepEqual((await q(U.nomsa, "select full_name from kitchen_volunteers()")).map((r) => r.full_name), ["lead", "lead2", "v1", "v2", "v3", "v4"]);
  await fails(as(db, null, () => db.query("select * from kitchen_volunteers()")), /permission denied/);
});
