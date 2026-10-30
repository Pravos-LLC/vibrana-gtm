-- Internal helpers execute through postgres-owned SECURITY DEFINER RPCs and triggers.
-- Supabase grants service_role EXECUTE through postgres's default privileges; the
-- original PUBLIC/anon/authenticated revokes did not remove that independent grant.
-- Keep the exposed, checked RPC grants unchanged and close direct helper access.
revoke execute on function public.gtm_piece_require_actor(boolean) from service_role;
revoke execute on function public.gtm_piece_asset_fingerprint(public.gtm_story_assets) from service_role;
revoke execute on function public.gtm_delivery_require_service() from service_role;
revoke execute on function public.gtm_piece_delivery_hold(public.gtm_piece_deliveries,boolean) from service_role;
