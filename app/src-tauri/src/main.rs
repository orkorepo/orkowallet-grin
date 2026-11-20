// Desktop entry point; the app itself lives in lib.rs so the same code builds for Android.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    orkoswap_grin_wallet_lib::run()
}
