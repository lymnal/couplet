/* pure logic lives in lib.js so it can be covered by `node --test` — see
   lib.test.js. Importing it here is what makes those tests meaningful. */
import {
  applyDeckContent,
  validateDeck,
  duetShareCard,
  tangleShareCard,
  otherSlot,
  slotClass,
  hashStr,
  prevDay,
  dayKeyFor,
  shouldApplyRemote,
  renderInkPrompt,
  ritualMap as libRitualMap,
  ritualStreak as libRitualStreak,
  inkSubjectFor as libInkSubjectFor,
  inkCurrentIdx as libInkCurrentIdx,
  inkSeal as inkB64,
  inkUnseal as inkPlain,
  pickTanglePuzzle,
  pickUnusedWord,
  pickAttuneSpectrums,
  inkDealPool,
  duetStreakAfterWin,
} from "./lib.js?v=5";

const CFG = window.COUPLET_CONFIG;
/* vendored UMD build (vendor/supabase.js, pinned 2.112.4) — a CDN module
   import can't be cached by the service worker across origins, which made
   "works offline" depend on browser-cache luck */
const { createClient } = window.supabase;
const PUZZLES = window.TANGLE_PUZZLES;
/* asset version — ./bump.sh keeps this in step with index.html and sw.js */
const ASSET_VERSION = "5";
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ---------------- identity & room ---------------- */
const store = {
  get slot() {
    return localStorage.getItem("couplet_slot");
  },
  set slot(v) {
    localStorage.setItem("couplet_slot", v);
  },
  get room() {
    return localStorage.getItem("couplet_room");
  },
  set room(v) {
    localStorage.setItem("couplet_room", v);
  },
  get name() {
    return localStorage.getItem("couplet_name");
  },
  set name(v) {
    localStorage.setItem("couplet_name", v);
  },
};

let me = { slot: null, name: null };
let room = null;
let channel = null;
let supa = null;
let partnerHere = false;
let slotDoubled = false;
let saveTimer = null;
let allowedWords = null;
let answerWords = null;
let ritualData = [];
let ritualEditing = false;
let photoData = null;
let photoFetched = false;
let suggestion = null;
let suggestTyped = "";

const slotName = (s) =>
  s === me.slot
    ? me.name
    : (state.players?.[s] ?? (s === "A" ? "Emerald" : "Mint"));
const partnerName = () => state.players?.[otherSlot(me.slot)] ?? "your partner";

/* ---------------- shared state ---------------- */
const todayKey = () => dayKeyFor(new Date());

function freshState() {
  return {
    rev: 0,
    updatedAt: new Date().toISOString(),
    by: null,
    players: {},
    duet: null,
    tangle: null,
    stats: {
      duetWins: 0,
      duetPlayed: 0,
      streak: 0,
      tangleWins: 0,
      tanglePerfect: 0,
    },
  };
}
let state = freshState();

/* deterministic PRNG so both phones derive identical games */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seededPick = (arr, seed) =>
  arr[Math.floor(mulberry32(seed)() * arr.length)];
function seededShuffle(n, seed) {
  const rng = mulberry32(seed);
  const idx = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

/* ---------------- game builders ---------------- */
function pickDuetAnswer(seed) {
  const used = new Set((state.duetUsed ?? []).map((b) => atob(b)));
  const current = state.duet ? atob(state.duet.answer) : null;
  const start = Math.floor(mulberry32(seed)() * answerWords.length);
  return pickUnusedWord(answerWords, used, current, start);
}
function newDuetGame(mode, round = 1) {
  const dateKey = todayKey();
  const seed =
    mode === "daily"
      ? hashStr("duet:" + dateKey)
      : hashStr(`duet:${dateKey}:free:${round}:${state.rev}`);
  const answer = pickDuetAnswer(seed);
  return {
    mode,
    dateKey,
    round,
    answer: btoa(answer),
    guesses: [],
    turn: seededPick(["A", "B"], seed + 7),
    status: "playing",
  };
}
function newTangleGame(puzzleId) {
  const solved = state.tangle?.solvedIds ?? [];
  let played = [...(state.tangle?.playedIds ?? [])];
  let id = puzzleId;
  if (id == null) {
    ({ id, playedIds: played } = pickTanglePuzzle(
      hashStr("tangle:" + todayKey()) % PUZZLES.length,
      PUZZLES.length,
      {
        solvedIds: solved,
        playedIds: played,
        currentId: state.tangle?.puzzleId ?? null,
      },
    ));
  }
  return {
    puzzleId: id,
    order: seededShuffle(
      16,
      hashStr(`tangle:${id}:${state.rev}:${todayKey()}`),
    ),
    found: [],
    mistakes: 0,
    status: "playing",
    tried: [],
    solvedIds: solved,
    playedIds: played,
  };
}

/* ---------------- sync ---------------- */
function mutate(fn) {
  fn(state);
  state.rev += 1;
  state.updatedAt = new Date().toISOString();
  state.by = me.slot;
  broadcast("state", { state });
  scheduleSave();
  renderAll();
}
function applyRemote(incoming) {
  if (!incoming) return;
  if (shouldApplyRemote(state, incoming)) {
    const prev = state;
    state = incoming;
    reactToRemote(prev, incoming);
    renderAll();
    ensureMyName();
  }
}
/* Publish my name into shared state so my partner sees it. Two guards keep
   this from becoming the write-war that strobed the orbs: never push while
   another device is signed in on my slot (it would push back forever), and
   never more than once per few seconds. Retrying otherwise is deliberate —
   a rename that silently fails to propagate leaves me seeing my new name
   while my partner still sees the old one. */
let lastNameWrite = 0;
function ensureMyName() {
  if (!me.name || !me.slot) return;
  if (state.players?.[me.slot] === me.name) return;
  if (slotDoubled) return;
  if (performance.now() - lastNameWrite < 3000) return;
  lastNameWrite = performance.now();
  mutate((st) => {
    st.players = { ...(st.players ?? {}), [me.slot]: me.name };
  });
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    /* not queued: the room doc is last-write-wins, so replaying a stale
       snapshot later would undo newer play. Broadcast + next save covers it. */
    rpc("set_room", { p_code: room, p_state: state }, { queue: false });
  }, 700);
}
function broadcast(event, payload) {
  channel?.send({
    type: "broadcast",
    event,
    payload: { ...payload, from: me.slot },
  });
}

function reactToRemote(prev, next) {
  flareOrb(next.by);
  if (
    screenNow === "duet" &&
    next.duet &&
    prev.duet &&
    next.duet.guesses.length > prev.duet.guesses.length
  ) {
    ghostLetters = "";
    suggestion = null;
    suggestTyped = "";
    pendingFlipRow = next.duet.guesses.length - 1;
  }
}

/* ---------------- supabase wiring ---------------- */
async function connect() {
  supa = createClient(CFG.supabaseUrl, CFG.supabaseKey);

  /* A throw here used to skip everything below it — including joinChannel —
     so one failed call at startup left the app a dead shell with no realtime
     until someone reloaded. Opening the app underground did exactly that. */
  try {
    const { data, error } = await supa.rpc("get_room", { p_code: room });
    if (error) throw error;
    if (data) applyRemote(data);
    else await supa.rpc("set_room", { p_code: room, p_state: state });
    reportOk();
  } catch (e) {
    reportError("connect", e);
  }

  ensureMyName();
  Promise.all([
    fetchRitual(),
    fetchPhoto(),
    fetchInklings(),
    fetchNotes(),
  ]).then(renderAll);

  joinChannel();
}

/* Phones suspend the page (screen lock, app switch) and the realtime socket
   dies silently — sync would stop until a manual reload. Rejoin the channel
   and re-pull state whenever we come back. */
let channelUp = false;
let rejoinTimer = null;
let lastHiReply = 0;

function joinChannel() {
  if (channel) supa.removeChannel(channel);
  channelUp = false;

  const ch = (channel = supa.channel("room:" + room, {
    config: {
      broadcast: { self: false },
      presence: { key: me.slot + ":" + Math.random().toString(36).slice(2, 7) },
    },
  }));

  channel
    .on("broadcast", { event: "state" }, ({ payload }) =>
      applyRemote(payload.state),
    )
    /* answering every "hi" would amplify a peer stuck reconnecting */
    .on("broadcast", { event: "hi" }, () => {
      const now = performance.now();
      if (now - lastHiReply < 1200) return;
      lastHiReply = now;
      broadcast("state", { state });
    })
    /* the other phone erased the parlor — don't sit on a screen full of
       things that no longer exist, and don't let connect() helpfully
       re-create the room from this device's stale copy */
    .on("broadcast", { event: "gone" }, () => {
      forgetParlorLocally();
      location.href = location.pathname;
    })
    .on("broadcast", { event: "typing" }, ({ payload }) => {
      if (payload.from !== me.slot) {
        ghostLetters = payload.letters;
        ghostBy = payload.from;
        renderDuet();
        flareOrb(payload.from);
      }
    })
    .on("broadcast", { event: "sel" }, ({ payload }) => {
      if (payload.from !== me.slot) {
        tangleSel = new Set(payload.sel);
        tangleSelBy = payload.from;
        renderTangle();
        flareOrb(payload.from);
      }
    })
    .on("broadcast", { event: "dial" }, ({ payload }) => {
      if (
        payload.from !== me.slot &&
        screenNow === "attune" &&
        payload.idx === state.attune?.idx &&
        !dialDragging
      ) {
        dialPos = payload.pos;
        setNeedle(payload.pos);
      }
    })
    .on("broadcast", { event: "feedback" }, ({ payload }) => {
      if (payload.from !== me.slot) toast(payload.msg, payload.ms ?? 3200);
    })
    .on("broadcast", { event: "suggest" }, ({ payload }) => {
      if (payload.from !== me.slot) {
        suggestion = { w: payload.w, by: payload.from };
        flareOrb(payload.from);
        toast(`💡 ${slotName(payload.from)} whispered a word`);
        if (screenNow === "duet") renderDuet();
      }
    })
    .on("broadcast", { event: "photo" }, ({ payload }) => {
      if (payload.from !== me.slot)
        fetchPhoto().then(() => {
          renderAll();
          flareOrb(payload.from);
          toast(
            photoData
              ? `📷 ${partnerName()} updated your photo`
              : `${partnerName()} took the photo down`,
          );
        });
    })
    .on("broadcast", { event: "note" }, ({ payload }) => {
      if (payload.from !== me.slot)
        fetchNotes().then(() => {
          renderAll();
          flareOrb(payload.from);
          toast(`💌 a note from ${slotName(payload.from)}`);
        });
    })
    .on("broadcast", { event: "ritual" }, ({ payload }) => {
      if (payload.from !== me.slot)
        fetchRitual().then(() => {
          renderAll();
          flareOrb(payload.from);
          const t = ritualMap()[todayKey()] ?? {};
          if (t.A && t.B) {
            if (screenNow !== "ritual")
              toast("💛 tonight's four things are revealed — go look");
          } else {
            toast(`✨ ${partnerName()} sealed their four things`);
          }
        });
    })
    .on("broadcast", { event: "ink" }, ({ payload }) => {
      if (payload.from !== me.slot)
        fetchInklings().then(() => {
          renderAll();
          flareOrb(payload.from);
        });
    })
    .on("broadcast", { event: "emote" }, ({ payload }) => {
      if (payload.from !== me.slot) {
        spawnFloaters(payload.e, payload.from);
        flareOrb(payload.from);
      }
    })
    .on("presence", { event: "sync" }, () => {
      const entries = Object.values(channel.presenceState()).flat();
      const slots = new Set(entries.map((p) => p.slot));
      partnerHere = slots.has(otherSlot(me.slot));
      /* two devices on the same side is the usual cause of confusion */
      const wasDoubled = slotDoubled;
      slotDoubled = entries.filter((p) => p.slot === me.slot).length > 1;
      if (slotDoubled && !wasDoubled)
        toast("two devices are on your side — switch one to the other glow");
      renderPresence();
    })
    .subscribe(async (status) => {
      /* our own teardown fires CLOSED on the old channel — without this
         guard that would schedule a rejoin of the NEW channel, forever
         (the 8/4 notes/orb flicker bug) */
      if (ch !== channel) return;
      channelUp = status === "SUBSCRIBED";
      if (status === "SUBSCRIBED") {
        clearTimeout(rejoinTimer);
        await ch.track({ slot: me.slot, name: me.name });
        broadcast("hi", {});
      } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
        partnerHere = false;
        renderPresence();
        scheduleRejoin();
      }
    });
}

