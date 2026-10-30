begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users(id,aud,role,email) values('00000000-0000-0000-0000-000000000001','authenticated','authenticated','delivery-owner@example.test') on conflict(id) do nothing;
create function pg_temp.as_actor(r text, owner boolean default false) returns void language plpgsql as $$
begin
 execute format('set local role %I',r);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',case when r='authenticated' then '00000000-0000-0000-0000-000000000001' else null end,'role',r,'app_metadata',jsonb_build_object('gtm_owner',owner))::text,true);
end $$;
create function pg_temp.expected() returns jsonb language sql security definer as $$select jsonb_build_object('text',public.gtm_piece_asset_fingerprint(t),'video',public.gtm_piece_asset_fingerprint(v)) from public.gtm_story_assets t,public.gtm_story_assets v where t.id='delivery-text' and v.id='delivery-video'$$;
create function pg_temp.delivery() returns uuid language sql security definer as $$select id from public.gtm_piece_deliveries where story_id='delivery-test' and channel='linkedin'$$;
create function pg_temp.token() returns uuid language sql security definer as $$select claim_token from public.gtm_piece_deliveries where id=pg_temp.delivery()$$;
insert into public.gtm_seasons(id,title,starts_on,ends_on) values('delivery-season','Synthetic','2030-01-01','2099-12-31');
insert into public.gtm_stories(id,title,link_url) values('delivery-test','Delivery piece','https://example.test/delivery');
insert into public.gtm_story_assets(id,story_id,title,kind,source,sha256,body,storage_path,stage) values
 ('delivery-text','delivery-test','Text','copy','text.md',repeat('a',64),'Frozen caption',null,null),
 ('delivery-video','delivery-test','Video','video','video.mp4',repeat('b',64),null,'stories/delivery/video.mp4','final');
