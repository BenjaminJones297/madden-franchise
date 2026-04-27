/**
 * applyDraftOrder.mjs
 *
 * Overwrites the YearOffset=0 draft picks in a Madden 26 franchise file
 * with real-life 2026 draft pick ownership (parsed from ESPN).
 *
 * Compensatory picks are skipped — only the base 32 picks per round
 * (224 total across 7 rounds) are written. Already-drafted picks
 * (those with a SelectedPlayer reference set) are skipped to avoid
 * corrupting completed picks.
 *
 * Usage:
 *   node applyDraftOrder.mjs --franchise <path> [--output <path>] [--data <path>]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import FranchiseFile from '../../src/FranchiseFile.js';

const DEFAULT_DATA = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'draftOrder2026.json'
);

const NULL_REF = '0'.repeat(32);

// Madden uses ShortName "AZ" for Cardinals, "LAR" for Rams.  The ESPN data
// uses "ARI" and "LAR".  Build name aliases against the franchise team table.
const ALIAS = {
    ARI: 'AZ',
    LA:  'LAR',
};

function getArg(argv, flag) {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

function makeRef(tableId, row) {
    return tableId.toString(2).padStart(15, '0') + row.toString(2).padStart(17, '0');
}

export async function applyDraftOrder(franchisePath, outputPath, dataPath) {
    const resolvedSrc = path.resolve(franchisePath);
    if (!fs.existsSync(resolvedSrc)) {
        console.error(`Franchise file not found: ${resolvedSrc}`);
        process.exit(1);
    }
    const resolvedTarget = outputPath ? path.resolve(outputPath) : resolvedSrc;
    if (outputPath) {
        fs.copyFileSync(resolvedSrc, resolvedTarget);
        console.log(`Source : ${resolvedSrc}`);
        console.log(`Output : ${resolvedTarget}`);
    } else {
        fs.copyFileSync(resolvedSrc, resolvedSrc + '.bak');
        console.log(`Backup : ${resolvedSrc}.bak`);
    }

    const dataFile = path.resolve(dataPath || DEFAULT_DATA);
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    console.log(`Data   : ${dataFile} (${data.picks.length} picks)\n`);

    const file = await FranchiseFile.create(resolvedTarget);

    // ── Build team-shortname → Team table row map ─────────────────────────
    const teamTable = file.tables.find(
        t => t.name === 'Team' && t.header.recordCapacity > 1
    );
    if (!teamTable) {
        console.error('Could not locate primary Team table');
        process.exit(1);
    }
    await teamTable.readRecords(['ShortName', 'TeamIndex']);
    const teamTableId = teamTable.header.tableId;
    const shortToRow = new Map();
    for (let i = 0; i < teamTable.records.length; i++) {
        const r = teamTable.records[i];
        if (r.isEmpty) continue;
        if (r.TeamIndex >= 32) continue;
        shortToRow.set(r.ShortName, i);
    }

    function refFor(short) {
        const mapped = shortToRow.get(short) ?? shortToRow.get(ALIAS[short]);
        if (mapped === undefined) return null;
        return makeRef(teamTableId, mapped);
    }

    // Pre-validate every team in the data
    const missingTeams = new Set();
    for (const p of data.picks) {
        if (!refFor(p.current)) missingTeams.add(p.current);
        if (p.from && !refFor(p.from)) missingTeams.add(p.from);
    }
    if (missingTeams.size) {
        console.error('Unknown team short-names:', [...missingTeams].join(','));
        process.exit(1);
    }

    // ── Index all single-row Y=0 DraftPick records by (Round, PickNumber) ──
    // Round in single-row tables is 0-indexed (0 = R1).  PickNumber is also
    // 0-indexed within round (0 = first pick of round).
    const pickIndex = new Map();    // key "R-P" → record
    let scanned = 0;
    for (const t of file.tables) {
        if (t.name !== 'DraftPick') continue;
        if (t.header.recordCapacity !== 1) continue;
        await t.readRecords();
        const rec = t.records[0];
        if (rec.isEmpty) continue;
        if (rec.YearOffset !== 0) continue;
        scanned++;
        const key = `${rec.Round}-${rec.PickNumber}`;
        if (!pickIndex.has(key)) pickIndex.set(key, []);
        pickIndex.get(key).push(rec);
    }
    console.log(`Indexed ${scanned} Y=0 single-row DraftPick records\n`);

    // ── Apply ESPN data ───────────────────────────────────────────────────
    let updated = 0;
    let skippedDrafted = 0;
    let notFound = 0;

    for (const p of data.picks) {
        const overall = (p.round - 1) * 32 + (p.pick - 1);
        const key = `${p.round - 1}-${overall}`;
        const recs = pickIndex.get(key);
        if (!recs || recs.length === 0) {
            notFound++;
            console.warn(`  ! no record for R${p.round} pick ${p.pick}`);
            continue;
        }
        const currentRef  = refFor(p.current);
        const originalRef = refFor(p.from || p.current);

        for (const rec of recs) {
            if (rec.SelectedPlayer && rec.SelectedPlayer !== NULL_REF) {
                skippedDrafted++;
                continue;
            }
            rec.CurrentTeam  = currentRef;
            rec.OriginalTeam = originalRef;
            updated++;
        }
    }

    console.log(`Updated         : ${updated}`);
    console.log(`Skipped drafted : ${skippedDrafted}`);
    console.log(`Not found       : ${notFound}`);

    if (updated > 0) {
        console.log('\nSaving franchise file...');
        await file.save();
        console.log('Saved.');
    } else {
        console.log('\nNo changes made.');
    }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
    const franchise = getArg(process.argv, '--franchise');
    if (!franchise) {
        console.error('Usage: applyDraftOrder.mjs --franchise <path> [--output <path>] [--data <path>]');
        process.exit(1);
    }
    const output = getArg(process.argv, '--output');
    const data   = getArg(process.argv, '--data');
    await applyDraftOrder(franchise, output, data);
}
