/**
 * applyRatings.mjs
 *
 * Copies player ratings from a SOURCE Madden file (roster or franchise)
 * into a TARGET franchise file, matching players by normalized name.
 *
 * Usage (via index.mjs):
 *   node index.mjs ratings --source <path-to-source-file>
 *
 * Usage (standalone):
 *   node applyRatings.mjs --source <path> [--franchise <path>]
 *
 * The source file can be any M26 file — a roster update (.ros without
 * extension), another franchise, or any file the library can open.
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

// ---------------------------------------------------------------------------
// Rating fields: franchise file field name → readable label
// Sourced from scripts/3_extract_roster_ratings.js FIELD_MAP
// ---------------------------------------------------------------------------

// M26 schema-correct field names. IMPORTANT differences from older Madden:
//   BCVisionRating       (NOT BallCarrierVisionRating)
//   PressRating          (NOT PressCoverageRating)
//   FinesseMovesRating   (plural — NOT FinesseMoveRating)
//   ImpactBlockingRating (NOT ImpactBlockRating)
//   MoraleRating         (does not exist in M26 — dropped)
const RATING_FIELDS = [
    'OverallRating',
    'SpeedRating',
    'AccelerationRating',
    'AgilityRating',
    'StrengthRating',
    'AwarenessRating',
    'ThrowPowerRating',
    'ThrowAccuracyRating',
    'ThrowAccuracyShortRating',
    'ThrowAccuracyMidRating',
    'ThrowAccuracyDeepRating',
    'ThrowOnTheRunRating',
    'ThrowUnderPressureRating',
    'PlayActionRating',
    'BreakSackRating',
    'TackleRating',
    'HitPowerRating',
    'BlockSheddingRating',
    'FinesseMovesRating',
    'PowerMovesRating',
    'PursuitRating',
    'ZoneCoverageRating',
    'ManCoverageRating',
    'PressRating',
    'PlayRecognitionRating',
    'JumpingRating',
    'CatchingRating',
    'CatchInTrafficRating',
    'SpectacularCatchRating',
    'ShortRouteRunningRating',
    'MediumRouteRunningRating',
    'DeepRouteRunningRating',
    'ReleaseRating',
    'RunBlockRating',
    'PassBlockRating',
    'RunBlockPowerRating',
    'RunBlockFinesseRating',
    'PassBlockPowerRating',
    'PassBlockFinesseRating',
    'ImpactBlockingRating',
    'LeadBlockRating',
    'JukeMoveRating',
    'SpinMoveRating',
    'StiffArmRating',
    'TruckingRating',
    'BreakTackleRating',
    'BCVisionRating',
    'ChangeOfDirectionRating',
    'CarryingRating',
    'KickPowerRating',
    'KickAccuracyRating',
    'KickReturnRating',
    'StaminaRating',
    'ToughnessRating',
    'InjuryRating',
    'TraitDevelopment',   // dev trait (enum-string)
];

// Appearance / identity reference fields. These get nulled out when a
// player is "Deleted" in a franchise (e.g. retirement). When applyRosters
// resurrects them onto a real-life team, the visuals stay zeroed and
// Madden falls back to a generic head + default jersey for that player.
// We overlay these from the source ONLY when the dst value is null/zero
// so we don't trample legit custom appearance edits.
const APPEARANCE_FIELDS = [
    'CharacterVisuals',         // 32-bit ref to the 4KB visuals blob (binary string in this lib)
    'PLYR_ASSETNAME',           // EA asset id like 'LawrenceDeMarcus_11079'
    'GenericHeadAssetName',     // generic head fallback name (gen_*_*_*)
    'PLYR_GENERICHEAD',
    'PLYR_HANDEDNESS',
    'PLYR_QBSTYLE',
    'PLYR_STYLE',
    'PortraitSwappableLibraryPath',
    'RunningStyleRating',
    'PlayerVisMoveType',
];

// Treat all-zero binary refs and empty strings as "null" — those are the
// states left behind when a record is deleted/retired in the franchise.
function isNullVisualsRef(v) {
    if (v === undefined || v === null) return true;
    if (typeof v === 'string') {
        if (v === '') return true;
        if (/^0+$/.test(v)) return true;   // 32-bit reference all zeros
    }
    return false;
}

// Fields to read for identification
const ID_FIELDS = ['FirstName', 'LastName', 'Position', 'ContractStatus'];

// All fields we need to read from both files
const ALL_FIELDS = [...new Set([...ID_FIELDS, ...RATING_FIELDS])];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function norm(name) {
    return (name || '')
        .toLowerCase()
        .replace(/\s+(ii|iii|iv|v|jr|sr)\.?$/i, '')  // strip trailing suffix
        .replace(/[^a-z]/g, '');
}

function getArg(argv, flag) {
    const idx = argv.indexOf(flag);
    return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function applyRatings(franchisePath, sourcePath) {
    if (!sourcePath) {
        console.error('ERROR: --source <path> is required');
        process.exit(1);
    }

    const resolvedFranchise = path.resolve(franchisePath);
    const resolvedSource    = path.resolve(sourcePath);

    if (!fs.existsSync(resolvedFranchise)) {
        console.error(`Franchise file not found: ${resolvedFranchise}`);
        process.exit(1);
    }
    if (!fs.existsSync(resolvedSource)) {
        console.error(`Source file not found: ${resolvedSource}`);
        process.exit(1);
    }

    // ── Open source file ──────────────────────────────────────────────────────
    console.log(`Source      : ${resolvedSource}`);
    console.log('Opening source file...');
    const srcFile    = await FranchiseFile.create(resolvedSource, { gameYearOverride: 26 });
    const srcTable   = srcFile.getTableByName('Player');
    // Read all fields so we can also pull Original*Rating values when present.
    await srcTable.readRecords();

    // Build lookup: normName → best matching record (highest OverallRating wins ties)
    const srcLookup = new Map();
    for (const rec of srcTable.records) {
        if (rec.isEmpty) continue;
        if (rec.ContractStatus === 'Draft') continue; // skip draft prospects

        const key = norm(`${rec.FirstName} ${rec.LastName}`);
        if (!key) continue;

        const existing = srcLookup.get(key);
        const ovr = rec.OverallRating ?? 0;
        if (!existing || ovr > (existing.OverallRating ?? 0)) {
            srcLookup.set(key, rec);
        }
    }

    console.log(`Source players loaded: ${srcLookup.size}`);

    // ── Backup + open target franchise ────────────────────────────────────────
    const backupPath = resolvedFranchise + '.bak';
    fs.copyFileSync(resolvedFranchise, backupPath);
    console.log(`Backup      : ${backupPath}`);

    console.log('\nOpening franchise file...');
    const dstFile  = await FranchiseFile.create(resolvedFranchise);
    const dstTable = dstFile.getTableByName('Player');
    await dstTable.readRecords();

    const total = dstTable.records.filter(r => !r.isEmpty).length;
    console.log(`Target players: ${total} non-empty records\n`);

    // ── Copy ratings ──────────────────────────────────────────────────────────
    let updated   = 0;
    let notFound  = 0;
    let skipped   = 0;
    const missed  = [];

    for (const dst of dstTable.records) {
        if (dst.isEmpty) continue;
        if (dst.ContractStatus === 'Draft') { skipped++; continue; }

        const key = norm(`${dst.FirstName} ${dst.LastName}`);
        if (!key) { skipped++; continue; }

        const src = srcLookup.get(key);
        if (!src) {
            notFound++;
            missed.push(`${dst.FirstName} ${dst.LastName}`);
            continue;
        }

        let changed = false;
        for (const field of RATING_FIELDS) {
            const val = src[field];
            if (val === undefined || val === null) continue;
            try {
                dst[field] = val;
                changed = true;
            } catch (_) {
                // field may not exist in target schema — skip silently
            }
            // Mirror to Original* counterpart when present (M26's in-game OVR
            // recompute uses these as the baseline).
            const origField = 'Original' + field;
            const origVal   = src[origField] ?? src[field];
            if (origVal !== undefined && origVal !== null) {
                try { dst[origField] = origVal; } catch (_) {}
            }
        }

        // Restore appearance refs only when the target's are null — preserves
        // any in-franchise custom appearance edits but fixes deleted/retired
        // vets who got resurrected by applyRosters (their CharacterVisuals
        // get zeroed at delete time, so Madden falls back to a generic head).
        for (const field of APPEARANCE_FIELDS) {
            try {
                if (!isNullVisualsRef(dst[field])) continue;
                const val = src[field];
                if (val === undefined || val === null) continue;
                if (typeof val === 'string' && (val === '' || /^0+$/.test(val))) continue;
                dst[field] = val;
                changed = true;
            } catch (_) {}
        }

        if (changed) {
            updated++;
        } else {
            skipped++;
        }
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`Updated   : ${updated}`);
    console.log(`Not found : ${notFound}  (not in source — left unchanged)`);
    console.log(`Skipped   : ${skipped}  (draft prospects / empty)`);

    if (missed.length > 0 && missed.length <= 30) {
        console.log('\nNot found in source:');
        missed.forEach(n => console.log(`  ${n}`));
    } else if (missed.length > 30) {
        console.log(`\n(${missed.length} players not found — run with --verbose to see all)`);
    }

    if (updated > 0) {
        console.log('\nSaving franchise file...');
        await dstFile.save();
        console.log('Saved.');
    } else {
        console.log('\nNo changes — file unchanged.');
    }
}

// ---------------------------------------------------------------------------
// Standalone entry
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    const franchiseArg = getArg(process.argv, '--franchise') || FRANCHISE_PATH;
    const sourceArg    = getArg(process.argv, '--source');
    await applyRatings(franchiseArg, sourceArg);
}
