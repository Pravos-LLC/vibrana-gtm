-- Behaviour tests for 20261011150000_gtm_playbook_tags.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_playbook_tags.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(3);

select has_column('public', 'gtm_content_items', 'playbook_tags', 'calendar items carry playbook tags');
select col_type_is('public', 'gtm_content_items', 'playbook_tags', 'jsonb', 'playbook tags are jsonb');
select ok(exists(select 1 from pg_constraint where conname = 'gtm_content_items_playbook_tags_object'
  and conrelid = 'public.gtm_content_items'::regclass and contype = 'c'), 'playbook tags must be an object');

select * from finish();
rollback;
