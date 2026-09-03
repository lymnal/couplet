-- Couplet — full backend setup for a fresh Supabase project.
-- Run once in your project's SQL editor, then point config.js at the
-- project URL and publishable key.
--
-- Security model (capability-based): tables have RLS enabled with NO policies
-- (deny-all). The only access path is the SECURITY DEFINER functions below;
-- knowing a parlor code IS the capability. The publishable/anon key is safe
-- to ship client-side.

create table if not exists public.rooms (
  code       text primary key,
  state      jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.four_things (
  code       text not null,
  day        date not null,
  slot       text not null check (slot in ('A', 'B')),
  items      jsonb not null,
  created_at timestamptz not null default now(),
  primary key (code, day, slot)
);

create table if not exists public.keepsakes (
  code       text not null,
  kind       text not null,
  data       text not null,
  updated_at timestamptz not null default now(),
  primary key (code, kind)
);

alter table public.rooms enable row level security;
alter table public.four_things enable row level security;
alter table public.keepsakes enable row level security;

-- Deny-all: no policies. Belt-and-suspenders: revoke direct table access.
revoke all on public.rooms, public.four_things, public.keepsakes
  from anon, authenticated;

-- Codes are the primary key on every table, so an unbounded code is its own
-- storage attack. The join screen already caps input at 24 characters.
create or replace function public.assert_code(p_code text)
returns text
language plpgsql immutable
as $$
begin
  if p_code is null or length(p_code) = 0 or length(p_code) > 24 then
    raise exception 'invalid parlor code';
  end if;
  return upper(p_code);
end;
$$;

create or replace function public.get_room(p_code text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select state from public.rooms where code = upper(p_code);
$$;

-- Last-write-wins, enforced where it matters (added 2026-09-02). The client
-- already decides which of two competing docs survives — higher rev, then
-- newer updatedAt — but an unconditional upsert let a phone that woke up
-- holding a stale copy overwrite newer play. Now the row only changes when
-- the incoming doc would win by the same rule, and whatever is stored
-- afterwards is returned so the writer can adopt it.
create or replace function public.put_room(p_code text, p_state jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c text := assert_code(p_code);
  cur jsonb;
  new_rev numeric;
  cur_rev numeric;
begin
  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    raise exception 'room state must be an object';
  end if;
  if length(p_state::text) > 65536 then
    raise exception 'room state too large: % bytes (max 65536)', length(p_state::text);
  end if;
  new_rev := coalesce((p_state->>'rev')::numeric, 0);
  select state into cur from public.rooms where code = c for update;
  if not found then
    insert into public.rooms (code, state, updated_at) values (c, p_state, now());
    return p_state;
  end if;
  cur_rev := coalesce((cur->>'rev')::numeric, 0);
  if new_rev > cur_rev
     or (new_rev = cur_rev
         and coalesce(p_state->>'updatedAt', '') > coalesce(cur->>'updatedAt', '')) then
    update public.rooms set state = p_state, updated_at = now() where code = c;
    return p_state;
  end if;
  return cur;
end;
$$;

-- Kept for clients still running an older build: same rule, no return value.
create or replace function public.set_room(p_code text, p_state jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.put_room(p_code, p_state);
end;
$$;

create or replace function public.get_four(p_code text)
returns setof public.four_things
language sql
security definer
set search_path = public
as $$
  select * from public.four_things
  where code = upper(p_code)
  order by day desc, slot;
$$;

create or replace function public.save_four(
  p_code text, p_day date, p_slot text, p_items jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare c text := assert_code(p_code);
begin
  if length(p_items::text) > 4000 then
    raise exception 'four things too large: % bytes (max 4000)', length(p_items::text);
  end if;
  if (select count(*) from public.four_things where code = c) > 5000 then
    raise exception 'this parlor has too many entries';
  end if;
  insert into public.four_things (code, day, slot, items)
  values (c, p_day, p_slot, p_items)
  on conflict (code, day, slot) do update set items = excluded.items;
end;
$$;

create or replace function public.get_keepsake(p_code text, p_kind text)
returns text
language sql
security definer
set search_path = public
as $$
  select data from public.keepsakes
  where code = upper(p_code) and kind = p_kind;
$$;

create or replace function public.set_keepsake(p_code text, p_kind text, p_data text)
returns void language plpgsql security definer set search_path = public as $$
declare c text := assert_code(p_code);
begin
  -- photos arrive as base64 data URLs; the client downscales to well under this
  if length(p_data) > 1200000 then
    raise exception 'keepsake too large: % bytes (max 1200000)', length(p_data);
  end if;
  if length(p_kind) > 32 then raise exception 'invalid keepsake kind'; end if;
  insert into public.keepsakes (code, kind, data, updated_at)
  values (c, p_kind, p_data, now())
  on conflict (code, kind) do update set data = excluded.data, updated_at = now();
end;
$$;

create or replace function public.del_keepsake(p_code text, p_kind text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.keepsakes
  where code = upper(p_code) and kind = p_kind;
$$;

grant execute on function
  public.get_room(text),
  public.put_room(text, jsonb),
  public.set_room(text, jsonb),
  public.get_four(text),
  public.save_four(text, date, text, jsonb),
  public.get_keepsake(text, text),
  public.set_keepsake(text, text, text),
  public.del_keepsake(text, text)
to anon, authenticated;

-- Inklings (added 2026-08-04): guess-match game. Sealed fields merge via
-- coalesce so both players can write simultaneously without racing.
create table if not exists public.inklings (
  code       text not null,
  day        date not null,
  idx        int  not null,
  card       int,
  subject    text check (subject in ('A','B')),
  truth      text,
  guess      text,
  match      boolean,
  created_at timestamptz not null default now(),
  primary key (code, day, idx)
);
alter table public.inklings enable row level security;
revoke all on public.inklings from anon, authenticated;

create or replace function public.save_inkling(
  p_code text, p_day date, p_idx int,
  p_card int default null, p_subject text default null,
  p_truth text default null, p_guess text default null, p_match boolean default null
) returns void language plpgsql security definer set search_path = public as $$
declare c text := assert_code(p_code);
begin
  if length(coalesce(p_truth, '')) > 500 or length(coalesce(p_guess, '')) > 500 then
    raise exception 'inkling answer too long (max 500 characters)';
  end if;
  if (select count(*) from public.inklings where code = c) > 5000 then
    raise exception 'this parlor has too many inklings';
  end if;
  insert into public.inklings (code, day, idx, card, subject, truth, guess, match)
  values (c, p_day, p_idx, p_card, p_subject, p_truth, p_guess, p_match)
  on conflict (code, day, idx) do update set
    card    = coalesce(inklings.card, excluded.card),
    subject = coalesce(inklings.subject, excluded.subject),
    truth   = coalesce(excluded.truth, inklings.truth),
    guess   = coalesce(excluded.guess, inklings.guess),
    match   = coalesce(excluded.match, inklings.match);
end;
$$;

create or replace function public.get_inklings(p_code text)
returns setof public.inklings
language sql security definer set search_path = public as $$
  select * from public.inklings where code = upper(p_code) order by day, idx;
$$;

grant execute on function
  public.save_inkling(text,date,int,int,text,text,text,boolean),
  public.get_inklings(text)
to anon, authenticated;

-- Cheap freshness check (added 2026-08-06): lets the client skip re-downloading
-- a ~400KB photo data-URL on every app open when nothing has changed.
create or replace function public.keepsake_stamp(p_code text, p_kind text)
returns timestamptz
language sql security definer set search_path = public as $$
  select updated_at from public.keepsakes
  where code = upper(p_code) and kind = p_kind;
$$;

grant execute on function public.keepsake_stamp(text, text) to anon, authenticated;

-- Notes (moved out of rooms.state 2026-08-06). They were capped at 12 in a
-- last-write-wins document: note 13 destroyed note 1, and two simultaneous
-- writes could clobber each other. Their own table makes them unbounded,
-- safe under concurrent writes, and keeps the broadcast doc small.
create table if not exists public.notes (
  code       text not null,
  id         text not null,
  by         text not null check (by in ('A','B')),
  name       text,
  body       text not null,
  at         timestamptz not null default now(),
  primary key (code, id)
);
alter table public.notes enable row level security;
revoke all on public.notes from anon, authenticated;

create or replace function public.save_note(
  p_code text, p_id text, p_by text, p_name text, p_body text, p_at timestamptz
) returns void language plpgsql security definer set search_path = public as $$
declare c text := assert_code(p_code);
begin
  if length(p_id) > 64 or length(coalesce(p_name, '')) > 40 then
    raise exception 'invalid note';
  end if;
  if (select count(*) from public.notes where code = c) > 2000 then
    raise exception 'this parlor''s wall is full';
  end if;
  insert into public.notes (code, id, by, name, body, at)
  values (c, p_id, p_by, p_name, left(p_body, 500), coalesce(p_at, now()))
  on conflict (code, id) do nothing;
end;
$$;

create or replace function public.get_notes(p_code text)
returns setof public.notes
language sql security definer set search_path = public as $$
  select * from public.notes where code = upper(p_code) order by at;
$$;

create or replace function public.del_note(p_code text, p_id text)
returns void
language sql security definer set search_path = public as $$
  delete from public.notes where code = upper(p_code) and id = p_id;
$$;

grant execute on function
  public.save_note(text, text, text, text, text, timestamptz),
  public.get_notes(text),
  public.del_note(text, text)
to anon, authenticated;

-- Decks (added 2026-08-26): optional per-parlor content packs. A deck fully
-- replaces any of the four content sets (tangle / inklings / spectrums /
-- fourLeads); absent keys fall back to the shipped defaults. Binding is a
-- keepsake: kind 'deck', data = the deck id. Decks are immutable by
-- convention — edit by minting a new id and re-pointing the room — which is
-- what lets clients cache a deck forever. There is deliberately NO public
-- write path: author decks in the SQL editor (or your own tooling).
create table if not exists public.decks (
  id         text primary key,
  payload    jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.decks enable row level security;
revoke all on public.decks from anon, authenticated;

create or replace function public.get_deck(p_id text)
returns jsonb
language sql security definer set search_path = public as $$
  select payload from public.decks where id = upper(p_id);
$$;
grant execute on function public.get_deck(text) to anon, authenticated;

-- Erasure (added 2026-08-26): the app's "delete parlor" button. Knowing the
-- code is the capability, same as reading it.
-- Erase a parlor completely. Knowing the code is the capability, same as
-- reading it — but this is the only irreversible one, so the app asks twice.
create or replace function public.delete_room(p_code text)
returns void language plpgsql security definer set search_path = public as $$
declare c text := assert_code(p_code);
begin
  delete from public.four_things where code = c;
  delete from public.inklings    where code = c;
  delete from public.notes       where code = c;
  delete from public.keepsakes   where code = c;
  delete from public.rooms       where code = c;
end;
$$;

grant execute on function public.delete_room(text) to anon, authenticated;
revoke execute on function public.assert_code(text) from anon, authenticated;
