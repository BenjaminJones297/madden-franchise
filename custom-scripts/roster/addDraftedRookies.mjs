/**
 * addDraftedRookies.mjs
 *
 * Replaces Madden's auto-generated 2026 rookie class with the real one.
 *
 * Designed to run on a Pre-Season Week 1 franchise save where Madden has
 * already simulated the 2026 NFL Draft with fictional rookies. Operates
 * slot-by-slot via the DraftPick table:
 *
 *   For each Y=0 DraftPick that has SelectedPlayer set (i.e., was drafted):
 *     - Resolve the player ref to the fictional rookie's Player record.
 *     - Look up our real prospect by (round, overall-pick).
 *     - Stamp identity (name/position/height/weight), ratings, dev trait,
 *       jersey-back-to-zero, etc. into that same record.
 *     - Madden's TeamIndex, ContractStatus, contract slot money, and
 *       DraftPick.SelectedPlayer link are preserved as-is.
 *
 * Purge sweep: any other Player record with YearDrafted=2026, YearsPro=0
 * (i.e., the rest of Madden's fictional class — undrafted UDFAs cluttering
 * free agency) is emptied.
 *
 * Idempotent: re-running stamps the same prospects onto the same rows.
 *
 * Pre-fetched data files consumed (in <data>/):
 *   - prospects_rated.json      ← script 5: 422 prospects with ratings
 *   - nfl_team_id_to_abbr.json  ← script 4e: team UUID → Madden abbr (for warning only)
 *
 * Usage:
 *   node addDraftedRookies.mjs --franchise <path> [--data <dir>] [--output <path>] [--no-purge]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import FranchiseFile from '../../src/FranchiseFile.js';

// ── Default paths ────────────────────────────────────────────────────────────
export const FRANCHISE_PATH =
    'C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-FRANCHISE';

const DEFAULT_DATA_DIR =
    'C:/Users/benja/repos/madden-draft-class-generator/data';

// ── Madden TraitDevelopment is an enum: 0=Normal, 1=College_Impact,
//    2=College_Star, 3=College_X-Factor.  The library accepts the string form
//    reliably across all field-version variants; the integer form sometimes
//    silently no-ops.
const DEV_TRAIT_TO_STRING = {
    0: 'Normal',
    1: 'College_Impact',
    2: 'College_Star',
    3: 'College_Elite',  // M26's XFactor-equivalent enum name
};

// ── Madden team-abbreviation → TeamIndex (0-31).  Same mapping used by
//    applyRosters.mjs / applyDraftOrder.mjs — kept in sync deliberately. ───
const TEAM_INDEX = {
    CHI:  0,  CIN:  1,  BUF:  2,  DEN:  3,  CLE:  4,  TB:   5,
    ARI:  6,  LAC:  7,  KC:   8,  IND:  9,  DAL: 10,  MIA: 11,
    PHI: 12,  ATL: 13,  SF:  14,  NYG: 15,  JAX: 16,  NYJ: 17,
    DET: 18,  GB:  19,  CAR: 20,  NE:  21,  LV:  22,  LA:  23,
    BAL: 24,  WAS: 25,  NO:  26,  SEA: 27,  PIT: 28,  TEN: 29,
    MIN: 30,  HOU: 31,
    AZ:   6,  LAR: 23,
};

// ── Internal rating field → Madden 26 Player table field ─────────────────────
// NOTE: M26 uses these specific spellings (verified against the schema):
//   BCVisionRating (not BallCarrierVisionRating)
//   PressRating (not PressCoverageRating)
//   FinesseMovesRating (plural; not FinesseMoveRating)
//   ImpactBlockingRating (not ImpactBlockRating)
//   MoraleRating doesn't exist — Madden 26 renamed it; we drop it.
const RATING_FIELD_MAP = {
    overall:                 'OverallRating',
    speed:                   'SpeedRating',
    acceleration:            'AccelerationRating',
    agility:                 'AgilityRating',
    strength:                'StrengthRating',
    awareness:               'AwarenessRating',
    throwPower:              'ThrowPowerRating',
    throwAccuracy:           'ThrowAccuracyRating',
    throwAccuracyShort:      'ThrowAccuracyShortRating',
    throwAccuracyMid:        'ThrowAccuracyMidRating',
    throwAccuracyDeep:       'ThrowAccuracyDeepRating',
    throwOnTheRun:           'ThrowOnTheRunRating',
    throwUnderPressure:      'ThrowUnderPressureRating',
    playAction:              'PlayActionRating',
    breakSack:               'BreakSackRating',
    tackle:                  'TackleRating',
    hitPower:                'HitPowerRating',
    blockShedding:           'BlockSheddingRating',
    finesseMoves:            'FinesseMovesRating',
    powerMoves:              'PowerMovesRating',
    pursuit:                 'PursuitRating',
    zoneCoverage:            'ZoneCoverageRating',
    manCoverage:             'ManCoverageRating',
    pressCoverage:           'PressRating',
    playRecognition:         'PlayRecognitionRating',
    jumping:                 'JumpingRating',
    catching:                'CatchingRating',
    catchInTraffic:          'CatchInTrafficRating',
    spectacularCatch:        'SpectacularCatchRating',
    shortRouteRunning:       'ShortRouteRunningRating',
    mediumRouteRunning:      'MediumRouteRunningRating',
    deepRouteRunning:        'DeepRouteRunningRating',
    release:                 'ReleaseRating',
    runBlock:                'RunBlockRating',
    passBlock:               'PassBlockRating',
    runBlockPower:           'RunBlockPowerRating',
    runBlockFinesse:         'RunBlockFinesseRating',
    passBlockPower:          'PassBlockPowerRating',
    passBlockFinesse:        'PassBlockFinesseRating',
    impactBlocking:          'ImpactBlockingRating',
    leadBlock:               'LeadBlockRating',
    jukeMove:                'JukeMoveRating',
    spinMove:                'SpinMoveRating',
    stiffArm:                'StiffArmRating',
    trucking:                'TruckingRating',
    breakTackle:             'BreakTackleRating',
    ballCarrierVision:       'BCVisionRating',
    changeOfDirection:       'ChangeOfDirectionRating',
    carrying:                'CarryingRating',
    kickPower:               'KickPowerRating',
    kickAccuracy:            'KickAccuracyRating',
    kickReturn:              'KickReturnRating',
    stamina:                 'StaminaRating',
    toughness:               'ToughnessRating',
    injury:                  'InjuryRating',
    devTrait:                'TraitDevelopment',
};

// Identity fields we overwrite (only when we have a real prospect for the slot).
const IDENTITY_FIELDS = ['FirstName', 'LastName', 'Position'];

// Internal pos code → preferred Madden position string.  Madden's enum accepts
// LT/RT/LG/RG/LE/RE etc.; we leave the existing string in place when the enum
// rejects our preferred form.
const POSITION_MAP = {
    HB: 'HB', RB: 'HB',  FB: 'FB',  QB: 'QB',  WR: 'WR',  TE: 'TE',
    T:  'LT', G:  'LG',  C:  'C',
    DE: 'LE', DT: 'DT',
    OLB:'LOLB', MLB:'MLB',
    CB: 'CB', FS: 'FS', SS: 'SS',
    K:  'K',  P:  'P',  LS: 'LS',
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const NULL_REF = '0'.repeat(32);

function decodeRef(bin) {
    if (!bin || bin === NULL_REF) return null;
    return {
        tableId: parseInt(bin.slice(0, 15), 2),
        row:     parseInt(bin.slice(15), 2),
    };
}

function getArg(argv, flag) {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

function parseHeight(ht) {
    if (typeof ht === 'number') return Math.round(ht);
    if (!ht) return 72;
    const m = String(ht).match(/^(\d+)[-'](\d+)/);
    return m ? parseInt(m[1]) * 12 + parseInt(m[2]) : 72;
}

function norm(name) {
    return (name || '')
        .toLowerCase()
        .replace(/\s+(ii|iii|iv|v|jr|sr)\.?$/i, '')
        .replace(/[^a-z]/g, '');
}

// ── Main ─────────────────────────────────────────────────────────────────────
export async function addDraftedRookies(franchisePath, dataDir, outputPath, opts = {}) {
    const { skipPurge = false } = opts;

    const resolvedSrc = path.resolve(franchisePath);
    if (!fs.existsSync(resolvedSrc)) {
        console.error(`Franchise file not found: ${resolvedSrc}`);
        process.exit(1);
    }
    const resolvedDst = outputPath ? path.resolve(outputPath) : resolvedSrc;

    if (outputPath) {
        fs.copyFileSync(resolvedSrc, resolvedDst);
        console.log(`Source : ${resolvedSrc}`);
        console.log(`Output : ${resolvedDst}`);
    } else {
        fs.copyFileSync(resolvedSrc, resolvedSrc + '.bak');
        console.log(`Backup : ${resolvedSrc}.bak`);
    }

    const ratedPath   = path.join(dataDir, 'prospects_rated.json');
    const teamMapPath = path.join(dataDir, 'nfl_team_id_to_abbr.json');
    if (!fs.existsSync(ratedPath))   { console.error(`Missing: ${ratedPath}`);   process.exit(1); }
    if (!fs.existsSync(teamMapPath)) { console.error(`Missing: ${teamMapPath}`); process.exit(1); }

    const prospects = JSON.parse(fs.readFileSync(ratedPath, 'utf8'));
    const teamMap   = JSON.parse(fs.readFileSync(teamMapPath, 'utf8'));
    const drafted = prospects.filter(p => p.actual_draft_pick);
    console.log(`Prospects loaded: ${prospects.length}, drafted: ${drafted.length}`);

    // Index by overall pick (1..257).
    const prospectByPick = new Map();
    for (const p of drafted) {
        prospectByPick.set(p.actual_draft_pick, p);
    }

    // Names of all real prospects (drafted + undrafted) — used by the purge
    // sweep to leave any future-rookie record alone if its name happens to
    // already match (e.g., a user manually added someone in between).
    const realNameSet = new Set(
        prospects.map(p => norm(p.name || `${p.firstName} ${p.lastName}`))
    );

    const file = await FranchiseFile.create(resolvedDst, { autoUnempty: true });

    const playerTable = file.getTableByName('Player');
    // Read ALL fields so we can write the Original*Rating mirror counterparts
    // (used by Madden's in-game OVR computation) without listing each one.
    await playerTable.readRecords();
    const playerTableId = playerTable.header.tableId;
    console.log(`Player table   : ${playerTable.records.length} rows ` +
                `(${playerTable.records.filter(r => !r.isEmpty).length} non-empty)`);

    // ── Find Madden's fictional 2026 rookies via player-record draft fields ──
    // YearsPro=0 + ContractStatus='Signed' + PLYR_DRAFTPICK>0 is a reliable
    // marker. PLYR_DRAFTROUND=63 is Madden's compensatory-pick sentinel.
    const fictionalRookies = [];
    for (let i = 0; i < playerTable.records.length; i++) {
        const r = playerTable.records[i];
        if (r.isEmpty) continue;
        if (r.YearsPro !== 0 || r.ContractStatus !== 'Signed') continue;
        if (!r.PLYR_DRAFTPICK || r.PLYR_DRAFTPICK <= 0) continue;
        fictionalRookies.push({
            row:   i,
            round: r.PLYR_DRAFTROUND,
            pick:  r.PLYR_DRAFTPICK,
            name:  `${r.FirstName} ${r.LastName}`,
        });
    }
    const roundCounts = fictionalRookies.reduce((m, f) => {
        m[f.round] = (m[f.round] || 0) + 1; return m;
    }, {});
    console.log(`Fictional rookies : ${fictionalRookies.length}  by round: ${JSON.stringify(roundCounts)}`);

    if (fictionalRookies.length === 0) {
        console.error('\nNo fictional 2026 rookies found.');
        console.error('Expected players with YearsPro=0, Signed, PLYR_DRAFTPICK > 0.');
        process.exit(1);
    }

    // ── Build the matching plan: per-round, zip our prospects to fictional rookies ──
    // For each round, sort fictionals by PLYR_DRAFTPICK and our prospects by
    // actual_draft_pick (overall), then pair them by within-round position.
    const fictionalsByRound = new Map();
    for (const f of fictionalRookies) {
        if (!fictionalsByRound.has(f.round)) fictionalsByRound.set(f.round, []);
        fictionalsByRound.get(f.round).push(f);
    }
    for (const list of fictionalsByRound.values()) {
        list.sort((a, b) => a.pick - b.pick);
    }
    const prospectsByRound = new Map();
    for (const p of drafted) {
        const rd = p.actual_draft_round || 1;
        if (!prospectsByRound.has(rd)) prospectsByRound.set(rd, []);
        prospectsByRound.get(rd).push(p);
    }
    for (const list of prospectsByRound.values()) {
        list.sort((a, b) => a.actual_draft_pick - b.actual_draft_pick);
    }

    // Build the pair list: (fictional rookie row, real prospect)
    const draftLinks = [];   // { round, posInRound, overallPick, playerRow, prospect }
    let unmatchedFictionals = 0;
    let unmatchedProspects  = 0;
    for (const [round, ficList] of fictionalsByRound.entries()) {
        const proList = prospectsByRound.get(round) || [];
        const n = Math.min(ficList.length, proList.length);
        for (let i = 0; i < n; i++) {
            draftLinks.push({
                round,
                posInRound: i + 1,
                overallPick: proList[i].actual_draft_pick,
                playerRow:   ficList[i].row,
                prospect:    proList[i],
            });
        }
        unmatchedFictionals += Math.max(0, ficList.length - proList.length);
        unmatchedProspects  += Math.max(0, proList.length - ficList.length);
    }
    console.log(`Slot pairs to stamp : ${draftLinks.length}`);
    if (unmatchedFictionals) console.log(`  WARN: ${unmatchedFictionals} fictional rookies have no real prospect for their round`);
    if (unmatchedProspects)  console.log(`  WARN: ${unmatchedProspects} real prospects have no Madden slot in their round`);

    // ── Stamp real prospects onto the fictional rookies' rows ────────────────
    const stampedRows = new Set();
    let stamped = 0, missingProspect = 0, errors = 0;
    const log = [];

    for (const link of draftLinks) {
        const prospect = link.prospect;
        const rec = playerTable.records[link.playerRow];
        if (!rec || rec.isEmpty) {
            errors++;
            log.push(`  X  pick ${link.overallPick}: row ${link.playerRow} empty/missing`);
            continue;
        }

        const fullName = prospect.name
            || `${prospect.firstName} ${prospect.lastName}`.trim();
        const oldName  = `${rec.FirstName} ${rec.LastName}`.trim();

        // Resolve real drafting team — required for the team swap.
        const teamAbbr = teamMap[prospect.draftTeamId || ''] || null;
        const teamIdx  = teamAbbr !== null ? TEAM_INDEX[teamAbbr] : undefined;

        try {
            // Identity. Madden's FirstName is an enum-restricted field — many
            // first names map to a "canonical" form (Max -> Maxwell, etc.) or
            // even an unrelated name when the requested string isn't in the
            // enum dictionary. Try the requested name; the library will pick
            // the closest valid enum entry. LastName is free-form text.
            try { rec.FirstName = (prospect.firstName || fullName.split(' ')[0] || 'Unknown').slice(0, 17); } catch {}
            try { rec.LastName  = (prospect.lastName  || fullName.split(' ').slice(1).join(' ') || 'Player').slice(0, 21); } catch {}

            // Position — try preferred Madden form, fall back to current
            const preferred = POSITION_MAP[(prospect.pos || '').toUpperCase()];
            if (preferred) {
                try { rec.Position = preferred; } catch { /* enum may reject specific letter form */ }
            }

            // Physicals. Madden stores Weight as `actualLbs - 160`
            // (Mahomes 225lbs -> stored 65, Tyreek Hill 191 -> 31, Lamar 210 -> 50).
            try { rec.Height = parseHeight(prospect.ht); } catch {}
            try {
                const lbs    = Math.round(prospect.wt) || (rec.Weight + 160);
                rec.Weight   = Math.max(0, Math.min(255, lbs - 160));
            } catch {}

            // Team assignment — use the REAL drafting team, not whoever Madden
            // assigned this slot to. Madden's AI re-creates a fictional draft
            // order, so without this swap a record stamped at "R1#1" would
            // sit on whatever team Madden's AI gave the first overall pick to.
            if (teamIdx !== undefined) {
                try { rec.TeamIndex = teamIdx; } catch {}
            }

            // YearsPro=0 just to be safe; preserve YearDrafted relative encoding.
            try { rec.YearsPro = 0; } catch {}

            // Ratings — overwrite every mapped field. devTrait is enum-string;
            // everything else is uint8 (0-99). Madden mirrors most ratings into
            // an `Original*Rating` slot used as the "rookie / baseline" anchor;
            // we write both so in-game OVR derivation matches our stored OVR.
            const ratings = prospect.ratings || {};
            for (const [src, dst] of Object.entries(RATING_FIELD_MAP)) {
                const v = ratings[src];
                if (v === undefined || v === null) continue;
                try {
                    if (dst === 'TraitDevelopment') {
                        const enumStr = DEV_TRAIT_TO_STRING[Math.max(0, Math.min(3, v))] || 'Normal';
                        rec[dst] = enumStr;
                    } else {
                        const clamped = Math.max(0, Math.min(99, Math.round(v)));
                        rec[dst] = clamped;
                        // Mirror to Original* counterpart when the schema has it.
                        const origField = 'Original' + dst;
                        try { rec[origField] = clamped; } catch { /* not all fields have Original* */ }
                    }
                } catch { /* ignore unwritable */ }
            }

            stampedRows.add(link.playerRow);
            stamped++;
            log.push(
                `  +  R${prospect.actual_draft_round} #${String(prospect.actual_draft_pick).padStart(3)}` +
                `  ${(teamAbbr || '?').padEnd(4)}  ${oldName.padEnd(26)} -> ${fullName.padEnd(26)} (${preferred || rec.Position})`
            );
        } catch (err) {
            errors++;
            log.push(`  X  pick ${link.overallPick} (${fullName}): ${err.message}`);
        }
    }

    console.log(`\nStamped         : ${stamped}`);
    console.log(`No matching prospect for slot : ${missingProspect}`);
    console.log(`Errors          : ${errors}`);

    // ── Purge fictional 2026 UDFAs / unstamped rookies ───────────────────────
    // YearsPro=0 + ContractStatus in {FreeAgent, Signed} that we DIDN'T stamp.
    // These are Madden's auto-generated UDFAs (FreeAgent) plus any drafted
    // fictional rookies whose round had more Madden picks than ours did
    // (e.g., compensatory picks Madden invented but we don't have data for).
    let purged = 0;
    if (!skipPurge) {
        for (let i = 0; i < playerTable.records.length; i++) {
            if (stampedRows.has(i)) continue;
            const rec = playerTable.records[i];
            if (rec.isEmpty) continue;
            if (rec.YearsPro !== 0) continue;
            const cs = rec.ContractStatus;
            if (cs !== 'FreeAgent' && cs !== 'Signed') continue;

            // Belt-and-suspenders: don't purge if the name matches a real prospect
            // (handles the rare case where Madden generated a rookie whose name
            // collides with a real one — unlikely but possible).
            const nm = norm(`${rec.FirstName} ${rec.LastName}`);
            if (realNameSet.has(nm)) continue;

            // Non-destructive purge: retire the player and detach from team.
            // Calling rec.empty() can leave dangling refs in PlayerStats /
            // other cross-table indexes that crash Madden on load. Setting
            // status='Retired' + TeamIndex=32 keeps the record valid while
            // removing the player from rosters and FA listings.
            try {
                rec.ContractStatus = 'Retired';
                rec.TeamIndex      = 32;
                try { rec.PLYR_DRAFTPICK  = 0; } catch {}
                try { rec.PLYR_DRAFTROUND = 0; } catch {}
                // Zero contract slots so there's no lingering cap impact.
                try { rec.ContractLength = 0; } catch {}
                for (let s = 0; s < 8; s++) {
                    try { rec[`ContractSalary${s}`] = 0; } catch {}
                    try { rec[`ContractBonus${s}`]  = 0; } catch {}
                }
                purged++;
            } catch {}
        }
        console.log(`Purged (retired) fictional rookies / UDFAs : ${purged}`);
    } else {
        console.log('Purge skipped (--no-purge set).');
    }

    if (log.length && log.length <= 60) log.forEach(l => console.log(l));
    else if (log.length) console.log(`(${log.length} stamp transactions)`);

    // ── Rebuild per-team Roster arrays so the new TeamIndexes show up in
    //    depth charts. Same logic as applyRosters.mjs's rebuildRosters().
    if (stamped > 0) {
        console.log('\nRebuilding per-team rosters...');
        const stats = await rebuildRosters(file, playerTable);
        console.log(`Rosters: rebuilt ${stats.teams} teams, ${stats.placed} players placed` +
                    (stats.overflow ? `, ${stats.overflow} overflow` : ''));
    }

    if (stamped > 0 || purged > 0) {
        console.log('\nSaving franchise file...');
        await file.save();
        console.log('Saved.');
    } else {
        console.log('\nNo changes made.');
    }
}

