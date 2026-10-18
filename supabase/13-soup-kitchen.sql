-- ===================================================================
-- CBC Sandton phase 2, step 5: the Soup Kitchen workspace
--
-- Run once in the Supabase SQL editor, after 12-praise-worship.sql.
-- It is safe to run again.
--
-- How it works:
--   * Volunteers are people with the ministry_member (or leader) role for Soup Kitchen.
--     That is the pool a team can be drawn from.
--   * A manager sets the rotation: for each month, who leads the team.
--   * Only that month's leader admits or removes the other team members, up to three
--     people in all (the leader plus two).
--   * The team of a month sees that month's workspace and nobody else's.
--     Managers can see every month, but only the leader changes the team.
--   * The leader hands out tasks (shopping, cooking, serving, clean up) with due dates
--     inside the month, optional checklists and an assignee.
--   * A reminder goes to the outgoing and the incoming team a few days before the
--     month changes, and an assignee is reminded the day before a task is due.
-- ===================================================================

create table if not exists kitchen_months (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  team_name text check (team_name is null or length(team_name) <= 60),
  leader_id uuid references auth.users(id) on delete set null,
  reminder_sent_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (church_id, month)
);

create table if not exists kitchen_members (
  month_id uuid not null references kitchen_months(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  church_id uuid not null references churches(id) on delete cascade,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (month_id, user_id)
);
create index if not exists kitchen_members_user on kitchen_members (user_id);

create table if not exists kitchen_tasks (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  month_id uuid not null references kitchen_months(id) on delete cascade,
  title text not null check (length(title) between 1 and 120),
  category text not null default 'other' check (category in ('shopping', 'cooking', 'serving', 'cleanup', 'other')),
  assignee_id uuid references auth.users(id) on delete set null,
  due_date date,
  done boolean not null default false,
  done_at timestamptz,
  notes text check (notes is null or length(notes) <= 1000),
  reminded_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists kitchen_tasks_month on kitchen_tasks (month_id, due_date);

create table if not exists kitchen_checks (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references kitchen_tasks(id) on delete cascade,
  church_id uuid not null references churches(id) on delete cascade,
  position int not null,
  text text not null check (length(text) between 1 and 120),
  done boolean not null default false
);
create index if not exists kitchen_checks_task on kitchen_checks (task_id, position);

alter table kitchen_months enable row level security;
alter table kitchen_members enable row level security;
alter table kitchen_tasks enable row level security;
alter table kitchen_checks enable row level security;

-- ---------- helpers ----------

create or replace function kitchen_current_month()
returns date
language sql
stable
as $$
  select date_trunc('month', now() at time zone 'Africa/Johannesburg')::date;
$$;

create or replace function kitchen_in_pool(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from role_grants g
    join ministries m on m.id = g.scope_id and m.slug = 'soup-kitchen'
    where g.user_id = p_user and g.role in ('ministry_member', 'ministry_leader') and g.scope_type = 'ministry'
      and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())
  );
$$;

create or replace function kitchen_is_member(p_month uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from kitchen_members k where k.month_id = p_month and k.user_id = auth.uid());
$$;

create or replace function kitchen_is_leader(p_month uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from kitchen_months m where m.id = p_month and m.leader_id = auth.uid());
$$;

-- Can this person see this month? The team and the managers.
create or replace function kitchen_can_see(p_month uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from kitchen_months m
    where m.id = p_month and m.church_id = my_church_id()
      and (has_role('platform_manager') or kitchen_is_member(m.id))
  );
$$;

create or replace function kitchen_person_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select m.full_name from members m where m.user_id = p_user limit 1),
                  (select p.full_name from profiles p where p.id = p_user));
$$;

