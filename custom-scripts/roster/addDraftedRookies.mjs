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

// Group Madden positions to a coarse key for last+position fallback matching.
// Handles LT/RT/T being interchangeable, LE/RE/DE etc.
const POS_GROUP = {
    LT:'OL', RT:'OL', T:'OL', OT:'OL',
    LG:'OL', RG:'OL', G:'OL', OG:'OL', C:'OL', OL:'OL',
    LE:'EDGE', RE:'EDGE', DE:'EDGE', EDGE:'EDGE', LOLB:'EDGE', ROLB:'EDGE',
    DT:'DT', NT:'DT',
    MLB:'LB', LB:'LB',
    CB:'CB', DB:'CB',
    FS:'S', SS:'S', SAF:'S',
    QB:'QB', HB:'HB', RB:'HB', FB:'FB',
    WR:'WR', TE:'TE',
    K:'K', P:'P', LS:'LS',
};
function posGroup(p) { return POS_GROUP[(p || '').toUpperCase()] || (p || '').toUpperCase(); }

// First-name aliases — handles cases where Madden's name pool uses a player's
// preferred / nickname while NFL.com's API returns their legal name (or vice
// versa). Add new entries as you find mismatches.  All values are the
// CANONICAL form we collapse to.
const FIRST_NAME_CANONICAL = {
    // Standard nicknames
    pat: 'patrick', patrick: 'patrick',
    mike: 'michael', michael: 'michael', mikey: 'michael',
    chris: 'christopher', christopher: 'christopher',
    jon: 'jonathan', jonathan: 'jonathan', johnny: 'jonathan',
    matt: 'matthew', matthew: 'matthew',
    alex: 'alexander', alexander: 'alexander',
    rob: 'robert', bob: 'robert', robert: 'robert', bobby: 'robert',
    will: 'william', bill: 'william', william: 'william', billy: 'william',
    tim: 'timothy', timothy: 'timothy', timmy: 'timothy',
    tom: 'thomas', thomas: 'thomas', tommy: 'thomas',
    ben: 'benjamin', benjamin: 'benjamin', benny: 'benjamin',
    sam: 'samuel', samuel: 'samuel', sammy: 'samuel',
    steve: 'stephen', stephen: 'stephen', steven: 'stephen', stevie: 'stephen',
    joe: 'joseph', joseph: 'joseph', joey: 'joseph',
    dan: 'daniel', daniel: 'daniel', danny: 'daniel',
    nick: 'nicholas', nicholas: 'nicholas', nicky: 'nicholas',
    tony: 'anthony', anthony: 'anthony',
    drew: 'andrew', andy: 'andrew', andrew: 'andrew',
    rick: 'richard', rich: 'richard', richard: 'richard', ricky: 'richard',
    jim: 'james', jimmy: 'james', james: 'james',
    eli: 'elijah', elijah: 'elijah',
    max: 'maxwell', maxwell: 'maxwell', maxx: 'maxwell',
    // 2026-class aliases (NFL.com's legal name vs Madden's preferred name)
    sonny: 'alex',          // Sonny Styles -> Alex Styles
    kc:    'kevin',         // KC Concepcion -> Kevin Concepcion
    aj:    'adari',         // AJ Haulcy -> Adari Haulcy
    cj:    'christopher',   // CJ Allen -> Christian/Chris Allen
    tj:    'tomarrion',     // TJ Parker -> Tomarrion Parker
    dj:    'davison',       // DJ Igbinosun -> Davison Igbinosun (actually Aimuamwosa)
};

function canonFirst(s) {
    const k = (s || '').toLowerCase().replace(/[^a-z]/g, '');
    return FIRST_NAME_CANONICAL[k] || k;
}

function norm(name) {
    return (name || '')
        .toLowerCase()
        .replace(/\s+(ii|iii|iv|v|jr|sr)\.?$/i, '')
        .replace(/[^a-z]/g, '');
}

// Combined first+last canonical key: nickname-stable.
function nameKey(firstName, lastName) {
    return canonFirst(firstName) + '|' + norm(lastName);
}

