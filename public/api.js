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
      userId: r.user_id || null,
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

  function fromService(r) {
    return {
      id: r.id,
      title: r.title,
      startsAt: r.starts_at,
      endsAt: r.ends_at || null,
      venue: r.venue || "",
      streamUrl: r.stream_url || "",
      speaker: r.speaker || "",
      theme: r.theme || "",
      scripture: r.scripture || "",
      description: r.description || "",
      published: r.is_published !== false,
    };
  }

  function toServiceRow(s) {
    return {
      title: s.title,
      starts_at: s.startsAt,
      ends_at: s.endsAt || null,
      venue: s.venue || null,
      speaker: s.speaker || null,
      theme: s.theme || null,
      scripture: s.scripture || null,
      description: s.description || null,
      is_published: s.published !== false,
    };
  }

  function fromSermon(r) {
    return {
      id: r.id,
      title: r.title,
      preachedOn: r.preached_on,
      speaker: r.speaker || "",
      scripture: r.scripture || "",
      series: r.series || "",
      topic: r.topic || "",
      notes: r.notes || "",
      description: r.description || "",
      videoUrl: r.video_url || "",
      visibility: r.visibility || "members",
      serviceId: r.service_id || null,
      serviceTitle: r.service_title || "",
      serviceStartsAt: r.service_starts_at || null,
      fileCount: r.file_count || 0,
      published: r.is_published !== false,
    };
  }

  function toSermonRow(s) {
    return {
      title: s.title,
      preached_on: s.preachedOn,
      speaker: s.speaker || null,
      scripture: s.scripture || null,
      series: s.series || null,
      topic: s.topic || null,
      notes: s.notes || null,
      description: s.description || null,
      video_url: s.videoUrl || null,
      visibility: s.visibility || "members",
      service_id: s.serviceId || null,
      is_published: s.published !== false,
    };
  }

  function fromReminder(r) {
    return {
      id: r.id,
      title: r.title,
      body: r.body || "",
      priority: r.priority,
      publishAt: r.publish_at,
      expiresAt: r.expires_at || null,
      published: r.is_published !== false,
    };
  }

  function toReminderRow(r) {
    return {
      title: r.title,
      body: r.body || null,
      priority: r.priority || "normal",
      publish_at: r.publishAt || new Date().toISOString(),
      expires_at: r.expiresAt || null,
      is_published: r.published !== false,
    };
  }

  // The same list / create / update / remove calls for any church table.
  function crud(table, from, toRow) {
    var base = "/rest/v1/" + table;
    return {
      list: function (order) {
        return sbRequest(base + "?select=*&order=" + order, { method: "GET" }, true).then(function (rows) {
          return (rows || []).map(from);
        });
      },
      create: function (item) {
        return adminChurchId().then(function (churchId) {
          var row = toRow(item);
          row.church_id = churchId;
          return sbRequest(base, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) }, true).then(
            function (rows) {
              return from(rows[0]);
            }
          );
        });
      },
      update: function (id, item) {
        var row = toRow(item);
        row.updated_at = new Date().toISOString();
        return sbRequest(
          base + "?id=eq." + encodeURIComponent(id),
          { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) },
          true
        ).then(function (rows) {
          if (!rows || !rows.length) throw ApiError("That item no longer exists.");
          return from(rows[0]);
        });
      },
      remove: function (id) {
        return sbRequest(base + "?id=eq." + encodeURIComponent(id), { method: "DELETE" }, true).then(noop);
      },
    };
  }

  function adminChurchOrMine() {
    return rpc("my_church_id").then(function (id) {
      if (!id) throw ApiError("This login isn't linked to a church.");
      return id;
    });
  }

  var churchIdPromise = null;
  function adminChurchId() {
    // Use the church the signed-in user actually belongs to, not the public config value.
    if (!churchIdPromise) {
      churchIdPromise = rpc("my_church_id").then(function (id) {
        if (!id) throw ApiError("This login isn't linked to a church in ChurchHub.");
        return id;
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
      // Platform Managers and the Senior Pastor may not have a ChurchHub profile, only a role.
      return rpc("my_roles").then(
        function (roles) {
          return (roles || []).some(function (r) { return r.role === "platform_manager" || r.role === "senior_pastor"; });
        },
        function () { return false; }
      ).then(function (isManager) {
        if (isManager) return { role: "admin" };
        return rpc("my_member").then(function (mine) {
          return { role: mine && mine.length ? "member" : "unlinked" };
        });
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

  // ----- sign in with Google / Apple (PKCE: the code only works in the browser that asked for it) -----
  var PKCE_KEY = "cbc_pkce";

  function b64url(buf) {
    var bytes = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function oauthStart(provider) {
    if (!window.crypto || !crypto.subtle) return Promise.reject(ApiError("This browser can't use that sign in. Please use your email and password."));
    var raw = new Uint8Array(48);
    crypto.getRandomValues(raw);
    var verifier = b64url(raw);
    try {
      sessionStorage.setItem(PKCE_KEY, verifier);
    } catch (_) {
      return Promise.reject(ApiError("Please allow this site to store data for the session, or use your email and password."));
    }
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(function (hash) {
      var back = window.location.origin + window.location.pathname;
      window.location.assign(
        SB_URL + "/auth/v1/authorize?provider=" + encodeURIComponent(provider) +
          "&redirect_to=" + encodeURIComponent(back) +
          "&code_challenge=" + b64url(hash) + "&code_challenge_method=s256"
      );
    });
  }

  // Called when the login page loads. Resolves true if a provider sign in was just completed.
  function oauthFinish() {
    var q = new URLSearchParams(window.location.search);
    var h = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    var failed = q.get("error") || h.get("error");
    var code = q.get("code");
    if (!code && !failed) return Promise.resolve(false);
    try {
      window.history.replaceState(null, "", window.location.pathname);
    } catch (_) {}
    var verifier = null;
    try {
      verifier = sessionStorage.getItem(PKCE_KEY);
      sessionStorage.removeItem(PKCE_KEY);
    } catch (_) {}
    if (failed || !verifier) {
      return Promise.reject(ApiError("That sign in didn't finish. Please try again, or use your email and password."));
    }
    return fetch(SB_URL + "/auth/v1/token?grant_type=pkce", {
      method: "POST",
      headers: { apikey: sb.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
    })
      .then(readJson)
      .then(function (data) {
        if (!data || !data.access_token) throw ApiError("That sign in didn't finish. Please try again, or use your email and password.");
        tokens.set({ access_token: data.access_token, refresh_token: data.refresh_token });
        return true;
      });
  }

  var supabaseApi = {
    mode: "supabase",
    modeLabel: "Connected to ChurchHub",
    register: function (p) {
      if (p.hp_company) return Promise.resolve("Thank you. Your details have been received.");
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
          return "Welcome, " + p.firstName + ". We've received your details and someone will be in touch.";
        }
      );
    },
    program: (function () {
      // Raw storage calls for the program-files bucket: same sign in, with one retry if the session just expired.
      function objectUrl(path) {
        return SB_URL + "/storage/v1/object/program-files/" + path.split("/").map(encodeURIComponent).join("/");
      }
      function storage(method, url, extra, canRetry) {
        var s = tokens.get();
        if (!s) return Promise.reject(ApiError("Please sign in.", { auth: true }));
        var headers = Object.assign({ apikey: sb.anonKey, Authorization: "Bearer " + s.access_token }, extra.headers || {});
        return fetch(url, { method: method, headers: headers, body: extra.body }).then(function (res) {
          if (res.status === 401 && canRetry !== false) {
            return sbRefresh().then(function (ok) {
              if (!ok) {
                tokens.clear();
                throw ApiError("Your session has expired. Please sign in again.", { auth: true });
              }
              return storage(method, url, extra, false);
            });
          }
          if (res.ok) return res;
          return readJson(res).then(function (d) {
            throw ApiError(sbMessage(d, "The file couldn't be saved. Please try again."));
          });
        });
      }
      function safeName(name) {
        return String(name || "file").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120) || "file";
      }
      function newId() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return String(Date.now()) + Math.random().toString(16).slice(2);
      }
      function mapProgram(r) {
        if (!r) return null;
        return {
          id: r.id,
          title: r.title,
          startsAt: r.starts_at,
          status: r.status,
          version: r.version,
          items: (r.items || []).map(function (i) {
            return {
              id: i.id,
              position: i.position,
              title: i.title,
              minutes: i.duration_minutes,
              department: i.department || "",
              presenterId: i.presenter_id || null,
              presenterName: i.presenter_name || "",
              notes: i.notes == null ? null : i.notes,
              fileCount: i.file_count || 0,
            };
          }),
        };
      }
      function toItems(list) {
        return (list || []).map(function (i) {
          return {
            id: i.id || null,
            title: i.title,
            duration_minutes: Number(i.minutes) || 5,
            department: i.department || null,
            presenter_id: i.presenterId || null,
            presenter_name: i.presenterId ? null : i.presenterName || null,
            notes: i.notes || null,
          };
        });
      }
      function mapFile(r) {
        return { id: r.id, name: r.file_name, type: r.content_type || "", size: r.size_bytes || 0, path: r.storage_path, mine: !!r.uploaded_by_me };
      }
      return {
        list: function () {
          return rpc("list_programs").then(function (rows) {
            return (rows || []).map(function (r) {
              return { id: r.id, title: r.title, startsAt: r.starts_at, status: r.status, version: r.version, itemCount: r.item_count };
            });
          });
        },
        get: function (id) {
          return rpc("get_program", { p_program: id }).then(mapProgram);
        },
        create: function (o) {
          return rpc("create_program", { p_title: o.title, p_starts_at: o.startsAt, p_service: o.serviceId || null, p_copy_from: o.copyFrom || null });
        },
        save: function (id, o) {
          return rpc("save_program", { p_program: id, p_title: o.title || null, p_starts_at: o.startsAt || null, p_items: toItems(o.items), p_summary: o.summary || null });
        },
        publish: function (id, flag) {
          return rpc("publish_program", { p_program: id, p_publish: !!flag }).then(noop);
        },
        remove: function (id) {
          return rpc("delete_program", { p_program: id }).then(noop);
        },
        history: function (id) {
          return rpc("program_history", { p_program: id }).then(function (rows) {
            return (rows || []).map(function (r) {
              return { id: r.id, version: r.version, at: r.changed_at, by: r.changed_by_name, summary: r.summary || "", snapshot: r.snapshot };
            });
          });
        },
        restore: function (versionId) {
          return rpc("restore_program_version", { p_version: versionId });
        },
        myItems: function () {
          return rpc("my_items").then(function (rows) {
            return (rows || []).map(function (r) {
              return {
                itemId: r.item_id,
                programId: r.program_id,
                programTitle: r.program_title,
                startsAt: r.starts_at,
                title: r.item_title,
                minutes: r.duration_minutes,
                department: r.department || "",
                notes: r.notes || "",
                canUpload: !!r.can_upload,
                expiresAt: r.expires_at || null,
              };
            });
          });
        },
        files: function (itemId) {
          return rpc("item_files_for", { p_item: itemId }).then(function (rows) {
            return (rows || []).map(mapFile);
          });
        },
        upload: function (itemId, file) {
          if (file.size > 25 * 1024 * 1024) return Promise.reject(ApiError("That file is over 25 MB. Please choose a smaller one."));
          return adminChurchOrMine().then(function (churchId) {
            var path = churchId + "/" + itemId + "/" + newId() + "/" + safeName(file.name);
            return storage("POST", objectUrl(path), { headers: { "Content-Type": file.type || "application/octet-stream", "x-upsert": "false" }, body: file }).then(function () {
              var row = { church_id: churchId, item_id: itemId, file_name: String(file.name).slice(0, 200), content_type: file.type || null, size_bytes: Math.max(1, file.size), storage_path: path };
              return sbRequest("/rest/v1/program_item_files", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) }, true).then(
                function (rows) {
                  return mapFile(Object.assign({ uploaded_by_me: true }, rows[0]));
                }
              );
            });
          });
        },
        removeFile: function (f) {
          return storage("DELETE", objectUrl(f.path), {}).then(function () {
            return sbRequest("/rest/v1/program_item_files?id=eq." + encodeURIComponent(f.id), { method: "DELETE" }, true).then(noop);
          });
        },
        fileLink: function (path) {
          return sbRequest(
            "/storage/v1/object/sign/program-files/" + path.split("/").map(encodeURIComponent).join("/"),
            { method: "POST", body: JSON.stringify({ expiresIn: 300 }) },
            true
          ).then(function (d) {
            if (!d || !d.signedURL) throw ApiError("You don't have access to that file.");
            return SB_URL + "/storage/v1" + d.signedURL;
          });
        },
      };
    })(),    roles: {
      mine: function () {
        return rpc("my_roles").then(
          function (rows) { return (rows || []).map(function (r) { return r.role; }); },
          function () { return []; }
        );
      },
      // Everyone's roles in this church (managers only), newest first.
      list: function () {
        return rpc("list_role_grants").then(function (rows) {
          return (rows || []).map(function (r) {
            return {
              id: r.id,
              userId: r.user_id,
              name: r.full_name || "Someone",
              role: r.role,
              scopeType: r.scope_type || null,
              scopeId: r.scope_id || null,
              grantedAt: r.granted_at,
              expiresAt: r.expires_at || null,
              revokedAt: r.revoked_at || null,
            };
          });
        });
      },
      grant: function (userId, role, expiresAt) {
        return rpc("grant_role", { p_user: userId, p_role: role, p_scope_type: null, p_scope_id: null, p_expires_at: expiresAt || null });
      },
      revoke: function (grantId) {
        return rpc("revoke_role", { p_grant_id: grantId }).then(noop);
      },
      audit: function () {
        return sbRequest("/rest/v1/audit_log?select=*&order=at.desc&limit=40", { method: "GET" }, true).then(function (rows) {
          return (rows || []).map(function (r) {
            return { id: r.id, at: r.at, actorId: r.actor_id || null, action: r.action, targetId: r.target_user || null, role: r.role || "", expiresAt: (r.detail && r.detail.expires_at) || null };
          });
        });
      },
    },    notifications: {
      list: function () {
        return rpc("my_notifications").then(
          function (rows) {
            return (rows || []).map(function (r) {
              return { id: r.id, kind: r.kind, title: r.title, body: r.body || "", link: r.link || "", createdAt: r.created_at, read: !!r.read_at };
            });
          },
          function () { return []; }
        );
      },
      markRead: function () {
        return rpc("mark_notifications_read", { p_ids: null }).then(noop, noop);
      },
    },    auth: {
      emailOptional: false,
      providers: (sb.providers || []).filter(function (p) {
        return p === "google" || p === "apple";
      }),
      oauthStart: oauthStart,
      oauthFinish: oauthFinish,
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
      services: (function () {
        var c = crud("services", fromService, toServiceRow);
        return {
          list: function () {
            return c.list("starts_at.desc");
          },
          create: c.create,
          update: c.update,
          remove: c.remove,
        };
      })(),
      sermons: (function () {
        var c = crud("sermons", fromSermon, toSermonRow);

        function safeName(name) {
          return String(name || "file").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120) || "file";
        }
        function newId() {
          if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
          return String(Date.now()) + Math.random().toString(16).slice(2);
        }
        function objectUrl(path) {
          return SB_URL + "/storage/v1/object/sermon-files/" + path.split("/").map(encodeURIComponent).join("/");
        }
        // Raw storage calls: same sign in, with one retry if the session just expired.
        function storage(method, url, extra, canRetry) {
          var s = tokens.get();
          if (!s) return Promise.reject(ApiError("Please sign in.", { auth: true }));
          var headers = Object.assign({ apikey: sb.anonKey, Authorization: "Bearer " + s.access_token }, extra.headers || {});
          return fetch(url, { method: method, headers: headers, body: extra.body }).then(function (res) {
            if (res.status === 401 && canRetry !== false) {
              return sbRefresh().then(function (ok) {
                if (!ok) {
                  tokens.clear();
                  throw ApiError("Your session has expired. Please sign in again.", { auth: true });
                }
                return storage(method, url, extra, false);
              });
            }
            if (res.ok) return res;
            return readJson(res).then(function (d) {
              throw ApiError(sbMessage(d, "The file couldn't be saved. Please try again."));
            });
          });
        }

        return {
          list: function () {
            return c.list("preached_on.desc");
          },
          create: c.create,
          update: c.update,
          remove: c.remove,
          files: function (sermonId) {
            return sbRequest(
              "/rest/v1/sermon_files?sermon_id=eq." + encodeURIComponent(sermonId) + "&select=*&order=created_at",
              { method: "GET" },
              true
            ).then(function (rows) {
              return (rows || []).map(function (r) {
                return { id: r.id, name: r.file_name, type: r.content_type || "", size: r.size_bytes || 0, path: r.storage_path };
              });
            });
          },
          upload: function (sermonId, file) {
            if (file.size > 25 * 1024 * 1024) return Promise.reject(ApiError("That file is over 25 MB. Please choose a smaller one."));
            return adminChurchId().then(function (churchId) {
              var path = churchId + "/" + newId() + "/" + safeName(file.name);
              return storage("POST", objectUrl(path), {
                headers: { "Content-Type": file.type || "application/octet-stream", "x-upsert": "false" },
                body: file,
              }).then(function () {
                var row = {
                  church_id: churchId,
                  sermon_id: sermonId,
                  file_name: String(file.name).slice(0, 200),
                  content_type: file.type || null,
                  size_bytes: Math.max(1, file.size),
                  storage_path: path,
                };
                return sbRequest("/rest/v1/sermon_files", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) }, true).then(
                  function (rows) {
                    var r = rows[0];
                    return { id: r.id, name: r.file_name, type: r.content_type || "", size: r.size_bytes || 0, path: r.storage_path };
                  }
                );
              });
            });
          },
          removeFile: function (f) {
            return storage("DELETE", objectUrl(f.path), {}).then(function () {
              return sbRequest("/rest/v1/sermon_files?id=eq." + encodeURIComponent(f.id), { method: "DELETE" }, true).then(noop);
            });
          },
        };
      })(),
      reminders: (function () {
        var c = crud("reminders", fromReminder, toReminderRow);
        return {
          list: function () {
            return c.list("publish_at.desc");
          },
          create: c.create,
          update: c.update,
          remove: c.remove,
        };
      })(),
    },
    member: {
      services: function () {
        return rpc("my_services").then(function (rows) {
          return (rows || []).map(function (r) {
            return fromService(Object.assign({ is_published: true }, r));
          });
        });
      },
      sermons: function (opts) {
        opts = opts || {};
        return rpc("search_sermons", { p_query: opts.query || null, p_series: opts.series || null, p_from: opts.from || null, p_to: opts.to || null }).then(
          function (rows) {
            return (rows || []).map(fromSermon);
          }
        );
      },
      sermonSeries: function () {
        return rpc("sermon_series").then(function (rows) {
          return (rows || []).map(function (r) { return r.series; });
        });
      },
      sermonFiles: function (sermonId) {
        return rpc("sermon_files_for", { p_sermon: sermonId }).then(function (rows) {
          return (rows || []).map(function (r) {
            return { id: r.id, name: r.file_name, type: r.content_type || "", size: r.size_bytes || 0, path: r.storage_path };
          });
        });
      },
      // A link that works for five minutes, issued only if the database lets this person read the file.
      fileLink: function (path) {
        return sbRequest(
          "/storage/v1/object/sign/sermon-files/" + path.split("/").map(encodeURIComponent).join("/"),
          { method: "POST", body: JSON.stringify({ expiresIn: 300 }) },
          true
        ).then(function (d) {
          if (!d || !d.signedURL) throw ApiError("You don't have access to that file.");
          return SB_URL + "/storage/v1" + d.signedURL;
        });
      },
      reminders: function () {
        return rpc("my_reminders").then(function (rows) {
          return (rows || []).map(function (r) {
            return fromReminder(Object.assign({ is_published: true }, r));
          });
        });
      },
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

  window.CBC_API = useSupabase ? supabaseApi : localApi;
})();
