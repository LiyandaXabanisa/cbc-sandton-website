-- ===================================================================
-- CBC Sandton dashboard: the sermon library
--
-- Run once in the Supabase SQL editor, after 06-services-reminders.sql.
-- It is safe to run again.
--
-- Past sermons are recorded YouTube videos. A leader adds each one (title,
-- date preached, speaker, scripture, optional series, YouTube link) and
-- members watch them on the platform. Live streaming comes later and is
-- separate from this.
-- ===================================================================

create table if not exists sermons (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  title text not null check (length(title) between 1 and 120),
  preached_on date not null,
  speaker text check (speaker is null or length(speaker) <= 120),
  scripture text check (scripture is null or length(scripture) <= 200),
  series text check (series is null or length(series) <= 120),
  description text check (description is null or length(description) <= 4000),
  video_url text not null check (video_url ~ '^https://' and length(video_url) <= 500),
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sermons_church_date on sermons (church_id, preached_on desc);

alter table sermons enable row level security;

drop policy if exists "sermons in church" on sermons;
create policy "sermons in church" on sermons
  for all using (church_id = auth_church_id()) with check (church_id = auth_church_id());

-- An earlier draft of this function read from services, so replace it.
drop function if exists my_sermons();

create or replace function my_sermons()
returns table (
  id uuid, title text, preached_on date, speaker text, scripture text, series text,
  description text, video_url text
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.title, s.preached_on, s.speaker, s.scripture, s.series, s.description, s.video_url
  from sermons s
  join members m on m.church_id = s.church_id
  where m.user_id = auth.uid() and m.is_active and s.is_published
  order by s.preached_on desc, s.created_at desc
  limit 60;
$$;

revoke all on function my_sermons() from public;
grant execute on function my_sermons() to authenticated;
