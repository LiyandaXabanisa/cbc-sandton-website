(function () {
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

  function fill(member) {
    $("#welcome").textContent = "Welcome, " + member.fullName.split(" ")[0];
    $("#since").textContent = member.joinedAt ? "Member since " + formatDate(member.joinedAt) : "";
    $("#d-name").value = member.fullName;
    $("#d-phone").value = member.phone;
    $("#d-email").value = member.email;
  }

  function handleAuth(err) {
    if (err && err.auth) return toLogin();
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
      });
    })
    .catch(handleAuth);
})();
