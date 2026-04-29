/**
 * Extract Madden-computed OVR + key attributes for every rookie in a
 * franchise file, after Madden has loaded + saved (which triggers the
 * per-archetype OVR recompute from attributes).
 *
 * Workflow: write the file with our pipeline → open in Madden → enter the
 * franchise + back out (forces a save with recomputed OG) → run this script.
 * The OG values it reads are exactly what's displayed in-game.
 *
 * Usage:
 *   node custom-scripts/extractRookieRatings.mjs \
 *     --franchise "C:/.../CAREER-full-solution-2" \
 *     [--output    "C:/.../data/rookie_ratings_post_madden.json"]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import FranchiseFile from '../src/FranchiseFile.js';

function getArg(argv, flag) {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

const TEAMS = ['CHI','CIN','BUF','DEN','CLE','TB','ARI','LAC','KC','IND',
               'DAL','MIA','PHI','ATL','SF','NYG','JAX','NYJ','DET','GB',
               'CAR','NE','LV','LA','BAL','WAS','NO','SEA','PIT','TEN','MIN','HOU'];

async function main() {
    const franchise = getArg(process.argv, '--franchise');
    if (!franchise) {
        console.error('Usage: --franchise <path> [--output <path>]');
        process.exit(1);
    }
    const output = getArg(process.argv, '--output')
        || 'C:/Users/benja/repos/madden-draft-class-generator/data/rookie_ratings_from_franchise.json';

    const file = await FranchiseFile.create(franchise);
    const pt = file.getTableByName('Player');
    await pt.readRecords();

    const out = [];
    for (const r of pt.records) {
        if (r.isEmpty) continue;
        if (r.YearsPro !== 0) continue;
        if (r.ContractStatus !== 'Signed') continue;
        if (!r.PLYR_DRAFTPICK || r.PLYR_DRAFTPICK <= 0) continue;

        const og = [r.OverallGrade0, r.OverallGrade1, r.OverallGrade2, r.OverallGrade3, r.OverallGrade4];
        const team = r.TeamIndex < 32 ? TEAMS[r.TeamIndex] : 'FA';
        out.push({
            firstName: r.FirstName,
            lastName:  r.LastName,
            position:  r.Position,
            playerType: r.PlayerType,
            team,
            teamIndex: r.TeamIndex,
            round: r.PLYR_DRAFTROUND,
            pick:  r.PLYR_DRAFTPICK,
            // Madden displays max(OG) as the in-game OVR.
            overallStored:    r.OverallRating,
            overallDisplayed: Math.max(...og),
            overallGrades:    og,
            traitDevelopment: r.TraitDevelopment,
            // Key attributes
            speed:        r.SpeedRating,
            acceleration: r.AccelerationRating,
            agility:      r.AgilityRating,
            strength:     r.StrengthRating,
            awareness:    r.AwarenessRating,
            // Position-specific attributes
            tackle:       r.TackleRating,
            hitPower:     r.HitPowerRating,
            pursuit:      r.PursuitRating,
            blockShedding: r.BlockSheddingRating,
            powerMoves:   r.PowerMovesRating,
            finesseMoves: r.FinesseMovesRating,
            manCoverage:  r.ManCoverageRating,
            zoneCoverage: r.ZoneCoverageRating,
            pressCoverage: r.PressRating,
            playRecognition: r.PlayRecognitionRating,
            catching:     r.CatchingRating,
            spectacularCatch: r.SpectacularCatchRating,
            catchInTraffic: r.CatchInTrafficRating,
            shortRouteRunning: r.ShortRouteRunningRating,
            mediumRouteRunning: r.MediumRouteRunningRating,
            deepRouteRunning: r.DeepRouteRunningRating,
            release: r.ReleaseRating,
            passBlock: r.PassBlockRating,
            passBlockPower: r.PassBlockPowerRating,
            passBlockFinesse: r.PassBlockFinesseRating,
            runBlock: r.RunBlockRating,
            runBlockPower: r.RunBlockPowerRating,
            runBlockFinesse: r.RunBlockFinesseRating,
            impactBlocking: r.ImpactBlockingRating,
            leadBlock: r.LeadBlockRating,
            jukeMove: r.JukeMoveRating,
            spinMove: r.SpinMoveRating,
            stiffArm: r.StiffArmRating,
            trucking: r.TruckingRating,
            breakTackle: r.BreakTackleRating,
            bcVision: r.BCVisionRating,
            changeOfDirection: r.ChangeOfDirectionRating,
            carrying: r.CarryingRating,
            throwPower: r.ThrowPowerRating,
            throwAccuracy: r.ThrowAccuracyRating,
            throwAccuracyShort: r.ThrowAccuracyShortRating,
            throwAccuracyMid: r.ThrowAccuracyMidRating,
            throwAccuracyDeep: r.ThrowAccuracyDeepRating,
            throwOnTheRun: r.ThrowOnTheRunRating,
            throwUnderPressure: r.ThrowUnderPressureRating,
            playAction: r.PlayActionRating,
            breakSack: r.BreakSackRating,
            jumping: r.JumpingRating,
            kickPower: r.KickPowerRating,
            kickAccuracy: r.KickAccuracyRating,
        });
    }
    out.sort((a,b) => (a.round - b.round) || (a.pick - b.pick));

    fs.writeFileSync(output, JSON.stringify(out, null, 2));
    console.log(`Wrote ${out.length} rookie records to ${output}`);

    // Quick stats
    const r7 = out.filter(p => p.round === 7);
    if (r7.length) {
        const dispMax = Math.max(...r7.map(p => p.overallDisplayed));
        const dispMin = Math.min(...r7.map(p => p.overallDisplayed));
        const storedMax = Math.max(...r7.map(p => p.overallStored));
        console.log(`\nR7 (n=${r7.length}):`);
        console.log(`  stored OVR    range ${Math.min(...r7.map(p=>p.overallStored))}-${storedMax}`);
        console.log(`  displayed OVR range ${dispMin}-${dispMax} (max(OG))`);
        const inflated = r7.filter(p => p.overallDisplayed > p.overallStored + 1);
        console.log(`  inflated (display > stored+1): ${inflated.length}`);
        for (const p of inflated.slice(0, 10)) {
            console.log(`    R7#${p.pick} ${p.firstName} ${p.lastName} (${p.position}) stored=${p.overallStored} disp=${p.overallDisplayed} OG=[${p.overallGrades.join(',')}]`);
        }
    }
}

main().catch(err => { console.error(err); process.exit(1); });
