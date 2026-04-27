/**
 * importDraftClass.mjs
 *
 * Reads a CSV of draft prospects and writes them into your Madden franchise
 * save as players with ContractStatus = 'Draft', making them visible in the
 * in-game draft pool.
 *
 * Usage (standalone):
 *   node importDraftClass.mjs <path-to-csv>
 *
 * Usage (via franchise-updater/index.mjs):
 *   node index.mjs draftclass <path-to-csv>
 */

import FranchiseFile from '../../src/FranchiseFile.js';
import fs from 'fs';
import path from 'path';

export const FRANCHISE_PATH =
    'C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-APR15-05h28m01p-AUTOSAVE';

// Every rating field the script knows how to set.
// Leave a CSV column blank to skip setting that field on a player.
const RATING_FIELDS = [
    // Universal
    'OverallRating',
    'SpeedRating',
    'AwarenessRating',
    'StrengthRating',
    'AgilityRating',
    'AccelerationRating',
    'StaminaRating',
    'InjuryRating',
    'JumpingRating',
    // QB passing
    'ThrowPowerRating',
    'ThrowAccuracyShortRating',
    'ThrowAccuracyMidRating',
    'ThrowAccuracyDeepRating',
    'ThrowAccuracyRating',
    'ThrowUnderPressureRating',
    'ThrowOnTheRunRating',
    'PlayActionRating',
    // Receiving / route running
    'CatchingRating',
    'CatchInTrafficRating',
    'SpectacularCatchRating',
    'ShortRouteRunningRating',
    'MediumRouteRunningRating',
    'DeepRouteRunningRating',
    // Ball carrier
    'CarryingRating',
    'JukeMoveRating',
    'ElusivenessRating',
    // Blocking (OL / TE / FB)
    'PassBlockRating',
    'PassBlockPowerRating',
    'PassBlockFinesseRating',
    'RunBlockRating',
    'RunBlockPowerRating',
    'RunBlockFinesseRating',
    'ImpactBlockingRating',
    // Pass rush (DL / edge)
    'BlockSheddingRating',
    'FinesseMovesRating',
    'PowerMovesRating',
    // Defense
    'TackleRating',
    'PursuitRating',
    'PlayRecognitionRating',
    'ZoneCoverageRating',
    'ManCoverageRating',
    // Special teams
    'KickPowerRating',
    'KickAccuracyRating',
    'KickReturnRating',
];

// ─── CSV parser ───────────────────────────────────────────────────────────────

