-- ===================================================================
-- CBC Sandton phase 2, step 2: Sermon Desk and teaching library
--
-- Run once in the Supabase SQL editor, after 08-roles.sql.
-- It is safe to run again.
--
-- What it adds to the sermon library from 07:
--   * topic, notes (written with a few simple marks, shown safely), a visibility
--     setting per sermon and an optional link to the service it is for
--   * attachments (PowerPoint, PDF, images) in a private storage bucket
--   * search by words, series and dates
--   * a notice for the media team and managers when a sermon is first published
--
-- Visibility per sermon:
--   managers_media   Media Team and managers only
--   members          every active member (the default)
--   public           anyone, set only by the Senior Pastor
-- Managers (the Senior Pastor and Platform Managers) always see every sermon,
-- including drafts. Files follow the same visibility rules, and a file can only
-- be downloaded through a short lived link that is issued after that check.
-- ===================================================================

alter table sermons alter column video_url drop not null;
alter table sermons add column if not exists topic text check (topic is null or length(topic) <= 120);
alter table sermons add column if not exists notes text check (notes is null or length(notes) <= 20000);
alter table sermons add column if not exists visibility text not null default 'members'
  check (visibility in ('managers_media', 'members', 'public'));
alter table sermons add column if not exists service_id uuid references services(id) on delete set null;
alter table sermons add column if not exists published_at timestamptz;
alter table sermons add column if not exists created_by uuid references auth.users(id) on delete set null;
create index if not exists sermons_church_series on sermons (church_id, series);

-- Managers (including Platform Managers who have no ChurchHub profile) manage the library.
drop policy if exists "sermons in church" on sermons;
drop policy if exists "managers manage sermons" on sermons;
create policy "managers manage sermons" on sermons
  for all
  using (church_id = my_church_id() and has_role('platform_manager'))
  with check (church_id = my_church_id() and has_role('platform_manager'));

-- Attachments
create table if not exists sermon_files (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  sermon_id uuid not null references sermons(id) on delete cascade,
  file_name text not null check (length(file_name) between 1 and 200),
  content_type text,
  size_bytes bigint check (size_bytes between 1 and 26214400),
  storage_path text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists sermon_files_sermon on sermon_files (sermon_id);
alter table sermon_files enable row level security;

-- Can the signed in person read this sermon (and so its files)?
create or replace function can_read_sermon(p_sermon uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from sermons s
    where s.id = p_sermon
      and s.church_id = my_church_id()
      and (
        has_role('platform_manager')
        or (
          s.is_published
          and (
            (s.visibility in ('members', 'public') and (
              has_role('media_team')
              or exists (select 1 from members m where m.user_id = auth.uid() and m.church_id = s.church_id and m.is_active)
            ))
            or (s.visibility = 'managers_media' and has_role('media_team'))
          )
        )
      )
  );
$$;

drop policy if exists "read files you can read" on sermon_files;
create policy "read files you can read" on sermon_files
  for select using (can_read_sermon(sermon_id));

drop policy if exists "managers manage files" on sermon_files;
create policy "managers manage files" on sermon_files
  for all
  using (church_id = my_church_id() and has_role('platform_manager'))
  with check (church_id = my_church_id() and has_role('platform_manager'));

-- The private bucket. Nothing in it is reachable by address alone.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sermon-files', 'sermon-files', false, 26214400,
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

drop policy if exists "sermon files readable" on storage.objects;
create policy "sermon files readable" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'sermon-files'
    and exists (select 1 from sermon_files f where f.storage_path = name and can_read_sermon(f.sermon_id))
  );

-- Managers can always see their own church's folder. This also lets them finish an upload,
-- which happens before the file record is written.
drop policy if exists "managers read sermon files" on storage.objects;
create policy "managers read sermon files" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'sermon-files'
    and has_role('platform_manager')
    and name like my_church_id()::text || '/%'
  );

drop policy if exists "managers upload sermon files" on storage.objects;
create policy "managers upload sermon files" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'sermon-files'
    and has_role('platform_manager')
    and name like my_church_id()::text || '/%'
  );

drop policy if exists "managers remove sermon files" on storage.objects;
create policy "managers remove sermon files" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'sermon-files'
    and has_role('platform_manager')
    and name like my_church_id()::text || '/%'
  );

-- In app notices (the bell). Written by the database only.
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  link text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists notifications_user on notifications (user_id, created_at desc);
alter table notifications enable row level security;

drop policy if exists "read own notifications" on notifications;
create policy "read own notifications" on notifications for select using (user_id = auth.uid());

create or replace function my_notifications()
returns table (id uuid, kind text, title text, body text, link text, created_at timestamptz, read_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select n.id, n.kind, n.title, n.body, n.link, n.created_at, n.read_at
  from notifications n
  where n.user_id = auth.uid()
  order by n.created_at desc
  limit 50;
$$;

create or replace function mark_notifications_read(p_ids uuid[] default null)
returns void
language sql
security definer
set search_path = public
as $$
  update notifications set read_at = now()
  where user_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids));
$$;

-- Guard and timestamps. Only the Senior Pastor can make a sermon public.
create or replace function sermons_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    if new.visibility = 'public'
       and (tg_op = 'INSERT' or old.visibility is distinct from 'public')
       and not has_role('senior_pastor') then
      raise exception 'Only the Senior Pastor can make a sermon public.';
    end if;
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    end if;
  end if;
  if new.is_published and new.published_at is null then
    new.published_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists sermons_guard on sermons;
