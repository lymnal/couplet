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

create or replace function public.get_room(p_code text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select state from public.rooms where code = upper(p_code);
$$;

create or replace function public.set_room(p_code text, p_state jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.rooms (code, state, updated_at)
  values (upper(p_code), p_state, now())
  on conflict (code)
  do update set state = excluded.state, updated_at = now();
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
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.four_things (code, day, slot, items)
  values (upper(p_code), p_day, p_slot, p_items)
  on conflict (code, day, slot)
  do update set items = excluded.items;
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

create or replace function public.set_keepsake(
  p_code text, p_kind text, p_data text
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.keepsakes (code, kind, data, updated_at)
  values (upper(p_code), p_kind, p_data, now())
  on conflict (code, kind)
  do update set data = excluded.data, updated_at = now();
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
) returns void
language sql security definer set search_path = public as $$
  insert into public.inklings (code, day, idx, card, subject, truth, guess, match)
  values (upper(p_code), p_day, p_idx, p_card, p_subject, p_truth, p_guess, p_match)
  on conflict (code, day, idx) do update set
    card    = coalesce(inklings.card, excluded.card),
    subject = coalesce(inklings.subject, excluded.subject),
    truth   = coalesce(excluded.truth, inklings.truth),
    guess   = coalesce(excluded.guess, inklings.guess),
    match   = coalesce(excluded.match, inklings.match);
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
) returns void
language sql security definer set search_path = public as $$
  insert into public.notes (code, id, by, name, body, at)
  values (upper(p_code), p_id, p_by, p_name, left(p_body, 500), coalesce(p_at, now()))
  on conflict (code, id) do nothing;
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