select pg_temp.as_actor('authenticated',true);
select public.gtm_configure_piece_review('delivery-test','delivery-text','delivery-video',array['linkedin','youtube'],pg_temp.expected());
select throws_ok($$select public.gtm_prepare_piece_delivery('delivery-test','linkedin','2030-10-08','14:00','UTC',pg_temp.expected())$$,'42501',null,'owner cannot bypass service dispatch boundary');
select public.gtm_decide_piece_part('delivery-test','text','approved','',pg_temp.expected()->>'text',1);
select public.gtm_decide_piece_part('delivery-test','video','fixing','Trim only the end',pg_temp.expected()->>'video',1);
select pg_temp.as_actor('service_role');
select throws_ok($$select public.gtm_prepare_piece_delivery('delivery-test','linkedin','2030-10-08','14:00','UTC',pg_temp.expected())$$,'22023',null,'accepted but unfixed blocks reservation');
select pg_temp.as_actor('authenticated',true);
select public.gtm_decide_piece_part('delivery-test','video','approved','',pg_temp.expected()->>'video',1);
select pg_temp.as_actor('service_role');
select throws_ok($$select public.gtm_prepare_piece_delivery('delivery-test','linkedin','2030-10-08','14:00','UTC','{}')$$,'PT409',null,'stale scheduling request cannot freeze a newer version');
insert into public.gtm_content_items(id,week,date,time,pillar,title,format,channels,status) values('batch-conflict',41,'2030-10-08','17:00','proof','Occupied','video','{youtube}','scheduled');
select throws_ok($$select public.gtm_prepare_piece_deliveries('delivery-test','[{"channel":"linkedin","date":"2030-10-08","time":"14:00","timezone":"UTC"},{"channel":"youtube","date":"2030-10-08","time":"17:00","timezone":"UTC"}]',pg_temp.expected(),'proof')$$,'PT409',null,'second channel conflict rejects the whole reservation batch');
select is((select count(*)::int from public.gtm_piece_deliveries),0,'batch failure retains no first channel reservation');
select is((select count(*)::int from public.gtm_content_items where id='delivery-test-linkedin'),0,'batch failure rolls back calendar writes');
delete from public.gtm_content_items where id='batch-conflict';
select lives_ok($$select public.gtm_prepare_piece_delivery('delivery-test','linkedin','2030-10-08','14:00','UTC',pg_temp.expected(),'proof')$$,'ready content freezes one delivery and calendar row atomically');
select is((select count(*)::int from public.gtm_piece_deliveries),1,'one channel delivery exists');
select is((select review_snapshot->'text'->'asset'->>'body' from public.gtm_piece_deliveries where id=pg_temp.delivery()),'Frozen caption','approved text is retained in immutable snapshot');
select throws_ok($$update public.gtm_piece_deliveries set state='published'$$,'42501',null,'service cannot mutate ledger outside checked functions');
select throws_ok($$update public.gtm_content_items set body='Silent replacement' where id='delivery-test-linkedin'$$,'22023',null,'calendar payload cannot silently change after reservation');
select pg_temp.as_actor('authenticated',true);
select public.gtm_set_piece_dispatch('delivery-test',pg_temp.expected(),false);
select pg_temp.as_actor('service_role');
select throws_ok($$select public.gtm_claim_piece_delivery(pg_temp.delivery())$$,'22023',null,'rollout pause stops new dispatch and retains reservation evidence');
select pg_temp.as_actor('authenticated',true);
select public.gtm_set_piece_dispatch('delivery-test',pg_temp.expected(),true);
select pg_temp.as_actor('service_role');
update public.gtm_story_assets set metadata='{}' where id='delivery-video';
select is((select metadata->>'shared_review_part' from public.gtm_story_assets where id='delivery-video'),'video','metadata rewrites cannot revive legacy approval authority');
update public.gtm_stories set held_at=now() where id='delivery-test';
select throws_ok($$select public.gtm_claim_piece_delivery(pg_temp.delivery())$$,'22023',null,'hold added after preparation blocks a first provider dispatch');
update public.gtm_stories set held_at=null where id='delivery-test';
select ok(public.gtm_claim_piece_delivery(pg_temp.delivery()) is not null,'first worker claims upload preparation');
select is(public.gtm_claim_piece_delivery(pg_temp.delivery()),null::jsonb,'overlapping worker cannot claim again');
select throws_ok($$select public.gtm_start_piece_send(pg_temp.delivery(),gen_random_uuid(),'{}')$$,'PT409',null,'stale worker cannot start an outbound request');
update public.gtm_stories set held_at=now() where id='delivery-test';
select throws_ok($$select public.gtm_start_piece_send(pg_temp.delivery(),pg_temp.token(),'{"content":"Frozen caption"}')$$,'22023',null,'hold added during upload still blocks the provider request');
update public.gtm_stories set held_at=null where id='delivery-test';
select lives_ok($$select public.gtm_start_piece_send(pg_temp.delivery(),pg_temp.token(),'{"content":"Frozen caption"}')$$,'request is durably recorded before provider call');
select is((select zernio_post_id from public.gtm_content_items where id='delivery-test-linkedin'),'pending','legacy sends cannot repeat an in-flight dispatch');
select public.gtm_record_piece_delivery(pg_temp.delivery(),pg_temp.token(),null,'uncertain',null,'Timed out');
select is(public.gtm_claim_piece_delivery(pg_temp.delivery(),true),null::jsonb,'uncertain outcome cannot be retried by creating another post');
select throws_ok($$select public.gtm_replan_unsent_delivery(pg_temp.delivery(),'2030-10-09','14:00','UTC')$$,'PT409',null,'uncertain create cannot be moved to a fresh slot or request');
create function pg_temp.yt() returns uuid language sql security definer as $$select id from public.gtm_piece_deliveries where story_id='delivery-test' and channel='youtube'$$;
create function pg_temp.yt_token() returns uuid language sql security definer as $$select claim_token from public.gtm_piece_deliveries where id=pg_temp.yt()$$;
select public.gtm_prepare_piece_delivery('delivery-test','youtube','2030-10-08','17:00','UTC',pg_temp.expected());
select public.gtm_claim_piece_delivery(pg_temp.yt());
select public.gtm_start_piece_send(pg_temp.yt(),pg_temp.yt_token(),'{"content":"Frozen caption","scheduledFor":"2030-10-08T17:00:00"}');
select public.gtm_record_piece_delivery(pg_temp.yt(),pg_temp.yt_token(),null,'failed',null,'Definitive provider rejection');
select lives_ok($$select public.gtm_replan_unsent_delivery(pg_temp.yt(),'2030-10-09','17:00','UTC')$$,'definitively rejected unsent delivery can move without content reapproval');
select is((select count(*)::int from public.gtm_piece_delivery_attempts where delivery_id=pg_temp.yt()),1,'prior provider request remains recorded after replanning');
select is((select body from public.gtm_content_items where id='delivery-test-youtube'),'Frozen caption','replanning changes the slot while retaining approved content');
select pg_temp.as_actor('authenticated',true);
select public.gtm_save_piece_text('delivery-test','New separate draft',pg_temp.expected()->>'text',1);
select is(public.gtm_piece_snapshot('delivery-test')->'text'->>'status','pending','editing opens only the separate draft approval');
select is((select body from public.gtm_content_items where id='delivery-test-linkedin'),'Frozen caption','queued caption stays unchanged after draft edit');
select pg_temp.as_actor('service_role');
select public.gtm_record_piece_delivery(pg_temp.delivery(),pg_temp.token(),'provider-1','scheduled',null,null);
select is((select state from public.gtm_piece_deliveries where id=pg_temp.delivery()),'scheduled','provider reconciliation records known scheduled outcome');
select public.gtm_record_piece_delivery(pg_temp.delivery(),pg_temp.token(),'provider-1','failed',null,'Channel rejected');
select is(public.gtm_piece_snapshot('delivery-test')->'video'->>'status','approved','channel failure never resets content approval');
select ok(public.gtm_claim_piece_delivery(pg_temp.delivery(),true) is not null,'definitive channel failure supports explicit retry');
select throws_ok($$select public.gtm_start_piece_send(pg_temp.delivery(),pg_temp.token(),'{"content":"Changed request"}')$$,'22023',null,'retry cannot modify the frozen request');
select public.gtm_start_piece_send(pg_temp.delivery(),pg_temp.token(),'{"content":"Frozen caption"}');
select public.gtm_record_piece_delivery(pg_temp.delivery(),pg_temp.token(),'provider-1','published',null,null);
select lives_ok($$select public.gtm_record_piece_delivery(pg_temp.delivery(),pg_temp.token(),'provider-1','published','https://example.test/published',null,'2030-10-08T14:05:00Z')$$,'late publication URL can fill without changing terminal published status');
select is((select published_at from public.gtm_content_items where id='delivery-test-linkedin'),'2030-10-08T14:05:00Z'::timestamptz,'publication time is provider evidence rather than reconciliation time');
select public.gtm_record_piece_delivery(pg_temp.delivery(),pg_temp.token(),'provider-1','failed',null,'Duplicate old event');
select is((select state from public.gtm_piece_deliveries where id=pg_temp.delivery()),'published','duplicate stale failure cannot undo published evidence');
select is((select urls->>'linkedin' from public.gtm_content_items where id='delivery-test-linkedin'),'https://example.test/published','publication link survives duplicate delivery events');
select throws_ok($$select public.gtm_record_piece_delivery(pg_temp.delivery(),pg_temp.token(),'provider-2','scheduled',null,null)$$,'22023',null,'provider identity cannot be replaced');
select is((select count(*)::int from public.gtm_piece_decision_events where story_id='delivery-test')>0,true,'shared decisions retain append-only evidence');
insert into public.gtm_content_items(id,week,date,time,pillar,title,format,channels,status,body,media,story_assets) values('delivery-legacy-test',41,'2030-10-09','14:00','proof','Legacy','text','{linkedin}','approved','Approved','[]','{}');
select lives_ok($$select public.gtm_claim_legacy_send('delivery-legacy-test',jsonb_build_object('calendar',(select jsonb_build_object('body',body,'media',media,'assets',story_assets,'date',date,'time',time,'channels',channels,'story_id',story_id,'approved_hash',approved_hash) from public.gtm_content_items where id='delivery-legacy-test'),'assets','[]'::jsonb))$$,'legacy sender atomically claims its calendar row');
select throws_ok($$select public.gtm_claim_legacy_send('delivery-legacy-test',jsonb_build_object('calendar',(select jsonb_build_object('body',body,'media',media,'assets',story_assets,'date',date,'time',time,'channels',channels,'story_id',story_id,'approved_hash',approved_hash) from public.gtm_content_items where id='delivery-legacy-test'),'assets','[]'::jsonb))$$,'PT409',null,'overlapping legacy send cannot duplicate a post');
insert into public.gtm_stories(id,title,link_url,held_at) values('held-legacy','Held legacy','https://example.test',now());
insert into public.gtm_story_assets(id,story_id,title,kind,source,sha256,body) values('held-legacy-text','held-legacy','Text','copy','text.md',repeat('d',64),'Legacy body');
insert into public.gtm_story_asset_channels(asset_id,channel) values('held-legacy-text','linkedin');
insert into public.gtm_content_items(id,story_id,week,date,time,pillar,title,format,channels,status,body,media,story_assets) values('held-legacy-item','held-legacy',41,'2030-10-10','14:00','proof','Held','text','{linkedin}','approved','Legacy body','[]','{held-legacy-text}');
create function pg_temp.legacy_expected() returns jsonb language sql as $$select jsonb_build_object('calendar',(select jsonb_build_object('body',body,'media',media,'assets',story_assets,'date',date,'time',time,'channels',channels,'story_id',story_id,'approved_hash',approved_hash) from public.gtm_content_items where id='held-legacy-item'),'assets',jsonb_build_array(jsonb_build_object('id','held-legacy-text','sha256',repeat('d',64),'revision',1)))$$;
select throws_ok($$select public.gtm_claim_legacy_send('held-legacy-item',pg_temp.legacy_expected())$$,'22023',null,'legacy claim cannot ignore a publishing hold');
update public.gtm_stories set held_at=null where id='held-legacy';
select throws_ok($$select public.gtm_claim_legacy_send('held-legacy-item',pg_temp.legacy_expected())$$,'PT409',null,'legacy atomic claim rechecks current channel approval');
select pg_temp.as_actor('authenticated',false);
select is((select count(*)::int from public.gtm_piece_deliveries),0,'non-owner cannot see channel deliveries');
select is((select count(*)::int from public.gtm_piece_decision_events),0,'non-owner cannot see decision history');
select pg_temp.as_actor('service_role');
update public.gtm_stories set third_party_who='Canonical partner' where id='delivery-test';
insert into public.gtm_reviewer_invites(token_sha256,party,expires_at) values(repeat('9',64),'Canonical partner',now()+interval '1 day');
select throws_ok($$select public.gtm_reviewer_decide_piece_video('delivery-video','approved','',repeat('b',64),1,repeat('8',64))$$,'42501',null,'wrong link cannot decide canonical video');
select lives_ok($$select public.gtm_reviewer_decide_piece_video('delivery-video','approved','',repeat('b',64),1,repeat('9',64))$$,'third party reviews canonical video without platform-copy rows');
select ok(not(public.gtm_piece_snapshot('delivery-test')->'blockers' ? 'Waiting for third-party approval'),'canonical media-only signoff clears the shared gate');
select throws_ok($$select public.gtm_reviewer_decide_piece_video('delivery-text','approved','',repeat('a',64),1,repeat('9',64))$$,'42501',null,'shared text is never a third-party approval target');
update public.gtm_reviewer_invites set revoked_at=now() where token_sha256=repeat('9',64);
select throws_ok($$select public.gtm_reviewer_decide_piece_video('delivery-video','changes','Change it',repeat('b',64),1,repeat('9',64))$$,'42501',null,'revoked review link cannot mutate protected shared content');

