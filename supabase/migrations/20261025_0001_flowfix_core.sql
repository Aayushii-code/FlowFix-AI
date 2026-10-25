-- FLOWFIX AI | Supabase Postgres Core Schema | 2026-10-25
-- Apply once from Supabase > SQL Editor as project administrator.
-- No demo users, fake runs, fake verdicts, or payments inserted.
-- All customer data is workspace-scoped and protected by RLS.

create extension if not exists pgcrypto;

-- Draft plan entitlements (NOT proof of payment / not activated paid subscriptions).
create table if not exists public.ff_plan_catalog (
  code text primary key check (code in ('free','pro','business')),
  display_name text not null,
  monthly_runs_limit integer not null check (monthly_runs_limit > 0),
  public_signup_enabled boolean not null default false,
  created_at timestamptz not null default now()
);
insert into public.ff_plan_catalog (code, display_name, monthly_runs_limit, public_signup_enabled)
values ('free','Free',3,true),('pro','Pro (planned)',100,false),('business','Business (planned)',1000,false)
on conflict (code) do nothing;

create table if not exists public.ff_workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 100),
  created_by uuid not null references auth.users(id),
  plan_code text not null default 'free' references public.ff_plan_catalog(code),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Free-account abuse mitigation (MVP): each user can own one workspace.
create unique index if not exists ff_workspaces_one_owner on public.ff_workspaces(created_by);

create table if not exists public.ff_workspace_members (
  workspace_id uuid not null references public.ff_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','member')),
  joined_at timestamptz not null default now(),
  primary key (workspace_id,user_id)
);
create index if not exists ff_members_user_idx on public.ff_workspace_members(user_id,workspace_id);

create table if not exists public.ff_projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.ff_workspaces(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 120),
  base_url text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create index if not exists ff_projects_workspace_idx on public.ff_projects(workspace_id,created_at desc);

create table if not exists public.ff_test_definitions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.ff_workspaces(id) on delete cascade,
  project_id uuid not null,
  name text not null check (char_length(btrim(name)) between 2 and 160),
  requirement text not null check (char_length(btrim(requirement)) between 12 and 20000),
  checks jsonb not null default '[]'::jsonb check (jsonb_typeof(checks) = 'array'),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, workspace_id) references public.ff_projects(id,workspace_id) on delete cascade,
  unique (id,workspace_id)
);
create index if not exists ff_tests_workspace_idx on public.ff_test_definitions(workspace_id,updated_at desc);

-- Immutable-through-API execution evidence must be written by trusted backend only.
-- Execution ID maps 1:1 to Aayushi's /api/executions/:id UUID.
create table if not exists public.ff_executions (
  id uuid primary key,
  workspace_id uuid not null references public.ff_workspaces(id) on delete cascade,
  project_id uuid,
  test_definition_id uuid,
  created_by uuid references auth.users(id),
  url text not null check (char_length(url) between 8 and 4000),
  requirement text,
  goal text,
  expected_outcome jsonb,
  status text not null default 'QUEUED' check (status in ('QUEUED','RUNNING','COMPLETED','FAILED','TIMED_OUT','CANCELLED','INCOMPLETE')),
  tinyfish_run_id text,
  observations jsonb,
  evidence jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (project_id,workspace_id) references public.ff_projects(id,workspace_id),
  foreign key (test_definition_id,workspace_id) references public.ff_test_definitions(id,workspace_id),
  unique (id,workspace_id)
);
create index if not exists ff_executions_workspace_created_idx on public.ff_executions(workspace_id,created_at desc);
create index if not exists ff_executions_status_idx on public.ff_executions(workspace_id,status);

create table if not exists public.ff_verifications (
  execution_id uuid primary key,
  workspace_id uuid not null,
  status text not null check (status in ('PENDING','RUNNING','COMPLETED','UNAVAILABLE','ERROR','SKIPPED')),
  verdict text check (verdict in ('PASS','FAIL','INCONCLUSIVE')),
  summary text,
  checks jsonb not null default '[]'::jsonb check (jsonb_typeof(checks)='array'),
  verification_engine text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (execution_id,workspace_id) references public.ff_executions(id,workspace_id) on delete cascade,
  constraint ff_verdict_only_if_completed check (
    (status = 'COMPLETED' and verdict is not null) or (status <> 'COMPLETED' and verdict is null)
  )
);
create index if not exists ff_verifications_workspace_idx on public.ff_verifications(workspace_id,created_at desc);

create table if not exists public.ff_subscriptions (
  workspace_id uuid primary key references public.ff_workspaces(id) on delete cascade,
  plan_code text not null references public.ff_plan_catalog(code),
  state text not null default 'inactive' check (state in ('inactive','trialing','active','past_due','cancelled')),
  payment_provider text,
  provider_subscription_id text unique,
  current_period_start timestamptz,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);
