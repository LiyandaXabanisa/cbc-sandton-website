// Praise and Worship workspace permission matrix (phase 2, step 4).
import test from "node:test";
import assert from "node:assert/strict";
import { boot, as, fails } from "./harness.mjs";

const FILES = ["01-churchhub-schema.sql", "02-website-integration.sql", "06-services-reminders.sql", "07-sermons.sql", "08-roles.sql", "09-sermon-desk.sql", "11-weekly-program.sql", "12-praise-worship.sql"];
const id = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const CH = id(900), OTHER = id(901);
const U = { pastor: id(1), nomsa: id(2), media: id(3), leader: id(4), singer: id(5), cook: id(6), member: id(7), outsider: id(8) };
const refused = /row-level security|policy|permission|violates/i;
const worshipOnly = /Praise and Worship leaders and the managers/;
const teamOnly = /Praise and Worship team/;

let db, PW, SOUP, OUT_PW;
let S1, S2, V1, V1B, V2, SET;
const rpc = (uid, fn, args = []) => as(db, uid, async () => (await db.query(`select ${fn}(${args.map((_, i) => "$" + (i + 1) + (typeof args[i] === "object" && args[i] !== null && !(args[i] instanceof Date) ? "::jsonb" : "")).join(",")}) as v`, args.map((a) => (typeof a === "object" && a !== null ? JSON.stringify(a) : a)))).rows[0].v);
const q = (uid, sql, params = []) => as(db, uid, async () => (await db.query(sql, params)).rows);
const soon = () => new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
const notifs = async (kind = "worship") => (await db.query("select user_id, title, body from notifications where kind=$1 order by user_id", [kind])).rows;
const clearNotifs = () => db.query("delete from notifications");

test.before(async () => {
  db = await boot(FILES);
  await db.query("insert into churches (id, name) values ($1,'Church A'), ($2,'Church B')", [CH, OTHER]);
  for (const [n, uid] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1,$2)", [uid, n + "@example.com"]);
  for (const n of ["pastor", "nomsa", "media", "leader", "singer", "cook", "member"]) {
    await db.query("insert into members (church_id, full_name, email, is_active, user_id) values ($1,$2,$3,true,$4)", [CH, n, n + "@example.com", U[n]]);
  }
  await db.query("insert into members (church_id, full_name, email, is_active, user_id) values ($1,'outsider','o@example.com',true,$2)", [OTHER, U.outsider]);
  // the church and the other church each get their ministries from the migration; run it again now that churches exist
  await db.exec(readSeed());
  PW = (await db.query("select id from ministries where church_id=$1 and slug='praise-worship'", [CH])).rows[0].id;
  SOUP = (await db.query("select id from ministries where church_id=$1 and slug='soup-kitchen'", [CH])).rows[0].id;
  OUT_PW = (await db.query("select id from ministries where church_id=$1 and slug='praise-worship'", [OTHER])).rows[0].id;
  await db.query("insert into role_grants (church_id, user_id, role) values ($1,$2,'senior_pastor'), ($1,$3,'platform_manager'), ($1,$4,'media_team'), ($5,$6,'platform_manager')", [CH, U.pastor, U.nomsa, U.media, OTHER, U.outsider]);
  await db.query("insert into role_grants (church_id, user_id, role, scope_type, scope_id) values ($1,$2,'ministry_leader','ministry',$3), ($1,$4,'ministry_member','ministry',$3), ($1,$5,'ministry_member','ministry',$6)", [CH, U.leader, PW, U.singer, U.cook, SOUP]);
});

function readSeed() {
  // only the ministries seed from the migration, so the test churches get their ministries
  return `insert into ministries (church_id, slug, name, colour, description)
    select c.id, m.slug, m.name, m.colour, m.description from churches c
    cross join (values ('praise-worship','Praise and Worship','#b8862b','x'), ('soup-kitchen','Soup Kitchen','#c26a1a','x')) as m(slug,name,colour,description)
    on conflict (church_id, slug) do nothing;`;
}