-- Review follow-ups: moving and releasing reservations, uncertain recovery, frozen dispatch markers,
-- calendar pillar/week/published_at, and deletion of pieces with deliveries.
reset role;
insert into public.gtm_stories(id,title,link_url) values('replan','Replan piece','https://example.test/replan'),('recover','Recover piece','https://example.test/recover');
insert into public.gtm_story_assets(id,story_id,title,kind,source,sha256,body,storage_path,stage) values
 ('replan-text','replan','Text','copy','t.md',repeat('1',64),'Replan caption',null,null),
 ('replan-video','replan','Video','video','v.mp4',repeat('2',64),null,'stories/replan/v.mp4','final'),
 ('recover-text','recover','Text','copy','t.md',repeat('3',64),'Recover caption',null,null),
 ('recover-video','recover','Video','video','v.mp4',repeat('4',64),null,'stories/recover/v.mp4','final');
insert into public.gtm_content_items(id,story_id,week,date,time,pillar,title,format,channels,status) values('recover-linkedin','recover',50,'2030-12-10','14:00','build','Recover','video','{linkedin}','drafted');
create function pg_temp.exp(sid text) returns jsonb language sql security definer as $$select jsonb_build_object('text',public.gtm_piece_asset_fingerprint(t),'video',public.gtm_piece_asset_fingerprint(v)) from public.gtm_story_assets t,public.gtm_story_assets v where t.id=sid||'-text' and v.id=sid||'-video'$$;
create function pg_temp.dv(sid text,ch text) returns uuid language sql security definer as $$select id from public.gtm_piece_deliveries where story_id=sid and channel=ch$$;
create function pg_temp.tok(sid text,ch text) returns uuid language sql security definer as $$select claim_token from public.gtm_piece_deliveries where story_id=sid and channel=ch$$;
create function pg_temp.cal(cid text) returns public.gtm_content_items language sql security definer as $$select * from public.gtm_content_items where id=cid$$;
select pg_temp.as_actor('authenticated',true);
select public.gtm_configure_piece_review(sid,sid||'-text',sid||'-video',array['linkedin','instagram','youtube'],pg_temp.exp(sid)) from unnest(array['replan','recover']) sid;
select public.gtm_decide_piece_part(sid,part,'approved','',pg_temp.exp(sid)->>part,1) from unnest(array['replan','recover']) sid,unnest(array['text','video']) part;
select pg_temp.as_actor('service_role');

