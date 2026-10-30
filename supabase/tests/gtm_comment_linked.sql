-- Behaviour tests for 20261012180000_gtm_comment_linked.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_comment_linked.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

set local role service_role;
insert into public.gtm_comments (id, source, platform, external_id, text)
  values ('00000000-0000-0000-0000-0000000000a7', 'poll', 'linkedin', 'linked-1', 'Read this: https://example.com/essay');
select lives_ok($$update public.gtm_comments set linked = '[{"url": "https://example.com/essay", "title": "An essay", "summary": "Low tech and high tech sit on one spectrum."}]'
  where id = '00000000-0000-0000-0000-0000000000a7'$$, 'a comment keeps a summary of what it linked to');
select throws_ok($$update public.gtm_comments set linked = '{"url": "https://example.com"}' where id = '00000000-0000-0000-0000-0000000000a7'$$, '23514', null, 'linked is a list');
select throws_ok($$update public.gtm_comments set linked = '[{}, {}, {}, {}]' where id = '00000000-0000-0000-0000-0000000000a7'$$, '23514', null, 'at most three links');
select throws_ok($$update public.gtm_comments set linked = jsonb_build_array(jsonb_build_object('summary', repeat('x', 4100))) where id = '00000000-0000-0000-0000-0000000000a7'$$, '23514', null, 'summaries stay short; the page itself is never stored');

select * from finish();
rollback;
