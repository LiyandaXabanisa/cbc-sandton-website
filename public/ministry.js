// Ministry workspaces. Used by both the member app and the leaders area, which call CBC_MIN.init(...) after sign in.
// Today only Praise and Worship has a workspace: set lists, the song library and the weekly colour planner.
(function () {
  var ctx = null;
  var PL = window.CBC_PL;
  var $;

  // ---------- tiny DOM helpers (text only, never HTML) ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function btn(label, cls, onclick) {
    var b = el("button", "btn " + (cls || "btn-outline") + " btn-sm", label);
    b.type = "button";
    if (onclick) b.addEventListener("click", onclick);
    return b;
  }

  function field(labelText, control, hint) {
    var wrap = el("div", "field");
    var id = "mf" + Math.random().toString(16).slice(2, 8);
    control.id = id;
    var label = el("label", null, labelText);
    label.htmlFor = id;
    wrap.append(label, control);
    if (hint) wrap.append(el("p", "hint", hint));
    return wrap;
  }

  function input(type, value, attrs) {
    var i = el("input");
    i.type = type;
    i.value = value || "";
    Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); });
    return i;
  }

  function textarea(value, rows, max) {
    var t = el("textarea");
    t.rows = rows || 4;
    if (max) t.maxLength = max;
    t.value = value || "";
    return t;
  }

  // A dialog built on the fly: title, body nodes, and a submit handler that returns a promise or throws a message.
  function dialog(title, body, okLabel, onSubmit) {
    var dlg = el("dialog");
    var form = el("form");
    form.noValidate = true;
    var h2 = el("h2", null, title);
    var err = el("p", "form-status");
    err.setAttribute("role", "alert");
    var actions = el("div", "dialog-actions");
    var cancel = btn("Cancel", "btn-outline");
    var ok = el("button", "btn btn-gold", okLabel || "Save");
    ok.type = "submit";
    actions.append(cancel, ok);
    form.append(h2);
    body.forEach(function (n) { form.append(n); });
    form.append(err, actions);
    dlg.append(form);
    document.body.append(dlg);
    function close() {
      dlg.close();
      dlg.remove();
    }
    cancel.addEventListener("click", close);
    dlg.addEventListener("cancel", function () { dlg.remove(); });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.className = "form-status";
      ok.disabled = true;
      Promise.resolve()
        .then(function () { return onSubmit(); })
        .then(function () { close(); })
        .catch(function (e2) {
          if (e2 && e2.auth) return ctx.toLogin();
          err.textContent = (e2 && e2.message) || "Something went wrong. Please try again.";
          err.className = "form-status show error";
        })
        .then(function () { ok.disabled = false; });
    });
    dlg.showModal();
    return { dlg: dlg, close: close };
  }

  function fail(message) {
    throw new Error(message);
  }

  function dayText(date) {
    var d = new Date(date + "T12:00:00");
    return isNaN(d) ? date : d.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", timeZone: PL.TZ });
  }

  function whenText(iso) {
    return PL.dayLabel(iso) + " at " + PL.clock(new Date(iso));
  }

  var root, current, canWrite, tab;

  // ---------- the list of my ministries ----------
  function tiles(box, list) {
    box.replaceChildren();
    list.forEach(function (m) {
      var t = el("button", "tile");
      t.type = "button";
      t.style.borderLeftColor = m.colour;
      t.append(el("strong", null, m.name), el("span", null, m.role === "leader" ? "You lead this ministry" : m.role === "manager" ? "Manager access" : "Team member"));
      t.addEventListener("click", function () { openMinistry(m); });
      box.append(t);
    });
  }

  function showTiles() {
    return ctx.API.ministries.mine().then(function (list) {
      var home = $("#min-tiles-home");
      var sec = $("#min-section");
      if (home) {
        // Praise and Worship is the only workspace so far
        var mine = list.filter(function (m) { return m.slug === "praise-worship"; });
        if (sec) sec.hidden = mine.length === 0;
        tiles(home, mine);
      }
      var all = $("#min-tiles");
      if (all) {
        tiles(all, list);
        $("#min-empty").hidden = list.length > 0;
      }
    });
  }

  function openMinistry(m) {
    current = m;
    canWrite = m.role === "leader" || m.role === "manager";
    root = $("#min-root");
    root.replaceChildren();
    root.append(el("h1", null, m.name));
    if (m.slug === "praise-worship") {
      renderWorship();
    } else {
      root.append(el("p", "muted", "This ministry's workspace is coming soon."));
    }
    ctx.nav.show("ministry");
  }

  // ---------- Praise and Worship ----------
  var area;

  function renderWorship() {
    var chips = el("div", "chips");
    chips.setAttribute("role", "tablist");
    area = el("div", "min-area");
    var defs = [["sets", "Set lists", showSets], ["songs", "Songs", showSongs], ["colours", "Colours", showColours]];
    function select(name) {
      tab = name;
      Array.prototype.forEach.call(chips.children, function (c) { c.setAttribute("aria-selected", String(c.getAttribute("data-tab") === name)); });
      defs.filter(function (d) { return d[0] === name; })[0][2]();
    }
    defs.forEach(function (d) {
      var c = el("button", "chip", d[1]);
      c.type = "button";
      c.setAttribute("role", "tab");
      c.setAttribute("data-tab", d[0]);
      c.addEventListener("click", function () { select(d[0]); });
      chips.append(c);
    });
    root.append(chips, area);
    select(tab || "sets");
  }

  // ----- set lists -----
  function showSets() {
    area.replaceChildren(el("p", "empty", "Loading…"));
    return ctx.API.worship.setLists().then(function (list) {
      area.replaceChildren();
      if (canWrite) area.append(btn("New set list", "btn-gold", newSet));
      if (!list.length) area.append(el("p", "empty", canWrite ? "No set lists yet. Use New set list to plan Sunday." : "No set lists are ready yet."));
      var box = el("div", "list");
      list.forEach(function (s) {
        var row = el("div", "row");
        row.setAttribute("role", "button");
        row.tabIndex = 0;
        var main = el("span", "main");
        main.append(el("span", "name", s.title), el("span", "sub", whenText(s.startsAt) + "  |  " + s.songCount + (s.songCount === 1 ? " song" : " songs")));
        row.append(main);
        if (canWrite) row.append(el("span", "pill " + (s.status === "published" ? "active" : "pending"), s.status === "published" ? "published" : "draft"));
        var go = function () { openSet(s.id); };
        row.addEventListener("click", go);
        row.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
        box.append(row);
      });
      if (list.length) area.append(box);
    }, ctx.handleError);
  }

  function nextSunday() {
    var d = new Date();
    var add = (7 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + add);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + "T10:00";
  }

  function newSet() {
    var title = input("text", "Sunday Service", { maxlength: "120" });
    var start = input("datetime-local", nextSunday());
    var copy = el("select");
    copy.append(new Option("A blank set list", ""));
    ctx.API.worship.setLists().then(function (l) {
      l.slice(0, 12).forEach(function (s) { copy.append(new Option("Copy of " + s.title + " (" + PL.dayLabel(s.startsAt) + ")", s.id)); });
    });
    dialog("New set list", [field("Title", title), field("Service starts", start), field("Start from", copy, "Copying keeps the songs, versions, keys and notes.")], "Create", function () {
      var iso = PL.fromInput(start.value);
      if (!title.value.trim()) fail("Give the set list a title.");
      if (!iso) fail("Choose when the service starts.");
      return ctx.API.worship.createSet({ title: title.value.trim(), startsAt: iso, copyFrom: copy.value || null }).then(function (id) {
        return openSet(id);
      });
    });
  }

  function lyricsText(set) {
    return set.songs
      .map(function (s, i) {
        var head = (i + 1) + ". " + s.title + (s.key ? " (Key of " + s.key + ")" : "") + (s.versionLabel && s.versionLabel !== "Original" ? " - " + s.versionLabel : "");
        return head + "\n\n" + (s.lyrics || "(no lyrics yet)") + (s.notes ? "\n\nNote: " + s.notes : "");
      })
      .join("\n\n----------\n\n");
  }

  function exportButtons(set) {
    var wrap = el("div", "p-footer");
    wrap.append(
      btn("Copy lyrics", "btn-outline", function () {
        if (!navigator.clipboard) return ctx.toast("Copying isn't available here. Use Download instead.", true);
        navigator.clipboard.writeText(lyricsText(set)).then(function () { ctx.toast("Lyrics copied"); }, function () { ctx.toast("Couldn't copy. Use Download instead.", true); });
      }),
      btn("Download lyrics", "btn-outline", function () {
        var url = URL.createObjectURL(new Blob([set.title + "\n" + whenText(set.startsAt) + "\n\n" + lyricsText(set)], { type: "text/plain;charset=utf-8" }));
        var a = el("a");
        a.href = url;
        a.download = set.title.replace(/[^A-Za-z0-9]+/g, "-") + ".txt";
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      })
    );
    return wrap;
  }

  var set; // the set list being edited
  var baseline = "";
  var versionCache = {};

  function setSnapshot() {
    return JSON.stringify({ t: set.title, s: set.startsAt, p: set.programItemId, n: set.notes, songs: set.songs.map(function (x) { return [x.songId, x.versionId, x.key, x.notes]; }) });
  }

  function openSet(id) {
    return ctx.API.worship.setList(id).then(function (s) {
      if (!s) return ctx.toast("That set list is no longer available.", true);
      set = s;
      baseline = setSnapshot();
      renderSet();
    }, ctx.handleError);
  }

  function renderSet() {
    area.replaceChildren();
    var back = btn("Back to set lists", "btn-outline", function () {
      if (canWrite && setSnapshot() !== baseline && !window.confirm("You have unsaved changes. Leave without saving?")) return;
      showSets();
    });
    area.append(back);
    if (!canWrite) return renderSetReadOnly();

    var title = input("text", set.title, { maxlength: "120" });
    var start = input("datetime-local", PL.toInput(set.startsAt));
    var notes = textarea(set.notes, 2, 2000);
    var status = el("p", "muted", set.status === "published" ? "Published: the team and the media team can see it, with lyrics." : "Draft: only the worship leaders and managers can see it.");
    var form = el("div", "form-card");
    form.append(field("Title", title), field("Service starts", start), field("Notes for the team (optional)", notes), status);
    area.append(form);

    var saveBtn = btn("Save changes", "btn-gold");
    saveBtn.disabled = true;
    function touch() {
      set.title = title.value.trim() || set.title;
      set.startsAt = PL.fromInput(start.value) || set.startsAt;
      set.notes = notes.value.trim();
      saveBtn.disabled = setSnapshot() === baseline;
    }
    [title, start, notes].forEach(function (i) { i.addEventListener("input", touch); i.addEventListener("change", touch); });

    // link to an item in the program
    var linkBox = el("div", "form-card");
    var progSel = el("select");
    var itemSel = el("select");
    progSel.append(new Option("Not linked to a program", ""));
    var itemWrap = field("Worship item", itemSel);
    itemWrap.hidden = true;
    var linkNote = el("p", "hint", set.programItemId ? "Linked to an item in the program. Choose another program below to change it." : "Linking the set list to the worship item in the program lets the media team find it.");
    linkBox.append(field("Program", progSel), itemWrap, linkNote);
    if (ctx.API.program) {
      ctx.API.program.list().then(function (l) {
        l.filter(function (p) { return new Date(p.startsAt).getTime() > Date.now() - 2 * 86400000; }).reverse().forEach(function (p) { progSel.append(new Option(p.title + " (" + PL.dayLabel(p.startsAt) + ")", p.id)); });
      }, function () {});
      progSel.addEventListener("change", function () {
        itemSel.replaceChildren();
        if (!progSel.value) { itemWrap.hidden = true; set.programItemId = null; touch(); return; }
        ctx.API.program.get(progSel.value).then(function (p) {
          itemSel.replaceChildren(new Option("Choose the item", ""));
          var tl = PL.timeline(p.startsAt, p.items);
          tl.rows.forEach(function (r) { itemSel.append(new Option(PL.clock(r.start) + "  " + r.title, r.id)); });
          itemWrap.hidden = false;
        });
      });
      itemSel.addEventListener("change", function () { set.programItemId = itemSel.value || null; touch(); });
    } else {
      linkBox.hidden = true;
    }
    area.append(linkBox);

    // the songs
    var songsBox = el("div", "p-items");
    function paintSongs() {
      songsBox.replaceChildren();
      if (!set.songs.length) songsBox.append(el("p", "empty", "No songs yet. Use Add song."));
      set.songs.forEach(function (s, i) {
        var card = el("div", "p-item w-song");
        var top = el("div", "w-top");
        top.append(el("strong", null, (i + 1) + ". " + s.title));
        var acts = el("span", "p-actions");
        var up = btn("↑", "btn-outline", function () { swap(i, i - 1); });
        up.disabled = i === 0;
        up.setAttribute("aria-label", "Move " + s.title + " up");
        var down = btn("↓", "btn-outline", function () { swap(i, i + 1); });
        down.disabled = i === set.songs.length - 1;
        down.setAttribute("aria-label", "Move " + s.title + " down");
        acts.append(up, down, btn("Remove", "btn-outline", function () { set.songs.splice(i, 1); paintSongs(); touch(); }));
        top.append(acts);
        var ver = el("select");
        ver.setAttribute("aria-label", "Version of " + s.title);
        ver.append(new Option("Default version", ""));
        function fillVersions(v) {
          v.forEach(function (x) { ver.append(new Option(x.label + (x.key ? " (" + x.key + ")" : ""), x.id)); });
          ver.value = s.versionId || "";
        }
        if (versionCache[s.songId]) fillVersions(versionCache[s.songId]);
        else ctx.API.worship.song(s.songId).then(function (song) { versionCache[s.songId] = song ? song.versions : []; fillVersions(versionCache[s.songId]); });
        ver.addEventListener("change", function () { s.versionId = ver.value || null; touch(); });
        var key = input("text", s.key, { maxlength: "12", placeholder: "Key", "aria-label": "Key for " + s.title });
        key.addEventListener("input", function () { s.key = key.value.trim(); touch(); });
        var note = input("text", s.notes, { maxlength: "500", placeholder: "Note (for example: intro x2)", "aria-label": "Note for " + s.title });
        note.addEventListener("input", function () { s.notes = note.value.trim(); touch(); });
        var line = el("div", "w-line");
        line.append(ver, key);
        card.append(top, line, note);
        songsBox.append(card);
      });
    }
    function swap(a, b) {
      if (b < 0 || b >= set.songs.length) return;
      var t = set.songs[a];
      set.songs[a] = set.songs[b];
      set.songs[b] = t;
      paintSongs();
      touch();
    }
    area.append(el("h2", null, "Songs"), songsBox, btn("Add song", "btn-outline", function () {
      pickSong(function (song) {
        set.songs.push({ songId: song.id, title: song.title, versionId: null, versionLabel: "", key: "", lyrics: "", songNotes: "", notes: "" });
        paintSongs();
        touch();
      });
    }));
    paintSongs();

    saveBtn.addEventListener("click", function () {
      touch();
      saveBtn.disabled = true;
      ctx.API.worship
        .saveSet(set.id, { title: set.title, startsAt: set.startsAt, programItemId: set.programItemId, songs: set.songs, notes: set.notes })
        .then(function () { ctx.toast("Saved"); return openSet(set.id); })
        .catch(function (err) { saveBtn.disabled = false; ctx.handleError(err); });
    });
    var pub = btn(set.status === "published" ? "Unpublish" : "Publish", "btn-outline", function () {
      if (setSnapshot() !== baseline) return ctx.toast("Save your changes first.", true);
      var publishing = set.status !== "published";
      if (!window.confirm(publishing ? "Publish this set list? The team, the media team and the managers will be told, and the media team can see the lyrics." : "Unpublish this set list? The media team will no longer see it.")) return;
      ctx.API.worship.publishSet(set.id, publishing).then(function () { ctx.toast(publishing ? "Published" : "Unpublished"); return openSet(set.id); }, ctx.handleError);
    });
    var del = btn("Delete set list", "btn-danger", function () {
      if (!window.confirm("Delete “" + set.title + "”? This can't be undone.")) return;
      ctx.API.worship.deleteSet(set.id).then(function () { ctx.toast("Set list deleted"); showSets(); }, ctx.handleError);
    });
    var foot = el("div", "p-footer");
    foot.append(saveBtn, pub, del);
    area.append(foot, exportButtons(set));
  }

  function renderSetReadOnly() {
    area.append(el("h2", null, set.title), el("p", "muted", whenText(set.startsAt)));
    if (set.notes) area.append(el("p", "service-notes", set.notes));
    set.songs.forEach(function (s, i) {
      var card = el("article", "p-card");
      var top = el("div", "p-card-top");
      top.append(el("span", "p-time", String(i + 1)), el("h3", null, s.title));
      card.append(top);
      var sub = [s.key ? "Key of " + s.key : "", s.versionLabel && s.versionLabel !== "Original" ? s.versionLabel : "", s.author].filter(Boolean).join("  |  ");
      if (sub) card.append(el("p", "service-line", sub));
      if (s.notes) card.append(el("p", "service-notes", s.notes));
      if (s.lyrics) {
        var b = btn("Lyrics", "btn-outline");
        b.setAttribute("aria-expanded", "false");
        b.addEventListener("click", function () {
          var ex = card.querySelector(".lyrics");
          if (ex) { ex.remove(); b.setAttribute("aria-expanded", "false"); return; }
          b.setAttribute("aria-expanded", "true");
          card.append(el("pre", "lyrics", s.lyrics));
        });
        card.append(b);
      }
      area.append(card);
    });
    area.append(exportButtons(set));
  }

  function pickSong(onPick) {
    var q = input("search", "", { placeholder: "Search by title, author or words", autocomplete: "off" });
    var list = el("div", "list pick-list");
    var timer;
    function load() {
      ctx.API.worship.songs(q.value).then(function (songs) {
        list.replaceChildren();
        if (!songs.length) list.append(el("p", "empty", "No songs found. Add songs in the Songs tab first."));
        songs.forEach(function (s) {
          var row = el("button", "row");
          row.type = "button";
          var main = el("span", "main");
          main.append(el("span", "name", s.title), el("span", "sub", [s.author, s.keys].filter(Boolean).join("  |  ")));
          row.append(main);
          row.addEventListener("click", function () { d.close(); onPick(s); });
          list.append(row);
        });
      }, function () {});
    }
    q.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(load, 250); });
    var d = dialog("Add a song", [q, list], "Close", function () {});
    load();
  }

  // ----- songs -----
  function showSongs() {
    area.replaceChildren();
    var q = input("search", "", { placeholder: "Search by title, author or words", autocomplete: "off" });
    var list = el("div", "list");
    var timer;
    function load() {
      ctx.API.worship.songs(q.value, canWrite).then(function (songs) {
        list.replaceChildren();
        list.hidden = songs.length === 0;
        songs.forEach(function (s) {
          var row = el("div", "row");
          row.setAttribute("role", "button");
          row.tabIndex = 0;
          var main = el("span", "main");
          main.append(el("span", "name", s.title), el("span", "sub", [s.author, s.keys ? "Keys: " + s.keys : "", s.versions + (s.versions === 1 ? " version" : " versions")].filter(Boolean).join("  |  ")));
          row.append(main);
          if (s.archived) row.append(el("span", "pill inactive", "archived"));
          var go = function () { openSong(s.id); };
          row.addEventListener("click", go);
          row.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
          list.append(row);
        });
        empty.hidden = songs.length > 0;
      }, ctx.handleError);
    }
    var empty = el("p", "empty", canWrite ? "No songs yet. Use New song to add the first one." : "No songs found.");
    empty.hidden = true;
    q.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(load, 250); });
    if (canWrite) area.append(btn("New song", "btn-gold", function () { editSong(null, onSaved); }));
    area.append(el("div", "search").appendChild(q).parentNode, list, empty);
    function onSaved() { versionCache = {}; load(); }
    load();
    showSongs.reload = load;
  }

  function openSong(id) {
    ctx.API.worship.song(id).then(function (s) {
      if (!s) return;
      if (canWrite) editSong(s, function () { versionCache = {}; if (showSongs.reload) showSongs.reload(); });
      else readSong(s);
    }, ctx.handleError);
  }

  function readSong(s) {
    var body = [];
    if (s.author) body.push(el("p", "muted", s.author));
    s.versions.forEach(function (v) {
      var box = el("div", "form-card");
      box.append(el("strong", null, v.label + (v.key ? "  |  Key of " + v.key : "")));
      if (v.notes) box.append(el("p", "service-notes", v.notes));
      box.append(el("pre", "lyrics", v.lyrics || "(no lyrics yet)"));
      body.push(box);
    });
    var d = dialog(s.title, body, "Close", function () {});
    d.dlg.querySelector("button[type=button]").hidden = true;
  }

  function editSong(song, done) {
    var data = song || { id: null, title: "", author: "", archived: false, versions: [{ id: null, label: "Original", key: "", lyrics: "", notes: "" }] };
    var title = input("text", data.title, { maxlength: "120" });
    var author = input("text", data.author, { maxlength: "120" });
    var versionsBox = el("div");
    function paint() {
      versionsBox.replaceChildren();
      data.versions.forEach(function (v, i) {
        var card = el("div", "form-card");
        var label = input("text", v.label, { maxlength: "60" });
        var key = input("text", v.key, { maxlength: "12", placeholder: "G" });
        var lyrics = textarea(v.lyrics, 8, 20000);
        var notes = textarea(v.notes, 2, 2000);
        label.addEventListener("input", function () { v.label = label.value; });
        key.addEventListener("input", function () { v.key = key.value; });
        lyrics.addEventListener("input", function () { v.lyrics = lyrics.value; });
        notes.addEventListener("input", function () { v.notes = notes.value; });
        card.append(field("Version name", label, i === 0 ? "For example Original, Acoustic or Youth key." : null), field("Key", key), field("Lyrics", lyrics), field("Notes (optional)", notes));
        if (data.versions.length > 1) card.append(btn("Remove this version", "btn-danger", function () { data.versions.splice(i, 1); paint(); }));
        versionsBox.append(card);
      });
    }
    paint();
    var add = btn("Add a version", "btn-outline", function () { if (data.versions.length < 12) { data.versions.push({ id: null, label: "", key: "", lyrics: "", notes: "" }); paint(); } });
    var extras = [];
    if (song) {
      extras.push(btn(data.archived ? "Restore to the library" : "Archive this song", "btn-outline", function () {
        ctx.API.worship.archive(data.id, !data.archived).then(function () { d.close(); ctx.toast(data.archived ? "Song restored" : "Song archived"); done(); }, ctx.handleError);
      }));
    }
    var d = dialog(song ? "Edit song" : "New song", [field("Title", title), field("Author (optional)", author), versionsBox, add].concat(extras), "Save", function () {
      var t = title.value.trim();
      if (!t) fail("Give the song a title.");
      var vs = data.versions.filter(function (v) { return (v.label || "").trim(); });
      if (!vs.length) fail("Give the version a name.");
      return ctx.API.worship.saveSong(data.id, { title: t, author: author.value.trim(), versions: vs.map(function (v) { return { id: v.id, label: v.label.trim(), key: (v.key || "").trim(), lyrics: v.lyrics, notes: (v.notes || "").trim() }; }) }).then(function () {
        ctx.toast("Song saved");
        done();
      });
    });
  }

  // ----- colours -----
  function showColours() {
    area.replaceChildren(el("p", "empty", "Loading…"));
    return ctx.API.worship.colours().then(function (plans) {
      area.replaceChildren();
      if (canWrite) area.append(btn("Add a colour plan", "btn-gold", function () { editColours(null); }));
      if (!plans.length) area.append(el("p", "empty", canWrite ? "No colour plans yet." : "No colours have been set yet."));
      plans.forEach(function (p) {
        var card = el("article", "service-card");
        var head = el("div", "sermon-head");
        head.append(el("h3", null, dayText(p.date)));
        if (canWrite) head.append(el("span", "priority-badge", p.status === "published" ? "Published" : "Draft"));
        card.append(head);
        var sw = el("div", "swatches");
        p.colours.forEach(function (c) {
          var s = el("span", "swatch");
          var dot = el("i");
          dot.style.background = c.hex;
          s.append(dot, document.createTextNode(c.name || c.hex));
          sw.append(s);
        });
        card.append(sw);
        if (p.note) card.append(el("p", "service-notes", p.note));
        if (canWrite) {
          var acts = el("div", "sermon-actions");
          acts.append(btn("Edit", "btn-outline", function () { editColours(p); }), btn("Delete", "btn-danger", function () {
            if (!window.confirm("Delete this colour plan?")) return;
            ctx.API.worship.deleteColours(p.id).then(function () { ctx.toast("Deleted"); showColours(); }, ctx.handleError);
          }));
          card.append(acts);
        }
        area.append(card);
      });
    }, ctx.handleError);
  }

  function editColours(plan) {
    var date = input("date", plan ? plan.date : "");
    var note = input("text", plan ? plan.note : "", { maxlength: "500", placeholder: "For example: smart casual" });
    var colours = plan ? plan.colours.map(function (c) { return { name: c.name || "", hex: c.hex }; }) : [{ name: "", hex: "#1b2430" }];
    var rows = el("div");
    function paint() {
      rows.replaceChildren();
      colours.forEach(function (c, i) {
        var line = el("div", "w-line");
        var name = input("text", c.name, { maxlength: "40", placeholder: "Colour name", "aria-label": "Colour name " + (i + 1) });
        var pick = input("color", c.hex, { "aria-label": "Colour " + (i + 1) });
        name.addEventListener("input", function () { c.name = name.value; });
        pick.addEventListener("input", function () { c.hex = pick.value; });
        line.append(name, pick);
        if (colours.length > 1) line.append(btn("Remove", "btn-outline", function () { colours.splice(i, 1); paint(); }));
        rows.append(line);
      });
    }
    paint();
    var add = btn("Add a colour", "btn-outline", function () { if (colours.length < 6) { colours.push({ name: "", hex: "#c9a24d" }); paint(); } });
    var pub = el("input");
    pub.type = "checkbox";
    pub.checked = plan ? plan.status === "published" : true;
    var pubWrap = el("div", "field check");
    var pubLabel = el("label", null, "Tell the team now (they also get a reminder the evening before)");
    pub.id = "pub" + Math.random().toString(16).slice(2, 8);
    pubLabel.htmlFor = pub.id;
    pubWrap.append(pub, pubLabel);
    dialog(plan ? "Edit colour plan" : "New colour plan", [field("Service date", date), rows, add, field("Note (optional)", note), pubWrap], "Save", function () {
      if (!date.value) fail("Choose the service date.");
      return ctx.API.worship.saveColours({ date: date.value, colours: colours.map(function (c) { return { name: c.name.trim(), hex: c.hex }; }), note: note.value.trim(), publish: pub.checked }).then(function () {
        ctx.toast("Colour plan saved");
        showColours();
      });
    });
  }

  // ---------- start ----------
  function init(c) {
    ctx = c;
    $ = c.$;
    var back = $("#min-back");
    if (back) {
      back.addEventListener("click", function () {
        if (set && canWrite && tab === "sets" && area && area.querySelector(".form-card") && setSnapshot() !== baseline && !window.confirm("You have unsaved changes. Leave without saving?")) return;
        set = null;
        ctx.nav.show(back.getAttribute("data-back"));
      });
    }
    showTiles();
  }

  window.CBC_MIN = { init: init, showTiles: showTiles };
})();
