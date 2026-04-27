const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

// seasonType: 1=preseason, 2=regular, 3=postseason
export async function fetchWeekScores(seasonType, week, year = 2025) {
    const url = `${BASE}/scoreboard?seasontype=${seasonType}&week=${week}&dates=${year}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ESPN scoreboard fetch failed: ${res.status} (type=${seasonType} week=${week})`);
    const data = await res.json();
    return parseScoreboard(data, seasonType, week);
}

function parseScoreboard(data, seasonType, espnWeek) {
    return (data.events || []).map(event => {
        const comp = event.competitions[0];
        const home = comp.competitors.find(c => c.homeAway === 'home');
        const away = comp.competitors.find(c => c.homeAway === 'away');
        const completed = comp.status?.type?.completed ?? false;

        return {
            espnSeasonType: seasonType,
            espnWeek,
            homeTeam: home.team.abbreviation,
            awayTeam: away.team.abbreviation,
            homeScore: completed ? parseInt(home.score ?? '0') : 0,
            awayScore: completed ? parseInt(away.score ?? '0') : 0,
            completed,
        };
    });
}

// ESPN postseason week numbers for the 2025 season
const POSTSEASON_WEEKS = [1, 2, 3, 4]; // WC, Div, Conf, SB

export async function fetchAllScores(year = 2025) {
    const all = [];

    console.log('Fetching preseason scores...');
    for (let week = 1; week <= 4; week++) {
        const games = await fetchWeekScores(1, week, year);
        console.log(`  Preseason week ${week}: ${games.length} games`);
        all.push(...games);
    }

    console.log('Fetching regular season scores...');
    for (let week = 1; week <= 18; week++) {
        const games = await fetchWeekScores(2, week, year);
        console.log(`  Regular season week ${week}: ${games.length} games`);
        all.push(...games);
    }

    console.log('Fetching postseason scores...');
    for (const week of POSTSEASON_WEEKS) {
        const games = await fetchWeekScores(3, week, year);
        console.log(`  Postseason week ${week}: ${games.length} games`);
        all.push(...games);
    }

    return all;
}

// Franchise SeasonWeekType + SeasonWeek for a given ESPN season type + week
export function toFranchiseWeek(espnSeasonType, espnWeek) {
    switch (espnSeasonType) {
        case 1:
            return { weekType: 'PreSeason', seasonWeek: espnWeek - 1 };
        case 2:
            return { weekType: 'RegularSeason', seasonWeek: espnWeek - 1 };
        case 3:
            switch (espnWeek) {
                case 1: return { weekType: 'WildcardPlayoff',   seasonWeek: 18 };
                case 2: return { weekType: 'DivisionalPlayoff', seasonWeek: 19 };
                case 3: return { weekType: 'ConferencePlayoff', seasonWeek: 20 };
                case 4: return { weekType: 'SuperBowl',         seasonWeek: 22 };
                default: return null;
            }
        default:
            return null;
    }
}

// Fetch transactions (free agent signings, trades, releases)
// ESPN transactions endpoint — returns up to ~1000 entries per call
export async function fetchTransactions(year = 2025) {
    // FA period: roughly March through August before the season
    const startDate = `${year}0101`;
    const endDate   = `${year}0901`;
    const url = `${BASE}/transactions?limit=1000&dates=${startDate}-${endDate}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`ESPN transactions fetch failed: ${res.status}`);
    const data = await res.json();
    return parseTransactions(data);
}

function parseTransactions(data) {
    const items = data.transactions ?? data.items ?? [];
    return items.flatMap(entry => {
        // ESPN nests transactions differently depending on endpoint version
        const transactions = entry.transactions ?? [entry];
        return transactions.map(t => ({
            date: t.date ?? entry.date,
            type: t.type?.description ?? t.description ?? '',
            teamAbbr: t.team?.abbreviation ?? '',
            playerName: t.athlete?.fullName ?? t.athlete?.displayName ?? '',
            playerId: t.athlete?.id ?? null,
        }));
    }).filter(t => t.playerName);
}
