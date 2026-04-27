/**
 * inspectContracts.mjs - read a few players' ContractSalary0..7 / ContractBonus0..7
 * values from a reference franchise to understand Madden's native scale.
 */
import FranchiseFile from '../../src/FranchiseFile.js';

const SOURCE = 'C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-UPDATED';
const NAMES  = ['Mahomes', 'Sweat', 'Prescott', 'Allen', 'Hill', 'Barkley', 'Watt'];

const file = await FranchiseFile.create(SOURCE, { gameYearOverride: 26 });
const players = file.getTableByName('Player');
const fields = [
    'FirstName', 'LastName', 'Position', 'ContractLength', 'ContractYear',
    ...Array.from({ length: 8 }, (_, i) => `ContractSalary${i}`),
    ...Array.from({ length: 8 }, (_, i) => `ContractBonus${i}`),
];
await players.readRecords(fields);

for (const r of players.records) {
    if (r.isEmpty) continue;
    if (!NAMES.some(n => r.LastName === n)) continue;
    const sals = Array.from({ length: 8 }, (_, i) => r[`ContractSalary${i}`]);
    const bons = Array.from({ length: 8 }, (_, i) => r[`ContractBonus${i}`]);
    const capY0 = sals[0] + bons[0];
    console.log(`${r.FirstName} ${r.LastName} (${r.Position}) Len=${r.ContractLength} Yr=${r.ContractYear}`);
    console.log(`  Salary: ${sals.join(', ')}`);
    console.log(`  Bonus : ${bons.join(', ')}`);
    console.log(`  Y0 cap hit raw: ${capY0}  (= ${capY0}K ≈ $${(capY0/1000).toFixed(2)}M if unit=thousands)`);
    console.log();
}
