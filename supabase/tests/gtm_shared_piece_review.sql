begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users(id,aud,role,email) values('00000000-0000-0000-0000-000000000001','authenticated','authenticated','shared-review-owner@example.test') on conflict(id) do nothing;
create function pg_temp.as_actor(r text, owner boolean default false) returns void language plpgsql as $$
begin
  execute format('set local role %I',r);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',case when r='authenticated' then '00000000-0000-0000-0000-000000000001' else null end,'role',r,'app_metadata',jsonb_build_object('gtm_owner',owner),'user_metadata',jsonb_build_object('gtm_owner',true))::text,true);
end $$;
create function pg_temp.fp(asset text) returns text language sql security definer as $$ select public.gtm_piece_asset_fingerprint(a) from public.gtm_story_assets a where id=asset $$;
create function pg_temp.fix() returns uuid language sql security definer as $$ select id from public.gtm_piece_fixes where story_id='shared-test' and status='open' $$;
insert into public.gtm_stories(id,title,link_url) values('shared-test','Shared piece','https://example.test/shared');
insert into public.gtm_story_assets(id,story_id,title,kind,source,sha256,body,storage_path,stage) values
('shared-text','shared-test','Shared text','copy','caption.md',repeat('a',64),'One caption',null,null),
('shared-video','shared-test','Shared video','video','video.mp4',repeat('b',64),null,'stories/shared/video.mp4','final');
insert into public.gtm_story_asset_channels(asset_id,channel) values ('shared-text','linkedin'),('shared-text','youtube'),('shared-video','linkedin'),('shared-video','youtube');
select pg_temp.as_actor('anon');
select throws_ok($$select public.gtm_piece_snapshot('shared-test')$$,'42501',null,'anonymous cannot inspect shared review');
select throws_ok($$select * from public.gtm_piece_reviews$$,'42501',null,'anonymous has no table access');
select pg_temp.as_actor('authenticated',false);
select is((select count(*)::int from public.gtm_piece_reviews),0,'user metadata owner impersonation grants no rows');
select throws_ok($$select public.gtm_piece_snapshot('shared-test')$$,'42501',null,'non-owner cannot call privileged snapshot');
select pg_temp.as_actor('authenticated',true);
select public.gtm_decide_story_asset('shared-text','linkedin','approved','',repeat('a',64),1);
select throws_ok($$select public.gtm_configure_piece_review('shared-test','shared-text','shared-video',array['linkedin','youtube'],'{}')$$,'PT409',null,'stale canonical selection fails before any write');
select is((select count(*)::int from public.gtm_piece_reviews),0,'failed selection is atomic');
select lives_ok($$select public.gtm_configure_piece_review('shared-test','shared-text','shared-video',array['linkedin','youtube'],jsonb_build_object('text',pg_temp.fp('shared-text'),'video',pg_temp.fp('shared-video')))$$,'owner selects exactly one shared text and video');
select is(public.gtm_piece_snapshot('shared-test')->'text'->>'status','approved','real approval of these exact bytes carries across channels');
select is(public.gtm_piece_snapshot('shared-test')->'video'->>'status','pending','no video approval is invented');
select is(public.gtm_piece_snapshot('shared-test')->>'dispatchEnabled','false','adoption never releases existing backlog');
select throws_ok($$update public.gtm_piece_reviews set dispatch_enabled=true$$,'42501',null,'owner cannot bypass RPC by table write');
select throws_ok($$select public.gtm_decide_story_asset('shared-video','youtube','approved','',repeat('b',64),1)$$,'22023',null,'legacy platform approval cannot compete with shared authority');
select throws_ok($$select public.gtm_decide_piece_part('shared-test','video','approved','','stale',1)$$,'PT409',null,'owner cannot approve an unseen video');
select lives_ok($$select public.gtm_decide_piece_part('shared-test','video','approved','',pg_temp.fp('shared-video'),1)$$,'one video decision applies to both channels');
select is(public.gtm_piece_snapshot('shared-test')->>'ready','true','both shared parts are ready without platform decisions');
select pg_temp.as_actor('service_role');
select throws_ok($$update public.gtm_piece_part_decisions set status='approved'$$,'42501',null,'service cannot approve directly around scoped completion');
update public.gtm_story_assets set title='Another display title',storage_path='stories/shared/moved.mp4' where id='shared-video';
select is(public.gtm_piece_snapshot('shared-test')->'video'->>'status','approved','identical video bytes keep approval after a key move');
select throws_ok($$select public.gtm_decide_piece_part('shared-test','text','approved','',pg_temp.fp('shared-text'),1)$$,'42501',null,'service cannot impersonate owner approval');
update public.gtm_story_assets set body='A changed caption',sha256=repeat('c',64) where id='shared-text';
select is(public.gtm_piece_snapshot('shared-test')->'text'->>'status','pending','changed caption reopens text only');
select is(public.gtm_piece_snapshot('shared-test')->'video'->>'status','approved','text edit never resets video approval');
select pg_temp.as_actor('authenticated',true);
select lives_ok($$select public.gtm_decide_piece_part('shared-test','text','fixing','Change caption spelling',pg_temp.fp('shared-text'),2)$$,'owner authorises a specified fix');
select is(public.gtm_piece_snapshot('shared-test')->'text'->>'status','fixing','accepted note is visibly fixing');
select is(public.gtm_piece_snapshot('shared-test')->>'ready','false','accepted note blocks publishing');
select throws_ok($$select public.gtm_complete_piece_fix(pg_temp.fix(),pg_temp.fp('shared-text'),2,'worker','Verified',true)$$,'42501',null,'browser cannot certify its own fix completion');
select pg_temp.as_actor('service_role');
select throws_ok($$select public.gtm_complete_piece_fix(pg_temp.fix(),pg_temp.fp('shared-text'),2,'worker','Verified',true)$$,'22023',null,'completion without changed content is refused');
update public.gtm_story_assets set body='A corrected caption',sha256=repeat('d',64) where id='shared-text';
select is(public.gtm_piece_snapshot('shared-test')->'text'->>'status','fixing','restaging a fix does not silently approve it');
select throws_ok($$select public.gtm_complete_piece_fix(pg_temp.fix(),pg_temp.fp('shared-text'),3,'worker','Verified',false)$$,'22023',null,'unrelated changes cannot use fix authorisation');
select throws_ok($$select public.gtm_complete_piece_fix(pg_temp.fix(),'stale',3,'worker','Verified',true)$$,'PT409',null,'completion must name the version actually verified');
select lives_ok($$select public.gtm_complete_piece_fix(pg_temp.fix(),pg_temp.fp('shared-text'),3,'content-worker','Checked the specified spelling fix and unchanged video',true)$$,'specified fix completes atomically without an owner session');
select is(public.gtm_piece_snapshot('shared-test')->>'ready','true','completed authorised fix releases its part');
select ok((select completed_by='content-worker' and completed_revision=3 and authorised_by='00000000-0000-0000-0000-000000000001' from public.gtm_piece_fixes where story_id='shared-test'),'fix evidence retains owner authority and actual completing actor');
select ok((select resolved_at is not null from public.gtm_story_feedback where id=(select feedback_id from public.gtm_piece_fixes where story_id='shared-test')),'work note closes in the same transaction');
update public.gtm_story_assets set metadata='{"thumbnail_sha256":"new-thumbnail"}' where id='shared-text';
select is(public.gtm_piece_snapshot('shared-test')->'text'->>'status','pending','thumbnail bytes affect text/packaging approval even if source text is identical');
select is(public.gtm_piece_snapshot('shared-test')->'video'->>'status','approved','packaging does not reset the video');
select pg_temp.as_actor('authenticated',true);
select public.gtm_decide_piece_part('shared-test','text','approved','',pg_temp.fp('shared-text'),3);
select pg_temp.as_actor('service_role');
update public.gtm_stories set held_at=now(),hold_who='reviewer' where id='shared-test';
select is(public.gtm_piece_snapshot('shared-test')->>'ready','false','manual hold remains a final dispatch blocker');
select pg_temp.as_actor('authenticated',false);
select is((select count(*)::int from public.gtm_piece_fixes),0,'non-owner cannot read fix notes or authorisation evidence');