drop policy if exists "team and managers read months" on kitchen_months;
create policy "team and managers read months" on kitchen_months for select using (kitchen_can_see(id));
drop policy if exists "team and managers read members" on kitchen_members;
create policy "team and managers read members" on kitchen_members for select using (kitchen_can_see(month_id));
drop policy if exists "team and managers read tasks" on kitchen_tasks;
create policy "team and managers read tasks" on kitchen_tasks for select using (kitchen_can_see(month_id));
drop policy if exists "team and managers read checks" on kitchen_checks;
create policy "team and managers read checks" on kitchen_checks for select
  using (exists (select 1 from kitchen_tasks t where t.id = task_id and kitchen_can_see(t.month_id)));
-- No one writes these tables directly: every change goes through the functions below, which enforce the rules.

-- ---------- the rotation (managers) ----------

create or replace function save_kitchen_month(p_month date, p_leader uuid, p_team_name text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := require_manager();
  v_month date;
  v_id uuid;
  v_old uuid;
  v_name text := nullif(btrim(coalesce(p_team_name, '')), '');
begin
  if p_month is null then
    raise exception 'Choose the month.';
  end if;
  v_month := date_trunc('month', p_month)::date;
  if v_month < kitchen_current_month() then
    raise exception 'That month has already passed.';
  end if;
  if p_leader is null or not exists (select 1 from members m where m.user_id = p_leader and m.church_id = v_church and m.is_active) then
    raise exception 'The team leader must be an active member with a login.';
  end if;
  if not kitchen_in_pool(p_leader) then
    raise exception 'The team leader must first be given the Soup Kitchen ministry role.';
  end if;

  select id, leader_id into v_id, v_old from kitchen_months where church_id = v_church and month = v_month;
  if v_id is null then
    insert into kitchen_months (church_id, month, team_name, leader_id, created_by)
    values (v_church, v_month, v_name, p_leader, auth.uid())
    returning id into v_id;
  else
    update kitchen_months set team_name = v_name, leader_id = p_leader where id = v_id;
    if v_old is distinct from p_leader and v_old is not null then
      delete from kitchen_members where month_id = v_id and user_id = v_old;
      update kitchen_tasks set assignee_id = null where month_id = v_id and assignee_id = v_old;
    end if;
  end if;
  insert into kitchen_members (month_id, user_id, church_id, added_by)
  values (v_id, p_leader, v_church, auth.uid())
  on conflict do nothing;

  if v_old is distinct from p_leader then
    perform notify_users(v_church, array[p_leader], 'kitchen',
      'You lead the Soup Kitchen team for ' || to_char(v_month, 'FMMonth YYYY'),
      'You can now choose the other two members of your team and plan the tasks.', 'ministries');
  end if;
  return v_id;
end;
$$;

create or replace function delete_kitchen_month(p_month uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_church uuid := require_manager();
  v_month date;
begin
  select month into v_month from kitchen_months where id = p_month and church_id = v_church;
  if v_month is null then
    raise exception 'That month was not found.';
  end if;
  if v_month < kitchen_current_month() then
    raise exception 'A month that has passed is kept as a record.';
  end if;
  delete from kitchen_months where id = p_month;
end;
$$;

-- Months with their leader and team size. Managers see all, everyone else only months they serve in.
create or replace function kitchen_schedule()
returns table (
  month_id uuid, month date, team_name text, leader_id uuid, leader_name text,
  member_count int, am_member boolean, am_leader boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.month, m.team_name, m.leader_id, kitchen_person_name(m.leader_id),
         (select count(*)::int from kitchen_members k where k.month_id = m.id),
         kitchen_is_member(m.id), m.leader_id = auth.uid()
  from kitchen_months m
  where m.church_id = my_church_id()
    and m.month >= (kitchen_current_month() - interval '1 month')
    and m.month <= (kitchen_current_month() + interval '8 months')
    and (has_role('platform_manager') or kitchen_is_member(m.id))
  order by m.month;
$$;

-- ---------- one month: the team and the tasks ----------

create or replace function get_kitchen_month(p_month uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', m.id, 'month', m.month, 'team_name', m.team_name, 'leader_id', m.leader_id,
    'leader_name', kitchen_person_name(m.leader_id),
    'is_leader', m.leader_id = auth.uid(),
    'is_manager', has_role('platform_manager'),
    'is_current', m.month = kitchen_current_month(),
    'is_past', m.month < kitchen_current_month(),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', k.user_id, 'name', kitchen_person_name(k.user_id), 'is_leader', k.user_id = m.leader_id) order by (k.user_id = m.leader_id) desc, k.added_at)
      from kitchen_members k where k.month_id = m.id
    ), '[]'::jsonb),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'title', t.title, 'category', t.category, 'assignee_id', t.assignee_id,
        'assignee_name', kitchen_person_name(t.assignee_id), 'due_date', t.due_date, 'done', t.done, 'notes', t.notes,
        'checklist', coalesce((
          select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'done', c.done) order by c.position)
          from kitchen_checks c where c.task_id = t.id
        ), '[]'::jsonb)
      ) order by t.done, t.due_date nulls last, t.created_at)
      from kitchen_tasks t where t.month_id = m.id
    ), '[]'::jsonb)
  )
  from kitchen_months m
  where m.id = p_month and kitchen_can_see(m.id);
