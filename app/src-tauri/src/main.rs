//! OrkoWallet – Grin: Tauri shell over `orko-grin-core`.
//!
//! Layout on disk (app data dir):
//!   settings.json                       global settings
//!   wallets/<network>/<id>/meta.json    our per-wallet metadata (name, connection, confirmations)
//!   wallets/<network>/<id>/...          a normal grin-wallet top level dir (wallet_data, toml, tor)
//!   node/<network>/chain_data           integrated node
//!
//! Every wallet/node call runs on its own plain OS thread (`blocking`): the grin crates start
//! their own runtimes and call `block_on`, which panics on a tokio worker thread.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use orko_grin_core::node::{IntegratedNode, NodeSettings, NodeView};
use orko_grin_core::tor::{TorBundle, TorStatus};
use orko_grin_core::{
    amount_from_hr_string, amount_to_hr_string, Network, ProcessOutcome, ReceiveOutcome,
    SendOutcome, Settings, SlateState, TorMode, Wallet,
};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

/// Public nodes that answered on 2026-11-14 (main.gri.mw and grincoin.org are the defaults Grim
/// ships, plus the community node grinnode.live). The wallet fails over between them on errors.
fn builtin_nodes(n: Network) -> Vec<String> {
    let v: &[&str] = match n {
        Network::Mainnet => &["https://main.gri.mw", "https://grincoin.org", "https://grinnode.live:3413"],
        Network::Testnet => &["https://test.gri.mw", "https://testnet.grincoin.org"],
        Network::Usernet => &["http://127.0.0.1:33413"],
    };
    v.iter().map(|s| s.to_string()).collect()
}

// ------------------------------------------------------------------ settings

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct NodeCfg {
    /// Start the integrated node when the app starts.
    autostart: bool,
    /// Extra peers, one "host:port" per line.
    peers: String,
    /// Only connect to `peers` (no DNS seeds). For private test networks.
    only_peers: bool,
    archive: bool,
}

impl Default for NodeCfg {
    fn default() -> Self {
        NodeCfg { autostart: false, peers: String::new(), only_peers: false, archive: false }
    }
}

/// How payments are built and broadcast, plus the password-before-send guard.
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct SendCfg {
    /// Ask for the wallet password again before every payment.
    confirm_password: bool,
    /// Broadcast at once instead of Dandelion stem relay.
    fluff: bool,
    change_outputs: usize,
    /// "smallest" (fewest outputs that are enough) or "all".
    strategy: String,
    /// Drop an unmined transaction after this many blocks (0 = never).
    ttl_blocks: u64,
    /// When the recipient is offline, try again every minute instead of failing at once.
    retry: bool,
    /// For how many minutes (one attempt per minute).
    retry_minutes: u64,
    /// Confirmations an incoming payment needs before it counts as spendable (1-10, Grin default 10).
    min_confirmations: u64,
}

impl Default for SendCfg {
    fn default() -> Self {
        SendCfg { confirm_password: false, fluff: false, change_outputs: 1, strategy: "smallest".into(), ttl_blocks: 0, retry: true, retry_minutes: 30, min_confirmations: 10 }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct AppSettings {
    /// "mainnet" | "testnet" | "usernet" (usernet only for local tests).
    network: String,
    /// "system" | "dark" | "light"
    theme: String,
    /// Colour set: "grin" (black and yellow, the default) | "orko" (blue).
    palette: String,
    /// Desktop notification when a payment arrives or gets confirmed.
    notify_payments: bool,
    /// Desktop notification when the Tor address stops answering (and when it is back).
    notify_tor: bool,
    /// The close button hides the window to the system tray; the wallet keeps running and receiving.
    close_to_tray: bool,
    /// The one-time "still running in the tray" notice was shown.
    tray_hint_shown: bool,
    /// "bundled" | "arti"
    tor: String,
    /// "none" | "obfs4" | "snowflake" | "custom"
    bridges: String,
    custom_bridges: String,
    /// "auto" (system language) | "tr" | "en"
    language: String,
    /// Lock the screen after this many idle minutes (0 = never). The wallet keeps receiving.
    auto_lock_minutes: u32,
    /// Nodes the user added, per network. They join the built-in ones in the failover pool.
    custom_nodes: BTreeMap<String, Vec<String>>,
    /// The node the user picked per network; wallets start on it and switch to it at once.
    preferred_node: BTreeMap<String, String>,
    node: NodeCfg,
    send: SendCfg,
    /// Last opened wallet id per network.
    last_wallet: BTreeMap<String, String>,
    /// Wallet folders to delete on the next start (they are locked while open).
    pending_delete: Vec<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            network: "mainnet".into(),
            theme: "system".into(),
            palette: "grin".into(),
            notify_payments: true,
            notify_tor: true,
            close_to_tray: true,
            tray_hint_shown: false,
            tor: "bundled".into(),
            bridges: "none".into(),
            custom_bridges: String::new(),
            language: "auto".into(),
            auto_lock_minutes: 10,
            custom_nodes: BTreeMap::new(),
            preferred_node: BTreeMap::new(),
            node: NodeCfg::default(),
            send: SendCfg::default(),
            last_wallet: BTreeMap::new(),
            pending_delete: Vec::new(),
        }
    }
}

impl AppSettings {
    fn network(&self) -> Network {
        Network::parse(&self.network).unwrap_or(Network::Mainnet)
    }
    /// Built-in nodes of the current network followed by the user's own.
    fn pool_nodes(&self) -> Vec<String> {
        let mut v = builtin_nodes(self.network());
        for u in self.custom_nodes.get(&self.network).into_iter().flatten() {
            if !v.contains(u) {
                v.push(u.clone());
            }
        }
        v
    }
}

fn net_name(n: Network) -> &'static str {
    match n {
        Network::Mainnet => "mainnet",
        Network::Testnet => "testnet",
        Network::Usernet => "usernet",
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct WalletMeta {
    id: String,
    name: String,
    created: String,
    /// "auto" (node pool with failover) | "custom" (only `custom_url`) | "integrated" (own node).
    /// Older wallets carry "external", which means "auto".
    connection: String,
    /// The one node used when `connection` is "custom".
    custom_url: String,
    min_confirmations: u64,
    /// A chain scan that has not finished yet: (start height, delete unconfirmed). Resumed on open.
    scan_pending: Option<(u64, bool)>,
}

impl Default for WalletMeta {
    fn default() -> Self {
        WalletMeta {
            id: String::new(),
            name: "Cüzdan".into(),
            created: String::new(),
            connection: "auto".into(),
            custom_url: String::new(),
            min_confirmations: 10,
            scan_pending: None,
        }
    }
}

// ------------------------------------------------------------------ state

#[derive(Default, Clone)]
struct RemoteCache {
    url: String,
    view: Option<NodeView>,
    version: String,
    error: String,
    at: Option<Instant>,
}

struct OpenWallet {
    meta: WalletMeta,
    wallet: Arc<Wallet>,
}

struct AppState {
    root: PathBuf,
    tor_bundle: TorBundle,
    settings: Mutex<AppSettings>,
    open: RwLock<Option<Arc<OpenWallet>>>,
    tor_ready_at: Mutex<Option<Instant>>,
    node: Arc<IntegratedNode>,
    remote: Mutex<RemoteCache>,
    scan: Mutex<ScanState>,
    /// Latest health check of the pool nodes of the current network.
    probes: Mutex<Vec<orko_grin_core::remote::NodeProbe>>,
    /// Screen lock. While set, every command that reads or spends wallet data refuses to run,
    /// not just the UI (the wallet itself keeps running, so payments still arrive).
    locked: std::sync::atomic::AtomicBool,
    /// The open wallet's onion address answered a test connection made over Tor.
    reachable: std::sync::atomic::AtomicBool,
    /// Payments waiting for an offline recipient (retried every minute), by transaction id.
    jobs: Mutex<HashMap<String, JobView>>,
    jobs_stop: std::sync::atomic::AtomicBool,
    jobs_active: std::sync::atomic::AtomicUsize,
    /// Consecutive wrong passwords and when the last one happened (slows brute forcing).
    guard: Mutex<(u32, Instant)>,
    /// Interface language as reported by the UI (tray menu and notifications are worded here).
    ui_lang: Mutex<String>,
}

#[derive(Default, Clone, Serialize)]
struct ScanState {
    active: bool,
    error: String,
    /// Unix seconds when the last scan finished (0 = none yet).
    finished_at: u64,
}

type St<'a> = State<'a, Arc<AppState>>;

impl AppState {
    fn net(&self) -> String {
        self.settings.lock().unwrap().network.clone()
    }
    fn wallets_dir(&self) -> PathBuf {
        self.root.join("wallets").join(self.net())
    }
    fn wallet_dir(&self, id: &str) -> Result<PathBuf, String> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("geçersiz cüzdan".into());
        }
        Ok(self.wallets_dir().join(id))
    }
    fn read_meta(&self, id: &str) -> Result<WalletMeta, String> {
        let dir = self.wallet_dir(id)?;
        let mut m: WalletMeta = std::fs::read_to_string(dir.join("meta.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        m.id = id.to_string();
        Ok(m)
    }
    fn write_meta(&self, m: &WalletMeta) -> Result<(), String> {
        let dir = self.wallet_dir(&m.id)?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let text = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("meta.json"), text).map_err(|e| e.to_string())
    }
    fn save_settings(&self) -> Result<(), String> {
        let s = self.settings.lock().unwrap().clone();
        let text = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
        std::fs::write(self.root.join("settings.json"), text).map_err(|e| e.to_string())
    }
    fn open(&self) -> Result<Arc<OpenWallet>, String> {
        if self.locked.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Cüzdan kilitli".into());
        }
        self.open.read().unwrap().clone().ok_or_else(|| "Açık cüzdan yok.".to_string())
    }
    /// Refuse password attempts for a growing time after the third wrong one in a row.
    fn throttle(&self) -> Result<(), String> {
        let g = self.guard.lock().unwrap();
        if g.0 >= 3 {
            let wait = 2u64.pow((g.0 - 2).min(5)).min(30);
            let passed = g.1.elapsed().as_secs();
            if passed < wait {
                return Err(format!("Çok fazla hatalı deneme. {} sn sonra yeniden dene.", wait - passed));
            }
        }
        Ok(())
    }
    fn attempt<T>(&self, r: Result<T, String>) -> Result<T, String> {
        let mut g = self.guard.lock().unwrap();
        match &r {
            Ok(_) => *g = (0, Instant::now()),
            Err(e) if e.contains("Parola yanlış") => *g = (g.0 + 1, Instant::now()),
            _ => {}
        }
        r
    }
    fn wallet(&self) -> Result<Arc<Wallet>, String> {
        Ok(self.open()?.wallet.clone())
    }
    fn builtin_bridges(&self, kind: &str) -> Vec<String> {
        let p = self.tor_bundle.dir.join("tor").join("pluggable_transports").join("pt_config.json");
        let Ok(text) = std::fs::read_to_string(p) else { return vec![] };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return vec![] };
        v["bridges"][kind]
            .as_array()
            .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
            .unwrap_or_default()
    }
    fn bridge_lines(&self, s: &AppSettings) -> Vec<String> {
        match s.bridges.as_str() {
            "obfs4" | "snowflake" => self.builtin_bridges(&s.bridges),
            "custom" => s
                .custom_bridges
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(String::from)
                .collect(),
            _ => vec![],
        }
    }
    /// Nodes this wallet may use, unordered. "auto" is the whole pool; the other modes are one node.
    fn nodes_for(&self, m: &WalletMeta) -> Vec<String> {
        if m.connection == "integrated" {
            return vec![self.node.settings.api_url()];
        }
        if m.connection == "custom" && !m.custom_url.trim().is_empty() {
            return vec![m.custom_url.trim().trim_end_matches('/').to_string()];
        }
        self.settings.lock().unwrap().pool_nodes()
    }
    fn is_auto(m: &WalletMeta) -> bool {
        m.connection != "integrated" && !(m.connection == "custom" && !m.custom_url.trim().is_empty())
    }
    fn core_settings(&self, m: &WalletMeta) -> Result<Settings, String> {
        let s = self.settings.lock().unwrap().clone();
        Ok(Settings {
            dir: self.wallet_dir(&m.id)?,
            network: s.network(),
            nodes: self.nodes_for(m),
            listen_port: free_port(),
            tor: if s.tor == "arti" {
                TorMode::Integrated
            } else {
                TorMode::Bundled(self.tor_bundle.clone())
            },
            bridges: self.bridge_lines(&s),
        })
    }
    fn list_wallets(&self) -> Vec<WalletMeta> {
        let mut v: Vec<WalletMeta> = std::fs::read_dir(self.wallets_dir())
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter(|e| orko_grin_core::wallet_exists(&e.path()))
                    .filter_map(|e| self.read_meta(&e.file_name().to_string_lossy()).ok())
                    .collect()
            })
            .unwrap_or_default();
        v.sort_by(|a, b| a.created.cmp(&b.created));
        v
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(3415)
}