-- Scoped legacy notes and exact final-stage rules cannot be bypassed during migration or restaging.
select pg_temp.as_actor('service_role');
update public.gtm_stories set held_at=null,hold_who=null,hold_note='',held_by=null where id='shared-test';
update public.gtm_story_assets set stage='rough-cut' where id='shared-video';
select is(public.gtm_piece_snapshot('shared-test')->'video'->>'status','pending','moving stage invalidates final video approval');
select pg_temp.as_actor('authenticated',true);
select throws_ok($$select public.gtm_decide_piece_part('shared-test','video','approved','',pg_temp.fp('shared-video'),2)$$,'22023',null,'rough cut cannot get final shared approval');
select pg_temp.as_actor('service_role');
update public.gtm_story_assets set stage='final' where id='shared-video';
select is(public.gtm_piece_snapshot('shared-test')->'video'->>'status','pending','promoting identical rough bytes never inherits a final approval');
select throws_ok($$update public.gtm_story_assets set kind='image' where id='shared-video'$$,'22023',null,'selected video cannot silently change kind');
select lives_ok($$insert into public.gtm_story_stage_decisions(story_id,stage,party,decision,note,assets) values('shared-test','rough-cut','john','reopened','Again','[]')$$,'a send-back before the final is recorded on an adopted piece');
select is(public.gtm_piece_snapshot('shared-test')->'video'->>'status','pending','a send-back leaves the shared video unapproved');
update public.gtm_story_assets set body='[JOHN: fill in detail]',sha256=repeat('e',64) where id='shared-text';
select pg_temp.as_actor('authenticated',true);
select throws_ok($$select public.gtm_decide_piece_part('shared-test','text','approved','',pg_temp.fp('shared-text'),4)$$,'22023',null,'PostgreSQL placeholder guard rejects real owner markers');
select throws_ok($$select public.gtm_decide_piece_part('shared-test','text','fixing','Fix it',pg_temp.fp('shared-text'),4)$$,'22023',null,'incomplete text cannot receive delegated approval');
select pg_temp.as_actor('service_role');
update public.gtm_story_assets set body='Finished',sha256=repeat('f',64) where id='shared-text';
insert into public.gtm_story_feedback(asset_id,body,author) values('shared-video','[approved with note: fix before scheduling] part=text channels=linkedin,youtube assets=shared-text'||chr(10)||'Correct the detail','john');
select ok(public.gtm_piece_snapshot('shared-test')->'blockers' ? 'Existing accepted notes need conversion before scheduling','legacy marker on a different asset remains a scheduling blocker');
select is(jsonb_array_length(public.gtm_piece_snapshot('shared-test')->'legacyFixes'),1,'legacy accepted notes remain visible for explicit conversion');


