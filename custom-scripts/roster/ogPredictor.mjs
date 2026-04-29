/**
 * ogPredictor.mjs — predict OverallGrade0..4 for a rookie offline,
 * eliminating the need for a Madden advance to recompute.
 *
 * Approach: for each rookie, find K-nearest existing M26 player records
 * in franchise_ratings.json (extracted from CAREER-OFFICIAL) by attribute
 * similarity, and average their OG arrays. The result reflects what
 * Madden's per-archetype formulas would produce on the rookie's
 * attributes. Then pick PlayerType = the archetype at the max slot.
 *
 * On franchise load, Madden displays max(OG) for the player's PlayerType,
 * which now matches our prediction — no week advance needed.
 */

import fs from 'fs';

// Hardcoded slot mappings learned from fixArchetypes.mjs against multiple
// franchise files. nulls indicate "this slot isn't a valid archetype for
// this position" (Madden zeros it out).
export const POSITION_ARCHETYPE_BY_SLOT = {
    QB:   ['QB_FieldGeneral', 'QB_StrongArm', 'QB_Improviser', 'QB_Scrambler', null],
    HB:   ['HB_PowerBack', 'HB_ElusiveBack', 'HB_ReceivingBack', null, null],
    FB:   ['FB_Blocking', 'FB_Utility', null, null, null],
    WR:   ['WR_DeepThreat', 'WR_Playmaker', 'WR_Physical', 'WR_Slot', null],
    TE:   ['TE_Blocking', 'TE_VerticalThreat', 'TE_Possession', null, null],
    LT:   ['OT_PassProtector', 'OT_Power', 'OT_Agile', null, null],
    RT:   ['OT_PassProtector', 'OT_Power', 'OT_Agile', null, null],
    LG:   ['G_PassProtector', 'G_Power', 'G_Agile', null, null],
    RG:   ['G_PassProtector', 'G_Power', 'G_Agile', null, null],
    C:    ['C_PassProtector', 'C_Power', 'C_Agile', null, null],
    LE:   ['DE_SmallerSpeedRusher', 'DE_PowerRusher', 'DE_RunStopper', null, null],
    RE:   ['DE_SmallerSpeedRusher', 'DE_PowerRusher', 'DE_RunStopper', null, null],
    DT:   ['DT_NoseTackle', 'DT_SpeedRusher', 'DT_PowerRusher', null, null],
    LOLB: ['OLB_PassCoverage', 'OLB_RunStopper', null, null, null],
    ROLB: ['OLB_PassCoverage', 'OLB_RunStopper', null, null, null],
    MLB:  ['MLB_FieldGeneral', 'MLB_PassCoverage', 'MLB_RunStopper', null, null],
    CB:   ['CB_MantoMan', 'CB_Slot', 'CB_Zone', null, null],
    FS:   ['S_Zone', 'S_Hybrid', 'S_RunSupport', null, null],
    SS:   ['S_Zone', 'S_Hybrid', 'S_RunSupport', null, null],
    K:    ['KP_Power', 'KP_Accurate', null, null, null],
    P:    ['KP_Power', 'KP_Accurate', null, null, null],
    LS:   ['LS_Accurate', 'LS_Power', null, null, null],
};

// Position-grouping for nearest-neighbor pool. LT/RT both pull from OT, etc.
const POOL_POSITIONS = {
    LT: ['LT', 'RT'], RT: ['LT', 'RT'],
    LG: ['LG', 'RG'], RG: ['LG', 'RG'],
    LE: ['LE', 'RE'], RE: ['LE', 'RE'],
    LOLB: ['LOLB', 'ROLB'], ROLB: ['LOLB', 'ROLB'],
    QB: ['QB'], HB: ['HB'], FB: ['FB'], WR: ['WR'], TE: ['TE'],
    C: ['C'], DT: ['DT'], MLB: ['MLB'], CB: ['CB'],
    FS: ['FS'], SS: ['SS'],
    K: ['K'], P: ['P'], LS: ['LS'],
};

