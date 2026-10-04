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

  var views = {
    loading: $("#loading-view"),
    notice: $("#notice-view"),
    login: $("#login-view"),
    app: $("#app-view"),
  };
  var signOutBtn = $("#signout");

  function show(name) {
    Object.keys(views).forEach(function (k) {
      views[k].hidden = k !== name;
    });
    signOutBtn.hidden = name !== "app";
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

  // ---------- render ----------
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
              render();
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
      actions.append(actionButton("Deactivate", "btn-outline", function () { setStatus(m, "inactive", "Deactivated " + m.fullName); }));
    } else {
      actions.append(actionButton("Reactivate", "btn-outline", function () { setStatus(m, "active", "Reactivated " + m.fullName); }));
    }
    actions.append(actionButton("Edit", "btn-outline", function () { openDialog(m); }));
    actions.append(actionButton(m.status === "pending" ? "Decline" : "Delete", "btn-danger", function () { removeMember(m); }));

    var contact = h("td", { "data-label": "Contact" });
    if (m.email) contact.append(h("span", { class: "line", text: m.email }));
    if (m.phone) contact.append(h("span", { class: "line", text: m.phone }));
    if (!m.email && !m.phone) contact.append(h("span", { class: "line", text: "No contact details" }));

    var nameCell = h("td", { "data-label": "Name" }, h("span", { class: "name", text: m.fullName }));
    if (m.notes) nameCell.append(h("span", { class: "note", text: m.notes }));

    return h(
      "tr",
      null,
      nameCell,
      contact,
      h("td", { "data-label": "Status" }, h("span", { class: "pill " + m.status, text: m.status })),
      h("td", { class: "date", "data-label": "Registered", text: formatDate(m.createdAt) }),
      h("td", { class: "actions" }, actions)
    );
  }

  function render() {
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

  // ---------- actions ----------
  function handleError(err) {
    if (err && err.auth) {
      showLogin(err.message || "Your session has expired. Please sign in again.");
    } else {
      toast((err && err.message) || "Something went wrong. Please try again.", true);
    }
  }

  function reload() {
    return admin.list().then(function (list) {
      members = list;
      render();
    });
  }

  function setStatus(m, status, doneMessage) {
    admin
      .update(m.id, { status: status, joinedAt: m.joinedAt })
      .then(reload)
      .then(function () { toast(doneMessage); })
      .catch(handleError);
  }

  function removeMember(m) {
    var what = m.status === "pending" ? "Decline and remove" : "Permanently delete";
    if (!window.confirm(what + " " + m.fullName + "? This can't be undone.")) return;
    admin
      .remove(m.id)
      .then(reload)
      .then(function () { toast("Removed " + m.fullName); })
      .catch(handleError);
  }

  // ---------- add / edit dialog ----------
  var dialog = $("#member-dialog");
  var memberForm = $("#member-form");
  var editing = null;

  function openDialog(m) {
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

  $("#add-member").addEventListener("click", function () { openDialog(null); });
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
    if (data.fullName.length < 2) {
      err.textContent = "Please enter the member's full name.";
      err.className = "form-status show error";
      return;
    }
    if (!data.email && !data.phone) {
      err.textContent = "Provide an email address or a phone number.";
      err.className = "form-status show error";
      return;
    }
    var save = $("#member-save");
    save.disabled = true;
    var job = editing ? admin.update(editing.id, data) : admin.create(data);
    job
      .then(reload)
      .then(function () {
        dialog.close();
        toast(editing ? "Saved changes" : "Added " + data.fullName);
      })
      .catch(function (e2) {
        if (e2 && e2.auth) {
          dialog.close();
          return handleError(e2);
        }
        err.textContent = (e2 && e2.message) || "Couldn't save. Please try again.";
        err.className = "form-status show error";
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

  // ---------- search ----------
  $("#search").addEventListener("input", function (e) {
    query = e.target.value;
    render();
  });

  // ---------- sign in / out ----------
  function showNotice(title, body) {
    $("#notice-title").textContent = title;
    $("#notice-body").textContent = body;
    show("notice");
  }

  function showLogin(message) {
    $("#login-email-field").hidden = !admin.needsEmail;
    $("#login-intro").textContent = admin.needsEmail
      ? "Use your ChurchHub login. For church leaders and admins only."
      : "For church leaders and admins only.";
    var err = $("#login-error");
    err.textContent = message || "";
    err.className = message ? "form-status show error" : "form-status";
    $("#login-password").value = "";
    show("login");
    (admin.needsEmail ? $("#login-email") : $("#login-password")).focus();
  }

  $("#login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = $("#login-submit");
    var err = $("#login-error");
    err.className = "form-status";
    btn.disabled = true;
    admin
      .login({ email: $("#login-email").value.trim(), password: $("#login-password").value })
      .then(start)
      .catch(function (ex) {
        err.textContent = (ex && ex.message) || "Couldn't sign in. Please try again.";
        err.className = "form-status show error";
      })
      .then(function () { btn.disabled = false; });
  });

  signOutBtn.addEventListener("click", function () {
    admin.logout().then(function () {
      members = [];
      showLogin();
    });
  });

  function start() {
    $("#mode-note").textContent = API.modeLabel;
    return reload()
      .then(function () { show("app"); })
      .catch(function (err) {
        if (err && err.auth) return showLogin(err.message);
        showNotice("Couldn't load members", (err && err.message) || "Please refresh the page and try again.");
      });
  }

  function boot() {
    show("loading");
    admin.status().then(function (state) {
      if (state === "unavailable") {
        return showNotice(
          "Members area isn't switched on",
          "This site isn't connected to a database yet. Add your ChurchHub (Supabase) details to site.config.js, or run the site locally with npm start."
        );
      }
      if (state === "unconfigured") {
        return showNotice(
          "Set an admin password",
          "Add ADMIN_PASSWORD to the .env file next to server.js (see .env.example), then restart the server."
        );
      }
      if (state === "signed-in") return start();
      showLogin();
    });
  }

  boot();
})();