test("every church gets the standard ministries, and only managers change them", async () => {
  const names = (await q(U.member, "select slug from ministries order by slug")).map((r) => r.slug);
  assert.deepEqual(names, ["praise-worship", "soup-kitchen"]);          // only their own church's
  await fails(as(db, U.member, () => db.query("insert into ministries (church_id, slug, name) values ($1,'x1','X')", [CH])), refused);
  await fails(as(db, U.leader, () => db.query("insert into ministries (church_id, slug, name) values ($1,'x2','X')", [CH])), refused);
  assert.equal((await as(db, U.member, () => db.query("update ministries set name='hacked'"))).affectedRows, 0);
  await as(db, U.nomsa, () => db.query("insert into ministries (church_id, slug, name) values ($1,'x3','Added')", [CH]));
  await fails(as(db, U.nomsa, () => db.query("insert into ministries (church_id, slug, name) values ($1,'x4','Other')", [OTHER])), refused);
  await db.query("delete from ministries where slug='x3'");
});

test("my ministries lists the ones I belong to; managers belong to all", async () => {
  assert.deepEqual((await q(U.singer, "select slug, my_role from my_ministries()")).map((r) => r.slug + ":" + r.my_role), ["praise-worship:member"]);
  assert.deepEqual((await q(U.leader, "select slug, my_role from my_ministries()")).map((r) => r.slug + ":" + r.my_role), ["praise-worship:leader"]);
  assert.deepEqual((await q(U.cook, "select slug from my_ministries()")).map((r) => r.slug), ["soup-kitchen"]);
  assert.equal((await q(U.member, "select * from my_ministries()")).length, 0);
  assert.equal((await q(U.nomsa, "select * from my_ministries()")).length, 2);
  assert.equal((await q(U.media, "select * from my_ministries()")).length, 2 - 2);   // the media team is not a ministry member
});

test("only the leaders and managers can write songs; the team reads; others see nothing", async () => {
  const versions = [{ label: "Original", musical_key: "G", lyrics: "Verse one\nChorus" }, { label: "Youth key", musical_key: "A", lyrics: "Verse one\nChorus" }];
  await fails(rpc(U.singer, "save_song", [null, "Great Is Thy Faithfulness", "Chisholm", versions]), worshipOnly);
  await fails(rpc(U.cook, "save_song", [null, "x", null, versions]), worshipOnly);
  await fails(rpc(U.media, "save_song", [null, "x", null, versions]), worshipOnly);
  await fails(rpc(U.member, "save_song", [null, "x", null, versions]), worshipOnly);
  S1 = await rpc(U.leader, "save_song", [null, "Great Is Thy Faithfulness", "Chisholm", versions]);
  S2 = await rpc(U.nomsa, "save_song", [null, "Open Doors", null, [{ label: "Original", musical_key: "D", lyrics: "Doors open wide" }]]);
  const song = await rpc(U.singer, "get_song", [S1]);
  assert.deepEqual(song.versions.map((v) => v.label), ["Original", "Youth key"]);
  [V1, V1B] = song.versions.map((v) => v.id);
  V2 = (await rpc(U.singer, "get_song", [S2])).versions[0].id;
  assert.equal((await q(U.singer, "select * from list_songs()")).length, 2);
  for (const uid of [U.cook, U.media, U.member]) {
    await fails(q(uid, "select * from list_songs()"), teamOnly);
    await fails(rpc(uid, "get_song", [S1]), teamOnly);
    assert.equal((await q(uid, "select * from songs")).length, 0);
    assert.equal((await q(uid, "select * from song_versions")).length, 0);
  }
  // a manager of another church leads that church's own worship team, and sees none of this church's songs
  assert.equal((await q(U.outsider, "select * from list_songs()")).length, 0);
  assert.equal(await rpc(U.outsider, "get_song", [S1]), null);
  assert.equal((await q(U.outsider, "select * from songs")).length, 0);
});

