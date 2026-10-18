-- ===================================================================
-- CBC Sandton phase 2, step 3: the Weekly Program (the digital Order of Service)
--
-- Run once in the Supabase SQL editor, after 10-first-roles.sql.
-- It is safe to run again.
--
-- A program is one service planned as time slotted items: what happens, for how
-- long, which department, who presents. Managers build it. Every save is a numbered
-- version that can be compared and restored. Naming a presenter gives that person
-- the Item Renderer role for that one item, which ends by itself at the end of the
-- service day. Changes tell the media team, the managers and the presenters affected.
--
-- Who sees what:
--   managers          everything, including drafts and history
--   media team        every published program, with internal notes and all item files
--   active members    published programs without internal notes
--   a presenter       their own item's notes and files, and upload rights until the service day ends
-- ===================================================================

create table if not exists programs (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  service_id uuid references services(id) on delete set null,
  title text not null check (length(title) between 1 and 120),
  starts_at timestamptz not null,
  status text not null default 'draft' check (status in ('draft', 'published')),
  version int not null default 0,
  published_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists programs_church_start on programs (church_id, starts_at desc);

create table if not exists program_items (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references programs(id) on delete cascade,
  church_id uuid not null references churches(id) on delete cascade,
  position int not null,
  title text not null check (length(title) between 1 and 120),
  duration_minutes int not null default 5 check (duration_minutes between 1 and 600),
  department text check (department is null or length(department) <= 80),
  presenter_id uuid references auth.users(id) on delete set null,
  presenter_name text check (presenter_name is null or length(presenter_name) <= 120),
  notes text check (notes is null or length(notes) <= 4000),
  created_at timestamptz not null default now()
);
create index if not exists program_items_program on program_items (program_id, position);
create index if not exists program_items_presenter on program_items (presenter_id);

create table if not exists program_versions (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references programs(id) on delete cascade,
  church_id uuid not null references churches(id) on delete cascade,
  version int not null,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now(),
  summary text,
  snapshot jsonb not null,
  unique (program_id, version)
);

create table if not exists program_item_files (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  item_id uuid not null references program_items(id) on delete cascade,
  file_name text not null check (length(file_name) between 1 and 200),
  content_type text,
  size_bytes bigint check (size_bytes between 1 and 26214400),
  storage_path text not null unique,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists program_item_files_item on program_item_files (item_id);

alter table programs enable row level security;
alter table program_items enable row level security;
alter table program_versions enable row level security;
alter table program_item_files enable row level security;

-- ---------- who can read what ----------

create or replace function can_read_program(p_program uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from programs p
    where p.id = p_program
      and p.church_id = my_church_id()
      and (
        has_role('platform_manager')
        or (
          p.status = 'published'
          and (
            has_role('media_team')
            or exists (select 1 from members m where m.user_id = auth.uid() and m.church_id = p.church_id and m.is_active)
          )
        )
      )
  );
$$;

-- Notes and files of one item: managers, the media team, and the person presenting it.
create or replace function can_read_item_details(p_item uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from program_items i
    join programs p on p.id = i.program_id
    where i.id = p_item
      and p.church_id = my_church_id()
      and (
        has_role('platform_manager')
        or (p.status = 'published' and has_role('media_team'))
        or (p.status = 'published' and has_role('item_renderer', 'oos_item', i.id))
      )
  );
$$;

-- The church an item belongs to, readable by the upload rules below without opening the item table.
create or replace function item_church(p_item uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select i.church_id from program_items i where i.id = p_item;
$$;

-- Direct table access is for managers only. Everyone else goes through the functions below.
drop policy if exists "managers manage programs" on programs;
create policy "managers manage programs" on programs for all
  using (church_id = my_church_id() and has_role('platform_manager'))
  with check (church_id = my_church_id() and has_role('platform_manager'));

drop policy if exists "managers manage items" on program_items;
create policy "managers manage items" on program_items for all
  using (church_id = my_church_id() and has_role('platform_manager'))
  with check (church_id = my_church_id() and has_role('platform_manager'));

drop policy if exists "managers read versions" on program_versions;
create policy "managers read versions" on program_versions for select
  using (church_id = my_church_id() and has_role('platform_manager'));

drop policy if exists "read item files you may read" on program_item_files;
create policy "read item files you may read" on program_item_files for select
  using (can_read_item_details(item_id));

-- A presenter can add a file to their own item only while the Item Renderer role is active.
drop policy if exists "presenters add files" on program_item_files;
create policy "presenters add files" on program_item_files for insert
  with check (
    church_id = my_church_id()
    and uploaded_by = auth.uid()
    and has_role('item_renderer', 'oos_item', item_id)
    and item_church(item_id) = church_id
  );

drop policy if exists "remove item files" on program_item_files;
create policy "remove item files" on program_item_files for delete
  using (
    church_id = my_church_id()
    and (has_role('platform_manager') or (uploaded_by = auth.uid() and has_role('item_renderer', 'oos_item', item_id)))
  );

-- ---------- the file bucket ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'program-files', 'program-files', false, 26214400,
  array[
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png', 'image/jpeg', 'image/webp'
  ]
)
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Paths look like  church-id / item-id / random / file-name
create or replace function storage_item_id(p_name text)
returns uuid
language sql
immutable
as $$
  select case when split_part(p_name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name, '/', 2)::uuid end;
$$;

drop policy if exists "program files readable" on storage.objects;
create policy "program files readable" on storage.objects for select to authenticated
  using (
    bucket_id = 'program-files'
    and name like my_church_id()::text || '/%'
    and (
      has_role('platform_manager')
      or can_read_item_details(storage_item_id(name))
      or has_role('item_renderer', 'oos_item', storage_item_id(name))
    )
  );

drop policy if exists "presenters upload program files" on storage.objects;
create policy "presenters upload program files" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'program-files'
    and name like my_church_id()::text || '/%'
    and storage_item_id(name) is not null
    and has_role('item_renderer', 'oos_item', storage_item_id(name))
  );

drop policy if exists "remove program files" on storage.objects;
create policy "remove program files" on storage.objects for delete to authenticated
  using (
    bucket_id = 'program-files'
    and name like my_church_id()::text || '/%'
    and has_role('item_renderer', 'oos_item', storage_item_id(name))
  );

-- ---------- internal helpers (nobody signed in can call these) ----------

create or replace function program_audience(p_church uuid)
returns table (uid uuid)
language sql
stable
security definer
set search_path = public
as $$
  select g.user_id from role_grants g
  where g.church_id = p_church and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())
    and g.role in ('media_team', 'platform_manager', 'senior_pastor')
  union
  select p.id from profiles p where p.church_id = p_church and p.role = 'admin';