$$;

-- Volunteers who could join this month's team. Only the leader (and managers, to help) may look.
create or replace function kitchen_pool(p_month uuid)
returns table (user_id uuid, full_name text)
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
  if not (kitchen_is_leader(p_month) or has_role('platform_manager')) then
    raise exception 'Only the team leader can do that.';
  end if;
  if not exists (select 1 from kitchen_months m where m.id = p_month and m.church_id = v_church) then
    raise exception 'That month was not found.';
  end if;
  return query
    select m.user_id, m.full_name
    from members m
    where m.church_id = v_church and m.is_active and m.user_id is not null
      and kitchen_in_pool(m.user_id)
      and not exists (select 1 from kitchen_members k where k.month_id = p_month and k.user_id = m.user_id)
    order by m.full_name;
end;
$$;

create or replace function kitchen_require_leader(p_month uuid)
returns kitchen_months
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  m kitchen_months;
begin
  if auth.uid() is null or my_church_id() is null then
    raise exception 'Please sign in.';
  end if;
  select * into m from kitchen_months where id = p_month and church_id = my_church_id();
  if not found then
    raise exception 'That month was not found.';
  end if;
  if m.leader_id is distinct from auth.uid() then
    raise exception 'Only the team leader can do that.';
  end if;
  return m;
end;
$$;

