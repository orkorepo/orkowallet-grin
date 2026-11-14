// node scripts/export-i18n.js : writes app/ui/translations/source.json = [{ tr, en }] for the translators.
const { fs, path, ui, loadEN } = require('./i18n-common');
const EN = loadEN();
const rows = Object.keys(EN).map((tr) => ({ tr, en: EN[tr] }));
fs.mkdirSync(path.join(ui, 'translations'), { recursive: true });
fs.writeFileSync(path.join(ui, 'translations', 'source.json'), JSON.stringify(rows, null, 1));
console.log(rows.length + ' strings written to app/ui/translations/source.json');
