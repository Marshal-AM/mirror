-- Paste into Supabase → SQL Editor → Run.
-- Then set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY on Vercel (server-only).

create table if not exists public.leads (
  address text primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  lead text,
  follower text,
  message text not null default '',
  meta jsonb,
  at timestamptz not null default now()
);

alter table public.leads enable row level security;
alter table public.alerts enable row level security;

-- API routes use the service role key (bypasses RLS). No anon policies.
