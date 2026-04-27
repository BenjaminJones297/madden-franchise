#!/usr/bin/env node
/**
 * runFullPipeline.mjs — repeatable, single-command 2026 franchise update.
 *
 * Runs every step in order, using only pre-fetched data files (no network).
 * Each step writes the same franchise file in-place; back up your save before
 * running, or pass --output <path> to keep the original untouched.
 *
 * Expects a Pre-Season Week 1 franchise save (post-draft, post-cuts).
 *
 * Steps:
 *   1. applyRosters       — vets onto real teams + contracts (current_rosters.json)
 *   2. applyDraftOrder    — 2026 draft pick ownership (draftOrder2026.json).
 *                           Skips picks already drafted, so this is essentially
 *                           a no-op at Pre-Season Week 1 — included for
 *                           completeness when run on pre-draft saves.
 *   3. addDraftedRookies  — replaces Madden's fictional 2026 rookies in-slot
 *                           (preserves team / contract / pick links) and purges
 *                           the fictional UDFA pool. Reads prospects_rated.json.
 *   4. applyRatings       — vet ratings overlay from a Madden source roster
 *                           (only runs if --source <path-to-Madden-roster> given)
 *
 * Pre-fetched data lives under madden-draft-class-generator/data/. Refresh with:
 *   python scripts/4d_fetch_nfl_prospects.py    # NFL.com prospect profiles + draft picks
 *   python scripts/4e_fetch_team_mapping.py     # NFL UUID -> team abbr (one-time)
 *   python scripts/5_generate_ratings.py        # Madden ratings via Ollama (~30 min)
 *   python scripts/10_fetch_current_rosters.py  # Vet roster + contracts
 *
 * Usage:
 *   node runFullPipeline.mjs --franchise <path> [--source <madden-roster>] [--output <path>]
 */

import { fileURLToPath } from 'url';
import path  from 'path';
import fs    from 'fs';

import { applyRosters }       from './roster/applyRosters.mjs';
import { applyDraftOrder }    from './roster/applyDraftOrder.mjs';
import { applyRatings }       from './roster/applyRatings.mjs';
import { addDraftedRookies }  from './roster/addDraftedRookies.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR =
    'C:/Users/benja/repos/madden-draft-class-generator/data';
// Madden franchise file holding the post-Super-Bowl rating updates. Used as
// the default --source for step 4 (vet rating overlay).
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

async function main() {
    const franchise = getArg(process.argv, '--franchise');
    if (!franchise) {
        console.error('Usage: node runFullPipeline.mjs --franchise <path> [--source <madden-roster>] [--output <path>] [--data <dir>]');
        process.exit(1);
    }
    const dataDir = getArg(process.argv, '--data')   || DEFAULT_DATA_DIR;
    const output  = getArg(process.argv, '--output') || null;
    // Allow --no-source to opt out; otherwise default to ROSTER-NEW (the
    // post-Super-Bowl Madden roster).
    const source  = process.argv.includes('--no-source') ? null
                  : (getArg(process.argv, '--source') || DEFAULT_RATING_SOURCE);

    // If --output is given, copy once at the start so all subsequent steps
    // operate on the copy and the original is preserved.
    let target = franchise;
    if (output) {
        fs.copyFileSync(path.resolve(franchise), path.resolve(output));
        target = output;
        console.log(`Working copy: ${output}`);
    }

    const t0 = Date.now();

    // Pre-flight: confirm all data files exist
    const required = [
        'current_rosters.json',
        'prospects_rated.json',
        'nfl_team_id_to_abbr.json',
    ];
    for (const f of required) {
        const p = path.join(dataDir, f);
        if (!fs.existsSync(p)) {
            console.error(`Missing pre-fetched data file: ${p}`);
            console.error('See header of this script for refresh commands.');
            process.exit(1);
        }
    }
    console.log('Pre-flight: all required data files present.');

    logStep(1, 'applyRosters — vets onto real teams + contracts');
    await applyRosters(target, path.join(dataDir, 'current_rosters.json'), null);

    logStep(2, 'applyDraftOrder — 2026 pick ownership');
    const draftOrderJson = path.join(HERE, 'roster', 'draftOrder2026.json');
    await applyDraftOrder(target, null, draftOrderJson);

    logStep(3, 'addDraftedRookies — drafted rookies on real teams + contracts + ratings');
    await addDraftedRookies(target, dataDir, null);

    if (source) {
        if (!fs.existsSync(source)) {
            console.warn(`\nWARN: rating source not found at ${source}.`);
            console.warn('      Skipping vet rating overlay. Pass --source <path> or --no-source.');
        } else {
            logStep(4, `applyRatings — vet ratings overlay from ${path.basename(source)}`);
            await applyRatings(target, source);
        }
    } else {
        console.log('\n(Skipping step 4 — --no-source set.)');
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n✓ Pipeline complete in ${elapsed}s.`);
    console.log(`  Final franchise file: ${target}`);
}

main().catch(err => {
    console.error('\nPipeline failed:', err);
    process.exit(1);
});
