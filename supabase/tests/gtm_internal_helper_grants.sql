-- These helpers are internal implementation details, called under the checked
-- SECURITY DEFINER RPCs' postgres identity, never directly through the API.
begin;
create extension if not exists pgtap with schema extensions;
select plan(2);

select ok(not has_function_privilege('service_role', 'public.gtm_delivery_require_service()', 'execute'), 'service_role cannot directly call the service helper');

set local role service_role;
select throws_ok('select public.gtm_delivery_require_service()', '42501', 'permission denied for function gtm_delivery_require_service', 'direct service helper invocation is denied');
reset role;

select * from finish();
rollback;
