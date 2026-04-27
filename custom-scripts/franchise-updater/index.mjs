import FranchiseFile from '../../src/FranchiseFile.js';
import { applyScores } from './applyScores.mjs';
import { applyTransactions } from './applyTransactions.mjs';
import { importDraftClass, FRANCHISE_PATH as DRAFT_FRANCHISE_PATH } from '../draft-class/importDraftClass.mjs';
import { importFromDraftClass } from '../draft-class/importFromDraftClass.mjs';
import { applyRosters } from '../roster/applyRosters.mjs';
import { applyRatings } from '../roster/applyRatings.mjs';

const FRANCHISE_PATH =
    'C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-FRANCHISE';

const command = process.argv[2];

if (!command) {
    console.log('Usage:');
    console.log('  node index.mjs scores        — apply real-life game results');
    console.log('  node index.mjs transactions  — apply free agency / trades');
    console.log('  node index.mjs status        — show current season state');
    console.log('  node index.mjs contract <firstName> <lastName> <teamAbbr> <years> <salary0> [salary1] ...');
    console.log('                               — manually set a player contract');
    console.log('  node index.mjs draftclass <path-to-csv>');
    console.log('                               — import a custom draft class from a CSV file');
    console.log('  node index.mjs fromdraftclass <path-to-file.draftclass>');
    console.log('                               — import a Madden .draftclass file (M25/M26)');
    console.log('  node index.mjs roster [--roster <path-to-current_rosters.json>] [--output <path>]');
    console.log('                               — apply real-life team assignments + contracts');
    console.log('  node index.mjs ratings --source <path-to-source-file>');
    console.log('                               — copy player ratings from a reference roster/franchise file');
    process.exit(0);
}

// draftclass / fromdraftclass open their own file with autoUnempty: true
if (command === 'draftclass') {
    await importDraftClass(DRAFT_FRANCHISE_PATH, process.argv[3]);
    process.exit(0);
}

if (command === 'fromdraftclass') {
    const overwrite = process.argv.includes('--overwrite');
    await importFromDraftClass(DRAFT_FRANCHISE_PATH, process.argv[3], { overwrite });
    process.exit(0);
}

if (command === 'roster') {
    const rosterArg = process.argv.includes('--roster')
        ? process.argv[process.argv.indexOf('--roster') + 1]
        : undefined;
    const outputArg = process.argv.includes('--output')
        ? process.argv[process.argv.indexOf('--output') + 1]
        : undefined;
    await applyRosters(DRAFT_FRANCHISE_PATH, rosterArg, outputArg);
    process.exit(0);
}

if (command === 'ratings') {
    const sourceArg = process.argv.includes('--source')
        ? process.argv[process.argv.indexOf('--source') + 1]
        : undefined;
    await applyRatings(DRAFT_FRANCHISE_PATH, sourceArg);
    process.exit(0);
}

console.log(`Opening franchise file: ${FRANCHISE_PATH}\n`);
const file = await FranchiseFile.create(FRANCHISE_PATH);

switch (command) {
    case 'scores':
        await applyScores(file);
        break;

    case 'transactions':
        await applyTransactions(file);
        break;

    case 'status':
        await showStatus(file);
        break;

    case 'contract':
        await setContract(file, process.argv.slice(3));
        break;

    default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function showStatus(file) {
    const si = file.getTableByName('SeasonInfo');
    await si.readRecords([
        'CurrentWeek', 'CurrentWeekType', 'CurrentYear',
        'CurrentSeasonYear', 'CurrentStage'
    ]);
    const info = si.records[0];
    console.log('── Season Info ──────────────────────────');
    console.log('  Year:        ', info.CurrentYear);
    console.log('  Season Year: ', info.CurrentSeasonYear);
    console.log('  Stage:       ', info.CurrentStage);
    console.log('  Week Type:   ', info.CurrentWeekType);
    console.log('  Week:        ', info.CurrentWeek);

    const sgTable = file.getTableByName('SeasonGame');
    await sgTable.readRecords(['GameStatus', 'SeasonWeekType', 'ForceWin']);
    const total    = sgTable.records.filter(r => !r.isEmpty).length;
    const forced   = sgTable.records.filter(r => !r.isEmpty && r.ForceWin !== 'None').length;
    const complete = sgTable.records.filter(r => !r.isEmpty && ['HomeWon','AwayWon','Tied'].includes(r.GameStatus)).length;
    console.log('\n── Games ────────────────────────────────');
    console.log('  Total games:      ', total);
    console.log('  Force-win set:    ', forced);
    console.log('  Already complete: ', complete);
}

// node index.mjs contract "Saquon" "Barkley" "PHI" 3 13000000 13000000 13000000
async function setContract(file, args) {
    const [firstName, lastName, teamAbbr, yearsStr, ...salaryStrs] = args;
    if (!firstName || !lastName || !teamAbbr || !yearsStr) {
        console.error('Usage: contract <firstName> <lastName> <teamAbbr> <years> <salary0> [salary1...]');
        process.exit(1);
    }

    const years    = parseInt(yearsStr);
    const salaries = salaryStrs.map(Number);

    const playerTable = file.getTableByName('Player');
    await playerTable.readRecords([
        'FirstName', 'LastName', 'TeamIndex',
        'ContractStatus', 'ContractYear', 'ContractLength',
        'ContractSalary0', 'ContractSalary1', 'ContractSalary2',
        'ContractSalary3', 'ContractSalary4', 'ContractSalary5',
        'ContractSalary6', 'ContractSalary7',
    ]);

    const fn = firstName.toLowerCase();
    const ln = lastName.toLowerCase();
    const player = playerTable.records.find(r =>
        !r.isEmpty &&
        r.FirstName?.toLowerCase() === fn &&
        r.LastName?.toLowerCase() === ln
    );

    if (!player) {
        console.error(`Player not found: ${firstName} ${lastName}`);
        process.exit(1);
    }

    player.ContractLength = years;
    player.ContractYear   = 0;
    player.ContractStatus = 'Signed';

    for (let i = 0; i < years; i++) {
        const salary = salaries[i] ?? salaries[salaries.length - 1] ?? 0;
        player[`ContractSalary${i}`] = salary;
    }

    console.log(`Updated contract for ${firstName} ${lastName}:`);
    console.log(`  Years: ${years}`);
    console.log(`  Salaries: ${salaries.join(', ')}`);

    await file.save();
    console.log('Saved.');
}
