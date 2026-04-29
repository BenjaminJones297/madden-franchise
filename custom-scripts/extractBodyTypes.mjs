/**
 * extractBodyTypes.mjs — one-off scrape: walk the Player table and build
 * a (position, height, weight) → CharacterBodyType lookup. Writes the
 * raw {position, height, weight, bodyType, count} buckets as JSON for
 * bodyTypeAssigner.mjs to consume.
 *
 * Run once; output is regenerable but not expected to change unless the
 * underlying franchise data shifts (e.g. a new Madden version).
 *
 * Usage:
 *   node custom-scripts/extractBodyTypes.mjs --franchise <path> --output <json>
 */

import fs from 'fs';
import path from 'path';
import FranchiseFile from '../src/FranchiseFile.js';

const args = process.argv.slice(2);
function arg(name) {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
}

const FRANCHISE = arg('--franchise')
    || 'C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-APR29-01h40m57p-AUTOSAVE';
const OUTPUT = arg('--output')
    || 'C:/Users/benja/repos/madden-draft-class-generator/data/body_type_lookup.json';

const file = await FranchiseFile.create(FRANCHISE);
const pt = file.getTableByName('Player');
await pt.readRecords();

// pos → "h|w" → { bodyType: count }
const buckets = new Map();
let scanned = 0;
for (const r of pt.records) {
    if (r.isEmpty) continue;
    const t = r.TeamIndex;
    if (typeof t !== 'number' || t >= 32) continue;
    const pos = r.Position;
    const h = r.Height;
    const w = (r.Weight || 0) + 160;   // Madden stores Weight - 160
    const bt = r.CharacterBodyType;
    if (!pos || !h || !w || !bt) continue;
    if (!buckets.has(pos)) buckets.set(pos, new Map());
    const m = buckets.get(pos);
    const k = `${h}|${w}`;
    if (!m.has(k)) m.set(k, {});
    m.get(k)[bt] = (m.get(k)[bt] || 0) + 1;
    scanned++;
}

const out = {};
for (const [pos, m] of buckets) {
    out[pos] = [];
    for (const [k, counts] of m) {
        const [h, w] = k.split('|').map(Number);
        out[pos].push({ h, w, counts });
    }
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 0));

console.log(`Scanned ${scanned} player records across ${Object.keys(out).length} positions.`);
console.log(`Wrote: ${OUTPUT}`);
console.log('Per-position bucket count:');
for (const [pos, arr] of Object.entries(out).sort()) {
    console.log(`  ${pos.padEnd(5)}: ${arr.length} unique (h,w) buckets`);
}