// Per-position attribute weights for similarity (sum to 1.0 within the
// attributes that drive that position's archetype formulas).
const SIM_WEIGHTS = {
    QB:   { ThrowPowerRating: .15, ThrowAccuracyShortRating: .12, ThrowAccuracyMidRating: .12,
            ThrowAccuracyDeepRating: .10, AwarenessRating: .15, ThrowOnTheRunRating: .08,
            ThrowUnderPressureRating: .08, PlayActionRating: .05, SpeedRating: .08, BreakSackRating: .07 },
    HB:   { SpeedRating: .15, AccelerationRating: .12, AgilityRating: .10, StrengthRating: .08,
            CarryingRating: .10, BCVisionRating: .10, BreakTackleRating: .10, JukeMoveRating: .08,
            SpinMoveRating: .07, TruckingRating: .10 },
    FB:   { StrengthRating: .25, ImpactBlockingRating: .25, LeadBlockRating: .25, RunBlockRating: .15,
            CatchingRating: .10 },
    WR:   { SpeedRating: .15, AccelerationRating: .10, AgilityRating: .08, CatchingRating: .15,
            CatchInTrafficRating: .08, SpectacularCatchRating: .08, ShortRouteRunningRating: .10,
            MediumRouteRunningRating: .08, DeepRouteRunningRating: .08, ReleaseRating: .10 },
    TE:   { SpeedRating: .10, StrengthRating: .10, CatchingRating: .15, CatchInTrafficRating: .10,
            ShortRouteRunningRating: .10, MediumRouteRunningRating: .08, DeepRouteRunningRating: .08,
            RunBlockRating: .10, ImpactBlockingRating: .10, ReleaseRating: .09 },
    LT:   { StrengthRating: .15, AwarenessRating: .15, PassBlockRating: .12, PassBlockPowerRating: .10,
            PassBlockFinesseRating: .10, RunBlockRating: .12, RunBlockPowerRating: .08,
            RunBlockFinesseRating: .08, ImpactBlockingRating: .05, LeadBlockRating: .05 },
    LG:   { StrengthRating: .15, AwarenessRating: .15, PassBlockRating: .12, PassBlockPowerRating: .10,
            PassBlockFinesseRating: .10, RunBlockRating: .12, RunBlockPowerRating: .08,
            RunBlockFinesseRating: .08, ImpactBlockingRating: .05, LeadBlockRating: .05 },
    C:    { StrengthRating: .15, AwarenessRating: .20, PassBlockRating: .15, PassBlockPowerRating: .10,
            RunBlockRating: .15, RunBlockPowerRating: .08, RunBlockFinesseRating: .07, ImpactBlockingRating: .10 },
    LE:   { SpeedRating: .12, AccelerationRating: .10, StrengthRating: .12, PowerMovesRating: .15,
            FinesseMovesRating: .15, BlockSheddingRating: .10, TackleRating: .10, HitPowerRating: .08, PursuitRating: .08 },
    DT:   { StrengthRating: .20, PowerMovesRating: .15, BlockSheddingRating: .15, TackleRating: .12,
            HitPowerRating: .10, PursuitRating: .08, SpeedRating: .10, FinesseMovesRating: .10 },
    LOLB: { SpeedRating: .12, AccelerationRating: .08, StrengthRating: .10, TackleRating: .12,
            HitPowerRating: .10, BlockSheddingRating: .10, PursuitRating: .10, ManCoverageRating: .08,
            ZoneCoverageRating: .08, PlayRecognitionRating: .12 },
    MLB:  { SpeedRating: .08, StrengthRating: .10, TackleRating: .15, HitPowerRating: .10,
            PursuitRating: .12, ZoneCoverageRating: .10, ManCoverageRating: .08, PlayRecognitionRating: .15,
            AwarenessRating: .12 },
    CB:   { SpeedRating: .15, AccelerationRating: .10, AgilityRating: .08, ManCoverageRating: .15,
            ZoneCoverageRating: .12, PressRating: .10, PlayRecognitionRating: .10, JumpingRating: .05,
            TackleRating: .07, HitPowerRating: .04, PursuitRating: .04 },
    FS:   { SpeedRating: .12, AccelerationRating: .08, AgilityRating: .08, ZoneCoverageRating: .15,
            ManCoverageRating: .10, PlayRecognitionRating: .15, TackleRating: .10, HitPowerRating: .08, PursuitRating: .14 },
    SS:   { SpeedRating: .08, StrengthRating: .10, TackleRating: .15, HitPowerRating: .15,
            ZoneCoverageRating: .10, ManCoverageRating: .08, PlayRecognitionRating: .12,
            PursuitRating: .10, AwarenessRating: .12 },
};

