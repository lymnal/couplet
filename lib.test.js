/* Run with: node --test    (no dependencies, no build step)
 *
 * These cover the logic that fails quietly rather than loudly: dates across
 * month/year/DST boundaries, streaks, and the last-write-wins rule that
 * decides whose change survives when both phones write at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDeckContent,
  validateDeck,
  otherSlot,
  dayKeyFor,
  prevDay,
  hashStr,
  ritualMap,
  ritualStreak,
  shouldApplyRemote,
  inkSubjectFor,
  inkCurrentIdx,
  inkSeal,
  inkUnseal,
  renderInkPrompt,
  pickTanglePuzzle,
  pickUnusedWord,
  pickAttuneSpectrums,
  inkDealPool,
  duetStreakAfterWin,
} from "./lib.js";

test("otherSlot flips both ways", () => {
  assert.equal(otherSlot("A"), "B");
  assert.equal(otherSlot("B"), "A");
});

test("dayKeyFor uses New York, not UTC", () => {
  /* 9pm ET on Aug 5 is already Aug 6 in UTC — the parlor's night must
     still be the 5th, or Four Things lands on the wrong day */
  const ninePmEt = new Date("2026-08-06T01:30:00Z");
  assert.equal(dayKeyFor(ninePmEt), "2026-08-05");
});

test("dayKeyFor holds through a DST change", () => {
  /* 1am ET on the spring-forward morning */
  const duringDst = new Date("2026-03-08T06:30:00Z");
  assert.equal(dayKeyFor(duringDst), "2026-03-08");
});

test("prevDay crosses month, year and leap-day boundaries", () => {
  assert.equal(prevDay("2026-08-01"), "2026-07-31");
  assert.equal(prevDay("2026-01-01"), "2025-12-31");
  assert.equal(prevDay("2028-03-01"), "2028-02-29"); // leap year
  assert.equal(prevDay("2027-03-01"), "2027-02-28");
});

test("prevDay survives the DST boundary", () => {
  /* the noon-UTC anchor exists precisely so this can't shift a day */
  assert.equal(prevDay("2026-03-08"), "2026-03-07");
  assert.equal(prevDay("2026-11-01"), "2026-10-31");
});

test("hashStr is stable and unsigned — both phones must agree", () => {
  assert.equal(hashStr("tangle:2026-08-06"), hashStr("tangle:2026-08-06"));
  assert.notEqual(hashStr("tangle:2026-08-06"), hashStr("tangle:2026-08-07"));
  assert.ok(hashStr("anything") >= 0);
  assert.ok(Number.isInteger(hashStr("anything")));
});

const rows = (...days) =>
  days.flatMap(([day, slots]) => slots.map((slot) => ({ day, slot })));

test("ritualMap groups by day and slot", () => {
  const m = ritualMap(rows(["2026-08-05", ["A", "B"]]));
  assert.equal(m["2026-08-05"].A.slot, "A");
  assert.equal(m["2026-08-05"].B.slot, "B");
});

test("streak counts only nights where both sealed", () => {
  const r = rows(
    ["2026-08-04", ["A", "B"]],
    ["2026-08-05", ["A", "B"]],
    ["2026-08-06", ["A", "B"]],
  );
  assert.equal(ritualStreak(r, "2026-08-06"), 3);
});

test("a half-finished tonight does not break the streak", () => {
  /* only one of you has sealed today — yesterday's streak must still stand,
     otherwise the number flickers down every evening until you both post */
  const r = rows(
    ["2026-08-04", ["A", "B"]],
    ["2026-08-05", ["A", "B"]],
    ["2026-08-06", ["A"]],
  );
  assert.equal(ritualStreak(r, "2026-08-06"), 2);
});

test("a missed night ends the streak", () => {
  const r = rows(["2026-08-01", ["A", "B"]], ["2026-08-06", ["A", "B"]]);
  assert.equal(ritualStreak(r, "2026-08-06"), 1);
});

test("no history is a streak of zero", () => {
  assert.equal(ritualStreak([], "2026-08-06"), 0);
});