-- N-06: a new row's pillar comes from the caller or the Story, never a hard-coded default.
select throws_ok($$select public.gtm_prepare_piece_delivery('replan','linkedin','2030-11-05','14:00','UTC',pg_temp.exp('replan'))$$,'22023',null,'a piece with no known pillar asks for one');
select throws_ok($$select public.gtm_prepare_piece_delivery('replan','linkedin','2030-11-05','14:00','UTC',pg_temp.exp('replan'),'story')$$,'22023',null,'an unknown pillar is refused');
select lives_ok($$select public.gtm_prepare_piece_delivery('replan','linkedin','2030-11-05','14:00','UTC',pg_temp.exp('replan'),'perspective')$$,'the caller supplies the pillar for a new row');
select is((pg_temp.cal('replan-linkedin')).pillar,'perspective','new calendar row carries the supplied pillar');
select lives_ok($$select public.gtm_prepare_piece_deliveries('replan','[{"channel":"instagram","date":"2030-11-06","time":"14:00","timezone":"UTC"},{"channel":"youtube","date":"2030-11-06","time":"17:00","timezone":"UTC"}]',pg_temp.exp('replan'))$$,'sibling channels inherit the piece pillar');
select is((pg_temp.cal('replan-youtube')).pillar,'perspective','inherited pillar matches the Story''s other rows');
select lives_ok($$select public.gtm_prepare_piece_delivery('recover','linkedin','2030-11-21','14:00','UTC',pg_temp.exp('recover'))$$,'an existing calendar row is reused');
select ok((pg_temp.cal('recover-linkedin')).pillar='build' and (pg_temp.cal('recover-linkedin')).week=47,'a reused row keeps its pillar and takes the new week');

-- N-02 and N-01 on instagram.
select public.gtm_claim_piece_delivery(pg_temp.dv('replan','instagram'));
select public.gtm_start_piece_send(pg_temp.dv('replan','instagram'),pg_temp.tok('replan','instagram'),'{"content":"Replan caption"}');
select public.gtm_record_piece_delivery(pg_temp.dv('replan','instagram'),pg_temp.tok('replan','instagram'),'ig-1','scheduled',null,null);
select public.gtm_record_piece_delivery(pg_temp.dv('replan','instagram'),pg_temp.tok('replan','instagram'),'ig-1','uncertain',null,'Unknown provider status');
select is((pg_temp.cal('replan-instagram')).status,'scheduled','an uncertain outcome keeps a scheduled calendar row scheduled');
select throws_ok($$update public.gtm_content_items set status='skipped' where id='replan-instagram'$$,'22023',null,'service cannot rewrite delivery status outside the ledger');
select throws_ok($$update public.gtm_content_items set zernio_post_id=null where id='replan-instagram'$$,'22023',null,'service cannot clear the provider marker outside the ledger');
select throws_ok($$update public.gtm_content_items set published_at=now() where id='replan-instagram'$$,'22023',null,'service cannot stamp publication outside the ledger');
select lives_ok($$update public.gtm_content_items set title='Display only' where id='replan-instagram'$$,'non-dispatch fields of a frozen row stay editable');
select throws_ok($$select public.gtm_release_piece_delivery(pg_temp.dv('replan','instagram'))$$,'PT409',null,'a delivery with a provider post cannot be released');
select throws_ok($$select public.gtm_resolve_uncertain_delivery(pg_temp.dv('replan','instagram'),'Full scan found nothing')$$,'PT409',null,'an uncertain delivery with a provider post cannot be resolved as absent');

