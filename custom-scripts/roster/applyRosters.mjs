/**
 * applyRosters.mjs
 *
 * Reads current_rosters.json (output of script 10_fetch_current_rosters.py)
 * and applies real-life team assignments + contracts to every matching player
 * in a Madden 26 franchise file.
 *
 * Contract storage notes:
 *  - ContractSalary0..7 and ContractBonus0..7 are per-year, 14-bit ints (max 16383)
 *  - Unit is thousands of dollars: 16383 = $16.383M per slot
 *  - Per-year cap hit = ContractSalary{Y} + ContractBonus{Y} (max combined ~$32.77M)
 *  - We split each year's AAV roughly evenly between salary and bonus
 *  - Unused year slots are zeroed so stale values from CAREER-OFFICIAL don't leak
 *  - Remaining years = contractYears - (2026 - yearSigned), clamped to [1, 7]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import FranchiseFile from '../../src/FranchiseFile.js';

// ---------------------------------------------------------------------------
// Default paths
// ---------------------------------------------------------------------------

export const FRANCHISE_PATH =
    'C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-FRANCHISE';

const DEFAULT_ROSTER_JSON =
    'C:/Users/benja/repos/madden-draft-class-generator/data/current_rosters.json';

// ---------------------------------------------------------------------------
// nflverse team abbreviation → Madden TeamIndex (0-31)
// ---------------------------------------------------------------------------

const TEAM_INDEX = {
    CHI:  0,  CIN:  1,  BUF:  2,  DEN:  3,  CLE:  4,  TB:   5,
    ARI:  6,  LAC:  7,  KC:   8,  IND:  9,  DAL: 10,  MIA: 11,
    PHI: 12,  ATL: 13,  SF:  14,  NYG: 15,  JAX: 16,  NYJ: 17,
    DET: 18,  GB:  19,  CAR: 20,  NE:  21,  LV:  22,  LA:  23,
    BAL: 24,  WAS: 25,  NO:  26,  SEA: 27,  PIT: 28,  TEN: 29,
    MIN: 30,  HOU: 31,
};

const CURRENT_YEAR = 2026;
const MAX_14BIT    = 16383;      // field cap (tens of thousands of dollars → $163.83M max/slot)
const MAX_SLOTS    = 8;          // ContractSalary0..7
const MAX_WRITABLE = 7;          // we leave slot 7 clear to match EA's ReSign template
const UNIT_DOLLARS = 10_000;     // each stored integer = $10,000 (verified against CAREER-OFFICIAL)
const MIN_SALARY_U = 87;         // 2026 NFL min $870k → 87 units

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Canonical first-name map — maps common nicknames to a single form so
// Madden "Patrick Surtain" matches nflverse "Pat Surtain", etc.
const FIRST_NAME_CANONICAL = {
    pat: 'patrick', patrick: 'patrick',
    mike: 'michael', michael: 'michael',
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
    greg: 'gregory', gregory: 'gregory',
    jeff: 'jeffrey', jeffrey: 'jeffrey', geoff: 'jeffrey',
    rick: 'richard', rich: 'richard', richard: 'richard', ricky: 'richard',
    andy: 'andrew', andrew: 'andrew', drew: 'andrew',
    ed: 'edward', edward: 'edward', eddie: 'edward',
    dave: 'david', david: 'david', davey: 'david',
    ken: 'kenneth', kenneth: 'kenneth', kenny: 'kenneth',
    ron: 'ronald', ronald: 'ronald', ronny: 'ronald',
    don: 'donald', donald: 'donald', donny: 'donald',
    frank: 'francis', francis: 'francis', frankie: 'francis',
    foye: 'foyesade', foyesade: 'foyesade',
    // Add more as needed
};

function norm(name) {
    const cleaned = (name || '')
        .toLowerCase()
        .replace(/\s+(ii|iii|iv|v|jr|sr)\.?$/i, '')  // strip trailing suffix
        .trim();
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
        const firstKey = parts[0].replace(/[^a-z]/g, '');
        parts[0] = FIRST_NAME_CANONICAL[firstKey] || parts[0];
    }
    return parts.join('').replace(/[^a-z]/g, '');
}

// Last-name-only norm for fallback matching (same suffix-stripping).
function normLast(name) {
    return (name || '')
        .toLowerCase()
        .replace(/\s+(ii|iii|iv|v|jr|sr)\.?$/i, '')
        .replace(/[^a-z]/g, '');
}

/**
 * Split an AAV (full dollars) into per-year (salary, bonus), each clamped to 14 bits.
 * Returns values in UNITS of $10,000 (Madden's native storage scale).
 *
 * Allocation: ~10% to bonus, ~90% to salary.  Bonus drives release dead cap, so
 * keeping it small avoids the "penalty $200M" display issue when cutting a player.
 */
