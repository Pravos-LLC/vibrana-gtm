-- The one claim before a calendar post reaches Zernio (gtm_claim_legacy_send, rewritten by 20261104020000 when shared
-- review was retired): it claims an approved row once, and refuses a held piece, a stale approval, a changed post and a
-- taken channel day.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

create function pg_temp.as_actor(r text) returns void language plpgsql as $$
begin
 execute format('set local role %I',r);
 perform set_config('request.jwt.claims',jsonb_build_object('role',r,'app_metadata',jsonb_build_object('gtm_owner',r='authenticated'))::text,true);
end $$;
create function pg_temp.expected(p_id text) returns jsonb language sql security definer as $$
 select jsonb_build_object(
  'calendar',(select jsonb_build_object('body',body,'media',media,'assets',story_assets,'date',date,'time',time,'channels',channels,'story_id',story_id,'approved_hash',approved_hash) from public.gtm_content_items where id=p_id),
  'assets',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'sha256',a.sha256,'revision',a.revision)) from public.gtm_story_assets a join public.gtm_content_items c on a.id=any(c.story_assets) where c.id=p_id),'[]'::jsonb))
$$;

insert into public.gtm_content_items(id,week,date,time,pillar,title,format,channels,status,body,media,story_assets)
 values('claim-plain',41,'2030-10-09','14:00','proof','Plain','text','{linkedin}','approved','Approved','[]','{}');
insert into public.gtm_stories(id,title,link_url,held_at) values('claim-story','Claim story','https://example.test/claim',now());
insert into public.gtm_story_assets(id,story_id,title,kind,source,sha256,body) values('claim-story-text','claim-story','Text','copy','text.md',repeat('d',64),'Story body');
insert into public.gtm_story_asset_channels(asset_id,channel) values('claim-story-text','linkedin');
insert into public.gtm_content_items(id,story_id,week,date,time,pillar,title,format,channels,status,body,media,story_assets)
 values('claim-story-linkedin','claim-story',41,'2030-10-10','14:00','proof','Story','text','{linkedin}','approved','Story body','[]','{claim-story-text}');
insert into public.gtm_content_items(id,week,date,time,pillar,title,format,channels,status,body,media,story_assets)
 values('claim-day-taken',45,'2030-11-07','09:00','proof','Taken','text','{linkedin}','scheduled','Other','[]','{}'),
       ('claim-on-taken-day',45,'2030-11-07','14:00','proof','Late','text','{linkedin}','approved','Late','[]','{}');

select pg_temp.as_actor('authenticated');
select throws_ok($$select public.gtm_claim_legacy_send('claim-plain',pg_temp.expected('claim-plain'))$$,'42501',null,'an owner session cannot claim a send directly');
reset role;

select pg_temp.as_actor('service_role');
select throws_ok($$select public.gtm_claim_legacy_send('claim-plain',jsonb_set(pg_temp.expected('claim-plain'),'{calendar,body}','"Edited"'))$$,'PT409',null,'a post that changed since the page loaded is not claimed');
select lives_ok($$select public.gtm_claim_legacy_send('claim-plain',pg_temp.expected('claim-plain'))$$,'an approved post is claimed');
select is((select zernio_post_id from public.gtm_content_items where id='claim-plain'),'pending','the claim marks the row pending');
select throws_ok($$select public.gtm_claim_legacy_send('claim-plain',pg_temp.expected('claim-plain'))$$,'PT409',null,'a second claim cannot duplicate the post');
select throws_ok($$select public.gtm_claim_legacy_send('claim-story-linkedin',pg_temp.expected('claim-story-linkedin'))$$,'22023',null,'a held piece is not claimed');
reset role;
update public.gtm_stories set held_at=null where id='claim-story';
select pg_temp.as_actor('service_role');
select throws_ok($$select public.gtm_claim_legacy_send('claim-story-linkedin',pg_temp.expected('claim-story-linkedin'))$$,'PT409',null,'a channel approval that does not match the bytes refuses the claim');
reset role;
-- John's approval on the current bytes, written as a fixture (the owner-only decision RPC is tested elsewhere).
set local session_replication_role = replica;
update public.gtm_story_asset_channels set status='approved',approved_sha256=repeat('d',64),reviewed_at=now() where asset_id='claim-story-text' and channel='linkedin';
set local session_replication_role = origin;
select pg_temp.as_actor('service_role');
select lives_ok($$select public.gtm_claim_legacy_send('claim-story-linkedin',pg_temp.expected('claim-story-linkedin'))$$,'an approved, unheld Story post is claimed');
select throws_ok($$select public.gtm_claim_legacy_send('claim-on-taken-day',pg_temp.expected('claim-on-taken-day'))$$,'PT409',null,'a channel day another post holds is refused');
reset role;
update public.gtm_content_items set status='skipped' where id='claim-day-taken';
select pg_temp.as_actor('service_role');
select lives_ok($$select public.gtm_claim_legacy_send('claim-on-taken-day',pg_temp.expected('claim-on-taken-day'))$$,'a freed channel day can be claimed');
reset role;

select * from finish();
rollback;