fn new_id() -> String {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("w{t:x}")
}

/// Run `f` on a fresh OS thread and await it without blocking the async runtime.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        let _ = tx.send(match r {
            Ok(r) => r.map_err(|e| friendly(&format!("{e:#}"))),
            Err(_) => Err("Beklenmeyen bir hata oluştu (ayrıntılar log dosyasında).".into()),
        });
    });
    rx.await.map_err(|_| "İşlem yarıda kaldı".to_string())?
}

/// Turn the most common grin errors into plain Turkish.
fn friendly(e: &str) -> String {
    let l = e.to_lowercase();
    if l.contains("not enough funds") {
        return "Yetersiz bakiye (ücret dahil). Onay bekleyen tutarlar henüz harcanamaz.".into();
    }
    if l.contains("wrong password") {
        return "Parola yanlış.".into();
    }
    if l.contains("recovery phrase is not valid") {
        return "Kurtarma ifadesi geçersiz. Kelimeleri ve sırasını kontrol et.".into();
    }
    if l.contains("cannot parse response") || l.contains("error decoding response") {
        return "Node'lardan okunabilir yanıt alınamadı (hepsi denendi). Birkaç dakika sonra yeniden dene ya da Node ayarları'ndan kendi node'unu ekle.".into();
    }
    if l.contains("get_tip") || (l.contains("node") && (l.contains("connect") || l.contains("request"))) {
        return "Node'a ulaşılamadı. Node panelinden bağlantıyı kontrol et.".into();
    }
    if l.contains("already exists") {
        return "Bu klasörde zaten bir cüzdan var.".into();
    }
    e.to_string()
}

fn qr_svg(text: &str) -> String {
    match qrcode::QrCode::with_error_correction_level(text, qrcode::EcLevel::L) {
        Ok(code) => code
            .render::<qrcode::render::svg::Color>()
            .min_dimensions(200, 200)
            .quiet_zone(true)
            .dark_color(qrcode::render::svg::Color("#0b1220"))
            .light_color(qrcode::render::svg::Color("#ffffff"))
            .build(),
        Err(_) => String::new(),
    }
}

/// Stop the integrated node cleanly, then restart the app (closes wallet, listener and tor).
fn graceful_restart(app: &tauri::AppHandle) {
    if let Some(st) = app.try_state::<Arc<AppState>>() {
        st.node.stop(true);
    }
    app.restart();
}

// ------------------------------------------------------------------ app / settings

#[derive(Serialize)]
struct Status {
    network: String,
    settings: AppSettings,
    /// Built-in nodes of this network (the user's own are in `settings.custom_nodes`).
    builtin_nodes: Vec<String>,
    wallets: Vec<WalletMeta>,
    open_wallet: Option<WalletMeta>,
    last_wallet: String,
    node_api: String,
}

#[tauri::command]
fn status(state: St<'_>) -> Status {
    let s = state.settings.lock().unwrap().clone();
    Status {
        network: s.network.clone(),
        builtin_nodes: builtin_nodes(s.network()),
        wallets: state.list_wallets(),
        open_wallet: state.open.read().unwrap().as_ref().map(|o| o.meta.clone()),
        last_wallet: s.last_wallet.get(&s.network).cloned().unwrap_or_default(),
        node_api: state.node.settings.api_url(),
        settings: s,
    }
}

/// Theme, language, auto lock, integrated-node options. Network, Tor and node list have their own commands.
#[tauri::command]
fn save_settings(state: St<'_>, theme: String, palette: Option<String>, notify_payments: Option<bool>, notify_tor: Option<bool>, close_to_tray: Option<bool>, language: String, auto_lock_minutes: u32, node: serde_json::Value, send: serde_json::Value) -> Result<(), String> {
    {
        let mut s = state.settings.lock().unwrap();
        s.theme = theme;
        if let Some(p) = palette {
            s.palette = if p == "orko" { "orko".into() } else { "grin".into() };
        }
        if let Some(b) = notify_payments {
            s.notify_payments = b;
        }
        if let Some(b) = notify_tor {
            s.notify_tor = b;
        }
        if let Some(b) = close_to_tray {
            s.close_to_tray = b;
        }
        s.language = if ["auto", "tr", "en", "de", "fr", "ru", "zh"].contains(&language.as_str()) { language } else { "auto".into() };
        s.auto_lock_minutes = auto_lock_minutes.min(24 * 60);
        if let Ok(n) = serde_json::from_value::<NodeCfg>(node) {
            s.node = n;
        }
        if let Ok(mut v) = serde_json::from_value::<SendCfg>(send) {
            v.change_outputs = v.change_outputs.clamp(1, 8);
            v.ttl_blocks = v.ttl_blocks.min(100_000);
            v.retry_minutes = v.retry_minutes.clamp(1, 240);
            v.min_confirmations = v.min_confirmations.clamp(1, 10);
            if v.strategy != "all" {
                v.strategy = "smallest".into();
            }
            s.send = v;
        }
    }
    state.save_settings()
}

#[tauri::command]
fn switch_network(app: tauri::AppHandle, state: St<'_>, network: String) -> Result<(), String> {
    Network::parse(&network).map_err(|e| e.to_string())?;
    state.settings.lock().unwrap().network = network;
    state.save_settings()?;
    // Chain type is process global in grin: a network change needs a fresh process.
    graceful_restart(&app);
    Ok(())
}

/// "Repair": forget tor's saved state of every wallet (chosen entry relays, cached consensus) and restart
/// the app. Wallets, recovery phrases and balances are not touched. Users whose tor would not connect
/// report that a fresh start of the connection fixes it.
#[tauri::command]
async fn repair_restart(app: tauri::AppHandle, state: St<'_>) -> Result<(), String> {
    let open_w = state.open.read().unwrap().as_ref().map(|o| o.wallet.clone());
    let wallets_root = state.root.join("wallets");
    blocking(move || {
        if let Some(w) = &open_w {
            w.shutdown();
            if let Err(e) = w.wipe_tor_state() {
                orko_grin_core::tor::glog(log::Level::Warn, &format!("repair: open wallet: {e}"));
            }
        }
        // Every wallet of every network; the open one is already done and its folder is skipped below
        // only by failing quietly, as tor is no longer running there.
        for net in std::fs::read_dir(&wallets_root).into_iter().flatten().flatten() {
            for w in std::fs::read_dir(net.path()).into_iter().flatten().flatten() {
                if let Err(e) = orko_grin_core::wipe_tor_state_in(&w.path()) {
                    orko_grin_core::tor::glog(log::Level::Warn, &format!("repair: {e}"));
                }
            }
        }
        Ok(())
    })
    .await?;
    graceful_restart(&app);
    Ok(())
}

// ------------------------------------------------------------------ wallets

async fn open_with(
    state: Arc<AppState>,
    meta: WalletMeta,
    password: String,
    mode: OpenMode,
) -> Result<Option<Vec<String>>, String> {
    if state.open.read().unwrap().is_some() {
        return Err("Önce açık cüzdanı kapat.".into());
    }
    let mut settings = state.core_settings(&meta)?;
    let auto = AppState::is_auto(&meta);
    let cached: Vec<orko_grin_core::remote::NodeProbe> = state.probes.lock().unwrap().clone();
    let preferred: Option<String> = {
        let s = state.settings.lock().unwrap();
        s.preferred_node.get(&s.network).cloned()
    };
    let st = state.clone();
    orko_grin_core::reset_scan_progress();
    blocking(move || {
        // Pool nodes: healthy and fastest first, so the wallet starts on the best one.
        if auto && settings.nodes.len() > 1 {
            let known = settings.nodes.iter().all(|u| cached.iter().any(|p| &p.url == u));
            let want = preferred.clone();
            settings.nodes = if known {
                orko_grin_core::remote::order_from_probes(&settings.nodes, &cached)
            } else {
                orko_grin_core::remote::order_by_health(&settings.nodes)
            };
            // The node the user picked goes first, whatever the health order says.
            if let Some(p) = want {
                if let Some(pos) = settings.nodes.iter().position(|u| u == &p) {
                    let u = settings.nodes.remove(pos);
                    settings.nodes.insert(0, u);
                }
            }
        }
        let (mut w, words) = match mode {
            OpenMode::Unlock => (Wallet::open(settings, &password)?, None),
            OpenMode::Create(n) => {
                let (w, phrase) = Wallet::create(settings, &password, None, n)?;
                (w, Some(phrase.split_whitespace().map(String::from).collect()))
            }
            // No scan here: the wallet opens at once and `start_scan` runs it in the background.
            OpenMode::Restore(words) => {
                let (w, _) = Wallet::create(settings, &password, Some(&words), 24)?;
                (w, None)
            }
        };
        w.start_listener()?;
        *st.tor_ready_at.lock().unwrap() = None;
        {
            let mut s = st.settings.lock().unwrap();
            let net = s.network.clone();
            s.last_wallet.insert(net, meta.id.clone());
        }
        let _ = st.save_settings();
        let ow = Arc::new(OpenWallet { meta, wallet: Arc::new(w) });
        *st.open.write().unwrap() = Some(ow.clone());
        reach_watcher(st.clone(), ow);
        Ok(words)
    })
    .await
}

enum OpenMode {
    Unlock,
    Create(usize),
    Restore(String),
}

/// Run a chain scan of the open wallet on a background thread. Recorded in the wallet's meta
/// first, so a scan cut short by closing the app resumes on the next open.
fn start_scan(state: &Arc<AppState>, start: u64, delete: bool) -> Result<(), String> {
    let o = state.open()?;
    {
        let mut sc = state.scan.lock().unwrap();
        if sc.active {
            return Err("Zaten bir tarama sürüyor.".into());
        }
        *sc = ScanState { active: true, ..Default::default() };
    }
    let mut meta = state.read_meta(&o.meta.id)?;
    meta.scan_pending = Some((start, delete));
    state.write_meta(&meta)?;
    orko_grin_core::reset_scan_progress();
    let st = state.clone();
    std::thread::spawn(move || {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| o.wallet.scan_from(start, delete)));
        let error = match r {
            Ok(Ok(())) => {
                if let Ok(mut m) = st.read_meta(&o.meta.id) {
                    m.scan_pending = None;
                    let _ = st.write_meta(&m);
                }
                String::new()
            }
            Ok(Err(e)) => friendly(&format!("{e:#}")),
            Err(_) => "Tarama beklenmedik şekilde durdu (ayrıntılar log dosyasında).".into(),
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        *st.scan.lock().unwrap() = ScanState { active: false, error, finished_at: now };
    });
    Ok(())
}

