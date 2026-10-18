// Shared helpers for the Weekly Program: start and end times of each item, and a comparison of two versions.
// Times always show in South African time, whatever the visitor's own clock says.
(function () {
  var TZ = "Africa/Johannesburg";

  function clock(date) {
    return date.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });
  }

  function dayLabel(iso) {
    return new Date(iso).toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ });
  }

  // Each item starts when the one before it ends. Items need { minutes } (or { duration_minutes }).
  function timeline(startsAtIso, items) {
    var t = new Date(startsAtIso).getTime();
    var rows = (items || []).map(function (it) {
      var mins = Number(it.minutes != null ? it.minutes : it.duration_minutes) || 0;
      var start = new Date(t);
      t += mins * 60000;
      return Object.assign({}, it, { start: start, end: new Date(t), minutes: mins });
    });
    var total = rows.reduce(function (n, r) { return n + r.minutes; }, 0);
    return { rows: rows, end: new Date(t), total: total };
  }

  var FIELDS = [
    ["title", "title"],
    ["duration_minutes", "length"],
    ["department", "department"],
    ["presenter_id", "presenter"],
    ["presenter_name", "presenter"],
    ["notes", "notes"],
  ];

  function norm(v) {
    return v == null || v === "" ? null : v;
  }

  // Compare two snapshots ({ title, starts_at, items: [...] }), oldest first.
  function diff(before, after) {
    var out = { title: null, startsAt: null, added: [], removed: [], changed: [], moved: [] };
    before = before || { items: [] };
    after = after || { items: [] };
    if (before.title !== after.title) out.title = { from: before.title, to: after.title };
    if (before.starts_at !== after.starts_at && new Date(before.starts_at).getTime() !== new Date(after.starts_at).getTime()) {
      out.startsAt = { from: before.starts_at, to: after.starts_at };
    }
    var oldById = {};
    (before.items || []).forEach(function (i) { oldById[i.id] = i; });
    var seen = {};
    (after.items || []).forEach(function (n) {
      var o = oldById[n.id];
      seen[n.id] = true;
      if (!o) {
        out.added.push({ title: n.title });
        return;
      }
      var fields = [];
      FIELDS.forEach(function (f) {
        if (norm(o[f[0]]) !== norm(n[f[0]]) && fields.indexOf(f[1]) === -1) fields.push(f[1]);
      });
      if (fields.length) out.changed.push({ title: n.title, fields: fields });
      else if (o.position !== n.position) out.moved.push({ title: n.title, from: o.position, to: n.position });
    });
    (before.items || []).forEach(function (o) {
      if (!seen[o.id]) out.removed.push({ title: o.title });
    });
    return out;
  }

  // The differences as short sentences.
  function describe(d) {
    var lines = [];
    if (d.title) lines.push("Title changed to " + d.title.to);
    if (d.startsAt) lines.push("Start time changed");
    d.added.forEach(function (a) { lines.push("Added " + a.title); });
    d.removed.forEach(function (r) { lines.push("Removed " + r.title); });
    d.changed.forEach(function (c) { lines.push(c.title + ": " + c.fields.join(", ") + " changed"); });
    d.moved.forEach(function (m) { lines.push("Moved " + m.title); });
    return lines;
  }

  // A datetime-local box shows the church's own time (South Africa), whatever the computer's clock says.
  function toInput(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(" ", "T");
  }

  // The reverse: a South African wall clock time (UTC+2, no daylight saving) to an instant.
  function fromInput(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value || "");
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 2, +m[5])).toISOString();
  }

  var api = { timeline: timeline, diff: diff, describe: describe, clock: clock, dayLabel: dayLabel, toInput: toInput, fromInput: fromInput, TZ: TZ };
  if (typeof window !== "undefined") window.CBC_PL = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
