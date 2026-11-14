// node scripts/build-lang.js de fr ru zh : turns app/ui/translations/<code>.json ({ turkish: translation })
// into app/ui/lang-<code>.js (escaped with JSON.stringify, so quotes can never break the file).
const { fs, path, ui, LANGS } = require('./i18n-common');
const names = { de: 'Deutsch', fr: 'Français', ru: 'Русский', zh: '简体中文' };
for (const code of process.argv.slice(2)) {
  if (!LANGS[code]) { console.error('unknown language ' + code); process.exit(1); }
  const map = JSON.parse(fs.readFileSync(path.join(ui, 'translations', code + '.json'), 'utf8'));
  const body = Object.entries(map).map(([k, v]) => '  ' + JSON.stringify(k) + ': ' + JSON.stringify(v) + ',').join('\n');
  fs.writeFileSync(path.join(ui, 'lang-' + code + '.js'),
    `// ${names[code]} (${code}): translation of the OrkoWallet interface. Keys are the Turkish source text.\n'use strict';\nconst ${LANGS[code]} = {\n${body}\n};\n`);
  console.log('lang-' + code + '.js written (' + Object.keys(map).length + ' strings)');
}
