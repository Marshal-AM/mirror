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

create table if not exists public.outcomes (
  id uuid primary key default gen_random_uuid(),
  lead text not null,
  timestamp bigint not null,
  pnl_bps integer not null default 0,
  direction text,
  size_pct integer,
  tx_hash text,
  created_at timestamptz not null default now()
);

create index if not exists outcomes_lead_idx on public.outcomes (lead);

alter table public.leads enable row level security;
alter table public.alerts enable row level security;
alter table public.outcomes enable row level security;

-- API routes use the service role key (bypasses RLS). No anon policies.
