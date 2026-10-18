-- ===================================================================
-- CBC Sandton phase 2, step 4: ministries and the Praise and Worship workspace
--
-- Run once in the Supabase SQL editor, after 11-weekly-program.sql.
-- It is safe to run again.
--
-- Ministries are the church's departments. People belong to one through the
-- ministry_member or ministry_leader role (given in Settings, People and roles).
-- Praise and Worship gets a workspace:
--   * a song library: each song has versions (name, musical key, lyrics, notes)
--   * a set list for each service, optionally tied to an item in the Weekly Program
--   * a weekly colour planner, with a reminder the evening before
--   * change alerts when lyrics, keys or a set list change
--
-- Who can do what:
--   managers and the ministry's leaders   write everything
--   the ministry's team members            read songs, set lists and colours
--   the media team                         read the lyrics of PUBLISHED set lists only, to prepare slides
--   everyone else                          nothing
-- ===================================================================

create table if not exists ministries (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z][a-z0-9-]{1,40}$'),
  name text not null check (length(name) between 1 and 80),
  colour text not null default '#566170' check (colour ~ '^#[0-9a-fA-F]{6}$'),
  description text check (description is null or length(description) <= 500),
  created_at timestamptz not null default now(),
  unique (church_id, slug)
);

alter table ministries enable row level security;

drop policy if exists "members see ministries" on ministries;
create policy "members see ministries" on ministries for select
  using (church_id = my_church_id());

drop policy if exists "managers manage ministries" on ministries;
create policy "managers manage ministries" on ministries for all
  using (church_id = my_church_id() and has_role('platform_manager'))
  with check (church_id = my_church_id() and has_role('platform_manager'));

-- The church's ministries (safe to run again)
insert into ministries (church_id, slug, name, colour, description)
select c.id, m.slug, m.name, m.colour, m.description
from churches c
cross join (values
  ('pastoral-desk', 'Pastoral Desk', '#3a4a5c', 'Pastor''s messages and pastoral announcements'),
  ('praise-worship', 'Praise and Worship', '#b8862b', 'Rehearsals, song lists and the worship team'),
  ('teens', 'Teens Ministry', '#2f7048', 'Teens meetings, lessons and outings'),
  ('youth', 'Youth Ministry', '#7a4fa3', 'Youth services, events and outreach'),
  ('ladies', 'Ladies Ministry', '#b3432f', 'Meetings, fellowships and conferences'),
  ('soup-kitchen', 'Soup Kitchen', '#c26a1a', 'Feeding schedules and volunteer teams'),
  ('intercessors', 'Intercessors', '#2c6e8a', 'Prayer meetings and prayer focus'),
  ('mens', 'Men''s Ministry', '#566170', 'Meetings, breakfasts and outreach')
) as m(slug, name, colour, description)
on conflict (church_id, slug) do nothing;

-- ---------- helpers ----------

