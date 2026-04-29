#!/usr/bin/env node
/**
 * runEndToEnd.mjs — convenience wrapper for the full 2026 franchise pipeline.
 *
 * Usage modes:
 *
 *   STEP 1 (initial pipeline run):
 *     node runEndToEnd.mjs --franchise <input> --output <step1-output>
 *     -> writes the franchise file with vets/picks/rookies stamped.
 *     Then user opens in Madden + advances one week.
 *
 *   STEP 3 (post-Madden archetype optimization):
 *     node runEndToEnd.mjs --fix-archetypes --franchise <step1-AUTOSAVE> --output <final>
 *     -> re-picks PlayerType per Madden's recomputed OG values.
 *     Then user advances one more week.
 *
 *   ALL-IN-ONE (skips manual Madden step — only if you want to defer
 *   archetype optimization until after a manual Madden run):
 *     node runEndToEnd.mjs --franchise <input> --output <step1>
 *     [Madden: load, advance 1 week, exit]
 *     node runEndToEnd.mjs --fix-archetypes \
 *       --franchise <step1-AUTOSAVE> --output <final>
 *     [Madden: load, advance 1 week, exit]  -> done
 *
 * See PIPELINE.md for the full documented workflow.
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

import { applyRosters }      from './roster/applyRosters.mjs';
import { applyDraftOrder }   from './roster/applyDraftOrder.mjs';
import { applyRatings }      from './roster/applyRatings.mjs';
import { addDraftedRookies } from './roster/addDraftedRookies.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR =
    'C:/Users/benja/repos/madden-draft-class-generator/data';
const DEFAULT_RATING_SOURCE =
    'C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-OFFICIAL';

function getArg(argv, flag) {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

function logStep(n, name) {
    console.log('\n' + '='.repeat(70));
    console.log(`  STEP ${n}: ${name}`);
    console.log('='.repeat(70));
}

async function runStep1(franchise, output, dataDir, source) {
    const target = output;
    fs.copyFileSync(path.resolve(franchise), path.resolve(target));
    console.log(`Working copy: ${target}`);

    const required = [
        'current_rosters.json',
        'prospects_rated.json',
        'nfl_team_id_to_abbr.json',
    ];
    for (const f of required) {
        const p = path.join(dataDir, f);
        if (!fs.existsSync(p)) {
            console.error(`Missing pre-fetched data file: ${p}`);
            console.error('See PIPELINE.md "Refresh data" section.');
            process.exit(1);
        }
    }

    logStep(1, 'applyRosters — vets onto real teams + contracts');
    await applyRosters(target, path.join(dataDir, 'current_rosters.json'), null);

    logStep(2, 'applyDraftOrder — 2026 pick ownership');
    const draftOrderJson = path.join(HERE, 'roster', 'draftOrder2026.json');
    await applyDraftOrder(target, null, draftOrderJson);

    logStep(3, 'addDraftedRookies — drafted rookies on real teams + ratings + archetypes');
    await addDraftedRookies(target, dataDir, null);

    if (source && fs.existsSync(source)) {
        logStep(4, `applyRatings — vet ratings overlay from ${path.basename(source)}`);
        await applyRatings(target, source);
    } else if (source) {
        console.warn(`\nWARN: rating source not found at ${source}. Skipping vet rating overlay.`);
    } else {
        console.log('\n(Skipping vet rating overlay — --no-source set.)');
    }

    console.log(`\nStep 1 complete. Open ${target} in Madden, advance one week, exit.`);
    console.log(`Then run: node runEndToEnd.mjs --fix-archetypes --franchise ${target}-AUTOSAVE --output <final>`);
}

async function runFixArchetypes(franchise, output) {
    // Just delegate to the standalone script for clarity.
    const { spawnSync } = await import('child_process');
    const fixScript = path.join(HERE, 'roster', 'fixArchetypes.mjs');
    const args = ['--franchise', franchise];
    if (output) { args.push('--output', output); }
    const res = spawnSync('node', [fixScript, ...args], { stdio: 'inherit' });
    if (res.status !== 0) process.exit(res.status);
}

async function main() {
    const franchise = getArg(process.argv, '--franchise');
    if (!franchise) {
        console.error('Usage:');
        console.error('  Step 1: node runEndToEnd.mjs --franchise <input> --output <step1>');
        console.error('  Step 3: node runEndToEnd.mjs --fix-archetypes --franchise <step1-AUTOSAVE> --output <final>');
        console.error('See PIPELINE.md for the full workflow.');
        process.exit(1);
    }
    const output = getArg(process.argv, '--output');
    const dataDir = getArg(process.argv, '--data') || DEFAULT_DATA_DIR;
    const fixArch = process.argv.includes('--fix-archetypes');
    const source  = process.argv.includes('--no-source') ? null
                  : (getArg(process.argv, '--source') || DEFAULT_RATING_SOURCE);

    if (fixArch) {
        await runFixArchetypes(franchise, output);
    } else {
        if (!output) {
            console.error('--output is required for step 1');
            process.exit(1);
        }
        await runStep1(franchise, output, dataDir, source);
    }
}

main().catch(err => { console.error('\nPipeline failed:', err); process.exit(1); });
