# Feature Pack: Sound, Score Log, JT Mode, Emoji Mode, Leaderboard — Design

**Date:** 2026-06-10
**Status:** Approved

## Overview

Five features, built in order of complexity, each as its own commit:

1. Sound effects (default off)
2. Score log on results screen
3. JT mode (solo big-target training)
4. Emoji mode (room mode, advance-on-miss)
5. Persistent top-8 historical leaderboard

## Context & Constraints

- Score is **server-authoritative**: the server replays the client's `antiCheatStream`
  against the seeded target sequence (`auditPlayerBehavior` in `server.js`). Any change
  to target-advance rules must be mirrored in the replay or players get false-banned.
- All state is in-memory today; the leaderboard introduces the first persistence.
- Client is a single file (`public/index.html`); server is `server.js`; pure logic with
  tests lives in small modules (`team-logic.js` + `test/`).

---

## 1. Sound Effects

**What:** Loud hit/miss sound effects, toggleable, default muted.

- WebAudio-synthesized, no audio asset files:
  - **Hit:** short ding; pitch rises with ring points (100-pt center = highest).
  - **Miss:** harsh buzzer.
- High gain when enabled ("very loud" was the request).
- Speaker icon in the header: 🔊 when on, 🔇 when off. Default **off**.
- Preference persisted in `localStorage` (`apexpulse_sound`).
- AudioContext created lazily on first user gesture (browser autoplay policy).
- Client-only; applies in every mode (competitive, JT, emoji).

## 2. Score Log on Results Screen

**What:** Per-click accuracy log on the results overlay, sourced from the **server's
replay** so displayed numbers can't be forged client-side.

- Server: `auditPlayerBehavior` already replays every click. Extend it to also build:
  - `clickLog`: per click — `t` (ms into run), `offset` (px from center), `pts`,
    `hit` (bool), `running` (score after click).
  - `summary`: `clicks`, `hits`, `accuracy` (hits/clicks %), `avgOffset` (px).
  - Stored on the player after a passed audit. Cheaters get no log (banned display
    unchanged). Players who never submit (window expired) have no log.
- `match_over` becomes **per-socket**: each player receives all players' `summary`
  plus their **own** full `clickLog`.
- Client results overlay adds:
  - One summary line: `HITS 24/31 · ACCURACY 77% · AVG OFFSET 6.2px`.
  - A scrollable table of the click log (capped height; overlay already scrolls).
- Anti-forge property: the log is the server's reconstruction, not the client's claims.

## 3. JT Mode (solo big-target training)

**What:** Solo practice mode with adjustable target size, named after Justin Thomas
who asked for bigger targets.

- Lobby overlay gains a **JT MODE** button + target-size slider (1.0×–3.0×, step 0.1,
  default 1.6×). Visible only in the pre-lock lobby (`status === 'waiting'`).
- Starts a local 30s run: same game loop, locally generated random seed,
  `target.r × factor` for both rendering and hit detection.
- **No socket emits**: no `sync_score`, no `submit_score`, no anti-cheat, and scores
  never enter the historical leaderboard.
- Run end shows a local summary (score, hits, accuracy) with **AGAIN** and
  **BACK TO LOBBY** buttons.
- If the host locks the room mid-JT-run, the competitive `match_open` flow takes
  priority: the JT run is aborted and the player returns to the ready overlay.

## 4. Emoji Mode (room mode)

**What:** Entertainment mode — misses don't retry; every click advances to the next
target, and after a miss the next target is a 🤣 emoji.

- Host toggles **EMOJI MODE** in the lobby (checkbox like team mode), synced to all
  players via `room_config`. Orthogonal to team mode — both can be on.
- Rule change (client **and** server replay): the target advances on **every** click,
  hit or miss. Ring scoring unchanged, miss still −20, floor at 0.
- Rendering: after a miss, the next target draws as 🤣 (font-rendered at the target
  position, sized to the target's diameter, center aim dot kept). After a hit, normal
  rings return. Hitbox identical either way.
- Server: `auditPlayerBehavior(stream, seed, claimedScore, emojiMode)` — in emoji
  mode, respawn the target after every click during replay. Anti-cheat heuristics
  (macro cadence, pixel-perfect ratio) still run.
- Emoji-mode match scores are **excluded** from the historical leaderboard. The live
  in-match leaderboard works as normal.

## 5. Persistent Top-8 Historical Leaderboard

**What:** All-time top 8 verified runs, surviving restarts, on a dedicated page.

- **Storage:** `records.json` next to `server.js` (path overridable via
  `RECORDS_FILE` env var). Loaded at startup; written synchronously on change
  (file is tiny — max 8 entries).
- **Entry:** `{ name, score, accuracy, date }` (ISO date). Duplicates of the same
  name allowed — records are runs, not players.
- **Eligibility:** only audit-passed competitive submits. Excluded: cheaters,
  JT-mode (never submits), emoji-mode matches, score 0.
- **Logic:** pure `records.js` module — `addRecord(list, entry) -> new top-8 list`
  (sorted desc by score, trimmed to 8) — with unit tests in `test/`, matching the
  existing `team-logic.js` pattern.
- **API:** `GET /api/leaderboard` → JSON top 8.
- **UI:** new `public/leaderboard.html`, same dark theme, ranked list with
  name / score / accuracy / date. 🏆 link in the game header opens it; back link
  returns to the game.

## Error Handling

- Sound: if AudioContext creation fails, toggle stays functional but silent — no crash.
- Score log: missing log (never submitted, banned) → summary line omitted for that player.
- Records file: corrupt/missing `records.json` → start with empty list, log a warning.
- Emoji mode + replay: mode flag captured at `lock_start` into room state; replay uses
  the room's flag, never a client-supplied one.

## Testing

- `records.js`: unit tests — insert into empty/partial/full list, sort order, trim to 8,
  tie handling (stable: earlier record keeps rank).
- `auditPlayerBehavior` emoji-mode replay: test that a miss advances the target and the
  computed score matches a hand-built stream (extract or test via a small harness).
- UI features (sound, JT mode, emoji skin, results table): manual verification in browser.

## Build Order & Commits

| # | Feature | Touches |
|---|---------|---------|
| 1 | Sound effects | client |
| 2 | Score log | server + client |
| 3 | JT mode | client |
| 4 | Emoji mode | server + client |
| 5 | Leaderboard | server + new module + new page + tests |
