# Security

## Reporting a vulnerability
Email info@orkoswap.io (PGP key to be published) with details and a way to reproduce. Please do not open a public issue for vulnerabilities. We aim to answer within 72 hours.

## What the wallet protects
- **Keys never leave this computer.** The seed is encrypted by grin-wallet's own storage with your password. The recovery phrase is shown only after the password is entered again, and the window is excluded from screenshots and screen recording while it is on screen.
- **Screen lock is enforced in the backend**, not only in the UI: while locked, every command that reads or spends wallet data is refused until the password is verified.
- **Password attempts are throttled** after the third wrong one (up to 30 s per attempt).
- **No remote content.** The UI is bundled; the Content Security Policy allows only local scripts, styles and IPC (`object-src`, `base-uri`, `form-action`, `frame-ancestors` are `none`).
- **Tor** runs as a child of the app and exits with it (`__OwningControllerProcess`); its SOCKS port listens on 127.0.0.1 on a random port; no control port is opened.
- **Node answers are untrusted.** Wallet logic stays in the official libraries; the node pool only retries and switches nodes.
- Release builds use `overflow-checks`, `strip` and LTO; dependencies are pinned in `Cargo.lock`; the Tor bundle is verified by SHA-256 and the Tor Project signature.

## What it does not protect against
Malware running as your user (it can read process memory and the clipboard), a compromised OS, someone with your password and your files, or losing the recovery phrase. While the screen is locked the wallet keeps running so payments arrive; use **Log out** to close it completely.

## Known limits
Public nodes can see which wallet queries come from your IP when you do not use Tor for node traffic; run the built-in node for full privacy. The app is not yet code-signed.