let _poolCache = null;
let _poolByPos = null;

export function loadPool(franchiseRatingsPath) {
    if (_poolByPos) return _poolByPos;
    if (!fs.existsSync(franchiseRatingsPath)) return null;
    const all = JSON.parse(fs.readFileSync(franchiseRatingsPath, 'utf8'));
    _poolCache = all.filter(p => {
        const og = [0,1,2,3,4].map(i => (p.ratings[`OverallGrade${i}`] || 0));
        return Math.max(...og) > 0;
    });
    _poolByPos = new Map();
    for (const p of _poolCache) {
        const pos = p.Position;
        if (!_poolByPos.has(pos)) _poolByPos.set(pos, []);
        _poolByPos.get(pos).push(p);
    }
    return _poolByPos;
}

function dist(prospect, candidate, weights) {
    let acc = 0, w = 0;
    for (const [field, weight] of Object.entries(weights)) {
        const a = prospect[field], b = candidate.ratings[field];
        if (a === undefined || b === undefined) continue;
        acc += weight * Math.abs(a - b);
        w += weight;
    }
    return w > 0 ? acc / w : 99;
}

/**
 * Predict OverallGrade0..4 for a rookie based on K-nearest neighbors among
 * existing M26 player records.  `prospect` here is the per-attribute value
 * dict (already-stamped attributes from our pipeline).
 */
export function predictOverallGrades(maddenPos, attrs, k = 5) {
    if (!_poolByPos) return null;
    const poolPositions = POOL_POSITIONS[maddenPos] || [maddenPos];
    const pool = poolPositions.flatMap(p => _poolByPos.get(p) || []);
    if (pool.length === 0) return null;
    const weights = SIM_WEIGHTS[maddenPos] || SIM_WEIGHTS.WR;

    // Find k nearest by weighted L1 distance
    const scored = pool.map(p => ({ p, d: dist(attrs, p, weights) }));
    scored.sort((a, b) => a.d - b.d);
    const top = scored.slice(0, Math.min(k, scored.length));

    // Inverse-distance weighted average of OG arrays
    const ogSum = [0, 0, 0, 0, 0];
    let wSum = 0;
    for (const { p, d } of top) {
        const og = [0,1,2,3,4].map(i => p.ratings[`OverallGrade${i}`] || 0);
        const w = 1.0 / (1.0 + d);
        for (let i = 0; i < 5; i++) ogSum[i] += og[i] * w;
        wSum += w;
    }
    if (wSum === 0) return null;
    const result = ogSum.map(v => Math.round(v / wSum));
    return result;
}

/**
 * Pick the PlayerType corresponding to the slot with maximum predicted OG.
 * Returns {playerType, ovr, og} or null if not predictable.
 */
export function pickArchetypeFromOG(maddenPos, og) {
    const archetypes = POSITION_ARCHETYPE_BY_SLOT[maddenPos];
    if (!archetypes) return null;
    let bestSlot = 0, bestVal = -1;
    for (let i = 0; i < og.length; i++) {
        if (archetypes[i] && og[i] > bestVal) {
            bestVal = og[i];
            bestSlot = i;
        }
    }
    return {
        playerType: archetypes[bestSlot],
        ovr: bestVal,
        og,
        bestSlot,
    };
}