function scheduleRejoin(ms = 1500) {
  clearTimeout(rejoinTimer);
  rejoinTimer = setTimeout(() => {
    if (document.visibilityState === "visible") resync();
    else scheduleRejoin(ms); // wait out the background; visibilitychange also fires resync
  }, ms);
}

async function resync() {
  if (!supa || !room) return;
  try {
    const { data } = await supa.rpc("get_room", { p_code: room });
    applyRemote(data);
  } catch (e) {
    reportError("resync", e);
  }
  Promise.all([
    fetchRitual(),
    fetchPhoto(),
    fetchInklings(),
    fetchNotes(),
  ]).then(renderAll);
  const socketAlive = supa.realtime?.isConnected?.() ?? true;
  if (!channelUp || !socketAlive) joinChannel();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resync();
});
window.addEventListener("online", () => resync());

/* ---------------- screens ---------------- */
let screenNow = "join";
function show(name) {
  screenNow = name;
  ["join", "lobby", "duet", "tangle", "ritual", "attune", "inklings"].forEach(
    (s) => $("#screen-" + s).classList.toggle("hidden", s !== name),
  );
  $("#emote-fab").classList.toggle("hidden", name === "join");
  if (name === "duet") renderDuet();
  if (name === "tangle") renderTangle();
  if (name === "lobby") renderLobby();
  if (name === "ritual") renderRitual();
  if (name === "attune") renderAttune();
  if (name === "inklings") renderInklings();
}

/* ---------------- presence & orbs ---------------- */
function renderPresence() {
  if (!me.slot) return;
  $$(".orb[data-orb]").forEach((orb) => {
    const s = orb.dataset.orb;
    const lit = s === me.slot || (s === otherSlot(me.slot) && partnerHere);
    orb.classList.toggle("lit", lit);
    orb.classList.toggle("you", s === me.slot);
    const label = s === me.slot ? me.name : state.players?.[s];
    orb.textContent = label?.[0]?.toUpperCase() ?? "";
    orb.title = s === me.slot ? `${label} (you)` : (label ?? "waiting…");
  });
  const line = netDown
    ? `you're ${me.name} ✦ offline — your play is saved here ⌁`
    : partnerHere
      ? `you're ${me.name} ✦ ${partnerName()} is here with you ✨`
      : `you're ${me.name} ✦ waiting for ${partnerName()}…`;
  $$("[data-presenceline]").forEach((el) => (el.textContent = line));
  $$("[data-roomchip]").forEach((chip) => (chip.textContent = room ?? ""));
  renderDuetPill();
}
/* a peer that reconnects in a loop can fire these hundreds of times a
   second; one flare per slot per beat is all the eye can read anyway */
const flareAt = { A: 0, B: 0 };
function flareOrb(slot) {
  if (!slot) return;
  const now = performance.now();
  if (now - (flareAt[slot] ?? 0) < 700) return;
  flareAt[slot] = now;
  $$(`.orb[data-orb="${slot}"]`).forEach((o) => {
    o.classList.remove("flare");
    void o.offsetWidth;
    o.classList.add("flare");
  });
}

/* ---------------- lobby ---------------- */
function renderLobby() {
  $("#lobby-room-chip").textContent = room;
  const s = state.stats;
  $("#stats-strip").innerHTML =
    `<span><b>${s.streak}</b> streak ♥</span>` +
    `<span><b>${s.duetWins}</b> duets won</span>` +
    `<span><b>${s.tangleWins}</b> tangles solved</span>` +
    `<span><b>${ritualStreak()}</b> nights ✦</span>` +
    ((s.attuneRounds ?? 0) > 0
      ? `<span><b>${Math.round((100 * (s.attunePoints ?? 0)) / (4 * s.attuneRounds))}%</b> in tune</span>`
      : "") +
    (inkResolved().length > 0
      ? `<span><b>${Math.round((100 * inkResolved().filter((r) => r.match).length) / inkResolved().length)}%</b> known</span>`
      : "");
  const rt = ritualMap()[todayKey()] ?? {};
  $("#ritual-badge").textContent =
    rt.A && rt.B
      ? "revealed ♥"
      : rt[me.slot]
        ? "sealed — their turn"
        : rt[otherSlot(me.slot)]
          ? "✎ your turn"
          : "✎ tonight";
  $("#duet-badge").textContent =
    state.duet?.status === "playing"
      ? "in progress"
      : state.duet?.dateKey === todayKey() &&
          state.duet?.mode === "daily" &&
          state.duet?.status !== "playing"
        ? "today ✓"
        : "";
  $("#tangle-badge").textContent =
    state.tangle?.status === "playing" ? "in progress" : "";
  $("#attune-badge").textContent =
    state.attune?.status === "playing" &&
    state.attune.spectrums?.some((x) => x.clue)
      ? "in progress"
      : "";
  $("#inklings-badge").textContent =
    state.inklings?.day === todayKey()
      ? inkCurrentIdx() === -1
        ? "tonight ✓"
        : "in progress"
      : inkRows.length
        ? ""
        : "new!";
  $("#invite-btn").textContent = `Invite ${partnerName()} — send the link`;
  renderPhoto();
  renderNotes();
  renderPresence();
}

/* Notes live in their own table now. In rooms.state they were capped at 12
   (note 13 destroyed note 1) and a simultaneous write could clobber them —
   the wrong home for the most sentimental data in the app. */
let noteRows = [];
let notesOpen = false;
const NOTES_PREVIEW = 6;

async function fetchNotes() {
  try {
    const { data, error } = await supa.rpc("get_notes", { p_code: room });
    if (error) throw error;
    noteRows = Array.isArray(data) ? data : [];
    reportOk();
    await rescueLegacyNotes();
  } catch (e) {
    reportError("fetchNotes", e);
  }
}

/* a device still on an older build writes notes into the room doc — adopt
   any that never made it into the table rather than letting them vanish */
async function rescueLegacyNotes() {
  const legacy = state.notes ?? [];
  if (!legacy.length) return;
  const have = new Set(noteRows.map((r) => `${r.by}|${r.body}`));
  const orphans = legacy.filter((n) => !have.has(`${n.by}|${n.t}`));
  if (!orphans.length) return;
  for (const n of orphans) {
    await rpc("save_note", {
      p_code: room,
      p_id: `rescued-${hashStr(`${n.by}|${n.t}|${n.at}`)}`,
      p_by: n.by,
      p_name: n.name ?? null,
      p_body: n.t,
      p_at: n.at,
    });
  }
  const { data } = await supa.rpc("get_notes", { p_code: room });
  if (Array.isArray(data)) noteRows = data;
}

let notesSig = null;
function renderNotes() {
  const wall = $("#notes-wall");
  const shown = notesOpen ? noteRows : noteRows.slice(-NOTES_PREVIEW);
  /* skip untouched rebuilds — they replay the entrance animation (flicker) */
  const sig = JSON.stringify([shown.map((n) => n.id), notesOpen]);
  if (sig === notesSig) return;
  notesSig = sig;
  wall.innerHTML = "";

  if (noteRows.length > NOTES_PREVIEW) {
    const more = document.createElement("button");
    more.className = "notes-more";
    more.textContent = notesOpen
      ? "show fewer"
      : `read all ${noteRows.length} notes ↓`;
    more.addEventListener("click", () => {
      notesOpen = !notesOpen;
      renderNotes();
    });
    wall.appendChild(more);
  }

  for (const n of shown) {
    const card = document.createElement("div");
    card.className = "note-card " + (n.by === "A" ? "n-a" : "n-b");
    const body = document.createElement("span");
    body.textContent = n.body;
    const meta = document.createElement("span");
    meta.className = "note-meta";
    const when = new Date(n.at).toLocaleDateString([], {
      month: "short",
      day: "numeric",
    });
    meta.textContent = `— ${n.name ?? slotName(n.by)} · ${when}`;
    card.append(body, meta);
    wall.appendChild(card);
  }
}

/* ---------------- PHOTO ---------------- */
/* The photo is a ~400KB data URL living in Postgres, and it was re-downloaded
   on every single app open — the slowest thing in the experience on cellular.
   Check a 34-byte timestamp first and reuse the local copy when unchanged. */
const photoCacheKey = () => `tg_photo_${room}`;
function readPhotoCache() {
  try {
    return JSON.parse(localStorage.getItem(photoCacheKey()) ?? "null");
  } catch {
    return null;
  }
}
function writePhotoCache(stamp, data) {
  try {
    localStorage.setItem(photoCacheKey(), JSON.stringify({ stamp, data }));
  } catch {
    /* quota — the photo just stays a network fetch, no need to bother anyone */
  }
}

async function fetchPhoto() {
  const cached = readPhotoCache();
  try {
    const { data: stamp, error: stampErr } = await supa.rpc("keepsake_stamp", {
      p_code: room,
      p_kind: "photo",
    });
    if (stampErr) throw stampErr;
    if (!stamp) {
      /* removed upstream */
      photoData = null;
      if (cached) localStorage.removeItem(photoCacheKey());
    } else if (cached?.stamp === stamp) {
      photoData = cached.data;
    } else {
      const { data, error } = await supa.rpc("get_keepsake", {
        p_code: room,
        p_kind: "photo",
      });
      if (error) throw error;
      photoData = data || null;
      if (photoData) writePhotoCache(stamp, photoData);
    }
  } catch (e) {
    /* offline or an older backend without keepsake_stamp: fall back to the
       cached copy so the frame still fills, then to the full fetch */
    reportError("fetchPhoto", e);
    if (cached?.data) photoData = cached.data;
    else
      try {
        const { data } = await supa.rpc("get_keepsake", {
          p_code: room,
          p_kind: "photo",
        });
        photoData = data || null;
      } catch {
        /* leave whatever we had */
      }
  }
  photoFetched = true;
}
function renderPhoto() {
  const frame = $("#photo-frame");
  frame.classList.toggle("hidden", !photoData);
  if (photoData) $("#photo-img").src = photoData;
  $("#photo-add").classList.toggle("hidden", !!photoData || !photoFetched);
}
function shrinkImage(file, maxEdge, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    img.src = url;
  });
}

