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
const NOTICES_FILE = path.join(__dirname, "data", "notices.json");
const COOKIE_NAME = "cbc_session";
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

function readJson(file) {
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    // Corrupt file: fail loudly rather than overwrite it with an empty list.
    throw err;
  }
}

function writeJson(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

const readMembers = () => readJson(DATA_FILE);
const writeMembers = (list) => writeJson(DATA_FILE, list);
const readNotices = () => readJson(NOTICES_FILE);
const writeNotices = (list) => writeJson(NOTICES_FILE, list);

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

// ---------- sessions and passwords ----------

const sessions = new Map(); // token -> { role: "admin" | "member", memberId, exp }
const activateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

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

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString("hex")}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function checkPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || "").split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Compared against when an email is unknown, so unknown and known emails take the same time.
const DUMMY_HASH = hashPassword("not-a-real-password");

function normaliseCode(code) {
  return String(code || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function hashCode(code) {
  return digest(normaliseCode(code)).toString("hex");
}

function codesMatch(code, storedHash) {
  const a = Buffer.from(hashCode(code), "hex");
  const b = Buffer.from(String(storedHash || ""), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function startSession(req, res, data) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { ...data, exp: Date.now() + SESSION_TTL_MS });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: IS_PROD || req.secure,
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

function getSession(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { ...s, token };
}

const ADMIN_NOT_SET_UP = "Admin sign-in isn't set up. Add ADMIN_PASSWORD to the .env file and restart the server.";

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).json({ ok: false, errors: [ADMIN_NOT_SET_UP] });
  const s = getSession(req);
  if (!s || s.role !== "admin") return res.status(401).json({ ok: false, errors: ["Please sign in."] });
  next();
}

function requireMember(req, res, next) {
  const s = getSession(req);
  if (!s || s.role !== "member") return res.status(401).json({ ok: false, errors: ["Please sign in."] });
  const member = readMembers().find((m) => m.id === s.memberId);
  // Deleted or deactivated members lose access straight away.
  if (!member || member.status !== "active") {
    sessions.delete(s.token);
    return res.status(401).json({ ok: false, errors: ["Please sign in."] });
  }
  req.member = member;
  next();
}

// Never send password or invite hashes to the browser.
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

// One login for everyone. Members use email + password. Leaving the email empty
// signs in a leader with ADMIN_PASSWORD (local demo mode only; the hosted site
// uses ChurchHub logins instead).
app.post("/api/login", loginLimiter, (req, res) => {
  const email = text(req.body?.email).toLowerCase();
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!email) {
    if (!ADMIN_PASSWORD) return res.status(503).json({ ok: false, errors: [ADMIN_NOT_SET_UP] });
    if (!password || !passwordMatches(password)) {
      return res.status(401).json({ ok: false, errors: ["That password isn't right."] });
    }
    startSession(req, res, { role: "admin" });
    return res.json({ ok: true, role: "admin" });
  }

  const member = readMembers().find((m) => m.email && m.email.toLowerCase() === email && m.passwordHash);
  const valid = checkPassword(password, member ? member.passwordHash : DUMMY_HASH) && !!member;
  if (!valid) return res.status(401).json({ ok: false, errors: ["That email or password isn't right."] });
  if (member.status !== "active") {
    return res.status(403).json({ ok: false, errors: ["Your membership isn't active. Please contact the church office."] });
  }
  startSession(req, res, { role: "member", memberId: member.id });
  res.json({ ok: true, role: "member" });
});

app.post("/api/logout", (req, res) => {
  const s = getSession(req);
  if (s) sessions.delete(s.token);
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ ok: false, errors: ["Please sign in."] });
  res.json({ ok: true, role: s.role });
});

// ---------- member accounts ----------

app.post("/api/member/activate", activateLimiter, (req, res) => {
  const email = text(req.body?.email).toLowerCase();
  const code = text(req.body?.code);
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const BAD_CODE = "That code isn't right or has expired. Ask your leader for a new one.";

  if (password.length < 8 || password.length > 200) {
    return res.status(400).json({ ok: false, errors: ["Choose a password of at least 8 characters."] });
  }

  const members = readMembers();
  const member = members.find((m) => m.email && m.email.toLowerCase() === email && m.inviteHash);
  if (!member || member.status !== "active") return res.status(400).json({ ok: false, errors: [BAD_CODE] });
  if (new Date(member.inviteExpires).getTime() < Date.now() || (member.inviteAttempts || 0) >= 5) {
    return res.status(400).json({ ok: false, errors: [BAD_CODE] });
  }
  if (!codesMatch(code, member.inviteHash)) {
    member.inviteAttempts = (member.inviteAttempts || 0) + 1;
    writeMembers(members);
    return res.status(400).json({ ok: false, errors: [BAD_CODE] });
  }

  member.passwordHash = hashPassword(password);
  delete member.inviteHash;
  delete member.inviteExpires;
  delete member.inviteAttempts;
  writeMembers(members);
  startSession(req, res, { role: "member", memberId: member.id });
  res.json({ ok: true, role: "member" });
});