test("newer rev wins", () => {
  const cur = { rev: 5, updatedAt: "2026-08-06T10:00:00Z" };
  assert.equal(
    shouldApplyRemote(cur, { rev: 6, updatedAt: "2026-08-06T09:00:00Z" }),
    true,
  );
});

test("older rev loses even with a newer clock", () => {
  /* a device with a fast clock must not be able to resurrect stale state */
  const cur = { rev: 5, updatedAt: "2026-08-06T10:00:00Z" };
  assert.equal(
    shouldApplyRemote(cur, { rev: 4, updatedAt: "2026-08-06T23:59:00Z" }),
    false,
  );
});

test("equal rev falls back to the timestamp", () => {
  const cur = { rev: 5, updatedAt: "2026-08-06T10:00:00Z" };
  assert.equal(
    shouldApplyRemote(cur, { rev: 5, updatedAt: "2026-08-06T10:00:01Z" }),
    true,
  );
  assert.equal(
    shouldApplyRemote(cur, { rev: 5, updatedAt: "2026-08-06T09:59:59Z" }),
    false,
  );
});

test("a missing incoming doc is never applied", () => {
  assert.equal(shouldApplyRemote({ rev: 1, updatedAt: "x" }, null), false);
});

test("inklings alternates who answers", () => {
  assert.equal(inkSubjectFor(0, "A"), "A");
  assert.equal(inkSubjectFor(1, "A"), "B");
  assert.equal(inkSubjectFor(2, "A"), "A");
  assert.equal(inkSubjectFor(1, "B"), "A");
});

test("current card skips resolved ones and reports completion", () => {
  const judged = [{ match: true }, { match: false }, null, null, null];
  assert.equal(
    inkCurrentIdx([0, 1, 2, 3, 4], (i) => judged[i]),
    2,
  );
  assert.equal(
    inkCurrentIdx([0, 1], (i) => [{ match: true }, { match: false }][i]),
    -1,
  );
});

test("a card that is answered but unjudged is still the current one", () => {
  /* match null means both sealed, nobody has said yes/no yet */
  const rowsIn = [{ truth: "x", guess: "y", match: null }];
  assert.equal(
    inkCurrentIdx([0], (i) => rowsIn[i]),
    0,
  );
});

test("sealing round-trips emoji and accents", () => {
  for (const s of ["tiny candles", "café ☕", "🎂 her birthday", "ñandú"]) {
    assert.equal(inkUnseal(inkSeal(s)), s);
  }
});

test("unsealing garbage returns it rather than throwing", () => {
  assert.equal(inkUnseal("not base64 !!"), "not base64 !!");
});

test("prompts substitute both names, every occurrence", () => {
  assert.equal(
    renderInkPrompt("What would @S order? Would @P know?", "Ana", "Leo"),
    "What would Ana order? Would Leo know?",
  );
  assert.equal(
    renderInkPrompt("@S and @S again", "Jo", "Sam"),
    "Jo and Jo again",
  );
});

test("prompts degrade gracefully when a name is missing", () => {
  assert.equal(renderInkPrompt("@S is here", null, null), "they is here");
  assert.equal(renderInkPrompt(undefined, "A", "B"), "");
});

test("tangle serves the daily puzzle when it's unseen", () => {
  assert.deepEqual(pickTanglePuzzle(7, 10, {}), { id: 7, playedIds: [] });
});

test("tangle walks past solved and played puzzles", () => {
  /* the bug this guards: "next puzzle" re-serving the same daily with a
     fresh shuffle, which read as a shuffle button */
  const r = pickTanglePuzzle(7, 10, { solvedIds: [7, 8], playedIds: [9] });
  assert.equal(r.id, 0);
});

test("tangle never re-serves the puzzle on screen", () => {
  const r = pickTanglePuzzle(7, 10, {
    solvedIds: [],
    playedIds: [],
    currentId: 7,
  });
  assert.equal(r.id, 8);
});