create or replace function ministry_id_of(p_slug text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.id from ministries m where m.church_id = my_church_id() and m.slug = p_slug;
$$;

-- On the team of this ministry? Leaders count, and so do managers.
create or replace function is_ministry_team(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(has_role('ministry_member', 'ministry', ministry_id_of(p_slug)), false);
$$;

create or replace function is_ministry_leader(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(has_role('ministry_leader', 'ministry', ministry_id_of(p_slug)), false);
$$;

-- Everyone on a ministry's team, for notices.
create or replace function ministry_audience(p_church uuid, p_slug text)
returns table (uid uuid)
language sql
stable
security definer
set search_path = public
as $$
  select g.user_id
  from role_grants g
  join ministries m on m.id = g.scope_id and m.church_id = p_church and m.slug = p_slug
  where g.role in ('ministry_member', 'ministry_leader') and g.scope_type = 'ministry'
    and g.revoked_at is null and (g.expires_at is null or g.expires_at > now());
$$;

create or replace function notify_users(p_church uuid, p_users uuid[], p_kind text, p_title text, p_body text, p_link text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into notifications (church_id, user_id, kind, title, body, link)
  select distinct p_church, u, p_kind, p_title, p_body, p_link
  from unnest(coalesce(p_users, '{}'::uuid[])) as u
  where u is not null and u is distinct from auth.uid();
end;
$$;

-- The ministries I belong to (managers belong to all).
create or replace function my_ministries()
returns table (id uuid, slug text, name text, colour text, description text, my_role text)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.slug, m.name, m.colour, m.description,
         case when has_role('platform_manager') then 'manager'
              when has_role('ministry_leader', 'ministry', m.id) then 'leader'
              else 'member' end
  from ministries m
  where m.church_id = my_church_id()
    and has_role('ministry_member', 'ministry', m.id)
  order by m.name;
$$;

-- ---------- songs ----------

create table if not exists songs (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  title text not null check (length(title) between 1 and 120),
  author text check (author is null or length(author) <= 120),
  archived boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists songs_church_title on songs (church_id, title);

create table if not exists song_versions (
  id uuid primary key default gen_random_uuid(),
  song_id uuid not null references songs(id) on delete cascade,
  church_id uuid not null references churches(id) on delete cascade,
  label text not null default 'Original' check (length(label) between 1 and 60),
  musical_key text check (musical_key is null or length(musical_key) <= 12),
  lyrics text check (lyrics is null or length(lyrics) <= 20000),
  notes text check (notes is null or length(notes) <= 2000),
  position int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists song_versions_song on song_versions (song_id, position);

-- ---------- set lists ----------

create table if not exists set_lists (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  title text not null check (length(title) between 1 and 120),
  starts_at timestamptz not null,
  program_item_id uuid references program_items(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'published')),
  notes text check (notes is null or length(notes) <= 2000),
  published_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists set_lists_church_start on set_lists (church_id, starts_at desc);

create table if not exists set_list_songs (
  id uuid primary key default gen_random_uuid(),
  set_list_id uuid not null references set_lists(id) on delete cascade,
  church_id uuid not null references churches(id) on delete cascade,
  position int not null,
  song_id uuid not null references songs(id) on delete restrict,
  version_id uuid references song_versions(id) on delete set null,
  musical_key text check (musical_key is null or length(musical_key) <= 12),
  notes text check (notes is null or length(notes) <= 500)
);
create index if not exists set_list_songs_set on set_list_songs (set_list_id, position);

-- ---------- the weekly colour planner ----------

create table if not exists colour_plans (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  ministry_id uuid not null references ministries(id) on delete cascade,
  service_date date not null,
  colours jsonb not null default '[]'::jsonb,
  note text check (note is null or length(note) <= 500),
  status text not null default 'draft' check (status in ('draft', 'published')),
  reminded_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (ministry_id, service_date),
  check (jsonb_typeof(colours) = 'array' and jsonb_array_length(colours) <= 6)
);

alter table songs enable row level security;
alter table song_versions enable row level security;
alter table set_lists enable row level security;
alter table set_list_songs enable row level security;
alter table colour_plans enable row level security;

-- The team reads, the leaders (and managers) write. The media team has no direct access: it reads
-- published set lists through get_set_list() below.
drop policy if exists "team reads songs" on songs;
create policy "team reads songs" on songs for select using (church_id = my_church_id() and is_ministry_team('praise-worship'));
drop policy if exists "leaders write songs" on songs;
create policy "leaders write songs" on songs for all
  using (church_id = my_church_id() and is_ministry_leader('praise-worship'))
  with check (church_id = my_church_id() and is_ministry_leader('praise-worship'));

drop policy if exists "team reads versions" on song_versions;
create policy "team reads versions" on song_versions for select using (church_id = my_church_id() and is_ministry_team('praise-worship'));
drop policy if exists "leaders write versions" on song_versions;
create policy "leaders write versions" on song_versions for all
  using (church_id = my_church_id() and is_ministry_leader('praise-worship'))
  with check (church_id = my_church_id() and is_ministry_leader('praise-worship'));

drop policy if exists "team reads set lists" on set_lists;
create policy "team reads set lists" on set_lists for select using (church_id = my_church_id() and is_ministry_team('praise-worship'));
drop policy if exists "leaders write set lists" on set_lists;
create policy "leaders write set lists" on set_lists for all
  using (church_id = my_church_id() and is_ministry_leader('praise-worship'))
  with check (church_id = my_church_id() and is_ministry_leader('praise-worship'));

drop policy if exists "team reads set list songs" on set_list_songs;
create policy "team reads set list songs" on set_list_songs for select using (church_id = my_church_id() and is_ministry_team('praise-worship'));
drop policy if exists "leaders write set list songs" on set_list_songs;
create policy "leaders write set list songs" on set_list_songs for all
  using (church_id = my_church_id() and is_ministry_leader('praise-worship'))
  with check (church_id = my_church_id() and is_ministry_leader('praise-worship'));

drop policy if exists "team reads colours" on colour_plans;
create policy "team reads colours" on colour_plans for select
  using (church_id = my_church_id() and is_ministry_team('praise-worship') and (status = 'published' or is_ministry_leader('praise-worship')));
drop policy if exists "leaders write colours" on colour_plans;
create policy "leaders write colours" on colour_plans for all
  using (church_id = my_church_id() and is_ministry_leader('praise-worship'))
  with check (church_id = my_church_id() and is_ministry_leader('praise-worship'));

-- ---------- functions: the song library ----------

create or replace function require_worship_leader()
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
  if not is_ministry_leader('praise-worship') then
    raise exception 'Only the Praise and Worship leaders and the managers can do that.';
  end if;
  return v_church;
end;
$$;

create or replace function require_worship_team()
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
  if not is_ministry_team('praise-worship') then
    raise exception 'Only the Praise and Worship team can see that.';
  end if;
  return v_church;
end;
$$;

create or replace function list_songs(p_query text default null, p_include_archived boolean default false)
returns table (id uuid, title text, author text, archived boolean, version_count int, keys text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_church uuid := require_worship_team();
  q text := nullif(btrim(coalesce(p_query, '')), '');
begin
  return query
    select s.id, s.title, s.author, s.archived,
           (select count(*)::int from song_versions v where v.song_id = s.id),
           (select string_agg(distinct v.musical_key, ', ') from song_versions v where v.song_id = s.id and v.musical_key is not null)
    from songs s
    where s.church_id = v_church
      and (p_include_archived or not s.archived)
      and (q is null or concat_ws(' ', s.title, s.author, (select string_agg(coalesce(v.lyrics, ''), ' ') from song_versions v where v.song_id = s.id))
           ilike '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%')
    order by s.title
    limit 300;
end;
$$;

create or replace function get_song(p_song uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_church uuid := require_worship_team();
begin
  return (
    select jsonb_build_object(
      'id', s.id, 'title', s.title, 'author', s.author, 'archived', s.archived,
      'versions', coalesce((
        select jsonb_agg(jsonb_build_object('id', v.id, 'label', v.label, 'musical_key', v.musical_key, 'lyrics', v.lyrics, 'notes', v.notes) order by v.position)
        from song_versions v where v.song_id = s.id
      ), '[]'::jsonb)
    )
    from songs s where s.id = p_song and s.church_id = v_church
  );
end;
$$;

-- Save a song with all its versions at once. A change to a version's lyrics or key tells the team
-- and the media team, but only when the song is in a published set list that has not happened yet.
create or replace function save_song(p_song uuid, p_title text, p_author text, p_versions jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := require_worship_leader();
  v_id uuid := p_song;
  v_title text := btrim(coalesce(p_title, ''));
  elem jsonb;
  n int := 0;
  vid uuid;
  v_ids uuid[] := '{}';
  v_changed boolean := false;
  v_old jsonb;
  v_in_use boolean;
begin
  if length(v_title) < 1 or length(v_title) > 120 then
    raise exception 'Give the song a title.';
  end if;
  if p_versions is null or jsonb_typeof(p_versions) <> 'array' or jsonb_array_length(p_versions) < 1 then
    raise exception 'A song needs at least one version.';
  end if;
  if jsonb_array_length(p_versions) > 12 then
    raise exception 'A song can have at most 12 versions.';
  end if;

  if v_id is null then
    insert into songs (church_id, title, author, created_by)
    values (v_church, v_title, nullif(btrim(coalesce(p_author, '')), ''), auth.uid())
    returning id into v_id;
    v_changed := false;
  else
    if not exists (select 1 from songs where id = v_id and church_id = v_church) then
      raise exception 'That song was not found.';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'k', v.musical_key, 'l', v.lyrics) order by v.id), '[]'::jsonb) into v_old
      from song_versions v where v.song_id = v_id;
    update songs set title = v_title, author = nullif(btrim(coalesce(p_author, '')), ''), updated_at = now() where id = v_id;
  end if;

  for elem in select * from jsonb_array_elements(p_versions) loop
    n := n + 1;
    if length(btrim(coalesce(elem->>'label', ''))) < 1 then
      raise exception 'Version % needs a name.', n;
    end if;
    vid := nullif(elem->>'id', '')::uuid;
    if vid is not null and exists (select 1 from song_versions v where v.id = vid and v.song_id = v_id) then
      update song_versions set
        label = btrim(elem->>'label'),
        musical_key = nullif(btrim(coalesce(elem->>'musical_key', '')), ''),
        lyrics = nullif(coalesce(elem->>'lyrics', ''), ''),
        notes = nullif(btrim(coalesce(elem->>'notes', '')), ''),
        position = n,
        updated_at = now()
      where id = vid;
    else
      insert into song_versions (song_id, church_id, label, musical_key, lyrics, notes, position)
      values (v_id, v_church, btrim(elem->>'label'), nullif(btrim(coalesce(elem->>'musical_key', '')), ''),
              nullif(coalesce(elem->>'lyrics', ''), ''), nullif(btrim(coalesce(elem->>'notes', '')), ''), n)
      returning id into vid;
    end if;
    v_ids := v_ids || vid;
  end loop;
  delete from song_versions where song_id = v_id and not (id = any(v_ids));

  if p_song is not null then
    select exists (
      select 1 from jsonb_array_elements(v_old) o
      where not exists (
        select 1 from song_versions v where v.id = (o->>'id')::uuid
          and v.musical_key is not distinct from nullif(o->>'k', '') and v.lyrics is not distinct from nullif(o->>'l', '')
      )
    ) or exists (select 1 from song_versions v where v.song_id = v_id and not exists (select 1 from jsonb_array_elements(v_old) o where (o->>'id')::uuid = v.id))
    into v_changed;

    select exists (
      select 1 from set_list_songs ss join set_lists sl on sl.id = ss.set_list_id
      where ss.song_id = v_id and sl.status = 'published' and sl.starts_at >= now() - interval '12 hours'
    ) into v_in_use;

    if v_changed and v_in_use then
      perform notify_users(v_church,
        array(select uid from ministry_audience(v_church, 'praise-worship') union select user_id from role_grants g
              where g.church_id = v_church and g.role = 'media_team' and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())),
        'worship', 'Song changed: ' || v_title, 'The lyrics or key changed for a song in an upcoming set list.', 'ministries');
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function set_song_archived(p_song uuid, p_archived boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := require_worship_leader();
begin
  update songs set archived = coalesce(p_archived, false), updated_at = now() where id = p_song and church_id = v_church;
  if not found then
    raise exception 'That song was not found.';
  end if;
end;
$$;

-- ---------- functions: set lists ----------

create or replace function create_set_list(p_title text, p_starts_at timestamptz, p_program_item uuid default null, p_copy_from uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := require_worship_leader();
  v_id uuid;
  v_title text := btrim(coalesce(p_title, ''));
begin
  if length(v_title) < 1 or length(v_title) > 120 then
    raise exception 'Give the set list a title.';
  end if;
  if p_starts_at is null then
    raise exception 'Choose the service date.';
  end if;
  if p_program_item is not null and not exists (select 1 from program_items i where i.id = p_program_item and i.church_id = v_church) then
    raise exception 'That program item was not found.';
  end if;
  insert into set_lists (church_id, title, starts_at, program_item_id, created_by)
  values (v_church, v_title, p_starts_at, p_program_item, auth.uid())
  returning id into v_id;
  if p_copy_from is not null then
    insert into set_list_songs (set_list_id, church_id, position, song_id, version_id, musical_key, notes)
    select v_id, v_church, s.position, s.song_id, s.version_id, s.musical_key, s.notes
    from set_list_songs s join set_lists l on l.id = s.set_list_id
    where s.set_list_id = p_copy_from and l.church_id = v_church;
  end if;
  return v_id;
end;
$$;

create or replace function save_set_list(p_set uuid, p_title text, p_starts_at timestamptz, p_program_item uuid, p_songs jsonb, p_notes text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := require_worship_leader();
  sl set_lists;
  elem jsonb;
  n int := 0;
  v_song uuid;
  v_ver uuid;
  v_old jsonb;
  v_new jsonb;
begin
  select * into sl from set_lists where id = p_set and church_id = v_church for update;
  if not found then
    raise exception 'That set list was not found.';
  end if;
  if p_songs is null or jsonb_typeof(p_songs) <> 'array' then
    raise exception 'The songs must be a list.';
  end if;
  if jsonb_array_length(p_songs) > 30 then
    raise exception 'A set list can have at most 30 songs.';
  end if;
  if p_program_item is not null and not exists (select 1 from program_items i where i.id = p_program_item and i.church_id = v_church) then
    raise exception 'That program item was not found.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('s', s.song_id, 'v', s.version_id, 'k', s.musical_key, 'n', s.notes) order by s.position), '[]'::jsonb)
    into v_old from set_list_songs s where s.set_list_id = p_set;

  delete from set_list_songs where set_list_id = p_set;
  for elem in select * from jsonb_array_elements(p_songs) loop
    n := n + 1;
    v_song := nullif(elem->>'song_id', '')::uuid;
    if v_song is null or not exists (select 1 from songs s where s.id = v_song and s.church_id = v_church) then
      raise exception 'Song % was not found in this church.', n;
    end if;
    v_ver := nullif(elem->>'version_id', '')::uuid;
    if v_ver is not null and not exists (select 1 from song_versions v where v.id = v_ver and v.song_id = v_song) then
      raise exception 'The version for song % does not belong to that song.', n;
    end if;
    insert into set_list_songs (set_list_id, church_id, position, song_id, version_id, musical_key, notes)
    values (p_set, v_church, n, v_song, v_ver, nullif(btrim(coalesce(elem->>'musical_key', '')), ''), nullif(btrim(coalesce(elem->>'notes', '')), ''));
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('s', s.song_id, 'v', s.version_id, 'k', s.musical_key, 'n', s.notes) order by s.position), '[]'::jsonb)
    into v_new from set_list_songs s where s.set_list_id = p_set;

  update set_lists set
    title = coalesce(nullif(btrim(coalesce(p_title, '')), ''), sl.title),
    starts_at = coalesce(p_starts_at, sl.starts_at),
    program_item_id = p_program_item,
    notes = nullif(btrim(coalesce(p_notes, '')), ''),
    updated_at = now()
  where id = p_set;

  if sl.status = 'published' and (v_old is distinct from v_new or (p_starts_at is not null and p_starts_at is distinct from sl.starts_at)) then
    perform notify_users(v_church,
      array(select uid from ministry_audience(v_church, 'praise-worship') union select user_id from role_grants g
            where g.church_id = v_church and g.role = 'media_team' and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())),
      'worship', 'Set list updated: ' || sl.title, 'The songs for this service changed.', 'ministries');
  end if;
end;
$$;

create or replace function publish_set_list(p_set uuid, p_publish boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := require_worship_leader();
  sl set_lists;
begin
  select * into sl from set_lists where id = p_set and church_id = v_church for update;
  if not found then
    raise exception 'That set list was not found.';
  end if;
  if p_publish and sl.status <> 'published' then
    update set_lists set status = 'published', published_at = coalesce(published_at, now()) where id = p_set;
    perform notify_users(v_church,
      array(select uid from ministry_audience(v_church, 'praise-worship') union select user_id from role_grants g
            where g.church_id = v_church and g.role in ('media_team', 'platform_manager', 'senior_pastor') and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())),
      'worship', 'New set list: ' || sl.title, 'The songs and lyrics are ready.', 'ministries');
  elsif not p_publish and sl.status = 'published' then
    update set_lists set status = 'draft' where id = p_set;
  end if;
end;
$$;

create or replace function delete_set_list(p_set uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := require_worship_leader();
begin
  delete from set_lists where id = p_set and church_id = v_church;
  if not found then
    raise exception 'That set list was not found.';
  end if;
end;
$$;

-- The team sees every set list; the media team only published ones.
create or replace function list_set_lists()
returns table (id uuid, title text, starts_at timestamptz, status text, song_count int)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.title, l.starts_at, l.status, (select count(*)::int from set_list_songs s where s.set_list_id = l.id)
  from set_lists l
  where l.church_id = my_church_id()
    and l.starts_at >= now() - interval '60 days'
    and (is_ministry_team('praise-worship') or (l.status = 'published' and has_role('media_team')))
  order by l.starts_at desc
  limit 40;
$$;

-- One set list with the lyrics of every song, ready for slides.
create or replace function get_set_list(p_set uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', l.id, 'title', l.title, 'starts_at', l.starts_at, 'status', l.status, 'notes', l.notes, 'program_item_id', l.program_item_id,
    'songs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'position', s.position, 'song_id', s.song_id, 'title', g.title, 'author', g.author,
        'version_id', s.version_id, 'version_label', v.label,
        'musical_key', coalesce(s.musical_key, v.musical_key), 'lyrics', v.lyrics, 'song_notes', v.notes, 'notes', s.notes
      ) order by s.position)
      from set_list_songs s
      join songs g on g.id = s.song_id
      left join song_versions v on v.id = s.version_id
      where s.set_list_id = l.id
    ), '[]'::jsonb)
  )
  from set_lists l
  where l.id = p_set and l.church_id = my_church_id()
    and (is_ministry_team('praise-worship') or (l.status = 'published' and has_role('media_team')));
$$;

-- ---------- functions: colours ----------

create or replace function list_colour_plans()
returns table (id uuid, service_date date, colours jsonb, note text, status text)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.service_date, c.colours, c.note, c.status
  from colour_plans c
  join ministries m on m.id = c.ministry_id and m.slug = 'praise-worship'
  where c.church_id = my_church_id()
    and is_ministry_team('praise-worship')
    and (c.status = 'published' or is_ministry_leader('praise-worship'))
    and c.service_date >= (now() at time zone 'Africa/Johannesburg')::date - 14
  order by c.service_date
  limit 30;
$$;

create or replace function save_colour_plan(p_date date, p_colours jsonb, p_note text, p_publish boolean)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := require_worship_leader();
  v_min uuid := ministry_id_of('praise-worship');
  v_id uuid;
  v_old colour_plans;
  v_existed boolean;
  elem jsonb;
  v_names text;
  v_status text := case when coalesce(p_publish, false) then 'published' else 'draft' end;
begin
  if p_date is null then
    raise exception 'Choose the service date.';
  end if;
  if p_colours is null or jsonb_typeof(p_colours) <> 'array' or jsonb_array_length(p_colours) > 6 then
    raise exception 'Choose up to 6 colours.';
  end if;
  for elem in select * from jsonb_array_elements(p_colours) loop
    if coalesce(elem->>'hex', '') !~ '^#[0-9a-fA-F]{6}$' then
      raise exception 'Each colour needs a valid colour code.';
    end if;
    if length(btrim(coalesce(elem->>'name', ''))) > 40 then
      raise exception 'A colour name can have at most 40 characters.';
    end if;
  end loop;

  select * into v_old from colour_plans where ministry_id = v_min and service_date = p_date;
  v_existed := found;
  if v_existed then
    update colour_plans set colours = p_colours, note = nullif(btrim(coalesce(p_note, '')), ''), status = v_status,
           updated_by = auth.uid(), updated_at = now(),
           reminded_at = case when p_colours is distinct from v_old.colours then null else v_old.reminded_at end
    where id = v_old.id returning id into v_id;
  else
    insert into colour_plans (church_id, ministry_id, service_date, colours, note, status, updated_by)
    values (v_church, v_min, p_date, p_colours, nullif(btrim(coalesce(p_note, '')), ''), v_status, auth.uid())
    returning id into v_id;
  end if;

  if v_status = 'published' and (not v_existed or v_old.status <> 'published' or v_old.colours is distinct from p_colours) then
    select string_agg(coalesce(nullif(btrim(e->>'name'), ''), e->>'hex'), ', ') into v_names from jsonb_array_elements(p_colours) e;
    perform notify_users(v_church, array(select uid from ministry_audience(v_church, 'praise-worship')),
      'worship', 'Colours for ' || to_char(p_date, 'DD Mon'), coalesce(v_names, 'See the colour planner.'), 'ministries');
  end if;
  return v_id;
end;
$$;

create or replace function delete_colour_plan(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := require_worship_leader();
begin
  delete from colour_plans where id = p_id and church_id = v_church;
  if not found then
    raise exception 'That plan was not found.';
  end if;
end;
$$;

-- The evening before a service, remind the team once. Scheduled below. Not callable by signed in people.
create or replace function send_colour_reminders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  r record;
  v_names text;
begin
  for r in
    select c.id, c.church_id, c.service_date, c.colours, c.note
    from colour_plans c
    join ministries m on m.id = c.ministry_id and m.slug = 'praise-worship'
    where c.status = 'published' and c.reminded_at is null
      and c.service_date = (now() at time zone 'Africa/Johannesburg')::date + 1
  loop
    select string_agg(coalesce(nullif(btrim(e->>'name'), ''), e->>'hex'), ', ') into v_names from jsonb_array_elements(r.colours) e;
    insert into notifications (church_id, user_id, kind, title, body, link)
    select r.church_id, a.uid, 'worship', 'Tomorrow''s colours: ' || coalesce(v_names, 'see the planner'), coalesce(r.note, 'Please wear these colours tomorrow.'), 'ministries'
    from ministry_audience(r.church_id, 'praise-worship') a;
    update colour_plans set reminded_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------- permissions ----------

revoke all on function ministry_id_of(text) from public, anon, authenticated;
revoke all on function is_ministry_team(text) from public, anon, authenticated;
revoke all on function is_ministry_leader(text) from public, anon, authenticated;
revoke all on function ministry_audience(uuid, text) from public, anon, authenticated;
revoke all on function notify_users(uuid, uuid[], text, text, text, text) from public, anon, authenticated;
revoke all on function my_ministries() from public, anon, authenticated;
revoke all on function require_worship_leader() from public, anon, authenticated;
revoke all on function require_worship_team() from public, anon, authenticated;
revoke all on function list_songs(text, boolean) from public, anon, authenticated;
revoke all on function get_song(uuid) from public, anon, authenticated;
revoke all on function save_song(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function set_song_archived(uuid, boolean) from public, anon, authenticated;
revoke all on function create_set_list(text, timestamptz, uuid, uuid) from public, anon, authenticated;
revoke all on function save_set_list(uuid, text, timestamptz, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function publish_set_list(uuid, boolean) from public, anon, authenticated;
revoke all on function delete_set_list(uuid) from public, anon, authenticated;
revoke all on function list_set_lists() from public, anon, authenticated;
revoke all on function get_set_list(uuid) from public, anon, authenticated;
revoke all on function list_colour_plans() from public, anon, authenticated;
revoke all on function save_colour_plan(date, jsonb, text, boolean) from public, anon, authenticated;
revoke all on function delete_colour_plan(uuid) from public, anon, authenticated;
revoke all on function send_colour_reminders() from public, anon, authenticated;

grant execute on function ministry_id_of(text) to authenticated;
grant execute on function is_ministry_team(text) to authenticated;
grant execute on function is_ministry_leader(text) to authenticated;
grant execute on function my_ministries() to authenticated;
grant execute on function list_songs(text, boolean) to authenticated;
grant execute on function get_song(uuid) to authenticated;
grant execute on function save_song(uuid, text, text, jsonb) to authenticated;
grant execute on function set_song_archived(uuid, boolean) to authenticated;
grant execute on function create_set_list(text, timestamptz, uuid, uuid) to authenticated;
grant execute on function save_set_list(uuid, text, timestamptz, uuid, jsonb, text) to authenticated;
grant execute on function publish_set_list(uuid, boolean) to authenticated;
grant execute on function delete_set_list(uuid) to authenticated;
grant execute on function list_set_lists() to authenticated;
grant execute on function get_set_list(uuid) to authenticated;
grant execute on function list_colour_plans() to authenticated;
grant execute on function save_colour_plan(date, jsonb, text, boolean) to authenticated;
grant execute on function delete_colour_plan(uuid) to authenticated;
-- send_colour_reminders() is for the scheduled job only.

-- 18:00 South African time every day (16:00 UTC). If this errors, switch on pg_cron under Database > Extensions.
create extension if not exists pg_cron;
select cron.schedule('colour-reminders', '0 16 * * *', $job$select public.send_colour_reminders()$job$);