select throws_ok($$update public.gtm_story_assets set story_id='other-piece' where id='shared-video'$$,'22023',null,'selected asset membership cannot be moved behind approval');
update public.gtm_story_feedback set resolved_at=now(),resolution='Migrated fixture note' where asset_id='shared-video' and resolved_at is null;
update public.gtm_stories set third_party_who='Current reviewer' where id='shared-test';
insert into public.gtm_story_stage_decisions(story_id,stage,party,who,decision,note,assets) values('shared-test','final','third_party','Other reviewer','approved','Approved',jsonb_build_array(jsonb_build_object('asset_id','shared-video','sha256',repeat('b',64))));
select ok(public.gtm_piece_snapshot('shared-test')->'blockers' ? 'Waiting for third-party approval','approval by a different party never clears the required reviewer gate');
insert into public.gtm_story_stage_decisions(story_id,stage,party,who,decision,note,assets) values('shared-test','final','third_party','Current reviewer','approved','Approved',jsonb_build_array(jsonb_build_object('asset_id','shared-video','sha256',repeat('b',64))));
select ok(not(public.gtm_piece_snapshot('shared-test')->'blockers' ? 'Waiting for third-party approval'),'current-party current-video signoff clears the media-only gate');
select pg_temp.as_actor('authenticated',true);
select public.gtm_decide_piece_part('shared-test','text','fixing','Correct the spelling',pg_temp.fp('shared-text'),5);
select pg_temp.as_actor('service_role');
update public.gtm_story_assets set body='[TODO: finish this]',sha256=repeat('1',64) where id='shared-text';
select throws_ok($$select public.gtm_complete_piece_fix(pg_temp.fix(),pg_temp.fp('shared-text'),6,'worker','Checked',true)$$,'22023',null,'placeholder cannot be approved through delegated completion');
select is(public.gtm_piece_snapshot('shared-test')->'text'->>'status','fixing','failed completion is atomic and leaves the piece blocked');
select pg_temp.as_actor('authenticated',true);
select set_config('request.jwt.claims','{"role":"authenticated","app_metadata":{"gtm_owner":true}}',true);
select throws_ok($$select public.gtm_piece_snapshot('shared-test')$$,'42501',null,'owner claim without a signed-in user is refused');


