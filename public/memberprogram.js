// The member side of the Weekly Program: the Program tab, and "Your part" on Home for presenters.
// Loaded after member.js, which calls CBC_MPROG.init(...) once the member is signed in.
(function () {
  var ctx = null;
  var PL = window.CBC_PL;
  var $, el;
  var current = null;

  var ALLOWED = /\.(pdf|pptx?|docx?|png|jpe?g|webp)$/i;

  function fileSize(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  }

  function whenText(iso) {
    return PL.dayLabel(iso) + " at " + PL.clock(new Date(iso));
  }

  function note(box, message) {
    var p = el("p", "empty", message);
    box.prepend(p);
    setTimeout(function () { p.remove(); }, 4000);
  }

  // ----- files for one item: list, download (a five minute link) and, for the presenter, upload -----
  function filesBox(itemId, canUpload, onChange) {
    var box = el("div", "item-files");
    var list = el("div", "item-file-list");
    box.append(list);

    function load() {
      return ctx.API.program.files(itemId).then(
        function (files) {
          list.replaceChildren();
          if (!files.length) list.append(el("p", "empty", canUpload ? "No files yet." : "No files."));
          files.forEach(function (f) {
            var row = el("div", "file-row");
            row.append(el("span", "fname", f.name + "  (" + fileSize(f.size) + ")"));
            var dl = el("button", "btn btn-gold btn-sm", "Download");
            dl.type = "button";
            dl.addEventListener("click", function () {
              dl.disabled = true;
              ctx.API.program.fileLink(f.path).then(
                function (url) { window.open(url, "_blank", "noopener"); dl.disabled = false; },
                function (err) { dl.disabled = false; note(box, (err && err.message) || "That file isn't available."); }
              );
            });
            row.append(dl);
            if (canUpload && f.mine) {
              var rm = el("button", "btn btn-outline btn-sm", "Remove");
              rm.type = "button";
              rm.addEventListener("click", function () {
                if (!window.confirm("Remove " + f.name + "?")) return;
                ctx.API.program.removeFile(f).then(function () { load(); if (onChange) onChange(); }, function (err) { note(box, (err && err.message) || "Couldn't remove it."); });
              });
              row.append(rm);
            }
            list.append(row);
          });
        },
        function () { list.replaceChildren(el("p", "empty", "The files couldn't be loaded.")); }
      );
    }

    if (canUpload) {
      var label = el("label", "upload-label", "Add a file (PowerPoint, PDF, Word or a picture, up to 25 MB)");
      var input = el("input");
      input.type = "file";
      input.multiple = true;
      input.accept = ".pdf,.ppt,.pptx,.doc,.docx,.png,.jpg,.jpeg,.webp";
      label.append(input);
      var status = el("p", "empty");
      input.addEventListener("change", function () {
        var chosen = Array.prototype.slice.call(input.files);
        input.value = "";
        var bad = chosen.filter(function (f) { return !ALLOWED.test(f.name); });
        if (bad.length) status.textContent = "Only PowerPoint, Word, PDF and picture files can be added: " + bad.map(function (f) { return f.name; }).join(", ");
        chosen = chosen.filter(function (f) { return ALLOWED.test(f.name); });
        if (!chosen.length) return;
        input.disabled = true;
        status.textContent = "Uploading…";
        chosen
          .reduce(function (chain, f) { return chain.then(function () { return ctx.API.program.upload(itemId, f); }); }, Promise.resolve())
          .then(function () { status.textContent = "Uploaded."; return load(); })
          .then(function () { if (onChange) onChange(); })
          .catch(function (err) { status.textContent = (err && err.message) || "A file couldn't be uploaded."; })
          .then(function () { input.disabled = false; });
      });
      box.append(label, status);
    }
    load();
    return box;
  }

  // ----- Home: the items I present -----
  function showMine() {
    return ctx.API.program.myItems().then(
      function (items) {
        var box = $("#mine-list");
        box.replaceChildren();
        $("#mine-section").hidden = items.length === 0;
        items.forEach(function (it) {
          var card = el("article", "service-card mine-card");
          card.append(el("h3", null, it.title));
          card.append(el("p", "service-when", it.programTitle + ", " + whenText(it.startsAt)));
          var line = el("p", "service-line");
          line.append(el("span", "service-key", "Length"), " " + it.minutes + " min" + (it.department ? "  |  " + it.department : ""));
          card.append(line);
          if (it.notes) card.append(el("p", "service-notes", it.notes));
          if (it.canUpload && it.expiresAt) {
            card.append(el("p", "service-line", "You can add or change files until the end of " + PL.dayLabel(it.expiresAt) + "."));
          }
          card.append(filesBox(it.itemId, it.canUpload));
          var open = el("button", "btn btn-outline btn-sm", "See the full program");
          open.type = "button";
          open.addEventListener("click", function () { openProgram(it.programId); });
          card.append(open);
          box.append(card);
        });
      },
      function () { $("#mine-section").hidden = true; }
    );
  }

  // ----- Program tab -----
  function showList() {
    return ctx.API.program.list().then(
      function (list) {
        var box = $("#mp-list");
        box.replaceChildren();
        // members only see published programs; managers who open the member area see drafts too, marked as drafts
        $("#mp-empty").hidden = list.length > 0;
        list.forEach(function (p) {
          var card = el("article", "service-card mp-card");
          var head = el("div", "sermon-head");
          head.append(el("h3", null, p.title));
          if (p.status !== "published") head.append(el("span", "priority-badge", "Draft"));
          card.append(head, el("p", "service-when", whenText(p.startsAt)), el("p", "service-line", p.itemCount + (p.itemCount === 1 ? " item" : " items")));
          var open = el("button", "btn btn-gold btn-sm", "Open");
          open.type = "button";
          open.addEventListener("click", function () { openProgram(p.id); });
          card.append(open);
          box.append(card);
        });
      },
      function () { $("#mp-empty").hidden = false; }
    );
  }

  function openProgram(id) {
    return ctx.API.program.get(id).then(function (p) {
      if (!p) return;
      current = p;
      $("#mp-title").textContent = p.title;
      $("#mp-when").textContent = whenText(p.startsAt) + (p.status !== "published" ? "  |  Draft" : "");
      var tl = PL.timeline(p.startsAt, p.items);
      var box = $("#mp-items");
      box.replaceChildren();
      tl.rows.forEach(function (r) {
        var card = el("article", "p-card");
        var top = el("div", "p-card-top");
        top.append(el("span", "p-time", PL.clock(r.start)), el("h3", null, r.title));
        card.append(top);
        var sub = [r.department, r.presenterName, r.minutes + " min"].filter(Boolean).join("  |  ");
        card.append(el("p", "service-line", sub));
        if (r.notes) card.append(el("p", "service-notes", r.notes));
        if (r.fileCount > 0) {
          var btn = el("button", "btn btn-outline btn-sm", "Files (" + r.fileCount + ")");
          btn.type = "button";
          btn.setAttribute("aria-expanded", "false");
          btn.addEventListener("click", function () {
            var existing = card.querySelector(".item-files");
            if (existing) {
              existing.remove();
              btn.setAttribute("aria-expanded", "false");
              return;
            }
            btn.setAttribute("aria-expanded", "true");
            card.append(filesBox(r.id, false));
          });
          card.append(btn);
        }
        box.append(card);
      });
      box.append(el("p", "empty", "Ends " + PL.clock(tl.end) + "  |  " + tl.total + " minutes"));
      ctx.nav.show("program-view");
    });
  }

  function printCurrent() {
    if (!current) return;
    var tl = PL.timeline(current.startsAt, current.items);
    var area = $("#print-area");
    area.replaceChildren(el("h1", null, current.title), el("p", null, whenText(current.startsAt)));
    var table = el("table", "print-table");
    var head = el("thead");
    var hr = el("tr");
    ["Time", "Item", "Department", "Presenter", "Minutes"].forEach(function (t) { hr.append(el("th", null, t)); });
    head.append(hr);
    var body = el("tbody");
    tl.rows.forEach(function (r) {
      var tr = el("tr");
      [PL.clock(r.start), r.title, r.department || "", r.presenterName || "", String(r.minutes)].forEach(function (t) { tr.append(el("td", null, t)); });
      body.append(tr);
    });
    table.append(head, body);
    area.append(table, el("p", "print-end", "Ends " + PL.clock(tl.end) + "  |  " + tl.total + " minutes"));
    window.print();
  }

  function init(c) {
    ctx = c;
    $ = c.$;
    el = c.el;
    $("#mp-back").addEventListener("click", function () { ctx.nav.show("program"); });
    $("#mp-print").addEventListener("click", printCurrent);
    showMine();
  }

  window.CBC_MPROG = { init: init, showList: showList };
})();
