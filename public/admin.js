(function () {
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
    signOutBtn.hidden = name !== "app";
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
  function renderFilters() {
    var box = $("#filters");
    box.replaceChildren();
    FILTERS.forEach(function (f) {
      var count = f.key === "all" ? members.length : members.filter(function (m) { return m.status === f.key; }).length;
      box.append(
        h(
          "button",
          {
            class: "filter",
            type: "button",
            "aria-pressed": String(filter === f.key),
            onclick: function () {
              filter = f.key;
              renderMembers();
            },
          },
          h("span", { class: "count", text: String(count) }),
          h("span", { class: "label", text: f.label })
        )
      );
    });
  }

  function actionButton(label, cls, handler) {
    return h("button", { class: "btn btn-sm " + cls, type: "button", onclick: handler, text: label });
  }

  function rowFor(m) {
    var actions = h("div", { class: "row-actions" });
    if (m.status === "pending") {
      actions.append(actionButton("Approve", "btn-gold", function () { setStatus(m, "active", "Approved " + m.fullName); }));
    } else if (m.status === "active") {
      if (!m.hasAccount) actions.append(actionButton("Invite", "btn-outline", function () { invite(m); }));
      actions.append(actionButton("Deactivate", "btn-outline", function () { setStatus(m, "inactive", "Deactivated " + m.fullName); }));
    } else {
      actions.append(actionButton("Reactivate", "btn-outline", function () { setStatus(m, "active", "Reactivated " + m.fullName); }));
    }
    actions.append(actionButton("Edit", "btn-outline", function () { openMemberDialog(m); }));
    actions.append(actionButton(m.status === "pending" ? "Decline" : "Delete", "btn-danger", function () { removeMember(m); }));

    var contact = h("td", { "data-label": "Contact" });
    if (m.email) contact.append(h("span", { class: "line", text: m.email }));
    if (m.phone) contact.append(h("span", { class: "line", text: m.phone }));
    if (!m.email && !m.phone) contact.append(h("span", { class: "line", text: "No contact details" }));

    var nameCell = h("td", { "data-label": "Name" }, h("span", { class: "name", text: m.fullName }));
    if (m.notes) nameCell.append(h("span", { class: "note", text: m.notes }));

    var statusCell = h("td", { "data-label": "Status" }, h("span", { class: "pill " + m.status, text: m.status }));
    if (m.hasAccount) statusCell.append(" ", h("span", { class: "pill login", text: "has login" }));

    return h(
      "tr",
      null,
      nameCell,
      contact,
      statusCell,
      h("td", { class: "date", "data-label": "Registered", text: formatDate(m.createdAt) }),
      h("td", { class: "actions" }, actions)
    );
  }

  function renderMembers() {
    renderFilters();
    var list = visibleMembers();
    var body = $("#members-body");
    body.replaceChildren.apply(body, list.map(rowFor));

    var empty = $("#empty");
    $("#members-table").hidden = list.length === 0;
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

  // ---------- tabs ----------
  function selectTab(name) {
    var isMembers = name === "members";
    $("#tab-members").setAttribute("aria-selected", String(isMembers));
    $("#tab-notices").setAttribute("aria-selected", String(!isMembers));
    $("#panel-members").hidden = !isMembers;
    $("#panel-notices").hidden = isMembers;
    $("#members-actions").hidden = !isMembers;
    $("#notices-actions").hidden = isMembers;
    $("#page-title").textContent = isMembers ? "Members" : "Notices";
    if (!isMembers) reloadNotices().catch(handleError);
  }
  $("#tab-members").addEventListener("click", function () { selectTab("members"); });
  $("#tab-notices").addEventListener("click", function () { selectTab("notices"); });

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
      $("#mode-note").textContent = API.modeLabel;
      return reloadMembers().then(function () { show("app"); });
    })
    .catch(function (err) {
      if (err && err.auth) return toLogin();
      if (err && err.unavailable) {
        return showNotice(
          "Leaders area is opening soon",
          "This area isn't switched on yet. Please check back soon."
        );
      }
      showNotice("Couldn't load members", (err && err.message) || "Please refresh the page and try again.");
    });
})();