-- B-01: paused or held reservations can move and be released.
insert into public.gtm_content_items(id,week,date,time,pillar,title,format,channels,status,body,media,story_assets) values('legacy-on-freed-day',45,'2030-11-07','09:00','proof','Legacy','text','{linkedin}','approved','Legacy','[]','{}');
select pg_temp.as_actor('authenticated',true);
select public.gtm_set_piece_dispatch('replan',null,false);
select pg_temp.as_actor('service_role');
select lives_ok($$select public.gtm_replan_unsent_delivery(pg_temp.dv('replan','linkedin'),'2030-11-07','14:00','UTC')$$,'a paused piece''s reservation can move');
select is((pg_temp.cal('replan-linkedin')).date,'2030-11-07'::date,'the calendar row moves with it');
update public.gtm_stories set held_at=now() where id='replan';
select lives_ok($$select public.gtm_replan_unsent_delivery(pg_temp.dv('replan','linkedin'),'2030-11-07','15:00','UTC')$$,'a held piece''s reservation can move');
select throws_ok($$select public.gtm_claim_legacy_send('legacy-on-freed-day',jsonb_build_object('calendar',(select jsonb_build_object('body',body,'media',media,'assets',story_assets,'date',date,'time',time,'channels',channels,'story_id',story_id,'approved_hash',approved_hash) from public.gtm_content_items where id='legacy-on-freed-day'),'assets','[]'::jsonb))$$,'PT409',null,'the reserved day is taken for other posts');
create temp table released_delivery as select pg_temp.dv('replan','linkedin') id;
select pg_temp.as_actor('authenticated',true);
select throws_ok($$select public.gtm_release_piece_delivery((select id from released_delivery))$$,'42501',null,'the owner session cannot release a delivery directly');
select pg_temp.as_actor('service_role');
select lives_ok($$select public.gtm_release_piece_delivery((select id from released_delivery))$$,'a held, paused reservation can be released');
select ok((pg_temp.cal('replan-linkedin')).status='drafted' and (pg_temp.cal('replan-linkedin')).zernio_post_id is null,'release returns the calendar row to drafted');
select lives_ok($$select public.gtm_claim_legacy_send('legacy-on-freed-day',jsonb_build_object('calendar',(select jsonb_build_object('body',body,'media',media,'assets',story_assets,'date',date,'time',time,'channels',channels,'story_id',story_id,'approved_hash',approved_hash) from public.gtm_content_items where id='legacy-on-freed-day'),'assets','[]'::jsonb))$$,'a released day is free for another post');
select throws_ok($$select public.gtm_claim_piece_delivery((select id from released_delivery))$$,'22023',null,'a released delivery can never be claimed');
select throws_ok($$select public.gtm_release_piece_delivery(pg_temp.delivery())$$,'PT409',null,'a published delivery cannot be released');
update public.gtm_stories set held_at=null where id='replan';
select pg_temp.as_actor('authenticated',true);
select public.gtm_set_piece_dispatch('replan',pg_temp.exp('replan'),true);
select pg_temp.as_actor('service_role');

-- A definitive rejection is released with its attempt kept as evidence.
select public.gtm_claim_piece_delivery(pg_temp.dv('recover','linkedin'));
select public.gtm_start_piece_send(pg_temp.dv('recover','linkedin'),pg_temp.tok('recover','linkedin'),'{"content":"Recover caption"}');
select public.gtm_record_piece_delivery(pg_temp.dv('recover','linkedin'),pg_temp.tok('recover','linkedin'),null,'failed',null,'Rejected: 400');
create temp table rejected_token as select pg_temp.tok('recover','linkedin') id;
select lives_ok($$select public.gtm_release_piece_delivery(pg_temp.dv('recover','linkedin'))$$,'a definitive rejection with no provider post can be released');
select ok((select delivery_id is null and story_id='recover' and channel='linkedin' and state='failed' from public.gtm_piece_delivery_attempts where id=(select id from rejected_token)),'the released attempt stays as evidence');

-- N-07: published with no provider timestamp.
select public.gtm_prepare_piece_delivery('recover','instagram','2030-11-12','14:00','UTC',pg_temp.exp('recover'));
select public.gtm_claim_piece_delivery(pg_temp.dv('recover','instagram'));
select public.gtm_start_piece_send(pg_temp.dv('recover','instagram'),pg_temp.tok('recover','instagram'),'{"content":"Recover caption"}');
select public.gtm_record_piece_delivery(pg_temp.dv('recover','instagram'),pg_temp.tok('recover','instagram'),'rp-1','published',null,null);
select ok((pg_temp.cal('recover-instagram')).published_at is not null,'a publication without a provider timestamp is dated when observed');

-- B1: uncertain with no provider post. Same-key resend inside the window, evidence-backed resolve after it.
select public.gtm_claim_piece_delivery(pg_temp.dv('replan','youtube'));
select public.gtm_start_piece_send(pg_temp.dv('replan','youtube'),pg_temp.tok('replan','youtube'),'{"content":"Replan caption","idempotent":true}');
select public.gtm_record_piece_delivery(pg_temp.dv('replan','youtube'),pg_temp.tok('replan','youtube'),null,'uncertain',null,'429 Too Many Requests');
create temp table yt_first_token as select pg_temp.tok('replan','youtube') id;
select throws_ok($$select public.gtm_resend_uncertain_delivery(pg_temp.dv('replan','youtube'),gen_random_uuid())$$,'PT409',null,'only the current attempt can be re-sent');
select is((public.gtm_resend_uncertain_delivery(pg_temp.dv('replan','youtube'),(select id from yt_first_token))->>'claim_token')::uuid,(select id from yt_first_token),'a resend returns the same claim token, so the same idempotency key');
select ok((select state='sending' and request->>'idempotent'='true' from public.gtm_piece_deliveries where id=pg_temp.dv('replan','youtube')),'a resend carries the frozen request and marks the delivery sending');
select throws_ok($$select public.gtm_resend_uncertain_delivery(pg_temp.dv('replan','youtube'),(select id from yt_first_token))$$,'PT409',null,'a second worker cannot re-POST concurrently');
select is((select posts from public.gtm_piece_delivery_attempts where id=(select id from yt_first_token)),2,'the attempt counts both provider requests under one key');
select public.gtm_record_piece_delivery(pg_temp.dv('replan','youtube'),(select id from yt_first_token),null,'uncertain',null,'Timed out again');
select throws_ok($$select public.gtm_resolve_uncertain_delivery(pg_temp.dv('replan','youtube'),'Full provider scan found no post')$$,'PT409',null,'a just-sent request cannot be declared absent');
select throws_ok($$select public.gtm_resolve_uncertain_delivery(pg_temp.dv('replan','youtube'),'none')$$,'22023',null,'resolution needs recorded evidence');
reset role;
update public.gtm_piece_delivery_attempts set started_at=now()-interval '25 hours',last_posted_at=now()-interval '1 hour' where id=(select id from yt_first_token);
select pg_temp.as_actor('service_role');
select throws_ok($$select public.gtm_resend_uncertain_delivery(pg_temp.dv('replan','youtube'),(select id from yt_first_token))$$,'22023',null,'no same-key resend after the idempotency window');
select pg_temp.as_actor('authenticated',true);
select throws_ok($$select public.gtm_resolve_uncertain_delivery(pg_temp.dv('replan','youtube'),'Full provider scan found no post')$$,'42501',null,'the owner session cannot resolve a delivery directly');
select pg_temp.as_actor('service_role');
select lives_ok($$select public.gtm_resolve_uncertain_delivery(pg_temp.dv('replan','youtube'),'Full provider scan (1 of 1 pages) found no post with this calendarId')$$,'evidence of absence resolves an uncertain create to failed');
select ok((select state='failed' and error like 'Verified absent at the provider: Full provider scan%' from public.gtm_piece_deliveries where id=pg_temp.dv('replan','youtube')),'the evidence is recorded on the delivery');
select is((pg_temp.cal('replan-youtube')).status,'failed','the calendar row shows the failure');
select ok((public.gtm_claim_piece_delivery(pg_temp.dv('replan','youtube'),true)->>'claim_token')::uuid is distinct from (select id from yt_first_token),'the failed delivery retries with a new key');
select lives_ok($$select public.gtm_start_piece_send(pg_temp.dv('replan','youtube'),pg_temp.tok('replan','youtube'),'{"content":"Replan caption","idempotent":true}')$$,'the retry sends the same frozen request');
select is((select count(*)::int from public.gtm_piece_delivery_attempts where delivery_id=pg_temp.dv('replan','youtube')),2,'both attempts stay on record');

