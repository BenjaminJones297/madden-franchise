import { buildTeamMaps, normalizeEspnAbbr } from './teamMap.mjs';
import { fetchAllScores, toFranchiseWeek } from './espnClient.mjs';

const FRANCHISE_PATH = 'C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-FRANCHISE';

export async function applyScores(file) {
    // 1. Build team reference map
    console.log('Building team maps...');
    const { shortNameToIndex, rowToTeamIndex } = await buildTeamMaps(file);

    // 2. Fetch all ESPN scores
    const espnGames = await fetchAllScores(2025);
    console.log(`\nFetched ${espnGames.length} total ESPN games`);

    // 3. Load all SeasonGame records
    console.log('Reading SeasonGame table...');
    const sgTable = file.getTableByName('SeasonGame');
    await sgTable.readRecords([
        'HomeTeam', 'AwayTeam',
        'SeasonWeek', 'SeasonWeekType',
        'HomeScore', 'AwayScore',
        'ForceWin', 'GameStatus'
    ]);

    // Build an index: "WeekType_SeasonWeek" -> list of SeasonGame records
    const gameIndex = {};
    for (const r of sgTable.records) {
        if (r.isEmpty) continue;
        const key = `${r.SeasonWeekType}_${r.SeasonWeek}`;
        if (!gameIndex[key]) gameIndex[key] = [];
        gameIndex[key].push(r);
    }

    // 4. Match and apply
    let matched = 0;
    let skipped = 0;
    let notFound = 0;

    for (const game of espnGames) {
        if (!game.completed) {
            skipped++;
            continue;
        }

        const fw = toFranchiseWeek(game.espnSeasonType, game.espnWeek);
        if (!fw) { skipped++; continue; }

        const homeAbbr  = normalizeEspnAbbr(game.homeTeam);
        const awayAbbr  = normalizeEspnAbbr(game.awayTeam);
        const homeIndex = shortNameToIndex[homeAbbr];
        const awayIndex = shortNameToIndex[awayAbbr];

        if (homeIndex === undefined || awayIndex === undefined) {
            console.warn(`  Could not resolve team: ${game.homeTeam} vs ${game.awayTeam}`);
            skipped++;
            continue;
        }

        const key = `${fw.weekType}_${fw.seasonWeek}`;
        const candidates = gameIndex[key] ?? [];

        const franchiseGame = candidates.find(r => {
            const homeRef = r.getReferenceDataByKey('HomeTeam');
            const awayRef = r.getReferenceDataByKey('AwayTeam');
            return (
                rowToTeamIndex[homeRef.rowNumber] === homeIndex &&
                rowToTeamIndex[awayRef.rowNumber] === awayIndex
            );
        });

        if (!franchiseGame) {
            console.warn(`  No franchise match for ${game.homeTeam} vs ${game.awayTeam} (${fw.weekType} week ${fw.seasonWeek})`);
            notFound++;
            continue;
        }

        // Set scores and force the correct winner
        franchiseGame.HomeScore = game.homeScore;
        franchiseGame.AwayScore = game.awayScore;

        if (game.homeScore > game.awayScore) {
            franchiseGame.ForceWin = 'Home';
        } else if (game.awayScore > game.homeScore) {
            franchiseGame.ForceWin = 'Away';
        } else {
            franchiseGame.ForceWin = 'None'; // tie
        }

        matched++;
    }

    console.log(`\nScores applied:`);
    console.log(`  Matched and updated: ${matched}`);
    console.log(`  Skipped (not yet played): ${skipped}`);
    console.log(`  Not found in franchise: ${notFound}`);

    // 5. Save
    console.log('\nSaving franchise file...');
    await file.save();
    console.log('Saved.');
}
