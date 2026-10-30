
alter table public.gtm_stories
  add column pipeline text check (pipeline in ('short', 'carousel', 'text', 'episode', 'video')),
  add column series text check (series ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  add column third_party_who text check (length(btrim(third_party_who)) between 1 and 200);

comment on column public.gtm_stories.pipeline is 'Per-format pipeline (vibrana-gtm lib/pipelines.ts). Null = legacy: one implicit final stage.';
comment on column public.gtm_stories.series is 'Series a piece belongs to, for batch review (e.g. example-shorts).';
comment on column public.gtm_stories.third_party_who is 'Who must approve the final before it may publish (e.g. example_approver / Example Series). Null = nobody.';

create index gtm_stories_series_idx on public.gtm_stories (series) where series is not null;

alter table public.gtm_story_asset_versions
  add column stage text check (stage ~ '^[a-z][a-z0-9-]{0,39}$'),
  add column changes text not null default '' check (length(changes) <= 2000),
  add column metadata jsonb not null default '{}';

create or replace function public.gtm_story_asset_versioned()
returns trigger language plpgsql set search_path = '' as $$
declare existing bigint; next_label text; meta jsonb; what text;
begin
  select count(*) into existing from public.gtm_story_asset_versions v where v.asset_id = new.id;
  next_label := case when existing = 0 then 'v1' else 'v1.' || existing end;
  meta := jsonb_strip_nulls(jsonb_build_object(
    'label', new.metadata -> 'label', 'review_points', new.metadata -> 'review_points', 'inputs', new.metadata -> 'inputs'));
  what := left(coalesce(new.metadata ->> 'changes', ''), 2000);
  insert into public.gtm_story_asset_versions
    (asset_id, revision, label, sha256, kind, title, source, storage_path, poster_path, body, stage, changes, metadata)
  values
    (new.id, new.revision, next_label, new.sha256, new.kind, new.title, new.source, new.storage_path,
     new.metadata ->> 'poster_path', new.body, new.stage, what, meta)
  on conflict (asset_id, revision) do update
    set sha256 = excluded.sha256, title = excluded.title, source = excluded.source,
        storage_path = excluded.storage_path, poster_path = excluded.poster_path, body = excluded.body,
        stage = excluded.stage, changes = excluded.changes, metadata = excluded.metadata;
  return null;
end $$;
revoke all on function public.gtm_story_asset_versioned() from public, anon, authenticated;

update public.gtm_story_asset_versions v
   set stage = a.stage
  from public.gtm_story_assets a
 where a.id = v.asset_id and a.revision = v.revision and a.stage is not null;

create table public.gtm_story_stages (
  story_id text not null references public.gtm_stories (id) on delete cascade,
  stage text not null check (stage ~ '^[a-z][a-z0-9-]{0,39}$'),
  status text not null check (status in ('todo', 'working', 'review', 'changes', 'approved', 'done', 'skipped', 'blocked')),
  note text not null default '' check (length(note) <= 2000),
  actor text check (length(actor) <= 200),
  updated_at timestamptz not null default now(),
  primary key (story_id, stage)
);

create table public.gtm_story_stage_decisions (
  id uuid primary key default gen_random_uuid(),
  story_id text not null references public.gtm_stories (id) on delete cascade,
  stage text not null check (stage ~ '^[a-z][a-z0-9-]{0,39}$'),
  party text not null check (party in ('john', 'third_party')),
  who text check (length(who) <= 200),
  decision text not null check (decision in ('approved', 'changes', 'reopened')),
  note text not null default '' check (length(note) <= 5000),
  assets jsonb not null default '[]' check (jsonb_typeof(assets) = 'array'),
  decided_by uuid,
  decided_at timestamptz not null default now()
);
create index gtm_story_stage_decisions_story_idx on public.gtm_story_stage_decisions (story_id, decided_at);

create function public.gtm_story_stage_decisions_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.gtm_stories s where s.id = old.story_id) then
    return old;
  end if;
  raise exception 'stage decisions are append-only' using errcode = 'insufficient_privilege';
end $$;
create trigger gtm_story_stage_decisions_append_only before update or delete on public.gtm_story_stage_decisions
  for each row execute function public.gtm_story_stage_decisions_append_only();