-- B-01 (c): pieces with deliveries are not deleted or released from under their evidence.
reset role;
select throws_ok($$delete from public.gtm_stories where id='replan'$$,'22023',null,'a Story with deliveries cannot be deleted silently');
select pg_temp.as_actor('authenticated',true);
select throws_ok($$select public.gtm_release_piece_review('replan')$$,'22023',null,'a piece with deliveries stays shared');
reset role;
insert into public.gtm_stories(id,title,link_url) values('release-me','Release me','https://example.test/release');
insert into public.gtm_story_assets(id,story_id,title,kind,source,sha256,body,storage_path,stage) values
 ('release-me-text','release-me','Text','copy','t.md',repeat('5',64),'Caption',null,null),
 ('release-me-video','release-me','Video','video','v.mp4',repeat('6',64),null,'stories/r/v.mp4','final');
select pg_temp.as_actor('authenticated',true);
select public.gtm_configure_piece_review('release-me','release-me-text','release-me-video',array['linkedin'],pg_temp.exp('release-me'));
select public.gtm_release_piece_review('release-me');
select is((select count(*)::int from public.gtm_piece_decision_events where story_id='release-me' and part='piece' and status='released'),1,'a release is recorded in the decision history');
select ok((select count(*) from public.gtm_piece_decision_events where story_id='release-me' and part in ('text','video'))>0,'the decision history outlives the release');

-- 221-1: a provider post cancelled or deleted at the provider. Reproduce the dead end, then retire it.
reset role;
insert into public.gtm_stories(id,title,link_url) values('retire','Retire piece','https://example.test/retire'),('stale','Stale piece','https://example.test/stale');
insert into public.gtm_story_assets(id,story_id,title,kind,source,sha256,body,storage_path,stage) values
 ('retire-text','retire','Text','copy','t.md',repeat('7',64),'Retire caption',null,null),
 ('retire-video','retire','Video','video','v.mp4',repeat('8',64),null,'stories/retire/v.mp4','final'),
 ('stale-text','stale','Text','copy','t.md',repeat('9',64),'Old caption',null,null),
 ('stale-video','stale','Video','video','v.mp4',repeat('0',64),null,'stories/stale/v.mp4','final');
