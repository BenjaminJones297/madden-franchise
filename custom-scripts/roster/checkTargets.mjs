import FranchiseFile from '../../src/FranchiseFile.js';
const FRANCHISE = 'C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-UPDATED';
const TEAMS = ['CHI','CIN','BUF','DEN','CLE','TB','ARI','LAC','KC','IND','DAL','MIA','PHI','ATL','SF','NYG','JAX','NYJ','DET','GB','CAR','NE','LV','LA','BAL','WAS','NO','SEA','PIT','TEN','MIN','HOU'];
const targets = [['Penei', 'Sewell'], ['Patrick', 'Surtain II'], ['Laremy', 'Tunsil']];
const file = await FranchiseFile.create(FRANCHISE, { gameYearOverride: 26 });
const tbl = file.getTableByName('Player');
await tbl.readRecords(['FirstName','LastName','Position','TeamIndex','ContractStatus','ContractLength','ContractSalary0','ContractBonus0']);
for (const [fn, ln] of targets) {
    const r = tbl.records.find(r => !r.isEmpty && r.FirstName === fn && r.LastName === ln);
    if (!r) { console.log(`NOT FOUND in franchise: ${fn} ${ln}`); continue; }
    const team = r.TeamIndex < 32 ? TEAMS[r.TeamIndex] : (r.TeamIndex === 32 ? 'FA' : '?');
    const capY0 = (r.ContractSalary0 + r.ContractBonus0);
    console.log(`${fn} ${ln} (${r.Position}) → ${team}  [${r.ContractStatus}]  Len=${r.ContractLength}  Y0=${capY0} ($${(capY0/100).toFixed(2)}M)`);
}
