# Contributing to OrkoWallet – Grin

Thank you for helping. This is a small, privacy-focused project; clear, small changes are the easiest to review.

## Ways to help

- **Report a bug** with the [bug template](../../issues/new?template=bug_report.md). Include your Windows version, the OrkoWallet version (Settings → About) and the last lines of `orkowallet.log` (Settings → About → Open the log folder). Remove anything private first.
- **Suggest an idea** with the [feature template](../../issues/new?template=feature_request.md).
- **Translate or correct a language.** See below; native speakers are especially welcome.
- **Send a fix** as a pull request.

Never post a recovery phrase, a password or a wallet file. For a security problem do **not** open a public issue; follow [SECURITY.md](SECURITY.md).

## Building

```powershell
pwsh scripts/fetch-tor.ps1
cd app; npm ci; npx tauri build
```

For quick UI work run a portable copy that does not touch your real wallets:

```powershell
$env:ORKOWALLET_DATA = "$env:TEMP\ow-dev"
cargo run --release --manifest-path app/src-tauri/Cargo.toml
```

Close the app and `tor.exe` before rebuilding (Windows locks the files).

## Code

- Rust: `cargo fmt`, no new warnings from `cargo clippy`. Keep wallet logic in `core/`; `app/src-tauri` is the thin layer between the interface and the core.
- Interface: plain HTML, CSS and JavaScript in `app/ui`, no frameworks and no remote content (the content security policy forbids it). Text always goes through `t()`.
- Money-related behaviour (sending, fees, confirmations, deleting wallets) needs a clear description of what you tested and on which network. Please do not test with real funds you cannot lose.

## Translations

The Turkish source text is the key. English lives in `app/ui/i18n.js`; the other languages are `app/ui/translations/<code>.json`.

```powershell
node scripts/export-i18n.js            # rewrites translations/source.json from the dictionary
node scripts/build-lang.js de fr ru zh # regenerates app/ui/lang-<code>.js
node scripts/check-i18n.js             # every key present, same {placeholders}, no empty values
```

Keep placeholders such as `{n}` exactly, keep leading and trailing spaces, and keep brand and technical terms (Grin, Tor, Slatepack, Snowflake, obfs4, Dandelion…). To add a language, add it to `LANGS`, `LOCALES` and `DICTS` in `i18n.js`, to `scripts/i18n-common.js`, to the language list in `index.html`, and to the allow-list in `save_settings` in `app/src-tauri/src/main.rs`.

## Pull requests

- One topic per pull request, with a short description of the problem and the fix.
- Update `CHANGELOG.md` for anything a user would notice.
- By contributing you agree that your work is licensed under the Apache-2.0 license of this project.

## Conduct

Be kind and assume good faith. Harassment and personal attacks are not welcome.
