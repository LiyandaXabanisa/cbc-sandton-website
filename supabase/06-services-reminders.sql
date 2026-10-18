-- ===================================================================
-- CBC Sandton dashboard, slice 1: services and reminders
--
-- Run once in the Supabase SQL editor, after 02-website-integration.sql.
-- It is safe to run again.
--
--   services   what is happening on a given day (leaders write, members read)
--   reminders  short messages with a priority: urgent, important or normal
--
-- Leaders (anyone with a ChurchHub profile) manage both for their own church.
-- Members cannot read the tables directly. They call my_services() and
-- my_reminders(), which only ever return published items for their own church.
-- ===================================================================

create table if not exists services (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  title text not null check (length(title) between 1 and 120),
  starts_at timestamptz not null,
  ends_at timestamptz,
  venue text check (venue is null or length(venue) <= 200),
  stream_url text check (stream_url is null or (stream_url ~ '^https://' and length(stream_url) <= 500)),
  speaker text check (speaker is null or length(speaker) <= 120),
  theme text check (theme is null or length(theme) <= 200),
  scripture text check (scripture is null or length(scripture) <= 200),
  description text check (description is null or length(description) <= 4000),
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);
create index if not exists services_church_start on services (church_id, starts_at);

create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  title text not null check (length(title) between 1 and 120),
  body text check (body is null or length(body) <= 2000),
  priority text not null default 'normal' check (priority in ('urgent', 'important', 'normal')),
  publish_at timestamptz not null default now(),
  expires_at timestamptz,
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at is null or expires_at > publish_at)
);
create index if not exists reminders_church_publish on reminders (church_id, publish_at);

alter table services enable row level security;
alter table reminders enable row level security;

drop policy if exists "services in church" on services;
create policy "services in church" on services
  for all using (church_id = auth_church_id()) with check (church_id = auth_church_id());

drop policy if exists "reminders in church" on reminders;
create policy "reminders in church" on reminders
  for all using (church_id = auth_church_id()) with check (church_id = auth_church_id());

-- Members: services from a few hours ago up to the next 8 days
create or replace function my_services()
returns table (
  id uuid, title text, starts_at timestamptz, ends_at timestamptz, venue text, stream_url text,
  speaker text, theme text, scripture text, description text
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.title, s.starts_at, s.ends_at, s.venue, s.stream_url,
         s.speaker, s.theme, s.scripture, s.description
  from services s
  join members m on m.church_id = s.church_id
  where m.user_id = auth.uid() and m.is_active and s.is_published
    and coalesce(s.ends_at, s.starts_at + interval '3 hours') >= now()
    and s.starts_at < now() + interval '8 days'
  order by s.starts_at;
$$;

-- Members: reminders that are published, already started and not expired. Urgent first.
create or replace function my_reminders()
returns table (id uuid, title text, body text, priority text, publish_at timestamptz, expires_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.title, r.body, r.priority, r.publish_at, r.expires_at
  from reminders r
  join members m on m.church_id = r.church_id
  where m.user_id = auth.uid() and m.is_active and r.is_published
    and r.publish_at <= now()
    and (r.expires_at is null or r.expires_at > now())
  order by case r.priority when 'urgent' then 0 when 'important' then 1 else 2 end, r.publish_at desc;
$$;

revoke all on function my_services() from public;
revoke all on function my_reminders() from public;
grant execute on function my_services() to authenticated;
grant execute on function my_reminders() to authenticated;
