// Data layer for the site. Exposes window.CBC_API.
//
// Two interchangeable back ends behind one interface:
//   "supabase": used when site.config.js has url + anonKey + churchId (the hosted setup,
//                shares data with ChurchHub).
//   "local": the small Express server in server.js (zero setup, used for demos).
//
// Member shape used by the UI:
//   { id, fullName, email, phone, notes, status: "pending"|"active"|"inactive",
//     source, createdAt, joinedAt }

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

  var localApi = {
    mode: "local",
    modeLabel: "Local mode: members are saved on this computer",
    register: function (p) {
      return local("api/register", { method: "POST", body: JSON.stringify(p) }).then(function (d) {
        return d.message;
      });
    },
    admin: {
      needsEmail: false,
      status: function () {
        return local("api/admin/session")
          .then(function () {
            return "signed-in";
          })
          .catch(function (e) {
            if (e.auth) return "signed-out";
            return e.unavailable ? (/set up/.test(e.message) ? "unconfigured" : "unavailable") : "unavailable";
          });
      },
      login: function (c) {
        return local("api/admin/login", { method: "POST", body: JSON.stringify({ password: c.password }) });
      },
      logout: function () {
        return local("api/admin/logout", { method: "POST" }).catch(function () {});
      },
      list: function () {
        return local("api/admin/members").then(function (d) {
          return d.members;
        });
      },
      create: function (m) {
        return local("api/admin/members", { method: "POST", body: JSON.stringify(m) }).then(function (d) {
          return d.member;
        });
      },
      update: function (id, patch) {
        return local("api/admin/members/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(patch) }).then(
          function (d) {
            return d.member;
          }
        );
      },
      remove: function (id) {
        return local("api/admin/members/" + encodeURIComponent(id), { method: "DELETE" }).then(function () {});
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
    admin: {
      needsEmail: true,
      status: function () {
        return Promise.resolve(tokens.get() ? "signed-in" : "signed-out");
      },
      login: function (c) {
        return fetch(SB_URL + "/auth/v1/token?grant_type=password", {
          method: "POST",
          headers: { apikey: sb.anonKey, "Content-Type": "application/json" },
          body: JSON.stringify({ email: c.email, password: c.password }),
        }).then(function (res) {
          return readJson(res).then(function (data) {
            if (!res.ok || !data || !data.access_token) {
              throw ApiError("That email or password isn't right.", { auth: true });
            }
            tokens.set({ access_token: data.access_token, refresh_token: data.refresh_token });
          });
        });
      },
      logout: function () {
        var s = tokens.get();
        tokens.clear();
        churchIdPromise = null;
        if (!s) return Promise.resolve();
        return fetch(SB_URL + "/auth/v1/logout", {
          method: "POST",
          headers: { apikey: sb.anonKey, Authorization: "Bearer " + s.access_token },
        }).catch(function () {});
      },
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
        return sbRequest("/rest/v1/members?id=eq." + encodeURIComponent(id), { method: "DELETE" }, true).then(function () {});
      },
    },
  };

  window.CBC_API = useSupabase ? supabaseApi : localApi;
})();