/* ---------------- ATTUNE ---------------- */
const SPECTRUMS = window.ATTUNE_SPECTRUMS;
const ATTUNE_LEN = 7;
let dialPos = 50;
let dialDragging = false;
let dialBroadcastAt = 0;
let attuneRenderedKey = "";

const attuneTuner = (a) =>
  a.idx % 2 === 0 ? a.startTuner : otherSlot(a.startTuner);
const attuneTarget = (sp) => Number(atob(sp.t));
const specLabel = (txt) =>
  txt.replace("@A", slotName("A")).replace("@B", slotName("B"));
function attuneScore(diff) {
  if (diff <= 5) return 4;
  if (diff <= 12) return 3;
  if (diff <= 22) return 2;
  return 0;
}
function newAttuneSession(st) {
  const { picks, used } = pickAttuneSpectrums(
    SPECTRUMS.length,
    st.attuneUsed,
    ATTUNE_LEN,
  );
  st.attuneUsed = used;
  return {
    spectrums: picks.map((i) => ({
      s: i,
      t: btoa(String(8 + Math.floor(Math.random() * 85))),
      clue: null,
      guess: null,
      pts: null,
    })),
    idx: 0,
    startTuner: Math.random() < 0.5 ? "A" : "B",
    phase: "clue",
    status: "playing",
  };
}
function ensureAttune() {
  if (!state.attune)
    mutate((st) => {
      st.attune = newAttuneSession(st);
    });
}

/* dial geometry: semicircle, pos 0 (left) → 100 (right) */
const polar = (cx, cy, r, deg) => {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy - r * Math.sin(rad)];
};
const posToDeg = (p) => 180 - p * 1.8;
function arcPath(r, p1, p2) {
  const [x1, y1] = polar(100, 100, r, posToDeg(p1));
  const [x2, y2] = polar(100, 100, r, posToDeg(p2));
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}
function buildDial(showTarget, target, interactive) {
  const R = 78;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 200 112");
  let inner = `<path class="dial-track" d="${arcPath(R, 0, 100)}"/>`;
  inner += `<g class="dial-ticks">`;
  for (let p = 0; p <= 100; p += 10) {
    const [x1, y1] = polar(100, 100, R + 15, posToDeg(p));
    const [x2, y2] = polar(100, 100, R + 19, posToDeg(p));
    inner += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }
  inner += `</g>`;
  if (showTarget && target != null) {
    const band = (w, cls) =>
      `<path class="dial-band ${cls}" stroke-width="26" d="${arcPath(
        R,
        Math.max(0, target - w),
        Math.min(100, target + w),
      )}"/>`;
    inner += band(22, "b2") + band(12, "b3") + band(5, "b4");
  }
  inner += `<line id="dial-needle" class="dial-needle" x1="100" y1="100" x2="100" y2="30"/>`;
  inner += `<circle id="dial-knob" class="dial-knob" r="7" cx="100" cy="30"/>`;
  inner += `<circle class="dial-hub" r="10" cx="100" cy="100"/>`;
  svg.innerHTML = inner;
  const wrap = $("#dial-wrap");
  wrap.innerHTML = "";
  wrap.appendChild(svg);
  setNeedle(dialPos);
  if (interactive) {
    const onPoint = (ev) => {
      const rect = svg.getBoundingClientRect();
      const x = ((ev.clientX - rect.left) / rect.width) * 200;
      const y = ((ev.clientY - rect.top) / rect.height) * 112;
      const deg = (Math.atan2(100 - y, x - 100) * 180) / Math.PI;
      setDial(Math.max(0, Math.min(100, (180 - deg) / 1.8)));
    };
    svg.addEventListener("pointerdown", (ev) => {
      dialDragging = true;
      try {
        svg.setPointerCapture(ev.pointerId);
      } catch {
        /* older browsers */
      }
      onPoint(ev);
    });
    svg.addEventListener("pointermove", (ev) => {
      if (dialDragging) onPoint(ev);
    });
    const stop = () => {
      dialDragging = false;
    };
    svg.addEventListener("pointerup", stop);
    svg.addEventListener("pointercancel", stop);
  }
}
function setNeedle(p) {
  const needle = document.getElementById("dial-needle");
  const knob = document.getElementById("dial-knob");
  if (!needle) return;
  const [x, y] = polar(100, 100, 66, posToDeg(p));
  needle.setAttribute("x2", x.toFixed(1));
  needle.setAttribute("y2", y.toFixed(1));
  knob?.setAttribute("cx", x.toFixed(1));
  knob?.setAttribute("cy", y.toFixed(1));
}
function setDial(p) {
  dialPos = p;
  setNeedle(p);
  const now = Date.now();
  if (now - dialBroadcastAt > 80) {
    dialBroadcastAt = now;
    broadcast("dial", { pos: p, idx: state.attune?.idx });
  }
}
function attuneWait(text) {
  const d = document.createElement("div");
  d.className = "attune-wait";
  d.textContent = text;
  return d;
}
function advanceAttune() {
  mutate((st) => {
    const at = st.attune;
    if (!at || at.phase !== "reveal") return;
    if (at.idx >= ATTUNE_LEN - 1) {
      at.phase = "done";
      at.status = "done";
      const total = at.spectrums.reduce((s, x) => s + (x.pts ?? 0), 0);
      st.stats.attuneRounds = (st.stats.attuneRounds ?? 0) + ATTUNE_LEN;
      st.stats.attunePoints = (st.stats.attunePoints ?? 0) + total;
    } else {
      at.idx += 1;
      at.phase = "clue";
    }
  });
}
function renderAttune() {
  if (!me.slot) return;
  ensureAttune();
  const a = state.attune;
  const sp = a.spectrums[Math.min(a.idx, ATTUNE_LEN - 1)];
  const pair = SPECTRUMS[sp.s] ?? ["?", "?"];
  const tuner = attuneTuner(a);
  const iAmTuner = tuner === me.slot;
  const total = a.spectrums.reduce((s, x) => s + (x.pts ?? 0), 0);
  const target = attuneTarget(sp);

  $("#attune-progress").textContent =
    a.phase === "done"
      ? "session complete"
      : `spectrum ${a.idx + 1} of ${ATTUNE_LEN}`;
  $("#attune-score").textContent = `${total} pts`;
  $("#spec-left").textContent = a.phase === "done" ? "" : specLabel(pair[0]);
  $("#spec-right").textContent = a.phase === "done" ? "" : specLabel(pair[1]);
  $("#attune-clue").textContent =
    a.phase !== "done" && sp.clue ? `“${sp.clue}”` : " ";

  const stage = $("#attune-stage");
  stage.innerHTML = "";

  const key = `${a.idx}:${a.phase}`;
  const freshPhase = key !== attuneRenderedKey;
  attuneRenderedKey = key;

  if (a.phase === "done") {
    buildDial(false, null, false);
    const verdict =
      total >= 24
        ? "finishing each other's sentences"
        : total >= 19
          ? "on the same wavelength"
          : total >= 13
            ? "getting warmer"
            : total >= 7
              ? "politely acquainted"
              : "beautiful strangers";
    const ptsEl = document.createElement("div");
    ptsEl.className = "attune-points";
    ptsEl.textContent = `${total} / ${ATTUNE_LEN * 4} — ${verdict}`;
    const again = document.createElement("button");
    again.className = "submit-btn";
    again.textContent = "play again";
    again.addEventListener("click", () => {
      dialPos = 50;
      mutate((st) => {
        st.attune = newAttuneSession(st);
      });
    });
    stage.append(ptsEl, again);
    if (
      total >= 19 &&
      !modalShownFor(`attune-${(state.attuneUsed ?? []).length}-${total}`)
    )
      celebrate();
    return;
  }

  if (a.phase === "clue") {
    if (iAmTuner) {
      dialPos = target;
      buildDial(true, target, false);
      stage.appendChild(
        attuneWait("only you can see the target — clue them in ✨"),
      );
      const input = document.createElement("input");
      input.className = "clue-input";
      input.maxLength = 40;
      input.placeholder = "your clue — a word or short phrase";
      const btn = document.createElement("button");
      btn.className = "submit-btn";
      btn.textContent = "send the clue";
      btn.addEventListener("click", () => {
        const v = input.value.trim();
        if (!v) return toast("give them something, love");
        mutate((st) => {
          const at = st.attune;
          if (!at || at.phase !== "clue") return;
          at.spectrums[at.idx].clue = v;
          at.phase = "guess";
        });
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") btn.click();
      });
      stage.append(input, btn);
    } else {
      if (freshPhase) dialPos = 50;
      buildDial(false, null, false);
      stage.appendChild(
        attuneWait(`${slotName(tuner)} is studying the card… ✨`),
      );
    }
  } else if (a.phase === "guess") {
    if (iAmTuner) {
      buildDial(true, target, false);
      stage.appendChild(
        attuneWait(
          `watch ${slotName(otherSlot(tuner))} think — the needle is live`,
        ),
      );
    } else {
      if (freshPhase) dialPos = 50;
      buildDial(false, null, true);
      const btn = document.createElement("button");
      btn.className = "submit-btn";
      btn.textContent = "lock it in";
      btn.addEventListener("click", () => {
        mutate((st) => {
          const at = st.attune;
          if (!at || at.phase !== "guess") return;
          const s2 = at.spectrums[at.idx];
          s2.guess = Math.round(dialPos);
          s2.pts = attuneScore(Math.abs(s2.guess - attuneTarget(s2)));
          at.phase = "reveal";
        });
      });
      stage.append(attuneWait("drag the needle, then commit"), btn);
    }
  } else if (a.phase === "reveal") {
    dialPos = sp.guess ?? 50;
    buildDial(true, target, false);
    const pts = sp.pts ?? 0;
    const line =
      pts === 4
        ? "dead center 🎯"
        : pts === 3
          ? "so close"
          : pts === 2
            ? "in the neighborhood"
            : "different wavelengths 😅";
    const ptsEl = document.createElement("div");
    ptsEl.className = "attune-points";
    ptsEl.textContent = `+${pts} · ${line}`;
    const next = document.createElement("button");
    next.className = "ghost-btn";
    next.textContent =
      a.idx >= ATTUNE_LEN - 1 ? "see the verdict" : "next spectrum";
    next.addEventListener("click", advanceAttune);
    stage.append(ptsEl, next);
    if (pts === 4 && freshPhase) celebrate();
  }
}

