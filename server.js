// Local server for the CBC Sandton site.
// Serves /public and provides a small JSON-file API (registrations + members area).
// The hosted version (GitHub Pages) uses Supabase instead, see README.md.

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const IS_PROD = process.env.NODE_ENV === "production";
const DATA_FILE = path.join(__dirname, "data", "members.json");
const COOKIE_NAME = "cbc_admin";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
  });
  next();
});

// ---------- storage ----------

function readMembers() {
  try {
    const list = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    // Corrupt file: fail loudly rather than overwrite it with an empty list.
    throw err;
  }
}

function writeMembers(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- helpers ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+()\-\s]{7,30}$/;
const STATUSES = ["pending", "active", "inactive"];

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function newId() {
  return crypto.randomUUID();
}

function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, h] of hits) if (h.reset < now) hits.delete(key);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.reset < now) {
      h = { count: 0, reset: now + windowMs };
      hits.set(req.ip, h);
    }
    h.count += 1;
    if (h.count > max) {
      res.set("Retry-After", String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ ok: false, errors: ["Too many attempts. Please try again later."] });
    }
    next();
  };
}

const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 15 });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8 });

// ---------- public: registration ----------

app.post("/api/register", registerLimiter, (req, res) => {
  const b = req.body || {};

  // Honeypot: real visitors never see or fill this field. Pretend success to bots.
  if (text(b.hp_company)) {
    return res.status(201).json({ ok: true, message: "Thank you! Your details have been received." });
  }

  const firstName = text(b.firstName);
  const lastName = text(b.lastName);
  const email = text(b.email);
  const phone = text(b.phone);
  const notes = text(b.notes);

  const errors = [];
  if (!firstName || firstName.length > 60) errors.push("Please enter your first name.");
  if (!lastName || lastName.length > 60) errors.push("Please enter your last name.");
  if (!email && !phone) errors.push("Provide an email address or a phone number.");
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) errors.push("That email address doesn't look right.");
  if (phone && !PHONE_RE.test(phone)) errors.push("That phone number doesn't look right.");
  if (notes.length > 500) errors.push("Please keep your note under 500 characters.");
  if (b.consent !== true) errors.push("Please tick the box to let us store your details.");
  if (errors.length) return res.status(400).json({ ok: false, errors });

  const message = `Welcome, ${firstName}! We've received your details and someone will be in touch.`;
  const members = readMembers();

  // Already registered? Answer exactly the same, so the form can't be used
  // to find out who is on the list.
  if (email && members.some((m) => m.email && m.email.toLowerCase() === email.toLowerCase())) {
    return res.status(201).json({ ok: true, message });
  }

  const now = new Date().toISOString();
  members.push({
    id: newId(),
    fullName: `${firstName} ${lastName}`,
    email,
    phone,
    notes,
    status: "pending",
    source: "website",
    consentAt: now,
    createdAt: now,
    joinedAt: null,
  });
  writeMembers(members);

  res.status(201).json({ ok: true, message });
});

// ---------- admin: sessions ----------

const sessions = new Map(); // token -> expiry timestamp

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch (_) {
      /* ignore malformed cookie */
    }
  }
  return out;
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function passwordMatches(input) {
  return crypto.timingSafeEqual(digest(input), digest(ADMIN_PASSWORD));
}

function sessionToken(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const expiry = sessions.get(token);
  if (!expiry) return null;
  if (expiry < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return token;
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      ok: false,
      errors: ["Admin sign-in isn't set up. Add ADMIN_PASSWORD to the .env file and restart the server."],
    });
  }
  if (!sessionToken(req)) return res.status(401).json({ ok: false, errors: ["Please sign in."] });
  next();
}

app.post("/api/admin/login", loginLimiter, (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      ok: false,
      errors: ["Admin sign-in isn't set up. Add ADMIN_PASSWORD to the .env file and restart the server."],
    });
  }
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!password || !passwordMatches(password)) {
    return res.status(401).json({ ok: false, errors: ["That password isn't right."] });
  }
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: IS_PROD || req.secure,
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
  res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  const token = sessionToken(req);
  if (token) sessions.delete(token);
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/admin/session", requireAdmin, (req, res) => res.json({ ok: true }));

