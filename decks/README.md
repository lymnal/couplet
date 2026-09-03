# Decks — personalized content for one parlor

Every parlor plays the same five games, but the *content* — Tangle puzzles,
Inklings cards, Attune spectrums, Four Things prompts — can be swapped per
parlor. That's a **deck**: a JSON document that fully replaces any of the four
content sets. Whatever a deck doesn't include falls back to the built-ins, so
a deck of nothing but twenty Inklings cards about your two dogs is a perfectly
good deck.

The default content is written for any two people anywhere. Decks are for the
other thing: puzzles about the city you actually live in, the food you actually
argue about, the trip you actually took.

## Want one?

Open a [deck request](../../issues/new?template=deck-request.yml) and tell us
about the two of you. Hand-making a deck takes a while, so no promises on
timing — but requests with specific, textured details ("she defends pineapple
pizza in court", not "she likes food") get made first, because they make the
best puzzles.

## Format

See [`example-deck.json`](example-deck.json). All four keys are optional; each
one present replaces that game's content entirely:

| key | shape | notes |
|---|---|---|
| `tangle` | `[{ groups: [{ title, words: [4] }, ×4] }]` | 4 groups of 4; all 16 words unique per puzzle. Any number of puzzles. |
| `inklings` | `["…@S…"]` | `@S` = who's answering about themselves, `@P` = who's guessing. Every card must mention `@S`. |
| `spectrums` | `[["left", "right"]]` | `@A`/`@B` render as the two players' names. |
| `fourLeads` | `["What four things …?"]` | The nightly prompt rotates through these. |
| `duetAnswers` | `["STORM", "LATTE", …]` | Five letters a–z each, no repeats. Replaces the answer list; the shared guess dictionary still applies, plus these. A few dozen keeps the daily word fresh. |

Duet's *guess* dictionary is shared by everyone; its *answers* can be yours (`duetAnswers`).

## Rules of the road

- **Decks are immutable.** Clients cache a deck forever by its id. To revise
  one, insert a **new id** and re-point the parlor — never update a row in
  place.
- **A parlor's plays are keyed to its deck's order.** Re-pointing a parlor to
  a deck with different puzzle order makes old Tangle/Attune history point at
  different content. Bind a deck when a parlor is young, or keep the order
  stable across versions.
- **A deck id is a capability**, like a parlor code: anyone holding the id can
  read the deck. Use a random id, and keep the in-jokes the kind you'd be
  okay explaining at a dinner party.

## Self-hosting

Running your own parlor (see the [main README](../README.md))? The schema in
[`supabase/setup.sql`](../supabase/setup.sql) includes the `decks` table.
Author a deck in your project's SQL editor:

```sql
insert into decks (id, payload) values ('YOURDECK1', '{ …deck json… }');
insert into keepsakes (code, kind, data) values ('YOURROOM1', 'deck', 'YOURDECK1')
  on conflict (code, kind) do update set data = excluded.data, updated_at = now();
```

Unbind a parlor by deleting its `deck` keepsake. There is intentionally no
public write path for decks — the publishable key can only *read* them.