create or replace function admit_kitchen_member(p_month uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m kitchen_months := kitchen_require_leader(p_month);
begin
  if m.month < kitchen_current_month() then
    raise exception 'That month has already passed.';
  end if;
  if (select count(*) from kitchen_members k where k.month_id = p_month) >= 3 then
    raise exception 'A team has three people. Remove someone first.';
  end if;
  if not exists (select 1 from members x where x.user_id = p_user and x.church_id = m.church_id and x.is_active) then
    raise exception 'That person must be an active member with a login.';
  end if;
  if not kitchen_in_pool(p_user) then
    raise exception 'That person has not been given the Soup Kitchen ministry role.';
  end if;
  if exists (select 1 from kitchen_members k where k.month_id = p_month and k.user_id = p_user) then
    raise exception 'That person is already on the team.';
  end if;
  insert into kitchen_members (month_id, user_id, church_id, added_by) values (p_month, p_user, m.church_id, auth.uid());
  perform notify_users(m.church_id, array[p_user], 'kitchen',
    'You are on the Soup Kitchen team for ' || to_char(m.month, 'FMMonth YYYY'), 'Open the Soup Kitchen workspace to see your team and tasks.', 'ministries');
end;
$$;

create or replace function remove_kitchen_member(p_month uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m kitchen_months := kitchen_require_leader(p_month);
begin
  if m.month < kitchen_current_month() then
    raise exception 'That month has already passed.';
  end if;
  if p_user = m.leader_id then
    raise exception 'The team leader cannot be removed. Ask a manager to change the leader.';
  end if;
  delete from kitchen_members where month_id = p_month and user_id = p_user;
  if not found then
    raise exception 'That person is not on the team.';
  end if;
  update kitchen_tasks set assignee_id = null where month_id = p_month and assignee_id = p_user;
  perform notify_users(m.church_id, array[p_user], 'kitchen',
    'You are no longer on the Soup Kitchen team for ' || to_char(m.month, 'FMMonth YYYY'), 'Thank you for serving.', 'ministries');
end;
$$;

-- ---------- tasks ----------

create or replace function save_kitchen_task(
  p_month uuid, p_task uuid, p_title text, p_category text, p_assignee uuid, p_due date, p_notes text, p_checklist jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  m kitchen_months := kitchen_require_leader(p_month);
  v_id uuid := p_task;
  v_title text := btrim(coalesce(p_title, ''));
  elem jsonb;
  n int := 0;
  cid uuid;
  v_ids uuid[] := '{}';
begin
  if m.month < kitchen_current_month() then
    raise exception 'That month has already passed.';
  end if;
  if length(v_title) < 1 or length(v_title) > 120 then
    raise exception 'Give the task a title.';
  end if;
  if coalesce(p_category, 'other') not in ('shopping', 'cooking', 'serving', 'cleanup', 'other') then
    raise exception 'Choose shopping, cooking, serving, clean up or other.';
  end if;
  if p_assignee is not null and not exists (select 1 from kitchen_members k where k.month_id = p_month and k.user_id = p_assignee) then
    raise exception 'The task can only be given to someone on this month''s team.';
  end if;
  if p_due is not null and (p_due < m.month or p_due >= (m.month + interval '1 month')::date) then
    raise exception 'The due date must be inside the month.';
  end if;
  if p_checklist is null then
    p_checklist := '[]'::jsonb;
  end if;
  if jsonb_typeof(p_checklist) <> 'array' or jsonb_array_length(p_checklist) > 15 then
    raise exception 'A checklist can have at most 15 items.';
  end if;

  if v_id is null then
    if (select count(*) from kitchen_tasks t where t.month_id = p_month) >= 60 then
      raise exception 'A month can have at most 60 tasks.';
    end if;
    insert into kitchen_tasks (church_id, month_id, title, category, assignee_id, due_date, notes, created_by)
    values (m.church_id, p_month, v_title, coalesce(p_category, 'other'), p_assignee, p_due, nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
    returning id into v_id;
  else
    if not exists (select 1 from kitchen_tasks t where t.id = v_id and t.month_id = p_month) then
      raise exception 'That task was not found.';
    end if;
    update kitchen_tasks set title = v_title, category = coalesce(p_category, 'other'), assignee_id = p_assignee,
      due_date = p_due, notes = nullif(btrim(coalesce(p_notes, '')), ''),
      reminded_at = case when due_date is distinct from p_due or assignee_id is distinct from p_assignee then null else reminded_at end
    where id = v_id;
  end if;

  for elem in select * from jsonb_array_elements(p_checklist) loop
    n := n + 1;
    if length(btrim(coalesce(elem->>'text', ''))) < 1 or length(btrim(elem->>'text')) > 120 then
      raise exception 'Checklist item % needs some text.', n;
    end if;
    cid := nullif(elem->>'id', '')::uuid;
    if cid is not null and exists (select 1 from kitchen_checks c where c.id = cid and c.task_id = v_id) then
      update kitchen_checks set text = btrim(elem->>'text'), position = n, done = coalesce((elem->>'done')::boolean, done) where id = cid;
    else
      insert into kitchen_checks (task_id, church_id, position, text, done)
      values (v_id, m.church_id, n, btrim(elem->>'text'), coalesce((elem->>'done')::boolean, false))
      returning id into cid;
    end if;
    v_ids := v_ids || cid;
  end loop;
  delete from kitchen_checks where task_id = v_id and not (id = any(v_ids));
  return v_id;
end;
$$;

create or replace function delete_kitchen_task(p_task uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month uuid;
  m kitchen_months;
begin
  select month_id into v_month from kitchen_tasks where id = p_task;
  if v_month is null then
    raise exception 'That task was not found.';
  end if;
  m := kitchen_require_leader(v_month);
  if m.month < kitchen_current_month() then
    raise exception 'That month has already passed.';
  end if;
  delete from kitchen_tasks where id = p_task;
end;
$$;

-- The person it is given to, or the leader, ticks a task off.
create or replace function set_kitchen_task_done(p_task uuid, p_done boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t kitchen_tasks;
  m kitchen_months;
begin
  select * into t from kitchen_tasks where id = p_task and church_id = my_church_id();
  if not found then
    raise exception 'That task was not found.';
  end if;
  select * into m from kitchen_months where id = t.month_id;
  if not kitchen_is_member(t.month_id) or not (t.assignee_id = auth.uid() or m.leader_id = auth.uid()) then
    raise exception 'Only the person the task is given to, or the team leader, can tick it off.';
  end if;
  update kitchen_tasks set done = coalesce(p_done, false), done_at = case when coalesce(p_done, false) then now() else null end where id = p_task;
end;
$$;

-- Anyone on the team can tick a checklist item.
create or replace function set_kitchen_check(p_item uuid, p_done boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month uuid;
begin
  select t.month_id into v_month from kitchen_checks c join kitchen_tasks t on t.id = c.task_id
  where c.id = p_item and c.church_id = my_church_id();
  if v_month is null then
    raise exception 'That item was not found.';
  end if;
  if not kitchen_is_member(v_month) then
    raise exception 'Only the team can tick that.';
  end if;
  update kitchen_checks set done = coalesce(p_done, false) where id = p_item;
end;
$$;

-- For the home screen: how I am involved this month.
create or replace function my_kitchen()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'on_team', exists (select 1 from kitchen_months m join kitchen_members k on k.month_id = m.id
                       where m.church_id = my_church_id() and m.month = kitchen_current_month() and k.user_id = auth.uid()),
    'month_id', (select m.id from kitchen_months m join kitchen_members k on k.month_id = m.id
                 where m.church_id = my_church_id() and m.month = kitchen_current_month() and k.user_id = auth.uid()),
    'month', kitchen_current_month(),
    'next_turn', (select min(m.month) from kitchen_months m join kitchen_members k on k.month_id = m.id
                  where m.church_id = my_church_id() and m.month > kitchen_current_month() and k.user_id = auth.uid()),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'category', t.category, 'due_date', t.due_date) order by t.due_date nulls last)
      from kitchen_tasks t join kitchen_months m on m.id = t.month_id
      where t.assignee_id = auth.uid() and not t.done and m.church_id = my_church_id() and m.month = kitchen_current_month()
    ), '[]'::jsonb)
  )
  where auth.uid() is not null;
$$;

-- ---------- reminders (scheduled, not callable by signed in people) ----------

create or replace function send_rotation_reminders(p_today date default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  r kitchen_months;
  v_today date := coalesce(p_today, (now() at time zone 'Africa/Johannesburg')::date);
  v_out uuid;
begin
  for r in
    select * from kitchen_months m
    where m.reminder_sent_at is null
      and m.month = (date_trunc('month', v_today) + interval '1 month')::date
      and m.month - v_today between 1 and 3
  loop
    select id into v_out from kitchen_months where church_id = r.church_id and month = date_trunc('month', v_today)::date;
    insert into notifications (church_id, user_id, kind, title, body, link)
    select r.church_id, k.user_id, 'kitchen', 'Soup Kitchen: your month starts on ' || to_char(r.month, 'FMDD FMMonth'),
           'Please get ready to take over from the current team.', 'ministries'
    from kitchen_members k where k.month_id = r.id;
    if v_out is not null then
      insert into notifications (church_id, user_id, kind, title, body, link)
      select r.church_id, k.user_id, 'kitchen', 'Soup Kitchen: your month ends soon',
             'The next team starts on ' || to_char(r.month, 'FMDD FMMonth') || '. Please hand over and finish your tasks.', 'ministries'
      from kitchen_members k where k.month_id = v_out;
    end if;
    update kitchen_months set reminder_sent_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function send_kitchen_task_reminders(p_today date default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  t record;
begin
  for t in
    select k.id, k.church_id, k.title, k.assignee_id from kitchen_tasks k
    where not k.done and k.assignee_id is not null and k.reminded_at is null
      and k.due_date = coalesce(p_today, (now() at time zone 'Africa/Johannesburg')::date) + 1
  loop
    insert into notifications (church_id, user_id, kind, title, body, link)
    values (t.church_id, t.assignee_id, 'kitchen', 'Soup Kitchen task due tomorrow: ' || t.title, 'Open the Soup Kitchen workspace to see the details.', 'ministries');
    update kitchen_tasks set reminded_at = now() where id = t.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------- permissions ----------

revoke all on function kitchen_current_month() from public, anon;
revoke all on function kitchen_in_pool(uuid) from public, anon, authenticated;
revoke all on function kitchen_is_member(uuid) from public, anon, authenticated;
revoke all on function kitchen_is_leader(uuid) from public, anon, authenticated;
revoke all on function kitchen_can_see(uuid) from public, anon, authenticated;
revoke all on function kitchen_person_name(uuid) from public, anon, authenticated;
revoke all on function kitchen_require_leader(uuid) from public, anon, authenticated;
revoke all on function save_kitchen_month(date, uuid, text) from public, anon, authenticated;
revoke all on function delete_kitchen_month(uuid) from public, anon, authenticated;
revoke all on function kitchen_schedule() from public, anon, authenticated;
revoke all on function get_kitchen_month(uuid) from public, anon, authenticated;
revoke all on function kitchen_pool(uuid) from public, anon, authenticated;
revoke all on function admit_kitchen_member(uuid, uuid) from public, anon, authenticated;
revoke all on function remove_kitchen_member(uuid, uuid) from public, anon, authenticated;
revoke all on function save_kitchen_task(uuid, uuid, text, text, uuid, date, text, jsonb) from public, anon, authenticated;
revoke all on function delete_kitchen_task(uuid) from public, anon, authenticated;
revoke all on function set_kitchen_task_done(uuid, boolean) from public, anon, authenticated;
revoke all on function set_kitchen_check(uuid, boolean) from public, anon, authenticated;
revoke all on function my_kitchen() from public, anon, authenticated;
revoke all on function send_rotation_reminders(date) from public, anon, authenticated;
revoke all on function send_kitchen_task_reminders(date) from public, anon, authenticated;

grant execute on function kitchen_current_month() to authenticated;
grant execute on function kitchen_can_see(uuid) to authenticated;
grant execute on function save_kitchen_month(date, uuid, text) to authenticated;
grant execute on function delete_kitchen_month(uuid) to authenticated;
grant execute on function kitchen_schedule() to authenticated;
grant execute on function get_kitchen_month(uuid) to authenticated;
grant execute on function kitchen_pool(uuid) to authenticated;
grant execute on function admit_kitchen_member(uuid, uuid) to authenticated;
grant execute on function remove_kitchen_member(uuid, uuid) to authenticated;
grant execute on function save_kitchen_task(uuid, uuid, text, text, uuid, date, text, jsonb) to authenticated;
grant execute on function delete_kitchen_task(uuid) to authenticated;
grant execute on function set_kitchen_task_done(uuid, boolean) to authenticated;
grant execute on function set_kitchen_check(uuid, boolean) to authenticated;
grant execute on function my_kitchen() to authenticated;
-- the two reminder functions are for the scheduled job only.

-- 18:00 South African time every day (16:00 UTC). If this errors, switch on pg_cron under Database > Extensions.
create extension if not exists pg_cron;
select cron.schedule('kitchen-rotation-reminders', '0 16 * * *', $job$select public.send_rotation_reminders()$job$);
select cron.schedule('kitchen-task-reminders', '5 16 * * *', $job$select public.send_kitchen_task_reminders()$job$);
