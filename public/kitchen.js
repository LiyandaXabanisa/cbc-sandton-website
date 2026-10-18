// The Soup Kitchen workspace: this month's team and tasks, and the rotation schedule.
// Plugs into the ministry module (ministry.js). Loaded after it.
(function () {
  if (!window.CBC_MIN) return;
  var ui = window.CBC_MIN.ui;
  var el = ui.el, btn = ui.btn, field = ui.field, input = ui.input, textarea = ui.textarea, dialog = ui.dialog, fail = ui.fail;

  var CATEGORY = { shopping: "Shopping", cooking: "Cooking", serving: "Serving", cleanup: "Clean up", other: "Other" };
  var ORDER = ["shopping", "cooking", "serving", "cleanup", "other"];
  var area, ctx;

  function monthName(date) {
    var d = new Date(date + "T12:00:00");
    return isNaN(d) ? date : d.toLocaleDateString("en-ZA", { month: "long", year: "numeric" });
  }

  function dayName(date) {
    var d = new Date(date + "T12:00:00");
    return isNaN(d) ? date : d.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" });
  }

  function monthStartOf(date) {
    return date.slice(0, 7) + "-01";
  }

  function nextMonthStart(date) {
    var d = new Date(date + "T12:00:00");
    d.setMonth(d.getMonth() + 1, 1);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-01";
  }

  function render() {
    ctx = ui.ctx();
    var root = ui.root();
    var chips = el("div", "chips");
    chips.setAttribute("role", "tablist");
    area = el("div", "min-area");
    var defs = [["now", "This month", showNow], ["schedule", "Schedule", showSchedule]];
    function select(name) {
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
    select("now");
  }

  // ---------- this month ----------
  function showNow() {
    area.replaceChildren(el("p", "empty", "Loading…"));
    ctx.API.kitchen.schedule().then(function (list) {
      var today = new Date();
      var thisMonth = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-01";
      var now = list.filter(function (m) { return monthStartOf(m.month) === thisMonth; })[0];
      if (now) return openMonth(now.monthId, false);
      area.replaceChildren();
      var next = list.filter(function (m) { return m.amMember && m.month > thisMonth; })[0];
      area.append(el("p", "empty", "You are not on this month's team."));
      if (next) area.append(el("p", "muted", "Your next turn is " + monthName(next.month) + "."));
    }, ctx.handleError);
  }

  // ---------- the schedule ----------
  function showSchedule() {
    area.replaceChildren(el("p", "empty", "Loading…"));
    var manager = ui.isManager();
    return ctx.API.kitchen.schedule().then(function (list) {
      area.replaceChildren();
      if (manager) area.append(btn("Set up a month", "btn-gold", function () { editMonth(null); }));
      if (!list.length) area.append(el("p", "empty", manager ? "No months are set up yet. Choose a leader for each month." : "You are not on a team yet."));
      var box = el("div", "list");
      list.forEach(function (m) {
        var row = el("div", "row");
        row.setAttribute("role", "button");
        row.tabIndex = 0;
        var main = el("span", "main");
        main.append(el("span", "name", monthName(m.month) + (m.teamName ? "  |  " + m.teamName : "")), el("span", "sub", "Led by " + (m.leaderName || "no one yet") + "  |  " + m.members + " of 3"));
        row.append(main);
        if (m.amLeader) row.append(el("span", "pill active", "you lead"));
        else if (m.amMember) row.append(el("span", "pill inactive", "you serve"));
        var go = function () { openMonth(m.monthId, true); };
        row.addEventListener("click", go);
        row.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
        box.append(row);
      });
      if (list.length) area.append(box);
    }, ctx.handleError);
  }

  function editMonth(existing) {
    ctx.API.kitchen.volunteers().then(function (people) {
      var month = input("month", existing ? existing.month.slice(0, 7) : "");
      var leader = el("select");
      people.forEach(function (p) { leader.append(new Option(p.name, p.userId)); });
      if (existing && existing.leaderId) leader.value = existing.leaderId;
      var team = input("text", existing ? existing.teamName : "", { maxlength: "60", placeholder: "For example: Team A" });
      var hint = people.length ? null : "No one has the Soup Kitchen ministry role yet. Give it in Settings, People and roles, then come back.";
      dialog("Set up a month", [field("Month", month), field("Team leader", leader, hint || "Only active members with the Soup Kitchen ministry role are listed. The leader then chooses the other two team members."), field("Team name (optional)", team)], "Save", function () {
        if (!month.value) fail("Choose the month.");
        if (!leader.value) fail("Choose the team leader.");
        return ctx.API.kitchen.saveMonth({ month: month.value + "-01", leaderId: leader.value, teamName: team.value.trim() }).then(function () {
          ctx.toast("Month saved");
          showSchedule();
        });
      });
    }, ctx.handleError);
  }

  // ---------- one month ----------
  function openMonth(id, fromSchedule) {
    return ctx.API.kitchen.month(id).then(function (m) {
      area.replaceChildren();
      if (!m) {
        area.append(el("p", "empty", "That month isn't available to you."));
        return;
      }
      if (fromSchedule) area.append(btn("Back to the schedule", "btn-outline", showSchedule));
      var head = el("div", "form-card");
      head.append(el("h3", null, monthName(m.month) + (m.teamName ? "  |  " + m.teamName : "")));
      head.append(el("p", "muted", "Team leader: " + (m.leaderName || "not set")));
      if (m.isPast) head.append(el("p", "muted", "This month has passed. It is kept as a record."));
      else if (!m.isLeader) head.append(el("p", "muted", "Only the team leader changes the team and plans the tasks."));
      area.append(head);

      // the team
      area.append(el("h2", null, "The team (" + m.members.length + " of 3)"));
      var team = el("div", "list");
      m.members.forEach(function (p) {
        var row = el("div", "row");
        var main = el("span", "main");
        main.append(el("span", "name", p.name), el("span", "sub", p.isLeader ? "Team leader" : "Team member"));
        row.append(main);
        if (m.isLeader && !m.isPast && !p.isLeader) {
          row.append(btn("Remove", "btn-outline", function () {
            if (!window.confirm("Remove " + p.name + " from the team?")) return;
            ctx.API.kitchen.remove(m.id, p.userId).then(function () { ctx.toast("Removed"); openMonth(m.id, fromSchedule); }, ctx.handleError);
          }));
        }
        team.append(row);
      });
      area.append(team);
      if (m.isLeader && !m.isPast && m.members.length < 3) area.append(btn("Admit a team member", "btn-gold", function () { admit(m, fromSchedule); }));
      if (m.isManager && !m.isPast && fromSchedule) {
        var tools = el("div", "p-footer");
        tools.append(
          btn("Change leader or name", "btn-outline", function () { editMonth({ month: m.month, leaderId: m.leaderId, teamName: m.teamName }); }),
          btn("Delete this month", "btn-danger", function () {
            if (!window.confirm("Delete the team and tasks for " + monthName(m.month) + "?")) return;
            ctx.API.kitchen.deleteMonth(m.id).then(function () { ctx.toast("Month deleted"); showSchedule(); }, ctx.handleError);
          })
        );
        area.append(tools);
      }

      // the tasks
      area.append(el("h2", null, "Tasks"));
      if (m.isLeader && !m.isPast) area.append(btn("Add a task", "btn-gold", function () { editTask(m, null, fromSchedule); }));
      if (!m.tasks.length) area.append(el("p", "empty", m.isLeader ? "No tasks yet. Use Add a task to hand out the work." : "No tasks have been planned yet."));
      ORDER.forEach(function (cat) {
        var tasks = m.tasks.filter(function (t) { return t.category === cat; });
        if (!tasks.length) return;
        area.append(el("h2", null, CATEGORY[cat]));
        tasks.forEach(function (t) { area.append(taskCard(m, t, fromSchedule)); });
      });
    }, ctx.handleError);
  }

  function taskCard(m, t, fromSchedule) {
    var me = ctx.me ? ctx.me() : null;
    var card = el("article", "service-card kitchen-task" + (t.done ? " is-done" : ""));
    var head = el("div", "sermon-head");
    head.append(el("h3", null, t.title));
    if (t.done) head.append(el("span", "priority-badge", "Done"));
    card.append(head);
    var bits = [t.assigneeName ? "For " + t.assigneeName : "Not given to anyone yet", t.dueDate ? "Due " + dayName(t.dueDate) : ""].filter(Boolean).join("  |  ");
    card.append(el("p", "service-line", bits));
    if (t.notes) card.append(el("p", "service-notes", t.notes));
    t.checklist.forEach(function (c) {
      var line = el("label", "check-line");
      var box = el("input");
      box.type = "checkbox";
      box.checked = c.done;
      box.disabled = m.isPast;
      box.addEventListener("change", function () {
        ctx.API.kitchen.setCheck(c.id, box.checked).then(function () { line.classList.toggle("is-done", box.checked); }, function (err) { box.checked = !box.checked; ctx.handleError(err); });
      });
      line.classList.toggle("is-done", c.done);
      line.append(box, document.createTextNode(" " + c.text));
      card.append(line);
    });
    if (!m.isPast) {
      var acts = el("div", "sermon-actions");
      var tick = btn(t.done ? "Mark as not done" : "Mark as done", "btn-outline", function () {
        ctx.API.kitchen.setDone(t.id, !t.done).then(function () { openMonth(m.id, fromSchedule); }, ctx.handleError);
      });
      acts.append(tick);
      if (m.isLeader) {
        acts.append(btn("Edit", "btn-outline", function () { editTask(m, t, fromSchedule); }), btn("Delete", "btn-danger", function () {
          if (!window.confirm("Delete “" + t.title + "”?")) return;
          ctx.API.kitchen.deleteTask(t.id).then(function () { openMonth(m.id, fromSchedule); }, ctx.handleError);
        }));
      }
      card.append(acts);
    }
    return card;
  }

  function admit(m, fromSchedule) {
    ctx.API.kitchen.pool(m.id).then(function (people) {
      var sel = el("select");
      people.forEach(function (p) { sel.append(new Option(p.name, p.userId)); });
      var note = people.length ? "Only volunteers with the Soup Kitchen ministry role are listed." : "No volunteers are left to admit. Managers give the Soup Kitchen ministry role in Settings, People and roles.";
      dialog("Admit a team member", [field("Volunteer", sel, note)], "Admit", function () {
        if (!sel.value) fail("Choose a volunteer.");
        return ctx.API.kitchen.admit(m.id, sel.value).then(function () { ctx.toast("Added to the team"); openMonth(m.id, fromSchedule); });
      });
    }, ctx.handleError);
  }

  function editTask(m, task, fromSchedule) {
    var t = task || { id: null, title: "", category: "cooking", assigneeId: null, dueDate: "", notes: "", checklist: [] };
    var title = input("text", t.title, { maxlength: "120" });
    var cat = el("select");
    ORDER.forEach(function (c) { cat.append(new Option(CATEGORY[c], c)); });
    cat.value = t.category;
    var who = el("select");
    who.append(new Option("Not given to anyone yet", ""));
    m.members.forEach(function (p) { who.append(new Option(p.name, p.userId)); });
    who.value = t.assigneeId || "";
    var last = new Date(nextMonthStart(m.month) + "T12:00:00");
    last.setDate(0);
    var lastDay = last.getFullYear() + "-" + String(last.getMonth() + 1).padStart(2, "0") + "-" + String(last.getDate()).padStart(2, "0");
    var due = input("date", t.dueDate || "", { min: monthStartOf(m.month), max: lastDay });
    var notes = textarea(t.notes, 3, 1000);
    var list = textarea(t.checklist.map(function (c) { return c.text; }).join("\n"), 4, 2000);
    var ids = t.checklist.map(function (c) { return c; });
    dialog(task ? "Edit task" : "Add a task", [
      field("What needs doing", title), field("Kind of task", cat), field("Given to", who), field("Due date (inside the month)", due),
      field("Notes (optional)", notes), field("Checklist (optional, one item per line)", list),
    ], "Save", function () {
      if (!title.value.trim()) fail("Give the task a title.");
      var lines = list.value.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
      // keep the id and the ticked state of items whose words did not change
      var checklist = lines.map(function (text, i) {
        var old = ids[i];
        return { id: old && old.text === text ? old.id : null, text: text, done: old && old.text === text ? old.done : false };
      });
      return ctx.API.kitchen.saveTask(m.id, { id: t.id, title: title.value.trim(), category: cat.value, assigneeId: who.value || null, dueDate: due.value || null, notes: notes.value.trim(), checklist: checklist }).then(function () {
        ctx.toast("Task saved");
        openMonth(m.id, fromSchedule);
      });
    });
  }

  // ---------- Home: my Soup Kitchen tasks ----------
  function home(c) {
    var sec = document.querySelector("#kitchen-section");
    if (!sec || !c.API.kitchen) return;
    c.API.kitchen.mine().then(function (r) {
      var box = sec.querySelector("#kitchen-list");
      box.replaceChildren();
      if (!r || (!r.onTeam && !r.nextTurn)) { sec.hidden = true; return; }
      sec.hidden = false;
      if (!r.onTeam) {
        box.append(el("p", "service-line", "Your next Soup Kitchen turn is " + monthName(r.nextTurn) + "."));
        return;
      }
      if (!r.tasks.length) box.append(el("p", "service-line", "You are on this month's Soup Kitchen team. You have no open tasks."));
      r.tasks.forEach(function (t) {
        var card = el("article", "reminder-item");
        card.append(el("span", "dot"));
        var body = el("div", "body");
        body.append(el("h3", null, t.title), el("p", "reminder-body", CATEGORY[t.category] + (t.dueDate ? "  |  Due " + dayName(t.dueDate) : "")));
        card.append(body);
        box.append(card);
      });
    });
  }

  window.CBC_MIN.register("soup-kitchen", render);
  window.CBC_KITCHEN = { home: home };
})();
