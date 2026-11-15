-- Behaviour tests for 20261113010000_gtm_network_mailbox.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_network_mailbox.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select is((select relrowsecurity from pg_class where oid = 'public.gtm_network_mailbox'::regclass), true, 'row level security is on');
select is((select count(*) from pg_policies where schemaname = 'public' and tablename = 'gtm_network_mailbox'), 0::bigint, 'no policy: nobody but the service role');

select pg_temp.as_role('service_role', null);
-- Any fixture row goes first (rolled back with the rest): the one-row rule is tested from empty.
delete from public.gtm_network_mailbox;
select lives_ok($$insert into public.gtm_network_mailbox (address, token_ciphertext, granted_scopes, connected_by)
  values ('jo@example.com', repeat('x', 60), '{https://www.googleapis.com/auth/gmail.readonly}', 'JOHN')$$,
  'the service role stores a sealed network mailbox token');
select throws_ok($$insert into public.gtm_network_mailbox (id, address, token_ciphertext, connected_by) values (2, 'other@example.com', repeat('x', 60), 'JOHN')$$,
  '23514', null, 'there is only ever one network mailbox');
select throws_ok($$insert into public.gtm_network_mailbox (address, token_ciphertext, connected_by) values ('other@example.com', repeat('x', 60), 'JOHN')$$,
  '23505', null, 'a second connection replaces the row, it never adds one');
select throws_ok($$update public.gtm_network_mailbox set address = 'Jo@Example.com'$$, '23514', null, 'the address is stored lowercase');
select throws_ok($$update public.gtm_network_mailbox set token_ciphertext = 'short'$$, '23514', null, 'only a sealed token fits');
select lives_ok($$update public.gtm_network_mailbox set reconnect_needed_at = now(), last_error = 'Google no longer accepts the stored connection.'$$,
  'the service role marks the connection as needing a reconnect');

select pg_temp.as_role('anon', null);
select throws_ok($$select address from public.gtm_network_mailbox$$, '42501', null, 'anonymous cannot read the network mailbox');

select pg_temp.as_role('authenticated', false);
select throws_ok($$select address from public.gtm_network_mailbox$$, '42501', null, 'a signed-in non-owner cannot read it');

select pg_temp.as_role('authenticated', true);
select throws_ok($$select address from public.gtm_network_mailbox$$, '42501', null, 'not even the owner reads it through the Data API');
select throws_ok($$insert into public.gtm_network_mailbox (address, token_ciphertext, connected_by) values ('x@example.com', repeat('x', 60), 'JOHN')$$,
  '42501', null, 'nor writes it');

select * from finish();
rollback;