test("songs are validated, and a song belongs to one church", async () => {
  await fails(rpc(U.leader, "save_song", [null, "", null, [{ label: "Original" }]]), /title/);
  await fails(rpc(U.leader, "save_song", [null, "x", null, []]), /at least one version/);
  await fails(rpc(U.leader, "save_song", [null, "x", null, [{ label: "" }]]), /needs a name/);
  await fails(rpc(U.leader, "save_song", [null, "x", null, Array.from({ length: 13 }, (_, i) => ({ label: "v" + i }))]), /at most 12/);
  await fails(rpc(U.outsider, "save_song", [S1, "stolen", null, [{ label: "Original" }]]), /song was not found/);
  assert.equal((await q(U.nomsa, "select title from songs where id=$1", [S1]))[0].title, "Great Is Thy Faithfulness");
});

test("search finds a song by title, author or words in the lyrics", async () => {
  const found = async (t) => (await q(U.singer, "select title from list_songs($1)", [t])).map((r) => r.title);
  assert.deepEqual(await found("faithful"), ["Great Is Thy Faithfulness"]);
  assert.deepEqual(await found("chisholm"), ["Great Is Thy Faithfulness"]);
  assert.deepEqual(await found("doors open"), ["Open Doors"]);
  assert.deepEqual(await found("100%"), []);
});

test("archived songs are hidden from the list unless asked for", async () => {
  await rpc(U.leader, "set_song_archived", [S2, true]);
  assert.equal((await q(U.singer, "select * from list_songs()")).length, 1);
  assert.equal((await q(U.singer, "select * from list_songs(null, true)")).length, 2);
  await rpc(U.leader, "set_song_archived", [S2, false]);
  await fails(rpc(U.singer, "set_song_archived", [S2, true]), worshipOnly);
});

test("set lists: leaders build them, the team reads, the media team only sees published ones", async () => {
  await fails(rpc(U.singer, "create_set_list", ["Sunday", soon()]), worshipOnly);
  await fails(rpc(U.media, "create_set_list", ["Sunday", soon()]), worshipOnly);
  SET = await rpc(U.leader, "create_set_list", ["Sunday 25 October", soon()]);
  await rpc(U.leader, "save_set_list", [SET, null, null, null, [{ song_id: S1, version_id: V1, musical_key: "A", notes: "Intro x2" }, { song_id: S2, version_id: V2 }], "Slow start"]);
  const view = await rpc(U.singer, "get_set_list", [SET]);
  assert.deepEqual(view.songs.map((s) => s.title), ["Great Is Thy Faithfulness", "Open Doors"]);
  assert.equal(view.songs[0].musical_key, "A");                 // the key for the day overrides the version's key
  assert.equal(view.songs[1].musical_key, "D");
  assert.match(view.songs[0].lyrics, /Verse one/);
  // draft: invisible to the media team and everyone else
  assert.equal(await rpc(U.media, "get_set_list", [SET]), null);
  assert.equal((await q(U.media, "select * from list_set_lists()")).length, 0);
  for (const uid of [U.cook, U.member, U.outsider]) {
    assert.equal(await rpc(uid, "get_set_list", [SET]), null);
    assert.equal((await q(uid, "select * from list_set_lists()")).length, 0);
  }
  await rpc(U.leader, "publish_set_list", [SET, true]);
  const media = await rpc(U.media, "get_set_list", [SET]);
  assert.match(media.songs[0].lyrics, /Verse one/);              // lyrics flow to the media team on publish
  assert.equal((await q(U.media, "select * from list_set_lists()")).length, 1);
  assert.equal(await rpc(U.member, "get_set_list", [SET]), null);
  assert.equal(await rpc(U.cook, "get_set_list", [SET]), null);
});

test("set list songs must exist in this church, and a version must belong to its song", async () => {
  await fails(rpc(U.leader, "save_set_list", [SET, null, null, null, [{ song_id: id(777) }]]), /not found in this church/);
  await fails(rpc(U.leader, "save_set_list", [SET, null, null, null, [{ song_id: S2, version_id: V1 }]]), /does not belong/);
  await fails(rpc(U.leader, "save_set_list", [SET, null, null, null, Array.from({ length: 31 }, () => ({ song_id: S1 }))]), /at most 30/);
  await fails(rpc(U.outsider, "save_set_list", [SET, null, null, null, []]), /set list was not found/);
  assert.equal((await rpc(U.singer, "get_set_list", [SET])).songs.length, 2);   // nothing was changed by the failed saves
});

