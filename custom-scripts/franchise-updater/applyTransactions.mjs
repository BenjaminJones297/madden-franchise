import { buildTeamMaps, normalizeEspnAbbr } from './teamMap.mjs';
import { fetchTransactions } from './espnClient.mjs';

// Transaction type strings that indicate a free agent signing
const SIGNING_KEYWORDS = ['signed', 'agrees to', 'contract'];
const RELEASE_KEYWORDS = ['released', 'waived', 'cut'];
const TRADE_KEYWORDS   = ['traded', 'acquired'];

export async function applyTransactions(file) {
    // 1. Build team map
    console.log('Building team maps...');
    const { shortNameToIndex } = await buildTeamMaps(file);

    // 2. Fetch transactions
    console.log('Fetching ESPN transactions...');
    const transactions = await fetchTransactions(2025);
    console.log(`Fetched ${transactions.length} transactions`);

    // 3. Load all players
    console.log('Reading Player table...');
    const playerTable = file.getTableByName('Player');
    await playerTable.readRecords([
        'FirstName', 'LastName', 'TeamIndex',
        'ContractStatus', 'ContractYear', 'ContractLength',
        'ContractSalary0', 'ContractSalary1', 'ContractSalary2',
        'ContractBonus0', 'YearsPro', 'Age'
    ]);

    // Build a name lookup: "FirstName LastName" -> record[]
    // (multiple players can share a name, so we keep an array)
    const playersByName = {};
    for (const r of playerTable.records) {
        if (r.isEmpty) continue;
        const key = normalizeName(`${r.FirstName} ${r.LastName}`);
        if (!playersByName[key]) playersByName[key] = [];
        playersByName[key].push(r);
    }

    // 4. Apply each transaction
    let applied = 0;
    let playerNotFound = 0;
    let teamNotFound = 0;
    let skipped = 0;

    for (const txn of transactions) {
        const typeLower = txn.type.toLowerCase();
        const isSigning = SIGNING_KEYWORDS.some(k => typeLower.includes(k));
        const isRelease = RELEASE_KEYWORDS.some(k => typeLower.includes(k));
        const isTrade   = TRADE_KEYWORDS.some(k => typeLower.includes(k));

        if (!isSigning && !isRelease && !isTrade) {
            skipped++;
            continue;
        }

        const nameKey = normalizeName(txn.playerName);
        const matches = playersByName[nameKey];
        if (!matches || matches.length === 0) {
            console.warn(`  Player not found: "${txn.playerName}"`);
            playerNotFound++;
            continue;
        }

        if (isRelease) {
            // Move player to free agency
            for (const player of matches) {
                player.TeamIndex = 32;
                player.ContractStatus = 'FreeAgent';
            }
            applied++;
            continue;
        }

        if (isSigning || isTrade) {
            const teamAbbr = normalizeEspnAbbr(txn.teamAbbr);
            const teamIndex = shortNameToIndex[teamAbbr];

            if (teamIndex === undefined) {
                console.warn(`  Unknown team abbreviation: "${txn.teamAbbr}" for player "${txn.playerName}"`);
                teamNotFound++;
                continue;
            }

            // If multiple players share a name, move the one currently on a
            // different team (or a free agent) — prefer free agents first
            const player =
                matches.find(p => p.ContractStatus === 'FreeAgent') ??
                matches.find(p => p.TeamIndex !== teamIndex) ??
                matches[0];

            player.TeamIndex = teamIndex;
            player.ContractStatus = 'Signed';

            // Reset contract year to 0 (start of new deal)
            // Contract length and salary must be set manually via the
            // setContract helper or by editing the file — ESPN doesn't
            // provide full contract details in the transactions feed
            player.ContractYear = 0;

            applied++;
        }
    }

    console.log(`\nTransactions applied:`);
    console.log(`  Applied: ${applied}`);
    console.log(`  Player not found: ${playerNotFound}`);
    console.log(`  Team not found: ${teamNotFound}`);
    console.log(`  Skipped (other type): ${skipped}`);

    console.log('\nSaving franchise file...');
    await file.save();
    console.log('Saved.');
    console.log('\nNote: Contract lengths and salaries were NOT set automatically.');
    console.log('Use the setContract() helper in index.mjs to set specific contracts.');
}

function normalizeName(name) {
    return name
        .toLowerCase()
        .replace(/[.''-]/g, '')  // strip punctuation
        .replace(/\s+/g, ' ')
        .trim();
}
