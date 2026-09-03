/* Couplet — © 2026 lymnal. PolyForm Noncommercial 1.0.0 (see /LICENSE).
   Not licensed as AI/ML training, fine-tuning, evaluation, or retrieval data;
   text-and-data-mining rights reserved (/.well-known/tdmrep.json). */
/* Pure logic, lifted out of app.js so it can be tested without a browser.
 * Nothing in here touches the DOM, the network, or module state — if a
 * function needs `state` or `me`, it takes them as arguments.
 *
 * These are the parts that are easy to get quietly wrong: date maths across
 * month boundaries and DST, streak counting, the last-write-wins comparison
 * that decides whose change survives, and whose turn it is in Inklings.
 */

export const otherSlot = (s) => (s === "A" ? "B" : "A");
export const slotClass = (s) => (s === "A" ? "p-a" : "p-b");

/* The parlor's day starts in the parlor's own timezone, never UTC — a 9pm
   entry must not land on tomorrow's date. The zone is recorded on the room
   when it's made (see parlorTz in app.js); the default here is the zone the
   app was born in, which parlors older than that field still use. */
export const LEGACY_TZ = "America/New_York";
export const dayKeyFor = (date, tz = LEGACY_TZ) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);

/* a zone string is only trusted if Intl can actually use it */
export function validTz(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/* noon UTC dodges every DST edge: shifting a date by ±12h can't change the
   calendar day */
export function prevDay(d) {
  const t = new Date(d + "T12:00:00Z");
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

/* FNV-1a — small, fast, and stable across devices, which matters because
   both phones must derive the SAME daily puzzle from the same date string */
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* rows -> { 'YYYY-MM-DD': { A: row, B: row } } */
export function ritualMap(rows) {
  const m = {};
  for (const r of rows ?? []) (m[r.day] ??= {})[r.slot] = r;
  return m;
}

/* consecutive nights where BOTH sealed. Today not being done yet must not
   break the streak — you haven't lost it until yesterday is also missing. */
export function ritualStreak(rows, today) {
  const m = ritualMap(rows);
  const complete = (d) => !!(m[d]?.A && m[d]?.B);
  let d = today;
  if (!complete(d)) d = prevDay(d);
  let n = 0;
  while (complete(d)) {
    n++;
    d = prevDay(d);
  }
  return n;
}

/* Which incoming doc wins. rev first, then timestamp as the tiebreak — this
   is the rule that decides whose edit survives when both phones write. */
export function shouldApplyRemote(current, incoming) {
  if (!incoming) return false;
  if (incoming.rev > current.rev) return true;
  return incoming.rev === current.rev && incoming.updatedAt > current.updatedAt;
}

/* Inklings alternates who answers, starting from whoever the session picked */
export const inkSubjectFor = (idx, startSubject) =>
  idx % 2 === 0 ? startSubject : otherSlot(startSubject);

/* first unresolved card, or -1 when the session is done */
export function inkCurrentIdx(cards, rowFor) {
  for (let i = 0; i < (cards?.length ?? 0); i++) {
    const r = rowFor(i);
    if (!r || r.match === null || r.match === undefined) return i;
  }
  return -1;
}

/* unicode-safe base64 — plain btoa throws on the emoji people actually type */
export const inkSeal = (s) => btoa(unescape(encodeURIComponent(s)));
export const inkUnseal = (s) => {
  try {
    return decodeURIComponent(escape(atob(s)));
  } catch {
    return s;
  }
};

/* ---- game pickers: the "don't repeat what we've played" rules ----
   These all share a failure mode — a pick that quietly re-serves something
   already seen — which is why they live here, under test, instead of in
   app.js against globals. */

/* Tangle: walk forward from the daily anchor to the first puzzle neither
   solved nor played, never re-serving the one on screen. When the whole
   book has been seen, the played cycle resets and play continues in order. */
export function pickTanglePuzzle(
  daily,
  count,
  { solvedIds = [], playedIds = [], currentId = null } = {},
) {
  const played = [...playedIds];
  const seen = new Set([...solvedIds, ...played]);
  for (let step = 0; step < count; step++) {
    const cand = (daily + step) % count;
    if (!seen.has(cand) && cand !== currentId)
      return { id: cand, playedIds: played };
  }
  return {
    id: currentId != null ? (currentId + 1) % count : daily,
    playedIds: [],
  };
}

/* Duet: a bare hash pick repeats a word within ~2 months (birthday problem
   over 2,314 answers) — walk forward past every answer already played.
   Once all are played repeats are earned, but never the word on the board. */
export function pickUnusedWord(words, used, currentWord, start) {
  for (let step = 0; step < words.length; step++) {
    const w = words[(start + step) % words.length];
    if (!used.has(w) && w !== currentWord) return w;
  }
  for (let step = 0; step < words.length; step++) {
    const w = words[(start + step) % words.length];
    if (w !== currentWord) return w;
  }
  return words[start];
}

/* Attune: a session of distinct spectrums avoiding every used one; when too
   few remain for a full session, the used cycle resets */
export function pickAttuneSpectrums(total, usedList, len, rng = Math.random) {
  let used = new Set(usedList ?? []);
  let avail = [...Array(total).keys()].filter((i) => !used.has(i));
  if (avail.length < len) {
    used = new Set();
    avail = [...Array(total).keys()];
  }
  const picks = [];
  while (picks.length < len) {
    const i = avail[Math.floor(rng() * avail.length)];
    if (!picks.includes(i)) picks.push(i);
  }
  picks.forEach((i) => used.add(i));
  return { picks, used: [...used] };
}

/* Inklings: unseen cards first; when the deck runs dry, recycle it — but
   never re-deal a card from tonight's session */
export function inkDealPool(deckSize, usedList, tonightList, perSession) {
  const used = new Set(usedList);
  const pool = [...Array(deckSize).keys()].filter((i) => !used.has(i));
  if (pool.length >= perSession) return pool;
  const tonight = new Set(tonightList);
  return [...Array(deckSize).keys()].filter((i) => !tonight.has(i));
}

/* Duet streak: a missed day breaks the chain. A streak from before this was
   tracked (no lastWinDay on record) is grandfathered, not zeroed. */
export const duetStreakAfterWin = (streak, lastWinDay, day) =>
  lastWinDay == null || lastWinDay === prevDay(day) ? streak + 1 : 1;

/* @S = the person answering, @P = the person guessing.
   "@S's" is handled first so an unnamed player reads "their phone wallpaper"
   rather than the ungrammatical "they's phone wallpaper". */
export const renderInkPrompt = (template, subjectName, partnerName) =>
  (template ?? "")
    .replaceAll("@S's", subjectName ? `${subjectName}'s` : "their")
    .replaceAll("@S", subjectName ?? "they")
    .replaceAll("@P", partnerName ?? "your partner");

/* ---------------- decks ----------------
 * A parlor can carry a custom deck: full replacement lists for any of the
 * four content sets. `live` holds the arrays the games actually read (the
 * window globals, aliased at load) — so replacement must mutate IN PLACE,
 * never reassign. Absent or invalid keys fall back to the pristine
 * built-ins, so a partial deck (say, only inklings) is a valid deck. */
export const DECK_KEYS = [
  "tangle",
  "inklings",
  "spectrums",
  "fourLeads",
  "duetAnswers",
];

export function applyDeckContent(live, pristine, deck) {
  const custom = {};
  for (const key of DECK_KEYS) {
    const has = !!deck && Array.isArray(deck[key]) && deck[key].length > 0;
    const src = has ? deck[key] : pristine[key];
    live[key].length = 0;
    live[key].push(...src);
    custom[key] = has;
  }
  return custom;
}

/* Shape checks shared by the app (defensive) and the deck-authoring tools.
 * Returns a list of human-readable problems; empty list = valid. */
export function validateDeck(deck) {
  const problems = [];
  if (!deck || typeof deck !== "object") return ["deck is not an object"];
  if (!DECK_KEYS.some((k) => Array.isArray(deck[k]) && deck[k].length))
    problems.push("deck replaces nothing: include at least one of " + DECK_KEYS.join(", "));
  for (const [i, p] of (deck.tangle ?? []).entries()) {
    const where = `tangle[${i}]`;
    if (!Array.isArray(p?.groups) || p.groups.length !== 4) {
      problems.push(`${where}: needs exactly 4 groups`);
      continue;
    }
    const words = [];
    for (const [j, g] of p.groups.entries()) {
      if (typeof g?.title !== "string" || !g.title.trim())
        problems.push(`${where}.groups[${j}]: missing title`);
      if (!Array.isArray(g?.words) || g.words.length !== 4)
        problems.push(`${where}.groups[${j}] ("${g?.title}"): needs exactly 4 words`);
      else words.push(...g.words.map((w) => String(w).trim().toUpperCase()));
    }
    if (words.length === 16 && new Set(words).size !== 16)
      problems.push(`${where}: the 16 words must be unique`);
  }
  for (const [i, card] of (deck.inklings ?? []).entries())
    if (typeof card !== "string" || !card.includes("@S"))
      problems.push(`inklings[${i}]: must be a string mentioning @S`);
  for (const [i, s] of (deck.spectrums ?? []).entries())
    if (!Array.isArray(s) || s.length !== 2 || s.some((e) => typeof e !== "string" || !e.trim()))
      problems.push(`spectrums[${i}]: must be [left, right] labels`);
  for (const [i, lead] of (deck.fourLeads ?? []).entries())
    if (typeof lead !== "string" || !lead.trim())
      problems.push(`fourLeads[${i}]: must be a non-empty string`);
  /* Duet answers: five letters a–z, no repeats. The shared guess dictionary
     still applies, plus these — so a deck word outside it is still guessable. */
  const seen = new Set();
  for (const [i, w] of (deck.duetAnswers ?? []).entries()) {
    const word = typeof w === "string" ? w.trim().toLowerCase() : "";
    if (!/^[a-z]{5}$/.test(word))
      problems.push(`duetAnswers[${i}]: must be five letters a–z`);
    else if (seen.has(word)) problems.push(`duetAnswers[${i}]: "${word}" repeats`);
    seen.add(word);
  }
  return problems;
}

/* ---------------- share cards ----------------
 * Spoiler-free result grids in the emoji language group chats already read
 * fluently — recognition does the explaining, the grid poses the riddle
 * without spoiling it, and "together" is the one brag a solo puzzle can't
 * make. The URL rides along so the brag carries its own door in. */
/* Hearts, not squares. The square grids belong to other people's games,
   and this is the one for two — the shape should say so at a glance. */
const DUET_EMOJI = { g: "💚", y: "💛", x: "🖤" };

export function duetShareCard(scores, streak, url) {
  const grid = scores
    .map((row) => row.map((v) => DUET_EMOJI[v] ?? "🖤").join(""))
    .join("\n");
  const streakBit = streak > 1 ? ` · streak ${streak}` : "";
  return `Couplet Duet — got it in ${scores.length}, together${streakBit} ♥\n${grid}\n${url}`;
}

const TANGLE_EMOJI = ["💛", "💚", "💙", "💜"];

export function tangleShareCard(foundGroups, mistakes, puzzleNo, url) {
  const rows = foundGroups.map((g) => (TANGLE_EMOJI[g] ?? "💜").repeat(4)).join("\n");
  const miss =
    mistakes === 0 ? "not a single miss" : `${mistakes} miss${mistakes > 1 ? "es" : ""}`;
  return `Couplet Tangle #${puzzleNo} — untangled together, ${miss} ♥\n${rows}\n${url}`;
}
