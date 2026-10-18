-- ===================================================================
-- CBC Sandton dashboard: sermons (past services that have a recording)
--
-- Run once in the Supabase SQL editor, after 06-services-reminders.sql.
-- It is safe to run again.
--
-- A leader pastes the YouTube link on a service (before it, for the live
-- stream, or after it, for the recording). Once the service is over, it
-- moves from "This week" into the member's Sermons list.
-- ===================================================================

create or replace function my_sermons()
returns table (
  id uuid, title text, starts_at timestamptz, speaker text, theme text, scripture text,
  description text, stream_url text
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.title, s.starts_at, s.speaker, s.theme, s.scripture, s.description, s.stream_url
  from services s
  join members m on m.church_id = s.church_id
  where m.user_id = auth.uid() and m.is_active and s.is_published
    and s.stream_url is not null
    and coalesce(s.ends_at, s.starts_at + interval '3 hours') < now()
  order by s.starts_at desc
  limit 30;
$$;

revoke all on function my_sermons() from public;
grant execute on function my_sermons() to authenticated;