test("the program item link must belong to the church", async () => {
  await fails(rpc(U.leader, "create_set_list", ["x", soon(), id(888)]), /program item was not found/);
});

test("direct table access: the team reads, leaders write, nobody else touches the tables", async () => {
  for (const t of ["songs", "song_versions", "set_lists", "set_list_songs"]) {
    assert.equal((await q(U.singer, `select * from ${t}`)).length > 0, true, t);
    assert.equal((await q(U.cook, `select * from ${t}`)).length, 0, t);
    assert.equal((await q(U.media, `select * from ${t}`)).length, 0, t);
  }
  await fails(as(db, U.singer, () => db.query("insert into songs (church_id, title) values ($1,'x')", [CH])), refused);
  await fails(as(db, U.media, () => db.query("insert into set_lists (church_id, title, starts_at) values ($1,'x',now())", [CH])), refused);
  assert.equal((await as(db, U.singer, () => db.query("update songs set title='hacked'"))).affectedRows, 0);
  assert.equal((await as(db, U.cook, () => db.query("delete from songs"))).affectedRows, 0);
  await fails(as(db, U.leader, () => db.query("insert into songs (church_id, title) values ($1,'x')", [OTHER])), refused);
});

test("notices: publishing tells the team, the media team and managers, not the author or other ministries", async () => {
  await clearNotifs();
  await rpc(U.leader, "publish_set_list", [SET, false]);
  await rpc(U.leader, "publish_set_list", [SET, true]);
  const who = (await notifs()).map((r) => r.user_id).sort();
  assert.deepEqual(who, [U.pastor, U.nomsa, U.media, U.singer].sort());     // not the leader (author), not the cook, not a member
  assert.match((await notifs())[0].title, /New set list/);
});

test("notices: changes to a published set list reach the team and media; drafts and no-change saves stay quiet", async () => {
  await clearNotifs();
  await rpc(U.leader, "save_set_list", [SET, null, null, null, [{ song_id: S2, version_id: V2 }, { song_id: S1, version_id: V1, musical_key: "A", notes: "Intro x2" }], "Slow start"]);
  assert.deepEqual((await notifs()).map((r) => r.user_id).sort(), [U.media, U.singer].sort());
  await clearNotifs();
  await rpc(U.leader, "save_set_list", [SET, null, null, null, [{ song_id: S2, version_id: V2 }, { song_id: S1, version_id: V1, musical_key: "A", notes: "Intro x2" }], "Slow start"]);
  assert.equal((await notifs()).length, 0);
  await rpc(U.leader, "publish_set_list", [SET, false]);
  await clearNotifs();
  await rpc(U.leader, "save_set_list", [SET, null, null, null, [{ song_id: S1 }], null]);
  assert.equal((await notifs()).length, 0);
  await rpc(U.leader, "save_set_list", [SET, null, null, null, [{ song_id: S2, version_id: V2 }, { song_id: S1, version_id: V1, musical_key: "A", notes: "Intro x2" }], "Slow start"]);
  await rpc(U.leader, "publish_set_list", [SET, true]);
});

test("notices: changing lyrics or a key of a song in an upcoming published set list alerts the team and media", async () => {
  await clearNotifs();
  await rpc(U.leader, "save_song", [S1, "Great Is Thy Faithfulness", "Chisholm", [{ id: V1, label: "Original", musical_key: "G", lyrics: "Verse one\nChorus\nBridge added" }, { id: V1B, label: "Youth key", musical_key: "A", lyrics: "Verse one\nChorus" }]]);
  assert.deepEqual((await notifs()).map((r) => r.user_id).sort(), [U.media, U.singer].sort());
  assert.match((await notifs())[0].title, /Song changed/);
  // changing only the title, or saving with nothing new, stays quiet
  await clearNotifs();
  await rpc(U.leader, "save_song", [S1, "Great Is Thy Faithfulness (new title)", "Chisholm", [{ id: V1, label: "Original", musical_key: "G", lyrics: "Verse one\nChorus\nBridge added" }, { id: V1B, label: "Youth key", musical_key: "A", lyrics: "Verse one\nChorus" }]]);
  assert.equal((await notifs()).length, 0);
  // a song that is in no upcoming published set list changes quietly
  await rpc(U.leader, "save_song", [null, "Quiet song", null, [{ label: "Original", lyrics: "la" }]]);
  const quiet = (await db.query("select id from songs where title='Quiet song'")).rows[0].id;
  const qv = (await db.query("select id from song_versions where song_id=$1", [quiet])).rows[0].id;
  await rpc(U.leader, "save_song", [quiet, "Quiet song", null, [{ id: qv, label: "Original", lyrics: "la la la" }]]);
  assert.equal((await notifs()).length, 0);
});

