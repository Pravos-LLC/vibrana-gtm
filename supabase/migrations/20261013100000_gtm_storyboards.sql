
create table public.gtm_storyboards (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,159}$'),
  story_id text not null references public.gtm_stories (id) on delete cascade,
  stage text not null check (stage ~ '^[a-z][a-z0-9-]{0,39}$' and stage <> 'final'),
  format text not null check (format in ('short', 'episode', 'carousel', 'motion-video')),
  series text check (series ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  title text not null check (length(btrim(title)) between 1 and 300),
  current_version int not null default 0 check (current_version >= 0),
  status text not null default 'draft' check (status in ('draft', 'review', 'changes', 'approved', 'superseded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (story_id, stage)
);
create index gtm_storyboards_series_idx on public.gtm_storyboards (stage, series);

create table public.gtm_storyboard_versions (
  storyboard_id text not null references public.gtm_storyboards (id) on delete cascade,
  version int not null check (version >= 1),
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  doc_sha text not null check (doc_sha ~ '^[a-f0-9]{64}$'),
  schema text not null check (schema ~ '^vibrana\.storyboard/[0-9]+$'),
  scene_shas jsonb not null check (jsonb_typeof(scene_shas) = 'object'),
  changes text not null default '' check (length(changes) <= 4000),
  produced_by text not null check (length(btrim(produced_by)) between 1 and 200),
  motion_sha text check (motion_sha ~ '^[a-f0-9]{64}$'),
  motion_path text check (motion_path in ('motion.so', 'code-studio')),
  credit_cap numeric check (credit_cap >= 0),
  rule_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (storyboard_id, version)
);

create table public.gtm_storyboard_rules (
  id uuid primary key default gen_random_uuid(),
  format text not null check (format in ('short', 'episode', 'carousel', 'motion-video')),
  series text check (series ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  category text check (category in ('layout', 'graphics', 'broll', 'hook', 'motion', 'captions', 'audio', 'edit', 'credits')),
  rule text not null check (length(btrim(rule)) between 3 and 500),
  check_spec jsonb check (check_spec is null or jsonb_typeof(check_spec) = 'object'),
  conflicts_with text check (length(conflicts_with) <= 500),
  conflict_resolution text not null default '' check (length(conflict_resolution) <= 1000),
  skill text check (skill ~ '^[a-z][a-z0-9-]{0,79}$'),
  evidence uuid[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'retired')),
  source text not null default 'john' check (source in ('john', 'learned')),
  synced_skill_sha text check (synced_skill_sha ~ '^[a-f0-9]{7,40}$'),
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
create index gtm_storyboard_rules_scope_idx on public.gtm_storyboard_rules (format, series) where status = 'active';

create table public.gtm_storyboard_comments (
  id uuid primary key default gen_random_uuid(),
  storyboard_id text not null,
  version int not null,
  anchor jsonb not null default '{}' check (jsonb_typeof(anchor) = 'object'),
  kind text not null check (kind in ('note', 'swap', 'retime', 'crop', 'reselect', 'add', 'drop', 'brief', 'choice')),
  body text not null check (length(btrim(body)) between 1 and 5000),
  proposal jsonb check (proposal is null or jsonb_typeof(proposal) = 'object'),
  scope text not null default 'this' check (scope in ('this', 'series', 'format')),
  rule_id uuid references public.gtm_storyboard_rules (id) on delete set null,
  batch_id uuid,
  author text not null default 'john' check (author ~ '^(john|lint|agent|third_party:.{1,100})$'),
  status text not null default 'open' check (status in ('open', 'addressed', 'resolved', 'withdrawn', 'wontfix')),
  addressed_in int,
  resolution text not null default '' check (length(resolution) <= 4000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (storyboard_id, version) references public.gtm_storyboard_versions (storyboard_id, version) on delete cascade
);
create index gtm_storyboard_comments_board_idx on public.gtm_storyboard_comments (storyboard_id, version);
create index gtm_storyboard_comments_open_idx on public.gtm_storyboard_comments (storyboard_id) where status in ('open', 'addressed');
create index gtm_storyboard_comments_rule_idx on public.gtm_storyboard_comments (rule_id) where rule_id is not null;
create index gtm_storyboard_comments_batch_idx on public.gtm_storyboard_comments (batch_id) where batch_id is not null;

create table public.gtm_storyboard_scene_decisions (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  storyboard_id text not null,
  version int not null,
  scene_id text not null check (scene_id ~ '^[a-z0-9][a-z0-9_.-]{0,79}$'),
  scene_sha text not null check (scene_sha ~ '^[a-f0-9]{64}$'),
  decision text not null check (decision in ('approved', 'changes', 'cleared')),
  note text not null default '' check (length(note) <= 5000),
  decided_by uuid,
  decided_at timestamptz not null default now(),
  foreign key (storyboard_id, version) references public.gtm_storyboard_versions (storyboard_id, version) on delete cascade
);
create index gtm_storyboard_scene_decisions_idx on public.gtm_storyboard_scene_decisions (storyboard_id, scene_id, scene_sha, seq);
create index gtm_storyboard_scene_decisions_version_idx on public.gtm_storyboard_scene_decisions (storyboard_id, version);

create table public.gtm_storyboard_spend (
  id uuid primary key default gen_random_uuid(),
  storyboard_id text not null,
  version int not null,
  kind text not null check (kind in ('authorized', 'spent')),
  credits numeric not null check (credits >= 0),
  balance_after numeric,
  motion_sha text check (motion_sha ~ '^[a-f0-9]{64}$'),
  job_id text check (length(job_id) <= 200),
  note text not null default '' check (length(note) <= 2000),
  at timestamptz not null default now(),
  foreign key (storyboard_id, version) references public.gtm_storyboard_versions (storyboard_id, version) on delete cascade
);
create index gtm_storyboard_spend_board_idx on public.gtm_storyboard_spend (storyboard_id, version);

create table public.gtm_broll_shots (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_.-]{0,79}$'),
  library text not null default '' check (length(library) <= 200),
  file text not null check (length(file) between 1 and 500),
  src_in numeric, src_out numeric,
  description text not null default '' check (length(description) <= 2000),
  tags text[] not null default '{}',
  orientation text check (length(orientation) <= 40),
  resolution text check (length(resolution) <= 40),
  vertical_crop_ok boolean,
  crop_note text check (length(crop_note) <= 1000),
  people_identifiable boolean,
  sensitivity text check (length(sensitivity) <= 500),
  license text check (length(license) <= 300),
  attribution text check (length(attribution) <= 500),
  source_url text check (length(source_url) <= 1000),
  quality int check (quality between 0 and 5),
  beat text check (length(beat) <= 200),
  do_not_use boolean not null default false,
  do_not_use_reason text check (length(do_not_use_reason) <= 500),
  proxy_path text, poster_path text,
  catalog_sha text check (catalog_sha ~ '^[a-f0-9]{64}$'),
  synced_at timestamptz not null default now()
);
create index gtm_broll_shots_beat_idx on public.gtm_broll_shots (beat) where beat is not null;

create function public.gtm_storyboard_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.gtm_storyboards s where s.id = old.storyboard_id) then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end $$;
revoke all on function public.gtm_storyboard_append_only() from public, anon, authenticated;
create trigger gtm_storyboard_versions_append_only before update or delete on public.gtm_storyboard_versions
  for each row execute function public.gtm_storyboard_append_only();
create trigger gtm_storyboard_scene_decisions_append_only before update or delete on public.gtm_storyboard_scene_decisions
  for each row execute function public.gtm_storyboard_append_only();

do $$
declare t text;
begin
  foreach t in array array['gtm_storyboards', 'gtm_storyboard_versions', 'gtm_storyboard_rules', 'gtm_storyboard_comments',
                           'gtm_storyboard_scene_decisions', 'gtm_storyboard_spend', 'gtm_broll_shots'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false))$p$,
      t || '_owner_read', t);
  end loop;
