// The first roles script: sets the right roles, and is safe to run twice.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boot } from "./harness.mjs";

const FILES = ["01-churchhub-schema.sql", "02-website-integration.sql", "06-services-reminders.sql", "07-sermons.sql", "08-roles.sql", "09-sermon-desk.sql"];
const ME = "8627684d-b165-4cad-b8cd-6db3f7673c33";
const TSHEPO = "11111111-1111-4111-8111-111111111111";

function filled(script) {
  return script.replace(/YOUR-USER-ID/g, ME).replace(/TSHEPO-USER-ID/g, TSHEPO);
}

test("the first roles script gives the administrator and Tshepo the right roles, twice over safely", async () => {
  const db = await boot(FILES);
  await db.query("insert into churches (name) values ('Change Bible Church Sandton')");
  for (const uid of [ME, TSHEPO]) await db.query("insert into auth.users (id, email) values ($1,$2)", [uid, uid + "@example.com"]);
  const script = filled(readFileSync(new URL("../../supabase/10-first-roles.sql", import.meta.url), "utf8"));
  await db.exec(script);
  await db.exec(script);
  const rows = (await db.query("select user_id, role from role_grants where revoked_at is null order by role, user_id")).rows;
  assert.deepEqual(
    rows.map((r) => r.role + ":" + r.user_id),
    ["platform_manager:" + ME, "platform_manager:" + TSHEPO, "senior_pastor:" + ME].sort((a, b) => a.localeCompare(b))
  );
  assert.equal((await db.query("select count(*)::int as n from audit_log where action = 'seeded'")).rows[0].n, 2);
});

test("the script refuses to run if the church does not exist yet", async () => {
  const db = await boot(FILES);
  await db.query("insert into auth.users (id, email) values ($1,'a@example.com')", [ME]);
  await assert.rejects(db.exec(filled(readFileSync(new URL("../../supabase/10-first-roles.sql", import.meta.url), "utf8")).replace(/TSHEPO-USER-ID/g, ME)), /church was not found/);
});