/* ---------------- FOUR THINGS ---------------- */
async function fetchRitual() {
  try {
    const { data, error } = await supa.rpc("get_four", { p_code: room });
    if (error) throw error;
    ritualData = Array.isArray(data) ? data : [];
    reportOk();
  } catch (e) {
    /* keep whatever we had, but say so */
    reportError("fetchRitual", e);
  }
}
const ritualMap = () => libRitualMap(ritualData);
const ritualStreak = () => libRitualStreak(ritualData, todayKey());
function fourPanel(slot, items) {
  const p = document.createElement("div");
  p.className = "four-panel " + slotClass(slot);
  const h = document.createElement("h3");
  h.textContent = slotName(slot);
  const ol = document.createElement("ol");
  for (const it of items) {
    const li = document.createElement("li");
    li.textContent = it;
    ol.appendChild(li);
  }
  p.append(h, ol);
  return p;
}
function sealedPanel(text, slot) {
  const p = document.createElement("div");
  p.className = "four-panel sealed " + slotClass(slot);
  p.textContent = text;
  return p;
}
/* the nightly question rotates — same one on both phones (date-seeded) */
const FOUR_LEADS = [
  "What four things are you grateful for tonight?",
  "What four things made today gentler?",
  "What four things would you bottle from today?",
  "What four things went quietly right today?",
  "What four things are you glad happened?",
  "What four things made you smile today?",
  "What four things deserve a thank-you tonight?",
  "What four things would you tell your diary?",
  "What four things felt like luck today?",
  "What four things warmed you up today?",
  "What four things do you want to remember from today?",
  "What four things tasted, sounded, or felt good today?",
  "What four things carried you through today?",
  "What four things made today yours?",
  "What four things softened the day?",
  "What four things are better than they were yesterday?",
  "What four things did you notice today that others missed?",
  "What four things kept you company today?",
  "What four things would today's highlight reel show?",
  "What four things felt like home today?",
  "What four small victories happened today?",
  "What four things surprised you, kindly, today?",
  "What four things do you owe today a nod for?",
  "What four things made the ordinary shine today?",
  "What four things would you do again tomorrow?",
  "What four things felt easy today?",
  "What four things gave you energy today?",
  "What four things did your future self thank you for today?",
  "What four things were worth slowing down for today?",
  "What four things made you feel looked after today?",
  "What four sounds from today would you keep?",
  "What four things did you laugh about today?",
  "What four things felt cozy today?",
  "What four things went better than expected?",
  "What four things are you proud of from today?",
  "What four tiny luxuries did today hold?",
  "What four things would you put in today's time capsule?",
  "What four things made you feel like you today?",
  "What four moments would you rewind to?",
  "What four things did the city give you today?",
  "What four things did you savor today?",
  "What four things held you steady today?",
  "What four glimmers did you catch today?",
  "What four things whispered 'good day' today?",
  "What four things would you toast to tonight?",
  "What four things did you learn or relearn today?",
  "What four things felt generous today?",
  "What four things made waiting worth it today?",
  "What four things did your body thank you for today?",
  "What four things do you want more of tomorrow?",
  "What four things came exactly when you needed them?",
  "What four things made today's weather irrelevant?",
  "What four things did you almost not notice today?",
  "What four comforts did today offer?",
  "What four things kept the gloom away today?",
  "What four things had good timing today?",
  "What four things would make today's postcard?",
  "What four things earned a place in the archive tonight?",
  "What four kindnesses crossed your path today?",
  "What four things felt like a small ceremony today?",
  "What four things made you feel capable today?",
  "What four things did you enjoy without your phone today?",
  "What four bites, sips, or smells stood out today?",
  "What four things gave today its color?",
  "What four things felt brand new today?",
  "What four things aged well today?",
  "What four things were softer than expected today?",
  "What four things did you give today, gladly?",
  "What four things did today teach you about us?",
  "What four things would you frame from today?",
  "What four things hummed along nicely today?",
  "What four things made the commute bearable today?",
  "What four things felt like a good omen today?",
  "What four things did you catch yourself smiling at?",
  "What four things deserve applause tonight?",
  "What four things were quietly beautiful today?",
  "What four things made dinner taste better today?",
  "What four things would your pet have loved about today?",
  "What four things made today feel spacious?",
  "What four things did you handle well today?",
  "What four things felt lighter today?",
  "What four things would you underline from today?",
  "What four things kept their promise today?",
  "What four things made you feel lucky in love today?",
  "What four things did the morning get right?",
  "What four things did the evening deliver?",
  "What four things would you tuck under your pillow tonight?",
  "What four things grew a little today?",
  "What four things did you not have to worry about today?",
  "What four things showed up for you today?",
  "What four things made silence comfortable today?",
  "What four things felt worth the detour today?",
  "What four things would you thank a stranger for today?",
  "What four things made your shoulders drop today?",
  "What four things belong in tonight's little museum?",
  "What four things made today gentle on you?",
  "What four things deserve to be said out loud tonight?",
  "What four things ended today on a good note?",
  "What four things will you carry into tomorrow?",
  "What four things made today enough?",
];

/* ---------------- decks ----------------
 * A parlor can carry a personalized deck (keepsake kind "deck" holds a deck
 * id; the decks table holds the content). The games read PUZZLES, SPECTRUMS,
 * window.INKLINGS_DECK and FOUR_LEADS directly, so a deck is applied by
 * mutating those arrays in place — LIVE_CONTENT aliases them, and
 * PRISTINE_CONTENT keeps the shipped built-ins for fallback and for rooms
 * with no deck. Decks are immutable by convention: editing one means minting
 * a new id and re-pointing the room, which is what makes the localStorage
 * cache safe to trust offline. */
const LIVE_CONTENT = {
  tangle: PUZZLES,
  inklings: window.INKLINGS_DECK,
  spectrums: SPECTRUMS,
  fourLeads: FOUR_LEADS,
};
const PRISTINE_CONTENT = {
  tangle: [...PUZZLES],
  inklings: [...window.INKLINGS_DECK],
  spectrums: [...SPECTRUMS],
  fourLeads: [...FOUR_LEADS],
};
let activeDeckId = null;

/* synchronous, runs before the first render — a decked parlor must never
   flash the default puzzles, and a deckless one must never keep the previous
   parlor's deck after a switch */
function applyCachedDeck() {
  applyDeckContent(LIVE_CONTENT, PRISTINE_CONTENT, null);
  activeDeckId = null;
  try {
    const raw = localStorage.getItem("couplet_deck::" + room);
    if (!raw) return;
    const { id, payload } = JSON.parse(raw);
    if (validateDeck(payload).length) return;
    applyDeckContent(LIVE_CONTENT, PRISTINE_CONTENT, payload);
    activeDeckId = id;
  } catch {
    /* a corrupt cache entry just means built-ins until refreshDeck runs */
  }
}

async function refreshDeck() {
  try {
    const { data: id, error } = await supa.rpc("get_keepsake", {
      p_code: room,
      p_kind: "deck",
    });
    if (error) throw error;
    if (!id) {
      if (activeDeckId) {
        applyDeckContent(LIVE_CONTENT, PRISTINE_CONTENT, null);
        activeDeckId = null;
        try {
          localStorage.removeItem("couplet_deck::" + room);
        } catch {}
        renderAll();
      }
      return;
    }
    if (id === activeDeckId) return;
    const { data: payload, error: deckErr } = await supa.rpc("get_deck", {
      p_id: id,
    });
    if (deckErr) throw deckErr;
    if (!payload || validateDeck(payload).length) {
      reportError("deck", new Error(`deck ${id} missing or malformed`));
      return;
    }
    applyDeckContent(LIVE_CONTENT, PRISTINE_CONTENT, payload);
    activeDeckId = id;
    try {
      localStorage.setItem(
        "couplet_deck::" + room,
        JSON.stringify({ id, payload }),
      );
    } catch {}
    renderAll();
    reportOk();
  } catch (err) {
    reportError("deck", err);
  }
}

function composeCard(prefill) {
  const card = document.createElement("div");
  card.className = "four-card";
  const lead = document.createElement("p");
  lead.className = "four-lead";
  lead.textContent =
    FOUR_LEADS[hashStr("lead:" + todayKey()) % FOUR_LEADS.length];
  card.appendChild(lead);
  const inputs = [];
  const hints = [
    "something small",
    "something about today",
    "something about them",
    "anything at all",
  ];
  for (let i = 0; i < 4; i++) {
    const row = document.createElement("div");
    row.className = "four-row";
    const num = document.createElement("span");
    num.className = "four-num";
    num.textContent = String(i + 1);
    const inp = document.createElement("input");
    inp.className = "four-input";
    inp.maxLength = 140;
    inp.placeholder = hints[i];
    if (prefill?.[i]) inp.value = prefill[i];
    row.append(num, inp);
    card.appendChild(row);
    inputs.push(inp);
  }
  const btn = document.createElement("button");
  btn.className = "submit-btn seal-btn";
  btn.textContent = "seal tonight's four 🔒";
  btn.addEventListener("click", async () => {
    const items = inputs.map((i) => i.value.trim());
    if (items.some((x) => !x)) return toast("it's called four things, love 😉");
    btn.disabled = true;
    await saveFour(items);
  });
  card.appendChild(btn);
  return card;
}
async function saveFour(items) {
  /* queued when offline: these are append-only per (day, slot), so replaying
     later is always safe — and losing tonight's four would actually hurt */
  const ok = await rpc("save_four", {
    p_code: room,
    p_day: todayKey(),
    p_slot: me.slot,
    p_items: items,
  });
  if (!ok) {
    ritualEditing = false;
    renderRitual();
    return;
  }
  ritualEditing = false;
  await fetchRitual();
  broadcast("ritual", { day: todayKey() });
  renderAll();
  const t = ritualMap()[todayKey()] ?? {};
  if (!(t.A && t.B)) toast(`sealed 🔒 waiting for ${partnerName()}`);
}
function renderRitual() {
  const wrap = $("#ritual-tonight");
  const arch = $("#ritual-archive");
  wrap.innerHTML = "";
  arch.innerHTML = "";
  const today = todayKey();
  const rm = ritualMap();
  const t = rm[today] ?? {};
  const mine = t[me.slot];
  const theirs = t[otherSlot(me.slot)];

  const date = document.createElement("p");
  date.className = "ritual-date";
  date.textContent = new Date(today + "T12:00:00").toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  wrap.appendChild(date);

  if (mine && theirs) {
    const seenKey = `tg_reveal_${room}_${today}`;
    if (!localStorage.getItem(seenKey)) {
      localStorage.setItem(seenKey, "1");
      celebrate();
    }
    wrap.appendChild(fourPanel("A", t.A.items));
    wrap.appendChild(fourPanel("B", t.B.items));
    const streakEl = document.createElement("p");
    streakEl.className = "ritual-streak";
    streakEl.innerHTML = `night <b>${ritualStreak()}</b> of gratitude together ✦`;
    wrap.appendChild(streakEl);
  } else if (mine && !ritualEditing) {
    wrap.appendChild(fourPanel(me.slot, mine.items));
    wrap.appendChild(
      sealedPanel(
        `${partnerName()}'s four — sealed until they share ✨`,
        otherSlot(me.slot),
      ),
    );
    const actions = document.createElement("div");
    actions.className = "ritual-actions";
    const edit = document.createElement("button");
    edit.className = "ghost-btn";
    edit.textContent = "edit tonight's four";
    edit.addEventListener("click", () => {
      ritualEditing = true;
      renderRitual();
    });
    actions.appendChild(edit);
    wrap.appendChild(actions);
  } else {
    if (theirs)
      wrap.appendChild(
        sealedPanel(
          `${partnerName()} already sealed theirs ✨ your turn`,
          otherSlot(me.slot),
        ),
      );
    wrap.appendChild(composeCard(mine?.items ?? null));
  }

  const days = Object.keys(rm)
    .filter((d) => d !== today)
    .sort()
    .reverse()
    .slice(0, 60);
  if (days.length) {
    const title = document.createElement("p");
    title.className = "arch-title";
    title.textContent = "your book of nights";
    arch.appendChild(title);
    for (const d of days) {
      const det = document.createElement("details");
      det.className = "arch-day";
      const sum = document.createElement("summary");
      const label = document.createElement("span");
      label.textContent = new Date(d + "T12:00:00").toLocaleDateString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const mark = document.createElement("span");
      mark.className = "arch-mark";
      const e = rm[d];
      mark.textContent =
        e.A && e.B ? "both ♥" : `only ${slotName(e.A ? "A" : "B")}`;
      sum.append(label, mark);
      det.appendChild(sum);
      const body = document.createElement("div");
      body.className = "arch-body";
      if (e.A) body.appendChild(fourPanel("A", e.A.items));
      if (e.B) body.appendChild(fourPanel("B", e.B.items));
      det.appendChild(body);
      arch.appendChild(det);
    }
  }
}