/// "all" = from the first block, "never" = no scan, "YYYY" = from the start of that year.
fn scan_start(state: &AppState, since: &str) -> Option<u64> {
    match since {
        "never" => None,
        "all" | "" => Some(1),
        y => {
            let year: i64 = y.parse().ok()?;
            // Unix time of Jan 1st of `year` (00:00 UTC), no leap-second fuss needed here.
            let days = (1970..year).map(|yy| if (yy % 4 == 0 && yy % 100 != 0) || yy % 400 == 0 { 366 } else { 365 }).sum::<i64>();
            let net = state.settings.lock().unwrap().network();
            Some(orko_grin_core::start_height_for(net, days * 86_400))
        }
    }
}

#[derive(Serialize)]
struct ScanDto {
    active: bool,
    progress: i32,
    error: String,
    finished_at: u64,
}

#[tauri::command]
fn scan_status(state: St<'_>) -> ScanDto {
    let s = state.scan.lock().unwrap().clone();
    ScanDto { active: s.active, progress: orko_grin_core::scan_progress(), error: s.error, finished_at: s.finished_at }
}

fn check_password(p: &str) -> Result<(), String> {
    if p.chars().count() < 4 {
        return Err("Parola en az 4 karakter olmalı.".into());
    }
    Ok(())
}

fn new_meta(name: &str, connection: &str) -> WalletMeta {
    WalletMeta {
        id: new_id(),
        name: if name.trim().is_empty() { "Cüzdan".into() } else { name.trim().chars().take(40).collect() },
        created: chrono_now(),
        connection: if connection == "integrated" { "integrated".into() } else { "auto".into() },
        ..Default::default()
    }
}

fn chrono_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    secs.to_string()
}

/// Remove a half-made wallet folder after a failed create/restore/import.
fn discard(state: &AppState, id: &str) {
    if let Ok(dir) = state.wallet_dir(id) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[tauri::command]
async fn wallet_create(state: St<'_>, name: String, password: String, connection: String, words: Option<usize>) -> Result<Vec<String>, String> {
    check_password(&password)?;
    let meta = new_meta(&name, &connection);
    state.write_meta(&meta)?;
    let id = meta.id.clone();
    match open_with(state.inner().clone(), meta, password, OpenMode::Create(if words == Some(12) { 12 } else { 24 })).await {
        Ok(w) => Ok(w.unwrap_or_default()),
        Err(e) => {
            discard(&state, &id);
            Err(e)
        }
    }
}

#[tauri::command]
async fn wallet_restore(state: St<'_>, name: String, password: String, words: String, connection: String, since: String) -> Result<(), String> {
    check_password(&password)?;
    let words = words.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    let n = words.split(' ').filter(|w| !w.is_empty()).count();
    if ![12, 15, 18, 21, 24].contains(&n) {
        return Err(format!("Kurtarma ifadesi 12-24 kelime olmalı, {n} kelime girildi."));
    }
    let meta = new_meta(&name, &connection);
    state.write_meta(&meta)?;
    let id = meta.id.clone();
    open_with(state.inner().clone(), meta, password, OpenMode::Restore(words)).await.map_err(|e| {
        discard(&state, &id);
        e
    })?;
    if let Some(start) = scan_start(&state, &since) {
        start_scan(state.inner(), start, false)?;
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let target = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &target)?;
        } else {
            std::fs::copy(e.path(), target)?;
        }
    }
    Ok(())
}

/// Import an existing grin-wallet / Grim wallet folder (the one with `wallet_data`, or
/// `wallet_data` itself). The original is copied, never moved.
#[tauri::command]
async fn wallet_import(state: St<'_>, name: String, path: String, password: String, connection: String) -> Result<(), String> {
    let src = PathBuf::from(path.trim().trim_matches('"'));
    let data = if src.join("wallet.seed").exists() { src.clone() } else { src.join("wallet_data") };
    if !data.join("wallet.seed").exists() {
        return Err("Bu klasörde bir Grin cüzdanı bulunamadı (wallet_data\\wallet.seed yok).".into());
    }
    let meta = new_meta(&name, &connection);
    let dest = state.wallet_dir(&meta.id)?;
    copy_dir(&data, &dest.join("wallet_data")).map_err(|e| format!("Kopyalanamadı: {e}"))?;
    state.write_meta(&meta)?;
    let id = meta.id.clone();
    open_with(state.inner().clone(), meta, password, OpenMode::Unlock).await.map(|_| ()).map_err(|e| {
        discard(&state, &id);
        e
    })
}

#[tauri::command]
async fn wallet_open(state: St<'_>, id: String, password: String) -> Result<(), String> {
    state.throttle()?;
    let meta = state.read_meta(&id)?;
    let pending = meta.scan_pending;
    state.attempt(open_with(state.inner().clone(), meta, password, OpenMode::Unlock).await)?;
    // A scan the last session did not finish.
    if let Some((start, delete)) = pending {
        start_scan(state.inner(), start, delete)?;
    }
    Ok(())
}

