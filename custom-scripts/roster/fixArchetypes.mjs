/**
 * fixArchetypes.mjs
 *
 * For each rookie in a franchise file, set PlayerType to the archetype
 * corresponding to their HIGHEST per-archetype OG slot — so Madden's
 * displayed OVR matches max(OverallGrade0..4) instead of getting stuck at
 * a sub-optimal archetype's value.
 *
 * Background: Madden recomputes OverallGrade0..4 from attributes on franchise
 * load (per-archetype formulas). The displayed/stored OVR appears to track
 * OG[slot_for_PlayerType] — so picking the wrong PlayerType pegs the
 * player at his worst archetype score (e.g., Mendoza was QB_FieldGeneral
 * with OG=[65,64,60,63,72] -> displayed 65; should be 72).
 *
 * How it works:
 *  Phase A: scan ALL non-empty Player records. For records where
 *           OverallRating matches exactly one OG slot, infer the
 *           (Position, PlayerType) -> slot mapping from observed examples.
 *  Phase B: invert the map -> for each (Position, slot) pick the most
 *           common PlayerType assigned at that slot.
 *  Phase C: walk rookies (YearsPro=0). Pick the slot with max OG, look
 *           up the archetype for that (Position, slot), set PlayerType.
 *           Also update OverallRating to max(OG) so all the fields agree.
 *
 * Workflow:
 *  1. Run pipeline to write CAREER-full-solution-2 (with our pickPlayerType
 *     guess for each rookie's PT)
 *  2. Open in Madden, advance one week, exit -> Madden recomputes OG and saves
 *  3. Run THIS script against CAREER-full-solution-2-AUTOSAVE
 *  4. Re-open in Madden, advance again -> Madden re-evaluates with the
 *     corrected PT, displayed OVR is now max(OG)
 *
 * Usage:
 *   node custom-scripts/roster/fixArchetypes.mjs --franchise <path> [--output <path>]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import FranchiseFile from '../../src/FranchiseFile.js';

function getArg(argv, flag) {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

async function main() {
    const franchise = getArg(process.argv, '--franchise');
    if (!franchise) {
        console.error('Usage: --franchise <path> [--output <path>]');
        process.exit(1);
    }
    const output = getArg(process.argv, '--output') || franchise;

    const resolvedSrc = path.resolve(franchise);
    const resolvedDst = path.resolve(output);
    if (resolvedSrc !== resolvedDst) {
        fs.copyFileSync(resolvedSrc, resolvedDst);
        console.log(`Source: ${resolvedSrc}`);
        console.log(`Output: ${resolvedDst}`);
    } else {
        fs.copyFileSync(resolvedSrc, resolvedSrc + '.bak');
        console.log(`Backup: ${resolvedSrc}.bak`);
    }

    const file = await FranchiseFile.create(resolvedDst);
    const pt = file.getTableByName('Player');
    await pt.readRecords();
    console.log(`Player table: ${pt.records.length} rows`);

    // ── Phase A: learn (Position, PlayerType) -> slot mapping ──────────
    // For each non-empty record, if exactly one OG slot equals OvR, that
    // slot corresponds to the player's PlayerType.
    const ptToSlot = new Map();   // "POS|ARCHETYPE" -> Counter({slot: count})
    let learnSamples = 0;
    for (const r of pt.records) {
        if (r.isEmpty) continue;
        const playerType = r.PlayerType;
        const pos = r.Position;
        const ovr = r.OverallRating;
        if (!playerType || !pos || !ovr) continue;
        const og = [r.OverallGrade0, r.OverallGrade1, r.OverallGrade2, r.OverallGrade3, r.OverallGrade4];
        const matches = og.map((v, i) => [v, i]).filter(([v]) => v === ovr).map(([_, i]) => i);
        if (matches.length !== 1) continue;
        const slot = matches[0];
        const k = `${pos}|${playerType}`;
        const m = ptToSlot.get(k) || new Map();
        m.set(slot, (m.get(slot) || 0) + 1);
        ptToSlot.set(k, m);
        learnSamples++;
    }
    console.log(`Phase A: learned slot mapping from ${learnSamples} player records`);

    // ── Phase B: build (Position, slot) -> archetype map ────────────────
    // For each (POS|PT), find its most-frequent slot. Then group by (pos, slot).
    const posSlotToArchetype = new Map();    // "POS|slot" -> Counter({archetype: count})
    for (const [posPt, slotCounter] of ptToSlot) {
        const [pos, archetype] = posPt.split('|');
        let bestSlot = -1, bestCount = -1;
        for (const [s, c] of slotCounter) {
            if (c > bestCount) { bestCount = c; bestSlot = s; }
        }
        if (bestSlot < 0) continue;
        const k = `${pos}|${bestSlot}`;
        const m = posSlotToArchetype.get(k) || new Map();
        m.set(archetype, (m.get(archetype) || 0) + bestCount);
        posSlotToArchetype.set(k, m);
    }
    // Resolve to single archetype per (pos, slot)
    const slotMap = new Map();   // "POS|slot" -> archetype_name
    for (const [k, m] of posSlotToArchetype) {
        let bestA = null, bestC = -1;
        for (const [a, c] of m) {
            if (c > bestC) { bestC = c; bestA = a; }
        }
        if (bestA) slotMap.set(k, bestA);
    }

    console.log(`Phase B: derived ${slotMap.size} (Position, slot) -> archetype entries`);
    // Print a few common position mappings
    const posSamples = ['QB', 'HB', 'WR', 'TE', 'LT', 'LG', 'C', 'LE', 'DT', 'LOLB', 'MLB', 'CB', 'FS', 'SS'];
    for (const ps of posSamples) {
        const slots = [0,1,2,3,4].map(s => slotMap.get(`${ps}|${s}`) || '?');
        console.log(`  ${ps.padEnd(5)} slots [0..4]: ${slots.join(' / ')}`);
    }

    // ── Phase C: re-pick rookie archetypes to maximize displayed OVR ────
    let optimized = 0, unchanged = 0, noMap = 0;
    const log = [];
    for (const r of pt.records) {
        if (r.isEmpty) continue;
        if (r.YearsPro !== 0) continue;
        if (r.ContractStatus !== 'Signed') continue;
        if (!r.PLYR_DRAFTPICK || r.PLYR_DRAFTPICK <= 0) continue;
        const og = [r.OverallGrade0, r.OverallGrade1, r.OverallGrade2, r.OverallGrade3, r.OverallGrade4];
        let bestSlot = 0, bestVal = og[0];
        for (let i = 1; i < og.length; i++) {
            if (og[i] > bestVal) { bestVal = og[i]; bestSlot = i; }
        }
        if (bestVal <= 0) continue;
        const pos = r.Position;
        const targetArchetype = slotMap.get(`${pos}|${bestSlot}`);
        if (!targetArchetype) {
            noMap++;
            continue;
        }
        const cur = r.PlayerType;
        if (cur === targetArchetype) {
            unchanged++;
            continue;
        }
        try {
            r.PlayerType = targetArchetype;
            // Also update OverallRating + OriginalOverallRating to max(OG) so
            // all displayed fields agree without waiting for another recompute.
            try { r.OverallRating         = bestVal; } catch {}
            try { r.OriginalOverallRating = bestVal; } catch {}
            optimized++;
            log.push(`  ${r.FirstName} ${r.LastName} (${pos}) ${cur} -> ${targetArchetype}  OG[${bestSlot}]=${bestVal}`);
        } catch (e) {
            log.push(`  ! ${r.FirstName} ${r.LastName}: ${e.message}`);
        }
    }
    console.log(`\nPhase C: optimized=${optimized}  unchanged=${unchanged}  no-map=${noMap}`);
    if (log.length && log.length <= 60) for (const l of log) console.log(l);
    else if (log.length) console.log(`(${log.length} changes — pass --verbose to list)`);

    if (optimized > 0) {
        console.log('\nSaving...');
        await file.save();
        console.log('Saved.');
    } else {
        console.log('\nNo changes.');
    }
}

main().catch(err => { console.error(err); process.exit(1); });