-- Paid subscriptions are NOT activated by this migration.

-- Each reservation starts before a provider run, with an independent request UUID.
-- Only trusted backend can create/settle usage; frontend cannot increase quota.
create table if not exists public.ff_monthly_usage (
  workspace_id uuid not null references public.ff_workspaces(id) on delete cascade,
  period_start date not null,
  reserved_count integer not null default 0 check (reserved_count >= 0),
  consumed_count integer not null default 0 check (consumed_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id,period_start)
);
create table if not exists public.ff_run_reservations (
  workspace_id uuid not null references public.ff_workspaces(id) on delete cascade,
  request_id uuid not null,
  execution_id uuid unique,
  period_start date not null,
  state text not null default 'reserved' check (state in ('reserved','consumed','released')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  primary key (workspace_id,request_id)
);

create table if not exists public.ff_audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.ff_workspaces(id) on delete cascade,
  execution_id uuid,
  actor_user_id uuid,
  action text not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now()
);
create index if not exists ff_audit_workspace_idx on public.ff_audit_events(workspace_id,created_at desc);

-- Automatic timestamps for writes by trusted server.
create or replace function public.ff_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;

do $$ declare name text; begin
 foreach name in array array['ff_workspaces','ff_projects','ff_test_definitions','ff_executions','ff_verifications','ff_subscriptions','ff_monthly_usage'] loop
   if not exists(select 1 from pg_trigger where tgname = name || '_touch') then
     execute format('create trigger %I before update on public.%I for each row execute function public.ff_touch_updated_at()',name || '_touch',name);
   end if;
 end loop;
end $$;

-- Membership functions run as owner, with closed search_path and explicit user check.
create or replace function public.ff_is_member(p_workspace_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.ff_workspace_members m
    where m.workspace_id=p_workspace_id and m.user_id=(select auth.uid())
  );
$$;
create or replace function public.ff_is_owner(p_workspace_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.ff_workspace_members m
    where m.workspace_id=p_workspace_id and m.user_id=(select auth.uid()) and m.role='owner'
  );
$$;