create function pg_temp.rv(asset text) returns bigint language sql security definer as $$select revision from public.gtm_story_assets where id=asset$$;
select pg_temp.as_actor('authenticated',true);
select public.gtm_configure_piece_review(sid,sid||'-text',sid||'-video',array['linkedin','instagram','youtube'],pg_temp.exp(sid)) from unnest(array['retire','stale']) sid;
select public.gtm_decide_piece_part(sid,part,'approved','',pg_temp.exp(sid)->>part,1) from unnest(array['retire','stale']) sid,unnest(array['text','video']) part;
select pg_temp.as_actor('service_role');
select public.gtm_prepare_piece_deliveries('retire','[{"channel":"youtube","date":"2030-11-14","time":"17:00","timezone":"UTC"},{"channel":"instagram","date":"2030-11-14","time":"14:00","timezone":"UTC"}]',pg_temp.exp('retire'),'build');
select public.gtm_claim_piece_delivery(pg_temp.dv('retire',ch)) from unnest(array['youtube','instagram']) ch;
select public.gtm_start_piece_send(pg_temp.dv('retire',ch),pg_temp.tok('retire',ch),'{"content":"Retire caption"}') from unnest(array['youtube','instagram']) ch;
select public.gtm_record_piece_delivery(pg_temp.dv('retire',ch),pg_temp.tok('retire',ch),'zp-'||ch,'scheduled','https://example.test/'||ch,null) from unnest(array['youtube','instagram']) ch;
select public.gtm_record_piece_delivery(pg_temp.dv('retire','youtube'),pg_temp.tok('retire','youtube'),'zp-youtube','failed',null,'Provider status: cancelled');
create temp table dead_delivery as select pg_temp.dv('retire','youtube') id,pg_temp.tok('retire','youtube') token;
select throws_ok($$select public.gtm_replan_unsent_delivery((select id from dead_delivery),'2030-11-15','17:00','UTC')$$,'PT409',null,'stuck case: a dead provider post cannot be moved');
select throws_ok($$select public.gtm_release_piece_delivery((select id from dead_delivery))$$,'PT409',null,'stuck case: a dead provider post cannot be released');
select throws_ok($$select public.gtm_resolve_uncertain_delivery((select id from dead_delivery),'Full provider scan found no post')$$,'PT409',null,'stuck case: a dead provider post cannot be resolved as absent');
select throws_ok($$select public.gtm_record_piece_delivery((select id from dead_delivery),(select token from dead_delivery),null,'failed',null,'Deleted')$$,'22023',null,'stuck case: the provider id cannot be cleared');
select is(public.gtm_prepare_piece_delivery('retire','youtube','2030-11-15','17:00','UTC',pg_temp.exp('retire'))->>'id',(select id::text from dead_delivery),'stuck case: preparing the channel again returns the dead delivery');
select throws_ok($$select public.gtm_retire_piece_delivery((select id from dead_delivery),'gone')$$,'22023',null,'retiring needs recorded evidence');
select throws_ok($$select public.gtm_retire_piece_delivery((select id from dead_delivery),'GET /posts/zp-youtube returned status cancelled')$$,'PT409',null,'a just-sent request cannot be retired');
reset role;
update public.gtm_piece_delivery_attempts set last_posted_at=now()-interval '1 hour' where delivery_id in (select pg_temp.dv('retire',ch) from unnest(array['youtube','instagram']) ch);
select pg_temp.as_actor('authenticated',true);
select throws_ok($$select public.gtm_retire_piece_delivery((select id from dead_delivery),'GET /posts/zp-youtube returned status cancelled')$$,'42501',null,'the owner session cannot retire a delivery directly');
select pg_temp.as_actor('service_role');
select throws_ok($$select public.gtm_retire_piece_delivery(pg_temp.dv('retire','instagram'),'GET /posts/zp-instagram returned status cancelled')$$,'PT409',null,'a scheduled delivery is never retired');
select throws_ok($$select public.gtm_retire_piece_delivery(pg_temp.dv('recover','instagram'),'GET /posts/rp-1 returned status cancelled')$$,'PT409',null,'a published delivery is never retired');
select lives_ok($$select public.gtm_retire_piece_delivery((select id from dead_delivery),'GET /posts/zp-youtube returned status cancelled')$$,'a cancelled provider post is retired with evidence');
select ok((select delivery_id is null and provider_id='zp-youtube' and state='failed' and error like 'Provider post zp-youtube cancelled or deleted at the provider: GET%' from public.gtm_piece_delivery_attempts where id=(select token from dead_delivery)),'the attempt keeps the provider id and the evidence');
select ok((pg_temp.cal('retire-youtube')).status='failed' and (pg_temp.cal('retire-youtube')).zernio_post_id is null,'the calendar row stays failed with no live provider id');
select ok(not ((pg_temp.cal('retire-youtube')).urls ? 'youtube'),'the dead post''s link leaves the calendar row');
select ok((select retired_at is not null and provider_id='zp-youtube' from public.gtm_piece_delivery_attempts where id=(select token from dead_delivery)),'the retired provider id stays watchable for the reconciler');
select isnt(public.gtm_prepare_piece_delivery('retire','youtube','2030-11-14','17:00','UTC',pg_temp.exp('retire'))->>'id',(select id::text from dead_delivery),'the channel and day can be prepared again');
select is((pg_temp.cal('retire-youtube')).status,'drafted','the reused calendar row is drafted again');
select ok(public.gtm_claim_piece_delivery(pg_temp.dv('retire','youtube')) is not null,'the new delivery dispatches with a new key');

