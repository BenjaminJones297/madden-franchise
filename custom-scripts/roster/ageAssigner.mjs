/**
 * ageAssigner.mjs — compute a rookie's age at draft day from a Wikipedia-
 * scraped DOB (preferred) or fall back to NFL.com's `collegeClass`.
 *
 * Inputs the caller is expected to merge into each prospect:
 *   prospect.dob           — ISO YYYY-MM-DD (from prospect_birthdates.json)
 *   prospect.college_class — 'Senior'|'R-Junior'|'Junior'|'R-Sophomore'|...
 *
 * If both are missing, returns the caller-provided fallback (default 22 —
 * roughly the median rookie age, matches what the empty-slot path used to
 * hardcode).
 */

import fs from 'fs';
import path from 'path';

// 2026 NFL Draft starts Thursday April 23 — use that as the reference
// date for "age at draft" computations.
const DRAFT_DATE_ISO = '2026-04-23';
const DRAFT_DATE     = new Date(DRAFT_DATE_ISO + 'T00:00:00Z');
const MS_PER_YEAR    = 365.25 * 24 * 60 * 60 * 1000;

// Rough age-at-draft for each NCAA classification. Redshirts add a year of
// eligibility (and typically a year of age).
const COLLEGE_CLASS_AGE = {
    'R-Senior':    23,
    'Senior':      22,
    'R-Junior':    22,
    'Junior':      21,
    'R-Sophomore': 21,
    'Sophomore':   20,
    'R-Freshman':  20,
    'Freshman':    19,
};

// A real NFL rookie at draft is essentially always 20-26 years old.
// Anything outside this band signals a Wikipedia mismatch (bad scrape) —
// reject the DOB and let the caller fall through to college_class.
const MIN_PLAUSIBLE_AGE = 19;
const MAX_PLAUSIBLE_AGE = 27;

export function ageFromDOB(isoDob, refDate = DRAFT_DATE) {
    if (!isoDob || typeof isoDob !== 'string') return null;
    const dob = new Date(isoDob + 'T00:00:00Z');
    if (isNaN(dob.getTime())) return null;
    const ms = refDate - dob;
    if (ms <= 0) return null;
    const age = Math.floor(ms / MS_PER_YEAR);
    if (age < MIN_PLAUSIBLE_AGE || age > MAX_PLAUSIBLE_AGE) return null;
    return age;
}

export function ageFromCollegeClass(cls) {
    if (!cls) return null;
    return COLLEGE_CLASS_AGE[cls] || null;
}

/**
 * pickAge(prospect, opts?)
 *   prospect.dob, prospect.college_class — see header.
 *   opts.fallback — used if neither signal is present (default 22).
 * Returns an integer age, clamped to [18, 35] for sanity.
 */
export function pickAge(prospect, { fallback = 22 } = {}) {
    let age = ageFromDOB(prospect && prospect.dob);
    if (age === null) age = ageFromCollegeClass(prospect && prospect.college_class);
    if (age === null) age = fallback;
    return Math.max(18, Math.min(35, age));
}

/**
 * Convenience helper: load prospect_birthdates.json + prospects_2026.json
 * and return an index keyed by nfl_id with `{dob, college_class}`.
 */
export function loadAgeIndex({
    birthdatesPath = 'C:/Users/benja/repos/madden-draft-class-generator/data/prospect_birthdates.json',
    prospectsPath  = 'C:/Users/benja/repos/madden-draft-class-generator/data/prospects_2026.json',
} = {}) {
    const idx = new Map();   // nfl_id -> {dob, college_class}
    if (fs.existsSync(prospectsPath)) {
        for (const p of JSON.parse(fs.readFileSync(prospectsPath, 'utf8'))) {
            if (!p.nfl_id) continue;
            idx.set(p.nfl_id, { college_class: p.college_class || null });
        }
    }
    if (fs.existsSync(birthdatesPath)) {
        const cache = JSON.parse(fs.readFileSync(birthdatesPath, 'utf8'));
        for (const [id, v] of Object.entries(cache)) {
            const cur = idx.get(id) || {};
            cur.dob = v.dob || null;
            idx.set(id, cur);
        }
    }
    return idx;
}
