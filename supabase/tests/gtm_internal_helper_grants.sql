-- These helpers are internal implementation details, called under the checked
-- SECURITY DEFINER RPCs' postgres identity, never directly through the API.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

select ok(not has_function_privilege('service_role', 'public.gtm_piece_require_actor(boolean)', 'execute'), 'service_role cannot directly call the actor helper');
select ok(not has_function_privilege('service_role', 'public.gtm_piece_asset_fingerprint(public.gtm_story_assets)', 'execute'), 'service_role cannot directly call the asset fingerprint helper');
select ok(not has_function_privilege('service_role', 'public.gtm_delivery_require_service()', 'execute'), 'service_role cannot directly call the service helper');
select ok(not has_function_privilege('service_role', 'public.gtm_piece_delivery_hold(public.gtm_piece_deliveries,boolean)', 'execute'), 'service_role cannot directly call the delivery hold helper');

set local role service_role;
select throws_ok('select public.gtm_piece_require_actor(false)', '42501', 'permission denied for function gtm_piece_require_actor', 'direct actor invocation is denied');
select throws_ok('select public.gtm_piece_asset_fingerprint(null::public.gtm_story_assets)', '42501', 'permission denied for function gtm_piece_asset_fingerprint', 'direct fingerprint invocation is denied');
select throws_ok('select public.gtm_delivery_require_service()', '42501', 'permission denied for function gtm_delivery_require_service', 'direct service helper invocation is denied');
select throws_ok('select public.gtm_piece_delivery_hold(null::public.gtm_piece_deliveries,true)', '42501', 'permission denied for function gtm_piece_delivery_hold', 'direct delivery hold invocation is denied');
reset role;

select * from finish();
rollback;