// Last name + position group fallback key.
function lastPosKey(lastName, pos) {
    return norm(lastName) + '|' + posGroup(pos);
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

    // ── Find every "rookie" record in the franchise (YearsPro=0 + Signed + has draft pick) ──
    // These are split into:
    //   - "real" rookies: name-matches one of our prospects (handles the case
    //                     where Madden's auto-draft picked from the real pool)
    //   - "fictional" rookies: rest. Get slot-stamped or purged.
    const allRookies = [];
    for (let i = 0; i < playerTable.records.length; i++) {
        const r = playerTable.records[i];
        if (r.isEmpty) continue;
        if (r.YearsPro !== 0 || r.ContractStatus !== 'Signed') continue;
        if (!r.PLYR_DRAFTPICK || r.PLYR_DRAFTPICK <= 0) continue;
        allRookies.push({
            row:   i,
            round: r.PLYR_DRAFTROUND,
            pick:  r.PLYR_DRAFTPICK,
            name:  `${r.FirstName} ${r.LastName}`,
            firstName: r.FirstName,
            lastName:  r.LastName,
            position:  r.Position,
        });
    }
    const roundCounts = allRookies.reduce((m, f) => {
        m[f.round] = (m[f.round] || 0) + 1; return m;
    }, {});
    console.log(`Rookie records found : ${allRookies.length}  by round: ${JSON.stringify(roundCounts)}`);

    if (allRookies.length === 0) {
        console.error('\nNo rookie records found.');
        console.error('Expected players with YearsPro=0, Signed, PLYR_DRAFTPICK > 0.');
        process.exit(1);
    }

    // Build name & lastPos lookup tables for fast phase-1 matching.
    const rookieByName    = new Map();    // canon name -> rookie
    const rookieByLastPos = new Map();    // canon lastname|posGroup -> [rookies]
    for (const rk of allRookies) {
        const k1 = nameKey(rk.firstName, rk.lastName);
        if (k1 && !rookieByName.has(k1)) rookieByName.set(k1, rk);
        const k2 = lastPosKey(rk.lastName, rk.position);
        if (k2) {
            if (!rookieByLastPos.has(k2)) rookieByLastPos.set(k2, []);
            rookieByLastPos.get(k2).push(rk);
        }
    }

    // ── Phase 1: name-match — find prospects already in the franchise ────────
    // For matched prospects, only update their team + draft slot. Don't touch
    // ratings/identity (they're often pre-filled with M26's published ratings,
    // which are more accurate than what we'd re-stamp).
    const usedRows = new Set();
    let nameMatched = 0, slotStamped = 0, errors = 0;
    const matchLog  = [];
    const stampLog  = [];

    function findRookieFor(prospect) {
        const k1 = nameKey(prospect.firstName, prospect.lastName);
        const m1 = rookieByName.get(k1);
        if (m1 && !usedRows.has(m1.row)) return { rk: m1, how: 'name' };
        // Last+pos fallback (only when unique)
        const k2 = lastPosKey(prospect.lastName, prospect.pos);
        const candidates = (rookieByLastPos.get(k2) || []).filter(r => !usedRows.has(r.row));
        if (candidates.length === 1) return { rk: candidates[0], how: 'last+pos' };
        return null;
    }

    let ratingOverridden = 0;
    for (const prospect of drafted) {
        const m = findRookieFor(prospect);
        if (!m) continue;

        const rec      = playerTable.records[m.rk.row];
        const teamAbbr = teamMap[prospect.draftTeamId || ''] || null;
        const teamIdx  = teamAbbr !== null ? TEAM_INDEX[teamAbbr] : undefined;
        const ourOvr   = (prospect.ratings || {}).overall;
        const stored   = rec.OverallRating || 0;

        try {
            // Update team + draft slot.
            if (teamIdx !== undefined) {
                try { rec.TeamIndex = teamIdx; } catch {}
            }
            try { rec.PLYR_DRAFTROUND = prospect.actual_draft_round || 1; } catch {}
            try { rec.PLYR_DRAFTPICK  = prospect.actual_draft_pick;       } catch {}

            // Rating override: if our OVR is meaningfully higher than what's
            // stored (Madden auto-rated this rookie too low — e.g. Carson
            // Beck at 60 when his profile suggests 67), use ours.
            const ratings = prospect.ratings || {};
            if (ourOvr && stored && ourOvr - stored >= 5) {
                for (const [src, dst] of Object.entries(RATING_FIELD_MAP)) {
                    const v = ratings[src];
                    if (v === undefined || v === null) continue;
                    try {
                        if (dst === 'TraitDevelopment') {
                            rec[dst] = DEV_TRAIT_TO_STRING[Math.max(0, Math.min(3, v))] || 'Normal';
                        } else {
                            const clamped = Math.max(0, Math.min(99, Math.round(v)));
                            rec[dst] = clamped;
                            try { rec['Original' + dst] = clamped; } catch {}
                        }
                    } catch {}
                }
                ratingOverridden++;
            }

            usedRows.add(m.rk.row);
            nameMatched++;
            const flag = (ourOvr && stored && ourOvr - stored >= 5) ? '*' : ' ';
            matchLog.push(
                `  =${flag} R${prospect.actual_draft_round} #${String(prospect.actual_draft_pick).padStart(3)}` +
                `  ${(teamAbbr || '?').padEnd(4)}  ${m.rk.name.padEnd(28)} (${m.how}, OVR=${stored}${flag === '*' ? ` -> ${ourOvr}` : ''})`
            );
        } catch (err) {
            errors++;
            matchLog.push(`  X  ${m.rk.name}: ${err.message}`);
        }
    }
    if (ratingOverridden) {
        console.log(`  (${ratingOverridden} prospects had our OVR > stored OVR + 5; rating overridden)`);
    }
    console.log(`\nPhase 1 (name match)  : ${nameMatched} prospects updated team/slot only (ratings preserved)`);
    if (matchLog.length && matchLog.length <= 30) matchLog.forEach(l => console.log(l));

    // ── Phase 2: slot-stamp — for prospects NOT name-matched, find any unused
    //   rookie record (fictional) and stamp our identity + ratings onto it. ──
    // Track which prospects we matched in phase 1 so we know who's left.
    const phase1MatchedKeys = new Set();
    for (const rk of allRookies) {
        if (usedRows.has(rk.row)) {
            phase1MatchedKeys.add(nameKey(rk.firstName, rk.lastName));
        }
    }
    const availableFictionals = allRookies.filter(rk => !usedRows.has(rk.row));
    // Empty Player slots — used as fallback when fictional rookies run out
    // (e.g. Madden generated 234 rookies but real draft has 257 picks).
    let emptyCursor = 0;
    function nextEmptySlot() {
        while (emptyCursor < playerTable.records.length) {
            const r = playerTable.records[emptyCursor];
            if (r.isEmpty) return emptyCursor;
            emptyCursor++;
        }
        return -1;
    }
    let ficCursor = 0;
    for (const prospect of drafted) {
        // Skip if this prospect was already matched in phase 1
        if (phase1MatchedKeys.has(nameKey(prospect.firstName, prospect.lastName))) continue;

        // Try next available fictional first.
        while (ficCursor < availableFictionals.length && usedRows.has(availableFictionals[ficCursor].row)) {
            ficCursor++;
        }
        let rk, rec, fromEmpty = false;
        if (ficCursor < availableFictionals.length) {
            rk  = availableFictionals[ficCursor++];
            rec = playerTable.records[rk.row];
        } else {
            // No fictional left — fall back to an empty Player slot.
            const emptyIdx = nextEmptySlot();
            if (emptyIdx < 0) {
                stampLog.push(`  -  no slot available for ${prospect.firstName} ${prospect.lastName}`);
                continue;
            }
            emptyCursor = emptyIdx + 1;
            rec = playerTable.records[emptyIdx];
            rk  = { row: emptyIdx, name: '(empty)' };
            fromEmpty = true;
        }
        const fullName = prospect.name || `${prospect.firstName} ${prospect.lastName}`.trim();
        const oldName  = `${rec.FirstName} ${rec.LastName}`.trim();
        const teamAbbr = teamMap[prospect.draftTeamId || ''] || null;
        const teamIdx  = teamAbbr !== null ? TEAM_INDEX[teamAbbr] : undefined;

        try {
            try { rec.FirstName = (prospect.firstName || fullName.split(' ')[0] || 'Unknown').slice(0, 17); } catch {}
            try { rec.LastName  = (prospect.lastName  || fullName.split(' ').slice(1).join(' ') || 'Player').slice(0, 21); } catch {}
            const preferred = POSITION_MAP[(prospect.pos || '').toUpperCase()];
            if (preferred) try { rec.Position = preferred; } catch {}
            try { rec.Height = parseHeight(prospect.ht); } catch {}
            try {
                const lbs = Math.round(prospect.wt) || (rec.Weight + 160);
                rec.Weight = Math.max(0, Math.min(255, lbs - 160));
            } catch {}
            if (teamIdx !== undefined) try { rec.TeamIndex = teamIdx; } catch {}
            try { rec.YearsPro = 0; } catch {}
            try { rec.PLYR_DRAFTROUND = prospect.actual_draft_round || 1; } catch {}
            try { rec.PLYR_DRAFTPICK  = prospect.actual_draft_pick;       } catch {}
            // For freshly-created records (from an empty slot) Madden has
            // nothing in ContractStatus / Age / contract slots — set sensible
            // defaults so the rookie is a usable, signed player.
            if (fromEmpty) {
                try { rec.ContractStatus = 'Signed'; } catch {}
                try { rec.Age           = 22;      } catch {}
                try { rec.JerseyNum     = 0;       } catch {}
                try { rec.College       = 'NoCollege'; } catch {}
                try { rec.YearDrafted   = 1;       } catch {}   // M26 relative encoding (current draft year)
                try { rec.ContractLength = 4;      } catch {}
                // Late-round rookie minimum slot money: ~$0.84M / yr split
                // 90% salary, 10% bonus, in $10k units.
                const aavU   = 84;   // 0.84M
                const bonus  = Math.max(0, Math.round(aavU * 0.1));
                const salary = aavU - bonus;
                for (let s = 0; s < 8; s++) {
                    try { rec[`ContractSalary${s}`] = (s < 4) ? salary : 0; } catch {}
                    try { rec[`ContractBonus${s}`]  = (s < 4) ? bonus  : 0; } catch {}
                }
            }

            const ratings = prospect.ratings || {};
            for (const [src, dst] of Object.entries(RATING_FIELD_MAP)) {
                const v = ratings[src];
                if (v === undefined || v === null) continue;
                try {
                    if (dst === 'TraitDevelopment') {
                        rec[dst] = DEV_TRAIT_TO_STRING[Math.max(0, Math.min(3, v))] || 'Normal';
                    } else {
                        const clamped = Math.max(0, Math.min(99, Math.round(v)));
                        rec[dst] = clamped;
                        try { rec['Original' + dst] = clamped; } catch {}
                    }
                } catch {}
            }

            usedRows.add(rk.row);
            slotStamped++;
            stampLog.push(
                `  +  R${prospect.actual_draft_round} #${String(prospect.actual_draft_pick).padStart(3)}` +
                `  ${(teamAbbr || '?').padEnd(4)}  ${oldName.padEnd(26)} -> ${fullName.padEnd(26)}`
            );
        } catch (err) {
            errors++;
            stampLog.push(`  X  ${fullName}: ${err.message}`);
        }
    }
    console.log(`\nPhase 2 (slot stamp)  : ${slotStamped} prospects stamped onto fictional rookies`);
    if (stampLog.length && stampLog.length <= 30) stampLog.forEach(l => console.log(l));

    const stampedRows = usedRows;   // reused below by phase 3 + roster rebuild
    const stamped = nameMatched + slotStamped;

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

    const totalLog = matchLog.length + stampLog.length;
    if (totalLog > 30) {
        console.log(`(${matchLog.length} name matches + ${stampLog.length} slot stamps; pass --verbose to list)`);
    }

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