test("tangle recycles once the whole book is seen, without a repeat", () => {
  const all = [...Array(10).keys()];
  const r = pickTanglePuzzle(7, 10, { solvedIds: all, currentId: 3 });
  assert.equal(r.id, 4);
  assert.deepEqual(r.playedIds, []); // fresh cycle
});

test("duet walks past used words and wraps", () => {
  const words = ["apple", "berry", "cider", "dates"];
  assert.equal(pickUnusedWord(words, new Set(["cider"]), null, 2), "dates");
  assert.equal(pickUnusedWord(words, new Set(["dates"]), null, 3), "apple");
});

test("duet never re-serves the word on the board, even exhausted", () => {
  const words = ["apple", "berry"];
  const used = new Set(words);
  assert.equal(pickUnusedWord(words, used, "apple", 0), "berry");
});

test("attune picks are distinct and avoid used spectrums", () => {
  const seq = [0.0, 0.0, 0.5, 0.5, 0.99, 0.99, 0.2, 0.4, 0.6, 0.8, 0.1, 0.3];
  let k = 0;
  const rng = () => seq[k++ % seq.length];
  const { picks, used } = pickAttuneSpectrums(10, [0, 1, 2], 3, rng);
  assert.equal(new Set(picks).size, 3);
  assert.ok(picks.every((i) => ![0, 1, 2].includes(i)));
  assert.ok(picks.every((i) => used.includes(i)));
});

test("attune resets the cycle when too few spectrums remain", () => {
  /* only 2 unseen of 5 but a session needs 3 — the pool must recycle */
  let k = 0;
  const seq = [0.1, 0.5, 0.9, 0.3, 0.7];
  const { picks } = pickAttuneSpectrums(
    5,
    [0, 1, 2],
    3,
    () => seq[k++ % seq.length],
  );
  assert.equal(new Set(picks).size, 3);
});

test("inklings deals unseen cards while any remain", () => {
  assert.deepEqual(inkDealPool(6, [0, 1, 2], [], 3), [3, 4, 5]);
});

test("inklings recycles a dry deck but never tonight's cards", () => {
  /* the bug this guards: "deal 5 more" near deck exhaustion re-dealing a
     card answered earlier the same evening */
  const pool = inkDealPool(6, [0, 1, 2, 3, 4], [3, 4], 3);
  assert.deepEqual(pool, [0, 1, 2, 5]);
});

test("duet streak grows only across consecutive days", () => {
  assert.equal(duetStreakAfterWin(4, "2026-08-11", "2026-08-12"), 5);
  /* a skipped day starts over at 1 — a streak should mean what it says */
  assert.equal(duetStreakAfterWin(4, "2026-08-09", "2026-08-12"), 1);
});

test("a streak from before tracking existed is grandfathered", () => {
  /* live rooms have real streaks but no lastWinDay on record — zeroing
     them on upgrade would be cruel */
  assert.equal(duetStreakAfterWin(12, null, "2026-08-12"), 13);
  assert.equal(duetStreakAfterWin(12, undefined, "2026-08-12"), 13);
});

test("possessive reads grammatically with and without a name", () => {
  assert.equal(
    renderInkPrompt("What's on @S's wallpaper?", "Ana", "Leo"),
    "What's on Ana's wallpaper?",
  );
  /* the bug this guards: "they's phone wallpaper" */
  assert.equal(
    renderInkPrompt("What's on @S's wallpaper?", null, null),
    "What's on their wallpaper?",
  );
});

/* ---------------- decks ---------------- */

const mkContent = () => {
  const live = {
    tangle: [{ groups: [] }],
    inklings: ["What's @S's usual?"],
    spectrums: [["Hot", "Cold"]],
    fourLeads: ["What four things?"],
  };
  const pristine = {
    tangle: [...live.tangle],
    inklings: [...live.inklings],
    spectrums: [...live.spectrums],
    fourLeads: [...live.fourLeads],
  };
  return { live, pristine };
};

