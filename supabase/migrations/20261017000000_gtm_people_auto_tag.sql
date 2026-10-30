-- Apply synthetic local example tags; preserve the reviewed update mechanics.
alter table public.gtm_people add column auto_tag boolean not null default false;

-- The team (proven tags: all three rendered as links on the 2026-10-02 reintroduction post).
update public.gtm_people set auto_tag = true
  where linkedin_url in ('https://www.linkedin.com/in/sample-person-1', 'https://www.linkedin.com/in/sample-person-2', 'https://www.linkedin.com/in/sample-person-3');
