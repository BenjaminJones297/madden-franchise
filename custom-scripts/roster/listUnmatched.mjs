/**
 * listUnmatched.mjs — list players in the franchise not found in current_rosters.json,
 * with their TeamIndex and OverallRating so we can tell real-NFL vets from
 * Madden-generated fill players.
 */
import fs from 'fs';
import FranchiseFile from '../../src/FranchiseFile.js';

const FRANCHISE = 'C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-UPDATED';
const ROSTER    = 'C:/Users/benja/repos/madden-draft-class-generator/data/current_rosters.json';

const TEAMS = [
    'CHI','CIN','BUF','DEN','CLE','TB','ARI','LAC','KC','IND','DAL','MIA',
    'PHI','ATL','SF','NYG','JAX','NYJ','DET','GB','CAR','NE','LV','LA',
    'BAL','WAS','NO','SEA','PIT','TEN','MIN','HOU',
];

const norm = (n) => (n || '')
    .toLowerCase()
    .replace(/\s+(ii|iii|iv|v|jr|sr)\.?$/i, '')
    .replace(/[^a-z]/g, '');

const players = JSON.parse(fs.readFileSync(ROSTER, 'utf8'));
const rosterKeys = new Set(players.map(p => norm(p.fullName || `${p.firstName} ${p.lastName}`)));

const file = await FranchiseFile.create(FRANCHISE, { gameYearOverride: 26 });
const table = file.getTableByName('Player');
await table.readRecords(['FirstName', 'LastName', 'Position', 'ContractStatus', 'TeamIndex', 'OverallRating']);

const missed = [];
for (const r of table.records) {
    if (r.isEmpty) continue;
    if (r.ContractStatus === 'Draft') continue;
    const fullName = `${r.FirstName || ''} ${r.LastName || ''}`.trim();
    const key = norm(fullName);
    if (!key) continue;
    if (rosterKeys.has(key)) continue;
    missed.push({
        name:    fullName,
        pos:     r.Position,
        team:    r.TeamIndex >= 0 && r.TeamIndex < 32 ? TEAMS[r.TeamIndex] : (r.TeamIndex === 32 ? 'FA' : `?${r.TeamIndex}`),
        ovr:     r.OverallRating,
        status:  r.ContractStatus,
    });
}

missed.sort((a, b) => b.ovr - a.ovr);

console.log(`\nTotal unmatched: ${missed.length}\n`);
console.log('Top 60 by OVR (likely real NFL players missed by name-match):\n');
console.log('OVR  TEAM  POS   STATUS       NAME');
console.log('---  ----  ----  -----------  --------------------------');
for (const m of missed.slice(0, 60)) {
    console.log(`${String(m.ovr).padStart(3)}  ${m.team.padEnd(4)}  ${(m.pos || '').padEnd(4)}  ${(m.status || '').padEnd(11)}  ${m.name}`);
}

// Write full list
fs.writeFileSync('unmatched_players.json', JSON.stringify(missed, null, 2));
console.log(`\nFull list written to unmatched_players.json (${missed.length} entries)`);