// ── Per-team Roster array rebuild ────────────────────────────────────────────
function makePlayerRef(playerTableId, rowIndex) {
    return playerTableId.toString(2).padStart(15, '0') + rowIndex.toString(2).padStart(17, '0');
}

async function rebuildRosters(file, playerTable) {
    const playerTableId = playerTable.header.tableId;

    const byTeam = new Map();
    for (let i = 0; i < playerTable.records.length; i++) {
        const rec = playerTable.records[i];
        if (rec.isEmpty) continue;
        const cs = rec.ContractStatus;
        if (cs === 'Draft' || cs === 'FreeAgent' || cs === 'Retired') continue;
        const tIdx = rec.TeamIndex;
        if (tIdx === undefined || tIdx === null || tIdx >= 32) continue;
        if (!byTeam.has(tIdx)) byTeam.set(tIdx, []);
        byTeam.get(tIdx).push(i);
    }

    let teamTable = null;
    for (const t of file.tables) {
        if (t.name === 'Team' && t.header.recordCapacity > 1) { teamTable = t; break; }
    }
    if (!teamTable) return { teams: 0, placed: 0, overflow: 0 };
    await teamTable.readRecords(['ShortName', 'TeamIndex', 'Roster']);

    const cache = new Map();
    let teams = 0, placed = 0, overflow = 0;
    for (const rec of teamTable.records) {
        if (rec.isEmpty) continue;
        const tIdx = rec.TeamIndex;
        if (tIdx === undefined || tIdx >= 32) continue;
        const ref = decodeRef(rec.Roster);
        if (!ref) continue;
        let rt = cache.get(ref.tableId);
        if (!rt) {
            rt = file.getTableById(ref.tableId);
            if (!rt) continue;
            await rt.readRecords();
            cache.set(ref.tableId, rt);
        }
        const rosterRow = rt.records[ref.row];
        if (!rosterRow) continue;
        const slotNames = rt.offsetTable
            .map(o => o.name)
            .filter(n => /^Player\d+$/.test(n))
            .sort((a, b) => parseInt(a.slice(6), 10) - parseInt(b.slice(6), 10));
        const slotCount = slotNames.length;
        const players = byTeam.get(tIdx) || [];
        const toWrite = players.slice(0, slotCount);
        if (players.length > slotCount) overflow += players.length - slotCount;
        for (let i = 0; i < slotCount; i++) {
            rosterRow[slotNames[i]] = i < toWrite.length
                ? makePlayerRef(playerTableId, toWrite[i])
                : NULL_REF;
        }
        teams++;
        placed += toWrite.length;
    }
    return { teams, placed, overflow };
}

// ── Standalone entry ─────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    const franchise = getArg(process.argv, '--franchise') || FRANCHISE_PATH;
    const dataDir   = getArg(process.argv, '--data')      || DEFAULT_DATA_DIR;
    const output    = getArg(process.argv, '--output')    || null;
    const skipPurge = process.argv.includes('--no-purge');
    await addDraftedRookies(franchise, dataDir, output, { skipPurge });
}
