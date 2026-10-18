-- ===================================================================
-- CBC Sandton: create the church and its first leader
--
-- Run AFTER 01-churchhub-schema.sql and 02-website-integration.sql.
--
-- Before running:
--   1. In Supabase open Authentication > Users > Add user > Create new user.
--      Use the leader's email and a strong password, and tick Auto Confirm User.
--   2. Replace LEADER-EMAIL and LEADER-FULL-NAME below.
--
-- The last line shows your church id. Copy it: it goes into
-- public/site.config.js (churchId) and into the member import.
-- ===================================================================

do $$
declare
  v_user uuid;
  v_church uuid;
begin
  select id into v_user from auth.users where lower(email) = lower('LEADER-EMAIL');
  if v_user is null then
    raise exception 'No login found for that email. Create the user under Authentication first.';
  end if;

  select id into v_church from churches where name = 'Change Bible Church Sandton' limit 1;
  if v_church is null then
    insert into churches (name, city) values ('Change Bible Church Sandton', 'Sandton')
    returning id into v_church;
  end if;

  insert into profiles (id, church_id, full_name, role)
  values (v_user, v_church, 'LEADER-FULL-NAME', 'admin')
  on conflict (id) do nothing;
end $$;

select id as church_id, name from churches where name = 'Change Bible Church Sandton';
