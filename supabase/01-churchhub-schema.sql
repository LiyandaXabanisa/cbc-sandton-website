-- ===================================================================
-- ChurchHub database schema (Supabase / Postgres)
-- Multi-tenant: every row is scoped to a church_id, and Row Level
-- Security guarantees a logged-in user can ONLY read/write rows that
-- belong to their own church. Run this in the Supabase SQL editor.
-- ===================================================================

-- ---------- Tables ----------

create table if not exists churches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  denomination text,
  city text,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  church_id uuid not null references churches(id) on delete cascade,
  full_name text not null,
  role text not null default 'admin' check (role in ('admin', 'staff')),
  created_at timestamptz not null default now()
);

create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  full_name text not null,
  phone text,
  email text,
  joined_at date,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists visitors (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  full_name text not null,
  phone text,
  how_heard text,
  first_visit date not null default current_date,
  followed_up boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists finance_entries (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  type text not null check (type in ('tithe', 'offering', 'donation', 'expense')),
  amount numeric(12,2) not null check (amount >= 0),
  category text,
  note text,
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists check_ins (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id) on delete cascade,
  member_id uuid references members(id) on delete set null,
  event_label text not null default 'Sunday Service',
  checked_in_at timestamptz not null default now()
);

-- ---------- Helper: current user's church ----------

create or replace function auth_church_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select church_id from profiles where id = auth.uid();
$$;

-- ---------- Enable RLS ----------

alter table churches enable row level security;
alter table profiles enable row level security;
alter table members enable row level security;
alter table visitors enable row level security;
alter table finance_entries enable row level security;
alter table check_ins enable row level security;

-- ---------- Policies ----------
-- A user can see their own church row; profiles in their church.

create policy "own church readable" on churches
  for select using (id = auth_church_id());

create policy "own profile readable" on profiles
  for select using (church_id = auth_church_id());

create policy "insert own profile" on profiles
  for insert with check (id = auth.uid());

-- Generic per-church tables: full access only within your church.
create policy "members in church" on members
  for all using (church_id = auth_church_id()) with check (church_id = auth_church_id());

create policy "visitors in church" on visitors
  for all using (church_id = auth_church_id()) with check (church_id = auth_church_id());

create policy "finance in church" on finance_entries
  for all using (church_id = auth_church_id()) with check (church_id = auth_church_id());

create policy "checkins in church" on check_ins
  for all using (church_id = auth_church_id()) with check (church_id = auth_church_id());

-- ---------- RPC: register a church + its first admin atomically ----------
-- Called right after auth.signUp(). Creates the church and links the new
-- auth user as its admin profile.

create or replace function create_church_with_admin(
  p_church_name text,
  p_denomination text,
  p_city text,
  p_admin_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_church_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  insert into churches (name, denomination, city)
  values (p_church_name, nullif(p_denomination, ''), nullif(p_city, ''))
  returning id into new_church_id;

  insert into profiles (id, church_id, full_name, role)
  values (auth.uid(), new_church_id, p_admin_name, 'admin');

  return new_church_id;
end;
$$;