select pg_temp.as_actor('authenticated',true);
select throws_ok($$select public.gtm_save_piece_text('shared-test','My human edit','stale',6)$$,'PT409',null,'save rejects a stale editor atomically');
select lives_ok($$select public.gtm_save_piece_text('shared-test','My human edit',pg_temp.fp('shared-text'),6)$$,'human save updates just the one canonical caption');
select is((select body from public.gtm_story_assets where id='shared-text'),'My human edit','canonical text contains saved human words');
select is((select metadata->>'edited_in_dashboard' is not null from public.gtm_story_assets where id='shared-text'),true,'staging receives protection against overwriting a human edit');

select is(public.gtm_piece_snapshot('shared-test')->'text'->>'status','pending','manual unrelated edit cancels delegated approval');
select is(jsonb_array_length(public.gtm_piece_snapshot('shared-test')->'fixes'),0,'superseded fix cannot be completed by an agent');
select is((select count(*)::int from public.gtm_story_feedback where resolved_at is null and id in (select feedback_id from public.gtm_piece_fixes where status='cancelled')),0,'superseded authorisations do not leave ghost waiting work');
select pg_temp.as_actor('service_role');
insert into public.gtm_story_feedback(asset_id,body,author) values('shared-video','[approved with note: fix before scheduling] part=text channels=linkedin assets=shared-text'||chr(10)||'Correct this detail','john');
select pg_temp.as_actor('authenticated',true);
select public.gtm_convert_piece_legacy_fix('shared-test',(select id from public.gtm_story_feedback where resolved_at is null and body like '[approved with note:%' limit 1),'text',pg_temp.fp('shared-text'),7);
select ok(not(public.gtm_piece_snapshot('shared-test')->'blockers' ? 'Existing accepted notes need conversion before scheduling') and public.gtm_piece_snapshot('shared-test')->'text'->>'status'='fixing','explicit owner conversion retains a blocking scoped fix');

-- Review follow-ups: service adoption, pre-final gates, scoped legacy guard, dispatch, removal, release.
reset role;
insert into public.gtm_stories(id,title,link_url) values('shared-two','Second piece','https://example.test/two'),('shared-three','Reviewed piece','https://example.test/three');
insert into public.gtm_story_assets(id,story_id,title,kind,source,sha256,body,storage_path,stage) values
('two-text','shared-two','Text','copy','caption.md',repeat('2',64),'Two caption',null,null),
('two-video','shared-two','Video','video','v.mp4',repeat('3',64),null,'stories/two/v.mp4',null),
('two-video-alt','shared-two','Alt video','video','v2.mp4',repeat('4',64),null,'stories/two/v2.mp4','final'),
('two-cover','shared-two','Cover','image','cover.jpg',repeat('5',64),null,'stories/two/cover.jpg',null),
('three-text','shared-three','Text','copy','c.md',repeat('6',64),'Three caption',null,null),
('three-video','shared-three','Video','video','v.mp4',repeat('7',64),null,'stories/three/v.mp4','final');
insert into public.gtm_story_asset_channels(asset_id,channel) values ('two-text','linkedin'),('two-text','instagram'),('two-video','linkedin'),('two-video','instagram'),('two-cover','instagram'),('three-text','linkedin'),('three-video','linkedin');
create function pg_temp.rev(asset text) returns bigint language sql security definer as $$ select revision from public.gtm_story_assets where id=asset $$;

select pg_temp.as_actor('service_role');
select lives_ok($$select public.gtm_configure_piece_review('shared-two','two-text','two-video',array['linkedin','instagram'],jsonb_build_object('text',pg_temp.fp('two-text'),'video',pg_temp.fp('two-video')))$$,'service staging may adopt a piece nobody has reviewed');
select is(public.gtm_piece_snapshot('shared-two')->'text'->>'status','pending','service adoption invents no text approval');
select is(public.gtm_piece_snapshot('shared-two')->'video'->>'status','pending','service adoption invents no video approval');
select is(public.gtm_piece_snapshot('shared-two')->>'dispatchEnabled','false','service adoption does not release dispatch');
select is((select count(*)::int from public.gtm_story_asset_channels where asset_id like 'two-%' and status<>'pending'),0,'adoption leaves every legacy row as it was');
select pg_temp.as_actor('authenticated',true);
select public.gtm_decide_story_asset('three-text','linkedin','approved','',repeat('6',64),1);
select pg_temp.as_actor('service_role');
select throws_ok($$select public.gtm_configure_piece_review('shared-three','three-text','three-video',array['linkedin'],jsonb_build_object('text',pg_temp.fp('three-text'),'video',pg_temp.fp('three-video')))$$,'42501',null,'service cannot adopt a piece John already reviewed');

