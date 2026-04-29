/**
 * Extract every player's full ratings + Madden-computed archetype grades
 * from a franchise file. The output is a JSON document keyed by canonical
 * normalized name plus parallel position/team/year_drafted info.
 *
 * Used by the rating pipeline as a ground-truth source for OVR (instead of
 * computing OVR via our own regression formulas — Madden's per-archetype
 * formula is what actually drives in-game display, so the OVR + OG values
 * we read here are exactly what the game shows).
 *
 * Usage:
 *   node custom-scripts/extractFranchiseRatings.mjs \
 *     --franchise "C:/Users/benja/.../CAREER-OFFICIAL" \
 *     --output    "C:/Users/benja/repos/madden-draft-class-generator/data/franchise_ratings.json"
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import FranchiseFile from '../src/FranchiseFile.js';

function getArg(argv, flag) {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

const RATING_FIELDS = [
    'OverallRating',
    'SpeedRating', 'AccelerationRating', 'AgilityRating', 'StrengthRating',
    'AwarenessRating', 'JumpingRating', 'StaminaRating', 'ToughnessRating',
    'InjuryRating',
    // QB
    'ThrowPowerRating', 'ThrowAccuracyRating', 'ThrowAccuracyShortRating',
    'ThrowAccuracyMidRating', 'ThrowAccuracyDeepRating',
    'ThrowOnTheRunRating', 'ThrowUnderPressureRating',
    'PlayActionRating', 'BreakSackRating',
    // BC
    'CarryingRating', 'BCVisionRating', 'BreakTackleRating',
    'JukeMoveRating', 'SpinMoveRating', 'StiffArmRating',
    'TruckingRating', 'ChangeOfDirectionRating',
    // WR/TE
    'CatchingRating', 'CatchInTrafficRating', 'SpectacularCatchRating',
    'ShortRouteRunningRating', 'MediumRouteRunningRating',
    'DeepRouteRunningRating', 'ReleaseRating',
    // OL
    'PassBlockRating', 'PassBlockPowerRating', 'PassBlockFinesseRating',
    'RunBlockRating', 'RunBlockPowerRating', 'RunBlockFinesseRating',
    'ImpactBlockingRating', 'LeadBlockRating',
    // Front 7
    'TackleRating', 'HitPowerRating', 'BlockSheddingRating', 'PursuitRating',
    'PowerMovesRating', 'FinesseMovesRating',
    // DBs
    'ZoneCoverageRating', 'ManCoverageRating', 'PressRating',
    'PlayRecognitionRating',
    // ST
    'KickPowerRating', 'KickAccuracyRating', 'KickReturnRating',
    'LongSnapRating',
    // Trait + archetypes
    'TraitDevelopment',
    'OverallGrade0', 'OverallGrade1', 'OverallGrade2', 'OverallGrade3', 'OverallGrade4',
];

const META_FIELDS = [
    'FirstName', 'LastName', 'Position', 'TeamIndex', 'ContractStatus',
    'YearsPro', 'YearDrafted', 'Age', 'Height', 'Weight',
    'PLYR_DRAFTROUND', 'PLYR_DRAFTPICK', 'PlayerType',
];

function normName(name) {
    return (name || '').toLowerCase()
        .replace(/\s+(ii|iii|iv|v|jr|sr)\.?$/i, '')
        .replace(/[^a-z]/g, '');
}

async function main() {
    const franchise = getArg(process.argv, '--franchise');
    const output    = getArg(process.argv, '--output');
    if (!franchise || !output) {
        console.error('Usage: --franchise <path> --output <path>');
        process.exit(1);
    }

    console.log(`Opening franchise: ${franchise}`);
    const file = await FranchiseFile.create(franchise);
    const pt = file.getTableByName('Player');
    await pt.readRecords();
    console.log(`Player table: ${pt.records.length} rows ` +
                `(${pt.records.filter(r => !r.isEmpty).length} non-empty)`);

    // Verify all fields exist in the schema
    const schemaFields = new Set(pt.offsetTable.map(o => o.name));
    const missing = [...RATING_FIELDS, ...META_FIELDS].filter(f => !schemaFields.has(f));
    if (missing.length) {
        console.warn(`WARN: ${missing.length} fields not in schema (will be skipped):`);
        for (const f of missing) console.warn(`  ${f}`);
    }

    const out = [];
    for (let i = 0; i < pt.records.length; i++) {
        const r = pt.records[i];
        if (r.isEmpty) continue;

        const fn = r.FirstName, ln = r.LastName;
        if (!fn || !ln) continue;

        const meta = {};
        for (const f of META_FIELDS) {
            if (!schemaFields.has(f)) continue;
            try {
                const v = r[f];
                if (v !== undefined && v !== null && v !== '') meta[f] = v;
            } catch {}
        }

        const ratings = {};
        for (const f of RATING_FIELDS) {
            if (!schemaFields.has(f)) continue;
            try {
                const v = r[f];
                if (v !== undefined && v !== null && v !== '') ratings[f] = v;
            } catch {}
        }

        out.push({
            row:  i,
            name: `${fn} ${ln}`.trim(),
            normName: normName(`${fn} ${ln}`),
            ...meta,
            ratings,
        });
    }
    out.sort((a, b) => (b.ratings.OverallRating || 0) - (a.ratings.OverallRating || 0));

    fs.writeFileSync(output, JSON.stringify(out, null, 2));
    console.log(`\nWrote ${out.length} player records to ${output}`);

    // Quick stats by year-drafted (offset relative to CurrentSeasonYear)
    const ydCounts = {};
    for (const p of out) {
        const yd = p.YearDrafted ?? 'null';
        ydCounts[yd] = (ydCounts[yd] || 0) + 1;
    }
    console.log('\nYearDrafted distribution (Madden uses offset from BaseCalendarYear):');
    for (const [k, v] of Object.entries(ydCounts).sort((a,b) => parseInt(b[0])-parseInt(a[0]))) {
        console.log(`  ${k.padStart(4)}  ${v}`);
    }

    const yp0 = out.filter(p => p.YearsPro === 0);
    console.log(`\nYearsPro=0 (rookie-tier) players: ${yp0.length}`);
    const ovrSum = yp0.reduce((s, p) => s + (p.ratings.OverallRating || 0), 0);
    console.log(`  Mean OVR: ${(ovrSum / Math.max(1, yp0.length)).toFixed(2)}`);

    // Sample top 5 OG distributions
    console.log('\nSample top-5 by OverallRating:');
    for (const p of out.slice(0, 5)) {
        const og = ['OverallGrade0','OverallGrade1','OverallGrade2','OverallGrade3','OverallGrade4']
            .map(k => p.ratings[k] ?? '-');
        console.log(`  ${p.name.padEnd(24)} ${(p.Position||'').padEnd(4)} OVR ${p.ratings.OverallRating}  OG=[${og.join(',')}]`);
    }
}

main().catch(err => { console.error(err); process.exit(1); });