// ---------- admin: members ----------

app.get("/api/admin/members", requireAdmin, (req, res) => {
  const list = readMembers().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({ ok: true, members: list });
});

function readMemberFields(body, { partial }) {
  const errors = [];
  const out = {};

  if (!partial || "fullName" in body) {
    const fullName = text(body.fullName);
    if (fullName.length < 2 || fullName.length > 120) errors.push("Please enter the member's full name.");
    out.fullName = fullName;
  }
  if (!partial || "email" in body) {
    const email = text(body.email);
    if (email && (email.length > 254 || !EMAIL_RE.test(email))) errors.push("That email address doesn't look right.");
    out.email = email;
  }
  if (!partial || "phone" in body) {
    const phone = text(body.phone);
    if (phone && !PHONE_RE.test(phone)) errors.push("That phone number doesn't look right.");
    out.phone = phone;
  }
  if (!partial || "notes" in body) {
    const notes = text(body.notes);
    if (notes.length > 500) errors.push("Notes must be under 500 characters.");
    out.notes = notes;
  }
  if ("status" in body) {
    if (!STATUSES.includes(body.status)) errors.push("Unknown status.");
    out.status = body.status;
  }
  return { errors, fields: out };
}

app.post("/api/admin/members", requireAdmin, (req, res) => {
  const { errors, fields } = readMemberFields(req.body || {}, { partial: false });
  if (!fields.email && !fields.phone) errors.push("Provide an email address or a phone number.");
  if (errors.length) return res.status(400).json({ ok: false, errors });

  const now = new Date().toISOString();
  const member = {
    id: newId(),
    fullName: fields.fullName,
    email: fields.email,
    phone: fields.phone,
    notes: fields.notes,
    status: "active",
    source: "admin",
    consentAt: null,
    createdAt: now,
    joinedAt: now.slice(0, 10),
  };
  const members = readMembers();
  members.push(member);
  writeMembers(members);
  res.status(201).json({ ok: true, member });
});

app.patch("/api/admin/members/:id", requireAdmin, (req, res) => {
  const members = readMembers();
  const member = members.find((m) => m.id === req.params.id);
  if (!member) return res.status(404).json({ ok: false, errors: ["That member no longer exists."] });

  const { errors, fields } = readMemberFields(req.body || {}, { partial: true });
  if (errors.length) return res.status(400).json({ ok: false, errors });

  Object.assign(member, fields);
  if (!member.email && !member.phone) {
    return res.status(400).json({ ok: false, errors: ["Keep at least an email address or a phone number."] });
  }
  if ((member.status === "active" || member.status === "inactive") && !member.joinedAt) {
    member.joinedAt = new Date().toISOString().slice(0, 10);
  }
  writeMembers(members);
  res.json({ ok: true, member });
});

app.delete("/api/admin/members/:id", requireAdmin, (req, res) => {
  const members = readMembers();
  const next = members.filter((m) => m.id !== req.params.id);
  if (next.length === members.length) {
    return res.status(404).json({ ok: false, errors: ["That member no longer exists."] });
  }
  writeMembers(next);
  res.json({ ok: true });
});

// ---------- static site ----------

app.get("/admin", (req, res) => res.redirect("/admin.html"));
app.use(express.static(path.join(__dirname, "public")));

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed" || err.type === "entity.too.large") {
    return res.status(400).json({ ok: false, errors: ["That request couldn't be read."] });
  }
  console.error(err);
  res.status(500).json({ ok: false, errors: ["Something went wrong on our side. Please try again."] });
});

app.listen(PORT, () => {
  console.log(`Change Bible Church Sandton site running at http://localhost:${PORT}`);
  if (!ADMIN_PASSWORD) {
    console.warn("ADMIN_PASSWORD is not set, so the members area is disabled. Copy .env.example to .env to enable it.");
  } else if (ADMIN_PASSWORD.length < 10) {
    console.warn("ADMIN_PASSWORD is short. Use at least 12 characters.");
  }
});
