-- Backlog schema for reviewed local ideas and their promotion links.
create table public.gtm_ideas (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  title text not null check (length(btrim(title)) between 1 and 300),
  -- What the idea is and the bet it makes: "if we ship X, Y happens because Z".
  summary text not null default '' check (length(summary) <= 5000),
  kind text not null default 'content' check (kind in ('content', 'engagement', 'lead_magnet', 'tool', 'other')),
  -- Slugs from vibrana-gtm content/guide/pillars.json, as on gtm_content_candidates.
  pillar text check (pillar in ('proof', 'perspective', 'build', 'lists')),
  format text check (format in ('text', 'carousel', 'video', 'newsletter', 'app', 'other')),
  effort text check (effort in ('s', 'm', 'l')),
  impact smallint check (impact between 1 and 5),
  status text not null default 'idea' check (status in ('idea', 'shortlisted', 'in_production', 'shipped', 'parked')),
  source_url text check (source_url ~ '^https?://\S+$' and length(source_url) <= 2000),
  owner text check (length(btrim(owner)) between 1 and 200),
  tags text[] not null default '{}' check (cardinality(tags) <= 20 and array_position(tags, null) is null),
  promoted_candidate_id uuid references public.gtm_content_candidates (id) on delete set null,
  promoted_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gtm_ideas_promoted check (promoted_candidate_id is null or promoted_at is not null)
);
create index gtm_ideas_status_idx on public.gtm_ideas (status, updated_at desc);
create index gtm_ideas_candidate_idx on public.gtm_ideas (promoted_candidate_id) where promoted_candidate_id is not null;

-- ---- access: owner reads, service role writes --------------------------------------------------------

alter table public.gtm_ideas enable row level security;
revoke all on public.gtm_ideas from anon, authenticated;
grant select on public.gtm_ideas to authenticated;
grant all on public.gtm_ideas to service_role;
create policy gtm_ideas_owner_read on public.gtm_ideas for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