select pg_temp.as_actor('authenticated',true);
select public.gtm_decide_piece_part('shared-two','text','approved','',pg_temp.fp('two-text'),pg_temp.rev('two-text'));
select lives_ok($$select public.gtm_decide_piece_part('shared-two','video','approved','',pg_temp.fp('two-video'),pg_temp.rev('two-video'))$$,'a stageless video is a final for shared approval');
select pg_temp.as_actor('service_role');
update public.gtm_story_assets set stage='final' where id='two-video';
select is(public.gtm_piece_snapshot('shared-two')->'video'->>'status','approved','annotating a stageless video as final keeps its approval');
select is(public.gtm_piece_snapshot('shared-two')->>'ready','true','fresh owner approvals release the piece');

select pg_temp.as_actor('authenticated',true);
select lives_ok($$select public.gtm_decide_story_asset('two-cover','instagram','approved','',repeat('5',64),1)$$,'a cover of an adopted piece stays decidable per platform');
select throws_ok($$select public.gtm_decide_story_asset('two-text','linkedin','approved','',repeat('2',64),1)$$,'22023',null,'the selected text still refuses a competing platform approval');

select lives_ok($$select public.gtm_set_piece_dispatch('shared-two',null,false)$$,'owner pauses dispatch without a content decision');
select ok(public.gtm_piece_snapshot('shared-two')->'blockers' ? 'Scheduling is paused for this piece' and public.gtm_piece_snapshot('shared-two')->'text'->>'status'='approved','a pause blocks dispatch and keeps approvals');
select throws_ok($$select public.gtm_set_piece_dispatch('shared-two','{"text":"stale","video":"stale"}',true)$$,'PT409',null,'enabling names the versions on screen');
select throws_ok($$select public.gtm_set_piece_dispatch('shared-two',null,null)$$,'22023',null,'dispatch needs an explicit choice');
select lives_ok($$select public.gtm_set_piece_dispatch('shared-two',jsonb_build_object('text',pg_temp.fp('two-text'),'video',pg_temp.fp('two-video')),true)$$,'owner resumes dispatch without re-approving');
select is(public.gtm_piece_snapshot('shared-two')->>'ready','true','a resumed piece is ready again');
select throws_ok($$select public.gtm_set_piece_dispatch('shared-test-missing',null,false)$$,'22023',null,'dispatch needs a shared piece');
select pg_temp.as_actor('service_role');
select throws_ok($$select public.gtm_set_piece_dispatch('shared-two',null,false)$$,'42501',null,'service cannot change dispatch');

-- The stage RPCs (gtm_decide_story_stage, gtm_decide_storyboard*, gtm_reopen_storyboard) insert these rows.
reset role;
select lives_ok($$insert into public.gtm_story_stage_decisions(story_id,stage,party,decision,note,assets) values('shared-two','storyboard','john','approved','Good','[]')$$,'a storyboard approval keeps working on an adopted piece');
select lives_ok($$insert into public.gtm_story_stage_decisions(story_id,stage,party,decision,note,assets) values('shared-two','rough-cut','john','approved','Good','[]')$$,'a rough-cut approval keeps working on an adopted piece');
select lives_ok($$insert into public.gtm_story_stage_decisions(story_id,stage,party,decision,note,assets) values('shared-two','paper-edit','john','changes','Tighten','[]')$$,'a pre-final change request keeps working on an adopted piece');
select pg_temp.as_actor('service_role');
select is(public.gtm_piece_snapshot('shared-two')->'video'->>'status','approved','pre-final approvals and notes never touch the shared decisions');
select pg_temp.as_actor('authenticated',true);
select public.gtm_decide_piece_part('shared-two','video','fixing','Trim the intro',pg_temp.fp('two-video'),pg_temp.rev('two-video'));
reset role;
insert into public.gtm_story_stage_decisions(story_id,stage,party,decision,note,assets) values('shared-two','rough-cut','john','reopened','Back to the rough cut','[]');
select pg_temp.as_actor('service_role');
select is(public.gtm_piece_snapshot('shared-two')->'video'->>'status','pending','a send-back withdraws the shared video approval, even one waiting for a fix');
select is(public.gtm_piece_snapshot('shared-two')->'text'->>'status','approved','a send-back leaves the text approval');
select is((select count(*)::int from public.gtm_piece_fixes where story_id='shared-two' and status='open'),0,'a send-back ends the open video fix authorisation');
select is((select count(*)::int from public.gtm_story_feedback where asset_id='two-video' and resolved_at is null and body='Trim the intro'),1,'John''s note stays open on the video');

