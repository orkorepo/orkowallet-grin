# Download the Tor Expert Bundle into vendor/tor-<version>, verifying SHA-256 and the Tor Project signature.
# Usage: pwsh scripts/fetch-tor.ps1
$ErrorActionPreference = 'Stop'
$ver = '16.0.1'
$sha256 = '9eed3c3ff1fe43df034ce360196c9ec95472560d77ff55614d0cd5120edea27b'
$key = 'EF6E286DDA85EA2A4BA7DE684E2C6E8793298290'   # Tor Browser Developers signing key
$base = "https://dist.torproject.org/torbrowser/$ver"
$name = "tor-expert-bundle-windows-x86_64-$ver.tar.gz"
$vendor = Join-Path $PSScriptRoot '..\vendor'
$dl = Join-Path $vendor "download-tor-$ver"
New-Item -ItemType Directory -Force $dl | Out-Null
foreach ($f in $name, "$name.asc") { Invoke-WebRequest "$base/$f" -OutFile (Join-Path $dl $f) -UseBasicParsing }
$got = (Get-FileHash (Join-Path $dl $name) -Algorithm SHA256).Hash.ToLower()
if ($got -ne $sha256) { throw "SHA-256 mismatch: $got" }
if (Get-Command gpg -ErrorAction SilentlyContinue) {
  gpg --auto-key-locate nodefault,wkd --locate-keys torbrowser@torproject.org | Out-Null
  $out = gpg --status-fd 1 --verify (Join-Path $dl "$name.asc") (Join-Path $dl $name) 2>&1 | Out-String
  if ($out -notmatch 'GOODSIG' -or $out -notmatch $key) { throw "GPG signature check failed" }
} else { Write-Warning 'gpg not found: only the SHA-256 was verified.' }
$dest = Join-Path $vendor "tor-$ver"
New-Item -ItemType Directory -Force $dest | Out-Null
tar -xzf (Join-Path $dl $name) -C $dest
Write-Host "Tor $ver ready in $dest"