/**
 * jerseyAssigner.mjs — pick legal NFL jersey numbers per position.
 *
 * 2024 NFL rules legalized most numbers for skill positions. The ranges
 * below reflect the new rules with priority ordering — preferred ranges
 * first, fallback ranges last.
 *
 * Used by addDraftedRookies.mjs to overwrite the inherited fictional-
 * rookie jersey on every slot-stamped record (so a CB that was stamped
 * onto a former WR's slot doesn't keep the WR's #87).
 */

// Per-position legal ranges, in priority order (most "natural" first).
// Each entry is [min, max] inclusive.
export const POSITION_PREFERRED_RANGES = {
    QB:   [[1, 19]],
    HB:   [[20, 49], [1, 9], [80, 89]],
    FB:   [[40, 49], [20, 39]],
    WR:   [[10, 19], [80, 89], [1, 9], [20, 49]],
    TE:   [[80, 89], [40, 49], [1, 19], [20, 39]],
    LT:   [[60, 79], [50, 59]],   RT: [[60, 79], [50, 59]],   T:  [[60, 79], [50, 59]],
    LG:   [[60, 79], [50, 59]],   RG: [[60, 79], [50, 59]],   G:  [[60, 79], [50, 59]],
    C:    [[50, 79]],
    LE:   [[90, 99], [50, 79]],   RE: [[90, 99], [50, 79]],   DE: [[90, 99], [50, 79]],
    DT:   [[90, 99], [50, 79]],   NT: [[90, 99], [50, 79]],
    LOLB: [[40, 59], [90, 99]],   ROLB:[[40, 59], [90, 99]],  OLB:[[40, 59], [90, 99]],
    MLB:  [[40, 59], [90, 99], [1, 39]],   ILB: [[40, 59], [90, 99], [1, 39]],
    CB:   [[20, 39], [1, 19]],
    FS:   [[20, 49], [1, 19]],
    SS:   [[20, 49], [1, 19]],
    K:    [[1, 19]],
    P:    [[1, 19]],
    LS:   [[40, 59]],
};

/**
 * Walk the Player table, return Map<TeamIndex, Map<JerseyNum, count>> of
 * jerseys currently assigned to non-empty active players. Free-agent
 * (TeamIndex >= 32) and retired records are excluded.
 *
 * Counts (multiset semantics) matter: Madden's saved state can have two
 * players on the same team sharing a jersey (e.g. a fictional rookie and
 * a vet both at #93). When we release one, the other still claims it, so
 * a Set would lose track of the survivor.
 */
export function buildOccupancyMap(playerTable) {
    const occ = new Map();   // teamIdx -> Map<jerseyNum, count>
    for (const r of playerTable.records) {
        if (r.isEmpty) continue;
        const t = r.TeamIndex;
        const j = r.JerseyNum;
        if (t === undefined || t === null || t >= 32) continue;
        if (typeof j !== 'number' || j <= 0) continue;
        if (!occ.has(t)) occ.set(t, new Map());
        const m = occ.get(t);
        m.set(j, (m.get(j) || 0) + 1);
    }
    return occ;
}

/**
 * Return a legal jersey number for `position` not currently used by
 * `teamIdx`. Tries the position's preferred ranges in order, picks the
 * lowest unused number in the first range with capacity. Mutates the
 * occupancy map so subsequent picks for the same team don't collide.
 *
 * If `teamIdx` is undefined or every range is fully occupied (vanishingly
 * rare — every team has 53+ jerseys available), returns null and the
 * caller should keep the existing JerseyNum or pick something arbitrary.
 */
export function pickJerseyNumber(position, teamIdx, occupancyMap) {
    const ranges = POSITION_PREFERRED_RANGES[(position || '').toUpperCase()];
    if (!ranges) return null;
    if (typeof teamIdx !== 'number' || teamIdx >= 32) return null;
    if (!occupancyMap.has(teamIdx)) occupancyMap.set(teamIdx, new Map());
    const occ = occupancyMap.get(teamIdx);

    for (const [min, max] of ranges) {
        for (let n = min; n <= max; n++) {
            if (!occ.get(n)) {
                occ.set(n, 1);
                return n;
            }
        }
    }
    return null;
}

/**
 * Returns true if `jersey` is in any legal range for `position`. Used by
 * Phase 1 (name-matched rookies) to decide whether to override an
 * inherited number — leave it alone if it's already legal.
 */
export function isLegalForPosition(position, jersey) {
    const ranges = POSITION_PREFERRED_RANGES[(position || '').toUpperCase()];
    if (!ranges || typeof jersey !== 'number') return false;
    for (const [min, max] of ranges) {
        if (jersey >= min && jersey <= max) return true;
    }
    return false;
}

/**
 * One-shot helper for slot-stamp / phase-1 paths. Reads the rec's CURRENT
 * (TeamIndex, JerseyNum), updates the occupancy map to reflect the move,
 * and writes a new legal jersey for `(newPos, newTeamIdx)`.
 *
 * Options:
 *   allowKeep — if true and the current jersey is already legal for newPos,
 *               keep it (just migrate occupancy old→new team if team changed).
 *               Used by Phase 1 to preserve Madden's auto-draft choice when
 *               it's already valid.
 *
 * Returns { kept, jersey, changed }.
 *   kept:    true if we left the existing jersey alone
 *   jersey:  the final jersey number (null if no legal pick was possible)
 *   changed: true if rec.JerseyNum was written
 */
export function reassignJersey(rec, newPos, newTeamIdx, occupancy, { allowKeep = false, oldTeam: oldTeamArg, oldJersey: oldJerseyArg } = {}) {
    const oldTeam   = oldTeamArg   !== undefined ? oldTeamArg   : rec.TeamIndex;
    const oldJersey = oldJerseyArg !== undefined ? oldJerseyArg : rec.JerseyNum;

    const releaseOld = () => {
        if (typeof oldTeam === 'number' && oldTeam < 32 && typeof oldJersey === 'number' && oldJersey > 0) {
            const m = occupancy.get(oldTeam);
            if (m) {
                const c = (m.get(oldJersey) || 0) - 1;
                if (c <= 0) m.delete(oldJersey);
                else m.set(oldJersey, c);
            }
        }
    };
    const claimNew = (j) => {
        if (typeof newTeamIdx === 'number' && newTeamIdx < 32) {
            if (!occupancy.has(newTeamIdx)) occupancy.set(newTeamIdx, new Map());
            const m = occupancy.get(newTeamIdx);
            m.set(j, (m.get(j) || 0) + 1);
        }
    };

    if (allowKeep && isLegalForPosition(newPos, oldJersey)) {
        // "Free on the new team" = nobody else claims oldJersey there. If the
        // rec was already on newTeamIdx, its own claim is in occCount; subtract
        // it. Otherwise occCount is purely other players.
        const newOcc = occupancy.get(newTeamIdx);
        const occCount = (newOcc && newOcc.get(oldJersey)) || 0;
        const recContributes = (oldTeam === newTeamIdx && typeof oldJersey === 'number' && oldJersey > 0) ? 1 : 0;
        const safeToKeep = (occCount - recContributes) <= 0;
        if (safeToKeep) {
            if (oldTeam !== newTeamIdx) {
                releaseOld();
                claimNew(oldJersey);
            }
            return { kept: true, jersey: oldJersey, changed: false };
        }
    }

    releaseOld();
    const jn = pickJerseyNumber(newPos, newTeamIdx, occupancy);
    if (jn === null) return { kept: false, jersey: null, changed: false };
    try { rec.JerseyNum = jn; } catch {}
    return { kept: false, jersey: jn, changed: true };
}
