# ApexPulse — Team Mode + Tie-Break Wheel

**Date:** 2026-06-06
**Status:** Approved design, pre-implementation

## Goal

Add an optional team mode. When the host creates/opens a room they can enable
team mode. Players then pick one of two teams. Final win/loss is decided by the
sum of each team's player scores. When the two teams have unequal player counts,
the host may resolve the match with a weighted "lucky wheel" instead of raw
totals; the wheel's slices are sized by each team's total score, so the
higher-scoring team is more likely (but not certain) to win.

## Non-Goals

- More than 2 teams (max 2: Team A / Team B).
- Changing per-player gameplay, ring scoring, or replay anti-cheat.
- Persistent accounts, team names beyond A/B, or re-balancing mid-match.

## Data Model (server, in-memory `rooms[roomId]`)

- `room.teamMode: boolean` — default `false`.
- `player.team: 'A' | 'B' | null` — `null` until the player picks (team mode only).

No other persistence. State lives only for the room's lifetime, same as today.

## Lobby Flow

1. First joiner of a room URL is the host (unchanged).
2. **Host-only Team Mode toggle** appears in the lobby overlay, before lock.
   - Toggling emits `set_team_mode { roomId, enabled }` (host-only, lobby-only).
   - Server sets `room.teamMode`, clears every `player.team`, broadcasts
     `room_config { teamMode }` + `room_update`.
3. When team mode is on, **all players** see a Team A / Team B picker.
   - Selecting emits `select_team { roomId, team }` (any player, lobby/ready
     only). Server sets `player.team`, broadcasts `room_update`. Players may
     switch freely until lock.
4. **Lock & Start** (`lock_start`):
   - If `teamMode`, validate **each team has >= 1 player**. If not, reject with
     `lock_denied { reason }` and the host sees an inline message; the window
     does not open.
   - Otherwise proceed exactly as today (seed, window, per-player runs).

## Match (unchanged)

- Each player runs their own 30s aim run; ring scoring + server replay
  verification as already implemented.
- **Team total** = sum of member `score` values. A banned/cheater player
  contributes 0 (their score is already forced to 0 server-side).

## Settlement (`match_over`)

`match_over` payload gains, in team mode:
`{ teamMode, teams: { A: {players, total, count}, B: {...} }, outcome }`

where `outcome` is computed server-side:

```
non-team mode      -> existing per-player leaderboard, no change
team mode:
  equal counts            -> winner = higher total; equal totals => "DRAW"
  unequal counts:
    one team 0, other > 0 -> winner = the > 0 team (auto, NO wheel button)
    both totals > 0       -> outcome = "WHEEL_ELIGIBLE" (weighted)
    both totals == 0      -> outcome = "WHEEL_ELIGIBLE" (50/50)
```

When `outcome === "WHEEL_ELIGIBLE"`, the host sees two buttons:
`[🎡 Spin Wheel]` and `[Decide by Total Score]`. Non-hosts see a waiting
message. Choosing "Decide by Total Score" resolves immediately to the
higher-total team (equal-but-eligible only occurs when both are 0, in which case
this button is hidden — only the wheel makes sense, see edge cases).

## Tie-Break Wheel (server-authoritative)

1. Host clicks Spin Wheel -> `spin_wheel { roomId }` (host-only, only valid when
   `outcome === "WHEEL_ELIGIBLE"`; ignored otherwise / if already spun).
2. **Server** computes the result so every client agrees:
   - `weightA = totalA`, `weightB = totalB`. If both are 0, use `1` and `1`
     (50/50).
   - `sliceA = weightA / (weightA + weightB)` (fraction of the wheel, 0..1),
     `sliceB = 1 - sliceA`.
   - `winner` = weighted random pick using those fractions.
   - `landAngle` = an angle (degrees) that falls inside the winner's arc, so the
     animation visibly stops on the winner.
3. Server broadcasts `wheel_result { sliceA, sliceB, winner, landAngle }`.
4. **All clients** render the same wheel (two arcs sized by `sliceA`/`sliceB`,
   Team A and Team B colors) and animate a slow ease-out spin
   (several full turns, ~5s, decelerating) that stops at `landAngle`. After it
   settles, the winner banner shows.
5. The wheel result is final; the server records the winning team.

The wheel can only be spun once per match. After it resolves, the room behaves
like any finished match (host can reset / play again).

## Edge Cases

- **Sizes equal, both totals 0:** equal-count path -> totals tie -> "DRAW". No
  wheel (wheel is only for unequal counts).
- **Sizes unequal, one 0 / one > 0:** auto-win for the non-zero team, no button.
- **Sizes unequal, both 0:** wheel eligible, 50/50; "Decide by Total Score"
  button hidden (totals tie), only the wheel button is shown.
- **Host disconnects after match:** host migrates to next player (existing
  `host_changed`); the new host gets the spin/decide controls.
- **Team mode off:** entire team UI and wheel are absent; behavior identical to
  today.

## New / Changed Socket Events

| Event | Dir | Payload | Notes |
|-------|-----|---------|-------|
| `set_team_mode` | C->S | `{ roomId, enabled }` | host, lobby only |
| `room_config` | S->C | `{ teamMode }` | broadcast on change + on join |
| `select_team` | C->S | `{ roomId, team }` | any player, lobby/ready |
| `lock_denied` | S->C | `{ reason }` | team validation failed |
| `spin_wheel` | C->S | `{ roomId }` | host, WHEEL_ELIGIBLE only |
| `decide_by_score` | C->S | `{ roomId }` | host, WHEEL_ELIGIBLE only |
| `wheel_result` | S->C | `{ sliceA, sliceB, winner, landAngle }` | broadcast |
| `match_over` | S->C | + `{ teamMode, teams, outcome }` | extended |
| `room_update` | S->C | players now include `team` | extended |

## Client UI Additions

- Lobby: host Team Mode toggle; per-player Team A / Team B picker (when on).
- Leaderboard: in team mode, group players under Team A / Team B with each
  team's running total.
- Results: team totals + winner/draw banner; host wheel controls when eligible;
  full-canvas (or overlay) lucky wheel with slow ease-out animation.

## Testing

- Unit-style (node): `outcome` computation for every branch in the settlement
  table; weighted winner distribution roughly matches slice fractions over many
  trials; `landAngle` always lands inside the winner's arc.
- Manual (browser, chrome-devtools): create team room, two clients pick teams,
  unequal counts, run, verify wheel appears for host only, spins, all clients
  see same winner; verify equal counts decide by total; verify the one-zero
  auto-win path skips the button.
