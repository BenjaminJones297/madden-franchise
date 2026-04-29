# 2026 Franchise Pipeline — Full End-to-End

Repeatable process to update any Madden 26 franchise at Pre-Season Week 1 of the 2026 season with:
1. Veterans on real 2026 teams + real contracts (from nflverse).
2. 2026 draft pick ownership reflecting real-life trades.
3. All 257 drafted rookies on their drafting team with real names + ratings derived from M26 calibration data + Lance Zierlein scouting profiles + actual combine measurements.
4. Per-rookie archetype (`PlayerType`) optimized so Madden's per-archetype OVR recompute lands at the player's best-fitting archetype value.

## Prerequisites

**One-time:**
- Python 3.10+ with packages from `requirements.txt` (a venv at `.venv/` works)
- Node 18+
- Both repos cloned: `madden-draft-class-generator/` and `madden-franchise/`
- A Madden 26 franchise save at **Pre-Season Week 1** (post-draft, post-cuts, before regular-season start)

**Pre-fetched data files (already committed to the draft-class-generator repo):**

| File | Source | Notes |
|---|---|---|
| `data/prospects_2026.json` | NFL.com API (`scripts/4d_fetch_nfl_prospects.py`) | All 422 prospects + measurables + actual draft picks/teams |
| `data/prospects_rated.json` | `scripts/5_generate_ratings.py` | Statistical-baseline-derived M26 ratings |
| `data/calibration_set.json` | M26 launch draft class binary (`scripts/2_extract_calibration.js`) | 2025 rookies + their actual M26 launch ratings — the ground-truth centroid source |
| `data/prospect_profiles.json` | NFL.com API (Lance Zierlein) | Strengths/weaknesses/NFL-comp per prospect |
| `data/current_rosters.json` | nflverse + 2026 FA moves (`scripts/10_fetch_current_rosters.py`) | Real 2026 NFL rosters + contracts |
| `data/nfl_team_id_to_abbr.json` | NFL.com teams API (`scripts/4e_fetch_team_mapping.py`) | UUID → Madden team abbr |
| `custom-scripts/roster/draftOrder2026.json` | Hand-curated from ESPN | Real 2026 draft pick ownership |

If any of these are stale, see the **Refresh data** section below.

## The Pipeline

### Step 1 — Run the franchise pipeline

Single command. Reads the data files, writes a new franchise file:

```powershell
node custom-scripts/runFullPipeline.mjs `
  --franchise "C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-UPDATED-ROSTER-AUTOSAVE" `
  --output    "C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-final-step1" `
  --no-source
```

(Drop `--no-source` to also overlay vet ratings from a Madden roster — defaults to `CAREER-OFFICIAL`.)

**What this does (~1 second):**
1. **applyRosters** — sets vet `TeamIndex` + 8-slot contract fields from `current_rosters.json`. Rebuilds per-team Roster arrays.
2. **applyDraftOrder** — writes 2026 pick ownership to `DraftPick` Y=0 records (no-op for already-drafted picks).
3. **addDraftedRookies** — Phase 1 (name match) → preserve ratings, just fix team/slot. Phase 2 (slot stamp) → overwrite fictional rookies' attributes/identity. Phase 3 (purge) → retire leftover fictional UDFAs. Empty-slot fallback uses a "donor template" (College/CharacterVisuals/PLYR_ASSETNAME refs from a valid donor record) so no malformed records.
4. **applyRatings** *(if --source given)* — overlay vet ratings from a Madden source roster.

### Step 2 — Open in Madden and advance one week

This forces Madden to recompute `OverallGrade0..4` per archetype from the attributes we wrote, and saves them back to disk.

1. Launch Madden 26
2. Load the franchise file produced in Step 1
3. **Advance one week** (Pre-Season Wk 1 → Wk 2)
4. Exit (Madden auto-saves to `<filename>-AUTOSAVE`)

### Step 3 — Run archetype optimizer

```powershell
node custom-scripts/roster/fixArchetypes.mjs `
  --franchise "C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-final-step1-AUTOSAVE" `
  --output    "C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-final"
