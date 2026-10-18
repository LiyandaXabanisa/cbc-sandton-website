import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { timeline, diff, describe, clock } = createRequire(import.meta.url)("../../public/programlib.js");

test("items start when the previous one ends, in South African time", () => {
  // 08:00 UTC is 10:00 in South Africa
  const t = timeline("2026-10-25T08:00:00Z", [{ minutes: 5 }, { minutes: 25 }, { duration_minutes: 10 }]);
  assert.deepEqual(t.rows.map((r) => clock(r.start)), ["10:00", "10:05", "10:30"]);
  assert.equal(clock(t.end), "10:40");
  assert.equal(t.total, 40);
});

test("an empty program has no length", () => {
  const t = timeline("2026-10-25T08:00:00Z", []);
  assert.equal(t.total, 0);
  assert.deepEqual(t.rows, []);
});

const item = (id, position, title, extra = {}) => Object.assign({ id, position, title, duration_minutes: 5, department: null, presenter_id: null, presenter_name: null, notes: null }, extra);

test("comparing versions finds added, removed, changed and moved items", () => {
  const before = { title: "Sunday", starts_at: "2026-10-25T08:00:00Z", items: [item("a", 1, "Welcome"), item("b", 2, "Worship", { duration_minutes: 20 }), item("c", 3, "Offering"), item("d", 4, "Closing")] };
  const after = { title: "Sunday", starts_at: "2026-10-25T08:00:00Z", items: [item("b", 1, "Worship", { duration_minutes: 25 }), item("a", 2, "Welcome"), item("e", 3, "Testimony"), item("d", 4, "Closing", { presenter_id: "u1" })] };
  const d = diff(before, after);
  assert.deepEqual(d.added.map((x) => x.title), ["Testimony"]);
  assert.deepEqual(d.removed.map((x) => x.title), ["Offering"]);
  assert.deepEqual(d.changed.map((x) => x.title + ":" + x.fields.join("+")), ["Worship:length", "Closing:presenter"]);
  assert.deepEqual(d.moved.map((x) => x.title), ["Welcome"]);
  assert.equal(describe(d).length, 5);
});

test("an identical snapshot has no differences", () => {
  const s = { title: "Sunday", starts_at: "2026-10-25T08:00:00Z", items: [item("a", 1, "Welcome")] };
  const d = diff(s, JSON.parse(JSON.stringify(s)));
  assert.deepEqual(describe(d), []);
});

test("a changed title or start time is reported", () => {
  const d = diff({ title: "A", starts_at: "2026-10-25T08:00:00Z", items: [] }, { title: "B", starts_at: "2026-10-25T09:00:00Z", items: [] });
  assert.equal(d.title.to, "B");
  assert.equal(d.startsAt !== null, true);
  // the same instant written two ways is not a change
  assert.equal(diff({ title: "A", starts_at: "2026-10-25T08:00:00Z", items: [] }, { title: "A", starts_at: "2026-10-25T08:00:00.000Z", items: [] }).startsAt, null);
});

test("empty text and missing text count as the same", () => {
  const d = diff({ title: "A", items: [item("a", 1, "X", { notes: "" })] }, { title: "A", items: [item("a", 1, "X", { notes: null })] });
  assert.deepEqual(describe(d), []);
});

test("a South African wall clock time round trips through the input helpers", () => {
  const lib = createRequire(import.meta.url)("../../public/programlib.js");
  assert.equal(lib.fromInput("2026-10-25T10:00"), "2026-10-25T08:00:00.000Z");
  assert.equal(lib.toInput("2026-10-25T08:00:00.000Z"), "2026-10-25T10:00");
  assert.equal(lib.fromInput("nonsense"), null);
  assert.equal(lib.toInput("nonsense"), "");
});
