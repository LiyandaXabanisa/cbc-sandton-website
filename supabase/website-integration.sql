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
