(function () {
  // Without a database (the live domain for now) these pages do not exist for visitors.
  if (window.CBC_ENV && !window.CBC_ENV.accounts) {
    window.location.replace("index.html");
    return;
  }

  var API = window.CBC_API;

  function $(sel) {
    return document.querySelector(sel);
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

  function showNotice(title, body) {
    $("#notice-title").textContent = title;
    $("#notice-body").textContent = body;
    show("notice");
  }

  function formatDate(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return "";
    return d.toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" });
  }

  function renderNotices(list) {
    var box = $("#notice-list");
    box.replaceChildren();
    $("#notice-empty").hidden = list.length > 0;
    list.forEach(function (n) {
      var card = document.createElement("article");
      card.className = "notice-card";
      var title = document.createElement("h3");
      title.textContent = n.title;
      var date = document.createElement("p");
      date.className = "notice-date";
      date.textContent = formatDate(n.createdAt);
      var body = document.createElement("p");
      body.className = "notice-body";
      body.textContent = n.body; // plain text only; line breaks kept by CSS
      card.append(title, date, body);
      box.append(card);
    });
  }

  // ----- services and reminders (only when the real database provides them) -----
  var TZ = "Africa/Johannesburg";
  var PRIORITY_LABEL = { urgent: "Urgent", important: "Important", normal: "Normal" };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function when(iso, withDay) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return "";
    return d.toLocaleString("en-ZA", {
      weekday: withDay ? "long" : undefined,
      day: withDay ? "numeric" : undefined,
      month: withDay ? "long" : undefined,
      hour: "2-digit",
      minute: "2-digit",
      timeZone: TZ,
    });
  }

  function readDismissed() {
    try {
      return JSON.parse(sessionStorage.getItem("cbc_dismissed") || "[]");
    } catch (_) {
      return [];
    }
  }

  function dismiss(id) {
    var list = readDismissed();
    list.push(id);
    try {
      sessionStorage.setItem("cbc_dismissed", JSON.stringify(list));
    } catch (_) {}
  }

  function renderUrgent(list) {
    var stack = $("#urgent-stack");
    stack.replaceChildren();
    var gone = readDismissed();
    var urgent = list.filter(function (r) { return r.priority === "urgent" && gone.indexOf(r.id) === -1; });
    stack.hidden = urgent.length === 0;
    urgent.forEach(function (r) {
      var banner = el("div", "urgent-banner");
      banner.setAttribute("role", "alert");
      var text = el("div", "urgent-text");
      text.append(el("strong", null, "Urgent: " + r.title));
      if (r.body) text.append(el("span", null, r.body));
      var close = el("button", "urgent-close", "Dismiss");
      close.type = "button";
      close.addEventListener("click", function () {
        dismiss(r.id);
        banner.remove();
        if (!stack.children.length) stack.hidden = true;
      });
      banner.append(text, close);
      stack.append(banner);
    });
  }

  function renderServices(list) {
    $("#services-section").hidden = false;
    var box = $("#service-list");
    box.replaceChildren();
    $("#service-empty").hidden = list.length > 0;
    var now = Date.now();
    list.forEach(function (s) {
      var card = el("article", "service-card");
      card.append(el("h3", null, s.title));
      var time = when(s.startsAt, true);
      if (s.endsAt) time += " to " + when(s.endsAt, false);
      card.append(el("p", "service-when", time));
      [["Venue", s.venue], ["Speaker", s.speaker], ["Theme", s.theme], ["Scripture", s.scripture]].forEach(function (row) {
        if (!row[1]) return;
        var p = el("p", "service-line");
        p.append(el("span", "service-key", row[0]), " " + row[1]);
        card.append(p);
      });
      if (s.description) card.append(el("p", "service-notes", s.description));
      box.append(card);
    });
  }

  // YouTube plays on this page, but only after a tap: nothing is loaded from YouTube until then.
  function playerBlock(videoId, title, label) {
    var wrap = el("div", "player");
    var btn = el("button", "btn btn-gold btn-sm", label);
    btn.type = "button";
    btn.addEventListener("click", function () {
      var frame = document.createElement("iframe");
      frame.src = "https://www.youtube-nocookie.com/embed/" + videoId + "?autoplay=1&rel=0&playsinline=1";
      frame.title = title;
      frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      frame.allowFullscreen = true;
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      var ratio = el("div", "player-ratio");
      ratio.append(frame);
      wrap.replaceChildren(ratio);
    });
    wrap.append(btn);
    return wrap;
  }

  // A YouTube link plays here. Any other https link opens in a new tab.
  function videoBlock(s, label) {
    var videoId = window.CBC_YT ? window.CBC_YT.id(s.videoUrl) : "";
    if (videoId) return playerBlock(videoId, s.title, label);
    if (/^https:\/\//i.test(s.videoUrl || "")) {
      var link = el("a", "btn btn-gold btn-sm", "Open video");
      link.href = s.videoUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return link;
    }
    return null;
  }

  var sermonState = { query: "", series: "" };
  var searchTimer;

  function fileSize(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  }

  function toggleSection(card, key, button, build) {
    var existing = card.querySelector('[data-section="' + key + '"]');
    if (existing) {
      existing.remove();
      button.setAttribute("aria-expanded", "false");
      return;
    }
    var box = el("div", "sermon-extra");
    box.setAttribute("data-section", key);
    card.append(box);
    button.setAttribute("aria-expanded", "true");
    build(box);
  }

  function renderSermons(list) {
    var box = $("#sermon-list");
    box.replaceChildren();
    $("#sermon-empty").hidden = list.length > 0;
    $("#sermon-empty").textContent =
      sermonState.query || sermonState.series ? "No sermons match that search." : "No sermons yet. New recordings will appear here.";
    list.forEach(function (s) {
      var card = el("article", "service-card sermon-card");
      var head = el("div", "sermon-head");
      head.append(el("h3", null, s.title));
      if (!s.published) head.append(el("span", "priority-badge", "Draft"));
      else if (s.visibility === "managers_media") head.append(el("span", "priority-badge", "Media team"));
      card.append(head);
      var day = s.preachedOn ? new Date(s.preachedOn + "T12:00:00") : null;
      card.append(
        el("p", "service-when", day && !isNaN(day) ? day.toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" }) : "")
      );
      [["Series", s.series], ["Speaker", s.speaker], ["Scripture", s.scripture], ["Topic", s.topic]].forEach(function (row) {
        if (!row[1]) return;
        var p = el("p", "service-line");
        p.append(el("span", "service-key", row[0]), " " + row[1]);
        card.append(p);
      });
      if (s.serviceTitle && s.serviceStartsAt) {
        card.append(el("p", "service-line", "For the service on " + when(s.serviceStartsAt, true)));
      }

      var actions = el("div", "sermon-actions");
      var watch = s.videoUrl ? videoBlock(s, "Watch the sermon") : null;
      if (watch) actions.append(watch);

      if (s.notes) {
        var notesBtn = el("button", "btn btn-outline btn-sm", "Notes");
        notesBtn.type = "button";
        notesBtn.setAttribute("aria-expanded", "false");
        notesBtn.addEventListener("click", function () {
          toggleSection(card, "notes", notesBtn, function (b) { b.append(window.CBC_RT.render(s.notes)); });
        });
        actions.append(notesBtn);
      }
      if (s.fileCount > 0) {
        var filesBtn = el("button", "btn btn-outline btn-sm", "Files (" + s.fileCount + ")");
        filesBtn.type = "button";
        filesBtn.setAttribute("aria-expanded", "false");
        filesBtn.addEventListener("click", function () {
          toggleSection(card, "files", filesBtn, function (b) {
            b.append(el("p", "empty", "Loading files…"));
            API.member.sermonFiles(s.id).then(
              function (files) {
                b.replaceChildren();
                if (!files.length) b.append(el("p", "empty", "No files."));
                files.forEach(function (f) {
                  var row = el("div", "file-row");
                  row.append(el("span", "fname", f.name + "  (" + fileSize(f.size) + ")"));
                  var dl = el("button", "btn btn-gold btn-sm", "Download");
                  dl.type = "button";
                  dl.addEventListener("click", function () {
                    dl.disabled = true;
                    // The link is made now, works for five minutes, and only if the database allows this person to read the file.
                    API.member.fileLink(f.path).then(
                      function (url) {
                        window.open(url, "_blank", "noopener");
                        dl.disabled = false;
                      },
                      function (err) {
                        dl.disabled = false;
                        alertSermonError((err && err.message) || "That file isn't available.");
                      }
                    );
                  });
                  row.append(dl);
                  b.append(row);
                });
              },
              function () { b.replaceChildren(el("p", "empty", "The files couldn't be loaded.")); }
            );
          });
        });
        actions.append(filesBtn);
      }
      if (actions.children.length) card.append(actions);
      box.append(card);
    });
  }

  function alertSermonError(message) {
    var box = $("#sermon-list");
    var note = el("p", "empty", message);
    box.prepend(note);
    setTimeout(function () { note.remove(); }, 4000);
  }

  function loadSermons() {
    return API.member.sermons({ query: sermonState.query, series: sermonState.series }).then(renderSermons, function () {});
  }

  function renderSeriesChips(series) {
    var box = $("#series-chips");
    box.replaceChildren();
    box.hidden = series.length === 0;
    ["All"].concat(series).forEach(function (name) {
      var value = name === "All" ? "" : name;
      var chip = el("button", "chip", name);
      chip.type = "button";
      chip.setAttribute("aria-pressed", String(sermonState.series === value));
      chip.addEventListener("click", function () {
        sermonState.series = value;
        renderSeriesChips(series);
        loadSermons();
      });
      box.append(chip);
    });
  }

  $("#sermon-search").addEventListener("input", function (e) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      sermonState.query = e.target.value;
      loadSermons();
    }, 250);
  });
  function renderReminders(list) {
    $("#reminders-section").hidden = false;
    var box = $("#reminder-list");
    box.replaceChildren();
    $("#reminder-empty").hidden = list.length > 0;
    list.forEach(function (r) {
      var item = el("article", "reminder-item priority-" + r.priority);
      var text = el("div", "body");
      var title = el("h3", null, r.title);
      if (r.priority !== "normal") title.append(el("span", "priority-badge", " " + (PRIORITY_LABEL[r.priority] || "")));
      text.append(title);
      if (r.body) text.append(el("p", "reminder-body", r.body));
      if (r.expiresAt) text.append(el("p", "reminder-until", "Until " + when(r.expiresAt, true)));
      item.append(el("span", "dot"), text);
      box.append(item);
    });
  }

  // A problem here (for example the database update has not been run yet) must never break the dashboard.
  function loadDashboard() {
    if (API.member.services) {
      API.member.services().then(renderServices, function () {});
    }
    if (API.member.sermons) {
      loadSermons();
      if (API.member.sermonSeries) API.member.sermonSeries().then(renderSeriesChips, function () {});
    }
    if (API.member.reminders) {
      API.member.reminders().then(function (list) {
        renderUrgent(list);
        renderReminders(list);
      }, function () {});
    }
  }

  function greeting() {
    var hour = Number(new Date().toLocaleString("en-ZA", { hour: "2-digit", hour12: false, timeZone: TZ }));
    return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  }

  function fill(member) {
    $("#welcome").textContent = greeting() + ", " + member.fullName.split(" ")[0];
    $("#today").textContent = new Date().toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
    $("#since").textContent = member.joinedAt ? "Member since " + formatDate(member.joinedAt) : "";
    window.CBC_APP.setUser(member.fullName);
    $("#d-name").value = member.fullName;
    $("#d-phone").value = member.phone;
    $("#d-email").value = member.email;
  }

  function handleAuth(err) {
    if (err && err.auth) return toLogin();
    if (err && err.unavailable) {
      return showNotice("This page isn't available", "Please try again later.");
    }
    showNotice("Something went wrong", (err && err.message) || "Please refresh the page and try again.");
  }

  $("#details-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var status = $("#d-status");
    var btn = $("#d-save");
    var name = $("#d-name").value.trim();
    status.className = "form-status";
    if (name.length < 2) {
      status.textContent = "Please enter your full name.";
      status.className = "form-status show error";
      return;
    }
    btn.disabled = true;
    API.member
      .update({ fullName: name, phone: $("#d-phone").value.trim() })
      .then(function (member) {
        fill(member);
        status.textContent = "Your details have been saved.";
        status.className = "form-status show ok";
      })
      .catch(function (err) {
        if (err && err.auth) return toLogin();
        status.textContent = (err && err.message) || "Couldn't save. Please try again.";
        status.className = "form-status show error";
      })
      .then(function () {
        btn.disabled = false;
      });
  });

  signOutBtn.addEventListener("click", function () {
    API.auth.logout().then(toLogin);
  });

  API.auth
    .session()
    .then(function (s) {
      if (!s || s.role === "unlinked") return toLogin();
      if (s.role === "admin") return window.location.replace("admin.html");
      return Promise.all([API.member.me(), API.member.notices()]).then(function (r) {
        if (r[0].status !== "active") {
          return showNotice("Membership not active", "Please contact the church office to reactivate your membership.");
        }
        fill(r[0]);
        renderNotices(r[1]);
        show("app");
        if (!API.member.sermons) $("#nav-sermons").hidden = true;
        if (!API.program) $("#nav-program").hidden = true;
        if (!API.member.services && !API.member.reminders) $("#home-empty").hidden = false;
        var nav = window.CBC_APP.views(function (name) {
          if (name === "program" && window.CBC_MPROG) window.CBC_MPROG.showList();
        });
        if (API.program && window.CBC_MPROG) window.CBC_MPROG.init({ API: API, nav: nav, el: el, $: $, when: when });
        $("#avatar").addEventListener("click", function () { nav.show("profile"); });
        nav.start("home");
        window.CBC_APP.bell(API);
        loadDashboard();
      });
    })
    .catch(handleAuth);
})();
