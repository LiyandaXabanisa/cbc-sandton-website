-- ===================================================================
-- CBC Sandton phase 2, step 1: roles, time limited permissions, audit log
--
-- Run once in the Supabase SQL editor, after 07-sermons.sql.
-- It is safe to run again.
--
-- Everyone who is an active member is a Member. Extra authority is a row in
-- role_grants. A grant can expire (an Item Renderer only works until the end
-- of their service date) and expiry is checked inside has_role() on every
-- call, so access can never stay open because a cleanup job did not run.
--
-- Rules live here, in the database. The pages only hide buttons.
--
-- Hierarchy, highest first:
--   senior_pastor      everything
--   platform_manager   everything except senior pastor only actions
--   media_team         church wide, read and download for upcoming services
--   item_renderer      one program item, always has an expiry
--   ministry_leader    one ministry (also counts as ministry_member)
--   ministry_member    one ministry
-- Existing leaders with a ChurchHub admin profile count as platform managers,
-- so nothing already working stops working.
-- ===================================================================

create table if not exists role_grants (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('senior_pastor', 'platform_manager', 'media_team', 'item_renderer', 'ministry_leader', 'ministry_member')),
  scope_type text check (scope_type in ('ministry', 'oos_item')),
  scope_id uuid,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  granted_by uuid references auth.users(id) on delete set null,
  expiry_logged boolean not null default false,
  check ((scope_type is null) = (scope_id is null)),
  check (expires_at is null or expires_at > granted_at),
  check (
    (role in ('senior_pastor', 'platform_manager', 'media_team') and scope_type is null)
    or (role = 'item_renderer' and scope_type is not distinct from 'oos_item' and expires_at is not null)
    or (role in ('ministry_leader', 'ministry_member') and scope_type is not distinct from 'ministry')
  )
);
create index if not exists role_grants_user on role_grants (user_id) where revoked_at is null;
create index if not exists role_grants_church on role_grants (church_id);

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  church_id uuid not null,
  at timestamptz not null default now(),
  actor_id uuid,
  action text not null,
  target_user uuid,
  role text,
  scope_type text,
  scope_id uuid,
  detail jsonb
);
create index if not exists audit_log_church_at on audit_log (church_id, at desc);

-- The church the signed in person belongs to, whether they are a leader or a member.
create or replace function my_church_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.church_id from profiles p where p.id = auth.uid()),
    (select m.church_id from members m where m.user_id = auth.uid() and m.is_active limit 1)
  );
$$;

-- Does the signed in person hold this role (for this scope), right now?
create or replace function has_role(p_role text, p_scope_type text default null, p_scope_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from role_grants g
      where g.user_id = auth.uid()
        and g.revoked_at is null
        and (g.expires_at is null or g.expires_at > now())
        and (
          (g.role = p_role and g.scope_type is not distinct from p_scope_type and g.scope_id is not distinct from p_scope_id)
          or g.role = 'senior_pastor'
          or (g.role = 'platform_manager' and p_role <> 'senior_pastor')
          or (g.role = 'ministry_leader' and p_role = 'ministry_member'
              and g.scope_type is not distinct from p_scope_type and g.scope_id is not distinct from p_scope_id)
        )
    )
    or (
      p_role <> 'senior_pastor'
      and exists (select 1 from profiles pr where pr.id = auth.uid() and pr.role = 'admin')
    );
$$;

alter table role_grants enable row level security;
alter table audit_log enable row level security;

-- Nobody writes these tables directly. grant_role() and revoke_role() are the only way.
drop policy if exists "see own grants or manage" on role_grants;
create policy "see own grants or manage" on role_grants
  for select using (user_id = auth.uid() or (church_id = my_church_id() and has_role('platform_manager')));

drop policy if exists "managers read the audit log" on audit_log;
create policy "managers read the audit log" on audit_log
  for select using (church_id = my_church_id() and has_role('platform_manager'));

-- Give someone a role. Senior pastor only for the senior pastor role, managers for the rest.
create or replace function grant_role(
  p_user uuid,
  p_role text,
  p_scope_type text default null,
  p_scope_id uuid default null,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := my_church_id();
  v_id uuid;
begin
  if auth.uid() is null or v_church is null then
    raise exception 'Please sign in.';
  end if;

  if p_role = 'senior_pastor' then
    if not has_role('senior_pastor') then
      raise exception 'Only the Senior Pastor can do that.';
    end if;
  elsif not has_role('platform_manager') then
    raise exception 'Only the Senior Pastor or a Platform Manager can do that.';
  end if;

  if not exists (select 1 from members m where m.user_id = p_user and m.church_id = v_church)
     and not exists (select 1 from profiles pr where pr.id = p_user and pr.church_id = v_church) then
    raise exception 'That person is not in this church.';
  end if;

  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'The end date must be in the future.';
  end if;

  -- One active grant per person, role and scope: granting again just updates the end date.
  select g.id into v_id from role_grants g
  where g.user_id = p_user and g.role = p_role and g.church_id = v_church
    and g.scope_type is not distinct from p_scope_type and g.scope_id is not distinct from p_scope_id
    and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())
  limit 1;

  if v_id is not null then
    update role_grants set expires_at = p_expires_at where id = v_id;
  else
    insert into role_grants (church_id, user_id, role, scope_type, scope_id, expires_at, granted_by)
    values (v_church, p_user, p_role, p_scope_type, p_scope_id, p_expires_at, auth.uid())
    returning id into v_id;
  end if;

  insert into audit_log (church_id, actor_id, action, target_user, role, scope_type, scope_id, detail)
  values (v_church, auth.uid(), 'granted', p_user, p_role, p_scope_type, p_scope_id, jsonb_build_object('grant_id', v_id, 'expires_at', p_expires_at));

  return v_id;
