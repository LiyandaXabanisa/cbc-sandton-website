// Demo database for the site.
//
// GitHub Pages cannot run a server or a database, so until the real ChurchHub
// (Supabase) database is connected, this file stands in for it. It keeps a small
// set of SAMPLE members and notices in the visitor's own browser (localStorage),
// so registration, login, the member area and the leaders area all work for a
// showcase. Nothing is ever sent anywhere.
//
// It switches itself on only when:
//   * site.config.js has  demo: true  and the address is one of demoHosts (default github.io), or
//   * the address ends with  ?demo=1  (handy for trying it on your own computer)
// and it switches itself off the moment the Supabase details are filled in.
// To remove it for good, delete this file and its <script> tags.

(function () {
  var cfg = window.SITE_CONFIG || {};
  var sb = cfg.supabase || {};
  if (sb.url && sb.anonKey && sb.churchId) return; // a real database is connected

  var loc = window.location || {};
  var host = (loc.hostname || "").toLowerCase();
  var forced = /[?&]demo=1(&|$)/.test(loc.search || "");
  // Only the addresses listed in demoHosts (default: the GitHub preview) get the demo,
  // so the real church domain never shows sample data by accident.
  var demoHosts = Array.isArray(cfg.demoHosts) ? cfg.demoHosts : ["github.io"];
  var onDemoHost = demoHosts.some(function (h) {
    h = String(h).toLowerCase();
    return host === h || host.slice(-(h.length + 1)) === "." + h;
  });
  if (!(forced || (cfg.demo === true && onDemoHost))) return;

  var LEADER_EMAIL = "leader@demo.example";
  var MEMBER_EMAIL = "grace.tau@example.com";
  var DEMO_PASSWORD = "demo1234";
  var DB_KEY = "cbc_demo_db_v1";
  var SESSION_KEY = "cbc_demo_session";
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var PHONE_RE = /^[0-9+()\-\s]{7,30}$/;

  function ApiError(message, opts) {
    var e = new Error(message);
    e.auth = !!(opts && opts.auth);
    return e;
  }

  // ---------- small helpers ----------

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function randomHex(bytes) {
    var a = new Uint8Array(bytes);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
    else for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map
      .call(a, function (b) {
        return ("0" + b.toString(16)).slice(-2);
      })
      .join("");
  }

  function sha(text) {
    if (window.crypto && crypto.subtle && window.TextEncoder) {
      return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (buf) {
        return Array.prototype.map
          .call(new Uint8Array(buf), function (b) {
            return ("0" + b.toString(16)).slice(-2);
          })
          .join("");
      });
    }
    // Very old browsers only: a simple non-secure fingerprint is fine for sample data.
    var h = 5381;
    for (var i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return Promise.resolve("weak" + (h >>> 0).toString(16));
  }

  function hashPassword(password) {
    var salt = randomHex(8);
    return sha(salt + password).then(function (h) {
      return salt + ":" + h;
    });
  }

  function checkPassword(password, stored) {
    var parts = String(stored || "").split(":");
    if (parts.length !== 2) return Promise.resolve(false);
    return sha(parts[0] + password).then(function (h) {
      return h === parts[1];
    });
  }

  function normaliseCode(code) {
    return String(code || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  }

  function text(v) {
    return typeof v === "string" ? v.trim() : "";
  }

  function iso(daysAgo) {
    return new Date(Date.now() - daysAgo * 86400000).toISOString();
  }

  // ---------- the sample database ----------

  function sampleMember(fullName, email, phone, notes, status, source, daysAgo) {
    var created = iso(daysAgo);
    return {
      id: uid(),
      fullName: fullName,
      email: email,
      phone: phone,
      notes: notes,
      status: status,
      source: source,
      createdAt: created,
      joinedAt: status === "pending" ? null : created.slice(0, 10),
    };
  }

  function seed() {
    return Promise.all([hashPassword(DEMO_PASSWORD), hashPassword(DEMO_PASSWORD)]).then(function (h) {
      var grace = sampleMember("Grace Tau", MEMBER_EMAIL, "082 555 0104", "", "active", "admin", 90);
      grace.passwordHash = h[1];
      return {
        leaders: [{ email: LEADER_EMAIL, passwordHash: h[0] }],
        members: [
          sampleMember("Thandi Khumalo", "thandi.khumalo@example.com", "071 555 0101", "First time visitor, came with a friend.", "pending", "website", 1),
          sampleMember("Lerato Mokoena", "lerato.mokoena@example.com", "071 555 0102", "Interested in joining a small group.", "pending", "website", 2),
          sampleMember("Sipho Dlamini", "sipho.dlamini@example.com", "071 555 0103", "", "active", "website", 40),
          grace,
          sampleMember("Mpho Sithole", "mpho.sithole@example.com", "", "Moved to Cape Town.", "inactive", "admin", 200),
        ],
        notices: [
          { id: uid(), title: "Sunday parking", body: "Please use the east gate this week.\nThank you for helping us keep the road clear.", published: true, createdAt: iso(2), updatedAt: iso(2) },
          { id: uid(), title: "Youth night", body: "Friday at 18:00 in the main hall. All teenagers are welcome.", published: true, createdAt: iso(5), updatedAt: iso(5) },
          { id: uid(), title: "Draft: Easter programme", body: "Still being planned. Members cannot see this one yet.", published: false, createdAt: iso(1), updatedAt: iso(1) },
        ],
      };
    });
  }

  var memoryDb = null;

  function readStore() {
    try {
      var raw = localStorage.getItem(DB_KEY);
      return raw ? JSON.parse(raw) : memoryDb;
    } catch (_) {
      return memoryDb;
    }
  }

  function writeStore(db) {
    memoryDb = db;
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(db));
    } catch (_) {}
  }

  function getDb() {
    var db = readStore();
    if (db) return Promise.resolve(db);
    return seed().then(function (fresh) {
      writeStore(fresh);
      return fresh;
    });
  }

  // ---------- session ----------

  function readSession() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    } catch (_) {
      return null;
    }
  }
  function writeSession(s) {
    try {
      if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch (_) {}
  }

  function needLeader() {
    var s = readSession();
    if (!s || s.role !== "admin") return Promise.reject(ApiError("Please sign in.", { auth: true }));
    return getDb();
  }

  function needMember() {
    var s = readSession();
    if (!s || s.role !== "member") return Promise.reject(ApiError("Please sign in.", { auth: true }));
    return getDb().then(function (db) {
      var m = db.members.find(function (x) {
        return x.id === s.memberId;
      });
      if (!m || m.status !== "active") {
        writeSession(null);
        throw ApiError("Please sign in.", { auth: true });
      }
      return { db: db, member: m };
    });
  }

  function publicMember(m) {
    return {
      id: m.id,
      fullName: m.fullName,
      email: m.email,
      phone: m.phone,
      notes: m.notes,
      status: m.status,
      source: m.source,
      createdAt: m.createdAt,
      joinedAt: m.joinedAt,
      hasAccount: !!m.passwordHash,
    };
  }

  function selfMember(m) {
    return { id: m.id, fullName: m.fullName, email: m.email, phone: m.phone, status: m.status, joinedAt: m.joinedAt };
  }

  function checkMemberFields(p, requireAll) {
    var out = {};
    if (requireAll || "fullName" in p) {
      out.fullName = text(p.fullName);
      if (out.fullName.length < 2 || out.fullName.length > 120) throw ApiError("Please enter the member's full name.");
    }
    if (requireAll || "email" in p) {
      out.email = text(p.email);
      if (out.email && !EMAIL_RE.test(out.email)) throw ApiError("That email address doesn't look right.");
    }
    if (requireAll || "phone" in p) {
      out.phone = text(p.phone);
      if (out.phone && !PHONE_RE.test(out.phone)) throw ApiError("That phone number doesn't look right.");
    }
    if (requireAll || "notes" in p) {
      out.notes = text(p.notes);
      if (out.notes.length > 500) throw ApiError("Notes must be under 500 characters.");
    }
    return out;
  }

  function checkNotice(p) {
    var title = text(p.title);
    var body = text(p.body);
    if (!title || title.length > 120) throw ApiError("Give the notice a title of up to 120 characters.");
    if (!body || body.length > 4000) throw ApiError("Write the notice text (up to 4000 characters).");
    return { title: title, body: body, published: p.published !== false };
  }

  function findById(list, id, message) {
    var item = list.find(function (x) {
      return x.id === id;
    });
    if (!item) throw ApiError(message);
    return item;
  }

  function noop() {}

  // ---------- the API (same shape as the real back ends) ----------

  var api = {
    mode: "demo",
    modeLabel: "Demo data: stored only in this browser",
    demo: {
      leaderEmail: LEADER_EMAIL,
      memberEmail: MEMBER_EMAIL,
      password: DEMO_PASSWORD,
      reset: function () {
        try {
          localStorage.removeItem(DB_KEY);
        } catch (_) {}
        memoryDb = null;
        writeSession(null);
      },
    },

    register: function (p) {
      if (text(p.hp_company)) return Promise.resolve("Thank you! Your details have been received.");
      var firstName = text(p.firstName), lastName = text(p.lastName), email = text(p.email), phone = text(p.phone), notes = text(p.notes);
      try {
        if (!firstName || firstName.length > 60) throw ApiError("Please enter your first name.");
        if (!lastName || lastName.length > 60) throw ApiError("Please enter your last name.");
        if (!email && !phone) throw ApiError("Provide an email address or a phone number.");
        if (email && !EMAIL_RE.test(email)) throw ApiError("That email address doesn't look right.");
        if (phone && !PHONE_RE.test(phone)) throw ApiError("That phone number doesn't look right.");
        if (notes.length > 500) throw ApiError("Please keep your note under 500 characters.");
        if (p.consent !== true) throw ApiError("Please tick the box to let us store your details.");
      } catch (e) {
        return Promise.reject(e);
      }
      var message = "Demo only: thanks, " + firstName + ". Your details were saved in this browser as a test and were not sent to the church.";
      return getDb().then(function (db) {
        var exists = email && db.members.some(function (m) {
          return m.email && m.email.toLowerCase() === email.toLowerCase();
        });
        if (!exists) {
          var m = sampleMember(firstName + " " + lastName, email, phone, notes, "pending", "website", 0);
          db.members.push(m);
          writeStore(db);
        }
        return message;
      });
    },

    auth: {
      emailOptional: false,
      session: function () {
        var s = readSession();
        if (!s) return Promise.resolve(null);
        if (s.role === "admin") return Promise.resolve({ role: "admin" });
        return needMember().then(
          function () {
            return { role: "member" };
          },
          function () {
            return null;
          }
        );
      },
      login: function (c) {
        var email = text(c.email).toLowerCase();
        var password = c.password || "";
        var BAD = "That email or password isn't right.";
        return getDb().then(function (db) {
          var leader = db.leaders.find(function (l) {
            return l.email.toLowerCase() === email;
          });
          if (leader) {
            return checkPassword(password, leader.passwordHash).then(function (ok) {
              if (!ok) throw ApiError(BAD, { auth: true });
              writeSession({ role: "admin" });
              return { role: "admin" };
            });
          }
          var member = db.members.find(function (m) {
            return m.email && m.email.toLowerCase() === email && m.passwordHash;
          });
          if (!member) return Promise.reject(ApiError(BAD, { auth: true }));
          return checkPassword(password, member.passwordHash).then(function (ok) {
            if (!ok) throw ApiError(BAD, { auth: true });
            if (member.status !== "active") throw ApiError("Your membership isn't active. Please contact the church office.");
            writeSession({ role: "member", memberId: member.id });
            return { role: "member" };
          });
        });
      },
      activate: function (c) {
        var email = text(c.email).toLowerCase();
        var BAD = "That code isn't right or has expired. Ask your leader for a new one.";
        if (!c.password || c.password.length < 8) return Promise.reject(ApiError("Choose a password of at least 8 characters."));
        return getDb().then(function (db) {
          var member = db.members.find(function (m) {
            return m.email && m.email.toLowerCase() === email && m.inviteHash;
          });
          if (!member || member.status !== "active") throw ApiError(BAD);
          if (new Date(member.inviteExpires).getTime() < Date.now() || (member.inviteAttempts || 0) >= 5) throw ApiError(BAD);
          return sha(normaliseCode(c.code)).then(function (h) {
            if (h !== member.inviteHash) {
              member.inviteAttempts = (member.inviteAttempts || 0) + 1;
              writeStore(db);
              throw ApiError(BAD);
            }
            return hashPassword(c.password).then(function (ph) {
              member.passwordHash = ph;
              delete member.inviteHash;
              delete member.inviteExpires;
              delete member.inviteAttempts;
              writeStore(db);
              writeSession({ role: "member", memberId: member.id });
              return { role: "member" };
            });
          });
        });
      },
      claim: function () {
        return Promise.reject(ApiError("Use the invite code on the activate form."));
      },
      logout: function () {
        writeSession(null);
        return Promise.resolve();
      },
    },

    admin: {
      list: function () {
        return needLeader().then(function (db) {
          return db.members
            .slice()
            .sort(function (a, b) {
              return String(b.createdAt).localeCompare(String(a.createdAt));
            })
            .map(publicMember);
        });
      },
      create: function (m) {
        return needLeader().then(function (db) {
          var f = checkMemberFields(m, true);
          if (!f.email && !f.phone) throw ApiError("Provide an email address or a phone number.");
          var member = sampleMember(f.fullName, f.email, f.phone, f.notes, "active", "admin", 0);
          db.members.push(member);
          writeStore(db);
          return publicMember(member);
        });
      },
      update: function (id, patch) {
        return needLeader().then(function (db) {
          var member = findById(db.members, id, "That member no longer exists.");
          var f = checkMemberFields(patch, false);
          Object.assign(member, f);
          if (patch.status === "active" || patch.status === "inactive" || patch.status === "pending") member.status = patch.status;
          if (!member.email && !member.phone) throw ApiError("Keep at least an email address or a phone number.");
          if ((member.status === "active" || member.status === "inactive") && !member.joinedAt) member.joinedAt = new Date().toISOString().slice(0, 10);
          writeStore(db);
          return publicMember(member);
        });
      },
      remove: function (id) {
        return needLeader().then(function (db) {
          findById(db.members, id, "That member no longer exists.");
          db.members = db.members.filter(function (m) {
            return m.id !== id;
          });
          writeStore(db);
        });
      },
      invite: function (id) {
        return needLeader().then(function (db) {
          var member = findById(db.members, id, "That member no longer exists.");
          if (member.status !== "active") throw ApiError("Approve this person before inviting them to the member area.");
          if (!member.email) throw ApiError("Add an email address for this member first.");
          var raw = randomHex(6).toUpperCase();
          var code = raw.slice(0, 4) + "-" + raw.slice(4, 8) + "-" + raw.slice(8, 12);
          var expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();
          return sha(raw).then(function (h) {
            member.inviteHash = h;
            member.inviteExpires = expiresAt;
            member.inviteAttempts = 0;
            writeStore(db);
            return { code: code, expiresAt: expiresAt };
          });
        });
      },
      notices: {
        list: function () {
          return needLeader().then(function (db) {
            return db.notices.slice().sort(function (a, b) {
              return String(b.createdAt).localeCompare(String(a.createdAt));
            });
          });
        },
        create: function (n) {
          return needLeader().then(function (db) {
            var f = checkNotice(n);
            var now = new Date().toISOString();
            var notice = { id: uid(), title: f.title, body: f.body, published: f.published, createdAt: now, updatedAt: now };
            db.notices.push(notice);
            writeStore(db);
            return notice;
          });
        },
        update: function (id, n) {
          return needLeader().then(function (db) {
            var notice = findById(db.notices, id, "That notice no longer exists.");
            var f = checkNotice(Object.assign({}, notice, n));
            Object.assign(notice, f, { updatedAt: new Date().toISOString() });
            writeStore(db);
            return notice;
          });
        },
        remove: function (id) {
          return needLeader().then(function (db) {
            findById(db.notices, id, "That notice no longer exists.");
            db.notices = db.notices.filter(function (n) {
              return n.id !== id;
            });
            writeStore(db);
          });
        },
      },
    },

    member: {
      me: function () {
        return needMember().then(function (r) {
          return selfMember(r.member);
        });
      },
      update: function (p) {
        return needMember().then(function (r) {
          var fullName = text(p.fullName), phone = text(p.phone);
          if (fullName.length < 2 || fullName.length > 120) throw ApiError("Please enter your full name.");
          if (phone && !PHONE_RE.test(phone)) throw ApiError("That phone number doesn't look right.");
          r.member.fullName = fullName;
          r.member.phone = phone;
          writeStore(r.db);
          return selfMember(r.member);
        });
      },
      notices: function () {
        return needMember().then(function (r) {
          return r.db.notices
            .filter(function (n) {
              return n.published;
            })
            .sort(function (a, b) {
              return String(b.createdAt).localeCompare(String(a.createdAt));
            });
        });
      },
    },
  };

  window.CBC_API = api;

  // A banner on every page so nobody mistakes the sample data for the real thing.
  function addBanner() {
    var bar = document.createElement("div");
    bar.className = "demo-banner";
    bar.setAttribute("role", "note");
    bar.textContent = "Demo preview: sample data only, stored in your browser. Nothing you enter is sent to the church.";
    document.body.insertBefore(bar, document.body.firstChild);
  }
  if (document.body) addBanner();
  else document.addEventListener("DOMContentLoaded", addBanner);

  noop();
})();
