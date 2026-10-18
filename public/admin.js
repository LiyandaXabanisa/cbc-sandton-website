(function () {
  // Without a database (the live domain for now) these pages do not exist for visitors.
  if (window.CBC_ENV && !window.CBC_ENV.accounts) {
    window.location.replace("index.html");
    return;
  }

  var API = window.CBC_API;
  var admin = API.admin;

  function $(sel) {
    return document.querySelector(sel);
  }

  // Build elements without innerHTML: member details come from public form
  // submissions, so everything is inserted as plain text.
  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid == null) continue;
      el.append(kid);
    }
    return el;
  }

  var views = { loading: $("#loading-view"), notice: $("#notice-view"), app: $("#app-view") };
  var signOutBtn = $("#signout");

  function show(name) {
    Object.keys(views).forEach(function (k) {
      views[k].hidden = k !== name;
    });
    $("#app-nav").hidden = name !== "app";
    $("#avatar").hidden = name !== "app";
  }

  function toLogin() {
    window.location.replace("login.html");
  }

  var toastTimer;
  function toast(message, isError) {
    var t = $("#toast");
    t.textContent = message;
    t.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.className = "toast";
    }, 3500);
  }

  // ---------- state ----------
  var members = [];
  var notices = [];
  var filter = "all";
  var query = "";

  var FILTERS = [
    { key: "all", label: "All" },
    { key: "pending", label: "Pending" },
    { key: "active", label: "Active" },
    { key: "inactive", label: "Inactive" },
  ];

  function formatDate(iso) {
    if (!iso) return "Not set";
    var d = new Date(iso);
    if (isNaN(d)) return "Not set";
    return d.toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });
  }

  function visibleMembers() {
    var q = query.trim().toLowerCase();
    return members.filter(function (m) {
      if (filter !== "all" && m.status !== filter) return false;
      if (!q) return true;
      return [m.fullName, m.email, m.phone].some(function (v) {
        return (v || "").toLowerCase().indexOf(q) !== -1;
      });
    });
  }

  // ---------- members: render ----------
  function stat(n, label, attn) {
    return h("div", { class: "stat" + (attn ? " attn" : "") }, h("b", { text: String(n) }), h("span", { text: label }));
  }

  function renderStats() {
    var pending = members.filter(function (m) { return m.status === "pending"; }).length;
    var withLogin = members.filter(function (m) { return m.hasAccount; }).length;
    $("#stats").replaceChildren(stat(members.length, "Members"), stat(pending, "To approve", pending > 0), stat(withLogin, "With login"));
  }

  function renderFilters() {
    var box = $("#filters");
    box.replaceChildren();
    FILTERS.forEach(function (f) {
      var count = f.key === "all" ? members.length : members.filter(function (m) { return m.status === f.key; }).length;
      box.append(
        h(
          "button",
          {
            class: "chip",
            type: "button",
            "aria-pressed": String(filter === f.key),
            onclick: function () {
              filter = f.key;
              renderMembers();
            },
          },
          f.label,
          h("span", { class: "n", text: String(count) })
        )
      );
    });
  }

  function actionButton(label, cls, handler) {
    return h("button", { class: "btn btn-sm " + cls, type: "button", onclick: handler, text: label });
  }

  var menuDialog = $("#member-menu");

  function menuButton(label, cls, handler) {
    return h("button", {
      class: "btn " + cls,
      type: "button",
      text: label,
      onclick: function () {
        menuDialog.close();
        handler();
      },
    });
  }

  function openMenu(m) {
    $("#menu-title").textContent = m.fullName;
    $("#menu-sub").textContent = [m.email, m.phone].filter(Boolean).join("  |  ") || "No contact details";
    var box = $("#menu-actions");
    box.replaceChildren();
    if (m.status === "pending") box.append(menuButton("Approve", "btn-gold", function () { setStatus(m, "active", "Approved " + m.fullName); }));
    if (m.status === "active" && !m.hasAccount) box.append(menuButton("Invite to log in", "btn-outline", function () { invite(m); }));
    box.append(menuButton("Edit details", "btn-outline", function () { openMemberDialog(m); }));
    if (m.status === "active") box.append(menuButton("Deactivate", "btn-outline", function () { setStatus(m, "inactive", "Deactivated " + m.fullName); }));
    if (m.status === "inactive") box.append(menuButton("Reactivate", "btn-outline", function () { setStatus(m, "active", "Reactivated " + m.fullName); }));
    box.append(menuButton(m.status === "pending" ? "Decline" : "Delete", "btn-danger", function () { removeMember(m); }));
    menuDialog.showModal();
  }

  $("#menu-close").addEventListener("click", function () { menuDialog.close(); });

  function rowFor(m) {
    var sub = [m.email, m.phone].filter(Boolean).join("  |  ") || "No contact details";
    var right;
    if (m.status === "pending") {
      right = actionButton("Approve", "btn-gold", function (e) {
        e.stopPropagation();
        setStatus(m, "active", "Approved " + m.fullName);
      });
    } else if (m.status === "active" && !m.hasAccount && m.email) {
      right = actionButton("Invite", "btn-outline", function (e) {
        e.stopPropagation();
        invite(m);
      });
    } else {
      right = h("span", { class: "pill " + m.status, text: m.hasAccount ? "has login" : m.status });
    }
    var row = h(
      "div",
      { class: "row", role: "button", tabindex: "0", "aria-label": "Open actions for " + m.fullName },
      h("span", { class: "av", text: window.CBC_APP.initials(m.fullName) }),
      h("span", { class: "main" }, h("span", { class: "name", text: m.fullName }), h("span", { class: "sub", text: sub })),
      right
    );
    row.style.cursor = "pointer";
    row.addEventListener("click", function () { openMenu(m); });
    row.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu(m);
      }
    });
    return row;
  }

  function renderMembers() {
    renderStats();
    renderFilters();
    var list = visibleMembers();
    var box = $("#members-list");
    box.replaceChildren.apply(box, list.map(rowFor));
    box.hidden = list.length === 0;

    var empty = $("#empty");
    empty.hidden = list.length !== 0;
    if (!list.length) {
      empty.textContent = members.length
        ? "No members match that search or filter."
        : "No members yet. New registrations from the website will appear here.";
    }
  }
  // ---------- members: actions ----------
  function handleError(err) {
    if (err && err.auth) return toLogin();
    toast((err && err.message) || "Something went wrong. Please try again.", true);
  }

  function reloadMembers() {
    return admin.list().then(function (list) {
      members = list;
      renderMembers();
    });
  }

  function setStatus(m, status, doneMessage) {
    admin
      .update(m.id, { status: status, joinedAt: m.joinedAt })
      .then(reloadMembers)
      .then(function () { toast(doneMessage); })
      .catch(handleError);
  }

  function removeMember(m) {
    var what = m.status === "pending" ? "Decline and remove" : "Permanently delete";
    if (!window.confirm(what + " " + m.fullName + "? This can't be undone.")) return;
    admin
      .remove(m.id)
      .then(reloadMembers)
      .then(function () { toast("Removed " + m.fullName); })
      .catch(handleError);
  }

  // ---------- invite codes ----------
  var inviteDialog = $("#invite-dialog");

  function invite(m) {
    if (!m.email) return toast("Add an email address for " + m.fullName + " first.", true);
    admin
      .invite(m.id)
      .then(function (r) {
        $("#invite-text").textContent = "Give this code to " + m.fullName + " (" + m.email + "). It expires on " + formatDate(r.expiresAt) + ".";
        $("#invite-code").textContent = r.code;
        inviteDialog.showModal();
      })
      .catch(handleError);
  }

  $("#invite-close").addEventListener("click", function () {
    $("#invite-code").textContent = "";
    inviteDialog.close();
  });
  $("#invite-copy").addEventListener("click", function () {
    var code = $("#invite-code").textContent;
    if (!navigator.clipboard) return toast("Select the code and copy it by hand.", true);
    navigator.clipboard.writeText(code).then(
      function () { toast("Code copied"); },
      function () { toast("Couldn't copy. Select the code and copy it by hand.", true); }
    );
  });

  // ---------- members: add / edit dialog ----------
  var dialog = $("#member-dialog");
  var memberForm = $("#member-form");
  var editing = null;

  function openMemberDialog(m) {
    editing = m || null;
    $("#dialog-title").textContent = m ? "Edit member" : "Add member";
    $("#m-name").value = m ? m.fullName : "";
    $("#m-email").value = m ? m.email : "";
    $("#m-phone").value = m ? m.phone : "";
    $("#m-notes").value = m ? m.notes : "";
    $("#member-error").className = "form-status";
    dialog.showModal();
    $("#m-name").focus();
  }

  $("#add-member").addEventListener("click", function () { openMemberDialog(null); });
  $("#member-cancel").addEventListener("click", function () { dialog.close(); });

  memberForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var err = $("#member-error");
    var data = {
      fullName: $("#m-name").value.trim(),
      email: $("#m-email").value.trim(),
      phone: $("#m-phone").value.trim(),
      notes: $("#m-notes").value.trim(),
    };
    function fail(message) {
      err.textContent = message;
      err.className = "form-status show error";
    }
    if (data.fullName.length < 2) return fail("Please enter the member's full name.");
    if (!data.email && !data.phone) return fail("Provide an email address or a phone number.");

    var save = $("#member-save");
    save.disabled = true;
    var job = editing ? admin.update(editing.id, data) : admin.create(data);
    job
      .then(reloadMembers)
      .then(function () {
        dialog.close();
        toast(editing ? "Saved changes" : "Added " + data.fullName);
      })
      .catch(function (e2) {
        if (e2 && e2.auth) return toLogin();
        fail((e2 && e2.message) || "Couldn't save. Please try again.");
      })
      .then(function () { save.disabled = false; });
  });

  // ---------- CSV export ----------
  function csvCell(value) {
    var s = String(value == null ? "" : value);
    // Stop spreadsheet apps treating text from the public form as a formula.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  $("#export-csv").addEventListener("click", function () {
    var list = visibleMembers();
    if (!list.length) return toast("Nothing to export with the current filter.", true);
    var rows = [["Name", "Email", "Phone", "Status", "Registered", "Notes"]].concat(
      list.map(function (m) {
        return [m.fullName, m.email, m.phone, m.status, m.createdAt ? m.createdAt.slice(0, 10) : "", m.notes];
      })
    );
    var csv = "﻿" + rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
    var url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    var a = h("a", { href: url, download: "cbc-sandton-members-" + new Date().toISOString().slice(0, 10) + ".csv" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast("Exported " + list.length + (list.length === 1 ? " member" : " members"));
  });

  $("#search").addEventListener("input", function (e) {
    query = e.target.value;
    renderMembers();
  });

  // ---------- notices ----------
  function renderNotices() {
    var box = $("#notices-list");
    box.replaceChildren();
    $("#notices-empty").hidden = notices.length > 0;
    notices.forEach(function (n) {
      var head = h(
        "div",
        { class: "notice-head" },
        h("h3", { text: n.title }),
        h("span", { class: "pill " + (n.published ? "active" : "inactive"), text: n.published ? "visible" : "hidden" })
      );
      var actions = h(
        "div",
        { class: "row-actions" },
        actionButton("Edit", "btn-outline", function () { openNoticeDialog(n); }),
        actionButton(n.published ? "Hide" : "Show", "btn-outline", function () {
          admin.notices
            .update(n.id, { title: n.title, body: n.body, published: !n.published })
            .then(reloadNotices)
            .catch(handleError);
        }),
        actionButton("Delete", "btn-danger", function () {
          if (!window.confirm("Delete the notice “" + n.title + "”? This can't be undone.")) return;
          admin.notices.remove(n.id).then(reloadNotices).then(function () { toast("Notice deleted"); }).catch(handleError);
        })
      );
      box.append(
        h(
          "article",
          { class: "notice-card" },
          head,
          h("p", { class: "notice-date", text: formatDate(n.createdAt) }),
          h("p", { class: "notice-body", text: n.body }),
          actions
        )
      );
    });
  }

  function reloadNotices() {
    return admin.notices.list().then(function (list) {
      notices = list;
      renderNotices();
    });
  }

  var noticeDialog = $("#notice-dialog");
  var editingNotice = null;

  function openNoticeDialog(n) {
    editingNotice = n || null;
    $("#notice-dialog-title").textContent = n ? "Edit notice" : "New notice";
    $("#n-title").value = n ? n.title : "";
    $("#n-body").value = n ? n.body : "";
    $("#n-published").checked = n ? n.published : true;
    $("#notice-error").className = "form-status";
    noticeDialog.showModal();
    $("#n-title").focus();
  }

  $("#add-notice").addEventListener("click", function () { openNoticeDialog(null); });
  $("#notice-cancel").addEventListener("click", function () { noticeDialog.close(); });

  $("#notice-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var err = $("#notice-error");
    var data = { title: $("#n-title").value.trim(), body: $("#n-body").value.trim(), published: $("#n-published").checked };
    function fail(message) {
      err.textContent = message;
      err.className = "form-status show error";
    }
    if (!data.title) return fail("Give the notice a title.");
    if (!data.body) return fail("Write the notice text.");

    var save = $("#notice-save");
    save.disabled = true;
    var job = editingNotice ? admin.notices.update(editingNotice.id, data) : admin.notices.create(data);
    job
      .then(reloadNotices)
      .then(function () {
        noticeDialog.close();
        toast(editingNotice ? "Notice updated" : "Notice posted");
      })
      .catch(function (e2) {
        if (e2 && e2.auth) return toLogin();
        fail((e2 && e2.message) || "Couldn't save. Please try again.");
      })
      .then(function () { save.disabled = false; });
  });

  // ---------- date helpers for services and reminders ----------
  var TZ = "Africa/Johannesburg";

  function formatWhen(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return "";
    return d.toLocaleString("en-ZA", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ });
  }

  // A datetime-local box works in the browser's own time zone.
  function toInput(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return "";
    var local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function fromInput(value) {
    if (!value) return null;
    var d = new Date(value);
    return isNaN(d) ? null : d.toISOString();
  }

  function dialogError(id, message) {
    var el = $(id);
    el.textContent = message;
    el.className = "form-status show error";
  }

  // ---------- services ----------
  var services = [];

  function renderServices() {
    var box = $("#services-list");
    box.replaceChildren();
    $("#services-empty").hidden = services.length > 0;
    services.forEach(function (s) {
      var details = [s.speaker && "Speaker: " + s.speaker, s.venue && "Venue: " + s.venue, s.theme && "Theme: " + s.theme]
        .filter(Boolean)
        .join("  |  ");
      box.append(
        h(
          "article",
          { class: "notice-card" },
          h("div", { class: "notice-head" }, h("h3", { text: s.title }), h("span", { class: "pill " + (s.published ? "active" : "inactive"), text: s.published ? "visible" : "hidden" })),
          h("p", { class: "notice-date", text: formatWhen(s.startsAt) }),
          details ? h("p", { class: "notice-body", text: details }) : null,
          h(
            "div",
            { class: "row-actions" },
            actionButton("Edit", "btn-outline", function () { openServiceDialog(s); }),
            actionButton("Duplicate", "btn-outline", function () { openServiceDialog(s, true); }),
            actionButton(s.published ? "Hide" : "Show", "btn-outline", function () {
              admin.services.update(s.id, Object.assign({}, s, { published: !s.published })).then(reloadServices).catch(handleError);
            }),
            actionButton("Delete", "btn-danger", function () {
              if (!window.confirm("Delete “" + s.title + "”? This can't be undone.")) return;
              admin.services.remove(s.id).then(reloadServices).then(function () { toast("Service deleted"); }).catch(handleError);
            })
          )
        )
      );
    });
  }

  function reloadServices() {
    return admin.services.list().then(function (list) {
      services = list;
      renderServices();
    });
  }

  var serviceDialog = $("#service-dialog");
  var editingService = null;

  function openServiceDialog(s, asCopy) {
    editingService = s && !asCopy ? s : null;
    $("#service-dialog-title").textContent = editingService ? "Edit service" : "New service";
    $("#s-title").value = s ? s.title : "";
    // A copy keeps the details but moves one week ahead, which is the usual reason to copy.
    var shift = asCopy ? 7 * 24 * 60 * 60 * 1000 : 0;
    $("#s-start").value = s ? toInput(new Date(new Date(s.startsAt).getTime() + shift).toISOString()) : "";
    $("#s-end").value = s && s.endsAt ? toInput(new Date(new Date(s.endsAt).getTime() + shift).toISOString()) : "";
    $("#s-venue").value = s ? s.venue : "";
    $("#s-speaker").value = s ? s.speaker : "";
    $("#s-theme").value = s ? s.theme : "";
    $("#s-scripture").value = s ? s.scripture : "";
    $("#s-desc").value = s ? s.description : "";
    $("#s-published").checked = s ? s.published : true;
    $("#service-error").className = "form-status";
    serviceDialog.showModal();
    $("#s-title").focus();
  }

  $("#add-service").addEventListener("click", function () { openServiceDialog(null); });
  $("#service-cancel").addEventListener("click", function () { serviceDialog.close(); });

  $("#service-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var data = {
      title: $("#s-title").value.trim(),
      startsAt: fromInput($("#s-start").value),
      endsAt: fromInput($("#s-end").value),
      venue: $("#s-venue").value.trim(),
      speaker: $("#s-speaker").value.trim(),
      theme: $("#s-theme").value.trim(),
      scripture: $("#s-scripture").value.trim(),
      description: $("#s-desc").value.trim(),
      published: $("#s-published").checked,
    };
    var fail = function (m) { dialogError("#service-error", m); };
    if (!data.title) return fail("Give the service a title.");
    if (!data.startsAt) return fail("Choose when it starts.");
    if (data.endsAt && new Date(data.endsAt) <= new Date(data.startsAt)) return fail("The end time must be after the start time.");

    var save = $("#service-save");
    save.disabled = true;
    var job = editingService ? admin.services.update(editingService.id, data) : admin.services.create(data);
    job
      .then(reloadServices)
      .then(function () {
        serviceDialog.close();
        toast(editingService ? "Service updated" : "Service added");
      })
      .catch(function (err) {
        if (err && err.auth) return toLogin();
        fail((err && err.message) || "Couldn't save. Please try again.");
      })
      .then(function () { save.disabled = false; });
  });

  // ---------- sermons ----------
  var sermons = [];
  var sermonQuery = "";
  var isPastor = false;
  var allowedExt = /\.(pdf|pptx?|docx?|png|jpe?g|webp)$/i;
  var VISIBILITY_LABEL = { members: "members", managers_media: "media only", public: "public" };

  if (API.roles) {
    API.roles.mine().then(function (list) {
      isPastor = list.indexOf("senior_pastor") !== -1;
    });
  }

  function formatDay(isoDate) {
    if (!isoDate) return "";
    var d = new Date(isoDate + "T12:00:00");
    return isNaN(d) ? "" : d.toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" });
  }

  function visibleSermons() {
    var q = sermonQuery.trim().toLowerCase();
    if (!q) return sermons;
    return sermons.filter(function (s) {
      return [s.title, s.speaker, s.scripture, s.series, s.topic, s.notes].some(function (v) {
        return (v || "").toLowerCase().indexOf(q) !== -1;
      });
    });
  }

  function renderSermons() {
    var box = $("#sermons-list");
    box.replaceChildren();
    var list = visibleSermons();
    $("#sermons-empty").hidden = list.length > 0;
    $("#sermons-empty").textContent = sermons.length ? "No sermons match that search." : "No sermons yet. Use New sermon to add the first one.";
    list.forEach(function (s) {
      var details = [s.speaker && "Speaker: " + s.speaker, s.series && "Series: " + s.series, s.scripture, s.topic && "Topic: " + s.topic]
        .filter(Boolean)
        .join("  |  ");
      var pills = h("span", { class: "pill-row" });
      if (!s.published) pills.append(h("span", { class: "pill pending", text: "draft" }));
      pills.append(h("span", { class: "pill " + (s.visibility === "members" ? "inactive" : "active"), text: VISIBILITY_LABEL[s.visibility] || s.visibility }));
      box.append(
        h(
          "article",
          { class: "notice-card" },
          h("div", { class: "notice-head" }, h("h3", { text: s.title }), pills),
          h("p", { class: "notice-date", text: formatDay(s.preachedOn) + (s.videoUrl ? "  |  video linked" : "") }),
          details ? h("p", { class: "notice-body", text: details }) : null,
          h(
            "div",
            { class: "row-actions" },
            actionButton("Edit", "btn-outline", function () { openSermonDialog(s); }),
            actionButton(s.published ? "Make draft" : "Publish", "btn-outline", function () {
              admin.sermons.update(s.id, Object.assign({}, s, { published: !s.published })).then(reloadSermons).catch(handleError);
            }),
            actionButton("Delete", "btn-danger", function () {
              if (!window.confirm("Delete “" + s.title + "” and its files? This can't be undone.")) return;
              admin.sermons.remove(s.id).then(reloadSermons).then(function () { toast("Sermon deleted"); }).catch(handleError);
            })
          )
        )
      );
    });
  }

  function reloadSermons() {
    return admin.sermons.list().then(function (list) {
      sermons = list;
      renderSermons();
    });
  }

  $("#sermon-search").addEventListener("input", function (e) {
    sermonQuery = e.target.value;
    renderSermons();
  });

  var sermonDialog = $("#sermon-dialog");
  var editingSermon = null;
  var pendingFiles = [];
  var currentFiles = [];
  var servicesCache = null;

  function fileSize(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  }

  function renderFileList() {
    var ul = $("#v-file-list");
    ul.replaceChildren();
    currentFiles.forEach(function (f) {
      ul.append(
        h(
          "li",
          null,
          h("span", { class: "fname", text: f.name + "  (" + fileSize(f.size) + ")" }),
          actionButton("Remove", "btn-danger", function () {
            admin.sermons
              .removeFile(f)
              .then(function () {
                currentFiles = currentFiles.filter(function (x) { return x.id !== f.id; });
                renderFileList();
              })
              .catch(handleError);
          })
        )
      );
    });
    pendingFiles.forEach(function (f, i) {
      ul.append(
        h(
          "li",
          null,
          h("span", { class: "fname", text: f.name + "  (" + fileSize(f.size) + ", uploads when you save)" }),
          actionButton("Remove", "btn-outline", function () {
            pendingFiles.splice(i, 1);
            renderFileList();
          })
        )
      );
    });
  }

  function loadServiceOptions(selectedId) {
    var sel = $("#v-service");
    var fill = function (list) {
      sel.replaceChildren(h("option", { value: "", text: "Not linked to a service" }));
      list.forEach(function (sv) {
        sel.append(h("option", { value: sv.id, text: formatWhen(sv.startsAt) + "  " + sv.title }));
      });
      sel.value = selectedId || "";
    };
    if (!admin.services) return fill([]);
    var load = servicesCache ? Promise.resolve(servicesCache) : admin.services.list().then(function (l) { servicesCache = l; return l; });
    load.then(function (l) {
      var cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
      fill(l.filter(function (sv) { return new Date(sv.startsAt).getTime() >= cutoff || sv.id === selectedId; }).reverse());
    }, function () { fill([]); });
  }

  function paintPreview() {
    $("#v-preview").replaceChildren(window.CBC_RT.render($("#v-notes").value));
  }

  function openSermonDialog(s) {
    editingSermon = s || null;
    pendingFiles = [];
    currentFiles = [];
    $("#sermon-dialog-title").textContent = s ? "Edit sermon" : "New sermon";
    $("#v-title").value = s ? s.title : "";
    $("#v-url").value = s ? s.videoUrl : "";
    $("#v-date").value = s ? s.preachedOn : new Date().toISOString().slice(0, 10);
    $("#v-speaker").value = s ? s.speaker : "";
    $("#v-scripture").value = s ? s.scripture : "";
    $("#v-series").value = s ? s.series : "";
    $("#v-topic").value = s ? s.topic : "";
    $("#v-notes").value = s ? s.notes : "";
    $("#v-visibility").value = s ? s.visibility : "members";
    $("#v-public-option").disabled = !isPastor && !(s && s.visibility === "public");
    $("#v-published").checked = s ? s.published : true;
    $("#v-files").value = "";
    $("#sermon-error").className = "form-status";
    loadServiceOptions(s ? s.serviceId : null);
    paintPreview();
    renderFileList();
    if (s) admin.sermons.files(s.id).then(function (f) { currentFiles = f; renderFileList(); }, handleError);
    sermonDialog.showModal();
    $("#v-title").focus();
  }

  $("#add-sermon").addEventListener("click", function () { openSermonDialog(null); });
  $("#sermon-cancel").addEventListener("click", function () { sermonDialog.close(); });
  $("#v-notes").addEventListener("input", paintPreview);

  // formatting buttons put the simple marks around the selected text
  Array.prototype.forEach.call(document.querySelectorAll("[data-mark]"), function (btn) {
    btn.addEventListener("click", function () {
      var ta = $("#v-notes");
      var a = ta.selectionStart, b = ta.selectionEnd, v = ta.value;
      var sel = v.slice(a, b);
      var kind = btn.getAttribute("data-mark");
      var out;
      if (kind === "bold") out = "**" + (sel || "bold text") + "**";
      else if (kind === "italic") out = "*" + (sel || "italic text") + "*";
      else if (kind === "heading") out = (a === 0 || v[a - 1] === "\n" ? "" : "\n") + "## " + (sel || "Heading");
      else if (kind === "bullet") out = (a === 0 || v[a - 1] === "\n" ? "" : "\n") + (sel || "item").split("\n").map(function (l) { return "- " + l; }).join("\n");
      else {
        var url = window.prompt("Paste the link (it must start with https://)", "https://");
        if (!url || !/^https:\/\//i.test(url.trim())) return toast("A link must start with https://", true);
        out = "[" + (sel || "link text") + "](" + url.trim() + ")";
      }
      ta.value = v.slice(0, a) + out + v.slice(b);
      ta.focus();
      ta.selectionStart = a;
      ta.selectionEnd = a + out.length;
      paintPreview();
    });
  });

  $("#v-files").addEventListener("change", function (e) {
    var chosen = Array.prototype.slice.call(e.target.files);
    e.target.value = "";
    var bad = chosen.filter(function (f) { return !allowedExt.test(f.name); });
    if (bad.length) dialogError("#sermon-error", "Only PowerPoint, Word, PDF and picture files can be attached: " + bad.map(function (f) { return f.name; }).join(", "));
    chosen = chosen.filter(function (f) { return allowedExt.test(f.name); });
    if (!editingSermon) {
      pendingFiles = pendingFiles.concat(chosen);
      return renderFileList();
    }
    var save = $("#sermon-save");
    save.disabled = true;
    chosen
      .reduce(function (chain, f) {
        return chain.then(function () {
          return admin.sermons.upload(editingSermon.id, f).then(function (rec) {
            currentFiles.push(rec);
            renderFileList();
          });
        });
      }, Promise.resolve())
      .catch(function (err) { dialogError("#sermon-error", (err && err.message) || "A file couldn't be uploaded."); })
      .then(function () { save.disabled = false; });
  });

  $("#sermon-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var data = {
      title: $("#v-title").value.trim(),
      videoUrl: $("#v-url").value.trim(),
      preachedOn: $("#v-date").value,
      speaker: $("#v-speaker").value.trim(),
      scripture: $("#v-scripture").value.trim(),
      series: $("#v-series").value.trim(),
      topic: $("#v-topic").value.trim(),
      notes: $("#v-notes").value.trim(),
      visibility: $("#v-visibility").value,
      serviceId: $("#v-service").value || null,
      description: editingSermon ? editingSermon.description : "",
      published: $("#v-published").checked,
    };
    var fail = function (m) { dialogError("#sermon-error", m); };
    if (!data.title) return fail("Give the sermon a title.");
    if (!data.preachedOn) return fail("Choose the date it was preached.");
    if (data.videoUrl) {
      if (!/^https:\/\//i.test(data.videoUrl)) return fail("The video link must start with https://");
      var yt = window.CBC_YT;
      if (yt && yt.isYouTubeHost(data.videoUrl) && !yt.id(data.videoUrl)) {
        return fail("That YouTube link isn't recognised. Open the video on YouTube, press Share, and paste that link.");
      }
    }
    if (data.visibility === "public" && !isPastor && !(editingSermon && editingSermon.visibility === "public")) {
      return fail("Only the Senior Pastor can make a sermon public.");
    }

    var save = $("#sermon-save");
    save.disabled = true;
    var job = editingSermon ? admin.sermons.update(editingSermon.id, data) : admin.sermons.create(data);
    job
      .then(function (saved) {
        return pendingFiles.reduce(function (chain, f) {
          return chain.then(function () { return admin.sermons.upload(saved.id, f); });
        }, Promise.resolve());
      })
      .then(reloadSermons)
      .then(function () {
        sermonDialog.close();
        toast(editingSermon ? "Sermon updated" : "Sermon saved");
      })
      .catch(function (err) {
        if (err && err.auth) return toLogin();
        fail((err && err.message) || "Couldn't save. Please try again.");
      })
      .then(function () { save.disabled = false; });
  });
  // ---------- reminders ----------
  var reminders = [];
  var PRIORITY_LABEL = { urgent: "Urgent", important: "Important", normal: "Normal" };

  function renderReminders() {
    var box = $("#reminders-list");
    box.replaceChildren();
    $("#reminders-empty").hidden = reminders.length > 0;
    var now = Date.now();
    reminders.forEach(function (r) {
      var expired = r.expiresAt && new Date(r.expiresAt).getTime() <= now;
      var state = !r.published ? "hidden" : expired ? "expired" : "visible";
      box.append(
        h(
          "article",
          { class: "notice-card" },
          h(
            "div",
            { class: "notice-head" },
            h("h3", { text: r.title }),
            h("span", { class: "pill " + (state === "visible" ? "active" : "inactive"), text: state })
          ),
          h("p", { class: "notice-date", text: PRIORITY_LABEL[r.priority] + (r.expiresAt ? "  |  until " + formatWhen(r.expiresAt) : "") }),
          r.body ? h("p", { class: "notice-body", text: r.body }) : null,
          h(
            "div",
            { class: "row-actions" },
            actionButton("Edit", "btn-outline", function () { openReminderDialog(r); }),
            actionButton(r.published ? "Hide" : "Show", "btn-outline", function () {
              admin.reminders.update(r.id, Object.assign({}, r, { published: !r.published })).then(reloadReminders).catch(handleError);
            }),
            actionButton("Delete", "btn-danger", function () {
              if (!window.confirm("Delete “" + r.title + "”? This can't be undone.")) return;
              admin.reminders.remove(r.id).then(reloadReminders).then(function () { toast("Reminder deleted"); }).catch(handleError);
            })
          )
        )
      );
    });
  }

  function reloadReminders() {
    return admin.reminders.list().then(function (list) {
      reminders = list;
      renderReminders();
    });
  }

  var reminderDialog = $("#reminder-dialog");
  var editingReminder = null;

  function openReminderDialog(r) {
    editingReminder = r || null;
    $("#reminder-dialog-title").textContent = r ? "Edit reminder" : "New reminder";
    $("#r-title").value = r ? r.title : "";
    $("#r-body").value = r ? r.body : "";
    $("#r-priority").value = r ? r.priority : "normal";
    $("#r-expires").value = r ? toInput(r.expiresAt) : "";
    $("#r-published").checked = r ? r.published : true;
    $("#reminder-error").className = "form-status";
    reminderDialog.showModal();
    $("#r-title").focus();
  }

  $("#add-reminder").addEventListener("click", function () { openReminderDialog(null); });
  $("#reminder-cancel").addEventListener("click", function () { reminderDialog.close(); });

  $("#reminder-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var data = {
      title: $("#r-title").value.trim(),
      body: $("#r-body").value.trim(),
      priority: $("#r-priority").value,
      publishAt: editingReminder ? editingReminder.publishAt : new Date().toISOString(),
      expiresAt: fromInput($("#r-expires").value),
      published: $("#r-published").checked,
    };
    var fail = function (m) { dialogError("#reminder-error", m); };
    if (!data.title) return fail("Give the reminder a title.");
    if (data.expiresAt && new Date(data.expiresAt) <= new Date(data.publishAt)) return fail("The disappear date must be in the future.");

    var save = $("#reminder-save");
    save.disabled = true;
    var job = editingReminder ? admin.reminders.update(editingReminder.id, data) : admin.reminders.create(data);
    job
      .then(reloadReminders)
      .then(function () {
        reminderDialog.close();
        toast(editingReminder ? "Reminder updated" : "Reminder added");
      })
      .catch(function (err) {
        if (err && err.auth) return toLogin();
        fail((err && err.message) || "Couldn't save. Please try again.");
      })
      .then(function () { save.disabled = false; });
  });

  // ---------- content chips (inside the Content view) ----------
  var TABS = {
    notices: { add: "#add-notice", load: reloadNotices },
    services: { add: "#add-service", load: reloadServices },
    sermons: { add: "#add-sermon", load: reloadSermons },
    reminders: { add: "#add-reminder", load: reloadReminders },
  };
  var lastTab = "notices";

  function selectTab(name) {
    lastTab = name;
    Object.keys(TABS).forEach(function (k) {
      var on = k === name;
      $("#tab-" + k).setAttribute("aria-selected", String(on));
      $("#panel-" + k).hidden = !on;
      $(TABS[k].add).hidden = !on;
    });
    TABS[name].load().catch(handleError);
  }

  Object.keys(TABS).forEach(function (k) {
    var tab = $("#tab-" + k);
    var needs = tab.getAttribute("data-needs");
    // Services, sermons and reminders only exist once the real database is connected.
    if (needs && !admin[needs]) {
      tab.hidden = true;
      return;
    }
    tab.addEventListener("click", function () { selectTab(k); });
  });
  // ---------- people and roles ----------
  var ROLE_LABEL = {
    senior_pastor: "Senior Pastor",
    platform_manager: "Platform Manager",
    media_team: "Media Team",
    item_renderer: "Item Renderer",
    ministry_leader: "Ministry Leader",
    ministry_member: "Ministry Member",
  };
  var grants = [];
  var auditRows = [];
  var showPast = false;
  var appNav = null;

  function grantState(g) {
    if (g.revokedAt) return "removed";
    if (g.expiresAt && new Date(g.expiresAt).getTime() <= Date.now()) return "ended";
    return "active";
  }

  function nameOf(userId) {
    if (!userId) return "The system";
    var g = grants.filter(function (x) { return x.userId === userId; })[0];
    if (g) return g.name;
    var m = members.filter(function (x) { return x.userId === userId; })[0];
    return m ? m.fullName : "A leader";
  }

  function untilText(iso) {
    return iso ? "until " + new Date(iso).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" }) : "no end date";
  }

  function renderRolesList() {
    var box = $("#roles-list");
    box.replaceChildren();
    var rows = grants
      .filter(function (g) { return showPast || grantState(g) === "active"; })
      .sort(function (a, b) { return a.name.localeCompare(b.name) || a.role.localeCompare(b.role); });
    $("#roles-empty").hidden = rows.length > 0;
    box.hidden = rows.length === 0;
    box.className = rows.length ? "list" : "";
    rows.forEach(function (g) {
      var state = grantState(g);
      var right = state === "active"
        ? actionButton("Remove", "btn-outline", function () { removeRole(g); })
        : h("span", { class: "pill inactive", text: state });
      box.append(
        h(
          "div",
          { class: "row" },
          h("span", { class: "av", text: window.CBC_APP.initials(g.name) }),
          h("span", { class: "main" }, h("span", { class: "name", text: g.name }), h("span", { class: "sub", text: (ROLE_LABEL[g.role] || g.role) + "  |  " + untilText(g.expiresAt) })),
          right
        )
      );
    });
  }

  function sentence(a) {
    var role = ROLE_LABEL[a.role] || a.role;
    var actor = nameOf(a.actorId);
    var target = nameOf(a.targetId);
    if (a.action === "granted") return actor + " gave " + role + " to " + target + (a.expiresAt ? " (" + untilText(a.expiresAt) + ")" : "");
    if (a.action === "revoked") return actor + " removed " + role + " from " + target;
    if (a.action === "expired") return role + " ended for " + target;
    if (a.action === "seeded") return "The first roles were set up";
    return actor + " " + a.action;
  }

  function renderAudit() {
    var box = $("#audit-list");
    box.replaceChildren();
    $("#audit-empty").hidden = auditRows.length > 0;
    box.hidden = auditRows.length === 0;
    auditRows.forEach(function (a) {
      box.append(
        h(
          "div",
          { class: "row" },
          h("span", { class: "main" }, h("span", { class: "name", text: sentence(a) }), h("span", { class: "sub", text: formatWhen(a.at) }))
        )
      );
    });
  }

  function loadRoles() {
    return Promise.all([API.roles.list(), API.roles.audit()])
      .then(function (r) {
        grants = r[0];
        auditRows = r[1];
        renderRolesList();
        renderAudit();
      })
      .catch(handleError);
  }

  function removeRole(g) {
    if (!window.confirm("Remove " + (ROLE_LABEL[g.role] || g.role) + " from " + g.name + "?")) return;
    API.roles.revoke(g.id).then(loadRoles).then(function () { toast("Role removed"); }).catch(handleError);
  }

  var roleDialog = $("#role-dialog");

  function openRoleDialog() {
    var sel = $("#rl-person");
    sel.replaceChildren();
    var people = members
      .filter(function (m) { return m.hasAccount && m.userId && m.status === "active"; })
      .sort(function (a, b) { return a.fullName.localeCompare(b.fullName); });
    people.forEach(function (m) { sel.append(h("option", { value: m.userId, text: m.fullName })); });
    $("#role-save").disabled = people.length === 0;
    if (!people.length) sel.append(h("option", { value: "", text: "No one has a login yet" }));
    $("#rl-pastor-option").disabled = !isPastor;
    $("#rl-role").value = "platform_manager";
    $("#rl-until").value = "";
    $("#role-error").className = "form-status";
    roleDialog.showModal();
  }

  $("#add-role").addEventListener("click", openRoleDialog);
  $("#role-cancel").addEventListener("click", function () { roleDialog.close(); });
  $("#roles-past").addEventListener("click", function () {
    showPast = !showPast;
    $("#roles-past").setAttribute("aria-pressed", String(showPast));
    renderRolesList();
  });
  $("#roles-back").addEventListener("click", function () { if (appNav) appNav.show("settings"); });
  $("#open-roles").addEventListener("click", function () { if (appNav) appNav.show("roles"); });
  $("#open-roles").hidden = !(API.roles && API.roles.list);

  $("#role-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var fail = function (m) { dialogError("#role-error", m); };
    var userId = $("#rl-person").value;
    var role = $("#rl-role").value;
    var untilDay = $("#rl-until").value;
    if (!userId) return fail("Choose a person.");
    var expires = null;
    if (untilDay) {
      var end = new Date(untilDay + "T23:59:59");
      if (isNaN(end) || end.getTime() <= Date.now()) return fail("The end date must be in the future.");
      expires = end.toISOString();
    }
    if (role === "senior_pastor" && !isPastor) return fail("Only the Senior Pastor can give that role.");

    var save = $("#role-save");
    save.disabled = true;
    API.roles
      .grant(userId, role, expires)
      .then(loadRoles)
      .then(function () {
        roleDialog.close();
        toast("Role given");
      })
      .catch(function (err) {
        if (err && err.auth) return toLogin();
        fail((err && err.message) || "Couldn't save. Please try again.");
      })
      .then(function () { save.disabled = false; });
  });
  // ---------- demo data reset ----------
  if (API.demo) {
    $("#demo-reset").hidden = false;
    $("#demo-reset").addEventListener("click", function () {
      if (!window.confirm("Reset the demo database back to its original sample data?")) return;
      API.demo.reset();
      window.location.replace("login.html");
    });
  }

  // ---------- sign out and start ----------
  signOutBtn.addEventListener("click", function () {
    API.auth.logout().then(toLogin);
  });

  function showNotice(title, body) {
    $("#notice-title").textContent = title;
    $("#notice-body").textContent = body;
    show("notice");
  }

  API.auth
    .session()
    .then(function (s) {
      if (!s || s.role === "unlinked") return toLogin();
      if (s.role === "member") return window.location.replace("member.html");
      $("#mode-note").textContent = API.mode === "supabase" ? "" : API.modeLabel;
      return reloadMembers().then(function () {
        show("app");
        var nav = window.CBC_APP.views(function (name) {
          if (name === "content") selectTab(lastTab);
          if (name === "roles") loadRoles();
        });
        appNav = nav;
        $("#avatar").addEventListener("click", function () { nav.show("settings"); });
        nav.start("members");
        window.CBC_APP.bell(API);
      });
    })
    .catch(function (err) {
      if (err && err.auth) return toLogin();
      if (err && err.unavailable) {
        return showNotice(
          "This page isn't available",
          "Please try again later."
        );
      }
      showNotice("Couldn't load members", (err && err.message) || "Please refresh the page and try again.");
    });
})();
