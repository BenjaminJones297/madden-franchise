/**
 * importFromDraftClass.mjs
 *
 * Reads a Madden .draftclass file (FBCHUNKS binary format, M25/M26) and
 * writes all prospects into your franchise save as Player records with
 * ContractStatus = 'Draft', making them appear in the in-game draft pool.
 *
 * Requires: madden-draft-class-tools (npm install madden-draft-class-tools)
 *
 * Usage (standalone):
 *   node importFromDraftClass.mjs <path-to-file.draftclass>
 *
 * Usage (via franchise-updater/index.mjs):
 *   node index.mjs fromdraftclass <path-to-file.draftclass>
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import FranchiseFile from '../../src/FranchiseFile.js';

const require = createRequire(import.meta.url);
const { readDraftClass } = require('madden-draft-class-tools');

export const FRANCHISE_PATH =
    'C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-APR15-05h28m01p-AUTOSAVE';

// .draftclass position byte → franchise PositionE enum string
// Matches the standard Madden position ordering (value field in PositionE enum)
const POSITION_MAP = [
    'QB',   // 0
    'HB',   // 1
    'FB',   // 2
    'WR',   // 3
    'TE',   // 4
    'LT',   // 5  (offensive tackle — franchise uses LT/RT, default LT)
    'LG',   // 6  (guard — franchise uses LG/RG, default LG)
    'C',    // 7
    'RE',   // 8  (defensive end — franchise uses LE/RE, default RE)
    'DT',   // 9
    'MLB',  // 10
    'ROLB', // 11 (outside linebacker — franchise uses LOLB/ROLB, default ROLB)
    'CB',   // 12
    'FS',   // 13
    'SS',   // 14
    'K',    // 15
    'P',    // 16
];

export async function importFromDraftClass(franchisePath, draftClassPath, { overwrite = false } = {}) {
    if (!draftClassPath) {
        console.error('Error: no .draftclass path provided.');
        console.error('Usage: node index.mjs fromdraftclass <path-to-file.draftclass> [--overwrite]');
        process.exit(1);
    }

    const resolved = path.resolve(draftClassPath);
    if (!fs.existsSync(resolved)) {
        console.error(`File not found: ${resolved}`);
        process.exit(1);
    }

    const resolved_franchise = path.resolve(franchisePath);
    if (!fs.existsSync(resolved_franchise)) {
        console.error(`Franchise file not found: ${resolved_franchise}`);
        process.exit(1);
    }

    // Parse the .draftclass binary
    console.log(`Reading: ${resolved}`);
    const buf = fs.readFileSync(resolved);
    let draftClass;
    try {
        draftClass = readDraftClass(buf);
    } catch (err) {
        console.error(`Failed to parse .draftclass file: ${err.message}`);
        process.exit(1);
    }

    const { prospects } = draftClass;
    console.log(`Game year : ${draftClass.header.gameYear}`);
    console.log(`Prospects : ${prospects.length}`);

    console.log('\nOpening franchise file (autoUnempty enabled)...');

    // Backup the file before any changes
    const backupPath = resolved_franchise + '.bak';
    fs.copyFileSync(resolved_franchise, backupPath);
    console.log(`Backup saved: ${backupPath}`);

    const file = await FranchiseFile.create(franchisePath, { autoUnempty: true });

    // Use the franchise's current season year for YearDrafted
    const siTable = file.getTableByName('SeasonInfo');
    await siTable.readRecords(['CurrentSeasonYear', 'CurrentYear']);
    const seasonYear =
        siTable.records[0]?.CurrentSeasonYear ??
        siTable.records[0]?.CurrentYear ??
        new Date().getFullYear();
    console.log(`Franchise season year: ${seasonYear}\n`);

    const playerTable = file.getTableByName('Player');
    await playerTable.readRecords([
        'FirstName', 'LastName', 'Position',
        'Age', 'Height', 'Weight', 'JerseyNum',
        'ContractStatus', 'TeamIndex', 'YearsPro', 'YearDrafted', 'Background',
        'PLYR_DRAFTROUND', 'PLYR_DRAFTPICK',
        // Universal ratings
        'OverallRating', 'SpeedRating', 'AwarenessRating', 'StrengthRating',
        'AgilityRating', 'AccelerationRating', 'StaminaRating', 'InjuryRating', 'JumpingRating',
        // QB
        'ThrowPowerRating', 'ThrowAccuracyShortRating', 'ThrowAccuracyMidRating',
        'ThrowAccuracyDeepRating', 'ThrowAccuracyRating',
        'ThrowUnderPressureRating', 'ThrowOnTheRunRating', 'PlayActionRating',
        // Receiving
        'CatchingRating', 'CatchInTrafficRating', 'SpectacularCatchRating',
        'ShortRouteRunningRating', 'MediumRouteRunningRating', 'DeepRouteRunningRating',
        // Ball carrier
        'CarryingRating', 'JukeMoveRating', 'ElusivenessRating',
        // Blocking
        'PassBlockRating', 'PassBlockPowerRating', 'PassBlockFinesseRating',
        'RunBlockRating', 'RunBlockPowerRating', 'RunBlockFinesseRating', 'ImpactBlockingRating',
        // Pass rush
        'BlockSheddingRating', 'FinesseMovesRating', 'PowerMovesRating',
        // Defense
        'TackleRating', 'PursuitRating', 'PlayRecognitionRating',
        'ZoneCoverageRating', 'ManCoverageRating',
        // Special teams
        'KickPowerRating', 'KickAccuracyRating', 'KickReturnRating',
    ]);

    // In overwrite mode: update existing Draft records in-place (preserves
    // Madden's cross-references in scouting/draft-board tables — emptying them
    // causes a crash on load). Any of our prospects beyond the existing count
    // fall through to empty slots below.
    let writeTargets = [];

    if (overwrite) {
        const existing = playerTable.records.filter(
            (r) => !r.isEmpty && r.ContractStatus === 'Draft' && r.TeamIndex === 32
        );
        console.log(`Overwrite: updating ${Math.min(existing.length, prospects.length)} existing draft record(s) in-place...`);
        writeTargets = existing;
    }

    const emptySlots = playerTable.records.filter((r) => r.isEmpty);

    // Build the final slot list: in-place records first, then empty slots for overflow
    const availableSlots = [
        ...writeTargets,
        ...emptySlots,
    ];

    console.log(`Draft slots available: ${writeTargets.length} in-place + ${emptySlots.length} empty`);

    if (availableSlots.length < prospects.length) {
        console.error(
            `Not enough slots — need ${prospects.length}, have ${availableSlots.length}.`
        );
        process.exit(1);
    }

    let added = 0;
    let failed = 0;

    for (let i = 0; i < prospects.length; i++) {
        const p = prospects[i];
        const record = availableSlots[i];
        const posStr = POSITION_MAP[p.position] ?? 'QB';

        try {
            // ── Identity ──────────────────────────────────────────────────────
            record.FirstName = p.firstName || 'Unknown';
            record.LastName  = p.lastName  || 'Player';
            record.Position  = posStr;

            // ── Physical ──────────────────────────────────────────────────────
            record.Age       = p.age          || 21;
            record.Height    = p.heightInches || 72;
            record.Weight    = p.weight       || 215;
            record.JerseyNum = p.jerseyNum    || 0;

            // ── Draft status ──────────────────────────────────────────────────
            record.ContractStatus = 'Draft';
            record.TeamIndex      = 32;
            record.YearsPro       = 0;
            record.YearDrafted    = seasonYear;

            // Derive Background from round stored in file
            record.Background =
                p.draftRound === 0 ? 'Undrafted'
                : p.draftRound <= 2 ? 'EarlyDraftPick'
                : 'LateDraftPick';

            if (p.draftRound) record.PLYR_DRAFTROUND = p.draftRound;
            if (p.draftPick)  record.PLYR_DRAFTPICK  = p.draftPick;

            // ── Ratings (direct 1-to-1 from draftclass bytes) ─────────────────
            record.OverallRating            = p.overall;
            record.SpeedRating              = p.speed;
            record.AwarenessRating          = p.awareness;
            record.StrengthRating           = p.strength;
            record.AgilityRating            = p.agility;
            record.AccelerationRating       = p.acceleration;
            record.StaminaRating            = p.stamina;
            record.InjuryRating             = p.injury;
            record.JumpingRating            = p.jumping;

            record.ThrowPowerRating         = p.throwPower;
            record.ThrowAccuracyShortRating = p.throwAccuracyShort;
            record.ThrowAccuracyMidRating   = p.throwAccuracyMid;
            record.ThrowAccuracyDeepRating  = p.throwAccuracyDeep;
            record.ThrowAccuracyRating      = p.throwAccuracy;
            record.ThrowUnderPressureRating = p.throwUnderPressure;
            record.ThrowOnTheRunRating      = p.throwOnTheRun;
            record.PlayActionRating         = p.playAction;

            record.CatchingRating           = p.catching;
            record.CatchInTrafficRating     = p.catchInTraffic;
            record.SpectacularCatchRating   = p.spectacularCatch;
            record.ShortRouteRunningRating  = p.shortRouteRunning;
            record.MediumRouteRunningRating = p.mediumRouteRunning;
            record.DeepRouteRunningRating   = p.deepRouteRunning;

            record.CarryingRating           = p.carrying;
            record.JukeMoveRating           = p.jukeMove;

            record.PassBlockRating          = p.passBlock;
            record.PassBlockPowerRating     = p.passBlockPower;
            record.PassBlockFinesseRating   = p.passBlockFinesse;
            record.RunBlockRating           = p.runBlock;
            record.RunBlockPowerRating      = p.runBlockPower;
            record.RunBlockFinesseRating    = p.runBlockFinesse;
            record.ImpactBlockingRating     = p.impactBlocking;

            record.BlockSheddingRating      = p.blockShedding;
            record.FinesseMovesRating       = p.finesseMoves;
            record.PowerMovesRating         = p.powerMoves;

            record.TackleRating             = p.tackle;
            record.PursuitRating            = p.pursuit;
            record.PlayRecognitionRating    = p.playRecognition;
            record.ZoneCoverageRating       = p.zoneCoverage;
            record.ManCoverageRating        = p.manCoverage;

            record.KickPowerRating          = p.kickPower;
            record.KickAccuracyRating       = p.kickAccuracy;
            record.KickReturnRating         = p.kickReturn;

            added++;
            console.log(
                `  ✓  ${p.firstName} ${p.lastName} (${posStr}, OVR ${p.overall})`
            );
        } catch (err) {
            console.error(
                `  ✗  ${p.firstName ?? '?'} ${p.lastName ?? '?'}: ${err.message}`
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
        console.log('  2. Navigate to the Draft — your prospects will appear there.');
        console.log('  3. Use "node index.mjs contract ..." after the draft to set rookie deals.');
    }
}

// ─── Standalone entry ─────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    const overwrite = process.argv.includes('--overwrite');
    await importFromDraftClass(FRANCHISE_PATH, process.argv[2], { overwrite });
}