revoke all on function public.gtm_story_stage_decisions_append_only() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['gtm_story_stages', 'gtm_story_stage_decisions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false))$p$,
      t || '_owner_read', t);
  end loop;
end $$;

alter table public.gtm_story_feedback add column stage text check (stage ~ '^[a-z][a-z0-9-]{0,39}$');
update public.gtm_story_feedback f set stage = a.stage from public.gtm_story_assets a where a.id = f.asset_id and a.stage is not null;

create or replace function public.gtm_add_story_feedback(p_asset_id text, p_channel text, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid; current_revision bigint; current_stage text;
begin
  if (select auth.uid()) is null or
     not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false) then
    raise exception 'only the signed-in owner can leave Story feedback' using errcode = 'insufficient_privilege';
  end if;
  if p_body is null or length(btrim(p_body)) = 0 or length(p_body) > 5000 then
    raise exception 'invalid Story feedback' using errcode = 'invalid_parameter_value';
  end if;
  select a.revision, a.stage into current_revision, current_stage from public.gtm_story_assets a where a.id = p_asset_id;
  if current_revision is null then raise exception 'Story asset not found'; end if;
  insert into public.gtm_story_feedback (asset_id, channel, body, revision, stage)
    values (p_asset_id, p_channel, p_body, current_revision, current_stage)
    returning id into new_id;
  return new_id;
end $$;
revoke all on function public.gtm_add_story_feedback(text, text, text) from public, anon, authenticated;
grant execute on function public.gtm_add_story_feedback(text, text, text) to authenticated;

update public.gtm_stories s
   set pipeline = v.pipeline
  from (values
    ('s1-01-example-record-1', 'video'), ('s1-02-example-record-3', 'video'), ('s1-03-example-record-4', 'video'),
    ('s1-04-example-record-5', 'carousel'), ('s1-05-example-record-6', 'video'), ('s1-06-example-record-7', 'video'),
    ('s1-07-example-record-8', 'carousel'), ('s1-08-example-record-9', 'video'), ('s1-09-example-record-10', 'video'),
    ('s1-10-example-record-11', 'video'), ('s1-11-example-record-12', 'carousel'), ('s1-12-example-record-13', 'video'),
    ('s1-13-example-record-14', 'short'), ('s1-14-example-record-15', 'short'), ('s1-15-example-record-16', 'short'),
    ('s1-16-example-record-17', 'short'), ('s1-17-example-record-18', 'short')
  ) as v (id, pipeline)
 where s.id = v.id and s.pipeline is null;

insert into public.gtm_story_stages (story_id, stage, status, note, actor)
select s.id, st.stage, 'done', 'made before stages existed', 'backfill'
  from public.gtm_stories s
  join (values
    ('short', 'paper-edit'), ('short', 'rough-cut'), ('short', 'enhance-plan'), ('short', 'broll'), ('short', 'motion'), ('short', 'finish'),
    ('carousel', 'copy'), ('carousel', 'slide-copy'), ('video', 'storyboard'), ('video', 'motion')
  ) as st (pipeline, stage) on st.pipeline = s.pipeline
 where s.id ~ '^s1-(0[1-9]|1[0-7])-'
on conflict do nothing;

update public.gtm_stories
   set pipeline = 'short', series = 'example-shorts', third_party_who = 'example_approver / Example Series'
 where id ~ '^s1-(18|19|20|21|22)-example-record-';

insert into public.gtm_story_stages (story_id, stage, status, note, actor)
select s.id, 'paper-edit', 'approved', 'Reviewed example paper edit', 'backfill'
  from public.gtm_stories s where s.id ~ '^s1-(18|19|20|21|22)-example-record-'
on conflict do nothing;

insert into public.gtm_story_stages (story_id, stage, status, note, actor)
select s.id, 'rough-cut',
       case
         when bool_or(c.status = 'rejected') then 'changes'
         when count(c.*) > 0 and bool_and(c.status = 'approved' and c.approved_sha256 = a.sha256) then 'approved'
         else 'review'
       end,
       '', 'backfill'
  from public.gtm_stories s
  join public.gtm_story_assets a on a.story_id = s.id and a.kind = 'video' and a.stage = 'rough-cut'
  left join public.gtm_story_asset_channels c on c.asset_id = a.id
 where s.id ~ '^s1-(18|19|20|21|22)-example-record-'
 group by s.id
on conflict do nothing;
