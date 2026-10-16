const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.join(__dirname, '..', 'geofs-defensive-ai.user.js');
const start = '    // BEGIN GENERATED MISSILE DATABASE';
const end = '    // END GENERATED MISSILE DATABASE';
const source = fs.readFileSync(scriptPath, 'utf8');
const first = source.indexOf(start);
const last = source.indexOf(end, first);
if (first < 0 || last < first) throw new Error('Missing missile database markers');

const window = { __GeoFSDefenseAI_NOAUTO: true };
vm.runInNewContext(source, { window });
const normalize = window.__GeoFSDefenseAI.normalize;
const classes = {
    Infrared: 'ir',
    'Semi-Active Radar Homing': 'radar',
    'Active Radar Homing': 'radar',
    'Mixed / Multiple': 'mixed',
    'None / N/A': 'beam'
};
const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'master_missile_database.json'), 'utf8'));
const rows = records.map(record => {
    const cls = classes[record.guidance];
    if (!cls) throw new Error('Unsupported guidance for ' + record.official_name + ': ' + record.guidance);
    const aliases = [...new Set([record.official_name, ...record.aliases].map(normalize))].filter(Boolean).sort();
    return '        ' + JSON.stringify([record.official_name, cls, aliases]);
});
const generated = start + '\n    const MISSILE_DATABASE = [\n' + rows.join(',\n') + '\n    ];\n' + end;
const output = source.slice(0, first) + generated + source.slice(last + end.length);
if (process.argv.includes('--check')) {
    if (output !== source) throw new Error('Embedded missile database is stale; run node missiledb\\embed.cjs');
} else {
    fs.writeFileSync(scriptPath, output);
}
console.log('Embedded missile records: ' + records.length);
