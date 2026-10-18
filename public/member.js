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
    signOutBtn.hidden = name !== "app";
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
      // The live video appears half an hour before the start and stays until the end.
      var start = new Date(s.startsAt).getTime();
      var end = s.endsAt ? new Date(s.endsAt).getTime() : start + 3 * 60 * 60 * 1000;
      if (s.streamUrl && now >= start - 30 * 60 * 1000 && now <= end) {
        var watch = videoBlock(s, "Watch live");
        if (watch) card.append(watch);
      }
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
    var videoId = window.CBC_YT ? window.CBC_YT.id(s.streamUrl) : "";
    if (videoId) return playerBlock(videoId, s.title, label);
    if (/^https:\/\//i.test(s.streamUrl || "")) {
      var link = el("a", "btn btn-gold btn-sm", "Open video");
      link.href = s.streamUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return link;
    }
    return null;
  }

  function renderSermons(list) {
    var box = $("#sermon-list");
    box.replaceChildren();
    $("#sermons-section").hidden = list.length === 0;
    list.forEach(function (s) {
      var card = el("article", "service-card");
      card.append(el("h3", null, s.title));
      card.append(el("p", "service-when", when(s.startsAt, true)));
      [["Speaker", s.speaker], ["Theme", s.theme], ["Scripture", s.scripture]].forEach(function (row) {
        if (!row[1]) return;
        var p = el("p", "service-line");
        p.append(el("span", "service-key", row[0]), " " + row[1]);
        card.append(p);
      });
      var watch = videoBlock(s, "Watch the sermon");
      if (watch) card.append(watch);
      box.append(card);
    });
  }

  function renderReminders(list) {
    $("#reminders-section").hidden = false;
    var box = $("#reminder-list");
    box.replaceChildren();
    $("#reminder-empty").hidden = list.length > 0;
    list.forEach(function (r) {
      var item = el("article", "reminder-item priority-" + r.priority);
      var head = el("div", "reminder-head");
      head.append(el("span", "priority-badge", PRIORITY_LABEL[r.priority] || "Normal"), el("h3", null, r.title));
      item.append(head);
      if (r.body) item.append(el("p", "reminder-body", r.body));
      if (r.expiresAt) item.append(el("p", "reminder-until", "Until " + when(r.expiresAt, true)));
      box.append(item);
    });
  }

  // A problem here (for example the database update has not been run yet) must never break the dashboard.
  function loadDashboard() {
    if (API.member.services) {
      API.member.services().then(renderServices, function () {});
    }
    if (API.member.sermons) {
      API.member.sermons().then(renderSermons, function () {});
    }
    if (API.member.reminders) {
      API.member.reminders().then(function (list) {
        renderUrgent(list);
        renderReminders(list);
      }, function () {});
    }
  }

  function fill(member) {
    $("#welcome").textContent = "Welcome, " + member.fullName.split(" ")[0];
    $("#since").textContent = member.joinedAt ? "Member since " + formatDate(member.joinedAt) : "";
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
        loadDashboard();
      });
    })
    .catch(handleAuth);
})();
