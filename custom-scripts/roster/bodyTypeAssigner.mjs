/**
 * bodyTypeAssigner.mjs — pick a CharacterBodyType for a rookie based on
 * empirical (position, height, weight) → body-type frequencies extracted
 * from existing M26 players (data/body_type_lookup.json).
 *
 * Approach: K-nearest-neighbor on (height, weight) within the rookie's
 * position. Aggregates body-type counts across the K=5 closest neighbors,
 * returns the mode. Falls back to position-wide mode if no neighbors,
 * then to 'Standard' as a last resort.
 *
 * The 5 main body types in M26's CharacterBodyType enum:
 *   Standard, Thin, Muscular, Heavy, Freshman
 *
 * (Other enum entries — First_, FirstMain_, ReservedMain_*, *_Alternate,
 * Max_, Invalid_ — appear to be schema markers, not real options.)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE     = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOOKUP_PATH =
    'C:/Users/benja/repos/madden-draft-class-generator/data/body_type_lookup.json';

// Group positions where the lookup may be sparse for one but rich for siblings.
// Used as a fallback if the rookie's exact position has no entries.
const POSITION_FALLBACKS = {
    LT: ['RT'], RT: ['LT'],
    LG: ['RG', 'C'], RG: ['LG', 'C'], C: ['LG', 'RG'],
    G:  ['LG', 'RG', 'C'], T: ['LT', 'RT'],
    LE: ['RE'], RE: ['LE'], DE: ['LE', 'RE'],
    DT: ['NT'], NT: ['DT'],
    LOLB: ['ROLB'], ROLB: ['LOLB'], OLB: ['LOLB', 'ROLB'],
    ILB: ['MLB'],
    FS: ['SS'], SS: ['FS'], S: ['FS', 'SS'],
};

let _cachedLookup = null;
let _cachedPath   = null;

function loadLookup(lookupPath) {
    const p = lookupPath || DEFAULT_LOOKUP_PATH;
    if (_cachedLookup && _cachedPath === p) return _cachedLookup;
    if (!fs.existsSync(p)) {
        console.warn(`[bodyTypeAssigner] lookup table not found: ${p}`);
        _cachedLookup = {};
    } else {
        _cachedLookup = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    _cachedPath = p;
    return _cachedLookup;
}

function modeFromCounts(counts) {
    let best = null, bestN = 0;
    for (const [bt, n] of Object.entries(counts)) {
        if (n > bestN) { best = bt; bestN = n; }
    }
    return best;
}

function aggregateCounts(entries, height, weight, k = 5) {
    if (!entries || entries.length === 0) return {};
    // Manhattan distance with weight scaled (weight varies more than height).
    const scored = entries.map(e => ({
        e,
        d: Math.abs(e.h - height) + Math.abs(e.w - weight) / 3,
    }));
    scored.sort((a, b) => a.d - b.d);
    const top = scored.slice(0, Math.max(1, k));
    const agg = {};
    for (const { e, d } of top) {
        const weightFactor = 1 / (1 + d);   // closer entries weighted more
        for (const [bt, n] of Object.entries(e.counts || {})) {
            agg[bt] = (agg[bt] || 0) + n * weightFactor;
        }
    }
    return agg;
}

/**
 * pickBodyType(position, height, weight, options?)
 *   position: M26 position string (e.g. "QB", "LT", "CB"). Case-sensitive
 *             match against the lookup table; pass the canonical form.
 *   height:   inches (Madden's raw Height value)
 *   weight:   pounds (already de-offset; pass `rec.Weight + 160`)
 *   options.lookupPath — override the default body_type_lookup.json path
 *
 * Returns one of: 'Standard', 'Thin', 'Muscular', 'Heavy', 'Freshman' (or
 * null if no data is available, in which case the caller should leave the
 * existing CharacterBodyType alone).
 */
export function pickBodyType(position, height, weight, { lookupPath } = {}) {
    if (!position || typeof height !== 'number' || typeof weight !== 'number') return null;
    const lookup = loadLookup(lookupPath);
    const pos = position.toUpperCase();

    let entries = lookup[pos];
    if (!entries || entries.length === 0) {
        const fallbacks = POSITION_FALLBACKS[pos] || [];
        entries = fallbacks.flatMap(f => lookup[f] || []);
    }
    if (!entries || entries.length === 0) return null;

    const agg = aggregateCounts(entries, height, weight, 5);
    return modeFromCounts(agg);
}

/**
 * Diagnostic helper: returns the full count distribution for a (pos, h, w)
 * lookup, sorted by weighted aggregate. Useful for verifying picks.
 */
export function bodyTypeDistribution(position, height, weight, { lookupPath } = {}) {
    if (!position) return [];
    const lookup = loadLookup(lookupPath);
    const pos = position.toUpperCase();
    let entries = lookup[pos];
    if (!entries || entries.length === 0) {
        const fallbacks = POSITION_FALLBACKS[pos] || [];
        entries = fallbacks.flatMap(f => lookup[f] || []);
    }
    const agg = aggregateCounts(entries, height, weight, 5);
    return Object.entries(agg).sort((a, b) => b[1] - a[1]);
}