end;
$$;

create or replace function revoke_role(p_grant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := my_church_id();
  g role_grants;
begin
  if auth.uid() is null or v_church is null then
    raise exception 'Please sign in.';
  end if;

  select * into g from role_grants where id = p_grant_id and church_id = v_church and revoked_at is null;
  if not found then
    raise exception 'That role was not found.';
  end if;

  if g.role = 'senior_pastor' then
    if not has_role('senior_pastor') then
      raise exception 'Only the Senior Pastor can do that.';
    end if;
  elsif not has_role('platform_manager') then
    raise exception 'Only the Senior Pastor or a Platform Manager can do that.';
  end if;

  update role_grants set revoked_at = now() where id = p_grant_id;

  insert into audit_log (church_id, actor_id, action, target_user, role, scope_type, scope_id, detail)
  values (v_church, auth.uid(), 'revoked', g.user_id, g.role, g.scope_type, g.scope_id, jsonb_build_object('grant_id', g.id));
end;
$$;

-- The signed in person's own current roles (for the pages to decide what to show).
create or replace function my_roles()
returns table (role text, scope_type text, scope_id uuid, expires_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select g.role, g.scope_type, g.scope_id, g.expires_at
  from role_grants g
  where g.user_id = auth.uid() and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())
  union all
  select 'platform_manager', null::text, null::uuid, null::timestamptz
  where exists (select 1 from profiles pr where pr.id = auth.uid() and pr.role = 'admin')
    and not exists (
      select 1 from role_grants g2 where g2.user_id = auth.uid() and g2.role = 'platform_manager'
        and g2.revoked_at is null and (g2.expires_at is null or g2.expires_at > now())
    );
$$;

-- Managers: who holds which role, with names.
create or replace function list_role_grants()
returns table (
  id uuid, user_id uuid, full_name text, role text, scope_type text, scope_id uuid,
  granted_at timestamptz, expires_at timestamptz, revoked_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not has_role('platform_manager') then
    raise exception 'Only the Senior Pastor or a Platform Manager can do that.';
  end if;
  return query
    select g.id, g.user_id,
           coalesce((select m.full_name from members m where m.user_id = g.user_id limit 1),
                    (select pr.full_name from profiles pr where pr.id = g.user_id)),
           g.role, g.scope_type, g.scope_id, g.granted_at, g.expires_at, g.revoked_at
    from role_grants g
    where g.church_id = my_church_id()
    order by g.granted_at desc;
end;
$$;

-- Expired roles are already refused by has_role(). This only writes the audit row, once each.
-- It runs by itself every hour (see the end of the file) and can also be called by hand.
create or replace function expire_grants()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  with done as (
    update role_grants g set expiry_logged = true
    where g.expires_at is not null and g.expires_at <= now() and g.revoked_at is null and not g.expiry_logged
    returning g.church_id, g.user_id, g.role, g.scope_type, g.scope_id, g.id
  )
  insert into audit_log (church_id, actor_id, action, target_user, role, scope_type, scope_id, detail)
  select d.church_id, null, 'expired', d.user_id, d.role, d.scope_type, d.scope_id, jsonb_build_object('grant_id', d.id)
  from done d;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function my_church_id() from public, anon, authenticated;
revoke all on function has_role(text, text, uuid) from public, anon, authenticated;
revoke all on function grant_role(uuid, text, text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function revoke_role(uuid) from public, anon, authenticated;
revoke all on function my_roles() from public, anon, authenticated;
revoke all on function list_role_grants() from public, anon, authenticated;
revoke all on function expire_grants() from public, anon, authenticated;

grant execute on function my_church_id() to authenticated;
grant execute on function has_role(text, text, uuid) to authenticated;
grant execute on function grant_role(uuid, text, text, uuid, timestamptz) to authenticated;
grant execute on function revoke_role(uuid) to authenticated;
grant execute on function my_roles() to authenticated;
grant execute on function list_role_grants() to authenticated;
-- expire_grants() is for the scheduled job only, so no one signed in can call it.

-- Supabase opens every new function in the public schema to signed in and anonymous callers by
-- default. Close that for the functions from earlier steps that only signed in people may call.
do $tighten$
declare
  f text;
begin
  foreach f in array array[
    'my_member()', 'update_my_member(text, text)', 'my_notices()', 'create_member_invite(uuid)',
    'claim_member(uuid, text, text)', 'my_services()', 'my_reminders()', 'my_sermons()'
  ] loop
    if to_regprocedure('public.' || f) is not null then
      execute 'revoke all on function public.' || f || ' from public, anon';
      execute 'grant execute on function public.' || f || ' to authenticated';
    end if;
  end loop;
end
$tighten$;

-- Hourly, on the hour. If this line errors, switch on pg_cron under Database > Extensions and run it again.
create extension if not exists pg_cron;
select cron.schedule('expire-role-grants', '0 * * * *', $job$select public.expire_grants()$job$);
