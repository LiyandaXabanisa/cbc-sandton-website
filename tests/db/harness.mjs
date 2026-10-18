// Boots a throwaway Postgres (PGlite, runs in Node, nothing to install on a server),
// recreates the small part of Supabase the SQL relies on, then loads the project's SQL files.
// Never touches the real database.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const PRELUDE = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid default auth.uid(), created_at timestamptz default now());
  alter table storage.objects enable row level security;
  grant usage on schema public, auth, storage to anon, authenticated;
  grant all on storage.objects, storage.buckets to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
`;

// pg_cron is a Supabase extension, so the scheduling lines are skipped here.
function loadSql(file) {
  return readFileSync(path.join(root, "supabase", file), "utf8")
    .replace(/create extension if not exists pg_cron;/g, "")
    .replace(/select cron\.schedule\([^;]*;/g, "");
}

export async function boot(files) {
  const db = new PGlite();
  await db.exec(PRELUDE);
  for (const f of files) await db.exec(loadSql(f));
  // the same default access Supabase gives to its two web roles
  await db.exec("grant all on all tables in schema public to anon, authenticated; grant all on all sequences in schema public to anon, authenticated;");
  return db;
}

// Run a function as a signed in person (null = not signed in), then go back to the owner.
export async function as(db, userId, fn) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId || ""]);
  await db.exec(userId ? "set role authenticated" : "set role anon");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}

export async function fails(promise, pattern) {
  try {
    await promise;
  } catch (e) {
    if (pattern && !pattern.test(String(e.message))) throw new Error("Failed with a different message: " + e.message);
    return e.message;
  }
  throw new Error("Expected this to be refused, but it worked.");
}
