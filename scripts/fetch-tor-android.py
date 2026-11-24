"""Fetch the Tor Expert Bundle for Android and put Tor into the Android project.

Run once before building the APK (and again after a Tor version bump):

    python scripts/fetch-tor-android.py

What it does
  1. Downloads tor-expert-bundle-android-<abi>-<version>.tar.gz from archive.torproject.org and checks its
     SHA-256 against the value pinned below (taken from Tor's signed sha256sums-signed-build.txt for 16.0.1).
  2. Unpacks it to vendor/tor-android-<version>/<abi>/.
  3. Copies libTor.so and the bridge plugin (as liblyrebird.so) into
     app/src-tauri/gen/android/app/src/main/torLibs/<jni abi>/, where Gradle packs them as native libraries.
     Android only lets an app run executables from its native library folder, hence the lib*.so names.
  4. libTor.so asks for "libz.so.1", a name Android does not have (the system zlib is "libz.so"). The one
     name in the dynamic section is rewritten in place; the new name is shorter, so nothing moves.

To use a newer Tor, change VERSION and the hashes (from the signed sums file of that release).
"""
import hashlib
import pathlib
import shutil
import sys
import tarfile
import urllib.request

VERSION = "16.0.1"
BUNDLES = {
    # tor expert bundle abi : (jni abi folder, sha256 of the .tar.gz)
    "aarch64": ("arm64-v8a", "0091927b9fd72992a88021d55416b23a8380dc39a70c4b73a2cca9ee6a3dbcec"),
    "x86_64": ("x86_64", "cdb1b567ffe8f93ed21b5a8ca3cc72571387e8cf16055ce76084bb81ddc56674"),
}

root = pathlib.Path(__file__).resolve().parent.parent
vendor = root / "vendor"
dl = vendor / f"download-tor-{VERSION}-android"
dst = root / "app/src-tauri/gen/android/app/src/main/torLibs"


def fetch(abi, want):
    name = f"tor-expert-bundle-android-{abi}-{VERSION}.tar.gz"
    f = dl / name
    if not f.exists():
        dl.mkdir(parents=True, exist_ok=True)
        url = f"https://archive.torproject.org/tor-package-archive/torbrowser/{VERSION}/{name}"  # dist keeps only the latest releases
        print("downloading", url)
        urllib.request.urlretrieve(url, f)
    got = hashlib.sha256(f.read_bytes()).hexdigest()
    if got != want:
        f.unlink()
        sys.exit(f"{name}: SHA-256 mismatch (got {got}); file removed")
    print(name, "SHA-256 ok")
    out = vendor / f"tor-android-{VERSION}" / abi
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    with tarfile.open(f) as t:
        t.extractall(out, filter="data")
    return out


for abi, (jni, sha) in BUNDLES.items():
    src = fetch(abi, sha) / "tor"
    target = dst / jni
    target.mkdir(parents=True, exist_ok=True)
    data = (src / "libTor.so").read_bytes()
    old, new = b"libz.so.1\0", b"libz.so\0\0\0"
    n = data.count(old)
    if n < 1:
        sys.exit(f"{abi}: libz.so.1 not found in libTor.so (new Tor version? check the dependency list)")
    patched = data.replace(old, new)
    assert len(patched) == len(data)
    (target / "libTor.so").write_bytes(patched)
    shutil.copy(src / "pluggable_transports" / "lyrebird", target / "liblyrebird.so")
    print(f"{jni}: libTor.so patched ({n}), liblyrebird.so copied")