create trigger sermons_guard before insert or update on sermons
  for each row execute function sermons_guard();

-- First publish: tell the media team and the managers, once.
create or replace function notify_sermon_published()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service text;
begin
  if new.published_at is null then return null; end if;
  if tg_op = 'UPDATE' and old.published_at is not null then return null; end if;

  select to_char(sv.starts_at at time zone 'Africa/Johannesburg', 'DD Mon YYYY') into v_service
  from services sv where sv.id = new.service_id;

  insert into notifications (church_id, user_id, kind, title, body, link)
  select distinct new.church_id, r.uid, 'sermon_published',
         'New sermon material: ' || new.title,
         trim(both ' ' from coalesce(new.speaker, '') || case when new.scripture is not null then ' | ' || new.scripture else '' end
              || case when v_service is not null then ' | For the service on ' || v_service else '' end),
         'sermons'
  from (
    select g.user_id as uid from role_grants g
    where g.church_id = new.church_id and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())
      and g.role in ('media_team', 'platform_manager', 'senior_pastor')
    union
    select p.id from profiles p where p.church_id = new.church_id and p.role = 'admin'
  ) r
  where r.uid is distinct from auth.uid();
  return null;
end;
$$;

drop trigger if exists notify_sermon_published on sermons;
create trigger notify_sermon_published after insert or update on sermons
  for each row execute function notify_sermon_published();

-- Search and the member facing list. Same shape for both.
drop function if exists my_sermons();

create or replace function search_sermons(
  p_query text default null,
  p_series text default null,
  p_from date default null,
  p_to date default null
)
returns table (
  id uuid, title text, preached_on date, speaker text, scripture text, series text, topic text,
  notes text, description text, video_url text, visibility text, is_published boolean,
  service_id uuid, service_title text, service_starts_at timestamptz, file_count int
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.title, s.preached_on, s.speaker, s.scripture, s.series, s.topic,
         s.notes, s.description, s.video_url, s.visibility, s.is_published,
         s.service_id, sv.title, sv.starts_at,
         (select count(*)::int from sermon_files f where f.sermon_id = s.id)
  from sermons s
  left join services sv on sv.id = s.service_id
  where can_read_sermon(s.id)
    and (p_series is null or p_series = '' or s.series = p_series)
    and (p_from is null or s.preached_on >= p_from)
    and (p_to is null or s.preached_on <= p_to)
    and (
      p_query is null or btrim(p_query) = ''
      or concat_ws(' ', s.title, s.speaker, s.scripture, s.series, s.topic, s.notes, s.description)
         ilike '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    )
  order by s.preached_on desc, s.created_at desc
  limit 100;
$$;

create or replace function my_sermons()
returns table (
  id uuid, title text, preached_on date, speaker text, scripture text, series text, topic text,
  notes text, description text, video_url text, visibility text, is_published boolean,
  service_id uuid, service_title text, service_starts_at timestamptz, file_count int
)
language sql
stable
security definer
set search_path = public
as $$
  select * from search_sermons();
$$;

create or replace function sermon_series()
returns table (series text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct s.series from sermons s
  where s.series is not null and can_read_sermon(s.id)
  order by 1;
$$;

create or replace function sermon_files_for(p_sermon uuid)
returns table (id uuid, file_name text, content_type text, size_bytes bigint, storage_path text)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, f.file_name, f.content_type, f.size_bytes, f.storage_path
  from sermon_files f
  where f.sermon_id = p_sermon and can_read_sermon(p_sermon)
  order by f.created_at;
$$;

-- Sermons the Senior Pastor has made public, for the church website (no files).
create or replace function public_sermons(p_church_id uuid)
returns table (id uuid, title text, preached_on date, speaker text, scripture text, series text, topic text, description text, video_url text)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.title, s.preached_on, s.speaker, s.scripture, s.series, s.topic, s.description, s.video_url
  from sermons s
  where s.church_id = p_church_id and s.is_published and s.visibility = 'public'
  order by s.preached_on desc
  limit 50;
$$;

revoke all on function can_read_sermon(uuid) from public, anon, authenticated;
revoke all on function my_notifications() from public, anon, authenticated;
revoke all on function mark_notifications_read(uuid[]) from public, anon, authenticated;
revoke all on function search_sermons(text, text, date, date) from public, anon, authenticated;
revoke all on function my_sermons() from public, anon, authenticated;
revoke all on function sermon_series() from public, anon, authenticated;
revoke all on function sermon_files_for(uuid) from public, anon, authenticated;
revoke all on function public_sermons(uuid) from public, anon, authenticated;
revoke all on function sermons_guard() from public, anon, authenticated;
revoke all on function notify_sermon_published() from public, anon, authenticated;

grant execute on function can_read_sermon(uuid) to authenticated;
grant execute on function my_notifications() to authenticated;
grant execute on function mark_notifications_read(uuid[]) to authenticated;
grant execute on function search_sermons(text, text, date, date) to authenticated;
grant execute on function my_sermons() to authenticated;
grant execute on function sermon_series() to authenticated;
grant execute on function sermon_files_for(uuid) to authenticated;
grant execute on function public_sermons(uuid) to anon, authenticated;