/* ---------------- DUET ---------------- */
const KB_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm<\n"];
let ghostLetters = "";
let ghostBy = null;
let typed = "";
let pendingFlipRow = null;

const duetAnswer = () => atob(state.duet.answer);
const myTurn = () => !partnerHere || state.duet.turn === me.slot;

function ensureDuet() {
  if (
    !state.duet ||
    (state.duet.mode === "daily" && state.duet.dateKey !== todayKey())
  ) {
    mutate((st) => {
      st.duet = newDuetGame("daily");
    });
  }
}
function scoreGuess(guess, answer) {
  const res = Array(5).fill("x");
  const rem = {};
  for (let i = 0; i < 5; i++) {
    if (guess[i] === answer[i]) res[i] = "g";
    else rem[answer[i]] = (rem[answer[i]] ?? 0) + 1;
  }
  for (let i = 0; i < 5; i++) {
    if (res[i] === "x" && rem[guess[i]] > 0) {
      res[i] = "y";
      rem[guess[i]] -= 1;
    }
  }
  return res;
}
function renderDuetPill() {
  if (screenNow !== "duet" || !state.duet) return;
  const pill = $("#turn-pill");
  pill.className = "turn-pill";
  if (state.duet.status !== "playing") {
    pill.textContent =
      state.duet.status === "won"
        ? "solved together ♥"
        : `it was “${duetAnswer().toUpperCase()}”`;
    return;
  }
  if (!partnerHere) {
    pill.textContent = `playing solo — ${slotName(otherSlot(me.slot))} can jump in anytime`;
    return;
  }
  if (myTurn()) {
    pill.classList.add("mine", slotClass(me.slot));
    pill.textContent = "your turn";
  } else pill.textContent = `${slotName(state.duet.turn)}'s turn…`;
}
function renderDuet() {
  if (!answerWords || !me.slot) return;
  ensureDuet();
  const d = state.duet;
  const answer = duetAnswer();
  const board = $("#duet-board");
  board.innerHTML = "";
  $("#duet-mode-tag").textContent =
    d.mode === "daily" ? "tonight's word" : `round ${d.round}`;

  for (let r = 0; r < 6; r++) {
    const rowWrap = document.createElement("div");
    rowWrap.className = "row-wrap";
    const row = document.createElement("div");
    row.className = "board-row";
    const g = d.guesses[r];
    const isCurrent = r === d.guesses.length && d.status === "playing";
    const liveWord = isCurrent ? (myTurn() ? typed : ghostLetters) : "";
    const score = g ? scoreGuess(g.w, answer) : null;

    for (let c = 0; c < 5; c++) {
      const tile = document.createElement("div");
      tile.className = "tile";
      if (g) {
        tile.textContent = g.w[c];
        const cls = "st-" + score[c];
        if (pendingFlipRow === r) {
          tile.classList.add("flip");
          tile.style.animationDelay = `${c * 0.16}s`;
          setTimeout(() => tile.classList.add(cls), c * 160 + 250);
        } else tile.classList.add(cls);
      } else if (isCurrent && liveWord[c]) {
        if (myTurn()) {
          tile.textContent = liveWord[c];
          tile.classList.add("filled");
        } else {
          tile.dataset.ch = liveWord[c];
          tile.classList.add("ghost", slotClass(ghostBy ?? otherSlot(me.slot)));
        }
      }
      row.appendChild(tile);
    }
    if (g) {
      const dot = document.createElement("span");
      dot.className = "row-author " + slotClass(g.by);
      rowWrap.appendChild(dot);
    }
    rowWrap.appendChild(row);
    board.appendChild(rowWrap);
  }
  if (pendingFlipRow != null)
    setTimeout(() => {
      pendingFlipRow = null;
    }, 1200);

  renderSuggestBar();
  renderKeyboard();
  renderDuetPill();
}
function renderSuggestBar() {
  const sb = $("#suggest-bar");
  sb.innerHTML = "";
  const d = state.duet;
  if (!d || d.status !== "playing") return;
  if (partnerHere && !myTurn()) {
    if (suggestTyped) {
      const word = document.createElement("span");
      word.className = "suggest-word";
      word.textContent = suggestTyped
        .toUpperCase()
        .padEnd(5, "·")
        .split("")
        .join(" ");
      const hint = document.createElement("span");
      hint.className = "suggest-label";
      hint.textContent = "enter to whisper it";
      sb.append(word, hint);
    } else {
      const label = document.createElement("span");
      label.className = "suggest-label";
      label.textContent = `type to whisper a word to ${slotName(d.turn)}`;
      sb.append(label);
    }
  } else if (myTurn() && suggestion) {
    const chip = document.createElement("button");
    chip.className = "suggest-chip " + slotClass(suggestion.by);
    chip.textContent = `💡 ${suggestion.w.toUpperCase()} — from ${slotName(suggestion.by)} · tap to use`;
    chip.addEventListener("click", () => {
      typed = suggestion.w;
      broadcast("typing", { letters: typed });
      renderDuet();
    });
    sb.append(chip);
  }
}
function keyState() {
  const map = {};
  const answer = duetAnswer();
  for (const g of state.duet.guesses) {
    const sc = scoreGuess(g.w, answer);
    for (let i = 0; i < 5; i++) {
      const ch = g.w[i];
      const rank = { x: 0, y: 1, g: 2 }[sc[i]];
      if (rank > (map[ch] ?? -1)) map[ch] = rank;
    }
  }
  return map;
}
function renderKeyboard() {
  const kb = $("#keyboard");
  const ks = keyState();
  kb.classList.toggle("locked", state.duet.status !== "playing");
  kb.innerHTML = "";
  for (const rowStr of KB_ROWS) {
    const row = document.createElement("div");
    row.className = "kb-row";
    for (const ch of rowStr) {
      const key = document.createElement("button");
      if (ch === "\n") {
        key.className = "key wide";
        key.textContent = "enter";
        key.dataset.k = "enter";
      } else if (ch === "<") {
        key.className = "key wide";
        key.textContent = "⌫";
        key.dataset.k = "back";
      } else {
        key.className = "key";
        key.textContent = ch;
        key.dataset.k = ch;
        const st = ks[ch];
        if (st === 2) key.classList.add("st-g");
        else if (st === 1) key.classList.add("st-y");
        else if (st === 0) key.classList.add("st-x");
      }
      row.appendChild(key);
    }
    kb.appendChild(row);
  }
}
function pressKey(k) {
  const d = state.duet;
  if (d.status !== "playing") return;
  if (!myTurn()) {
    // whisper mode: the waiting player drafts a suggestion
    if (k === "back") suggestTyped = suggestTyped.slice(0, -1);
    else if (k === "enter") return submitSuggestion();
    else if (suggestTyped.length < 5 && /^[a-z]$/.test(k)) suggestTyped += k;
    renderDuet();
    return;
  }
  if (k === "back") typed = typed.slice(0, -1);
  else if (k === "enter") return submitGuess();
  else if (typed.length < 5 && /^[a-z]$/.test(k)) typed += k;
  broadcast("typing", { letters: typed });
  renderDuet();
}
function submitSuggestion() {
  if (suggestTyped.length !== 5) return toast("five letters, love");
  if (!allowedWords.has(suggestTyped)) return toast("not in our dictionary");
  broadcast("suggest", { w: suggestTyped });
  toast(`whispered to ${slotName(state.duet.turn)} ✨`);
  suggestTyped = "";
  renderDuet();
}
function submitGuess() {
  const d = state.duet;
  if (typed.length !== 5) return toast("five letters, love");
  if (!allowedWords.has(typed)) {
    $$("#duet-board .board-row")[d.guesses.length]?.classList.add("shake");
    return toast("not in our dictionary");
  }
  const word = typed;
  typed = "";
  suggestion = null;
  suggestTyped = "";
  broadcast("typing", { letters: "" });
  mutate((st) => {
    const dd = st.duet;
    dd.guesses.push({ w: word, by: me.slot });
    dd.turn = otherSlot(me.slot);
    const won = word === duetAnswer();
    if (won) {
      dd.status = "won";
      st.stats.duetPlayed += 1;
      st.stats.duetWins += 1;
      if (dd.mode === "daily") {
        st.stats.streak = duetStreakAfterWin(
          st.stats.streak,
          st.stats.lastDailyWinDay,
          dd.dateKey,
        );
        st.stats.lastDailyWinDay = dd.dateKey;
      }
    } else if (dd.guesses.length >= 6) {
      dd.status = "lost";
      st.stats.duetPlayed += 1;
      if (dd.mode === "daily") st.stats.streak = 0;
    }
    /* only finished games count as used — an abandoned word was never seen */
    if (dd.status !== "playing" && !(st.duetUsed ?? []).includes(dd.answer))
      st.duetUsed = [...(st.duetUsed ?? []), dd.answer];
  });
  pendingFlipRow = state.duet.guesses.length - 1;
  renderDuet();
  const status = state.duet.status;
  if (status !== "playing") {
    setTimeout(() => {
      if (status === "won") {
        celebrate();
        openModal(
          "duet",
          "You two ✨",
          `“${duetAnswer().toUpperCase()}” in ${state.duet.guesses.length} — streak ${state.stats.streak} ♥\n${winLine()}`,
          duetShareCard(
            state.duet.guesses.map((g) => scoreGuess(g.w, duetAnswer())),
            state.stats.streak,
            location.origin + location.pathname,
          ),
        );
      } else {
        openModal(
          "duet",
          "So close",
          `It was “${duetAnswer().toUpperCase()}”.\nTomorrow's word is already waiting.`,
        );
      }
    }, 1400);
  }
}

/* ---------------- TANGLE ---------------- */
let tangleSel = new Set();
let tangleSelBy = null;