function parseCSV(text) {
    const lines = text
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.trim().startsWith('#'));
    if (lines.length < 2) return [];

    const parseRow = (line) => {
        const cols = [];
        let field = '';
        let inQuotes = false;
        for (const c of line) {
            if (c === '"') {
                inQuotes = !inQuotes;
            } else if (c === ',' && !inQuotes) {
                cols.push(field.trim());
                field = '';
            } else {
                field += c;
            }
        }
        cols.push(field.trim());
        return cols;
    };

    const headers = parseRow(lines[0]);
    return lines.slice(1).map((line) => {
        const values = parseRow(line);
        const obj = {};
        headers.forEach((h, i) => (obj[h] = values[i] ?? ''));
        return obj;
    });
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function importDraftClass(franchisePath, csvPath) {
    if (!csvPath) {
        console.error('Error: no CSV path provided.');
        console.error('Usage: node index.mjs draftclass <path-to-csv>');
        process.exit(1);
    }

    const resolvedCsv = path.resolve(csvPath);
    if (!fs.existsSync(resolvedCsv)) {
        console.error(`CSV not found: ${resolvedCsv}`);
        process.exit(1);
    }

    const prospects = parseCSV(fs.readFileSync(resolvedCsv, 'utf-8'));
    if (prospects.length === 0) {
        console.error('No players found in CSV (check headers / comment lines).');
        process.exit(1);
    }
    console.log(`Loaded ${prospects.length} prospect(s) from ${resolvedCsv}`);

    // Open with autoUnempty so writing any field on an empty record activates it
    console.log('Opening franchise file...');
    const file = await FranchiseFile.create(franchisePath, {
        autoUnempty: true,
    });

    // Grab the current season year so YearDrafted is accurate
    const siTable = file.getTableByName('SeasonInfo');
    await siTable.readRecords(['CurrentSeasonYear', 'CurrentYear']);
    const seasonYear =
        siTable.records[0]?.CurrentSeasonYear ??
        siTable.records[0]?.CurrentYear ??
        new Date().getFullYear();
    console.log(`Season year: ${seasonYear}\n`);

    // Load the Player table with every field we might write
    const playerTable = file.getTableByName('Player');
    await playerTable.readRecords([
        'FirstName',
        'LastName',
        'Position',
        'College',
        'Age',
        'Height',
        'Weight',
        'JerseyNum',
        'ContractStatus',
        'TeamIndex',
        'YearsPro',
        'YearDrafted',
        'Background',
        'PLYR_DRAFTROUND',
        'PLYR_DRAFTPICK',
        ...RATING_FIELDS,
    ]);

    const emptySlots = playerTable.records.filter((r) => r.isEmpty);
    console.log(`Empty player slots available: ${emptySlots.length}`);

    if (emptySlots.length < prospects.length) {
        console.error(
            `Not enough empty slots — need ${prospects.length}, have ${emptySlots.length}.`
        );
        process.exit(1);
    }

    let added = 0;
    let failed = 0;

    for (let i = 0; i < prospects.length; i++) {
        const p = prospects[i];
        const record = emptySlots[i];

        try {
            // ── Identity ────────────────────────────────────────────────────
            record.FirstName = p.FirstName || 'Unknown';
            record.LastName  = p.LastName  || 'Player';
            record.Position  = p.Position  || 'QB';

            // College is an enum — fall back to NoCollege if value is invalid
            try {
                record.College = p.College || 'NoCollege';
            } catch {
                record.College = 'NoCollege';
            }

            // ── Physical ────────────────────────────────────────────────────
            record.Age       = parseInt(p.Age)       || 21;
            record.Height    = parseInt(p.Height)    || 72;   // inches
            record.Weight    = parseInt(p.Weight)    || 215;  // lbs
            record.JerseyNum = parseInt(p.JerseyNum) || 0;

            // ── Draft status ────────────────────────────────────────────────
            record.ContractStatus = 'Draft';  // marks player as a draft prospect
            record.TeamIndex      = 32;       // no team (draft pool)
            record.YearsPro       = 0;
            record.YearDrafted    = seasonYear;

            // Background drives narrative text in-game
            record.Background = p.Background || 'LateDraftPick';

            if (p.PLYR_DRAFTROUND && p.PLYR_DRAFTROUND !== '')
                record.PLYR_DRAFTROUND = parseInt(p.PLYR_DRAFTROUND);
            if (p.PLYR_DRAFTPICK && p.PLYR_DRAFTPICK !== '')
                record.PLYR_DRAFTPICK = parseInt(p.PLYR_DRAFTPICK);

            // ── Ratings ─────────────────────────────────────────────────────
            for (const field of RATING_FIELDS) {
                const val = p[field];
                if (val !== undefined && val !== '') {
                    record[field] = parseInt(val);
                }
            }

            added++;
            const ovr = p.OverallRating ? ` OVR ${p.OverallRating}` : '';
            console.log(`  ✓  ${p.FirstName} ${p.LastName} (${p.Position || '?'}${ovr})`);
        } catch (err) {
            console.error(
                `  ✗  ${p.FirstName ?? '?'} ${p.LastName ?? '?'}: ${err.message}`
            );
            failed++;
        }
    }

    console.log(`\nResult: ${added} added, ${failed} failed`);

    if (added > 0) {
        console.log('Saving franchise file...');
        await file.save();
        console.log('Saved.\n');
        console.log('Next steps:');
        console.log('  1. Open Madden and load your franchise save.');
        console.log('  2. Navigate to the Draft section — your prospects will appear there.');
        console.log('  3. Use the setContract command after drafting to assign rookie contracts.');
    }
}

// ─── Standalone entry point ───────────────────────────────────────────────────

const isMain =
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace('file:///', '').replace('file://', ''));

if (isMain) {
    await importDraftClass(FRANCHISE_PATH, process.argv[2]);
}
