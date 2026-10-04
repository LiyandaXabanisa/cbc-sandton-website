// Data layer for the site. Exposes window.CBC_API.
//
// Two interchangeable back ends behind one interface:
//   "supabase": used when site.config.js has url + anonKey + churchId (the hosted setup,
//               shares data with ChurchHub).
//   "local": the small Express server in server.js (zero setup, used for demos).
//
// Member shape used by the UI:
//   { id, fullName, email, phone, notes, status: "pending"|"active"|"inactive",
//     source, createdAt, joinedAt, hasAccount }
//
// API.auth.session() resolves to null or { role: "admin" | "member" | "unlinked" }.
// "unlinked" (hosted mode only) means the person has a login but has not yet
// entered the invite code that connects it to their member record.

(function () {
  var cfg = window.SITE_CONFIG || {};
  var sb = cfg.supabase || {};
  var useSupabase = !!(sb.url && sb.anonKey && sb.churchId);
  var SB_URL = (sb.url || "").replace(/\/+$/, "");

  function ApiError(message, opts) {
    var e = new Error(message);
    e.auth = !!(opts && opts.auth);
    e.unavailable = !!(opts && opts.unavailable);
    return e;
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function readJson(res) {
    return res.json().catch(function () {
      return null;
    });
  }

  function noop() {}

  // ===================================================================
  // Local (Express) back end
  // ===================================================================

  function local(path, options) {
    var opts = Object.assign({ credentials: "same-origin", headers: { "Content-Type": "application/json" } }, options || {});
    return fetch(path, opts).then(function (res) {
      return readJson(res).then(function (data) {
        // A 404 with no JSON means there is no server behind this site (e.g. GitHub Pages).
        if (!data && (res.status === 404 || res.status === 405)) {
          throw ApiError("This feature isn't switched on for this site yet.", { unavailable: true });
        }
        if (res.status === 401) throw ApiError((data && data.errors && data.errors[0]) || "Please sign in.", { auth: true });
        if (!res.ok || !data || data.ok === false) {
          throw ApiError((data && data.errors && data.errors.join(" ")) || "Something went wrong. Please try again.", {
            unavailable: res.status === 503,
          });
        }
        return data;
      });
    });
  }

  function send(method, body) {
    return { method: method, body: body === undefined ? undefined : JSON.stringify(body) };
  }

  var localApi = {
    mode: "local",
    modeLabel: "Local mode: details are saved on this computer",
    register: function (p) {
      return local("api/register", send("POST", p)).then(function (d) {
        return d.message;
      });
    },
    auth: {
      emailOptional: true, // leaders can leave the email empty and use the admin password
      session: function () {
        return local("api/me")
          .then(function (d) {
            return { role: d.role };
          })
          .catch(function (e) {
            if (e.auth) return null;
            throw e;
          });
      },
      login: function (c) {
        return local("api/login", send("POST", { email: c.email, password: c.password })).then(function (d) {
          return { role: d.role };
        });
      },
      activate: function (c) {
        return local("api/member/activate", send("POST", c)).then(function (d) {
          return { role: d.role };
        });
      },
      claim: function () {
        return Promise.reject(ApiError("Use the invite code on the activate form."));
      },
      logout: function () {
        return local("api/logout", send("POST")).then(noop, noop);
      },
    },
    admin: {
      list: function () {
        return local("api/admin/members").then(function (d) {
          return d.members;
        });
      },
      create: function (m) {
        return local("api/admin/members", send("POST", m)).then(function (d) {
          return d.member;
        });
      },
      update: function (id, patch) {
        return local("api/admin/members/" + encodeURIComponent(id), send("PATCH", patch)).then(function (d) {
          return d.member;
        });
      },
      remove: function (id) {
        return local("api/admin/members/" + encodeURIComponent(id), send("DELETE")).then(noop);
      },
      invite: function (id) {
        return local("api/admin/members/" + encodeURIComponent(id) + "/invite", send("POST")).then(function (d) {
          return { code: d.code, expiresAt: d.expiresAt };
        });
      },
      notices: {
        list: function () {
          return local("api/admin/notices").then(function (d) {
            return d.notices;
          });
        },
        create: function (n) {
          return local("api/admin/notices", send("POST", n)).then(function (d) {
            return d.notice;
          });
        },
        update: function (id, n) {
          return local("api/admin/notices/" + encodeURIComponent(id), send("PATCH", n)).then(function (d) {
            return d.notice;
          });
        },
        remove: function (id) {
          return local("api/admin/notices/" + encodeURIComponent(id), send("DELETE")).then(noop);
        },
      },
    },
    member: {
      me: function () {
        return local("api/member/me").then(function (d) {
          return d.member;
        });
      },
      update: function (p) {
        return local("api/member/me", send("PATCH", p)).then(function (d) {
          return d.member;
        });
      },
      notices: function () {
        return local("api/member/notices").then(function (d) {
          return d.notices;
        });
      },
    },
  };

  // ===================================================================
  // Supabase back end (talks to the REST + Auth endpoints directly, no library)
  // ===================================================================

  var SESSION_KEY = "cbc_sb_session";

  var tokens = {
    get: function () {
      try {
        return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      } catch (_) {
        return null;
      }
    },
    set: function (v) {
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(v));
      } catch (_) {}
    },
    clear: function () {
      try {
        sessionStorage.removeItem(SESSION_KEY);
      } catch (_) {}
    },
  };

  function sbMessage(data, fallback) {
    if (!data) return fallback;
    return data.message || data.msg || data.error_description || data.error || fallback;
  }

  function sbRequest(path, options, authed, canRetry) {
    var headers = Object.assign({ apikey: sb.anonKey, "Content-Type": "application/json" }, (options && options.headers) || {});
    if (authed) {
      var s = tokens.get();
      if (!s) return Promise.reject(ApiError("Please sign in.", { auth: true }));
      headers.Authorization = "Bearer " + s.access_token;
    } else if (/^eyJ/.test(sb.anonKey)) {
      headers.Authorization = "Bearer " + sb.anonKey;
    }
    return fetch(SB_URL + path, Object.assign({}, options, { headers: headers })).then(function (res) {
      if (res.status === 401 && authed && canRetry !== false) {
        return sbRefresh().then(function (ok) {
          if (!ok) {
            tokens.clear();
            throw ApiError("Your session has expired. Please sign in again.", { auth: true });
          }
          return sbRequest(path, options, authed, false);
        });
      }
      if (res.status === 204) return null;
      return readJson(res).then(function (data) {
        if (!res.ok) {
          if (res.status === 401) throw ApiError(sbMessage(data, "Please sign in."), { auth: true });
          throw ApiError(sbMessage(data, "Something went wrong. Please try again."));
        }
        return data;
      });
    });
  }

  function sbRefresh() {
    var s = tokens.get();
    if (!s || !s.refresh_token) return Promise.resolve(false);
    return fetch(SB_URL + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: { apikey: sb.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    })
      .then(readJson)
      .then(function (data) {
        if (data && data.access_token) {
          tokens.set({ access_token: data.access_token, refresh_token: data.refresh_token || s.refresh_token });
          return true;
        }
        return false;
      })
      .catch(function () {
        return false;
      });
  }

  function rpc(name, body) {
    return sbRequest("/rest/v1/rpc/" + name, { method: "POST", body: JSON.stringify(body || {}) }, true);
  }

  function fromRow(r) {
    var pending = !r.is_active && r.source === "website" && !r.joined_at;
    return {
      id: r.id,
      fullName: r.full_name,
      email: r.email || "",
      phone: r.phone || "",
      notes: r.notes || "",
      status: pending ? "pending" : r.is_active ? "active" : "inactive",
      source: r.source || "app",
      createdAt: r.created_at,
      joinedAt: r.joined_at || null,
      hasAccount: !!r.user_id,
    };
  }

  function toRow(p) {
    var o = {};
    if ("fullName" in p) o.full_name = p.fullName;
    if ("email" in p) o.email = p.email || null;
    if ("phone" in p) o.phone = p.phone || null;
    if ("notes" in p) o.notes = p.notes || null;
    if (p.status === "active") {
      o.is_active = true;
      o.joined_at = p.joinedAt || today();
    } else if (p.status === "inactive") {
      o.is_active = false;
      o.joined_at = p.joinedAt || today();
    }
    return o;
  }

  function fromNotice(r) {
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      published: r.is_published !== false,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  var churchIdPromise = null;
  function adminChurchId() {
    // Use the church the signed-in user actually belongs to, not the public config value.
    if (!churchIdPromise) {
      churchIdPromise = sbRequest("/rest/v1/profiles?select=church_id&limit=1", { method: "GET" }, true).then(function (rows) {
        if (!rows || !rows.length) throw ApiError("This login isn't linked to a church in ChurchHub.");
        return rows[0].church_id;
      });
      churchIdPromise.catch(function () {
        churchIdPromise = null;
      });
    }
    return churchIdPromise;
  }

  // Staff have a ChurchHub profile row. Members have a linked member record.
  function resolveRole() {
    return sbRequest("/rest/v1/profiles?select=church_id&limit=1", { method: "GET" }, true).then(function (rows) {
      if (rows && rows.length) return { role: "admin" };
      return rpc("my_member").then(function (mine) {
        return { role: mine && mine.length ? "member" : "unlinked" };
      });
    });
  }

  function passwordGrant(email, password) {
    return fetch(SB_URL + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { apikey: sb.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: password }),
    }).then(function (res) {
      return readJson(res).then(function (data) {
        if (!res.ok || !data || !data.access_token) {
          var detail = sbMessage(data, "");
          var err = ApiError(
            /not confirmed/i.test(detail)
              ? "Please confirm your email address first (check your inbox), then sign in."
              : "That email or password isn't right.",
            { auth: true }
          );
          throw err;
        }
        tokens.set({ access_token: data.access_token, refresh_token: data.refresh_token });
      });
    });
  }

  function claimMember(email, code) {
    return rpc("claim_member", { p_church_id: sb.churchId, p_email: email, p_code: code }).then(function (ok) {
      if (ok !== true) throw ApiError("That code isn't right or has expired. Ask your leader for a new one.");
    });
  }

  var supabaseApi = {
    mode: "supabase",
    modeLabel: "Connected to ChurchHub",
    register: function (p) {
      if (p.hp_company) return Promise.resolve("Thank you! Your details have been received.");
      var body = {
        p_church_id: sb.churchId,
        p_full_name: (p.firstName + " " + p.lastName).trim(),
        p_phone: p.phone || null,
        p_email: p.email || null,
        p_notes: p.notes || null,
        p_consent: p.consent === true,
      };
      return sbRequest("/rest/v1/rpc/submit_website_registration", { method: "POST", body: JSON.stringify(body) }, false).then(
        function () {
          return "Welcome, " + p.firstName + "! We've received your details and someone will be in touch.";
        }
      );
    },
    auth: {
      emailOptional: false,
      session: function () {
        if (!tokens.get()) return Promise.resolve(null);
        return resolveRole().catch(function (e) {
          if (e.auth) return null;
          throw e;
        });
      },
      login: function (c) {
        return passwordGrant(c.email, c.password).then(resolveRole);
      },
      activate: function (c) {
        // Create the login, then connect it to the member record with the invite code.
        return fetch(SB_URL + "/auth/v1/signup", {
          method: "POST",
          headers: { apikey: sb.anonKey, "Content-Type": "application/json" },
          body: JSON.stringify({ email: c.email, password: c.password }),
        })
          .then(function (res) {
            return readJson(res).then(function (data) {
              if (!res.ok) throw ApiError(sbMessage(data, "We couldn't create your login. Please try again."));
              if (data && data.access_token) tokens.set({ access_token: data.access_token, refresh_token: data.refresh_token });
            });
          })
          .then(function () {
            if (tokens.get()) return;
            return passwordGrant(c.email, c.password).catch(function (e) {
              throw ApiError(
                /confirm your email/i.test(e.message)
                  ? "Your login was created. Confirm your email address (check your inbox), then sign in and enter your invite code."
                  : "We couldn't sign you in. If you already have a login, use Sign in and enter your invite code there."
              );
            });
          })
          .then(function () {
            return claimMember(c.email, c.code);
          })
          .then(resolveRole);
      },
      claim: function (c) {
        return claimMember(c.email, c.code).then(resolveRole);
      },
      logout: function () {
        var s = tokens.get();
        tokens.clear();
        churchIdPromise = null;
        if (!s) return Promise.resolve();
        return fetch(SB_URL + "/auth/v1/logout", {
          method: "POST",
          headers: { apikey: sb.anonKey, Authorization: "Bearer " + s.access_token },
        }).then(noop, noop);
      },
    },
    admin: {
      list: function () {
        return sbRequest("/rest/v1/members?select=*&order=created_at.desc", { method: "GET" }, true).then(function (rows) {
          return (rows || []).map(fromRow);
        });
      },
      create: function (m) {
        return adminChurchId().then(function (churchId) {
          var row = toRow({ fullName: m.fullName, email: m.email, phone: m.phone, notes: m.notes, status: "active" });
          row.church_id = churchId;
          row.source = "admin";
          return sbRequest(
            "/rest/v1/members",
            { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) },
            true
          ).then(function (rows) {
            return fromRow(rows[0]);
          });
        });
      },
      update: function (id, patch) {
        return sbRequest(
          "/rest/v1/members?id=eq." + encodeURIComponent(id),
          { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(toRow(patch)) },
          true
        ).then(function (rows) {
          if (!rows || !rows.length) throw ApiError("That member no longer exists.");
          return fromRow(rows[0]);
        });
      },
      remove: function (id) {
        return sbRequest("/rest/v1/members?id=eq." + encodeURIComponent(id), { method: "DELETE" }, true).then(noop);
      },
      invite: function (id) {
        return rpc("create_member_invite", { p_member_id: id }).then(function (code) {
          return { code: code, expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString() };
        });
      },
      notices: {
        list: function () {
          return sbRequest("/rest/v1/notices?select=*&order=created_at.desc", { method: "GET" }, true).then(function (rows) {
            return (rows || []).map(fromNotice);
          });
        },
        create: function (n) {
          return adminChurchId().then(function (churchId) {
            var row = { church_id: churchId, title: n.title, body: n.body, is_published: n.published !== false };
            return sbRequest(
              "/rest/v1/notices",
              { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) },
              true
            ).then(function (rows) {
              return fromNotice(rows[0]);
            });
          });
        },
        update: function (id, n) {
          var row = { title: n.title, body: n.body, is_published: n.published !== false, updated_at: new Date().toISOString() };
          return sbRequest(
            "/rest/v1/notices?id=eq." + encodeURIComponent(id),
            { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) },
            true
          ).then(function (rows) {
            if (!rows || !rows.length) throw ApiError("That notice no longer exists.");
            return fromNotice(rows[0]);
          });
        },
        remove: function (id) {
          return sbRequest("/rest/v1/notices?id=eq." + encodeURIComponent(id), { method: "DELETE" }, true).then(noop);
        },
      },
    },
    member: {
      me: function () {
        return rpc("my_member").then(function (rows) {
          var r = rows && rows[0];
          if (!r) throw ApiError("Please sign in.", { auth: true });
          return {
            id: r.id,
            fullName: r.full_name,
            email: r.email || "",
            phone: r.phone || "",
            status: r.is_active ? "active" : "inactive",
            joinedAt: r.joined_at || null,
          };
        });
      },
      update: function (p) {
        return rpc("update_my_member", { p_full_name: p.fullName, p_phone: p.phone || null }).then(function () {
          return supabaseApi.member.me();
        });
      },
      notices: function () {
        return rpc("my_notices").then(function (rows) {
          return (rows || []).map(function (r) {
            return { id: r.id, title: r.title, body: r.body, createdAt: r.created_at };
          });
        });
      },
    },
  };

  var host = (window.location && window.location.hostname) || "";
  if (!useSupabase && cfg.demo !== true && host && host !== "localhost" && host !== "127.0.0.1") {
    console.info(
      "CBC site: no database is connected. Registration and logins stay switched off until the " +
        "Supabase url, anonKey and churchId are filled in public/site.config.js (see README.md)."
    );
  }

  window.CBC_API = useSupabase ? supabaseApi : localApi;
})();