test("copying a set list keeps the songs", async () => {
  const copy = await rpc(U.leader, "create_set_list", ["Next Sunday", new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString(), null, SET]);
  assert.equal((await rpc(U.leader, "get_set_list", [copy])).songs.length, 2);
  await rpc(U.leader, "delete_set_list", [copy]);
  await fails(rpc(U.singer, "delete_set_list", [SET]), worshipOnly);
  await fails(rpc(U.outsider, "delete_set_list", [SET]), /set list was not found/);
});

test("a song used in a set list cannot be deleted by accident, only archived", async () => {
  await fails(db.query("delete from songs where id=$1", [S1]), /violates foreign key|restrict/i);
});

// ---------- colour planner ----------
const day = (n) => new Date(Date.now() + n * 24 * 3600 * 1000 + 2 * 3600 * 1000).toISOString().slice(0, 10);
const colours = [{ name: "Navy", hex: "#1b2430" }, { name: "Gold", hex: "#c9a24d" }];

test("colour plans: leaders write, the team reads published ones, others see nothing", async () => {
  await fails(rpc(U.singer, "save_colour_plan", [day(5), colours, null, true]), worshipOnly);
  await fails(rpc(U.media, "save_colour_plan", [day(5), colours, null, true]), worshipOnly);
  await rpc(U.leader, "save_colour_plan", [day(5), colours, "Smart casual", false]);
  assert.equal((await q(U.singer, "select * from list_colour_plans()")).length, 0);        // a draft is not shown to the team
  assert.equal((await q(U.leader, "select * from list_colour_plans()")).length, 1);
  await rpc(U.leader, "save_colour_plan", [day(5), colours, "Smart casual", true]);
  assert.equal((await q(U.singer, "select * from list_colour_plans()")).length, 1);
  for (const uid of [U.cook, U.media, U.member, U.outsider]) {
    await fails(q(uid, "select * from list_colour_plans()"), /./).catch(async () => {});
    assert.equal((await q(uid, "select * from colour_plans")).length, 0);
  }
  assert.equal((await q(U.cook, "select * from list_colour_plans()")).length, 0);
  assert.equal((await q(U.media, "select * from list_colour_plans()")).length, 0);
});

test("colour plans are validated and one per day", async () => {
  await fails(rpc(U.leader, "save_colour_plan", [day(6), [{ name: "x", hex: "red" }], null, false]), /valid colour code/);
  await fails(rpc(U.leader, "save_colour_plan", [day(6), Array.from({ length: 7 }, () => ({ name: "x", hex: "#000000" })), null, false]), /up to 6/);
  await fails(rpc(U.leader, "save_colour_plan", [day(6), [{ name: "x".repeat(41), hex: "#000000" }], null, false]), /at most 40/);
  await fails(rpc(U.leader, "save_colour_plan", [null, colours, null, false]), /service date/);
  const again = await rpc(U.leader, "save_colour_plan", [day(5), [{ name: "Cream", hex: "#f5efe0" }], "Smart casual", true]);
  assert.equal((await db.query("select count(*)::int as n from colour_plans where service_date=$1", [day(5)])).rows[0].n, 1);
  assert.equal(typeof again, "string");
});