-- Authenticated user creates their FIRST workspace with self as owner.
-- Called via Supabase .rpc('ff_create_workspace', { p_name: 'My workspace' }).
create or replace function public.ff_create_workspace(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_id uuid;
begin
 v_user := auth.uid();
 if v_user is null then raise exception 'Authentication required'; end if;
 if p_name is null or char_length(btrim(p_name)) not between 2 and 100 then
   raise exception 'Workspace name length must be 2..100';
 end if;
 insert into public.ff_workspaces(name,created_by) values (btrim(p_name),v_user) returning id into v_id;
 insert into public.ff_workspace_members(workspace_id,user_id,role) values(v_id,v_user,'owner');
 return v_id;
end; $$;

-- Atomic quota protection: serialize writes by locking parent workspace row.
-- MUST be executed by backend BEFORE starting TinyFish. Idempotent by request_id.
create or replace function public.ff_reserve_run(p_workspace_id uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_plan text; v_limit integer; v_period date;
        v_used integer; v_reserved integer; v_existing text;
begin
 if p_workspace_id is null or p_request_id is null then raise exception 'Missing workspace/request UUID'; end if;
 select plan_code into v_plan from public.ff_workspaces where id=p_workspace_id for update;
 if not found then raise exception 'Workspace not found'; end if;
 select state into v_existing from public.ff_run_reservations
  where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
   return jsonb_build_object('state',v_existing,'already_exists',true);
 end if;
 select monthly_runs_limit into v_limit from public.ff_plan_catalog where code=v_plan;
 if v_limit is null then raise exception 'Unknown plan'; end if;
 v_period := date_trunc('month',now() at time zone 'UTC')::date;
 insert into public.ff_monthly_usage(workspace_id,period_start)
 values (p_workspace_id,v_period) on conflict do nothing;
 select consumed_count,reserved_count into v_used,v_reserved
 from public.ff_monthly_usage where workspace_id=p_workspace_id and period_start=v_period for update;
 if v_used+v_reserved >= v_limit then
   raise exception 'Monthly run limit reached' using errcode = 'P0001';
 end if;
 insert into public.ff_run_reservations(workspace_id,request_id,period_start)
 values(p_workspace_id,p_request_id,v_period);
 update public.ff_monthly_usage set reserved_count=reserved_count+1
 where workspace_id=p_workspace_id and period_start=v_period;
 return jsonb_build_object('state','reserved','already_exists',false,'remaining',v_limit-v_used-v_reserved-1);
end; $$;

-- Settle reservation. count_as_used=true if run incurred charge; false if no provider call.
create or replace function public.ff_settle_run(
 p_workspace_id uuid,p_request_id uuid,p_execution_id uuid,p_count_as_used boolean default true
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_state text; v_period date; v_new text;
begin
 select state,period_start into v_state,v_period
 from public.ff_run_reservations where workspace_id=p_workspace_id and request_id=p_request_id for update;
 if not found then raise exception 'Reservation not found'; end if;
 if v_state <> 'reserved' then return jsonb_build_object('state',v_state,'already_settled',true); end if;
 v_new := case when p_count_as_used then 'consumed' else 'released' end;
 update public.ff_run_reservations set state=v_new,execution_id=p_execution_id,settled_at=now()
 where workspace_id=p_workspace_id and request_id=p_request_id;
 update public.ff_monthly_usage
 set reserved_count=reserved_count-1,
 consumed_count=consumed_count + case when p_count_as_used then 1 else 0 end
 where workspace_id=p_workspace_id and period_start=v_period;
 return jsonb_build_object('state',v_new,'already_settled',false);
end; $$;

-- Explicit RLS on all exposed tables, including catalog.
do $$ declare name text; begin
 foreach name in array array['ff_plan_catalog','ff_workspaces','ff_workspace_members','ff_projects','ff_test_definitions','ff_executions','ff_verifications','ff_subscriptions','ff_monthly_usage','ff_run_reservations','ff_audit_events'] loop
   execute format('alter table public.%I enable row level security',name);
   execute format('revoke all on table public.%I from anon, authenticated',name);
   execute format('grant select,insert,update,delete on table public.%I to service_role',name);
 end loop;
end $$;

-- Signed-in users may read authorized rows, but ONLY trusted services write runs,
-- verdicts, plans, billing, and quotas. Future editable test APIs need separate policies.
grant select on public.ff_plan_catalog,public.ff_workspaces,public.ff_workspace_members,
 public.ff_projects,public.ff_test_definitions,public.ff_executions,public.ff_verifications,
 public.ff_subscriptions,public.ff_monthly_usage,public.ff_run_reservations,
 public.ff_audit_events to authenticated;

create policy ff_catalog_read on public.ff_plan_catalog for select to authenticated using(true);
create policy ff_workspaces_read on public.ff_workspaces for select to authenticated using(public.ff_is_member(id));
create policy ff_members_read on public.ff_workspace_members for select to authenticated using(public.ff_is_member(workspace_id));
create policy ff_projects_read on public.ff_projects for select to authenticated using(public.ff_is_member(workspace_id));
create policy ff_tests_read on public.ff_test_definitions for select to authenticated using(public.ff_is_member(workspace_id));
create policy ff_executions_read on public.ff_executions for select to authenticated using(public.ff_is_member(workspace_id));
create policy ff_verifications_read on public.ff_verifications for select to authenticated using(public.ff_is_member(workspace_id));
create policy ff_subscriptions_owner_read on public.ff_subscriptions for select to authenticated using(public.ff_is_owner(workspace_id));
create policy ff_usage_read on public.ff_monthly_usage for select to authenticated using(public.ff_is_member(workspace_id));
create policy ff_reservations_read on public.ff_run_reservations for select to authenticated using(public.ff_is_member(workspace_id));
create policy ff_audit_read on public.ff_audit_events for select to authenticated using(public.ff_is_member(workspace_id));

-- SECURITY DEFINER functions: REVOKE default PUBLIC execute, grant minimal roles.
revoke all on function public.ff_is_member(uuid) from public,anon,authenticated;
revoke all on function public.ff_is_owner(uuid) from public,anon,authenticated;
revoke all on function public.ff_create_workspace(text) from public,anon,authenticated;
revoke all on function public.ff_reserve_run(uuid,uuid) from public,anon,authenticated;
revoke all on function public.ff_settle_run(uuid,uuid,uuid,boolean) from public,anon,authenticated;
revoke all on function public.ff_touch_updated_at() from public,anon,authenticated;
grant execute on function public.ff_is_member(uuid),public.ff_is_owner(uuid),public.ff_create_workspace(text) to authenticated;
grant execute on function public.ff_reserve_run(uuid,uuid),public.ff_settle_run(uuid,uuid,uuid,boolean) to service_role;

-- No broad PUBLIC write grants, no payment activation, no fake run records.
-- Sequence grants required for INSERTs into identity-backed audit table.
grant usage,select on sequence public.ff_audit_events_id_seq to service_role;
grant execute on function public.ff_touch_updated_at() to service_role;
