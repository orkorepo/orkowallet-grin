# Download the Tor Expert Bundle into vendor/tor-<version>, verifying SHA-256 and the Tor Project signature.
# Usage: pwsh scripts/fetch-tor.ps1 [-Platform windows-x86_64 | linux-x86_64 | macos-aarch64 | macos-x86_64]
#
# Windows: the SHA-256 is pinned below (and the .asc signature is checked when gpg is installed).
# Linux / macOS: the hash comes from the Tor Project's signed list (sha256sums-signed-build.txt). Its GPG
# signature MUST verify, so gpg is required there; nothing is unpacked otherwise.
param([string]$Platform = 'windows-x86_64')
$ErrorActionPreference = 'Stop'
$ver = '16.0.1'
$pinned = @{ 'windows-x86_64' = '9eed3c3ff1fe43df034ce360196c9ec95472560d77ff55614d0cd5120edea27b' }
$allowed = 'windows-x86_64', 'linux-x86_64', 'macos-aarch64', 'macos-x86_64'
if ($allowed -notcontains $Platform) { throw "Unknown platform '$Platform' (one of: $($allowed -join ', '))" }
$key = 'EF6E286DDA85EA2A4BA7DE684E2C6E8793298290'   # Tor Browser Developers signing key
$base = "https://archive.torproject.org/tor-package-archive/torbrowser/$ver"   # permanent: dist.torproject.org keeps only the latest releases
$name = "tor-expert-bundle-$Platform-$ver.tar.gz"
$vendor = Join-Path (Join-Path $PSScriptRoot '..') 'vendor'
$dl = Join-Path $vendor "download-tor-$ver"
New-Item -ItemType Directory -Force $dl | Out-Null
$haveGpg = [bool](Get-Command gpg -ErrorAction SilentlyContinue)
if ($haveGpg) { gpg --auto-key-locate nodefault,wkd --locate-keys torbrowser@torproject.org | Out-Null }

function Test-Signature([string]$file) {
  $out = gpg --status-fd 1 --verify "$file.asc" $file 2>&1 | Out-String
  if ($out -notmatch 'GOODSIG' -or $out -notmatch $key) { throw "GPG signature check failed for $(Split-Path $file -Leaf)" }
}

foreach ($f in $name, "$name.asc") { Invoke-WebRequest "$base/$f" -OutFile (Join-Path $dl $f) -UseBasicParsing }
$tarball = Join-Path $dl $name

if ($pinned.ContainsKey($Platform)) {
  $want = $pinned[$Platform]
} else {
  if (-not $haveGpg) { throw "gpg is required for ${Platform}: its hash comes from the Tor Project's signed list" }
  $sums = Join-Path $dl 'sha256sums-signed-build.txt'
  foreach ($f in 'sha256sums-signed-build.txt', 'sha256sums-signed-build.txt.asc') { Invoke-WebRequest "$base/$f" -OutFile (Join-Path $dl $f) -UseBasicParsing }
  Test-Signature $sums
  $line = Get-Content $sums | Where-Object { $_ -match "\s$([regex]::Escape($name))$" } | Select-Object -First 1
  if (-not $line) { throw "$name is not in the signed hash list" }
  $want = ($line -split '\s+')[0].ToLower()
}

$got = (Get-FileHash $tarball -Algorithm SHA256).Hash.ToLower()
if ($got -ne $want) { throw "SHA-256 mismatch: $got" }
if ($haveGpg) { Test-Signature $tarball } else { Write-Warning 'gpg not found: only the pinned SHA-256 was verified.' }

$dest = Join-Path $vendor "tor-$ver"
New-Item -ItemType Directory -Force $dest | Out-Null
tar -xzf $tarball -C $dest
Write-Host "Tor $ver ($Platform) ready in $dest"