function ensureTangle() {
  if (!state.tangle)
    mutate((st) => {
      st.tangle = newTangleGame();
    });
}
const puzzle = () => PUZZLES[state.tangle.puzzleId];
const wordAt = (flatIdx) => {
  const g = Math.floor(flatIdx / 4);
  return puzzle().groups[g].words[flatIdx % 4];
};
function renderTangle() {
  ensureTangle();
  const t = state.tangle;
  $("#tangle-puzzle-tag").textContent =
    `puzzle ${t.puzzleId + 1} of ${PUZZLES.length} ▾`;
  $("#tangle-hearts").innerHTML =
    "❤️".repeat(Math.max(0, 4 - t.mistakes)) +
    "🖤".repeat(Math.min(4, t.mistakes));

  const bands = $("#solved-bands");
  bands.innerHTML = "";
  for (const f of t.found) {
    const grp = puzzle().groups[f.g];
    const band = document.createElement("div");
    band.className = "band g" + f.g;
    band.innerHTML = `<div class="band-title">${grp.title}</div><div class="band-words">${grp.words.join(" · ")}</div>`;
    bands.appendChild(band);
  }

  const grid = $("#tangle-grid");
  grid.innerHTML = "";
  const foundGroups = new Set(t.found.map((f) => f.g));
  for (const flatIdx of t.order) {
    if (foundGroups.has(Math.floor(flatIdx / 4))) continue;
    const w = wordAt(flatIdx);
    const tileBtn = document.createElement("button");
    tileBtn.className =
      "word-tile " +
      (w.length <= 6 ? "len-sm" : w.length <= 9 ? "len-md" : "len-lg");
    tileBtn.textContent = w;
    tileBtn.dataset.idx = flatIdx;
    if (tangleSel.has(flatIdx)) {
      tileBtn.classList.add(
        tangleSelBy && tangleSelBy !== me.slot
          ? "sel-partner-" + tangleSelBy.toLowerCase()
          : "sel",
      );
      if (tangleSelBy && tangleSelBy !== me.slot) tileBtn.classList.add("sel");
    }
    grid.appendChild(tileBtn);
  }
  $("#tangle-submit").disabled = tangleSel.size !== 4 || t.status !== "playing";

  if (
    t.status !== "playing" &&
    !modalShownFor("tangle-" + t.puzzleId + t.status)
  ) {
    const perfect = t.mistakes === 0 && t.status === "won";
    setTimeout(() => {
      if (t.status === "won") {
        celebrate();
        openModal(
          "tangle",
          perfect ? "Flawless, you two" : "Untangled ♥",
          (perfect
            ? "Not a single miss. Power couple."
            : "Got there together.") +
            "\n" +
            winLine(),
          tangleShareCard(
            t.found.map((f) => f.g),
            t.mistakes,
            t.puzzleId + 1,
            location.origin + location.pathname,
          ),
        );
      } else {
        const missed = puzzle()
          .groups.map((g, i) =>
            t.found.some((f) => f.g === i)
              ? null
              : `${g.title}: ${g.words.join(", ")}`,
          )
          .filter(Boolean)
          .join("\n");
        openModal("tangle", "Tangled up", missed);
      }
    }, 600);
  }
}
const shownModals = new Set();
const modalShownFor = (k) => {
  if (shownModals.has(k)) return true;
  shownModals.add(k);
  return false;
};

/* leaving a puzzle by choice means it's been seen — same rule for the
   next-puzzle button and the picker */
function markTanglePlayed(st) {
  const cur = st.tangle;
  if (cur && !cur.solvedIds.includes(cur.puzzleId)) {
    cur.playedIds = cur.playedIds ?? [];
    if (!cur.playedIds.includes(cur.puzzleId)) cur.playedIds.push(cur.puzzleId);
  }
}

function openTanglePicker() {
  const grid = $("#picker-grid");
  grid.innerHTML = "";
  const t = state.tangle;
  const solved = new Set(t?.solvedIds ?? []);
  const played = new Set(t?.playedIds ?? []);
  for (let i = 0; i < PUZZLES.length; i++) {
    const cell = document.createElement("button");
    cell.className = "picker-cell";
    if (solved.has(i)) cell.classList.add("solved");
    else if (played.has(i)) cell.classList.add("played");
    if (i === t?.puzzleId) cell.classList.add("current");
    cell.textContent = i + 1;
    cell.dataset.id = i;
    grid.appendChild(cell);
  }
  $("#picker-modal").classList.remove("hidden");
}

function tapTile(flatIdx) {
  const t = state.tangle;
  if (t.status !== "playing") return;
  if (tangleSel.has(flatIdx)) tangleSel.delete(flatIdx);
  else if (tangleSel.size < 4) tangleSel.add(flatIdx);
  tangleSelBy = me.slot;
  broadcast("sel", { sel: [...tangleSel] });
  renderTangle();
}
function submitTangle() {
  const t = state.tangle;
  if (tangleSel.size !== 4) return;
  const sel = [...tangleSel].sort((a, b) => a - b);
  const key = sel.join(",");
  if (t.tried.includes(key)) return sharedToast("already tried that one");
  const groupsHit = new Set(sel.map((i) => Math.floor(i / 4)));
  const clearSel = () => {
    tangleSel = new Set();
    broadcast("sel", { sel: [] });
  };

  if (groupsHit.size === 1) {
    const g = [...groupsHit][0];
    clearSel();
    mutate((st) => {
      st.tangle.found.push({ g, by: me.slot });
      if (st.tangle.found.length === 4) {
        st.tangle.status = "won";
        st.stats.tangleWins += 1;
        if (st.tangle.mistakes === 0) st.stats.tanglePerfect += 1;
        if (!st.tangle.solvedIds.includes(st.tangle.puzzleId))
          st.tangle.solvedIds.push(st.tangle.puzzleId);
      }
    });
  } else {
    const counts = {};
    sel.forEach((i) => {
      const g = Math.floor(i / 4);
      counts[g] = (counts[g] ?? 0) + 1;
    });
    const oneAway = Object.values(counts).includes(3);
    $("#tangle-grid").classList.add("shake");
    setTimeout(() => $("#tangle-grid").classList.remove("shake"), 450);
    sharedToast(oneAway ? "so close — one away!" : "not quite, loves", 4200);
    mutate((st) => {
      st.tangle.tried.push(key);
      st.tangle.mistakes += 1;
      if (st.tangle.mistakes >= 4) st.tangle.status = "lost";
    });
    if (state.tangle.status === "lost") clearSel();
  }
}

/* ---------------- emotes & celebration ---------------- */
function spawnFloaters(e, from) {
  const layer = $("#float-layer");
  const n = 7;
  for (let i = 0; i < n; i++) {
    const el = document.createElement("span");
    el.className = "floater";
    el.textContent = e;
    el.style.left = `${12 + Math.random() * 76}%`;
    el.style.animationDelay = `${Math.random() * 0.5}s`;
    el.style.fontSize = `${1.2 + Math.random() * 1.2}rem`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 3400);
  }
}
function celebrate() {
  ["❤️", "✨", "🎉"].forEach((e, i) =>
    setTimeout(() => spawnFloaters(e, me.slot), i * 300),
  );
}

/* ---------------- toast & modal ---------------- */
const WIN_LINES = [
  "Tell each other four grateful things tonight ♥",
  "This calls for soba.",
  "Dia Beacon energy ✨",
  "Next stop: another museum date",
  "Celebrate with a movie night 🍿",
  "You'd survive a rom-com montage",
  "Somewhere a lavender field approves",
  "Encore! Encore!",
];
const winLine = () => WIN_LINES[Math.floor(Math.random() * WIN_LINES.length)];
/* toast on BOTH phones — gameplay feedback should never be submitter-only */
function sharedToast(msg, ms = 3200) {
  toast(msg, ms);
  broadcast("feedback", { msg, ms });
}
let toastTimer = null;
function toast(msg, ms = 3200) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
let modalGame = null;
function openModal(game, title, body, brag = null) {
  modalGame = game;
  modalBrag = brag;
  $("#modal-eyebrow").textContent = game === "duet" ? "duet" : "tangle";
  $("#modal-title").textContent = title;
  $("#modal-body").textContent = body;
  $("#modal-share").classList.toggle("hidden", !brag);
  $("#modal").classList.remove("hidden");
}
let modalBrag = null;
function closeModal() {
  $("#modal").classList.add("hidden");
}