app.get("/api/member/me", requireMember, (req, res) => res.json({ ok: true, member: selfMember(req.member) }));

app.patch("/api/member/me", requireMember, (req, res) => {
  const fullName = text(req.body?.fullName);
  const phone = text(req.body?.phone);
  const errors = [];
  if (fullName.length < 2 || fullName.length > 120) errors.push("Please enter your full name.");
  if (phone && !PHONE_RE.test(phone)) errors.push("That phone number doesn't look right.");
  if (errors.length) return res.status(400).json({ ok: false, errors });

  const members = readMembers();
  const member = members.find((m) => m.id === req.member.id);
  member.fullName = fullName;
  member.phone = phone;
  writeMembers(members);
  res.json({ ok: true, member: selfMember(member) });
});

app.get("/api/member/notices", requireMember, (req, res) => {
  const list = readNotices()
    .filter((n) => n.published)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({ ok: true, notices: list });
});

// ---------- admin: members ----------

app.get("/api/admin/members", requireAdmin, (req, res) => {
  const list = readMembers()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(publicMember);
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
  res.status(201).json({ ok: true, member: publicMember(member) });
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
  res.json({ ok: true, member: publicMember(member) });
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

// One-time code a leader hands to a member so they can create their login.
app.post("/api/admin/members/:id/invite", requireAdmin, (req, res) => {
  const members = readMembers();
  const member = members.find((m) => m.id === req.params.id);
  if (!member) return res.status(404).json({ ok: false, errors: ["That member no longer exists."] });
  if (member.status !== "active") {
    return res.status(400).json({ ok: false, errors: ["Approve this person before inviting them to the member area."] });
  }
  if (!member.email) {
    return res.status(400).json({ ok: false, errors: ["Add an email address for this member first."] });
  }

  const raw = crypto.randomBytes(6).toString("hex").toUpperCase();
  const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  member.inviteHash = hashCode(code);
  member.inviteExpires = expiresAt;
  member.inviteAttempts = 0;
  writeMembers(members);
  res.json({ ok: true, code, expiresAt });
});

// ---------- admin: notices ----------

function readNoticeFields(body) {
  const title = text(body.title);
  const noticeBody = text(body.body);
  const errors = [];
  if (!title || title.length > 120) errors.push("Give the notice a title of up to 120 characters.");
  if (!noticeBody || noticeBody.length > 4000) errors.push("Write the notice text (up to 4000 characters).");
  return { errors, fields: { title, body: noticeBody, published: body.published !== false } };
}

app.get("/api/admin/notices", requireAdmin, (req, res) => {
  const list = readNotices().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({ ok: true, notices: list });
});

app.post("/api/admin/notices", requireAdmin, (req, res) => {
  const { errors, fields } = readNoticeFields(req.body || {});
  if (errors.length) return res.status(400).json({ ok: false, errors });
  const now = new Date().toISOString();
  const notice = { id: newId(), ...fields, createdAt: now, updatedAt: now };
  const list = readNotices();
  list.push(notice);
  writeNotices(list);
  res.status(201).json({ ok: true, notice });
});

app.patch("/api/admin/notices/:id", requireAdmin, (req, res) => {
  const list = readNotices();
  const notice = list.find((n) => n.id === req.params.id);
  if (!notice) return res.status(404).json({ ok: false, errors: ["That notice no longer exists."] });
  const { errors, fields } = readNoticeFields({ ...notice, ...(req.body || {}) });
  if (errors.length) return res.status(400).json({ ok: false, errors });
  Object.assign(notice, fields, { updatedAt: new Date().toISOString() });
  writeNotices(list);
  res.json({ ok: true, notice });
});

app.delete("/api/admin/notices/:id", requireAdmin, (req, res) => {
  const list = readNotices();
  const next = list.filter((n) => n.id !== req.params.id);
  if (next.length === list.length) return res.status(404).json({ ok: false, errors: ["That notice no longer exists."] });
  writeNotices(next);
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