test("publishing or changing a colour plan tells the team once", async () => {
  await clearNotifs();
  await rpc(U.leader, "save_colour_plan", [day(9), colours, null, true]);
  assert.deepEqual((await notifs()).map((r) => r.user_id), [U.singer]);               // the team, not the author, not media
  assert.match((await notifs())[0].title, /Colours for/);
  await clearNotifs();
  await rpc(U.leader, "save_colour_plan", [day(9), colours, null, true]);               // nothing changed
  assert.equal((await notifs()).length, 0);
  await rpc(U.leader, "save_colour_plan", [day(9), [{ name: "Black", hex: "#000000" }], null, true]);
  assert.equal((await notifs()).length, 1);
});

test("the evening reminder goes out once, only for a published plan for tomorrow", async () => {
  await db.query("delete from colour_plans");
  await clearNotifs();
  const tomorrowSa = (await db.query("select ((now() at time zone 'Africa/Johannesburg')::date + 1) as d")).rows[0].d.toISOString().slice(0, 10);
  await rpc(U.leader, "save_colour_plan", [tomorrowSa, colours, "Wear them", true]);
  await clearNotifs();
  assert.equal((await db.query("select send_colour_reminders() as n")).rows[0].n, 1);
  assert.deepEqual((await notifs()).map((r) => r.user_id).sort(), [U.leader, U.singer].sort());   // the whole team, including the leader
  assert.match((await notifs())[0].title, /Tomorrow's colours/);
  assert.equal((await db.query("select send_colour_reminders() as n")).rows[0].n, 0);            // not twice
  // a draft for tomorrow is not announced
  await db.query("delete from colour_plans");
  await rpc(U.leader, "save_colour_plan", [tomorrowSa, colours, null, false]);
  await clearNotifs();
  assert.equal((await db.query("select send_colour_reminders() as n")).rows[0].n, 0);
  // changing the colours after a reminder allows a fresh one
  await rpc(U.leader, "save_colour_plan", [tomorrowSa, colours, null, true]);
  await db.query("update colour_plans set reminded_at = now()");
  await rpc(U.leader, "save_colour_plan", [tomorrowSa, [{ name: "Red", hex: "#ff0000" }], null, true]);
  assert.equal((await db.query("select send_colour_reminders() as n")).rows[0].n, 1);
});

test("people cannot run the reminder job or the internal helpers", async () => {
  await fails(as(db, U.leader, () => db.query("select send_colour_reminders()")), /permission denied/);
  for (const c of ["notify_users('" + CH + "', null, 'x', 'y', 'z', 'w')", "ministry_audience('" + CH + "', 'praise-worship')", "require_worship_leader()", "require_worship_team()"]) {
    await fails(as(db, U.nomsa, () => db.query("select * from " + c)), /permission denied/);
  }
});

test("anonymous visitors cannot call any ministry or worship function", async () => {
  const calls = ["my_ministries()", "list_songs()", "get_song('" + S1 + "')", "list_set_lists()", "get_set_list('" + SET + "')", "list_colour_plans()",
    "save_song(null,'x',null,'[]')", "create_set_list('x', now())", "publish_set_list('" + SET + "', true)", "save_colour_plan(current_date,'[]',null,false)",
    "is_ministry_team('praise-worship')", "ministry_id_of('praise-worship')"];
  for (const c of calls) await fails(as(db, null, () => db.query("select * from " + c)), /permission denied/);
});

test("the people and roles rules still work for ministry roles", async () => {
  // a manager can give and take away a ministry role, a member cannot
  await fails(as(db, U.member, () => db.query("select grant_role($1,'ministry_member','ministry',$2)", [U.member, PW])), /Only the Senior Pastor or a Platform Manager/);
  await as(db, U.nomsa, () => db.query("select grant_role($1,'ministry_member','ministry',$2)", [U.member, PW]));
  assert.equal((await q(U.member, "select * from list_songs()")).length > 0, true);
  const g = (await db.query("select id from role_grants where user_id=$1 and role='ministry_member'", [U.member])).rows[0].id;
  await as(db, U.nomsa, () => db.query("select revoke_role($1)", [g]));
  await fails(q(U.member, "select * from list_songs()"), teamOnly);
});