$$;

create or replace function service_day_end(p_start timestamptz)
returns timestamptz
language sql
immutable
as $$
  select (((p_start at time zone 'Africa/Johannesburg')::date + 1)::timestamp at time zone 'Africa/Johannesburg') - interval '1 second';
$$;

-- Make the Item Renderer roles match the presenters on a program.
create or replace function sync_item_grants(p_program uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  prog programs;
  v_end timestamptz;
begin
  select * into prog from programs where id = p_program;
  if not found then return; end if;
  v_end := service_day_end(prog.starts_at);

  -- remove roles for people who no longer present that item
  with gone as (
    update role_grants g set revoked_at = now()
    where g.role = 'item_renderer' and g.scope_type = 'oos_item' and g.revoked_at is null
      and g.scope_id in (select i.id from program_items i where i.program_id = p_program)
      and not exists (select 1 from program_items i where i.id = g.scope_id and i.presenter_id = g.user_id)
    returning g.church_id, g.user_id, g.scope_id, g.id
  )
  insert into audit_log (church_id, actor_id, action, target_user, role, scope_type, scope_id, detail)
  select church_id, auth.uid(), 'revoked', user_id, 'item_renderer', 'oos_item', scope_id, jsonb_build_object('grant_id', id) from gone;

  if v_end <= now() then return; end if;

  -- keep the end date right when the service date moves
  update role_grants g set expires_at = v_end
  where g.role = 'item_renderer' and g.scope_type = 'oos_item' and g.revoked_at is null
    and g.scope_id in (select i.id from program_items i where i.program_id = p_program)
    and g.expires_at is distinct from v_end and v_end > g.granted_at;

  -- give the role to new presenters
  with made as (
    insert into role_grants (church_id, user_id, role, scope_type, scope_id, expires_at, granted_by)
    select i.church_id, i.presenter_id, 'item_renderer', 'oos_item', i.id, v_end, auth.uid()
    from program_items i
    where i.program_id = p_program and i.presenter_id is not null
      and not exists (
        select 1 from role_grants g
        where g.user_id = i.presenter_id and g.role = 'item_renderer' and g.scope_id = i.id
          and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())
      )
    returning church_id, user_id, scope_id, id
  )
  insert into audit_log (church_id, actor_id, action, target_user, role, scope_type, scope_id, detail)
  select church_id, auth.uid(), 'granted', user_id, 'item_renderer', 'oos_item', scope_id,
         jsonb_build_object('grant_id', id, 'expires_at', v_end)
  from made;
