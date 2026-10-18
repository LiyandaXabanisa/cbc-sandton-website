// The leaders' Weekly Program editor. Loaded after admin.js, which calls CBC_PROGRAM.init(...) once signed in.
(function () {
  var ctx = null;
  var PL = window.CBC_PL;
  var TZ = PL.TZ;
  var $, h;

  var programs = [];
  var cur = null; // the program being edited: { id, title, startsAt, status, version, items: [...] }
  var baseline = "";
  var editingIndex = -1;

  // ---------- small helpers ----------
  function inputValue(iso) {
    // datetime-local boxes show the church's own time (South Africa), whatever the computer's clock is
    var d = new Date(iso);
    if (isNaN(d)) return "";
    var parts = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
    return parts.replace(" ", "T");
  }

  function fromInput(value) {
    // value is a South African wall clock time, so build the instant for UTC+2
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value || "");
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 2, +m[5])).toISOString();
  }

  function whenText(iso) {
    return PL.dayLabel(iso) + " at " + PL.clock(new Date(iso));
  }

  function snapshotOf(p) {
    return JSON.stringify({
      title: p.title,
      startsAt: p.startsAt,
      items: p.items.map(function (i) {
        return { id: i.id || null, title: i.title, minutes: i.minutes, department: i.department, presenterId: i.presenterId, presenterName: i.presenterName, notes: i.notes || "" };
      }),
    });
  }

  function dirty() {
    return !!cur && snapshotOf(cur) !== baseline;
  }

  function memberOptions() {
    return ctx
      .members()
      .filter(function (m) { return m.hasAccount && m.userId && m.status === "active"; })
      .sort(function (a, b) { return a.fullName.localeCompare(b.fullName); });
  }

  function nameForUser(userId) {
    var m = ctx.members().filter(function (x) { return x.userId === userId; })[0];
    return m ? m.fullName : "";
  }

  // ---------- the list of programs ----------
  function showList() {
    return ctx.API.program
      .list()
      .then(function (list) {
        programs = list;
        var box = $("#program-list");
        box.replaceChildren();
        $("#program-empty").hidden = list.length > 0;
        box.hidden = list.length === 0;
        list.forEach(function (p) {
          box.append(
            h(
              "div",
              { class: "row", role: "button", tabindex: "0", onclick: function () { openProgram(p.id); }, onkeydown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openProgram(p.id); } } },
              h("span", { class: "main" }, h("span", { class: "name", text: p.title }), h("span", { class: "sub", text: whenText(p.startsAt) + "  |  " + p.itemCount + (p.itemCount === 1 ? " item" : " items") })),
              h("span", { class: "pill " + (p.status === "published" ? "active" : "pending"), text: p.status === "published" ? "published" : "draft" })
            )
          );
        });
      })
      .catch(ctx.handleError);
  }

  // ---------- new program ----------
  var newDialog;

  function nextSunday() {
    var d = new Date();
    var add = (7 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + add);
    var y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, "0"), da = String(d.getDate()).padStart(2, "0");
    return y + "-" + mo + "-" + da + "T10:00";
  }

  function openNew() {
    $("#pn-name").value = "Sunday Service";
    $("#pn-start").value = nextSunday();
    $("#pn-error").className = "form-status";
    var copy = $("#pn-copy");
    copy.replaceChildren(h("option", { value: "", text: "A blank program" }));
    programs.slice(0, 12).forEach(function (p) {
      copy.append(h("option", { value: p.id, text: "Copy of " + p.title + " (" + PL.dayLabel(p.startsAt) + ")" }));
    });
    var svc = $("#pn-service");
    svc.replaceChildren(h("option", { value: "", text: "Not linked" }));
    if (ctx.API.admin.services) {
      ctx.API.admin.services.list().then(function (list) {
        var cutoff = Date.now() - 2 * 24 * 3600 * 1000;
        list.filter(function (s) { return new Date(s.startsAt).getTime() >= cutoff; }).reverse().forEach(function (s) {
          svc.append(h("option", { value: s.id, text: whenText(s.startsAt) + "  " + s.title }));
        });
      }, function () {});
    }
    newDialog.showModal();
    $("#pn-name").focus();
  }

  function submitNew(e) {
    e.preventDefault();
    var fail = function (m) { ctx.dialogError("#pn-error", m); };
    var title = $("#pn-name").value.trim();
    var startsAt = fromInput($("#pn-start").value);
    if (!title) return fail("Give the program a title.");
    if (!startsAt) return fail("Choose when the service starts.");
    var btn = $("#pn-save");
    btn.disabled = true;
    ctx.API.program
      .create({ title: title, startsAt: startsAt, serviceId: $("#pn-service").value || null, copyFrom: $("#pn-copy").value || null })
      .then(function (id) {
        newDialog.close();
        return openProgram(id);
      })
      .catch(function (err) {
        if (err && err.auth) return ctx.toLogin();
        fail((err && err.message) || "Couldn't create it. Please try again.");
      })
      .then(function () { btn.disabled = false; });
  }

  // ---------- the editor ----------
  function openProgram(id) {
    return ctx.API.program
      .get(id)
      .then(function (p) {
        if (!p) throw new Error("That program is no longer available.");
        cur = p;
        baseline = snapshotOf(cur);
        renderEditor();
        ctx.nav.show("program-edit");
      })
      .catch(ctx.handleError);
  }

  function renderSummary() {
    var tl = PL.timeline(cur.startsAt, cur.items);
    $("#pe-summary").textContent = cur.items.length
      ? "Starts " + PL.clock(new Date(cur.startsAt)) + ", ends " + PL.clock(tl.end) + "  |  " + tl.total + " minutes in all"
      : "";
    $("#pe-heading").textContent = cur.title || "Program";
  }

  function renderEditor() {
    $("#pe-title").value = cur.title;
    $("#pe-start").value = inputValue(cur.startsAt);
    $("#pe-status").textContent =
      (cur.status === "published" ? "Published: members and the media team can see it." : "Draft: only managers can see it.") + "  Version " + cur.version + ".";
    $("#pe-publish").textContent = cur.status === "published" ? "Unpublish" : "Publish";
    renderItems();
    refreshButtons();
  }

  function refreshButtons() {
    $("#pe-save").disabled = !dirty();
    renderSummary();
  }

  function itemRow(it, index, tl) {
    var row = tl.rows[index];
    var sub = [it.department, it.presenterId ? nameForUser(it.presenterId) || "Presenter" : it.presenterName, it.minutes + " min"].filter(Boolean).join("  |  ");
    var li = h(
      "div",
      { class: "p-item", "data-index": String(index) },
      h("button", { class: "p-handle", type: "button", "aria-label": "Drag to move " + it.title, title: "Drag to reorder" }, "⋮⋮"),
      h("span", { class: "p-time", text: PL.clock(row.start) }),
      h("span", { class: "main" }, h("span", { class: "name", text: it.title }), h("span", { class: "sub", text: sub })),
      h(
        "span",
        { class: "p-actions" },
        h("button", { class: "btn btn-outline btn-sm", type: "button", "aria-label": "Move " + it.title + " up", text: "↑", disabled: index === 0, onclick: function () { move(index, index - 1); } }),
        h("button", { class: "btn btn-outline btn-sm", type: "button", "aria-label": "Move " + it.title + " down", text: "↓", disabled: index === cur.items.length - 1, onclick: function () { move(index, index + 1); } }),
        h("button", { class: "btn btn-outline btn-sm", type: "button", text: "Edit", onclick: function () { openItem(index); } }),
        h("button", { class: "btn btn-outline btn-sm", type: "button", "aria-label": "Remove " + it.title, text: "Remove", onclick: function () { removeItem(index); } })
      )
    );
    return li;
  }

  function renderItems() {
    var box = $("#pe-items");
    box.replaceChildren();
    $("#pe-empty").hidden = cur.items.length > 0;
    var tl = PL.timeline(cur.startsAt, cur.items);
    cur.items.forEach(function (it, i) { box.append(itemRow(it, i, tl)); });
  }

  function move(from, to) {
    if (to < 0 || to >= cur.items.length || from === to) return;
    var it = cur.items.splice(from, 1)[0];
    cur.items.splice(to, 0, it);
    renderItems();
    refreshButtons();
  }

  function removeItem(i) {
    if (!window.confirm("Remove “" + cur.items[i].title + "” from the program?")) return;
    cur.items.splice(i, 1);
    renderItems();
    refreshButtons();
  }

  // Drag by the handle. Works with a finger as well as a mouse.
  function enableDrag() {
    var box = $("#pe-items");
    var dragging = null;
    var from = -1;

    box.addEventListener("pointerdown", function (e) {
      var handle = e.target.closest(".p-handle");
      if (!handle) return;
      dragging = handle.closest(".p-item");
      from = Number(dragging.getAttribute("data-index"));
      dragging.classList.add("dragging");
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });

    box.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var rows = Array.prototype.slice.call(box.children).filter(function (r) { return r !== dragging; });
      var before = null;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { before = rows[i]; break; }
      }
      if (before) box.insertBefore(dragging, before);
      else box.append(dragging);
    });

    function finish() {
      if (!dragging) return;
      var order = Array.prototype.slice.call(box.children).map(function (r) { return Number(r.getAttribute("data-index")); });
      dragging.classList.remove("dragging");
      dragging = null;
      var reordered = order.map(function (idx) { return cur.items[idx]; });
      var changed = order.some(function (idx, pos) { return idx !== pos; });
      if (changed) {
        cur.items = reordered;
        renderItems();
        refreshButtons();
      }
    }
    box.addEventListener("pointerup", finish);
    box.addEventListener("pointercancel", finish);
  }

  // ---------- one item ----------
  var itemDialog;

  function fillPresenters(selectedId, otherName) {
    var sel = $("#pi-pres");
    sel.replaceChildren(h("option", { value: "", text: "No presenter yet" }));
    memberOptions().forEach(function (m) { sel.append(h("option", { value: m.userId, text: m.fullName })); });
    sel.append(h("option", { value: "__other", text: "Someone else (type a name)" }));
    sel.value = selectedId || (otherName ? "__other" : "");
    $("#pi-other-wrap").hidden = sel.value !== "__other";
    $("#pi-other").value = otherName || "";
  }

  function openItem(index) {
    editingIndex = index;
    var it = index >= 0 ? cur.items[index] : { title: "", minutes: 5, department: "", presenterId: null, presenterName: "", notes: "" };
    $("#pi-title").textContent = index >= 0 ? "Edit item" : "Add item";
    $("#pi-name").value = it.title;
    $("#pi-min").value = it.minutes;
    $("#pi-dept").value = it.department || "";
    $("#pi-notes").value = it.notes || "";
    fillPresenters(it.presenterId, it.presenterName);
    $("#pi-error").className = "form-status";
    itemDialog.showModal();
    $("#pi-name").focus();
  }

  function submitItem(e) {
    e.preventDefault();
    var fail = function (m) { ctx.dialogError("#pi-error", m); };
    var title = $("#pi-name").value.trim();
    var minutes = parseInt($("#pi-min").value, 10);
    if (!title) return fail("Say what happens.");
    if (!(minutes >= 1 && minutes <= 600)) return fail("The length must be between 1 and 600 minutes.");
    var pres = $("#pi-pres").value;
    var other = $("#pi-other").value.trim();
    if (pres === "__other" && !other) return fail("Type the presenter's name, or choose No presenter yet.");
    var it = {
      id: editingIndex >= 0 ? cur.items[editingIndex].id : null,
      title: title,
      minutes: minutes,
      department: $("#pi-dept").value.trim(),
      presenterId: pres && pres !== "__other" ? pres : null,
      presenterName: pres === "__other" ? other : "",
      notes: $("#pi-notes").value.trim(),
    };
    if (editingIndex >= 0) cur.items[editingIndex] = it;
    else cur.items.push(it);
    itemDialog.close();
    renderItems();
    refreshButtons();
  }

  // ---------- save, publish, delete ----------
  var saveDialog;

  function readHeader() {
    cur.title = $("#pe-title").value.trim() || cur.title;
    var iso = fromInput($("#pe-start").value);
    if (iso) cur.startsAt = iso;
  }

  function openSave() {
    readHeader();
    if (!dirty()) return;
    $("#ps-note").textContent =
      cur.status === "published"
        ? "This program is published, so the media team, the managers and the presenters will be told about the change."
        : "This is a draft, so nobody is told yet.";
    $("#ps-summary").value = "";
    saveDialog.showModal();
    $("#ps-summary").focus();
  }

  function submitSave(e) {
    e.preventDefault();
    var btn = $("#ps-save");
    btn.disabled = true;
    ctx.API.program
      .save(cur.id, { title: cur.title, startsAt: cur.startsAt, items: cur.items, summary: $("#ps-summary").value.trim() })
      .then(function () {
        saveDialog.close();
        ctx.toast("Saved");
        return openProgram(cur.id);
      })
      .catch(function (err) {
        if (err && err.auth) return ctx.toLogin();
        saveDialog.close();
        ctx.toast((err && err.message) || "Couldn't save. Please try again.", true);
      })
      .then(function () { btn.disabled = false; });
  }

  function togglePublish() {
    if (dirty()) return ctx.toast("Save your changes first.", true);
    var publishing = cur.status !== "published";
    var ask = publishing
      ? "Publish this program? The media team, the managers and the presenters will be told, and members will be able to see it."
      : "Unpublish this program? Members and the media team will no longer see it.";
    if (!window.confirm(ask)) return;
    ctx.API.program.publish(cur.id, publishing).then(function () { return openProgram(cur.id); }).then(function () { ctx.toast(publishing ? "Published" : "Unpublished"); }).catch(ctx.handleError);
  }

  function deleteProgram() {
    if (!window.confirm("Delete “" + cur.title + "”? Its history and files go too, and presenters lose their access. This can't be undone.")) return;
    ctx.API.program.remove(cur.id).then(function () {
      cur = null;
      baseline = "";
      ctx.toast("Program deleted");
      ctx.nav.show("program");
    }).catch(ctx.handleError);
  }

  function leave() {
    if (dirty() && !window.confirm("You have unsaved changes. Leave without saving?")) return;
    cur = null;
    baseline = "";
    ctx.nav.show("program");
  }

  // ---------- history ----------
  var historyDialog;

  function openHistory() {
    var box = $("#ph-list");
    box.replaceChildren(h("p", { class: "empty", text: "Loading…" }));
    historyDialog.showModal();
    ctx.API.program.history(cur.id).then(function (rows) {
      box.replaceChildren();
      rows.forEach(function (v, i) {
        var prev = rows[i + 1];
        var lines = prev ? PL.describe(PL.diff(prev.snapshot, v.snapshot)) : ["First version"];
        var detail = h("ul", { class: "p-changes" });
        (lines.length ? lines : ["No visible change"]).forEach(function (l) { detail.append(h("li", { text: l })); });
        box.append(
          h(
            "div",
            { class: "ph-row" },
            h("strong", { text: "Version " + v.version + (i === 0 ? " (current)" : "") }),
            h("span", { class: "sub", text: v.by + "  |  " + new Date(v.at).toLocaleString("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ }) }),
            v.summary ? h("span", { text: v.summary }) : null,
            detail,
            i === 0
              ? null
              : ctx.actionButton("Restore this version", "btn-outline", function () {
                  if (dirty() && !window.confirm("Restoring replaces your unsaved changes. Continue?")) return;
                  if (!window.confirm("Restore version " + v.version + "? This saves a new version, so nothing is lost.")) return;
                  ctx.API.program.restore(v.id).then(function () { historyDialog.close(); return openProgram(cur.id); }).then(function () { ctx.toast("Version restored"); }).catch(ctx.handleError);
                })
          )
        );
      });
    }, function (err) { historyDialog.close(); ctx.handleError(err); });
  }

  // ---------- print ----------
  function printProgram() {
    var tl = PL.timeline(cur.startsAt, cur.items);
    var area = $("#print-area");
    area.replaceChildren(h("h1", { text: cur.title }), h("p", { text: whenText(cur.startsAt) }));
    var table = h("table", { class: "print-table" }, h("thead", null, h("tr", null, h("th", { text: "Time" }), h("th", { text: "Item" }), h("th", { text: "Department" }), h("th", { text: "Presenter" }), h("th", { text: "Minutes" }))));
    var body = h("tbody");
    tl.rows.forEach(function (r) {
      body.append(h("tr", null,
        h("td", { text: PL.clock(r.start) }),
        h("td", { text: r.title }),
        h("td", { text: r.department || "" }),
        h("td", { text: r.presenterId ? nameForUser(r.presenterId) : r.presenterName || "" }),
        h("td", { text: String(r.minutes) })));
    });
    table.append(body);
    area.append(table, h("p", { class: "print-end", text: "Ends " + PL.clock(tl.end) + "  |  " + tl.total + " minutes" }));
    window.print();
  }

  // ---------- start ----------
  function init(c) {
    ctx = c;
    $ = c.$;
    h = c.h;
    newDialog = $("#pn-dialog");
    itemDialog = $("#pi-dialog");
    saveDialog = $("#ps-dialog");
    historyDialog = $("#ph-dialog");

    $("#new-program").addEventListener("click", openNew);
    $("#pn-cancel").addEventListener("click", function () { newDialog.close(); });
    $("#pn-form").addEventListener("submit", submitNew);
    $("#pe-back").addEventListener("click", leave);
    $("#pe-add").addEventListener("click", function () { openItem(-1); });
    $("#pi-cancel").addEventListener("click", function () { itemDialog.close(); });
    $("#pi-form").addEventListener("submit", submitItem);
    $("#pi-pres").addEventListener("change", function () {
      $("#pi-other-wrap").hidden = $("#pi-pres").value !== "__other";
    });
    $("#pe-save").addEventListener("click", openSave);
    $("#ps-cancel").addEventListener("click", function () { saveDialog.close(); });
    $("#ps-form").addEventListener("submit", submitSave);
    $("#pe-publish").addEventListener("click", togglePublish);
    $("#pe-delete").addEventListener("click", deleteProgram);
    $("#pe-history").addEventListener("click", openHistory);
    $("#pe-print").addEventListener("click", function () { if (cur) { readHeader(); printProgram(); } });
    $("#ph-close").addEventListener("click", function () { historyDialog.close(); });
    $("#pe-title").addEventListener("input", function () { readHeader(); refreshButtons(); });
    $("#pe-start").addEventListener("change", function () { readHeader(); renderItems(); refreshButtons(); });
    enableDrag();
    window.addEventListener("beforeunload", function (e) {
      if (dirty()) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  window.CBC_PROGRAM = { init: init, showList: showList };
})();
