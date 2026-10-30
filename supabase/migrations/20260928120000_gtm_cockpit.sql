-- GTM cockpit (products/gtm-cockpit): content calendar mirror, post metrics, channel followers,
-- CRM funnel snapshots, enrichment runs, Zernio webhook events.
-- Written only by the cockpit's server/CLI with the secret key. Readable only by users whose
-- server-set app_metadata carries gtm_owner=true (app_metadata is not user-editable).

create table if not exists public.gtm_content_items (
  id text primary key,
  week int not null,
  date date not null,
  time text,
  pillar text not null,
  title text not null,
  format text not null,
  channels text[] not null default '{}',
  status text not null,
  link text,
  cta text,
  zernio_post_id text,
  published_at timestamptz,
  urls jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create index if not exists gtm_content_items_date_idx on public.gtm_content_items (date);
create index if not exists gtm_content_items_zernio_idx on public.gtm_content_items (zernio_post_id);

create table if not exists public.gtm_post_metrics (
  id bigserial primary key,
  zernio_post_id text not null,
  platform text not null,
  captured_at timestamptz not null,
  content_item_id text,
  is_external boolean not null default false,
  published_at timestamptz,
  platform_post_url text,
  content_preview text,
  impressions int not null default 0,
  reach int not null default 0,
  likes int not null default 0,
  comments int not null default 0,
  shares int not null default 0,
  saves int not null default 0,
  clicks int not null default 0,
  views int not null default 0,
  engagement_rate numeric
);
create index if not exists gtm_post_metrics_post_idx on public.gtm_post_metrics (zernio_post_id, platform, captured_at desc);

-- Latest snapshot per post and platform.
create or replace view public.gtm_post_metrics_latest with (security_invoker = true) as
select distinct on (zernio_post_id, platform) *
from public.gtm_post_metrics
order by zernio_post_id, platform, captured_at desc;

create table if not exists public.gtm_channel_daily (
  account_id text not null,
  platform text not null,
  username text,
  date date not null,
  followers int,
  active boolean not null default true,
  primary key (account_id, date)
);

create table if not exists public.gtm_crm_snapshots (
  date date primary key,
  captured_at timestamptz not null default now(),
  metrics jsonb not null,
  opportunities jsonb not null default '{}'
);

create table if not exists public.gtm_enrichment_runs (
  run text primary key,
  status text not null,
  selected int, submitted int, returned int, no_result int,
  saved int, conflicted int, failed int, credits int,
  cap_usd numeric,
  at timestamptz
);

-- Card spend from Wise, classified against products/gtm-cockpit/config/vendors.yaml.
create table if not exists public.gtm_spend (
  id text primary key,            -- Wise referenceNumber (CARD-...)
  date date not null,
  currency text not null,
  amount numeric not null,        -- positive = money out, in the charge currency
  amount_eur numeric,             -- converted at sync time (approximate for non-EUR)
  merchant text not null,
  vendor text,                    -- null = unclassified
  category text,
  gtm boolean not null default false
);
create index if not exists gtm_spend_date_idx on public.gtm_spend (date);

create table if not exists public.gtm_zernio_events (
  event_id text primary key,
  event text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['gtm_content_items','gtm_post_metrics','gtm_channel_daily',
                           'gtm_crm_snapshots','gtm_enrichment_runs','gtm_zernio_events','gtm_spend'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_read', t);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false))$p$, t || '_owner_read', t);
  end loop;
end $$;
revoke all on public.gtm_post_metrics_latest from anon, authenticated;
grant select on public.gtm_post_metrics_latest to authenticated;
grant all on public.gtm_post_metrics_latest to service_role;
grant usage, select on sequence public.gtm_post_metrics_id_seq to service_role;
