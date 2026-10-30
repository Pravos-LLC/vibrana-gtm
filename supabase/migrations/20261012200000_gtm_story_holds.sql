
alter table public.gtm_stories
  add column hold_who text,
  add column hold_note text not null default '',
  add column held_at timestamptz,
  add column held_by uuid,
  add constraint gtm_stories_hold check (
    (held_at is null and hold_who is null and hold_note = '' and held_by is null)
    or (held_at is not null and length(hold_who) <= 200 and length(hold_note) <= 2000)
  );

create index gtm_stories_held_idx on public.gtm_stories (id) where held_at is not null;

create function public.gtm_set_story_hold(p_story_id text, p_held boolean, p_who text, p_note text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or
     not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false) then
    raise exception 'only the signed-in owner can hold a Story' using errcode = 'insufficient_privilege';
  end if;
  if p_held is null or length(coalesce(p_who, '')) > 200 or length(coalesce(p_note, '')) > 2000 then
    raise exception 'invalid hold' using errcode = 'invalid_parameter_value';
  end if;
  if p_held then
    update public.gtm_stories
       set held_at = coalesce(held_at, now()), held_by = (select auth.uid()),
           hold_who = btrim(coalesce(p_who, '')), hold_note = btrim(coalesce(p_note, '')), updated_at = now()
     where id = p_story_id;
  else
    update public.gtm_stories
       set held_at = null, held_by = null, hold_who = null, hold_note = '', updated_at = now()
     where id = p_story_id;
  end if;
  if not found then raise exception 'Story not found'; end if;
  return p_held;
end $$;
revoke all on function public.gtm_set_story_hold(text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.gtm_set_story_hold(text, boolean, text, text) to authenticated;

update public.gtm_stories
   set held_at = now(), hold_who = 'example_approver / Example Series', hold_note = 'Awaiting final example approval'
 where id ~ '^s1-(18|19|20|21|22)-example-record-' and held_at is null;
