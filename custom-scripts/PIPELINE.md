# 2026 Franchise Pipeline

Single-command, repeatable update of a Madden 26 franchise save.

**Expected save state: Pre-Season Week 1.** Post-draft, post-cuts, before regular-season Week 1. Madden's fictional 2026 rookies are already on rosters with auto-generated contracts — the pipeline replaces them in-slot with real prospects.

What it produces:
1. Veterans on their real 2026 teams with real contracts (from nflverse).
2. 2026 draft pick ownership reflects real-life trades (no-op at Pre-Season Week 1 since picks are already drafted, but preserved for re-running on earlier saves).
3. All 257 drafted rookies replace Madden's fictional rookies *in slot* — same team, same rookie contract Madden assigned, but real names + Madden ratings generated from NFL.com Lance Zierlein scouting profiles.
4. Madden's fictional UDFA pool (~150-300 generated 2026 rookies who didn't get drafted) is purged.
5. (optional) Vet rating overlay from any Madden source roster file.

## One-shot run

```bash
node custom-scripts/runFullPipeline.mjs \
    --franchise "C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-FRANCHISE" \
    [--output  "C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-2026"] \
    [--source  "C:/path/to/MaddenRoster"]
```

`--output` writes a copy and leaves the source save untouched. Without `--output` the source is modified in place (a `.bak` is automatically made).

`--source` is optional — when given, step 4 overlays vet ratings from that Madden roster/franchise file. Skip if your franchise already has acceptable vet ratings.

## Data files (pre-fetched, regenerate as needed)

All under `C:/Users/benja/repos/madden-draft-class-generator/data/`:

| File | Producer | Refresh frequency |
|---|---|---|
| `current_rosters.json` | `python scripts/10_fetch_current_rosters.py` | Whenever NFL transactions move |
| `prospects_2026.json` | `python scripts/4d_fetch_nfl_prospects.py` | Daily during draft, then settled |
| `nfl_team_id_to_abbr.json` | `python scripts/4e_fetch_team_mapping.py` | Once per season |
| `prospects_rated.json` | `python scripts/5_generate_ratings.py` | After any prospects_2026 change (~30 min on RTX 5070) |

`draftOrder2026.json` is hand-curated and lives in this repo at `custom-scripts/roster/draftOrder2026.json`.

## What each step does

### 1. `applyRosters.mjs`
Reads `current_rosters.json` and walks the franchise's Player table. For every non-Draft player matching by normalized name, sets `TeamIndex`, `ContractStatus`, and the 8-slot per-year `ContractSalary{0..7}` / `ContractBonus{0..7}` fields. Then rebuilds each team's `Roster` array so depth charts reflect the new assignments.

### 2. `applyDraftOrder.mjs`
Walks the YearOffset=0 `DraftPick` records and sets `CurrentTeam` / `OriginalTeam` per the 2026 draft order. Skips picks already drafted (where `SelectedPlayer` is set).

### 3. `addDraftedRookies.mjs`
**Slot-based replace, not name-based add.**

Walks every Y=0 `DraftPick` record where `SelectedPlayer` is set (i.e., the pick has been drafted in-game). For each one:
- Decodes the player ref → finds the fictional rookie's Player record.
- Looks up our real prospect by `actual_draft_pick`.
- Stamps identity (name, position, height, weight) and all 56 rating fields onto that record.
- **Preserves** Madden's TeamIndex, ContractStatus, ContractSalary/Bonus slots, and the existing DraftPick.SelectedPlayer link — so the rookie stays on the same team with the rookie contract Madden already wrote.

Then: **purge sweep.** Any other Player record with `YearDrafted=2026` and `YearsPro=0` whose name doesn't match a real prospect is emptied (this clears Madden's fictional UDFA pool — typically 150-300 records).

Undrafted real prospects (~165) are also not added — they stay out of the franchise. Rationale: we don't have UDFA-signing data, and Madden's auto-UDFA pool produces fictional players we just cleared.

Pass `--no-purge` to keep Madden's fictional UDFAs.

### 4. `applyRatings.mjs` *(optional)*
Vet rating overlay from a separate Madden source. Skips Draft players (rookies are already handled above).

## When to refresh vs. just re-run

- **Real-life trades / FA moves** → re-run `10_fetch_current_rosters.py`, then re-run pipeline.
- **NFL.com scouting reports updated** (rare post-draft) → re-run `4d_fetch_nfl_prospects.py` then `5_generate_ratings.py`, then pipeline.
- **Different franchise file** → just point `--franchise` at it; data files are reusable.
- **Want different rookie ratings** → tune `5_generate_ratings.py` (model, prompt rules, calibration), then re-run pipeline.

## Sanity checks after running

In Madden:
- Browse a top R1 pick (Mendoza → Raiders, Bailey → Jets, etc.) — confirm team, OVR ~78-80, dev = Star/XFactor.
- Browse the team's salary cap — rookies stay on Madden's auto-assigned slot money (no cap shock from re-running).
- Open the in-game Draft Recap — every pick should now show real names instead of fictional rookies.
- Free Agency screen — should be vet-only, no fictional 2026 rookies.

## Edge cases

- **Re-running on the same save**: idempotent — slots get re-stamped with the same data, the purge sweep finds nothing new because UDFAs were already cleared on first run.
- **Pre-draft save by mistake**: the `--no-purge` script bails early with `dpDrafted == 0` (no draft picks have a SelectedPlayer set yet). Use `importDraftClass.mjs` for that scenario instead.
- **Mid-season save**: same Y=0 DraftPick state as Pre-Season Week 1, so it works — but vet contracts may be mid-year and `applyRosters` could overwrite an already-correct state. Prefer Pre-Season Week 1.
