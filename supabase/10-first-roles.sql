-- ===================================================================
-- CBC Sandton phase 2: the first roles
--
-- Run after 08-roles.sql. It is safe to run again (nobody gets the same role twice).
--
-- The database owner sets the very first roles, because nobody can grant themselves
-- authority. After this, managers give roles from inside the platform.
--
-- Before running, find each person's User UID: Supabase > Authentication > Users.
-- A person needs a login first (a member activates one with an invite code from the
-- leaders area, or you add one under Authentication > Users). Replace the placeholders
-- below, and delete the lines for anyone who does not have a login yet.
--
--   YOUR-USER-ID     the church IT administrator: Platform Manager, and Senior Pastor for now
--   TSHEPO-USER-ID   Tshepo Tselapedi, Platform Manager
--   PASTOR-USER-ID   Pastor FJK Khoza, Senior Pastor (when he has a login)
--
-- The Senior Pastor role is held by the IT administrator only until Pastor Khoza has a login.
-- Then give it to him and remove it from the administrator (Settings, People and roles).
-- ===================================================================

do $$
declare
  v_church uuid := (select id from churches where name = 'Change Bible Church Sandton' limit 1);
begin
  if v_church is null then
    raise exception 'The church was not found. Run 03-first-church.sql first.';
  end if;

  insert into role_grants (church_id, user_id, role)
  select v_church, t.uid, t.role
  from (values
    ('YOUR-USER-ID'::uuid, 'platform_manager'),
    ('YOUR-USER-ID'::uuid, 'senior_pastor'),
    ('TSHEPO-USER-ID'::uuid, 'platform_manager')
    -- , ('PASTOR-USER-ID'::uuid, 'senior_pastor')
  ) as t(uid, role)
  where not exists (
    select 1 from role_grants g
    where g.user_id = t.uid and g.role = t.role and g.church_id = v_church and g.revoked_at is null
  );

  insert into audit_log (church_id, actor_id, action, role, detail)
  values (v_church, null, 'seeded', null, jsonb_build_object('note', 'first roles set by the database owner'));
end $$;

select r.role, coalesce(m.full_name, p.full_name) as person, r.granted_at
from role_grants r
left join members m on m.user_id = r.user_id
left join profiles p on p.id = r.user_id
where r.revoked_at is null
order by r.role, person;