end $$;


create function public.gtm_storyboard_is_owner()
returns boolean language sql stable set search_path = '' as $$
  select (select auth.uid()) is not null
     and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false)
$$;
revoke all on function public.gtm_storyboard_is_owner() from public, anon;
grant execute on function public.gtm_storyboard_is_owner() to authenticated, service_role;

create function public.gtm_storyboard_anchor_ok(a jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select a is not null and jsonb_typeof(a) = 'object'
    and not exists (select 1 from jsonb_object_keys(a) k
                     where k not in ('scene_id', 'element_id', 'lane', 't_start', 't_end', 't', 'region', 'words', 'slide'))
    and (not a ? 'scene_id' or (jsonb_typeof(a -> 'scene_id') = 'string' and a ->> 'scene_id' ~ '^[a-z0-9][a-z0-9_.-]{0,79}$'))
    and (not a ? 'element_id' or (jsonb_typeof(a -> 'element_id') = 'string' and a ->> 'element_id' ~ '^[a-z0-9][a-z0-9_.-]{0,79}$'))
    and (not a ? 'lane' or a ->> 'lane' in ('speaker', 'text', 'motion', 'broll', 'captions', 'audio', 'endcard'))
    and (not a ? 't' or (jsonb_typeof(a -> 't') = 'number' and (a ->> 't')::numeric >= 0))
    and (not a ? 't_start' or (jsonb_typeof(a -> 't_start') = 'number' and (a ->> 't_start')::numeric >= 0))
    and (not a ? 't_end' or (jsonb_typeof(a -> 't_end') = 'number' and a ? 't_start' and (a ->> 't_end')::numeric >= (a ->> 't_start')::numeric))
    and (not a ? 'region' or (jsonb_typeof(a -> 'region') = 'array' and jsonb_array_length(a -> 'region') = 4
         and not exists (select 1 from jsonb_array_elements(a -> 'region') v where jsonb_typeof(v) <> 'number' or v::text::numeric < 0 or v::text::numeric > 1)))
    and (not a ? 'words' or (jsonb_typeof(a -> 'words') = 'object' and jsonb_typeof(a -> 'words' -> 'from') = 'string' and jsonb_typeof(a -> 'words' -> 'to') = 'string'))
    and (not a ? 'slide' or (jsonb_typeof(a -> 'slide') = 'number' and (a ->> 'slide')::numeric >= 1))
$$;
revoke all on function public.gtm_storyboard_anchor_ok(jsonb) from public, anon;
grant execute on function public.gtm_storyboard_anchor_ok(jsonb) to authenticated, service_role;

create function public.gtm_storyboard_unapproved_scenes(p_storyboard_id text, p_version int)
returns setof text language sql stable set search_path = '' as $$
  select s.key
    from public.gtm_storyboard_versions v, jsonb_each_text(v.scene_shas) s
   where v.storyboard_id = p_storyboard_id and v.version = p_version
     and coalesce((select d.decision from public.gtm_storyboard_scene_decisions d
                    where d.storyboard_id = p_storyboard_id and d.scene_id = s.key and d.scene_sha = s.value
                    order by d.seq desc limit 1), '') <> 'approved'
   order by s.key
$$;
revoke all on function public.gtm_storyboard_unapproved_scenes(text, int) from public, anon;
grant execute on function public.gtm_storyboard_unapproved_scenes(text, int) to authenticated, service_role;


create function public.gtm_add_storyboard_comment(
  p_storyboard_id text, p_version int, p_anchor jsonb, p_kind text, p_body text,
  p_proposal jsonb default null, p_scope text default 'this', p_rule text default null, p_category text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare sb record; v record; new_id uuid; batch uuid; rid uuid; ids uuid[] := '{}'; sib record; cid uuid;
begin
  if not public.gtm_storyboard_is_owner() then
    raise exception 'only the signed-in owner can comment on a storyboard' using errcode = 'insufficient_privilege';
  end if;
  if p_kind not in ('note', 'swap', 'retime', 'crop', 'reselect', 'add', 'drop', 'brief', 'choice')
     or p_body is null or length(btrim(p_body)) = 0 or length(p_body) > 5000
     or coalesce(p_scope, '') not in ('this', 'series', 'format')
     or not public.gtm_storyboard_anchor_ok(coalesce(p_anchor, '{}'))
     or (p_proposal is not null and (jsonb_typeof(p_proposal) <> 'object' or coalesce(p_proposal ->> 'op', '') = ''))
     or (p_rule is not null and length(btrim(p_rule)) not between 3 and 500)
     or (p_category is not null and p_category not in ('layout', 'graphics', 'broll', 'hook', 'motion', 'captions', 'audio', 'edit', 'credits')) then
    raise exception 'invalid storyboard comment' using errcode = 'invalid_parameter_value';
  end if;
  select s.id, s.stage, s.format, s.series, s.current_version into sb from public.gtm_storyboards s where s.id = p_storyboard_id;
  if sb.id is null then raise exception 'storyboard not found'; end if;
  select x.scene_shas into v from public.gtm_storyboard_versions x where x.storyboard_id = p_storyboard_id and x.version = p_version;
  if v.scene_shas is null then raise exception 'storyboard version not found'; end if;
  if p_anchor ? 'scene_id' and not v.scene_shas ? (p_anchor ->> 'scene_id') then
    raise exception 'no scene % in version %', p_anchor ->> 'scene_id', p_version using errcode = 'invalid_parameter_value';
  end if;
  if p_scope = 'series' and sb.series is null then
    raise exception 'this storyboard has no series' using errcode = 'invalid_parameter_value';
  end if;

  if p_scope <> 'this' then
    batch := gen_random_uuid();
    insert into public.gtm_storyboard_rules (format, series, category, rule, source, status)
    values (sb.format, case when p_scope = 'series' then sb.series end, p_category, btrim(coalesce(p_rule, p_body)), 'john', 'active')
    returning id into rid;
  end if;

  insert into public.gtm_storyboard_comments (storyboard_id, version, anchor, kind, body, proposal, scope, rule_id, batch_id, author)
  values (p_storyboard_id, p_version, coalesce(p_anchor, '{}'), p_kind, btrim(p_body), p_proposal, coalesce(p_scope, 'this'), rid, batch, 'john')
  returning id into new_id;
  ids := ids || new_id;

  if p_scope <> 'this' then
    for sib in
      select s.id, s.current_version from public.gtm_storyboards s
       where s.id <> sb.id and s.stage = sb.stage and s.current_version > 0 and s.status not in ('superseded')
         and ((p_scope = 'series' and s.series = sb.series) or (p_scope = 'format' and s.format = sb.format))
       order by s.id
    loop
      insert into public.gtm_storyboard_comments (storyboard_id, version, anchor, kind, body, proposal, scope, rule_id, batch_id, author)
      values (sib.id, sib.current_version, '{}', 'note', btrim(p_body), null, p_scope, rid, batch, 'john')
      returning id into cid;
      ids := ids || cid;
    end loop;
    update public.gtm_storyboard_rules set evidence = ids where id = rid;
  end if;
  update public.gtm_storyboards set updated_at = now() where id = p_storyboard_id;
  return new_id;
end $$;
revoke all on function public.gtm_add_storyboard_comment(text, int, jsonb, text, text, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.gtm_add_storyboard_comment(text, int, jsonb, text, text, jsonb, text, text, text) to authenticated;

create function public.gtm_withdraw_storyboard_comment(p_comment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.gtm_storyboard_is_owner() then
    raise exception 'only the signed-in owner can withdraw a note' using errcode = 'insufficient_privilege';
  end if;
  update public.gtm_storyboard_comments set status = 'withdrawn', resolved_at = now()
   where id = p_comment_id and author = 'john' and status in ('open', 'addressed');
  if not found then raise exception 'no open note % to withdraw', p_comment_id using errcode = 'invalid_parameter_value'; end if;
end $$;
revoke all on function public.gtm_withdraw_storyboard_comment(uuid) from public, anon, authenticated;
grant execute on function public.gtm_withdraw_storyboard_comment(uuid) to authenticated;

create function public.gtm_decide_storyboard_scene(
  p_storyboard_id text, p_version int, p_scene_id text, p_expected_scene_sha text, p_decision text, p_note text default ''
) returns void language plpgsql security definer set search_path = '' as $$
declare sb record; live_sha text;
begin
  if not public.gtm_storyboard_is_owner() then
    raise exception 'only the signed-in owner can decide a scene' using errcode = 'insufficient_privilege';
  end if;
  if p_decision not in ('approved', 'changes', 'cleared') or p_note is null or length(p_note) > 5000
     or (p_decision = 'changes' and btrim(p_note) = '') or p_scene_id is null then
    raise exception 'invalid scene decision' using errcode = 'invalid_parameter_value';
  end if;
  select s.id, s.current_version, s.status into sb from public.gtm_storyboards s where s.id = p_storyboard_id for update;
  if sb.id is null then raise exception 'storyboard not found'; end if;
  if sb.current_version is distinct from p_version then
    raise exception 'a newer version (v%) was pushed; refresh', sb.current_version using errcode = 'PT409';
  end if;
  if sb.status = 'approved' then
    raise exception 'this storyboard is approved; reopen it to change a scene' using errcode = 'invalid_parameter_value';
  end if;
  select v.scene_shas ->> p_scene_id into live_sha from public.gtm_storyboard_versions v
   where v.storyboard_id = p_storyboard_id and v.version = p_version;
  if live_sha is null then raise exception 'no scene % in version %', p_scene_id, p_version using errcode = 'invalid_parameter_value'; end if;
  if live_sha is distinct from p_expected_scene_sha then
    raise exception 'scene % changed; refresh and review it', p_scene_id using errcode = 'PT409';
  end if;
  insert into public.gtm_storyboard_scene_decisions (storyboard_id, version, scene_id, scene_sha, decision, note, decided_by)
  values (p_storyboard_id, p_version, p_scene_id, live_sha, p_decision, btrim(p_note), (select auth.uid()));
  if p_decision = 'approved' then
    update public.gtm_storyboard_comments set status = 'resolved', resolved_at = now()
     where storyboard_id = p_storyboard_id and status = 'addressed' and anchor ->> 'scene_id' = p_scene_id;
  elsif p_decision = 'changes' then
    update public.gtm_storyboard_comments set status = 'open', resolved_at = null
     where storyboard_id = p_storyboard_id and status = 'addressed' and anchor ->> 'scene_id' = p_scene_id;
    insert into public.gtm_storyboard_comments (storyboard_id, version, anchor, kind, body, author)
    values (p_storyboard_id, p_version, jsonb_build_object('scene_id', p_scene_id), 'note', btrim(p_note), 'john');
    update public.gtm_storyboards set status = 'changes' where id = p_storyboard_id and status = 'review';
  end if;
  update public.gtm_storyboards set updated_at = now() where id = p_storyboard_id;
end $$;
revoke all on function public.gtm_decide_storyboard_scene(text, int, text, text, text, text) from public, anon, authenticated;
grant execute on function public.gtm_decide_storyboard_scene(text, int, text, text, text, text) to authenticated;

create function public.gtm_decide_storyboard(
  p_storyboard_id text, p_version int, p_doc_sha text, p_decision text, p_note text default '', p_approve_remaining boolean default false
) returns void language plpgsql security definer set search_path = '' as $$
declare sb record; v record; story_pipeline text; open_count int; missing text;
begin
  if not public.gtm_storyboard_is_owner() then
    raise exception 'only the signed-in owner can decide a storyboard' using errcode = 'insufficient_privilege';
  end if;
  if p_decision not in ('approved', 'changes') or p_note is null or length(p_note) > 5000
     or (p_decision = 'changes' and btrim(p_note) = '') then
    raise exception 'invalid storyboard decision' using errcode = 'invalid_parameter_value';
  end if;
  select s.id, s.story_id, s.stage, s.current_version, s.status into sb from public.gtm_storyboards s where s.id = p_storyboard_id for update;
  if sb.id is null then raise exception 'storyboard not found'; end if;
  if sb.current_version is distinct from p_version then
    raise exception 'a newer version (v%) was pushed; refresh', sb.current_version using errcode = 'PT409';
  end if;
  select x.doc_sha, x.scene_shas, x.motion_sha, x.motion_path, x.credit_cap into v
    from public.gtm_storyboard_versions x where x.storyboard_id = p_storyboard_id and x.version = p_version;
  if v.doc_sha is distinct from p_doc_sha then
    raise exception 'the storyboard changed; refresh and review it' using errcode = 'PT409';
  end if;
  if sb.status = 'approved' then
    raise exception 'already approved; reopen it to change the decision' using errcode = 'invalid_parameter_value';
  end if;
  select s.pipeline into story_pipeline from public.gtm_stories s where s.id = sb.story_id for update;
  if story_pipeline is null then raise exception 'the Story has no pipeline' using errcode = 'invalid_parameter_value'; end if;

  if p_decision = 'approved' then
    select count(*) into open_count from public.gtm_storyboard_comments c where c.storyboard_id = p_storyboard_id and c.status = 'open';
    if open_count > 0 then
      raise exception '% open note(s) on this storyboard; the agent answers them first, or withdraw them', open_count
        using errcode = 'invalid_parameter_value';
    end if;
    if p_approve_remaining then
      insert into public.gtm_storyboard_scene_decisions (storyboard_id, version, scene_id, scene_sha, decision, note, decided_by)
      select p_storyboard_id, p_version, u, v.scene_shas ->> u, 'approved', 'approved with the storyboard', (select auth.uid())
        from public.gtm_storyboard_unapproved_scenes(p_storyboard_id, p_version) u;
    end if;
    select string_agg(u, ', ') into missing from public.gtm_storyboard_unapproved_scenes(p_storyboard_id, p_version) u;
    if missing is not null then
      raise exception 'scenes not approved yet: %', missing using errcode = 'invalid_parameter_value';
    end if;
    update public.gtm_storyboard_comments set status = 'resolved', resolved_at = now()
     where storyboard_id = p_storyboard_id and status = 'addressed';
    if v.motion_path = 'motion.so' and v.credit_cap is not null then
      insert into public.gtm_storyboard_spend (storyboard_id, version, kind, credits, motion_sha, note)
      values (p_storyboard_id, p_version, 'authorized', v.credit_cap, v.motion_sha, 'one Motion.so create, approved by John in /studio');
    end if;
  else
    insert into public.gtm_storyboard_comments (storyboard_id, version, anchor, kind, body, author)
    values (p_storyboard_id, p_version, '{}', 'note', btrim(p_note), 'john');
  end if;

  update public.gtm_storyboards set status = case when p_decision = 'approved' then 'approved' else 'changes' end, updated_at = now()
   where id = p_storyboard_id;
  insert into public.gtm_story_stages (story_id, stage, status, note, actor, updated_at)
  values (sb.story_id, sb.stage, p_decision, btrim(p_note), 'john', now())
  on conflict (story_id, stage) do update set status = excluded.status, note = excluded.note, actor = 'john', updated_at = now();
  insert into public.gtm_story_stage_decisions (story_id, stage, party, who, decision, note, assets, decided_by)
  values (sb.story_id, sb.stage, 'john', null, p_decision, btrim(p_note),
          jsonb_build_array(jsonb_build_object('storyboard_id', p_storyboard_id, 'version', p_version, 'doc_sha', p_doc_sha)),
          (select auth.uid()));
end $$;
revoke all on function public.gtm_decide_storyboard(text, int, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.gtm_decide_storyboard(text, int, text, text, text, boolean) to authenticated;

create function public.gtm_reopen_storyboard(p_storyboard_id text, p_note text, p_reset_stages text[] default '{}')
returns void language plpgsql security definer set search_path = '' as $$
declare sb record; v record;
begin
  if not public.gtm_storyboard_is_owner() then
    raise exception 'only the signed-in owner can reopen a storyboard' using errcode = 'insufficient_privilege';
  end if;
  if p_note is null or length(btrim(p_note)) = 0 or length(p_note) > 5000
     or exists (select 1 from unnest(coalesce(p_reset_stages, '{}')) r where r !~ '^[a-z][a-z0-9-]{0,39}$' or r = 'final') then
    raise exception 'invalid reopen' using errcode = 'invalid_parameter_value';
  end if;
  select s.id, s.story_id, s.stage, s.current_version, s.status into sb from public.gtm_storyboards s where s.id = p_storyboard_id for update;
  if sb.id is null then raise exception 'storyboard not found'; end if;
  if sb.status <> 'approved' then raise exception 'only an approved storyboard is reopened' using errcode = 'invalid_parameter_value'; end if;
  select x.doc_sha into v from public.gtm_storyboard_versions x where x.storyboard_id = p_storyboard_id and x.version = sb.current_version;
  update public.gtm_storyboards set status = 'changes', updated_at = now() where id = p_storyboard_id;
  insert into public.gtm_storyboard_comments (storyboard_id, version, anchor, kind, body, author)
  values (p_storyboard_id, sb.current_version, '{}', 'note', btrim(p_note), 'john');
  insert into public.gtm_story_stages (story_id, stage, status, note, actor, updated_at)
  values (sb.story_id, sb.stage, 'changes', btrim(p_note), 'john', now())
  on conflict (story_id, stage) do update set status = 'changes', note = excluded.note, actor = 'john', updated_at = now();
  update public.gtm_story_stages set status = 'todo', note = '', actor = 'john', updated_at = now()
   where story_id = sb.story_id and stage = any (coalesce(p_reset_stages, '{}')) and stage <> sb.stage;
  insert into public.gtm_story_stage_decisions (story_id, stage, party, who, decision, note, assets, decided_by)
  values (sb.story_id, sb.stage, 'john', null, 'reopened', btrim(p_note),
          jsonb_build_array(jsonb_build_object('storyboard_id', p_storyboard_id, 'version', sb.current_version, 'doc_sha', v.doc_sha)),
          (select auth.uid()));
end $$;
revoke all on function public.gtm_reopen_storyboard(text, text, text[]) from public, anon, authenticated;
grant execute on function public.gtm_reopen_storyboard(text, text, text[]) to authenticated;

create function public.gtm_update_storyboard_rule(p_rule_id uuid, p_status text default null, p_rule text default null, p_conflict_resolution text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.gtm_storyboard_is_owner() then
    raise exception 'only the signed-in owner can change a rule' using errcode = 'insufficient_privilege';
  end if;
  if (p_status is not null and p_status not in ('active', 'retired'))
     or (p_rule is not null and length(btrim(p_rule)) not between 3 and 500)
     or (p_conflict_resolution is not null and length(btrim(p_conflict_resolution)) not between 1 and 1000) then
    raise exception 'invalid rule change' using errcode = 'invalid_parameter_value';
  end if;
  update public.gtm_storyboard_rules
     set status = coalesce(p_status, status),
         retired_at = case when p_status = 'retired' then now() when p_status = 'active' then null else retired_at end,
         rule = coalesce(btrim(p_rule), rule),
         conflict_resolution = coalesce(btrim(p_conflict_resolution), conflict_resolution)
   where id = p_rule_id;
  if not found then raise exception 'rule not found'; end if;
end $$;
revoke all on function public.gtm_update_storyboard_rule(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.gtm_update_storyboard_rule(uuid, text, text, text) to authenticated;

insert into public.gtm_storyboard_rules (format, series, category, rule, check_spec, conflicts_with, conflict_resolution, skill, source, status) values
  ('short', null, 'layout',
   'Text and Motion graphics sit in the top third, never over the speaker''s eyes or mouth; the lower half is the caption zone.',
   '{"type": "band", "lanes": ["text", "motion"], "max_y": 0.34, "avoid": ["eyes", "mouth"], "caption_zone": [0.5, 1.0]}',
   'vibrana-podcast-clips: "nothing above 64% height"',
   'The top-third layout rule takes precedence over the legacy height rule.',
   'vibrana-podcast-clips', 'john', 'active'),
  ('short', null, 'motion',
   'Motion beats are Vox-style illustrations (diagrams, maps, charts, tickers, icons), never words in a box.',
   '{"type": "motion_style", "forbid": ["card", "chip"]}',
   null, '', 'vibrana-podcast-clips', 'john', 'active'),
  ('short', null, 'broll',
   'Check every B-roll crop across its full window; the named subject must be visible and whole.',
   '{"type": "broll_checked"}',
   null, '', 'vibrana-podcast-clips', 'john', 'active');
