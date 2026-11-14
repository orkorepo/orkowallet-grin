// Shared by the i18n scripts: reads the Turkish->English dictionary out of app/ui/i18n.js.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const ui = path.join(root, 'app', 'ui');
function loadEN() {
  const src = fs.readFileSync(path.join(ui, 'i18n.js'), 'utf8');
  return new Function('return ' + src.match(/const EN = (\{[\s\S]*?\n\});/)[1])();
}
const LANGS = { de: 'LANG_DE', fr: 'LANG_FR', ru: 'LANG_RU', zh: 'LANG_ZH' };
module.exports = { fs, path, root, ui, loadEN, LANGS };