-- 221-2: a never-sent delivery re-checks the current approval of the versions it froze.
select public.gtm_prepare_piece_deliveries('stale','[{"channel":"linkedin","date":"2030-11-13","time":"14:00","timezone":"UTC"},{"channel":"instagram","date":"2030-11-13","time":"15:00","timezone":"UTC"}]',pg_temp.exp('stale'),'lists');
select pg_temp.as_actor('authenticated',true);
select public.gtm_decide_piece_part('stale','text','changes','Rewrite the opening',pg_temp.exp('stale')->>'text',pg_temp.rv('stale-text'));
select pg_temp.as_actor('service_role');
select throws_ok($$select public.gtm_claim_piece_delivery(pg_temp.dv('stale','linkedin'))$$,'22023','the piece changed since this delivery was prepared; release and prepare it again','changes requested on the text: the prepared delivery is refused');
select pg_temp.as_actor('authenticated',true);
select public.gtm_set_piece_dispatch('stale',null,false);
select pg_temp.as_actor('service_role');
update public.gtm_story_assets set body='New caption',sha256=repeat('e',64) where id='stale-text';
select pg_temp.as_actor('authenticated',true);
select public.gtm_decide_piece_part('stale','text','approved','',pg_temp.exp('stale')->>'text',pg_temp.rv('stale-text'));
select public.gtm_set_piece_dispatch('stale',pg_temp.exp('stale'),true);
select pg_temp.as_actor('service_role');
select is(public.gtm_piece_snapshot('stale')->>'ready','true','after pause, fix, approve and resume the piece is ready');
select throws_ok($$select public.gtm_claim_piece_delivery(pg_temp.dv('stale','linkedin'))$$,'22023','the piece changed since this delivery was prepared; release and prepare it again','the delivery prepared with the superseded caption is refused');
select lives_ok($$select public.gtm_replan_unsent_delivery(pg_temp.dv('stale','linkedin'),'2030-11-20','14:00','UTC')$$,'a superseded reservation can still move');
select throws_ok($$select public.gtm_claim_piece_delivery(pg_temp.dv('stale','linkedin'))$$,'22023','the piece changed since this delivery was prepared; release and prepare it again','moving does not launder a superseded delivery into a claim');
select lives_ok($$select public.gtm_release_piece_delivery(pg_temp.dv('stale',ch)) from unnest(array['linkedin','instagram']) ch$$,'superseded deliveries are released');
select lives_ok($$select public.gtm_prepare_piece_deliveries('stale','[{"channel":"linkedin","date":"2030-11-13","time":"14:00","timezone":"UTC"},{"channel":"instagram","date":"2030-11-13","time":"15:00","timezone":"UTC"}]',pg_temp.exp('stale'))$$,'the approved version is prepared again');
select is((pg_temp.cal('stale-linkedin')).body,'New caption','the calendar row now carries the approved caption');
select ok(public.gtm_claim_piece_delivery(pg_temp.dv('stale','linkedin')) is not null,'the new delivery dispatches');
select ok(public.gtm_claim_piece_delivery(pg_temp.dv('stale','instagram')) is not null,'a second channel is claimed before another change');
select pg_temp.as_actor('authenticated',true);
select public.gtm_decide_piece_part('stale','text','changes','One more change',pg_temp.exp('stale')->>'text',pg_temp.rv('stale-text'));
select pg_temp.as_actor('service_role');
select throws_ok($$select public.gtm_start_piece_send(pg_temp.dv('stale','instagram'),pg_temp.tok('stale','instagram'),'{"content":"New caption"}')$$,'22023','the piece changed since this delivery was prepared; release and prepare it again','a change between claim and first send stops the provider request');
select is((select count(*)::int from public.gtm_piece_delivery_attempts where story_id='stale'),0,'nothing was sent for the superseded versions');

-- 221-6 / 221-7: the approval re-check keys on "no live provider post"; retire takes failed only.
reset role;
insert into public.gtm_stories(id,title,link_url) values('reject','Reject piece','https://example.test/reject');
insert into public.gtm_story_assets(id,story_id,title,kind,source,sha256,body,storage_path,stage) values
 ('reject-text','reject','Text','copy','t.md',repeat('c',64),'Reject caption',null,null),
 ('reject-video','reject','Video','video','v.mp4',repeat('d',64),null,'stories/reject/v.mp4','final');
select pg_temp.as_actor('authenticated',true);
select public.gtm_configure_piece_review('reject','reject-text','reject-video',array['linkedin','youtube'],pg_temp.exp('reject'));
select public.gtm_decide_piece_part('reject',part,'approved','',pg_temp.exp('reject')->>part,1) from unnest(array['text','video']) part;
select pg_temp.as_actor('service_role');
select public.gtm_prepare_piece_deliveries('reject','[{"channel":"linkedin","date":"2030-11-19","time":"14:00","timezone":"UTC"},{"channel":"youtube","date":"2030-11-19","time":"17:00","timezone":"UTC"}]',pg_temp.exp('reject'),'proof');
select public.gtm_claim_piece_delivery(pg_temp.dv('reject',ch)) from unnest(array['linkedin','youtube']) ch;
select public.gtm_start_piece_send(pg_temp.dv('reject',ch),pg_temp.tok('reject',ch),'{"content":"Reject caption"}') from unnest(array['linkedin','youtube']) ch;
select public.gtm_record_piece_delivery(pg_temp.dv('reject','linkedin'),pg_temp.tok('reject','linkedin'),null,'failed',null,'400 caption invalid');
select public.gtm_record_piece_delivery(pg_temp.dv('reject','youtube'),pg_temp.tok('reject','youtube'),null,'uncertain',null,'Timed out');
select pg_temp.as_actor('authenticated',true);
select public.gtm_decide_piece_part('reject','text','changes','Rewrite it',pg_temp.exp('reject')->>'text',1);
select public.gtm_decide_piece_part('retire','text','changes','Rewrite it',pg_temp.exp('retire')->>'text',1);
select pg_temp.as_actor('service_role');
select throws_ok($$select public.gtm_claim_piece_delivery(pg_temp.dv('reject','linkedin'),true)$$,'22023','the piece changed since this delivery was prepared; release and prepare it again','a definitive rejection with no post cannot be retried with a withdrawn caption');
select lives_ok($$select public.gtm_resend_uncertain_delivery(pg_temp.dv('reject','youtube'),pg_temp.tok('reject','youtube'))$$,'a same-key resend of an uncertain create keeps its frozen request');
select public.gtm_record_piece_delivery(pg_temp.dv('retire','instagram'),pg_temp.tok('retire','instagram'),'zp-instagram','uncertain',null,'Unknown provider status');
select throws_ok($$select public.gtm_retire_piece_delivery(pg_temp.dv('retire','instagram'),'GET /posts/zp-instagram returned status cancelled')$$,'PT409',null,'an uncertain delivery is settled by a provider read before any retire');
select public.gtm_record_piece_delivery(pg_temp.dv('retire','instagram'),pg_temp.tok('retire','instagram'),'zp-instagram','failed',null,'Provider status: failed');
select ok(public.gtm_claim_piece_delivery(pg_temp.dv('retire','instagram'),true) is not null,'a retry in place of a live provider post keeps the frozen request');
select pg_temp.as_actor('anon');
select throws_ok($$select * from public.gtm_piece_deliveries$$,'42501',null,'anonymous cannot inspect frozen payloads');
reset role;
select * from finish();
rollback;
