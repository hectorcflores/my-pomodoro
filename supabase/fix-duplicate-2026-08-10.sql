-- One-time fix, 2026-08-10: hide the duplicated session from Aug 9
-- and make create_focus_session idempotent (matches supabase/schema.sql).
update public.focus_sessions set deleted_at = now()
where id = '5a1d2509-b274-48c7-a7d6-2935d1be0a9d';

drop function if exists public.create_focus_session(text, timestamptz, timestamptz, integer, text);
drop function if exists public.create_focus_session(text, timestamptz, timestamptz, integer, text, uuid);

create or replace function public.create_focus_session(
  p_sync_key_hash text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_duration_seconds integer,
  p_client_id text,
  p_id uuid default null
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
    id,
    sync_key_hash,
    started_at,
    completed_at,
    duration_seconds,
    client_id
  )
  values (
    coalesce(p_id, gen_random_uuid()),
    p_sync_key_hash,
    p_started_at,
    p_completed_at,
    p_duration_seconds,
    p_client_id
  )
  on conflict (id) do nothing
  returning
    public.focus_sessions.id,
    public.focus_sessions.started_at,
    public.focus_sessions.completed_at,
    public.focus_sessions.duration_seconds,
    public.focus_sessions.client_id,
    public.focus_sessions.created_at;
$function$;

grant execute on function public.create_focus_session(text, timestamptz, timestamptz, integer, text, uuid) to anon;
