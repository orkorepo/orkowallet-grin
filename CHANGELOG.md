# Changelog

## 0.3.2 – 2026-11-24 · The big update

- **Linux and macOS.** The desktop app is now built for Linux (`.deb`, `.AppImage`) and macOS (`.dmg`, Apple Silicon and Intel) by the same public GitHub workflow as Windows, with the same features. Tor comes from the Tor Project's permanent archive (the old download address only keeps the newest releases): pinned SHA-256 for Windows, the Tor Project's GPG-signed hash list for Linux and macOS. Opening the log folder and the kernel link work on every desktop. The macOS app is not signed with a paid Apple Developer ID; the README explains how to open it
- **Remove an account from the list.** Settings → Wallet → Accounts: "Remove from list" only hides an account (its money and address stay; "Show hidden accounts" brings it back). Deleting a wallet stays a separate step with its own warning
- **Phone: pull down to refresh** the wallet, the wallet list or the node panel
- **Connection mode in Settings → General** as well (With Tor / Slatepack only), not only on the Tor card
- **Repair (rescan) on testnet** also offers the years (counted back from the chain height)
- Fixed: Android closed but did not start again after a network change, a connection repair or closing a wallet during a scan; it now restarts by itself
- Fixed: the Settings window could scroll sideways on the desktop
- Fixed: the health dots in the node list were always grey
- **One Settings window, in categories.** Settings, Wallet settings and Node settings are now a single window with the same eight categories on the desktop and the phone: General, Wallet, Security, Sending, Node, Backup, Maintenance and repair, About. On the desktop the categories are on the left; on the phone Settings opens as a list of categories, a tap opens one, the back arrow returns. The wallet card shows only the transactions, with a "Wallet settings" button that opens Settings → Wallet (name, accounts, delete). The node connection is chosen with three large options in Settings → Node
- **Android: "Close wallet" in the notification.** The ongoing notification has a button that closes the wallet and Tor cleanly and quits the app. Settings → General has the same button on the phone
- **Android: fixed scrolling.** On the phone the last part of long pages (wallet settings, the transaction list and others) stayed hidden behind the bottom tabs and could not be scrolled into view. Pages now scroll to the end, and a round button shows when a page goes on below (at the bottom it takes you back to the top)
- **Android: the kernel link opens Grin Scan** in the browser (it did nothing before)
- **Node panel:** "Node settings", "Run your own node" and the hash buttons are now clearly buttons (large on the phone)
- **"Max" is instant:** the amount is worked out when the Send window opens, from the wallet's own records; sending still checks it against the node
- **Repair (rescan)** now starts with the current year selected (the fastest choice); "from the start" is the last option. Importing with a recovery phrase still starts with "I don't know: from the start"
- Transactions found by a chain scan (after importing with the recovery phrase, or a rescan) are labelled "Found by scan" instead of "Received", with a note: a scan cannot see outgoing payments, so a restored wallet, or the same wallet used on a second device, shows only what that device knows
- **Same wallet on two devices: "Spent on another device".** Grin keeps a payment's history only on the device that made it. When money of this wallet is spent on another device (same recovery phrase), the history now shows a "Spent on another device" entry with the amount and when this device noticed it (outputs noticed together form one entry; the recipient and fee are only known on the other device). A short background scan then looks for the change, which appears as "Found by scan". A warning on the balance card explains the risks of keeping the same wallet open on two devices and suggests a separate account on the second one. Detection compares the outputs the chain shows as spent with the inputs of this device's own sends (from their stored transaction files), so this device's own payments are never reported
- **Slatepack only mode (no Tor).** The Tor card has a switch: "With Tor" or "Slatepack only". In Slatepack only mode Tor does not run at all (no onion service, no Tor sends, no reply over Tor, no automatic Tor restarts, no "Tor lost" notifications); payments go and come as Slatepack texts, and the Send window offers only Slatepack. The choice is saved and applies at once to the open wallet (with the integrated Arti engine, when the wallet is opened again). The node connection still uses the internet
- New texts translated into all six languages

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