function splitAav(aavDollars) {
    const aavU  = Math.max(MIN_SALARY_U, Math.round((aavDollars || 0) / UNIT_DOLLARS));
    const bonus = Math.min(MAX_14BIT, Math.max(0, Math.round(aavU * 0.1)));
    const salary = Math.max(0, Math.min(MAX_14BIT, aavU - bonus));
    return { salary, bonus };
}

function zeroContract(record) {
    record.ContractLength = 0;
    record.ContractYear   = 0;
    for (let i = 0; i < MAX_SLOTS; i++) {
        record[`ContractSalary${i}`] = 0;
        record[`ContractBonus${i}`]  = 0;
    }
    record.ContractExtraYearOption = false;
}

function writeContract(record, aavDollars, remainingYears) {
    const years = Math.max(1, Math.min(MAX_WRITABLE, remainingYears));
    const { salary, bonus } = splitAav(aavDollars);

    record.ContractLength = years;
    record.ContractYear   = 0;
    record.ContractExtraYearOption = false;

    for (let i = 0; i < MAX_SLOTS; i++) {
        if (i < years) {
            record[`ContractSalary${i}`] = salary;
            record[`ContractBonus${i}`]  = bonus;
        } else {
            record[`ContractSalary${i}`] = 0;
            record[`ContractBonus${i}`]  = 0;
        }
    }
}