select pg_temp.as_actor('authenticated',true);
select public.gtm_decide_piece_part('shared-two','video','fixing','Use the other take',pg_temp.fp('two-video'),pg_temp.rev('two-video'));
select lives_ok($$select public.gtm_configure_piece_review('shared-two','two-text','two-video-alt',array['linkedin','instagram'],jsonb_build_object('text',pg_temp.fp('two-text'),'video',pg_temp.fp('two-video-alt')))$$,'owner reselects the video');
reset role;
select lives_ok($$delete from public.gtm_story_assets where id='two-video'$$,'an asset referenced only by a cancelled fix can be removed');
select is((select count(*)::int from public.gtm_piece_fixes where asset_id='two-video'),0,'its cancelled fix goes with it');
select throws_ok($$delete from public.gtm_story_assets where id='two-text'$$,'22023',null,'the selected text cannot be removed underneath the shared review');
select lives_ok($$delete from public.gtm_story_assets where id='two-cover'$$,'a non-selected asset of an adopted piece can be removed');

select pg_temp.as_actor('authenticated',true);
select public.gtm_configure_piece_review('shared-three','three-text','three-video',array['linkedin'],jsonb_build_object('text',pg_temp.fp('three-text'),'video',pg_temp.fp('three-video')));
select pg_temp.as_actor('service_role');
select throws_ok($$select public.gtm_release_piece_review('shared-three')$$,'42501',null,'service cannot release a shared review');
select pg_temp.as_actor('authenticated',true);
select is(public.gtm_release_piece_review('shared-three')->>'textApprovalKept','true','release reports the carried approval');
select is((select status from public.gtm_story_asset_channels where asset_id='three-text' and channel='linkedin'),'approved','an approval of the same bytes survives release');
select is((select count(*)::int from public.gtm_piece_reviews where story_id='shared-three'),0,'release removes the shared selection');
select is((select count(*)::int from public.gtm_piece_part_decisions where story_id='shared-three'),0,'release removes the shared decisions');
select is((select count(*)::int from public.gtm_story_assets where story_id='shared-three' and (metadata ? 'shared_review' or metadata ? 'shared_review_part')),0,'release clears the adoption markers');
select is(public.gtm_piece_snapshot('shared-three'),null::jsonb,'a released piece has no shared snapshot');
select throws_ok($$select public.gtm_release_piece_review('shared-three')$$,'22023',null,'releasing twice is refused');
select public.gtm_configure_piece_review('shared-three','three-text','three-video',array['linkedin'],jsonb_build_object('text',pg_temp.fp('three-text'),'video',pg_temp.fp('three-video')));
select public.gtm_decide_piece_part('shared-three','text','changes','Rewrite the opening',pg_temp.fp('three-text'),pg_temp.rev('three-text'));
select is(public.gtm_release_piece_review('shared-three')->>'textApprovalKept','false','a withdrawn shared approval is reported');
select is((select status from public.gtm_story_asset_channels where asset_id='three-text' and channel='linkedin'),'pending','release never resurrects an approval withdrawn while shared');
select is((select count(*)::int from public.gtm_story_feedback where asset_id='three-text' and resolved_at is null and body='Rewrite the opening'),1,'release keeps John''s note open');
select lives_ok($$select public.gtm_decide_story_asset('three-text','linkedin','approved','',repeat('6',64),1)$$,'a released piece is decidable per platform again');
select public.gtm_configure_piece_review('shared-three','three-text','three-video',array['linkedin'],jsonb_build_object('text',pg_temp.fp('three-text'),'video',pg_temp.fp('three-video')));
reset role;
select lives_ok($$delete from public.gtm_stories where id='shared-three'$$,'deleting an adopted Story still cascades');
select is((select count(*)::int from public.gtm_piece_reviews where story_id='shared-three'),0,'the deleted Story leaves no shared review');
reset role;
select * from finish();
rollback;
