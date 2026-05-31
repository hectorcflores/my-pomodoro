create extension if not exists pgcrypto;

create table if not exists public.focus_sessions (
  id uuid primary key default gen_random_uuid(),
  sync_key_hash text not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  duration_seconds integer not null default 1800,
  client_id text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists focus_sessions_sync_completed_idx
  on public.focus_sessions (sync_key_hash, completed_at desc)
  where deleted_at is null;

alter table public.focus_sessions enable row level security;

drop function if exists public.list_focus_sessions(text);
drop function if exists public.create_focus_session(text, timestamptz, timestamptz, integer, text);
drop function if exists public.undo_latest_focus_session(text);
drop function if exists public.undo_latest_focus_session(text, timestamptz);

create or replace function public.list_focus_sessions(p_sync_key_hash text)
returns table (
  id uuid,
  started_at timestamptz,
  completed_at timestamptz,
  duration_seconds integer,
  client_id text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $function$
  select
    fs.id,
    fs.started_at,
    fs.completed_at,
    fs.duration_seconds,
    fs.client_id,
    fs.created_at
  from public.focus_sessions
    as fs
  where fs.sync_key_hash = p_sync_key_hash
    and fs.deleted_at is null
  order by fs.completed_at asc;
$function$;

create or replace function public.create_focus_session(
  p_sync_key_hash text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_duration_seconds integer,
  p_client_id text
)
returns table (
  id uuid,
  started_at timestamptz,
  completed_at timestamptz,
  duration_seconds integer,
  client_id text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $function$
  insert into public.focus_sessions (
    sync_key_hash,
    started_at,
    completed_at,
    duration_seconds,
    client_id
  )
  values (
    p_sync_key_hash,
    p_started_at,
    p_completed_at,
    p_duration_seconds,
    p_client_id
  )
  returning
    public.focus_sessions.id,
    public.focus_sessions.started_at,
    public.focus_sessions.completed_at,
    public.focus_sessions.duration_seconds,
    public.focus_sessions.client_id,
    public.focus_sessions.created_at;
$function$;

create or replace function public.undo_latest_focus_session(
  p_sync_key_hash text,
  p_completed_after timestamptz
)
returns table (
  id uuid,
  started_at timestamptz,
  completed_at timestamptz,
  duration_seconds integer,
  client_id text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $function$
declare
  target_id uuid;
begin
  select fs.id
  into target_id
  from public.focus_sessions
    as fs
  where fs.sync_key_hash = p_sync_key_hash
    and fs.deleted_at is null
    and fs.completed_at >= p_completed_after
  order by fs.completed_at desc
  limit 1;

  if target_id is null then
    return;
  end if;

  update public.focus_sessions
  set deleted_at = now()
  where focus_sessions.id = target_id
  returning
    focus_sessions.id,
    focus_sessions.started_at,
    focus_sessions.completed_at,
    focus_sessions.duration_seconds,
    focus_sessions.client_id,
    focus_sessions.created_at
  into
    id,
    started_at,
    completed_at,
    duration_seconds,
    client_id,
    created_at;

  return next;
end;
$function$;

revoke all on public.focus_sessions from anon, authenticated;
grant execute on function public.list_focus_sessions(text) to anon;
grant execute on function public.create_focus_session(text, timestamptz, timestamptz, integer, text) to anon;
grant execute on function public.undo_latest_focus_session(text, timestamptz) to anon;
