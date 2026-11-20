# Changelog

## 0.3.1 – 2026-11-20

- **Import = recovery phrase.** "Import" now takes the recovery phrase (it used to take a wallet folder). The words go into numbered boxes (12, 15, 18, 21 or 24), with a **Paste** button that spreads a copied phrase over the boxes by itself (numbers and line breaks are ignored); a **Clear** button empties them
- **Restore = wallet folder** (desktop only), renamed "Restore from folder". The phone app only has Import, the folder option is gone there
- **Lock and Log out work differently.** Lock puts the whole app behind the password (the wallet keeps running). Log out no longer locks or closes anything: it takes you to the wallet list while the wallet stays open in the background (Tor and receiving keep working, also the Android service); "Enter" on the list returns to it without a password, "Close" closes it completely. Opening or creating another wallet closes the one waiting in the background. The lock screen has a "Close wallet" link for a forgotten password
- Auto-lock can now be set to 3, 6 or 12 hours. It also applies while a wallet waits in the background
- Logging out while a chain scan runs no longer restarts the app
- Desktop: the Close (X) button now asks whether to quit completely or minimize (to the tray), with a "don't ask again" box; the choice can be changed in Settings → General
- Android: new app icon (the Orko ghost on black) instead of the placeholder; the Paste button reads the clipboard through Android directly
- New texts translated into all six languages


## 0.3.0 – 2026-11-20

- **Android app (first release).** The same wallet now runs on Android phones (arm64, Android 7 and newer) as a signed APK on the Releases page. Tor is built in (the official Tor Expert Bundle for Android), so sending and receiving over Tor works the same way as on the desktop
- Android keeps receiving in the background: while a wallet is open a small ongoing notification ("OrkoWallet is running") keeps the app and its Tor address alive, also with the screen off and in Android's deep sleep. The Back button sends the app to the background instead of closing it. Logging out of the wallet stops the service. Payment and Tor notifications work on Android; Android asks for the notification permission the first time you open a wallet
- **Recovery phrase in Settings → Backup.** A new "Recovery phrase" box shows the words after you type your password, with a clear warning (write it on paper, no screenshots, anyone who knows it can take the money). The window is hidden from screen capture while the words are visible; on Android the screen is protected against screenshots and screen recording at that moment. It is also still available under Wallet settings → Security
- Fixed: the cards in Wallet settings (and other panels) could be wider than the window when the window was made smaller, so a button or a drop-down was cut off or the page scrolled sideways. They now always fit, on the desktop at any window size and on phones
- Tor on the desktop is more robust while the window sits in the system tray: tor is started again by itself if it stops, it is restarted with fresh circuits when the computer wakes from sleep, the clean restart of an unreachable address can now repeat (at most every 15 minutes) instead of once per session, and Windows is asked not to put the wallet and its Tor into power-saving ("efficiency") mode
- The "keep running in the system tray" option is hidden on phones, where it has no meaning
- New texts translated into all six languages

## 0.2.0 – 2026-11-18

- New black-and-yellow look (Grin colours) is now the default. The blue Orko colours stay available under Settings → General → Colour; light and dark themes work with both. The app icon and the logo inside the app follow the new colours
- Desktop notifications: a payment arrives or is confirmed, your payment is confirmed, and the Tor address stops answering for a minute (and again when it is back). Switch each on or off in Settings → General; "Send a test notification" shows how they look. Amounts are not shown while the wallet is locked. They work while the window is hidden in the tray
- System tray: the close button hides the window to the tray and the wallet keeps running, receiving and notifying; right-click the tray icon to open or quit. A one-time notice explains it. Can be switched off in Settings → General (then the close button quits as before)
- Transaction details: an icon next to the kernel opens it in the Grin Scan block explorer (mainnet, default browser)
- Smaller window: opens at 1180 × 740 and can be made much smaller (down to 480 × 600). Below about 1140 px wide the interface switches to a compact one-column layout with bottom tabs (Wallet, Tor, Node) and touch-sized controls; the window buttons stay. This is also the basis for a phone version
- New texts translated into all six languages

## 0.1.3 – 2026-11-17

- Deleting a wallet is now recoverable: its encrypted key file is kept for 30 days in a "Recently deleted" list on the wallet screen, from where it can be restored (the balance is scanned again) or removed for good. If the key file cannot be copied first, the deletion is cancelled
- Settings → Repair → Connection diagnosis: checks the internet connection, the computer clock, whether the network lets Tor through, Tor's own state and known problems in the log, then suggests the next step; the result can be copied for a bug report. It changes nothing and sends no wallet data
- New texts translated into all six languages

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
