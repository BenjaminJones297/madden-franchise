/**
 * restoreVisuals.mjs — fix vets whose CharacterVisuals row was emptied
 * (isEmpty=true) when Madden's auto-sim retired them. The row's RawData
 * JSON blob is intact in our save AND in CAREER-OFFICIAL — only the row's
 * 8-byte _data header has the "free-list" bytes set, which makes Madden
 * treat the row as deleted. We overwrite the header bytes from the source
 * file so the row reads as valid again.
 */

import FranchiseFile from '../src/FranchiseFile.js';
import path from 'path';

const TARGET_PATH = process.argv[2] || 'C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-SEAHAWKS-START-AUTOSAVE';
const SOURCE_PATH = process.argv[3] || 'C:/Users/benja/OneDrive/Documents/Madden NFL 26/saves/CAREER-OFFICIAL';

const TEAMS = ['CHI','CIN','BUF','DEN','CLE','TB','ARI','LAC','KC','IND','DAL','MIA','PHI','ATL','SF','NYG','JAX','NYJ','DET','GB','CAR','NE','LV','LA','BAL','WAS','NO','SEA','PIT','TEN','MIN','HOU'];

console.log(`Target: ${TARGET_PATH}`);
console.log(`Source: ${SOURCE_PATH}`);

const srcFile = await FranchiseFile.create(SOURCE_PATH);
const srcVis  = srcFile.getTableByName('CharacterVisuals');
await srcVis.readRecords();

const dstFile = await FranchiseFile.create(TARGET_PATH);
const dstPt   = dstFile.getTableByName('Player');
await dstPt.readRecords();
const dstVis  = dstFile.getTableByName('CharacterVisuals');
await dstVis.readRecords();

function deref(rec) {
    const fields = Object.values(rec._fields || {});
    const f = fields.find(x => x._offset && x._offset.name === 'CharacterVisuals');
    return f ? f.referenceData : null;
}

let onTeamVets = 0, fixed = 0, skipMissing = 0, log = [];
for (const r of dstPt.records) {
    if (r.isEmpty) continue;
    if (typeof r.TeamIndex !== 'number' || r.TeamIndex >= 32) continue;
    if (r.YearsPro === 0) continue;
    onTeamVets++;
    const ref = deref(r);
    if (!ref || ref.tableId === 0) continue;
    const dstRow = dstVis.records[ref.rowNumber];
    if (!dstRow) continue;
    if (!dstRow.isEmpty) continue;   // row already valid
    const srcRow = srcVis.records[ref.rowNumber];
    if (!srcRow || srcRow.isEmpty) {
        skipMissing++;
        continue;
    }
    // Overwrite dst row's 8-byte header with src's bytes — flips the row
    // from "free-listed/deleted" back to valid while preserving the table3
    // RawData JSON blob (which is the same in both files).
    srcRow._data.copy(dstRow._data);
    dstRow._isChanged = true;
    fixed++;
    log.push(`  ${(r.FirstName + ' ' + r.LastName).padEnd(28)} ${r.Position.padEnd(5)} ${TEAMS[r.TeamIndex].padEnd(4)} OVR=${r.OverallRating}  row=${ref.rowNumber}`);
}

console.log(`\nOn-team vets: ${onTeamVets}`);
console.log(`Empty-row visuals fixed: ${fixed}`);
console.log(`Skipped (source also empty): ${skipMissing}`);
if (log.length) {
    console.log('\nFixed players:');
    for (const l of log) console.log(l);
}

if (fixed > 0) {
    console.log('\nSaving target file...');
    await dstFile.save();
    console.log('Saved.');
}
