// ESPN uses different abbreviations for a few teams — normalize them
// to match the franchise file's ShortName field
export const ESPN_TO_FRANCHISE_ABBR = {
    ARI: 'AZ',   // Arizona Cardinals
    WSH: 'WAS',  // Washington Commanders
};

export function normalizeEspnAbbr(abbr) {
    return ESPN_TO_FRANCHISE_ABBR[abbr] ?? abbr;
}

// Reads the Team table from the franchise file and returns two maps:
//   shortNameToIndex:  'PHI' -> 12
//   rowToTeamIndex:    rowNumber -> TeamIndex (for SeasonGame reference lookup)
export async function buildTeamMaps(file) {
    // Discover the Team table ID from the first real SeasonGame record
    const sgTable = file.getTableByName('SeasonGame');
    await sgTable.readRecords(['HomeTeam']);

    const firstReal = sgTable.records.find(r => {
        if (r.isEmpty) return false;
        const ref = r.getReferenceDataByKey('HomeTeam');
        return ref && ref.tableId > 0;
    });

    if (!firstReal) throw new Error('No SeasonGame with a valid HomeTeam reference found');

    const { tableId } = firstReal.getReferenceDataByKey('HomeTeam');
    const teamTable = file.getTableById(tableId);
    await teamTable.readRecords(['TeamIndex', 'ShortName']);

    const shortNameToIndex = {};
    const rowToTeamIndex = {};

    for (let i = 0; i < teamTable.records.length; i++) {
        const r = teamTable.records[i];
        if (r.isEmpty) continue;
        rowToTeamIndex[i] = r.TeamIndex;
        if (r.TeamIndex < 32 && r.ShortName) {
            shortNameToIndex[r.ShortName.trim()] = r.TeamIndex;
        }
    }

    return { shortNameToIndex, rowToTeamIndex, teamTableId: tableId };
}