end;
$$;

create or replace function snapshot_program(p_program uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'title', p.title,
    'starts_at', p.starts_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'position', i.position, 'title', i.title, 'duration_minutes', i.duration_minutes,
        'department', i.department, 'presenter_id', i.presenter_id, 'presenter_name', i.presenter_name, 'notes', i.notes
      ) order by i.position)
      from program_items i where i.program_id = p.id
    ), '[]'::jsonb)
  )
  from programs p where p.id = p_program;
$$;

create or replace function notify_program(p_program uuid, p_title text, p_body text, p_extra uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  prog programs;
begin
  select * into prog from programs where id = p_program;
  if not found then return; end if;
  insert into notifications (church_id, user_id, kind, title, body, link)
  select distinct prog.church_id, r.uid, 'program', p_title, p_body, 'program'
  from (
    select a.uid from program_audience(prog.church_id) a
    union
    select unnest(coalesce(p_extra, '{}'::uuid[]))
  ) r
  where r.uid is not null and r.uid is distinct from auth.uid();
end;
$$;

create or replace function require_manager()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_church uuid := my_church_id();
begin
  if auth.uid() is null or v_church is null then
    raise exception 'Please sign in.';
  end if;
  if not has_role('platform_manager') then
    raise exception 'Only the Senior Pastor or a Platform Manager can do that.';
  end if;
  return v_church;
end;
$$;

-- ---------- managers: build the program ----------

create or replace function create_program(p_title text, p_starts_at timestamptz, p_service uuid default null, p_copy_from uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := require_manager();
  v_id uuid;
  v_title text := btrim(coalesce(p_title, ''));
begin
  if length(v_title) < 1 or length(v_title) > 120 then
    raise exception 'Give the program a title.';
  end if;
  if p_starts_at is null then
    raise exception 'Choose when the service starts.';
  end if;
  if p_service is not null and not exists (select 1 from services s where s.id = p_service and s.church_id = v_church) then
    raise exception 'That service was not found.';
  end if;

  insert into programs (church_id, service_id, title, starts_at, created_by)
  values (v_church, p_service, v_title, p_starts_at, auth.uid())
  returning id into v_id;

  -- start from an earlier program: the same order and times, without presenters
  if p_copy_from is not null then
    insert into program_items (program_id, church_id, position, title, duration_minutes, department, presenter_name, notes)
    select v_id, v_church, i.position, i.title, i.duration_minutes, i.department, null, i.notes
    from program_items i join programs p on p.id = i.program_id
    where i.program_id = p_copy_from and p.church_id = v_church;
  end if;

  update programs set version = 1 where id = v_id;
  insert into program_versions (program_id, church_id, version, changed_by, summary, snapshot)
  values (v_id, v_church, 1, auth.uid(), case when p_copy_from is null then 'Program created' else 'Copied from an earlier program' end, snapshot_program(v_id));
  return v_id;
end;
$$;

create or replace function save_program(p_program uuid, p_title text, p_starts_at timestamptz, p_items jsonb, p_summary text default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := require_manager();
  prog programs;
  elem jsonb;
  n int := 0;
  v_id uuid;
  v_ids uuid[] := '{}';
  v_title text;
  v_dur int;
  v_pres uuid;
  v_old jsonb;
  v_new jsonb;
  v_ver int;
  v_affected uuid[];
  v_summary text := nullif(btrim(coalesce(p_summary, '')), '');
begin
  select * into prog from programs where id = p_program and church_id = v_church for update;
  if not found then
    raise exception 'That program was not found.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'The items must be a list.';
  end if;
  if jsonb_array_length(p_items) > 60 then
    raise exception 'A program can have at most 60 items.';
  end if;

  v_old := snapshot_program(p_program);

  if p_title is not null and length(btrim(p_title)) between 1 and 120 then
    prog.title := btrim(p_title);
  end if;
  if p_starts_at is not null then
    prog.starts_at := p_starts_at;
  end if;

  for elem in select * from jsonb_array_elements(p_items) loop
    n := n + 1;
    v_title := btrim(coalesce(elem->>'title', ''));
    if length(v_title) < 1 or length(v_title) > 120 then
      raise exception 'Item % needs a title.', n;
    end if;
    v_dur := coalesce(nullif(elem->>'duration_minutes', '')::int, 5);
    if v_dur < 1 or v_dur > 600 then
      raise exception 'Item % needs a length between 1 and 600 minutes.', n;
    end if;
    v_pres := nullif(elem->>'presenter_id', '')::uuid;
    if v_pres is not null and not exists (
      select 1 from members m where m.user_id = v_pres and m.church_id = v_church and m.is_active
    ) then
      raise exception 'The presenter for item % must be an active member with a login.', n;
    end if;

    v_id := nullif(elem->>'id', '')::uuid;
    if v_id is not null and exists (select 1 from program_items i where i.id = v_id and i.program_id = p_program) then
      update program_items set
        position = n, title = v_title, duration_minutes = v_dur,
        department = nullif(btrim(coalesce(elem->>'department', '')), ''),
        presenter_id = v_pres,
        presenter_name = nullif(btrim(coalesce(elem->>'presenter_name', '')), ''),
        notes = nullif(btrim(coalesce(elem->>'notes', '')), '')
      where id = v_id;
    else
      insert into program_items (program_id, church_id, position, title, duration_minutes, department, presenter_id, presenter_name, notes)
      values (p_program, v_church, n, v_title, v_dur,
              nullif(btrim(coalesce(elem->>'department', '')), ''), v_pres,
              nullif(btrim(coalesce(elem->>'presenter_name', '')), ''),
              nullif(btrim(coalesce(elem->>'notes', '')), ''))
      returning id into v_id;
    end if;
    v_ids := v_ids || v_id;
  end loop;

  -- items taken out of the program lose their presenter's access
  with gone as (
    update role_grants g set revoked_at = now()
    where g.role = 'item_renderer' and g.scope_type = 'oos_item' and g.revoked_at is null
      and g.scope_id in (select i.id from program_items i where i.program_id = p_program and not (i.id = any(v_ids)))
    returning g.church_id, g.user_id, g.scope_id, g.id
  )
  insert into audit_log (church_id, actor_id, action, target_user, role, scope_type, scope_id, detail)
  select church_id, auth.uid(), 'revoked', user_id, 'item_renderer', 'oos_item', scope_id, jsonb_build_object('grant_id', id) from gone;
  delete from program_items where program_id = p_program and not (id = any(v_ids));

  update programs set title = prog.title, starts_at = prog.starts_at, version = version + 1, updated_at = now()
  where id = p_program returning version into v_ver;

  perform sync_item_grants(p_program);

  v_new := snapshot_program(p_program);
  insert into program_versions (program_id, church_id, version, changed_by, summary, snapshot)
  values (p_program, v_church, v_ver, auth.uid(), coalesce(v_summary, 'Program saved'), v_new);

  -- tell the people affected, but only for a program that members can already see
  if prog.status = 'published' then
    select coalesce(array_agg(distinct x.pid), '{}') into v_affected from (
      select (e->>'presenter_id')::uuid as pid from jsonb_array_elements(v_new->'items') e
        where nullif(e->>'presenter_id', '') is not null
          and (v_old->'items' is distinct from v_new->'items' or v_old->>'starts_at' is distinct from v_new->>'starts_at')
      union
      select (e->>'presenter_id')::uuid from jsonb_array_elements(v_old->'items') e where nullif(e->>'presenter_id', '') is not null
    ) x where x.pid is not null;
    if v_old is distinct from v_new then
      perform notify_program(p_program, 'Program updated: ' || prog.title,
        coalesce(v_summary, 'The order of service changed.'), v_affected);
    end if;
  end if;

  return v_ver;
end;
$$;

create or replace function publish_program(p_program uuid, p_publish boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := require_manager();
  prog programs;
  v_pres uuid[];
begin
  select * into prog from programs where id = p_program and church_id = v_church for update;
  if not found then
    raise exception 'That program was not found.';
  end if;
  if p_publish and prog.status <> 'published' then
    update programs set status = 'published', published_at = coalesce(published_at, now()) where id = p_program;
    select coalesce(array_agg(distinct i.presenter_id), '{}') into v_pres from program_items i
      where i.program_id = p_program and i.presenter_id is not null;
    perform notify_program(p_program, 'New program: ' || prog.title,
      'The order of service for ' || to_char(prog.starts_at at time zone 'Africa/Johannesburg', 'DD Mon YYYY') || ' is ready.', v_pres);
  elsif not p_publish and prog.status = 'published' then
    update programs set status = 'draft' where id = p_program;
  end if;
end;
$$;

create or replace function delete_program(p_program uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := require_manager();
begin
  if not exists (select 1 from programs where id = p_program and church_id = v_church) then
    raise exception 'That program was not found.';
  end if;
  with gone as (
    update role_grants g set revoked_at = now()
    where g.role = 'item_renderer' and g.scope_type = 'oos_item' and g.revoked_at is null
      and g.scope_id in (select i.id from program_items i where i.program_id = p_program)
    returning g.church_id, g.user_id, g.scope_id, g.id
  )
  insert into audit_log (church_id, actor_id, action, target_user, role, scope_type, scope_id, detail)
  select church_id, auth.uid(), 'revoked', user_id, 'item_renderer', 'oos_item', scope_id, jsonb_build_object('grant_id', id) from gone;
  delete from programs where id = p_program;
end;
$$;

create or replace function program_history(p_program uuid)
returns table (id uuid, version int, changed_at timestamptz, changed_by_name text, summary text, snapshot jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_church uuid := require_manager();
begin
  return query
    select v.id, v.version, v.changed_at,
           coalesce((select m.full_name from members m where m.user_id = v.changed_by limit 1),
                    (select pr.full_name from profiles pr where pr.id = v.changed_by), 'Someone'),
           v.summary, v.snapshot
    from program_versions v
    where v.program_id = p_program and v.church_id = v_church
    order by v.version desc;
end;
$$;

create or replace function restore_program_version(p_version uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := require_manager();
  v program_versions;
  v_items jsonb;
begin
  select * into v from program_versions where id = p_version and church_id = v_church;
  if not found then
    raise exception 'That version was not found.';
  end if;
  -- items that still exist keep their id (so their files stay); items that were deleted since come back as new ones
  select coalesce(jsonb_agg(
    case when exists (select 1 from program_items i where i.id = (e->>'id')::uuid and i.program_id = v.program_id)
         then e else e - 'id' end
    order by (e->>'position')::int), '[]'::jsonb)
  into v_items
  from jsonb_array_elements(v.snapshot->'items') e;
  return save_program(v.program_id, v.snapshot->>'title', (v.snapshot->>'starts_at')::timestamptz, v_items, 'Restored version ' || v.version);
end;
$$;

-- ---------- everyone: read the program ----------

create or replace function list_programs()
returns table (id uuid, title text, starts_at timestamptz, status text, version int, item_count int)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.title, p.starts_at, p.status, p.version, (select count(*)::int from program_items i where i.program_id = p.id)
  from programs p
  where can_read_program(p.id) and p.starts_at >= now() - interval '60 days'
  order by p.starts_at desc
  limit 40;
$$;

-- One program with its items. Internal notes only for managers, the media team and the item's presenter.
create or replace function get_program(p_program uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p.id, 'title', p.title, 'starts_at', p.starts_at, 'status', p.status, 'version', p.version,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'position', i.position, 'title', i.title, 'duration_minutes', i.duration_minutes,
        'department', i.department,
        'presenter_id', case when has_role('platform_manager') then i.presenter_id end,
        'presenter_name', coalesce(
          (select m.full_name from members m where m.user_id = i.presenter_id limit 1), i.presenter_name),
        'notes', case when can_read_item_details(i.id) then i.notes end,
        'file_count', case when can_read_item_details(i.id) then (select count(*)::int from program_item_files f where f.item_id = i.id) else 0 end
      ) order by i.position)
      from program_items i where i.program_id = p.id
    ), '[]'::jsonb)
  )
  from programs p
  where p.id = p_program and can_read_program(p.id);
$$;

-- What I am presenting soon.
create or replace function my_items()
returns table (
  item_id uuid, program_id uuid, program_title text, starts_at timestamptz, item_title text,
  duration_minutes int, department text, notes text, can_upload boolean, expires_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select i.id, p.id, p.title, p.starts_at, i.title, i.duration_minutes, i.department, i.notes,
         has_role('item_renderer', 'oos_item', i.id),
         (select g.expires_at from role_grants g where g.user_id = auth.uid() and g.role = 'item_renderer' and g.scope_id = i.id
            and g.revoked_at is null and (g.expires_at is null or g.expires_at > now()) limit 1)
  from program_items i
  join programs p on p.id = i.program_id
  where i.presenter_id = auth.uid()
    and p.status = 'published'
    and p.church_id = my_church_id()
    and service_day_end(p.starts_at) > now()
  order by p.starts_at, i.position;
$$;

create or replace function item_files_for(p_item uuid)
returns table (id uuid, file_name text, content_type text, size_bytes bigint, storage_path text, uploaded_by_me boolean)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, f.file_name, f.content_type, f.size_bytes, f.storage_path, f.uploaded_by = auth.uid()
  from program_item_files f
  where f.item_id = p_item and can_read_item_details(p_item)
  order by f.created_at;
$$;

-- ---------- permissions ----------

revoke all on function can_read_program(uuid) from public, anon, authenticated;
revoke all on function item_church(uuid) from public, anon, authenticated;
revoke all on function can_read_item_details(uuid) from public, anon, authenticated;
revoke all on function storage_item_id(text) from public, anon;
revoke all on function program_audience(uuid) from public, anon, authenticated;
revoke all on function service_day_end(timestamptz) from public, anon, authenticated;
revoke all on function sync_item_grants(uuid) from public, anon, authenticated;
revoke all on function snapshot_program(uuid) from public, anon, authenticated;
revoke all on function notify_program(uuid, text, text, uuid[]) from public, anon, authenticated;
revoke all on function require_manager() from public, anon, authenticated;
revoke all on function create_program(text, timestamptz, uuid, uuid) from public, anon, authenticated;
revoke all on function save_program(uuid, text, timestamptz, jsonb, text) from public, anon, authenticated;
revoke all on function publish_program(uuid, boolean) from public, anon, authenticated;
revoke all on function delete_program(uuid) from public, anon, authenticated;
revoke all on function program_history(uuid) from public, anon, authenticated;
revoke all on function restore_program_version(uuid) from public, anon, authenticated;
revoke all on function list_programs() from public, anon, authenticated;
revoke all on function get_program(uuid) from public, anon, authenticated;
revoke all on function my_items() from public, anon, authenticated;
revoke all on function item_files_for(uuid) from public, anon, authenticated;

grant execute on function can_read_program(uuid) to authenticated;
grant execute on function item_church(uuid) to authenticated;
grant execute on function can_read_item_details(uuid) to authenticated;
grant execute on function storage_item_id(text) to authenticated;
grant execute on function create_program(text, timestamptz, uuid, uuid) to authenticated;
grant execute on function save_program(uuid, text, timestamptz, jsonb, text) to authenticated;
grant execute on function publish_program(uuid, boolean) to authenticated;
grant execute on function delete_program(uuid) to authenticated;
grant execute on function program_history(uuid) to authenticated;
grant execute on function restore_program_version(uuid) to authenticated;
grant execute on function list_programs() to authenticated;
grant execute on function get_program(uuid) to authenticated;
grant execute on function my_items() to authenticated;
grant execute on function item_files_for(uuid) to authenticated;
