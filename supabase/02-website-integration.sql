-- ===================================================================
-- CBC Sandton website: ChurchHub integration (Supabase / Postgres)
--
-- Run this ONCE in the Supabase SQL editor, on the same project that
-- already has ChurchHub's schema.sql applied.
--
-- It is additive. Nothing is dropped, and ChurchHub keeps working as is.
--
-- What it does:
--   1. Adds three optional columns to `members` (notes, source, consent_at).
--   2. Adds a function the public website calls to submit a registration.
--      Anonymous visitors CANNOT read or write the members table directly.
--      They can only call this one function, which validates the input and
--      inserts a PENDING member (is_active = false, source = 'website').
--   3. Leaves the existing row level security untouched, so church staff who
--      sign in to the members area only ever see their own church's members.
-- ===================================================================

-- 1. Extra columns (safe to run more than once)
alter table members add column if not exists notes text;
alter table members add column if not exists source text not null default 'app';
alter table members add column if not exists consent_at timestamptz;

-- 2. Public registration function
create or replace function submit_website_registration(
  p_church_id uuid,
  p_full_name text,
  p_phone text,
  p_email text,
  p_notes text,
  p_consent boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name  text := btrim(coalesce(p_full_name, ''));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  if not coalesce(p_consent, false) then
    raise exception 'Please tick the box to let us store your details.';
  end if;

  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'Please enter your first and last name.';
  end if;

  if v_email is null and v_phone is null then
    raise exception 'Provide an email address or a phone number.';
  end if;

  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$') then
    raise exception 'That email address doesn''t look right.';
  end if;

  if v_phone is not null and v_phone !~ '^[0-9+()\-\s]{7,30}$' then
    raise exception 'That phone number doesn''t look right.';
  end if;

  if v_notes is not null and length(v_notes) > 500 then
    raise exception 'Please keep your note under 500 characters.';
  end if;

  if not exists (select 1 from churches where id = p_church_id) then
    raise exception 'This registration form isn''t set up correctly.';
  end if;

  -- Already registered? Return quietly, so the form can't be used to find out
  -- who is on the list.
  if v_email is not null and exists (
    select 1 from members where church_id = p_church_id and lower(email) = v_email
  ) then
    return;
  end if;

  insert into members (church_id, full_name, phone, email, is_active, source, notes, consent_at)
  values (p_church_id, v_name, v_phone, v_email, false, 'website', v_notes, now());
end;
$$;

-- Only the website (anon) and signed-in users may call it. Nobody else needs to.
revoke all on function submit_website_registration(uuid, text, text, text, text, boolean) from public;
grant execute on function submit_website_registration(uuid, text, text, text, text, boolean) to anon, authenticated;

-- ===================================================================
-- How "pending" works
--   pending  = is_active = false AND source = 'website' AND joined_at is null
--   Approving a registration in the members area sets is_active = true and
--   joined_at = today, so it then shows as a normal active member in ChurchHub.
-- ===================================================================


-- ===================================================================
-- MEMBER LOGINS AND NOTICES
--
-- How a member gets a login:
--   1. A leader opens the leaders area and presses Invite on an approved member.
--      create_member_invite() returns a one-time code (stored only as a hash,
--      valid for 14 days, locked after 5 wrong tries).
--   2. The member opens the Login page, chooses Activate, and enters their
--      email, the code, and a new password. The site creates their Supabase
--      login and calls claim_member() to connect it to their member record.
--   3. A signed-in member can only reach their OWN record (my_member,
--      update_my_member) and the published notices for their church
--      (my_notices). They cannot read other members, because there is no
--      table access for them, only these functions.
--
-- Staff are unaffected: ChurchHub's existing row level security still applies.
-- ===================================================================

alter table members add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table members add column if not exists invite_hash text;
alter table members add column if not exists invite_expires_at timestamptz;
alter table members add column if not exists invite_attempts int not null default 0;
create unique index if not exists members_user_id_key on members(user_id) where user_id is not null;

-- Notices written by leaders and read by members
create table if not exists notices (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  title text not null check (length(title) between 1 and 120),
  body text not null check (length(body) between 1 and 4000),
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table notices enable row level security;

drop policy if exists "notices in church" on notices;
create policy "notices in church" on notices
  for all using (church_id = auth_church_id()) with check (church_id = auth_church_id());

-- Staff only: create a one-time invite code for an approved member
create or replace function create_member_invite(p_member_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid;
  v_email text;
  v_active boolean;
  v_raw text;
begin
  if auth_church_id() is null then
    raise exception 'Only church staff can create invites.';
  end if;

  select church_id, email, is_active into v_church, v_email, v_active
  from members where id = p_member_id;

  if v_church is null or v_church <> auth_church_id() then
    raise exception 'That member was not found.';
  end if;
  if not v_active then
    raise exception 'Approve this person before inviting them.';
  end if;
  if v_email is null then
    raise exception 'Add an email address for this member first.';
  end if;

  v_raw := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));

  update members
  set invite_hash = encode(sha256(convert_to(v_raw, 'UTF8')), 'hex'),
      invite_expires_at = now() + interval '14 days',
      invite_attempts = 0
  where id = p_member_id;

  return substr(v_raw, 1, 4) || '-' || substr(v_raw, 5, 4) || '-' || substr(v_raw, 9, 4);
end;
$$;

-- Signed-in user: connect this login to the member record the code belongs to.
-- Returns false (never an error) for any wrong detail, so nothing is revealed.
create or replace function claim_member(p_church_id uuid, p_email text, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_code  text := upper(regexp_replace(coalesce(p_code, ''), '[^a-zA-Z0-9]', '', 'g'));
  m members%rowtype;
begin
  if auth.uid() is null then
    return false;
  end if;

  select * into m
  from members
  where church_id = p_church_id
    and lower(email) = v_email
    and invite_hash is not null
    and is_active
    and user_id is null
  limit 1;

  if not found then
    return false;
  end if;

  if m.invite_expires_at < now() or m.invite_attempts >= 5 then
    return false;
  end if;

  if m.invite_hash <> encode(sha256(convert_to(v_code, 'UTF8')), 'hex') then
    update members set invite_attempts = invite_attempts + 1 where id = m.id;
    return false;
  end if;

  -- one login per member record
  if exists (select 1 from members where user_id = auth.uid()) then
    return false;
  end if;

  update members
  set user_id = auth.uid(), invite_hash = null, invite_expires_at = null, invite_attempts = 0
  where id = m.id;

  return true;
end;
$$;

-- Signed-in member: read their own record
create or replace function my_member()
returns table (id uuid, church_id uuid, full_name text, phone text, email text, joined_at date, is_active boolean)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.church_id, m.full_name, m.phone, m.email, m.joined_at, m.is_active
  from members m
  where m.user_id = auth.uid();
$$;

-- Signed-in member: update only their own name and phone
create or replace function update_my_member(p_full_name text, p_phone text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name  text := btrim(coalesce(p_full_name, ''));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
begin
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'Please enter your full name.';
  end if;
  if v_phone is not null and v_phone !~ '^[0-9+()\-\s]{7,30}$' then
    raise exception 'That phone number doesn''t look right.';
  end if;

  update members set full_name = v_name, phone = v_phone
  where user_id = auth.uid() and is_active;

  if not found then
    raise exception 'No active member record is linked to this login.';
  end if;
end;
$$;

-- Signed-in member: published notices for their own church
create or replace function my_notices()
returns table (id uuid, title text, body text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select n.id, n.title, n.body, n.created_at
  from notices n
  join members m on m.church_id = n.church_id
  where m.user_id = auth.uid() and m.is_active and n.is_published
  order by n.created_at desc;
$$;

-- Every one of these needs a signed-in user.
revoke all on function create_member_invite(uuid) from public;
revoke all on function claim_member(uuid, text, text) from public;
revoke all on function my_member() from public;
revoke all on function update_my_member(text, text) from public;
revoke all on function my_notices() from public;

grant execute on function create_member_invite(uuid) to authenticated;
grant execute on function claim_member(uuid, text, text) to authenticated;
grant execute on function my_member() to authenticated;
grant execute on function update_my_member(text, text) to authenticated;
grant execute on function my_notices() to authenticated;