/* ---------------- events ---------------- */
function wire() {
  $$(".identity-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const name = $("#name-input").value.trim();
      if (!name) {
        toast("tell us your name first ♥");
        $("#name-input").focus();
        return;
      }
      me = { slot: b.dataset.slot, name };
      store.slot = me.slot;
      store.name = name;
      room = ($("#room-input").value.trim() || randomRoom()).toUpperCase();
      store.room = room;
      enterParlor();
    }),
  );

  /* typing a partner's code shows who's already inside — the difference
     between "am I in the right parlor?" and joining a typo by accident */
  let rosterTimer = null;
  let lastRosterCode = "";
  $("#room-input").addEventListener("input", () => {
    const code = $("#room-input").value.trim().toUpperCase();
    clearTimeout(rosterTimer);
    if (code === lastRosterCode) return;
    lastRosterCode = "";
    $("#label-a").textContent = "emerald";
    $("#label-b").textContent = "mint";
    if (code.length < 6) return;
    rosterTimer = setTimeout(() => {
      lastRosterCode = code;
      fetchRoomRoster(code);
    }, 450);
  });

  $("#card-duet").addEventListener("click", () => {
    typed = "";
    ghostLetters = "";
    show("duet");
  });
  $("#card-tangle").addEventListener("click", () => show("tangle"));
  $("#card-ritual").addEventListener("click", () => show("ritual"));
  $("#card-attune").addEventListener("click", () => show("attune"));
  $("#card-inklings").addEventListener("click", () => show("inklings"));
  $$("[data-back]").forEach((b) =>
    b.addEventListener("click", () => show("lobby")),
  );

  $("#keyboard").addEventListener("click", (e) => {
    const k = e.target.closest(".key")?.dataset.k;
    if (k) pressKey(k);
  });
  document.addEventListener("keydown", (e) => {
    if (screenNow !== "duet" || e.metaKey || e.ctrlKey) return;
    if (e.key === "Enter") pressKey("enter");
    else if (e.key === "Backspace") pressKey("back");
    else if (/^[a-zA-Z]$/.test(e.key)) pressKey(e.key.toLowerCase());
  });
  $("#duet-new-btn").addEventListener("click", () => {
    typed = "";
    ghostLetters = "";
    mutate((st) => {
      st.duet = newDuetGame("free", (st.duet?.round ?? 0) + 1);
    });
  });

  $("#tangle-grid").addEventListener("click", (e) => {
    const idx = e.target.closest(".word-tile")?.dataset.idx;
    if (idx != null) tapTile(Number(idx));
  });
  $("#tangle-submit").addEventListener("click", submitTangle);
  $("#tangle-clear").addEventListener("click", () => {
    tangleSel = new Set();
    broadcast("sel", { sel: [] });
    renderTangle();
  });
  $("#tangle-shuffle").addEventListener("click", () =>
    mutate((st) => {
      st.tangle.order = seededShuffle(16, hashStr(String(Math.random())));
    }),
  );
  $("#tangle-new-btn").addEventListener("click", () => {
    tangleSel = new Set();
    mutate((st) => {
      markTanglePlayed(st);
      st.tangle = newTangleGame();
    });
  });
  $("#tangle-puzzle-tag").addEventListener("click", openTanglePicker);
  $("#picker-cancel").addEventListener("click", () =>
    $("#picker-modal").classList.add("hidden"),
  );
  $("#picker-grid").addEventListener("click", (e) => {
    const cell = e.target.closest(".picker-cell");
    if (!cell) return;
    $("#picker-modal").classList.add("hidden");
    const id = Number(cell.dataset.id);
    if (id === state.tangle?.puzzleId) return;
    tangleSel = new Set();
    broadcast("sel", { sel: [] });
    mutate((st) => {
      markTanglePlayed(st);
      st.tangle = newTangleGame(id);
    });
  });

  $("#emote-toggle").addEventListener("click", () =>
    $("#emote-tray").classList.toggle("open"),
  );
  $("#emote-tray").addEventListener("click", (e) => {
    const em = e.target.closest("[data-emote]")?.dataset.emote;
    if (em) {
      spawnFloaters(em, me.slot);
      broadcast("emote", { e: em });
      $("#emote-tray").classList.remove("open");
    }
  });

  $("#photo-add").addEventListener("click", () => $("#photo-file").click());
  $("#photo-frame").addEventListener("click", () =>
    $("#photo-modal").classList.remove("hidden"),
  );
  $("#photo-cancel").addEventListener("click", () =>
    $("#photo-modal").classList.add("hidden"),
  );
  $("#photo-replace").addEventListener("click", () => {
    $("#photo-modal").classList.add("hidden");
    $("#photo-file").click();
  });
  $("#photo-remove").addEventListener("click", async () => {
    $("#photo-modal").classList.add("hidden");
    await supa.rpc("del_keepsake", { p_code: room, p_kind: "photo" });
    photoData = null;
    localStorage.removeItem(photoCacheKey());
    broadcast("photo", {});
    renderAll();
    toast("photo removed");
  });
  $("#photo-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    toast("tucking it into the frame…");
    try {
      const dataUrl = await shrinkImage(file, 1100, 0.82);
      if (dataUrl.length > 1400000)
        return toast("that one's too big — try another");
      const { error } = await supa.rpc("set_keepsake", {
        p_code: room,
        p_kind: "photo",
        p_data: dataUrl,
      });
      if (error) return toast("couldn't save — try again");
      photoData = dataUrl;
      /* stale stamp would serve the old photo from cache on next open */
      localStorage.removeItem(photoCacheKey());
      broadcast("photo", {});
      renderAll();
      toast("our photo is up ♥");
    } catch {
      toast("couldn't read that photo");
    }
  });

  $("#rename-btn").addEventListener("click", () => {
    $("#name-edit").value = me.name ?? "";
    $("#name-modal").classList.remove("hidden");
    $("#name-edit").focus();
  });
  $("#name-cancel").addEventListener("click", () =>
    $("#name-modal").classList.add("hidden"),
  );
  $("#name-save").addEventListener("click", () => {
    const n = $("#name-edit").value.trim();
    if (!n) return;
    $("#name-modal").classList.add("hidden");
    if (n === me.name) return;
    me.name = n;
    store.name = n;
    ensureMyName();
    channel?.track({ slot: me.slot, name: n });
    toast(`you're ${n} now ♥`);
  });

  $("#note-btn").addEventListener("click", () => {
    $("#note-modal").classList.remove("hidden");
    $("#note-text").focus();
  });
  $("#note-cancel").addEventListener("click", () =>
    $("#note-modal").classList.add("hidden"),
  );
  $("#note-save").addEventListener("click", async () => {
    const t = $("#note-text").value.trim();
    if (!t) return;
    $("#note-text").value = "";
    $("#note-modal").classList.add("hidden");
    const note = {
      p_code: room,
      p_id: crypto.randomUUID?.() ?? String(Math.random()).slice(2),
      p_by: me.slot,
      /* stamp the author's name now — looked up at render time, a note
         re-labelled itself after a rename and read differently per device */
      p_name: me.name,
      p_body: t,
      p_at: new Date().toISOString(),
    };
    noteRows = [
      ...noteRows,
      { id: note.p_id, by: me.slot, name: me.name, body: t, at: note.p_at },
    ];
    renderNotes();
    if (await rpc("save_note", note)) {
      broadcast("note", {});
      toast("note pinned 💌");
    }
  });

  $("#invite-btn").addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}&as=${otherSlot(me.slot)}`;
    const text = `Meet me in the parlor ♥`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Couplet", text, url });
      } catch {
        /* dismissed */
      }
    } else {
      await navigator.clipboard.writeText(url);
      toast("link copied — text it over");
    }
  });
  $("#switch-btn").addEventListener("click", () => {
    localStorage.removeItem("couplet_slot");
    location.href = location.pathname;
  });

  /* The only irreversible thing in the app, and it erases two people's
     memories, not one. So it asks for the code by hand — the friction is the
     feature — and says out loud that the other person isn't consulted. */
  $("#delete-btn").addEventListener("click", () => {
    $("#delete-confirm").value = "";
    $("#delete-go").disabled = true;
    $("#delete-modal").classList.remove("hidden");
  });
  $("#delete-cancel").addEventListener("click", () =>
    $("#delete-modal").classList.add("hidden"),
  );
  $("#delete-confirm").addEventListener("input", (e) => {
    $("#delete-go").disabled =
      e.target.value.trim().toUpperCase() !== (room ?? "").toUpperCase();
  });
  $("#delete-go").addEventListener("click", async () => {
    $("#delete-go").disabled = true;
    try {
      const { error } = await supa.rpc("delete_room", { p_code: room });
      if (error) throw error;
    } catch (err) {
      reportError("delete", err);
      toast("couldn't delete — check your signal and try again");
      return;
    }
    broadcast("gone", {});
    forgetParlorLocally();
    location.href = location.pathname;
  });

  $("#modal-close").addEventListener("click", closeModal);
  /* the brag is the invitation: a spoiler-free grid the group chat already
     knows how to read, with the door to the parlor riding along */
  $("#modal-share").addEventListener("click", async () => {
    if (!modalBrag) return;
    if (navigator.share) {
      try {
        await navigator.share({ text: modalBrag });
      } catch {
        /* dismissed */
      }
    } else {
      await navigator.clipboard.writeText(modalBrag);
      toast("copied — drop it in the group chat ♥");
    }
  });
  $("#modal-again").addEventListener("click", () => {
    closeModal();
    if (modalGame === "duet") $("#duet-new-btn").click();
    else $("#tangle-new-btn").click();
  });
}

/* ---------------- boot ---------------- */
async function loadWords() {
  const [allowedTxt, answersTxt] = await Promise.all([
    fetch("words/allowed.txt").then((r) => r.text()),
    fetch("words/answers.txt").then((r) => r.text()),
  ]);
  answerWords = answersTxt
    .split("\n")
    .map((w) => w.trim())
    .filter((w) => w.length === 5);
  allowedWords = new Set(
    [...allowedTxt.split("\n").map((w) => w.trim()), ...answerWords].filter(
      (w) => w.length === 5,
    ),
  );
}
async function enterParlor() {
  /* the code is the only credential there is, so it must not sit in the
     address bar — browser history, link previews, and screen shares all
     leak it. The invite link still carries it once; scrubbed after join. */
  history.replaceState(null, "", location.pathname);
  applyCachedDeck();
  await loadWords();
  show("lobby");
  renderAll();
  await connect();
  refreshDeck();
  flushQueue();
}

/* ---------------- offline ---------------- */
/* The installed app gets opened on trains. Duet and Tangle are pure local
   computation, so with the shell cached they play fine with no signal; only
   syncing needs the network. Writes attempted offline are queued here instead
   of vanishing into a catch block. */
/* Failures used to vanish into empty catch blocks, which is how a rename war
   and a broadcast storm both ran unnoticed for days. Fallback behaviour is
   unchanged — but now every failure leaves a trace, and a sustained one is
   visible to the people using the app instead of only to the network tab. */
let netDown = false;
function reportError(where, err) {
  console.warn(`[couplet] ${where}:`, err);
  if (netDown) return;
  netDown = true;
  document.body.dataset.net = "down";
  renderPresence();
}
function reportOk() {
  if (!netDown) return;
  netDown = false;
  document.body.dataset.net = "ok";
  renderPresence();
}

/* Wipe every trace of this parlor from this device. Used both by the person
   who deletes it and by their partner's phone when the "gone" ping lands. */
function forgetParlorLocally() {
  try {
    if (room) localStorage.removeItem("couplet_deck::" + room);
    for (const k of ["couplet_room", "couplet_slot", "couplet_name", "couplet_queue"])
      localStorage.removeItem(k);
  } catch {
    /* private mode — nothing was stored to begin with */
  }
}

const QUEUE_KEY = "couplet_queue";
const readQueue = () => {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
  } catch {
    return [];
  }
};
const writeQueue = (q) => {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-50)));
  } catch {
    /* storage full — dropping the queue beats bricking the app */
  }
};

/* every durable write goes through here, so nothing is silently lost */
async function rpc(fn, args, { queue = true } = {}) {
  try {
    const { error } = await supa.rpc(fn, args);
    if (error) throw error;
    reportOk();
    return true;
  } catch (err) {
    reportError(`rpc:${fn}`, err);
    if (queue) {
      writeQueue([...readQueue(), { fn, args, at: Date.now() }]);
      toast("saved on this phone — will sync when you're back online");
    }
    return false;
  }
}

async function flushQueue() {
  const q = readQueue();
  if (!q.length || !supa) return;
  const left = [];
  for (const item of q) {
    try {
      const { error } = await supa.rpc(item.fn, item.args);
      if (error) throw error;
    } catch {
      left.push(item);
    }
  }
  writeQueue(left);
  if (left.length < q.length) {
    await Promise.all([fetchRitual(), fetchInklings()]);
    renderAll();
    toast(
      `synced ${q.length - left.length} saved change${q.length - left.length > 1 ? "s" : ""} ✦`,
    );
  }
}
addEventListener("online", flushQueue);

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register(`sw.js?v=${ASSET_VERSION}`).catch(() => {});
  let reloading = false;
  /* the very first install also fires controllerchange when it claims the
     page — that's a fresh visitor, not an update; only toast on real swaps */
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    /* a newer build took over — this is what made "hard-refresh both phones"
       a recurring chore, so offer the refresh right in the toast */
    if (reloading) return;
    reloading = true;
    const t = $("#toast");
    const onTap = () => location.reload();
    t.classList.add("tappable");
    t.addEventListener("click", onTap);
    toast("a new version is ready — tap to refresh ✦", 12000);
    setTimeout(() => {
      t.classList.remove("tappable");
      t.removeEventListener("click", onTap);
    }, 12000);
  });
}

/* preview who already lives in a parlor, for the join screen */
async function fetchRoomRoster(code) {
  try {
    const r = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/get_room`, {
      method: "POST",
      headers: { apikey: CFG.supabaseKey, "Content-Type": "application/json" },
      body: JSON.stringify({ p_code: code.toUpperCase() }),
    });
    const s = await r.json();
    const players = s?.players ?? {};
    if (players.A) $("#label-a").textContent = players.A;
    if (players.B) $("#label-b").textContent = players.B;
    if (!document.querySelector(".identity-btn.picked")) {
      if (players.A && !players.B)
        $('.identity-btn[data-slot="B"]').classList.add("picked");
      else if (players.B && !players.A)
        $('.identity-btn[data-slot="A"]').classList.add("picked");
    }
  } catch {
    /* join screen works fine without the roster */
  }
}
/* ---------------- INKLINGS ---------------- */
/* One card per round: the subject answers about themselves, the partner
   guesses; both sealed until both are in (same table trick as four_things —
   coalesce-merged fields, so simultaneous writes can't race). Card = index
   into INKLINGS_DECK, which is append-only for that reason. */
const INK_PER_SESSION = 5;
let inkRows = [];

async function fetchInklings() {
  try {
    const { data, error } = await supa.rpc("get_inklings", { p_code: room });
    if (error) throw error;
    inkRows = Array.isArray(data) ? data : [];
    reportOk();
  } catch (e) {
    /* keep whatever we had, but say so */
    reportError("fetchInklings", e);
  }
}

const inkRowFor = (day, idx) =>
  inkRows.find((r) => r.day === day && r.idx === idx);
const inkSubjectFor = (idx) =>
  libInkSubjectFor(idx, state.inklings.startSubject);
const inkResolved = () => inkRows.filter((r) => r.match !== null);

