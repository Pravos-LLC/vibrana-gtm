-- The calendar moved into the database (20261002120000): `gtm calendar import` uploads each
-- non-Story item's local media to the private content-review bucket. LinkedIn carousel posts
-- ship a ready-made PDF (format: carousel, media: carousel.pdf), which the bucket refused because
-- its allow-list only held video and images. Add application/pdf; size limit and privacy unchanged.
update storage.buckets
   set allowed_mime_types = array['video/mp4', 'image/png', 'image/jpeg', 'image/webp', 'application/pdf']
 where id = 'content-review';
