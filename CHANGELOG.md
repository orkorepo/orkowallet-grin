# Changelog

## 0.1.2 – 2026-11-16

- Settings → Repair: reset the Tor connection (forgets Tor's saved state) and restart the app; wallets and balances are not touched
- Tor restarts from a clean state on its own once if the wallet address stays unreachable for four minutes; a hint appears on the Tor card after about two and a half minutes
- A leftover tor.exe on the same data folder is stopped before Tor starts
- Only one copy of the app can run; a second launch brings the first window to the front
- Unfinished Slatepack exchanges can be continued from the transaction list: the text can be copied again and the recipient's reply pasted to finish
- A wallet can be deleted from the wallet list without opening it (confirm with the wallet name)
- Publisher shown in the file properties is now "Orko"

## 0.1.1

- New wallets can be created with a 12- or 24-word recovery phrase (restore already accepted 12 to 24 words)
- "Max" button in Send: sends the whole spendable balance, the network fee is taken from it
- Settings: number of confirmations needed to spend (1 to 10, default 10), one setting for all wallets
- Drop-down lists follow the light and dark theme
- Settings → About: Donate
- Minimum wallet password length is 4 characters

## 0.1.0 – first public release

- Wallet core on the official grin-wallet 5.5.1 / grin 5.5.2 libraries
- Built-in Tor (0.4.9) with obfs4 / Snowflake / webtunnel bridges; send and receive over Tor, with automatic retry when the recipient is offline
- Public node pool with failover and health ordering, or the built-in node
- Multiple wallets and accounts, mainnet / testnet, restore from phrase, import grin-wallet / Grim folders
- Slatepack send and receive, transaction history with paging, CSV export, wallet backup
- Screen lock with auto-lock and brute-force throttle, recovery-phrase screen protected from screen capture
- Interface in six languages: Türkçe, English, Deutsch, Français, Русский, 简体中文
- Windows installer (NSIS, per-user)