function inkCardText(cardId, subject) {
  return renderInkPrompt(
    window.INKLINGS_DECK[cardId],
    state.players?.[subject],
    state.players?.[otherSlot(subject)],
  );
}

function inkDeal(extend = false) {
  const day = todayKey();
  const used = inkRows.map((r) => r.card);
  if (extend && state.inklings?.day === day) used.push(...state.inklings.cards);
  const tonight = [
    ...(state.inklings?.day === day ? state.inklings.cards : []),
    ...inkRows.filter((r) => r.day === day).map((r) => r.card),
  ];
  const pool = inkDealPool(
    window.INKLINGS_DECK.length,
    used,
    tonight,
    INK_PER_SESSION,
  );
  const pick = [];
  while (pick.length < INK_PER_SESSION && pool.length)
    pick.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  mutate((st) => {
    if (extend && st.inklings?.day === day)
      st.inklings.cards = [...st.inklings.cards, ...pick];
    else
      st.inklings = {
        day,
        cards: pick,
        startSubject: Math.random() < 0.5 ? "A" : "B",
      };
  });
}

function inkCurrentIdx() {
  const ses = state.inklings;
  return libInkCurrentIdx(ses.cards, (i) => inkRowFor(ses.day, i));
}

async function inkSave(fields) {
  /* queued when offline: coalesce-merged per (day, idx), so a late replay
     can't clobber a newer field */
  const ok = await rpc("save_inkling", {
    p_code: room,
    p_day: state.inklings.day,
    ...fields,
  });
  if (!ok) return false;
  await fetchInklings();
  broadcast("ink", {});
  renderAll();
  return true;
}

let inkSig = null;
function renderInklings() {
  const stage = $("#ink-stage");
  const ses = state.inklings;
  const today = todayKey();
  /* skip untouched rebuilds — keeps typing focus and kills animation replay */
  const idxNow = ses && ses.day === today ? inkCurrentIdx() : "intro";
  const rowNow = typeof idxNow === "number" ? inkRowFor(ses.day, idxNow) : null;
  const sig = JSON.stringify([
    ses?.day,
    ses?.cards,
    idxNow,
    rowNow?.truth,
    rowNow?.guess,
    rowNow?.match,
    state.players,
    inkRows.length,
  ]);
  if (sig === inkSig && stage.childElementCount) return;
  inkSig = sig;
  const prevInput = stage.querySelector(".four-input")?.value;
  stage.textContent = "";

  const card = document.createElement("div");
  card.className = "ink-card";
  stage.appendChild(card);

  /* no session tonight yet — the invitation */
  if (!ses || ses.day !== today) {
    const lead = document.createElement("p");
    lead.className = "ink-prompt";
    lead.textContent = "How well do you really know each other?";
    const sub = document.createElement("p");
    sub.className = "ink-wait";
    sub.textContent =
      "five cards — one of you answers truthfully, the other guesses. sealed till you're both in.";
    const deal = document.createElement("button");
    deal.className = "submit-btn seal-btn";
    deal.textContent = "deal tonight's cards 🂠";
    deal.addEventListener("click", () => inkDeal());
    card.append(lead, sub, deal);
    renderInkLifetime(stage);
    return;
  }

  const idx = inkCurrentIdx();

  /* session complete — the recap */
  if (idx === -1) {
    const todays = ses.cards.map((_, i) => inkRowFor(ses.day, i));
    const hits = todays.filter((r) => r?.match === true).length;
    const recap = document.createElement("div");
    recap.className = "ink-recap";
    const big = document.createElement("p");
    big.className = "big";
    big.textContent = `${hits} of ${todays.length}`;
    const line = document.createElement("p");
    line.className = "ink-wait";
    line.textContent =
      hits >= 4
        ? "suspiciously in sync 💛"
        : hits >= 2
          ? "getting to know you, getting to know all about you"
          : "well. more research required 😄";
    const more = document.createElement("button");
    more.className = "ghost-btn";
    more.textContent = "deal 5 more";
    more.addEventListener("click", () => inkDeal(true));
    recap.append(big, line, more);
    card.appendChild(recap);
    renderInkDots(stage, ses);
    renderInkLifetime(stage);
    return;
  }

  /* live card */
  renderInkDots(stage, ses);
  const row = inkRowFor(ses.day, idx);
  const subject = inkSubjectFor(idx);
  const meIsSubject = me.slot === subject;
  const myField = meIsSubject ? row?.truth : row?.guess;
  const bothIn = row?.truth && row?.guess;

  const prompt = document.createElement("p");
  prompt.className = "ink-prompt";
  prompt.textContent = inkCardText(ses.cards[idx], subject);
  const roles = document.createElement("p");
  roles.className = "ink-roles";
  roles.innerHTML =
    `<b class="role-${subject.toLowerCase()}">${slotName(subject)}</b> answers · ` +
    `<b class="role-${otherSlot(subject).toLowerCase()}">${slotName(otherSlot(subject))}</b> guesses`;
  card.append(prompt, roles);

  if (!bothIn) {
    if (myField) {
      const wait = document.createElement("p");
      wait.className = "ink-wait";
      wait.textContent = `sealed 🔒 waiting for ${partnerName()}…`;
      card.appendChild(wait);
    } else {
      const inp = document.createElement("input");
      inp.className = "four-input";
      inp.maxLength = 60;
      inp.placeholder = meIsSubject
        ? "the truth, in a few words"
        : "your best guess";
      if (prevInput) inp.value = prevInput;
      const seal = document.createElement("button");
      seal.className = "submit-btn seal-btn";
      seal.textContent = meIsSubject ? "seal my answer 🔒" : "seal my guess 🔒";
      seal.addEventListener("click", async () => {
        const v = inp.value.trim();
        if (!v) return toast("a few words, love 😉");
        seal.disabled = true;
        const fields = {
          p_idx: idx,
          p_card: ses.cards[idx],
          p_subject: subject,
        };
        fields[meIsSubject ? "p_truth" : "p_guess"] = inkB64(v);
        if (!(await inkSave(fields))) seal.disabled = false;
      });
      card.append(inp, seal);
    }
    return;
  }

  /* both sealed — the reveal */
  const reveal = document.createElement("div");
  reveal.className = "ink-reveal";
  for (const [label, value, slot] of [
    ["the truth", row.truth, subject],
    ["the guess", row.guess, otherSlot(subject)],
  ]) {
    const panel = document.createElement("div");
    panel.className = "four-panel " + slotClass(slot);
    const l = document.createElement("p");
    l.className = "ink-panel-label";
    l.textContent = `${label} · ${slotName(slot)}`;
    const v = document.createElement("p");
    v.textContent = inkPlain(value);
    panel.append(l, v);
    reveal.appendChild(panel);
  }
  card.appendChild(reveal);

  if (meIsSubject) {
    const verdict = document.createElement("div");
    verdict.className = "ink-verdict";
    const yes = document.createElement("button");
    yes.className = "submit-btn";
    yes.textContent = "they got it 💛";
    const no = document.createElement("button");
    no.className = "ghost-btn";
    no.textContent = "not quite 😅";
    const judge = (match) => async () => {
      yes.disabled = no.disabled = true;
      if (await inkSave({ p_idx: idx, p_match: match })) {
        if (match) {
          celebrate();
          toast("you know each other 💛");
        }
        broadcast("feedback", {
          msg: match
            ? `💛 ${me.name} says you got it`
            : `😅 close — it was "${inkPlain(row.truth)}"`,
          ms: 3600,
        });
      } else yes.disabled = no.disabled = false;
    };
    yes.addEventListener("click", judge(true));
    no.addEventListener("click", judge(false));
    verdict.append(yes, no);
    card.appendChild(verdict);
  } else {
    const wait = document.createElement("p");
    wait.className = "ink-wait";
    wait.textContent = `${slotName(subject)} is judging… 👀`;
    card.appendChild(wait);
  }
}

function renderInkDots(stage, ses) {
  const dots = document.createElement("div");
  dots.className = "ink-dots";
  const current = inkCurrentIdx();
  ses.cards.forEach((_, i) => {
    const d = document.createElement("span");
    d.className = "ink-dot";
    const r = inkRowFor(ses.day, i);
    if (r?.match === true) d.classList.add("hit");
    else if (r?.match === false) d.classList.add("miss");
    else if (i === current) d.classList.add("now");
    dots.appendChild(d);
  });
  stage.prepend(dots);
}

function renderInkLifetime(stage) {
  const done = inkResolved();
  if (!done.length) return;
  const pct = Math.round(
    (100 * done.filter((r) => r.match).length) / done.length,
  );
  const p = document.createElement("p");
  p.className = "ink-lifetime";
  p.textContent = `all time: you know each other ${pct}% · ${done.length} cards`;
  stage.appendChild(p);
}

function renderNow() {
  if (screenNow === "lobby") renderLobby();
  if (screenNow === "duet") renderDuet();
  if (screenNow === "tangle") renderTangle();
  if (screenNow === "ritual") renderRitual();
  if (screenNow === "attune") renderAttune();
  if (screenNow === "inklings") renderInklings();
  renderPresence();
}

/* A burst of broadcasts used to mean a burst of full re-renders, which is
   what replayed entrance animations and made the lobby flicker. Coalesce
   into one paint per frame instead of guarding each render function
   separately — the previous fix had to be applied twice and would have
   needed a third. */
let renderQueued = false;
function renderAll() {
  if (renderQueued) return;
  renderQueued = true;
  const run = () => {
    renderQueued = false;
    renderNow();
  };
  /* rAF never fires in a hidden tab, so a phone that loaded data with the
     screen off would come back to a UI that never painted. Fall back to a
     timeout when hidden — batching still works, it just isn't frame-aligned. */
  if (document.visibilityState === "visible") requestAnimationFrame(run);
  else setTimeout(run, 0);
}

function randomRoom() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = "";
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}

(function boot() {
  wire();
  const params = new URLSearchParams(location.search);
  const roomParam = params.get("room");
  const asParam = params.get("as");
  $("#room-input").value = roomParam ?? store.room ?? randomRoom();
  /* the field arrives prefilled with a fresh code, which is right for the
     person starting a parlor — but their partner arrives to TYPE a code, and
     appending to the suggestion strands them alone in a mistyped room.
     Select-on-focus makes typing (or pasting) replace it. */
  $("#room-input").addEventListener("focus", (e) => e.target.select());
  if (store.name) $("#name-input").value = store.name;

  if (asParam === "A" || asParam === "B") {
    store.slot = asParam;
    if (roomParam) store.room = roomParam.toUpperCase();
    if (store.name) {
      me = { slot: asParam, name: store.name };
      room = store.room;
      enterParlor();
    } else {
      // invited but never named themselves: preselect their side, ask the name
      $(`.identity-btn[data-slot="${asParam}"]`)?.classList.add("picked");
      $("#name-input").focus();
      if (roomParam) fetchRoomRoster(roomParam);
    }
  } else if (roomParam && store.name && store.slot) {
    // a shared parlor URL: the URL's room wins over whatever was stored
    store.room = roomParam.toUpperCase();
    me = { slot: store.slot, name: store.name };
    room = store.room;
    enterParlor();
  } else if (roomParam) {
    fetchRoomRoster(roomParam);
  } else if (store.slot && store.room && store.name) {
    me = { slot: store.slot, name: store.name };
    room = store.room;
    enterParlor();
  }
  registerServiceWorker();
})();
