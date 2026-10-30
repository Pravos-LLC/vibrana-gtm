-- VIB-400: covering index for the composite FK review_comments (asset_id, batch_id)
-- -> review_assets (id, batch_id). review_comments_asset_idx is (asset_id, t_ms) and does
-- not cover it, so cascading deletes from review_assets scanned review_comments
-- (advisor: unindexed_foreign_keys).
create index if not exists review_comments_asset_batch_idx on public.review_comments (asset_id, batch_id);