function getArg(argv, flag) {
    const idx = argv.indexOf(flag);
    return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function applyRosters(franchisePath, rosterJsonPath, outputPath) {
    const resolvedFranchise = path.resolve(franchisePath);
    if (!fs.existsSync(resolvedFranchise)) {
        console.error(`Franchise file not found: ${resolvedFranchise}`);
        process.exit(1);
    }

    // If outputPath given, write to a copy and leave the source untouched.
    const resolvedTarget = outputPath
        ? path.resolve(outputPath)
        : resolvedFranchise;

    if (outputPath) {
        fs.copyFileSync(resolvedFranchise, resolvedTarget);
        console.log(`Source      : ${resolvedFranchise}`);
        console.log(`Output      : ${resolvedTarget}`);
    }

    const resolvedRoster = path.resolve(rosterJsonPath || DEFAULT_ROSTER_JSON);
    if (!fs.existsSync(resolvedRoster)) {
        console.error(`Roster JSON not found: ${resolvedRoster}`);
        console.error('Run: python scripts/10_fetch_current_rosters.py');
        process.exit(1);
    }

    // ── Load roster data ──────────────────────────────────────────────────────
    const players = JSON.parse(fs.readFileSync(resolvedRoster, 'utf8'));
    console.log(`Roster data : ${players.length} players`);

    // Build lookup: normName → array of matching real players
    // (multiple players can share the same normalized name, e.g. "john johnson")
    const lookup = new Map();
    // Fallback lookup: (normLastName|position) → array of players
    // Used when full-name match fails (handles nicknames like Bing/Bingham)
    const lastPosLookup = new Map();
    for (const p of players) {
        const key = norm(p.fullName || `${p.firstName} ${p.lastName}`);
        if (!lookup.has(key)) lookup.set(key, []);
        lookup.get(key).push(p);

        const lnKey = `${normLast(p.lastName)}|${(p.position || '').toUpperCase()}`;
        if (!lastPosLookup.has(lnKey)) lastPosLookup.set(lnKey, []);
        lastPosLookup.get(lnKey).push(p);
    }

    // ── Backup + open franchise ───────────────────────────────────────────────
    // Only back up when modifying in-place (no separate output target).
    if (resolvedTarget === resolvedFranchise) {
        const backupPath = resolvedFranchise + '.bak';
        fs.copyFileSync(resolvedFranchise, backupPath);
        console.log(`Backup      : ${backupPath}`);
    }

    console.log('\nOpening franchise file...');
    const file = await FranchiseFile.create(resolvedTarget);

    const playerTable = file.getTableByName('Player');
    const CONTRACT_FIELDS = [
        'ContractLength', 'ContractYear', 'ContractExtraYearOption',
        ...Array.from({ length: MAX_SLOTS }, (_, i) => `ContractSalary${i}`),
        ...Array.from({ length: MAX_SLOTS }, (_, i) => `ContractBonus${i}`),
    ];
    await playerTable.readRecords([
        'FirstName', 'LastName', 'Position',
        'ContractStatus', 'TeamIndex',
        ...CONTRACT_FIELDS,
    ]);

    console.log(`Players     : ${playerTable.records.filter(r => !r.isEmpty).length} non-empty records\n`);

    // ── Process records ───────────────────────────────────────────────────────
    let updated    = 0;
    let notFound   = 0;
    let skipped    = 0;
    let ambiguous  = 0;
    let fallback   = 0;
    const log      = [];
    const missed   = [];

    for (const record of playerTable.records) {
        if (record.isEmpty) continue;

        // Never touch draft prospects
        if (record.ContractStatus === 'Draft') {
            skipped++;
            continue;
        }

        const firstName = record.FirstName || '';
        const lastName  = record.LastName  || '';
        const fullName  = `${firstName} ${lastName}`.trim();
        const key       = norm(fullName);
        if (!key) { skipped++; continue; }

        let real;
        const matches = lookup.get(key);
        if (matches && matches.length === 1) {
            real = matches[0];
        } else if (matches && matches.length > 1) {
            // Disambiguate by position when multiple players share a name
            const pos = (record.Position || '').toUpperCase();
            real = matches.find(m => (m.position || '').toUpperCase() === pos) || matches[0];
            ambiguous++;
        } else {
            // Primary lookup failed — try fallback: lastName + position
            const pos = (record.Position || '').toUpperCase();
            const fbKey = `${normLast(lastName)}|${pos}`;
            const fbMatches = lastPosLookup.get(fbKey);
            if (fbMatches && fbMatches.length === 1) {
                real = fbMatches[0];
                fallback++;
            } else {
                notFound++;
                missed.push(fullName);
                continue;
            }
        }

        const teamIdx = real.team === 'FA' ? 32 : TEAM_INDEX[real.team];
        if (teamIdx === undefined) {
            skipped++;
            continue;
        }

        try {
            record.TeamIndex = teamIdx;

            if (real.team === 'FA') {
                record.ContractStatus = 'FreeAgent';
                zeroContract(record);
            } else {
                // Player is on a current NFL roster per weekly data.  Keep them
                // signed even if their OTC contract shows expired — nflverse's
                // contract data lags real-life extensions, and marking star
                // players FA is worse than using a stale AAV.
                record.ContractStatus = 'Signed';
                const totalYears = real.contractYears || 1;
                const yearSigned = real.yearSigned    || CURRENT_YEAR;
                const elapsed    = Math.max(0, CURRENT_YEAR - yearSigned);
                const remaining  = Math.max(1, totalYears - elapsed);
                writeContract(record, real.contractAAV, remaining);
            }

            updated++;
            log.push(
                `  ✓  ${fullName.padEnd(28)} → ${real.team.padEnd(4)}`
            );
        } catch (err) {
            console.error(`  ✗  ${fullName}: ${err.message}`);
            skipped++;
        }
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`Updated     : ${updated}`);
    console.log(`  via fallback: ${fallback}  (lastName+position match)`);
    console.log(`Not in NFL  : ${notFound}  (Madden-generated or retired — left unchanged)`);
    console.log(`Ambiguous   : ${ambiguous}  (name collision, resolved by position)`);
    console.log(`Skipped     : ${skipped}  (draft prospects / empty / unknown team)`);

    if (log.length > 0) {
        console.log('\nTransactions:');
        log.forEach(l => console.log(l));
    }

    if (updated > 0) {
        // ── Rebuild per-team Roster arrays ────────────────────────────────────
        // Madden tracks each team's actual roster in a Player[] table referenced
        // by Team.Roster. Just changing Player.TeamIndex isn't enough — the team
        // menus / depth charts read from the per-team Roster array. Without this
        // step, players would still appear on their pre-update teams in-game.
        console.log('\nRebuilding per-team rosters...');
        const rebuildStats = await rebuildRosters(file, playerTable);
        console.log(
            `Rosters     : rebuilt ${rebuildStats.teams} teams, ` +
            `${rebuildStats.placed} players placed` +
            (rebuildStats.overflow > 0
                ? `, ${rebuildStats.overflow} overflow (slot cap exceeded)`
                : '')
        );

        console.log('\nSaving franchise file...');
        await file.save();
        console.log('Saved.\n');
        console.log('Next steps:');
        console.log('  1. Open Madden and load your franchise save.');
        console.log('  2. Players should be on their real-life teams with real contracts.');
    } else {
        console.log('\nNo changes made — file unchanged.');
    }
}

// ---------------------------------------------------------------------------
// Roster rebuild
// ---------------------------------------------------------------------------

const NULL_REF = '0'.repeat(32);

function makePlayerRef(playerTableId, rowIndex) {
    const tableBits = playerTableId.toString(2).padStart(15, '0');
    const rowBits   = rowIndex.toString(2).padStart(17, '0');
    return tableBits + rowBits;
}

function decodeRef(bin) {
    if (!bin || bin === NULL_REF) return null;
    return {
        tableId: parseInt(bin.slice(0, 15), 2),
        row:     parseInt(bin.slice(15), 2),
    };
}

async function rebuildRosters(file, playerTable) {
    const playerTableId = playerTable.header.tableId;

    // Group player row indices by TeamIndex (only Signed / non-empty / non-Draft).
    const byTeam = new Map();
    for (let i = 0; i < playerTable.records.length; i++) {
        const rec = playerTable.records[i];
        if (rec.isEmpty) continue;
        if (rec.ContractStatus === 'Draft') continue;
        if (rec.ContractStatus === 'FreeAgent') continue;
        const tIdx = rec.TeamIndex;
        if (tIdx === undefined || tIdx === null || tIdx >= 32) continue;
        if (!byTeam.has(tIdx)) byTeam.set(tIdx, []);
        byTeam.get(tIdx).push(i);
    }

    // Find the 37-record Team table (the one with ShortName / Roster fields).
    let teamTable = null;
    for (const t of file.tables) {
        if (t.name === 'Team' && t.header.recordCapacity > 1) {
            teamTable = t;
            break;
        }
    }
    if (!teamTable) {
        console.warn('  ! Could not locate primary Team table; skipping roster rebuild');
        return { teams: 0, placed: 0, overflow: 0 };
    }
    await teamTable.readRecords(['ShortName', 'DisplayName', 'TeamIndex', 'Roster']);

    // Cache Player[] roster tables we open.
    const rosterTableCache = new Map();
    let teamsRebuilt = 0;
    let totalPlaced  = 0;
    let overflow     = 0;

    for (const rec of teamTable.records) {
        if (rec.isEmpty) continue;
        const tIdx = rec.TeamIndex;
        if (tIdx === undefined || tIdx >= 32) continue;     // skip AFC/NFC/FA/Practice
        const ref = decodeRef(rec.Roster);
        if (!ref) continue;

        let rt = rosterTableCache.get(ref.tableId);
        if (!rt) {
            rt = file.getTableById(ref.tableId);
            if (!rt) continue;
            await rt.readRecords();
            rosterTableCache.set(ref.tableId, rt);
        }
        const rosterRow = rt.records[ref.row];
        if (!rosterRow) continue;

        // Number of Player# slots in this row (typically 100).
        const slotNames = rt.offsetTable
            .map(o => o.name)
            .filter(n => /^Player\d+$/.test(n))
            .sort((a, b) => parseInt(a.slice(6), 10) - parseInt(b.slice(6), 10));
        const slotCount = slotNames.length;

        const playerRows = byTeam.get(tIdx) || [];
        const toWrite = playerRows.slice(0, slotCount);
        if (playerRows.length > slotCount) overflow += playerRows.length - slotCount;

        for (let i = 0; i < slotCount; i++) {
            const slot = slotNames[i];
            if (i < toWrite.length) {
                rosterRow[slot] = makePlayerRef(playerTableId, toWrite[i]);
            } else {
                rosterRow[slot] = NULL_REF;
            }
        }

        teamsRebuilt++;
        totalPlaced += toWrite.length;
    }

    return { teams: teamsRebuilt, placed: totalPlaced, overflow };
}

// ---------------------------------------------------------------------------
// Standalone entry
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    const franchiseArg = getArg(process.argv, '--franchise') || FRANCHISE_PATH;
    const rosterArg    = getArg(process.argv, '--roster')    || DEFAULT_ROSTER_JSON;
    const outputArg    = getArg(process.argv, '--output')    || null;
    await applyRosters(franchiseArg, rosterArg, outputArg);
}
