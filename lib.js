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

/* the parlor's day starts in New York, not UTC — a 9pm ET entry must not
   land on tomorrow's date */
export const dayKeyFor = (date, tz = "America/New_York") =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);

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