test("applyDeckContent replaces in place and keeps array identity", () => {
  const { live, pristine } = mkContent();
  const tangleRef = live.tangle;
  const custom = applyDeckContent(live, pristine, {
    inklings: ["Would @S do it?", "Could @S resist?"],
  });
  assert.equal(live.tangle, tangleRef); // same object, games keep their alias
  assert.equal(live.inklings.length, 2);
  assert.deepEqual(custom, {
    tangle: false,
    inklings: true,
    spectrums: false,
    fourLeads: false,
  });
});

test("applyDeckContent with null restores pristine content", () => {
  const { live, pristine } = mkContent();
  applyDeckContent(live, pristine, {
    spectrums: [["A", "B"]],
    fourLeads: ["x?"],
  });
  applyDeckContent(live, pristine, null);
  assert.deepEqual(live.spectrums, pristine.spectrums);
  assert.deepEqual(live.fourLeads, pristine.fourLeads);
});

test("applyDeckContent ignores empty or non-array keys", () => {
  const { live, pristine } = mkContent();
  const custom = applyDeckContent(live, pristine, {
    tangle: [],
    inklings: "nope",
  });
  assert.equal(custom.tangle, false);
  assert.equal(custom.inklings, false);
  assert.deepEqual(live.inklings, pristine.inklings);
});

test("validateDeck accepts a partial deck and rejects junk", () => {
  assert.equal(validateDeck({ inklings: ["What's @S's usual?"] }).length, 0);
  assert.ok(validateDeck(null).length);
  assert.ok(validateDeck({}).length); // replaces nothing
  assert.ok(validateDeck({ inklings: ["no placeholder"] }).length);
  assert.ok(validateDeck({ spectrums: [["only left"]] }).length);
});

test("validateDeck enforces tangle shape and 16 unique words", () => {
  const g = (t, w) => ({ title: t, words: w });
  const ok = {
    tangle: [
      {
        groups: [
          g("A", ["ONE", "TWO", "THREE", "FOUR"]),
          g("B", ["FIVE", "SIX", "SEVEN", "EIGHT"]),
          g("C", ["NINE", "TEN", "ELEVEN", "TWELVE"]),
          g("D", ["THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN"]),
        ],
      },
    ],
  };
  assert.equal(validateDeck(ok).length, 0);
  const dupes = JSON.parse(JSON.stringify(ok));
  dupes.tangle[0].groups[3].words[3] = "one"; // case-insensitive collision
  assert.ok(validateDeck(dupes).length);
  const short = JSON.parse(JSON.stringify(ok));
  short.tangle[0].groups.pop();
  assert.ok(validateDeck(short).length);
});

/* ---------------- share cards ---------------- */

import { duetShareCard, tangleShareCard } from "./lib.js";

test("duetShareCard renders spoiler-free grid with couple framing", () => {
  const card = duetShareCard(
    [
      ["x", "y", "x", "x", "g"],
      ["g", "g", "g", "g", "g"],
    ],
    12,
    "https://example.test/",
  );
  assert.ok(card.includes("in 2, together"));
  assert.ok(card.includes("streak 12"));
  assert.ok(card.includes("⬛🟨⬛⬛🟩\n🟩🟩🟩🟩🟩"));
  assert.ok(card.includes("https://example.test/"));
  assert.ok(!card.match(/[A-Z]{5}/)); // never leaks the answer
});

test("duetShareCard omits streak when there is none to brag about", () => {
  assert.ok(!duetShareCard([[..."ggggg"]], 1, "u").includes("streak"));
});

test("tangleShareCard renders solve order in the connections palette", () => {
  const card = tangleShareCard([3, 0, 1, 2], 0, 85, "u");
  assert.ok(card.startsWith("Couplet Tangle #85"));
  assert.ok(card.includes("not a single miss"));
  assert.ok(card.includes("🟪🟪🟪🟪\n🟨🟨🟨🟨\n🟩🟩🟩🟩\n🟦🟦🟦🟦"));
  assert.ok(tangleShareCard([0], 1, 1, "u").includes("1 miss ♥"));
  assert.ok(tangleShareCard([0], 2, 1, "u").includes("2 misses"));
});