/// Close the open wallet and go back to the wallet list. The Foreign API server and Tor are
/// stopped inside the process; only grin-wallet's integrated Arti listener, or a chain scan that
/// is still running, cannot be stopped, and then the app restarts instead. Returns true if it did.
#[tauri::command]
async fn wallet_close(app: tauri::AppHandle, state: St<'_>) -> Result<bool, String> {
    if state.scan.lock().unwrap().active {
        graceful_restart(&app);
        return Ok(true);
    }
    if state.jobs_active.load(std::sync::atomic::Ordering::SeqCst) > 0 {
        // Waiting payments stop here (their transactions stay pending and can be cancelled later).
        state.jobs_stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let st = state.inner().clone();
        let stopped = blocking(move || {
            for _ in 0..40 {
                if st.jobs_active.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                    return Ok(true);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Ok(false)
        })
        .await?;
        if !stopped {
            graceful_restart(&app);
            return Ok(true);
        }
        state.jobs_stop.store(false, std::sync::atomic::Ordering::SeqCst);
    }
    state.jobs.lock().unwrap().clear();
    let Some(o) = state.open.write().unwrap().take() else { return Ok(false) };
    let w = o.wallet.clone();
    drop(o);
    let stopped = blocking(move || Ok(w.shutdown())).await?;
    if !stopped {
        graceful_restart(&app);
        return Ok(true);
    }
    state.locked.store(false, std::sync::atomic::Ordering::SeqCst);
    state.reachable.store(false, std::sync::atomic::Ordering::Relaxed);
    *state.tor_ready_at.lock().unwrap() = None;
    *state.scan.lock().unwrap() = ScanState::default();
    orko_grin_core::reset_scan_progress();
    Ok(false)
}

#[tauri::command]
fn win_min(w: tauri::WebviewWindow) {
    let _ = w.minimize();
}
#[tauri::command]
fn win_max(w: tauri::WebviewWindow) {
    if w.is_maximized().unwrap_or(false) {
        let _ = w.unmaximize();
    } else {
        let _ = w.maximize();
    }
}
#[tauri::command]
fn win_drag(w: tauri::WebviewWindow) {
    let _ = w.start_dragging();
}
#[tauri::command]
fn win_close(app: tauri::AppHandle) {
    if !hide_to_tray(&app) {
        app.exit(0); // RunEvent::Exit stops the integrated node cleanly
    }
}
#[tauri::command]
fn wallet_update(state: St<'_>, id: String, name: String, connection: String, custom_url: String) -> Result<bool, String> {
    let mut m = state.read_meta(&id)?;
    let connection = match connection.as_str() {
        "integrated" => "integrated",
        "custom" => "custom",
        _ => "auto",
    };
    let custom_url = custom_url.trim().trim_end_matches('/').to_string();
    if connection == "custom" && !is_http_url(&custom_url) {
        return Err("Node adresi http:// ya da https:// ile başlamalı.".into());
    }
    let was_auto = m.connection != "integrated" && m.connection != "custom";
    let reconnect = m.connection != connection && !(was_auto && connection == "auto")
        || (connection == "custom" && m.custom_url != custom_url);
    m.name = if name.trim().is_empty() { m.name } else { name.trim().chars().take(40).collect() };
    m.connection = connection.into();
    m.custom_url = custom_url;
    state.write_meta(&m)?;
    let mut open = state.open.write().unwrap();
    if let Some(o) = open.as_ref().filter(|o| o.meta.id == id) {
        *open = Some(Arc::new(OpenWallet { meta: m, wallet: o.wallet.clone() }));
    }
    // A new node connection takes effect when the wallet is opened again.
    Ok(reconnect)
}

/// Is `password` the open wallet's password? Used to unlock a locked screen (the wallet itself
/// keeps running while the screen is locked, so payments still arrive).
#[tauri::command]
async fn verify_password(state: St<'_>, password: String) -> Result<(), String> {
    state.throttle()?;
    let w = state.open.read().unwrap().as_ref().map(|o| o.wallet.clone()).ok_or("Açık cüzdan yok.")?;
    let r = blocking(move || w.recovery_phrase(&password).map(|_| ())).await;
    state.attempt(r)?;
    state.locked.store(false, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Lock the screen: from now on wallet commands refuse until `verify_password` succeeds.
#[tauri::command]
fn set_locked(state: St<'_>) {
    if state.open.read().unwrap().is_some() {
        state.locked.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Keep the window out of screenshots and screen recordings while secrets are on screen.
#[tauri::command]
fn set_protected(window: tauri::WebviewWindow, on: bool) {
    let _ = window.set_content_protected(on);
}

// ------------------------------------------------------------------ recoverable delete
// Deleting a wallet keeps its encrypted seed and name in <data>/trash/<network>/<id> for 30 days, so a
// mistake can be undone from the wallet list. Only the small seed and meta files are kept (the chain
// data is rebuilt by a scan), and the copy must succeed before anything is removed.
const TRASH_DAYS: u64 = 30;

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn trash_wallet(root: &Path, net: &str, id: &str, dir: &Path) -> Result<(), String> {
    let seed = dir.join("wallet_data").join("wallet.seed");
    if !seed.exists() {
        return Ok(()); // nothing worth keeping
    }
    let t = root.join("trash").join(net).join(id);
    let _ = std::fs::remove_dir_all(&t);
    std::fs::create_dir_all(t.join("wallet_data")).map_err(|e| e.to_string())?;
    std::fs::copy(&seed, t.join("wallet_data").join("wallet.seed")).map_err(|e| format!("Cüzdanın anahtar dosyası yedeklenemedi, silme iptal edildi ({e})."))?;
    let _ = std::fs::copy(dir.join("meta.json"), t.join("meta.json"));
    std::fs::write(t.join("deleted_at"), now_secs().to_string()).map_err(|e| e.to_string())
}

fn trash_deleted_at(p: &Path) -> u64 {
    std::fs::read_to_string(p.join("deleted_at")).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0)
}

/// Remove trash entries older than TRASH_DAYS (run at start).
fn trash_purge_old(root: &Path) {
    let limit = TRASH_DAYS * 86400;
    let Ok(nets) = std::fs::read_dir(root.join("trash")) else { return };
    for n in nets.filter_map(|e| e.ok()) {
        let Ok(items) = std::fs::read_dir(n.path()) else { continue };
        for it in items.filter_map(|e| e.ok()) {
            if now_secs().saturating_sub(trash_deleted_at(&it.path())) > limit {
                let _ = std::fs::remove_dir_all(it.path());
            }
        }
    }
}

#[tauri::command]
fn trash_list(state: St<'_>) -> Vec<serde_json::Value> {
    let net = state.net();
    let mut v: Vec<(u64, serde_json::Value)> = std::fs::read_dir(state.root.join("trash").join(&net))
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().join("wallet_data").join("wallet.seed").exists())
                .map(|e| {
                    let p = e.path();
                    let meta: WalletMeta = std::fs::read_to_string(p.join("meta.json"))
                        .ok()
                        .and_then(|t| serde_json::from_str(&t).ok())
                        .unwrap_or_default();
                    let at = trash_deleted_at(&p);
                    let left = (TRASH_DAYS * 86400).saturating_sub(now_secs().saturating_sub(at)) / 86400;
                    let name = if meta.name.is_empty() { e.file_name().to_string_lossy().into_owned() } else { meta.name };
                    (at, serde_json::json!({ "id": e.file_name().to_string_lossy(), "name": name, "deleted_at": at, "days_left": left }))
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v.into_iter().map(|x| x.1).collect()
}

#[tauri::command]
fn trash_restore(state: St<'_>, id: String) -> Result<(), String> {
    let t = state.root.join("trash").join(state.net()).join(&id);
    let dir = state.wallet_dir(&id)?; // also validates the id
    let seed = t.join("wallet_data").join("wallet.seed");
    if !seed.exists() {
        return Err("Silinen cüzdan bulunamadı.".into());
    }
    if dir.join("wallet_data").join("wallet.seed").exists() {
        return Err("Bu cüzdan zaten listede.".into());
    }
    std::fs::create_dir_all(dir.join("wallet_data")).map_err(|e| e.to_string())?;
    std::fs::copy(&seed, dir.join("wallet_data").join("wallet.seed")).map_err(|e| e.to_string())?;
    let _ = std::fs::copy(t.join("meta.json"), dir.join("meta.json"));
    // The balance is found again by a chain scan when the wallet is opened.
    let mut m = state.read_meta(&id)?;
    if m.name.is_empty() {
        m.name = id.clone();
    }
    m.scan_pending = Some((0, false));
    state.write_meta(&m)?;
    let _ = std::fs::remove_dir_all(&t);
    Ok(())
}

#[tauri::command]
fn trash_purge(state: St<'_>, id: String) -> Result<(), String> {
    state.wallet_dir(&id)?; // validates the id
    let _ = std::fs::remove_dir_all(state.root.join("trash").join(state.net()).join(&id));
    Ok(())
}

/// Delete the open wallet after checking its password. Returns true if the app had to restart
/// (only when the wallet cannot be closed inside the process; the folder is then removed on start).
/// Remove a wallet that is NOT open, straight from the wallet list. No password is asked (it may be
/// forgotten); the screen asks the user to type the wallet name instead. The money is only recoverable
/// with the recovery phrase afterwards.
#[tauri::command]
async fn wallet_remove(state: St<'_>, id: String) -> Result<(), String> {
    if state.open.read().unwrap().as_ref().is_some_and(|o| o.meta.id == id) {
        return Err("Açık cüzdan silinemez. Önce çıkış yap.".into());
    }
    let dir = state.wallet_dir(&id)?;
    if !dir.exists() {
        return Err("Cüzdan bulunamadı.".into());
    }
    trash_wallet(&state.root, &state.net(), &id, &dir)?;
    {
        let mut s = state.settings.lock().unwrap();
        let net = s.network.clone();
        if s.last_wallet.get(&net) == Some(&id) {
            s.last_wallet.remove(&net);
        }
    }
    // A wallet that was just closed can hold its database files for a few seconds (Tor and background
    // threads are still winding down). The seed goes first: without it the wallet is gone for good and
    // no longer listed. The rest is removed right away when possible, otherwise on the next start.
    let d = dir.clone();
    let all_gone = blocking(move || {
        let seed = d.join("wallet_data").join("wallet.seed");
        for _ in 0..25 {
            let _ = std::fs::remove_file(&seed);
            if !seed.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        if seed.exists() {
            anyhow::bail!("Cüzdan dosyaları hâlâ kullanımda; birkaç saniye sonra tekrar dene.");
        }
        for _ in 0..15 {
            if std::fs::remove_dir_all(&d).is_ok() || !d.exists() {
                return Ok(true);
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        Ok(false)
    })
    .await?;
    if !all_gone {
        state.settings.lock().unwrap().pending_delete.push(dir.to_string_lossy().into_owned());
    }
    state.save_settings()?;
    Ok(())
}

#[tauri::command]
async fn wallet_delete(app: tauri::AppHandle, state: St<'_>, password: String) -> Result<bool, String> {
    state.throttle()?;
    let o = state.open()?;
    let id = o.meta.id.clone();
    let w = o.wallet.clone();
    drop(o);
    let r = blocking({
        let w = w.clone();
        move || w.recovery_phrase(&password).map(|_| ())
    })
    .await;
    state.attempt(r)?;
    let dir = state.wallet_dir(&id)?;
    trash_wallet(&state.root, &state.net(), &id, &dir)?;
    {
        let mut s = state.settings.lock().unwrap();
        let net = s.network.clone();
        s.last_wallet.remove(&net);
    }
    let restarted = wallet_close(app.clone(), state.clone()).await?;
    if restarted {
        state.settings.lock().unwrap().pending_delete.push(dir.to_string_lossy().into_owned());
        state.save_settings()?;
        return Ok(true);
    }
    drop(w);
    for _ in 0..10 {
        if std::fs::remove_dir_all(&dir).is_ok() || !dir.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    state.save_settings()?;
    Ok(false)
}
#[tauri::command]
async fn change_password(state: St<'_>, old: String, new: String) -> Result<(), String> {
    check_password(&new)?;
    state.throttle()?;
    let w = state.wallet()?;
    let r = blocking(move || w.change_password(&old, &new)).await;
    state.attempt(r)
}

#[tauri::command]
async fn show_phrase(state: St<'_>, password: String) -> Result<Vec<String>, String> {
    state.throttle()?;
    let w = state.wallet()?;
    let r = blocking(move || Ok(w.recovery_phrase(&password)?.split_whitespace().map(String::from).collect())).await;
    state.attempt(r)
}

// ------------------------------------------------------------------ accounts

#[derive(Serialize)]
struct AccountDto {
    label: String,
    path: String,
    active: bool,
}

#[tauri::command]
async fn accounts(state: St<'_>) -> Result<Vec<AccountDto>, String> {
    let w = state.wallet()?;
    blocking(move || {
        Ok(w.accounts()?
            .into_iter()
            .map(|(label, path, active)| AccountDto { label, path, active })
            .collect())
    })
    .await
}

#[tauri::command]
async fn account_create(state: St<'_>, label: String) -> Result<(), String> {
    let w = state.wallet()?;
    blocking(move || w.create_account(&label)).await
}

#[tauri::command]
async fn account_set(state: St<'_>, label: String) -> Result<(), String> {
    let w = state.wallet()?;
    *state.tor_ready_at.lock().unwrap() = None;
    blocking(move || w.set_account(&label)).await
}

// ------------------------------------------------------------------ overview / txs

#[derive(Serialize)]
struct Overview {
    name: String,
    account: String,
    address: String,
    onion: String,
    spendable: String,
    awaiting: String,
    immature: String,
    locked: String,
    total: String,
    height: u64,
    node_ok: bool,
    min_confirmations: u64,
    /// The node the wallet is using right now, and how often it had to switch.
    node_in_use: String,
    node_failovers: usize,
    connection: String,
}

#[tauri::command]
async fn overview(state: St<'_>) -> Result<Overview, String> {
    let o = state.open()?;
    let min_conf = state.settings.lock().unwrap().send.min_confirmations.clamp(1, 10);
    blocking(move || {
        let w = &o.wallet;
        let (sp, onion) = w.address()?;
        let (fresh, i) = w.balance(min_conf)?;
        let account = w.accounts()?.into_iter().find(|a| a.2).map(|a| a.0).unwrap_or_default();
        Ok(Overview {
            name: o.meta.name.clone(),
            account,
            address: sp,
            onion,
            spendable: amount_to_hr_string(i.amount_currently_spendable, true),
            awaiting: amount_to_hr_string(i.amount_awaiting_confirmation + i.amount_awaiting_finalization, true),
            immature: amount_to_hr_string(i.amount_immature, true),
            locked: amount_to_hr_string(i.amount_locked, true),
            total: amount_to_hr_string(i.total, true),
            height: i.last_confirmed_height,
            node_ok: fresh,
            min_confirmations: min_conf,
            node_in_use: w.node_in_use(),
            node_failovers: w.node_failovers(),
            connection: o.meta.connection.clone(),
        })
    })
    .await
}

#[derive(Serialize)]
struct TxDto {
    id: u32,
    kind: String,
    amount: String,
    incoming: bool,
    fee: String,
    confirmed: bool,
    cancelled: bool,
    /// Both sides signed (slate state S3/I3) or confirmed: only waiting for the chain.
    finalized: bool,
    time: i64,
    confirmed_time: i64,
    slate_id: String,
    kernel: String,
    has_proof: bool,
    has_stored_tx: bool,
    inputs: usize,
    outputs: usize,
    ttl_height: u64,
}

fn tx_dto(t: orko_grin_core::TxLogEntry) -> TxDto {
    let kind = format!("{:?}", t.tx_type);
    let incoming = t.amount_credited >= t.amount_debited;
    let fee = t.fee.map(|f| f.fee()).unwrap_or(0);
    let net = if incoming {
        t.amount_credited - t.amount_debited
    } else {
        (t.amount_debited - t.amount_credited).saturating_sub(fee)
    };
    TxDto {
        id: t.id,
        cancelled: kind.contains("Cancelled"),
        amount: amount_to_hr_string(net, true),
        incoming,
        fee: if fee > 0 { amount_to_hr_string(fee, true) } else { String::new() },
        confirmed: t.confirmed,
        finalized: t.confirmed
            || matches!(t.tx_slate_state, Some(SlateState::Standard3) | Some(SlateState::Invoice3)),
        time: t.creation_ts.timestamp(),
        confirmed_time: t.confirmation_ts.map(|c| c.timestamp()).unwrap_or(0),
        slate_id: t.tx_slate_id.map(|u| u.to_string()).unwrap_or_default(),
        kernel: t
            .kernel_excess
            .map(|k| k.0.iter().map(|b| format!("{b:02x}")).collect())
            .unwrap_or_default(),
        has_proof: t.payment_proof.is_some(),
        has_stored_tx: t.stored_tx.is_some(),
        inputs: t.num_inputs,
        outputs: t.num_outputs,
        ttl_height: t.ttl_cutoff_height.unwrap_or(0),
        kind,
    }
}

#[tauri::command]
async fn transactions(state: St<'_>) -> Result<Vec<TxDto>, String> {
    let w = state.wallet()?;
    blocking(move || {
        let mut out: Vec<TxDto> = w.transactions(false)?.into_iter().map(tx_dto).collect();
        out.reverse();
        Ok(out)
    })
    .await
}

#[tauri::command]
async fn payment_proof(state: St<'_>, slate_id: String) -> Result<String, String> {
    let w = state.wallet()?;
    blocking(move || w.payment_proof(&slate_id)).await
}

#[tauri::command]
async fn repost(state: St<'_>, slate_id: String) -> Result<(), String> {
    let w = state.wallet()?;
    blocking(move || w.repost(&slate_id)).await
}

/// Slatepack texts of unfinished transactions are kept next to the wallet so a closed dialog is not the
/// end of the exchange: the transaction can be opened again from the list. They hold no secrets (a
/// slatepack is meant to be handed to the other side), and are removed when the transaction is cancelled.
fn slatepack_file(state: &AppState, wallet_id: &str, slate_id: &str) -> Option<PathBuf> {
    if slate_id.is_empty() || !slate_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    Some(state.wallet_dir(wallet_id).ok()?.join("slatepacks").join(format!("{slate_id}.txt")))
}
fn save_slatepack(state: &AppState, wallet_id: &str, slate_id: &str, text: &str) {
    if let Some(p) = slatepack_file(state, wallet_id, slate_id) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, text);
    }
}

#[derive(Serialize)]
struct SavedSlatepack {
    message: String,
    qr: String,
}

/// The Slatepack text saved for an unfinished transaction, if there is one.
#[tauri::command]
fn saved_slatepack(state: St<'_>, slate_id: String) -> Result<Option<SavedSlatepack>, String> {
    let o = state.open()?;
    let Some(p) = slatepack_file(&state, &o.meta.id, &slate_id) else { return Ok(None) };
    Ok(std::fs::read_to_string(p).ok().filter(|m| !m.trim().is_empty()).map(|m| SavedSlatepack { qr: qr_svg(&m), message: m }))
}

#[tauri::command]
async fn cancel_tx(state: St<'_>, slate_id: String) -> Result<(), String> {
    if let Ok(o) = state.open() {
        if let Some(p) = slatepack_file(&state, &o.meta.id, &slate_id) {
            let _ = std::fs::remove_file(p);
        }
    }
    set_job(&state, &slate_id, |j| {
        if j.state == "retrying" {
            j.state = "cancelled".into();
        }
    });
    let w = state.wallet()?;
    blocking(move || w.cancel(&slate_id)).await
}

/// Repair: rescan in the background from `since` ("all" or a year), dropping what the chain does
/// not know (grin-wallet `scan -d`).
#[tauri::command]
fn rescan(state: St<'_>, since: String) -> Result<(), String> {
    let start = scan_start(&state, &since).unwrap_or(1);
    start_scan(state.inner(), start, true)
}

// ------------------------------------------------------------------ tor

#[derive(Serialize)]
struct TorDto {
    /// "off" | "starting" | "ready" | "failed"
    state: String,
    percent: u8,
    message: String,
    /// Seconds since tor became ready (the onion is findable ~2 min later).
    ready_for: u64,
    engine: String,
    bridges: String,
    /// Whole progress 0..100: Tor connecting 0-35, address spreading 35-90 (estimated), then a real
    /// reachability test; 100 only after that test passed.
    overall: u8,
    /// 1 = connecting to Tor, 2 = address spreading, 3 = online (test passed)
    stage: u8,
    reachable: bool,
}

#[tauri::command]
fn tor_status(state: St<'_>) -> TorDto {
    let w = state.open.read().unwrap().clone();
    let st = w.and_then(|o| o.wallet.tor_status());
    let mut ready_at = state.tor_ready_at.lock().unwrap();
    let (s, pct, msg) = match st {
        None => ("off", 0, String::new()),
        Some(TorStatus::Starting(p)) => ("starting", p, String::new()),
        Some(TorStatus::Ready) => ("ready", 100, String::new()),
        Some(TorStatus::Failed(m)) => ("failed", 0, m),
    };
    if s == "ready" && ready_at.is_none() {
        *ready_at = Some(Instant::now());
    }
    if s != "ready" {
        *ready_at = None;
    }
    let reachable = s == "ready" && state.reachable.load(std::sync::atomic::Ordering::Relaxed);
    let elapsed = ready_at.map(|t| t.elapsed().as_secs()).unwrap_or(0);
    let (stage, overall) = match (s, reachable) {
        ("ready", true) => (3u8, 100u8),
        ("ready", false) => (2, (35 + (55 * elapsed.min(120) / 120)) as u8),
        ("starting", _) => (1, (pct as u32 * 35 / 100) as u8),
        _ => (1, 0),
    };
    let set = state.settings.lock().unwrap();
    TorDto {
        overall,
        stage,
        reachable,
        state: s.into(),
        percent: pct,
        message: msg,
        ready_for: ready_at.map(|t| t.elapsed().as_secs()).unwrap_or(0),
        engine: set.tor.clone(),
        bridges: set.bridges.clone(),
    }
}

/// Connection diagnostics for the Repair tab. Returns plain facts and ids; the interface words them.
#[tauri::command]
async fn tor_diagnose(state: St<'_>) -> Result<serde_json::Value, String> {
    let tor = tor_status(state.clone());
    let log_path = state.root.join("orkowallet.log");
    let (net, skew, reach, hints) = blocking(move || {
        let net = orko_grin_core::diag::internet_ok();
        let skew = if net { orko_grin_core::diag::clock_skew_secs() } else { None };
        let reach = if net { orko_grin_core::diag::tor_direct_reach() } else { (0, 0) };
        let bytes = std::fs::read(&log_path).unwrap_or_default();
        let tail = &bytes[bytes.len().saturating_sub(400_000)..];
        let hints = orko_grin_core::diag::log_hints(&String::from_utf8_lossy(tail));
        Ok((net, skew, reach, hints))
    })
    .await?;
    let advice = if !net {
        "internet"
    } else if skew.is_some_and(|s| s.abs() > 300) {
        "clock"
    } else if tor.bridges == "none" && reach.0 == 0 {
        "bridge"
    } else if tor.state == "ready" && tor.reachable {
        "ok"
    } else if tor.state == "ready" && tor.ready_for < 300 {
        "wait"
    } else if tor.state == "starting" && !hints.contains(&"stuck") {
        "connecting"
    } else {
        "repair"
    };
    Ok(serde_json::json!({
        "internet": net,
        "skew": skew,
        "reach_ok": reach.0,
        "reach_total": reach.1,
        "tor_state": tor.state,
        "tor_percent": tor.percent,
        "tor_reachable": tor.reachable,
        "tor_ready_for": tor.ready_for,
        "tor_message": tor.message,
        "bridges": tor.bridges,
        "hints": hints,
        "advice": advice,
    }))
}

/// Save bridge settings and apply them at once (restarts the bundled tor).
#[tauri::command]
async fn tor_apply(state: St<'_>, bridges: String, custom_bridges: String, engine: String) -> Result<bool, String> {
    let engine_changed;
    let lines = {
        let mut s = state.settings.lock().unwrap();
        if bridges == "custom" && custom_bridges.trim().is_empty() {
            return Err("En az bir köprü satırı yaz.".into());
        }
        s.bridges = bridges;
        s.custom_bridges = custom_bridges;
        engine_changed = s.tor != engine;
        s.tor = if engine == "arti" { "arti".into() } else { "bundled".into() };
        state.bridge_lines(&s)
    };
    state.save_settings()?;
    if engine_changed {
        return Ok(true); // needs reopen
    }
    if let Ok(w) = state.wallet() {
        *state.tor_ready_at.lock().unwrap() = None;
        blocking(move || w.restart_tor(lines)).await?;
    }
    Ok(false)
}

/// While a wallet is open: once Tor is ready, keep testing that the wallet's own onion address
/// answers over Tor. Fast retries until it does, then a slow re-check to notice losing it.
fn reach_watcher(state: Arc<AppState>, ow: Arc<OpenWallet>) {
    use std::sync::atomic::Ordering::Relaxed;
    std::thread::spawn(move || {
        let mut fails = 0u32;
        // Tor is up but the onion address never answers: after a few minutes start tor again from a clean
        // state (new entry relays), once per session. The hint on the Tor card covers what is left.
        let mut stuck_since: Option<Instant> = None;
        let mut healed = false;
        loop {
            let open_still = state.open.read().unwrap().as_ref().map(|o| Arc::ptr_eq(&o.wallet, &ow.wallet)).unwrap_or(false);
            if !open_still {
                state.reachable.store(false, Relaxed);
                return;
            }
            let pause = if matches!(ow.wallet.tor_status(), Some(TorStatus::Ready)) {
                if ow.wallet.self_check(25).is_ok() {
                    fails = 0;
                    stuck_since = None;
                    state.reachable.store(true, Relaxed);
                    90
                } else {
                    fails += 1;
                    if fails >= 2 {
                        state.reachable.store(false, Relaxed);
                    }
                    let since = *stuck_since.get_or_insert_with(Instant::now);
                    if !healed && since.elapsed() > Duration::from_secs(240) {
                        healed = true;
                        stuck_since = None;
                        orko_grin_core::tor::glog(log::Level::Warn, "tor: address unreachable for 4 min, restarting tor from a clean state");
                        *state.tor_ready_at.lock().unwrap() = None;
                        if let Err(e) = ow.wallet.reset_tor() {
                            orko_grin_core::tor::glog(log::Level::Warn, &format!("tor: clean restart failed: {e}"));
                        }
                    }
                    8
                }
            } else {
                // Tor (re)starting, e.g. after an account switch or a bridge change.
                state.reachable.store(false, Relaxed);
                fails = 0;
                2
            };
            std::thread::sleep(Duration::from_secs(pause));
        }
    });
}

// ------------------------------------------------------------------ send / receive

#[tauri::command]
fn check_address(address: String) -> bool {
    orko_grin_core::is_valid_address(&address)
}

#[tauri::command]
async fn ping(state: St<'_>, address: String) -> Result<(), String> {
    let w = state.wallet()?;
    // A first contact with an onion usually takes 10-30 s; give up after 60 s (the UI shows progress).
    blocking(move || w.ping(&address, 60)).await
}

#[derive(Serialize)]
struct SendDto {
    /// "tor" = delivered and posted; "slatepack" = hand `message` to the receiver;
    /// "queued" = recipient offline, retried in the background.
    kind: String,
    slate_id: String,
    message: String,
    qr: String,
    tor_error: String,
    retry_minutes: u64,
}

#[tauri::command]
async fn max_sendable(state: St<'_>) -> Result<String, String> {
    let o = state.open()?;
    let min_conf = state.settings.lock().unwrap().send.min_confirmations.clamp(1, 10);
    blocking(move || {
        let (max, _, _) = o.wallet.max_sendable(min_conf)?;
        Ok(amount_to_hr_string(max, true))
    })
    .await
}

#[tauri::command]
async fn send(state: St<'_>, amount: String, address: String, password: Option<String>, method: String, send_max: Option<bool>) -> Result<SendDto, String> {
    let over_tor = method != "slatepack";
    if over_tor && address.trim().is_empty() {
        return Err("Tor ile göndermek için alıcının adresini yaz.".into());
    }
    let o = state.open()?;
    let cfg = state.settings.lock().unwrap().send.clone();
    if cfg.confirm_password {
        // Spending needs the password again (stops someone at an unlocked screen).
        state.throttle()?;
        let pw = password.unwrap_or_default();
        let w = o.wallet.clone();
        let r = blocking(move || w.recovery_phrase(&pw).map(|_| ())).await;
        state.attempt(r)?;
    }
    let opts = orko_grin_core::SendOptions {
        change_outputs: cfg.change_outputs,
        use_all: cfg.strategy == "all",
        ttl_blocks: (cfg.ttl_blocks > 0).then_some(cfg.ttl_blocks),
        fluff: cfg.fluff,
        tor: over_tor,
        amount_includes_fee: false,
    };
    let min_conf = cfg.min_confirmations.clamp(1, 10);
    let mut opts = opts;
    let amount = if send_max.unwrap_or(false) {
        // "Max": everything spendable goes out and the fee is taken from it.
        let w = o.wallet.clone();
        let (_, total, _) = blocking(move || w.max_sendable(min_conf)).await?;
        if total == 0 {
            return Err("Gönderilebilir bakiye yok.".into());
        }
        opts.amount_includes_fee = true;
        total
    } else {
        amount_from_hr_string(amount.trim().replace(',', ".").as_str()).map_err(|_| "Tutar geçersiz.".to_string())?
    };
    if amount == 0 {
        return Err("Tutar sıfırdan büyük olmalı.".into());
    }
    let dest = address.trim().to_string();
    if !dest.is_empty() && !orko_grin_core::is_valid_address(&dest) {
        return Err("Bu adres bu ağ için geçerli bir Grin adresi değil.".into());
    }
    let st = state.inner().clone();
    blocking(move || {
        let d = (!dest.is_empty()).then_some(dest.as_str());
        Ok(match o.wallet.send(amount, d, min_conf, &opts)? {
            SendOutcome::PostedOverTor { tx_slate_id } => SendDto {
                kind: "tor".into(),
                slate_id: tx_slate_id,
                message: String::new(),
                qr: String::new(),
                tor_error: String::new(),
                retry_minutes: 0,
            },
            SendOutcome::Slatepack { tx_slate_id, message, tor_error } => {
                save_slatepack(&st, &o.meta.id, &tx_slate_id, &message);
                SendDto {
                kind: "slatepack".into(),
                slate_id: tx_slate_id,
                qr: qr_svg(&message),
                message,
                tor_error: tor_error.unwrap_or_default(),
                retry_minutes: 0,
                }
            }
            SendOutcome::Unreached { tx_slate_id, error, pending } => {
                if cfg.retry {
                    spawn_send_job(st, o.clone(), tx_slate_id.clone(), pending, cfg.retry_minutes);
                    SendDto {
                        kind: "queued".into(),
                        slate_id: tx_slate_id,
                        message: String::new(),
                        qr: String::new(),
                        tor_error: error,
                        retry_minutes: cfg.retry_minutes,
                    }
                } else {
                    let _ = o.wallet.cancel(&tx_slate_id); // unlock the funds
                    anyhow::bail!("Alıcıya ulaşılamadı; işlem başarısız oldu, tutar serbest kaldı. Ayarlardan yeniden denemeyi açabilirsin.");
                }
            }
        })
    })
    .await
}

/// A payment waiting for an offline recipient.
#[derive(Clone, Serialize)]
struct JobView {
    slate_id: String,
    /// "retrying" | "done" | "failed" | "cancelled" | "paused"
    state: String,
    attempts: u32,
    max_attempts: u32,
    /// Seconds until the next attempt.
    next_in: u64,
    error: String,
}

struct ActiveGuard(Arc<AppState>);
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.jobs_active.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

fn set_job(st: &AppState, id: &str, f: impl FnOnce(&mut JobView)) {
    if let Some(j) = st.jobs.lock().unwrap().get_mut(id) {
        f(j);
    }
}

/// Try the payment again every minute for `minutes` minutes, while this wallet stays open. When time
/// runs out the transaction is cancelled, which unlocks the funds. Nothing falls back to a Slatepack.
fn spawn_send_job(st: Arc<AppState>, ow: Arc<OpenWallet>, id: String, p: orko_grin_core::PendingSend, minutes: u64) {
    use std::sync::atomic::Ordering::SeqCst;
    let minutes = minutes.clamp(1, 240);
    st.jobs.lock().unwrap().insert(id.clone(), JobView { slate_id: id.clone(), state: "retrying".into(), attempts: 1, max_attempts: minutes as u32 + 1, next_in: 60, error: String::new() });
    st.jobs_active.fetch_add(1, SeqCst);
    std::thread::spawn(move || {
        let _g = ActiveGuard(st.clone());
        for n in 1..=minutes {
            for left in (0..60u64).rev() {
                std::thread::sleep(Duration::from_secs(1));
                let same = st.open.read().unwrap().as_ref().map(|o| Arc::ptr_eq(&o.wallet, &ow.wallet)).unwrap_or(false);
                let running = st.jobs.lock().unwrap().get(&id).map(|j| j.state == "retrying").unwrap_or(false);
                if st.jobs_stop.load(SeqCst) || !same || !running {
                    if running {
                        set_job(&st, &id, |j| j.state = "paused".into());
                    }
                    return;
                }
                set_job(&st, &id, |j| j.next_in = left);
            }
            set_job(&st, &id, |j| j.attempts = n as u32 + 1);
            match ow.wallet.retry_send(&p, 60) {
                Ok(()) => {
                    set_job(&st, &id, |j| j.state = "done".into());
                    return;
                }
                Err(e) => set_job(&st, &id, |j| j.error = e.to_string()),
            }
        }
        let _ = ow.wallet.cancel(&id);
        set_job(&st, &id, |j| j.state = "failed".into());
    });
}

#[tauri::command]
fn send_jobs(state: St<'_>) -> Vec<JobView> {
    state.jobs.lock().unwrap().values().cloned().collect()
}

#[derive(Serialize)]
struct ProcessDto {
    /// "returned" (signed, sent back over Tor) | "reply" (give `message` back) | "finalized"
    kind: String,
    message: String,
    qr: String,
    /// The reply is also being sent to the sender over Tor in the background.
    auto_return: bool,
}

/// A pasted Slatepack: an incoming payment is signed and the reply text comes back at once; if
/// the sender gave an address the reply is also pushed to them over Tor in the background.
#[tauri::command]
async fn process_slatepack(state: St<'_>, text: String) -> Result<ProcessDto, String> {
    let o = state.open()?;
    let w = o.wallet.clone();
    let wid = o.meta.id.clone();
    let st = state.inner().clone();
    blocking(move || {
        let sid = w.slatepack_id(&text).ok();
        let (outcome, pending) = w.process_slatepack(&text)?;
        let auto_return = pending.is_some();
        if let Some(p) = pending {
            let w2 = w.clone();
            std::thread::spawn(move || {
                if let Err(e) = w2.finish_return(p) {
                    orko_grin_core::tor::glog(log::Level::Warn, &format!("reply over Tor failed: {e}"));
                }
            });
        }
        let none = |kind: &str| ProcessDto { kind: kind.into(), message: String::new(), qr: String::new(), auto_return: false };
        Ok(match outcome {
            ProcessOutcome::Received(ReceiveOutcome::ReturnedOverTor) => none("returned"),
            ProcessOutcome::Received(ReceiveOutcome::Slatepack(m)) => {
                if let Some(id) = &sid {
                    save_slatepack(&st, &wid, id, &m);
                }
                ProcessDto { kind: "reply".into(), qr: qr_svg(&m), message: m, auto_return }
            }
            ProcessOutcome::Finalized { .. } => none("finalized"),
        })
    })
    .await
}

/// Chain scan progress (restore / repair): 0..100, or -1 when no scan is running.
#[tauri::command]
fn scan_progress() -> i32 {
    orko_grin_core::scan_progress()
}

#[tauri::command]
fn address_qr(text: String) -> String {
    qr_svg(&text)
}

// ------------------------------------------------------------------ node

#[derive(Serialize)]
struct NodeDto {
    /// "integrated" | "remote"
    mode: String,
    url: String,
    version: String,
    error: String,
    /// Seconds since the remote snapshot was taken.
    age: u64,
    view: Option<NodeView>,
    integrated_state: String,
    autostart: bool,
}

#[tauri::command]
fn node_view(state: St<'_>) -> NodeDto {
    let iv = state.node.view();
    let autostart = state.settings.lock().unwrap().node.autostart;
    if iv.state != "stopped" {
        return NodeDto {
            mode: "integrated".into(),
            url: state.node.settings.api_url(),
            version: format!("grin {}", grin_version()),
            error: iv.error.clone(),
            age: 0,
            integrated_state: iv.state.clone(),
            view: Some(iv),
            autostart,
        };
    }
    let r = state.remote.lock().unwrap().clone();
    NodeDto {
        mode: "remote".into(),
        url: r.url,
        version: r.version,
        error: r.error,
        age: r.at.map(|t| t.elapsed().as_secs()).unwrap_or(0),
        view: r.view,
        integrated_state: iv.state,
        autostart,
    }
}

fn grin_version() -> &'static str {
    "5.5.2"
}

#[tauri::command]
async fn node_start(state: St<'_>) -> Result<(), String> {
    let n = state.node.clone();
    blocking(move || n.start()).await
}

#[tauri::command]
async fn node_stop(state: St<'_>) -> Result<(), String> {
    let n = state.node.clone();
    blocking(move || {
        n.stop(true);
        Ok(())
    })
    .await
}

/// Which external node the panel should show right now: the one the open wallet is using, else
/// the best healthy node of the pool.
fn panel_url(state: &AppState) -> String {
    if let Some(o) = state.open.read().unwrap().as_ref() {
        if o.meta.connection != "integrated" {
            return o.wallet.node_in_use();
        }
    }
    let pool = state.settings.lock().unwrap().pool_nodes();
    let probes = state.probes.lock().unwrap();
    pool.iter()
        .filter_map(|u| probes.iter().find(|p| &p.url == u && p.ok))
        .min_by_key(|p| p.latency_ms)
        .map(|p| p.url.clone())
        .or_else(|| pool.first().cloned())
        .unwrap_or_default()
}

// ------------------------------------------------------------------ backup / export / support

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian.
fn civil(secs: i64) -> (i64, u32, u32, i64) {
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d, secs.rem_euclid(86_400))
}

fn iso(secs: i64) -> String {
    let (y, m, d, s) = civil(secs);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", s / 3600, s % 3600 / 60, s % 60)
}

fn stamp() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    iso(now).replace(['-', ' ', ':'], "")
}

fn csv_field(s: &str) -> String {
    if s.contains(['"', ',', '\n']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() }
}

fn safe_name(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' }).collect()
}

/// Write the transaction history of the open wallet as CSV into the Downloads folder.
#[tauri::command]
async fn export_transactions(app: tauri::AppHandle, state: St<'_>) -> Result<String, String> {
    let o = state.open()?;
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let name = format!("OrkoWallet-{}-{}.csv", safe_name(&o.meta.name), stamp());
    let path = dir.join(name);
    let p2 = path.clone();
    blocking(move || {
        let mut out = String::from("date,type,amount_grin,fee_grin,confirmed,transaction_id,kernel\n");
        for t in o.wallet.transactions(false)? {
            let x = tx_dto(t);
            let sign = if x.incoming { "" } else { "-" };
            out.push_str(&format!(
                "{},{},{}{},{},{},{},{}\n",
                iso(x.time), csv_field(&x.kind), sign, x.amount, x.fee, x.confirmed, csv_field(&x.slate_id), csv_field(&x.kernel)
            ));
        }
        std::fs::write(&p2, out)?;
        Ok(())
    })
    .await?;
    Ok(path.to_string_lossy().into_owned())
}

/// Copy the encrypted seed file of the open wallet to the Downloads folder. It is protected by
/// the wallet password and restores the keys; balances come back after a scan.
#[tauri::command]
async fn backup_wallet(app: tauri::AppHandle, state: St<'_>) -> Result<String, String> {
    let o = state.open()?;
    let src = state.wallet_dir(&o.meta.id)?.join("wallet_data").join("wallet.seed");
    let dir = app.path().download_dir().map_err(|e| e.to_string())?.join(format!("OrkoWallet-backup-{}-{}", safe_name(&o.meta.name), stamp()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::copy(&src, dir.join("wallet.seed")).map_err(|e| e.to_string())?;
    let note = "OrkoWallet backup\n\nwallet.seed is the encrypted seed of this wallet. It opens only with the wallet password.\nTo restore: put it in <wallet folder>\\wallet_data\\ (or restore with your 24-word recovery phrase, which is the real backup).\nKeep this folder offline.\n";
    let _ = std::fs::write(dir.join("README.txt"), note);
    Ok(dir.to_string_lossy().into_owned())
}

/// Show the app data folder (logs, settings) in the file manager.
#[tauri::command]
fn open_data_folder(state: St<'_>) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("explorer").arg(&state.root).spawn();
    }
    #[cfg(not(windows))]
    let _ = &state;
}

/// Open a transaction kernel in the Grin Scan block explorer (mainnet only), in the default browser.
/// Only a kernel excerpt (hex) is accepted, so the address that is opened is always
/// `https://scan.grin.money/kernel/<hex>` and nothing the UI sends can change the host or add arguments.
#[tauri::command]
fn open_kernel(state: St<'_>, kernel: String) -> Result<(), String> {
    if state.settings.lock().unwrap().network != "mainnet" {
        return Err("Kernel explorer is only available on mainnet".into());
    }
    let k = kernel.trim();
    if k.len() < 8 || k.len() > 130 || !k.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Not a kernel".into());
    }
    let url = format!("https://scan.grin.money/kernel/{}", k.to_ascii_lowercase());
    #[cfg(windows)]
    {
        std::process::Command::new("explorer").arg(&url).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = url;
    Ok(())
}

// ------------------------------------------------------------------ node pool

fn is_http_url(u: &str) -> bool {
    (u.starts_with("http://") || u.starts_with("https://")) && u.len() > 10 && !u.contains(char::is_whitespace)
}

#[derive(Serialize)]
struct NodeEntry {
    url: String,
    builtin: bool,
    /// None until the first health check finished.
    ok: Option<bool>,
    latency_ms: u64,
    height: u64,
    error: String,
    in_use: bool,
    /// The user chose this node (see `node_use`).
    preferred: bool,
}

fn node_entries(state: &AppState) -> Vec<NodeEntry> {
    let s = state.settings.lock().unwrap().clone();
    let builtin = builtin_nodes(s.network());
    let in_use = state
        .open
        .read()
        .unwrap()
        .as_ref()
        .filter(|o| o.meta.connection != "integrated")
        .map(|o| o.wallet.node_in_use());
    let probes = state.probes.lock().unwrap();
    s.pool_nodes()
        .into_iter()
        .map(|url| {
            let p = probes.iter().find(|p| p.url == url);
            NodeEntry {
                builtin: builtin.contains(&url),
                ok: p.map(|p| p.ok),
                latency_ms: p.map(|p| p.latency_ms).unwrap_or(0),
                height: p.map(|p| p.height).unwrap_or(0),
                error: p.map(|p| p.error.clone()).unwrap_or_default(),
                in_use: in_use.as_deref() == Some(url.as_str()),
                preferred: s.preferred_node.get(&s.network).map(|p| p == &url).unwrap_or(false),
                url,
            }
        })
        .collect()
}

fn refresh_probes(state: &AppState) {
    let pool = state.settings.lock().unwrap().pool_nodes();
    let res = orko_grin_core::remote::probe_nodes(&pool);
    *state.probes.lock().unwrap() = res;
}

#[tauri::command]
fn nodes_list(state: St<'_>) -> Vec<NodeEntry> {
    node_entries(&state)
}

/// Health-check every node of the pool now (up to 6 s) and return the fresh list.
#[tauri::command]
async fn nodes_probe(state: St<'_>) -> Result<Vec<NodeEntry>, String> {
    let st = state.inner().clone();
    blocking(move || {
        refresh_probes(&st);
        Ok(node_entries(&st))
    })
    .await
}

/// Add a node of the user's own to the pool of this network. It must answer a health check.
#[tauri::command]
async fn node_add(state: St<'_>, url: String) -> Result<Vec<NodeEntry>, String> {
    let url = url.trim().trim_end_matches('/').to_string();
    if !is_http_url(&url) {
        return Err("Node adresi http:// ya da https:// ile başlamalı.".into());
    }
    if state.settings.lock().unwrap().pool_nodes().contains(&url) {
        return Err("Bu node zaten listede.".into());
    }
    let st = state.inner().clone();
    blocking(move || {
        let p = orko_grin_core::remote::probe_nodes(&[url.clone()]).pop().unwrap_or_default();
        if !p.ok {
            anyhow::bail!("Bu adrese ulaşılamadı: {}", p.error);
        }
        {
            let mut s = st.settings.lock().unwrap();
            let net = s.network.clone();
            s.custom_nodes.entry(net).or_default().push(url);
        }
        st.save_settings().map_err(|e| anyhow::anyhow!(e))?;
        refresh_probes(&st);
        Ok(node_entries(&st))
    })
    .await
}

#[tauri::command]
fn node_remove(state: St<'_>, url: String) -> Result<Vec<NodeEntry>, String> {
    {
        let mut s = state.settings.lock().unwrap();
        let net = s.network.clone();
        if let Some(v) = s.custom_nodes.get_mut(&net) {
            v.retain(|u| u != &url);
        }
    }
    state.save_settings()?;
    state.probes.lock().unwrap().retain(|p| p.url != url);
    Ok(node_entries(&state))
}

/// Pick the node this network's wallets use (None = automatic). An open wallet in pool mode
/// switches to it at once; it still fails over to the others if it breaks.
#[tauri::command]
fn node_use(state: St<'_>, url: Option<String>) -> Result<Vec<NodeEntry>, String> {
    {
        let mut s = state.settings.lock().unwrap();
        let net = s.network.clone();
        match &url {
            Some(u) => {
                if !s.pool_nodes().contains(u) {
                    return Err("Bu node listede yok.".into());
                }
                s.preferred_node.insert(net, u.clone());
            }
            None => {
                s.preferred_node.remove(&net);
            }
        }
    }
    state.save_settings()?;
    if let (Some(u), Some(o)) = (&url, state.open.read().unwrap().as_ref()) {
        if o.meta.connection != "integrated" {
            o.wallet.prefer_node(u);
        }
    }
    Ok(node_entries(&state))
}

fn probe_poller(state: Arc<AppState>) {
    std::thread::spawn(move || loop {
        refresh_probes(&state);
        std::thread::sleep(Duration::from_secs(45));
    });
}

fn remote_poller(state: Arc<AppState>) {
    std::thread::spawn(move || loop {
        if state.node.view().state == "stopped" {
            let url = panel_url(&state);
            let res = orko_grin_core::remote::remote_view(&url, 10);
            let mut c = state.remote.lock().unwrap();
            c.url = url;
            c.at = Some(Instant::now());
            match res {
                Ok((v, ver)) => {
                    c.view = Some(v);
                    c.version = ver;
                    c.error.clear();
                }
                Err(e) => c.error = e.to_string(),
            }
        }
        std::thread::sleep(Duration::from_secs(15));
    });
}

// ------------------------------------------------------------------ tray and desktop notifications

/// Wording of the tray menu and the desktop notifications. The UI reports its language (`ui_lang`);
/// order: tr, en, de, fr, ru, zh. An unknown language falls back to English.
fn say(lang: &str, key: &str) -> &'static str {
    let row: [&'static str; 6] = match key {
        "tray_show" => ["OrkoWallet'i aç", "Open OrkoWallet", "OrkoWallet öffnen", "Ouvrir OrkoWallet", "Открыть OrkoWallet", "打开 OrkoWallet"],
        "tray_quit" => ["Çık", "Quit", "Beenden", "Quitter", "Выход", "退出"],
        "tray_tip" => [
            "OrkoWallet – Grin çalışıyor",
            "OrkoWallet – Grin is running",
            "OrkoWallet – Grin läuft",
            "OrkoWallet – Grin est actif",
            "OrkoWallet – Grin работает",
            "OrkoWallet – Grin 正在运行",
        ],
        "hint_title" => [
            "OrkoWallet arka planda çalışıyor",
            "OrkoWallet keeps running",
            "OrkoWallet läuft im Hintergrund weiter",
            "OrkoWallet reste actif en arrière-plan",
            "OrkoWallet продолжает работать в фоне",
            "OrkoWallet 在后台继续运行",
        ],
        "hint_body" => [
            "Sistem tepsisindeki simgeden açabilir ya da tamamen kapatabilirsin.",
            "Open it from the tray icon, or quit it there.",
            "Öffne es über das Tray-Symbol oder beende es dort.",
            "Ouvrez-le depuis l'icône de la zone de notification, ou quittez-le depuis là.",
            "Откройте его через значок в трее или завершите работу там.",
            "可从托盘图标打开，或在那里退出。",
        ],
        "tor_lost_title" => ["Tor bağlantısı kesildi", "Tor connection lost", "Tor-Verbindung unterbrochen", "Connexion Tor perdue", "Соединение с Tor потеряно", "Tor 连接已断开"],
        "tor_lost_body" => [
            "Adresin şu an ödeme alamıyor. Cüzdan yeniden bağlanmayı deniyor.",
            "Your address cannot receive payments right now. The wallet is trying to reconnect.",
            "Deine Adresse kann gerade keine Zahlungen empfangen. Die Wallet versucht, sich neu zu verbinden.",
            "Votre adresse ne peut pas recevoir de paiements pour le moment. Le portefeuille tente de se reconnecter.",
            "Сейчас адрес не может принимать платежи. Кошелёк пытается переподключиться.",
            "您的地址目前无法收款。钱包正在尝试重新连接。",
        ],
        "tor_back_title" => ["Tor bağlantısı yeniden kuruldu", "Tor connection restored", "Tor-Verbindung wiederhergestellt", "Connexion Tor rétablie", "Соединение с Tor восстановлено", "Tor 连接已恢复"],
        "tor_back_body" => [
            "Adresin yeniden ödeme alabilir.",
            "Your address can receive payments again.",
            "Deine Adresse kann wieder Zahlungen empfangen.",
            "Votre adresse peut de nouveau recevoir des paiements.",
            "Адрес снова может принимать платежи.",
            "您的地址可以再次收款。",
        ],
        "pay_in_title" => ["Ödeme alındı", "Payment received", "Zahlung erhalten", "Paiement reçu", "Платёж получен", "收到付款"],
        "pay_pending" => ["onay bekliyor", "waiting for confirmation", "wartet auf Bestätigung", "en attente de confirmation", "ожидает подтверждения", "等待确认"],
        "pay_conf_title" => ["Ödeme onaylandı", "Payment confirmed", "Zahlung bestätigt", "Paiement confirmé", "Платёж подтверждён", "付款已确认"],
        "sent_conf_title" => [
            "Gönderdiğin ödeme onaylandı",
            "Your payment was confirmed",
            "Deine Zahlung wurde bestätigt",
            "Votre paiement a été confirmé",
            "Ваш платёж подтверждён",
            "您的付款已确认",
        ],
        "locked_body" => [
            "Tutar, cüzdan kilitliyken gösterilmez.",
            "The amount is hidden while the wallet is locked.",
            "Der Betrag wird bei gesperrter Wallet nicht angezeigt.",
            "Le montant est masqué tant que le portefeuille est verrouillé.",
            "Сумма скрыта, пока кошелёк заблокирован.",
            "钱包锁定时不显示金额。",
        ],
        "many_title" => ["Yeni işlemler var", "New transactions", "Neue Transaktionen", "Nouvelles transactions", "Новые транзакции", "有新的交易"],
        "many_body" => [
            "Cüzdanda yeni işlemler görüldü. Ayrıntılar için uygulamayı aç.",
            "New activity in your wallet. Open the app for details.",
            "Neue Aktivität in deiner Wallet. Öffne die App für Details.",
            "Nouvelle activité dans votre portefeuille. Ouvrez l'application pour les détails.",
            "В кошельке новая активность. Откройте приложение, чтобы узнать подробности.",
            "钱包中有新活动。打开应用查看详情。",
        ],
        "test_title" => ["Bildirimler çalışıyor", "Notifications work", "Benachrichtigungen funktionieren", "Les notifications fonctionnent", "Уведомления работают", "通知正常"],
        "test_body" => [
            "Ödeme ve Tor durumu bildirimlerini böyle göreceksin.",
            "This is how payment and Tor status notifications will look.",
            "So sehen Zahlungs- und Tor-Benachrichtigungen aus.",
            "Voici à quoi ressembleront les notifications de paiement et d'état de Tor.",
            "Так будут выглядеть уведомления о платежах и состоянии Tor.",
            "付款和 Tor 状态通知将以这种方式显示。",
        ],
        _ => ["", "", "", "", "", ""],
    };
    let i = match lang {
        "tr" => 0,
        "de" => 2,
        "fr" => 3,
        "ru" => 4,
        "zh" => 5,
        _ => 1,
    };
    row[i]
}

/// The tray menu entries, kept so their text follows the interface language.
struct TrayItems {
    show: tauri::menu::MenuItem<tauri::Wry>,
    quit: tauri::menu::MenuItem<tauri::Wry>,
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toast(app: &tauri::AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::warn!("notification failed: {e}");
    }
}

fn lang_of(state: &AppState) -> String {
    state.ui_lang.lock().unwrap().clone()
}

/// The close button / Alt+F4: hide to the tray when that is on and the tray icon exists (otherwise the
/// window would be gone with no way back). Returns false when the app should really close.
fn hide_to_tray(app: &tauri::AppHandle) -> bool {
    let Some(st) = app.try_state::<Arc<AppState>>() else { return false };
    if app.try_state::<TrayItems>().is_none() || !st.settings.lock().unwrap().close_to_tray {
        return false;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    let first = {
        let mut s = st.settings.lock().unwrap();
        let first = !s.tray_hint_shown;
        s.tray_hint_shown = true;
        first
    };
    if first {
        let _ = st.save_settings();
        let l = lang_of(&st);
        toast(app, say(&l, "hint_title"), say(&l, "hint_body"));
    }
    true
}

/// The UI tells the Rust side its language: tray menu and tooltip follow it.
#[tauri::command]
fn ui_lang(app: tauri::AppHandle, state: St<'_>, lang: String) {
    *state.ui_lang.lock().unwrap() = lang.clone();
    if let Some(t) = app.try_state::<TrayItems>() {
        let _ = t.show.set_text(say(&lang, "tray_show"));
        let _ = t.quit.set_text(say(&lang, "tray_quit"));
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(say(&lang, "tray_tip")));
    }
}

#[tauri::command]
fn notify_test(app: tauri::AppHandle, state: St<'_>) {
    let l = lang_of(&state);
    toast(&app, say(&l, "test_title"), say(&l, "test_body"));
}

fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let show = MenuItem::with_id(app, "show", say("en", "tray_show"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", say("en", "tray_quit"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tb = TrayIconBuilder::with_id("main")
        .tooltip(say("en", "tray_tip"))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0), // RunEvent::Exit stops the integrated node cleanly
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tb = tb.icon(icon.clone());
    }
    tb.build(app)?;
    app.manage(TrayItems { show, quit });
    Ok(())
}

/// Watches the open wallet for things worth a desktop notification: a payment that arrives or gets
/// confirmed, and the Tor address going down or coming back. It runs here, not in the page, so it keeps
/// working while the window is hidden in the tray. Amounts are left out while the wallet is locked.
fn notifier(app: tauri::AppHandle, state: Arc<AppState>) {
    use std::sync::atomic::Ordering::Relaxed;
    std::thread::spawn(move || {
        let mut wid = String::new();
        let mut seen: Option<HashMap<u32, bool>> = None; // transaction id -> confirmed
        let mut was_ok = false;
        let mut down_since: Option<Instant> = None;
        let mut told_down = false;
        let mut last_refresh = Instant::now();
        loop {
            std::thread::sleep(Duration::from_secs(10));
            let Some(ow) = state.open.read().unwrap().clone() else {
                seen = None;
                wid.clear();
                was_ok = false;
                down_since = None;
                told_down = false;
                continue;
            };
            if ow.meta.id != wid {
                wid = ow.meta.id.clone();
                seen = None;
                was_ok = false;
                down_since = None;
                told_down = false;
                last_refresh = Instant::now();
            }
            let (want_pay, want_tor, min_conf) = {
                let s = state.settings.lock().unwrap();
                (s.notify_payments, s.notify_tor, s.send.min_confirmations.clamp(1, 10))
            };
            let l = lang_of(&state);

            // Tor: gone for a minute = tell once; back = tell once. A short restart stays silent.
            let ok = matches!(ow.wallet.tor_status(), Some(TorStatus::Ready)) && state.reachable.load(Relaxed);
            if ok {
                if told_down && want_tor {
                    toast(&app, say(&l, "tor_back_title"), say(&l, "tor_back_body"));
                }
                told_down = false;
                down_since = None;
                was_ok = true;
            } else if was_ok {
                let t0 = *down_since.get_or_insert_with(Instant::now);
                if !told_down && t0.elapsed() >= Duration::from_secs(60) {
                    told_down = true;
                    if want_tor {
                        toast(&app, say(&l, "tor_lost_title"), say(&l, "tor_lost_body"));
                    }
                }
            }

            // With the window hidden the page does not refresh the wallet from the node, so do it here.
            let scanning = state.scan.lock().unwrap().active;
            let window_idle = app
                .get_webview_window("main")
                .map(|w| !w.is_visible().unwrap_or(true) || w.is_minimized().unwrap_or(false))
                .unwrap_or(true);
            if window_idle && !scanning && last_refresh.elapsed() >= Duration::from_secs(60) {
                last_refresh = Instant::now();
                let _ = ow.wallet.balance(min_conf);
            }

            // Payments.
            let Ok(list) = ow.wallet.transactions(false) else { continue };
            let list: Vec<TxDto> = list.into_iter().map(tx_dto).collect();
            let now: HashMap<u32, bool> = list.iter().map(|t| (t.id, t.confirmed)).collect();
            if let Some(prev) = &seen {
                if want_pay && !scanning {
                    let mut events: Vec<(&'static str, String, String)> = Vec::new();
                    let locked = state.locked.load(Relaxed);
                    for t in list.iter().filter(|t| !t.cancelled) {
                        let amount = if locked { say(&l, "locked_body").to_string() } else { format!("{}{} ツ", if t.incoming { "+" } else { "−" }, t.amount) };
                        match prev.get(&t.id) {
                            None if t.incoming => events.push((
                                "pay_in_title",
                                say(&l, "pay_in_title").to_string(),
                                if locked { amount } else { format!("{amount} · {}", say(&l, "pay_pending")) },
                            )),
                            Some(false) if t.confirmed => events.push((
                                if t.incoming { "pay_conf_title" } else { "sent_conf_title" },
                                say(&l, if t.incoming { "pay_conf_title" } else { "sent_conf_title" }).to_string(),
                                amount,
                            )),
                            _ => {}
                        }
                    }
                    if events.len() > 3 {
                        toast(&app, say(&l, "many_title"), say(&l, "many_body"));
                    } else {
                        for (_, title, body) in events {
                            toast(&app, &title, &body);
                        }
                    }
                }
            }
            seen = Some(now);
        }
    });
}

// ------------------------------------------------------------------ main

fn main() {
    let mut builder = tauri::Builder::default();
    // One copy only: a second launch would start a second Tor on the same wallet folder and fail
    // ("another Tor process is running with the same data directory"). It focuses the first window
    // instead. Portable/test copies (ORKOWALLET_DATA) are separate on purpose and skip this.
    if std::env::var_os("ORKOWALLET_DATA").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            // Alt+F4 and the system close: hide to the tray when that is switched on.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && hide_to_tray(window.app_handle()) {
                    api.prevent_close();
                }
            }
        })
        .setup(|app| {
            // Portable / test mode: ORKOWALLET_DATA moves wallets, settings, node data and the
            // browser profile to one folder, so a second copy never touches the normal one.
            let custom = std::env::var_os("ORKOWALLET_DATA").map(PathBuf::from);
            let root = match &custom {
                Some(p) => p.clone(),
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&root)?;
            {
                let mut w = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                    .title("OrkoWallet – Grin")
                    .inner_size(1180.0, 740.0)
                    .min_inner_size(480.0, 600.0)
                    .decorations(false)
                    .shadow(true)
                    .center();
                if let Some(p) = &custom {
                    w = w.data_directory(p.join("webview"));
                }
                w.build()?;
            }
            let mut settings: AppSettings = std::fs::read_to_string(root.join("settings.json"))
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default();
            trash_purge_old(&root);
            // Wallets deleted last session (their folders were locked then).
            for p in std::mem::take(&mut settings.pending_delete) {
                let p = PathBuf::from(p);
                if p.starts_with(root.join("wallets")) {
                    let _ = std::fs::remove_dir_all(p);
                }
            }
            // Packaged: <resources>/tor. Dev: the vendored bundle next to the sources.
            let mut tor_dir = app.path().resource_dir()?.join("tor");
            if !tor_dir.join("tor").exists() {
                tor_dir = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../vendor/tor-16.0.1"));
            }
            let mut log = grin_util::logger::LoggingConfig::default();
            log.log_file_path = root.join("orkowallet.log").to_string_lossy().into_owned();
            log.log_to_file = true;
            log.stdout_log_level = log::Level::Warn;
            log.file_log_level = log::Level::Info;
            grin_util::init_logger(Some(log), None);
            let network = settings.network();
            orko_grin_core::select_network(network);
            let (api_port, p2p_port) = NodeSettings::default_ports(network);
            let node = Arc::new(IntegratedNode::new(NodeSettings {
                network,
                dir: root.join("node").join(net_name(network)),
                api_port,
                p2p_port,
                peers: settings.node.peers.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect(),
                only_these_peers: settings.node.only_peers,
                archive: settings.node.archive,
            }));
            if settings.node.autostart {
                if let Err(e) = node.start() {
                    log::error!("integrated node autostart failed: {e}");
                }
            }
            let state = Arc::new(AppState {
                root,
                tor_bundle: TorBundle { dir: tor_dir },
                settings: Mutex::new(settings),
                open: RwLock::new(None),
                tor_ready_at: Mutex::new(None),
                node,
                remote: Mutex::new(RemoteCache::default()),
                scan: Mutex::new(ScanState::default()),
                probes: Mutex::new(Vec::new()),
                locked: std::sync::atomic::AtomicBool::new(false),
                reachable: std::sync::atomic::AtomicBool::new(false),
                jobs: Mutex::new(HashMap::new()),
                jobs_stop: std::sync::atomic::AtomicBool::new(false),
                jobs_active: std::sync::atomic::AtomicUsize::new(0),
                guard: Mutex::new((0, Instant::now())),
                ui_lang: Mutex::new("en".into()),
            });
            let _ = state.save_settings();
            probe_poller(state.clone());
            remote_poller(state.clone());
            app.manage(state.clone());
            if let Err(e) = build_tray(app) {
                log::warn!("tray icon unavailable: {e}"); // the close button then really closes
            }
            notifier(app.handle().clone(), state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
            save_settings,
            switch_network,
            wallet_create,
            wallet_restore,
            wallet_import,
            wallet_open,
            wallet_close,
            win_min,
            win_max,
            win_drag,
            win_close,
            ui_lang,
            notify_test,
            wallet_update,
            wallet_delete,
            wallet_remove,
            tor_diagnose,
            trash_list,
            trash_restore,
            trash_purge,
            repair_restart,
            saved_slatepack,
            change_password,
            show_phrase,
            accounts,
            account_create,
            account_set,
            overview,
            transactions,
            payment_proof,
            repost,
            cancel_tx,
            rescan,
            tor_status,
            tor_apply,
            check_address,
            ping,
            send,
            process_slatepack,
            scan_progress,
            scan_status,
            verify_password,
            send_jobs,
            max_sendable,
            export_transactions,
            backup_wallet,
            open_data_folder,
            open_kernel,
            set_locked,
            set_protected,
            nodes_list,
            nodes_probe,
            node_add,
            node_remove,
            node_use,
            address_qr,
            node_view,
            node_start,
            node_stop
        ])
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            // Close the chain cleanly however the app ends.
            if let tauri::RunEvent::Exit = event {
                if let Some(st) = app.try_state::<Arc<AppState>>() {
                    st.node.stop(true);
                }
            }
        });
}
