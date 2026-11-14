// node scripts/check-i18n.js [de fr ru zh] : every Turkish key present, placeholders identical, nothing empty.
const { fs, path, ui, loadEN, LANGS } = require('./i18n-common');
const EN = loadEN();
const keys = Object.keys(EN);
const ph = (s) => (s.match(/\{[A-Za-z_0-9]+\}/g) || []).sort().join(',');
let bad = 0;
for (const code of (process.argv.length > 2 ? process.argv.slice(2) : Object.keys(LANGS))) {
  const file = path.join(ui, 'translations', code + '.json');
  if (!fs.existsSync(file)) { console.log(`${code}: translations/${code}.json is missing`); bad++; continue; }
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = [];
  for (const k of keys) {
    const v = map[k];
    if (v === undefined) { problems.push('MISSING  ' + k.slice(0, 70)); continue; }
    if (typeof v !== 'string' || !v.trim()) { problems.push('EMPTY    ' + k.slice(0, 70)); continue; }
    if (ph(k) !== ph(v)) problems.push(`PLACEHOLDERS differ (${ph(k)} vs ${ph(v)}): ` + k.slice(0, 60));
    if (/^\s/.test(k) !== /^\s/.test(v) || /\s$/.test(k) !== /\s$/.test(v)) problems.push('LEADING/TRAILING SPACE differs: ' + JSON.stringify(k.slice(0, 50)));
    if (code === 'ru' && /[ğĞıİşŞçÇöÖüÜ]/.test(v)) problems.push('TURKISH LETTERS left: ' + v.slice(0, 60));
    if ((code === 'ru' || code === 'zh') && v === EN[k] && /[A-Za-z]{4,}/.test(v) && v.length > 14) problems.push('LOOKS UNTRANSLATED (same as English): ' + v.slice(0, 60));
  }
  for (const k of Object.keys(map)) if (!(k in EN)) problems.push('EXTRA KEY ' + k.slice(0, 70));
  console.log(`${code}: ${problems.length ? problems.length + ' problem(s)' : 'OK (' + keys.length + ' strings)'}`);
  problems.slice(0, 40).forEach((p) => console.log('   ' + p));
  bad += problems.length;
}
process.exit(bad ? 1 : 0);