```

**What this does (~5 seconds):**
1. Phase A — scans every Player record. For records where `OverallRating` matches exactly one of the five `OverallGrade*` slots, infers `(Position, PlayerType) → slot`.
2. Phase B — derives `(Position, slot) → archetype_name` mapping from observed M26 data.
3. Phase C — for each rookie, finds `argmax(OG[0..4])`. Looks up the archetype for `(Position, max_slot)`. Sets `PlayerType` accordingly. Updates `OverallRating` to `max(OG)` so all fields agree.

This guarantees each rookie's displayed in-game OVR is their best archetype's score, not their worst.

### Step 4 — Open in Madden + advance once more

The optimizer changed some PlayerTypes. Madden re-evaluates with the new archetypes on the next load.

1. Open `CAREER-final` in Madden
2. Advance one week
3. Done — every rookie is at their optimal archetype OVR

## Verification

To inspect the final state before/after each Madden recompute:

```powershell
node custom-scripts/extractRookieRatings.mjs `
  --franchise "C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-final" `
  --output    "C:/Users/benja/repos/madden-draft-class-generator/data/rookie_ratings_final.json"
```

Outputs JSON with `OverallRating`, `OverallGrade0..4`, `PlayerType`, position, draft slot, key attributes per rookie. Sorted by (round, pick).

The script also prints per-round summaries — easy way to spot tier-distribution problems.

## Refresh data (if needed)

Only required if NFL.com prospect grades change, post-draft trades happen, or you want to update vet ratings.

```powershell
# Refresh prospect profiles + measurables + draft picks from NFL.com API
.venv/Scripts/python.exe scripts/4d_fetch_nfl_prospects.py

# Re-run rating generator (statistical baseline; ~5 seconds, no LLM needed)
.venv/Scripts/python.exe scripts/5_generate_ratings.py --no-prior-clamp

# Refresh nflverse vet rosters (only when NFL transactions move)
.venv/Scripts/python.exe scripts/10_fetch_current_rosters.py
```

The team-mapping (`4e_fetch_team_mapping.py`) is one-time per season.

## Algorithmic summary — what's in `prospects_rated.json`

The rating generator (`scripts/5_generate_ratings.py`) replaces the original LLM-based pipeline with a **nearest-neighbor centroid** from M26 calibration data, plus targeted post-processing layers:

1. **Centroid** — for each prospect, find k=5 nearest 2025 rookies (similarity weighted: pick 35% / weight 25% / forty 25% / height 15%). Take the similarity-weighted mean of their attributes.
2. **Variance-weighted regression** — for high-variance attributes (where individual prospects differ), pull the centroid partially toward the position mean, leaving room for individual signals (profile keywords, combine measurements) to drive the value.
3. **Position-specific corrections** — caps DL stats on OL records, floors WR speed by 40-time, floors CB tackle/hitPower/pursuit (run-defense stats are real CB stats), etc.
4. **Combine corrections** — `_anchor()` clamps speed/strength/agility/jumping to within ±band of expected values from real combine measurements (40-yard, bench, vertical, cone, shuttle).
5. **Profile-keyword bumps** — scans Lance Zierlein's scouting prose for ~70 position-specific phrases ("press corner", "tackler", "elusive", "field general", etc.) and bumps matching attributes upward.
6. **Per-position dampener** — subtracts 1-2 from key fields for over-rated positions (CB, DE, FS, T, etc. — calibrated against the 2025 round means).
7. **Top-pick AWR floor** — pick-tier-based floor on awareness + smart stats (PlayRecognition, ThrowUnderPressure, PlayAction). Pick 1-3 QB needs AWR ≥ 82 to register correctly in QB_FieldGeneral formula.
8. **Late-pick dampener** — picks 181+ get -1 to -2 on key fields so Madden's recompute on inflated late-round attributes doesn't push OVR above tier band.
9. **Dev trait by pick** — pick 1 → XFactor (College_Elite); picks 2-12 → Star; picks 13-32 → Impact; tail → Normal.
10. **Compute OVR** — tier-anchored regression (anchor's actual M26 rating + dampened delta from key-field average).

Each layer is a standalone function in `scripts/5_generate_ratings.py` — easy to tune one without touching the others.

## Edge cases

- **Re-running on the same save**: idempotent. Slots get re-stamped with the same data; the purge sweep finds nothing new.
- **Pre-draft save by mistake**: addDraftedRookies bails early with `dpDrafted == 0`. Use `importDraftClass.mjs` for that scenario instead.
- **Mid-season save**: Y=0 DraftPick state is the same so it works, but vet contracts will be mid-year and `applyRosters` may overwrite an already-correct state. Prefer Pre-Season Week 1.
- **Empty-slot rookies**: ~23 prospects don't fit into Madden's auto-generated rookie pool (Madden generates 234, real draft has 257). The donor template handles College/Visuals/PLYR_ASSETNAME refs so they render correctly.
- **Byron Murphy Jr (and similar)**: some real NFL vets aren't in Madden's roster export — not a pipeline issue.
