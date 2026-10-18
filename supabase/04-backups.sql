-- ===================================================================
-- CBC Sandton: backups (two layers)
--
-- Run once in the Supabase SQL editor, after 03-first-church.sql.
-- It is safe to run again.
--
-- Layer 1, inside the database: every night the members table is copied
--   into members_snapshot and the last 14 days are kept. This undoes
--   "someone deleted or changed the wrong people" in seconds.
-- Layer 2, outside the database: backup_export() lets the weekly GitHub
--   job download everything as one file, which it encrypts before storing.
--   It only answers to a long secret token (see 05-backup-token.sql).
-- ===================================================================

-- ---------- Layer 1: nightly snapshot ----------

create table if not exists members_snapshot (
  id bigint generated always as identity primary key,
  taken_on date not null default current_date,
  church_id uuid not null,
  member jsonb not null
);
create index if not exists members_snapshot_taken_on on members_snapshot (taken_on);

-- No policies: nobody can read it through the website or the API.
alter table members_snapshot enable row level security;
revoke all on members_snapshot from anon, authenticated;

create or replace function snapshot_members(p_keep_days int default 14)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  delete from members_snapshot where taken_on = current_date;
  -- invite_hash is left out on purpose: a backup never needs it
  insert into members_snapshot (church_id, member)
  select church_id, to_jsonb(m) - 'invite_hash' from members m;
  get diagnostics v_count = row_count;
  delete from members_snapshot where taken_on < current_date - p_keep_days;
  return v_count;
end;
$$;
revoke all on function snapshot_members(int) from public, anon, authenticated;

-- Nightly at 23:00 UTC, which is 01:00 in South Africa.
-- If this line errors, open Database > Extensions in Supabase, switch on pg_cron, and run it again.
create extension if not exists pg_cron;
select cron.schedule('members-snapshot', '0 23 * * *', $job$select public.snapshot_members()$job$);

-- To bring back someone removed by mistake, run this with their id and the snapshot day:
--   insert into members
--   select * from jsonb_populate_recordset(null::members,
--     (select jsonb_agg(member) from members_snapshot
--       where taken_on = 'YYYY-MM-DD' and member->>'id' = 'MEMBER-ID'));

-- ---------- Layer 2: export for the weekly offsite backup ----------

create table if not exists backup_settings (
  id int primary key default 1 check (id = 1),
  token_hash text not null
);
alter table backup_settings enable row level security;
revoke all on backup_settings from anon, authenticated;

create or replace function backup_export(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
begin
  select token_hash into v_hash from backup_settings where id = 1;
  if v_hash is null
     or p_token is null
     or length(p_token) < 24
     or encode(digest(p_token, 'sha256'), 'hex') <> v_hash then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'exported_at', now(),
    'churches', coalesce((select jsonb_agg(to_jsonb(c)) from churches c), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(to_jsonb(m) - 'invite_hash') from members m), '[]'::jsonb),
    'visitors', coalesce((select jsonb_agg(to_jsonb(v)) from visitors v), '[]'::jsonb),
    'notices', coalesce((select jsonb_agg(to_jsonb(n)) from notices n), '[]'::jsonb),
    'finance_entries', coalesce((select jsonb_agg(to_jsonb(f)) from finance_entries f), '[]'::jsonb),
    'check_ins', coalesce((select jsonb_agg(to_jsonb(k)) from check_ins k), '[]'::jsonb)
  );
end;
$$;
revoke all on function backup_export(text) from public;
grant execute on function backup_export(text) to anon;
