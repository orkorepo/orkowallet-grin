# Building the Android app

The Android app is the same Tauri 2 project as the desktop wallet: `app/src-tauri/src/lib.rs` holds the shared code (`run()` with the mobile entry point), `main.rs` only calls it on the desktop. The Android project lives in `app/src-tauri/gen/android/`.

## What is Android-specific

| Part | Where |
|---|---|
| Tor | The official Tor Expert Bundle for Android. `scripts/fetch-tor-android.py` downloads it, checks the SHA-256, and puts `libTor.so` and the bridge plugin (as `liblyrebird.so`) into `app/src-tauri/gen/android/app/src/main/torLibs/<abi>/`. Gradle packs them as native libraries with `useLegacyPackaging = true`, so they exist as real files in the app's native library folder; Android only lets an app run executables from there. `core/src/tor.rs` finds that folder through `/proc/self/maps`. |
| `libz.so.1` | `libTor.so` asks for `libz.so.1`, which Android does not have (the system zlib is `libz.so`). The fetch script rewrites that one name in place (the new name is shorter, nothing moves). |
| Background | `OrkoService.kt` is a foreground service (type `specialUse`) with a partial wake lock. `MainActivity.kt` exposes `window.OrkoAndroid.serviceOn/serviceOff/setSecure` to the page, asks for the notification permission, sends Back to the background while a wallet is open, and sets `FLAG_SECURE` while the recovery phrase is visible. |
| Desktop-only code | Tray, single instance, window size and the integrated node's window handling are `#[cfg(desktop)]`. `tauri.android.conf.json` removes the Windows Tor bundle from the Android resources (`"resources": null`). |
| Build fix | `vendor/patches/lmdb-master-sys` links `advapi32` by `TARGET`, not by host, so the crate cross-compiles from Windows. It is wired in with `[patch.crates-io]` in the root `Cargo.toml`. |

## Build

```sh
python scripts/fetch-tor-android.py
cd app && npm ci
npx tauri android build --target aarch64 --apk          # release, signed if a key is configured
npx tauri android build --debug --target aarch64 --apk  # debug
```

Output: `app/src-tauri/gen/android/app/build/outputs/apk/universal/{release,debug}/`.

`x86_64` (the emulator's own architecture) does not build yet: NDK 26's clang cannot assemble OpenSSL's `sm3-x86_64.S`. The emulator runs the arm64 APK through its ARM translation layer.

## Release signing

`app/build.gradle.kts` reads the signing key from `ORKO_KEYSTORE_PROPS`, or `~/.orko-signing/keystore.properties` by default. The file contains `storeFile`, `storePassword`, `keyAlias` and `keyPassword`. Keep the key store and this file **outside the repository** and back them up: every update has to be signed with the same key. Without the file the release APK is unsigned.

Create a key once with `keytool -genkeypair -v -keystore orkowallet-release.jks -alias orkowallet -keyalg RSA -keysize 4096 -validity 9125`.

## Building from Windows

The Android build runs OpenSSL's build system, which expects a Unix-like toolchain. What worked:

- `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME` with **forward slashes** (OpenSSL's makefile runs through `sh`, which eats backslashes).
- A full Perl (Strawberry Perl, or Git's Perl with the missing modules copied in) on `PERL5LIB`, and a `make` on `PATH`. In Git Bash set `MSYS2_ENV_CONV_EXCL="PERL5LIB;ANDROID_HOME;NDK_HOME"` so these paths are not rewritten.
- `<triple>-ar.exe` and `<triple>-ranlib.exe` on `PATH` (copies of the NDK's `llvm-ar` and `llvm-ranlib`).
- In `~/.cargo/config.toml`, a forward-slash compiler for each target:

  ```toml
  [env]
  CC_aarch64_linux_android = { value = "C:/Users/<you>/AppData/Local/Android/Sdk/ndk/26.3.11579264/toolchains/llvm/prebuilt/windows-x86_64/bin/clang.exe --target=aarch64-linux-android24", force = true }
  ```

On Linux and macOS none of this is needed.

## Testing on the emulator

An Android 14 (API 34) `google_apis` x86_64 image works, with hardware acceleration (WHPX on Windows). The WebView of a debug build can be inspected with `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`. To check that the wallet keeps receiving in the background, force deep sleep with `adb shell dumpsys deviceidle force-idle` and test the wallet's onion address from another machine.
