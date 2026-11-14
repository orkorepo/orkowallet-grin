//! Integrated Grin node (the official `grin_servers` crate, same code as the `grin` binary).
//!
//! One node per process (grin keeps chain type and feature flags in process globals). It runs on
//! its own thread; `stats()` returns a snapshot refreshed every second. `stop()` shuts the chain
//! down cleanly: killing a node mid-write corrupts its database (seen on usernet 2026-11-13).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use grin_chain::SyncStatus;
use grin_core::global::{self, ChainTypes};
use grin_p2p::msg::PeerAddrs;
use grin_p2p::{PeerAddr, Seeding};
use grin_util::ToHex;
use grin_servers::{Server, ServerConfig, ServerStats};
use serde::Serialize;

use crate::Network;

/// How the user configured the integrated node.
#[derive(Clone, Debug)]
pub struct NodeSettings {
    pub network: Network,
    /// Chain data lives in `<dir>/chain_data`.
    pub dir: PathBuf,
    /// Local API port the wallet talks to (127.0.0.1 only).
    pub api_port: u16,
    /// P2P port.
    pub p2p_port: u16,
    /// Extra peers ("host:port"). With `only_these_peers` DNS seeding is off (used for tests).
    pub peers: Vec<String>,
    pub only_these_peers: bool,
    /// Keep full history (much more disk).
    pub archive: bool,
}

impl NodeSettings {
    pub fn default_ports(network: Network) -> (u16, u16) {
        match network {
            Network::Mainnet => (3413, 3414),
            Network::Testnet => (13413, 13414),
            Network::Usernet => (23413, 23414),
        }
    }
    pub fn api_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.api_port)
    }
}

/// Plain view of the node for the UI.
#[derive(Clone, Debug, Serialize, Default)]
pub struct NodeView {
    /// "stopped" | "starting" | "running" | "stopping" | "failed"
    pub state: String,
    pub error: String,
    /// Short human text of the sync phase (Turkish) and 0..100 progress when known.
    pub sync_text: String,
    pub sync_percent: Option<u8>,
    pub synced: bool,
    /// Newest known header and newest fully processed block. Equal once the node is in sync.
    pub header: ChainPoint,
    pub block: ChainPoint,
    pub peer_count: u32,
    pub peers: Vec<PeerView>,
    pub blocks: Vec<BlockView>,
    pub average_block_time: u64,
    pub average_difficulty: u64,
    pub tx_pool_size: usize,
    pub stem_pool_size: usize,
    pub disk_usage_gb: String,
    pub uptime_secs: u64,
}

/// Hash, height, total difficulty and time of one chain tip (a header or a block).
#[derive(Clone, Debug, Serialize, Default)]
pub struct ChainPoint {
    pub hash: String,
    pub height: u64,
    pub difficulty: u64,
    pub time: i64,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct PeerView {
    pub addr: String,
    pub user_agent: String,
    pub direction: String,
    pub height: u64,
    pub state: String,
    pub last_seen: i64,
    pub sent_bps: u64,
    pub received_bps: u64,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct BlockView {
    pub height: i64,
    pub hash: String,
    pub difficulty: u64,
    pub time: u64,
    pub duration: u64,
    pub secondary: bool,
}

#[derive(Default)]
struct Shared {
    state: String,
    error: String,
    stats: Option<ServerStats>,
    started: Option<Instant>,
}

/// Handle to the integrated node.
pub struct IntegratedNode {
    shared: Arc<RwLock<Shared>>,
    stop: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
    pub settings: NodeSettings,
}

fn set_globals(network: Network) {
    let chain = network.chain();
    if !global::GLOBAL_CHAIN_TYPE.is_init() {
        global::init_global_chain_type(chain);
    }
    global::set_local_chain_type(chain);
    let nrd = chain != ChainTypes::Mainnet;
    if !global::GLOBAL_NRD_FEATURE_ENABLED.is_init() {
        global::init_global_nrd_enabled(nrd);
    } else {
        global::set_global_nrd_enabled(nrd);
    }
}

fn server_config(s: &NodeSettings) -> Result<ServerConfig> {
    let chain = s.network.chain();
    let mut gc = grin_config::GlobalConfig::for_chain(&chain);
    let mut c = gc
        .members
        .take()
        .ok_or_else(|| anyhow!("no default node config"))?
        .server;
    c.chain_type = chain;
    c.db_root = s.dir.join("chain_data").to_string_lossy().into_owned();
    c.api_http_addr = format!("127.0.0.1:{}", s.api_port);
    // Local-only API: the wallet in this process is the only client.
    c.api_secret_path = None;
    c.foreign_api_secret_path = None;
    c.archive_mode = Some(s.archive);
    c.run_tui = Some(false);
    c.run_test_miner = Some(false);
    c.stratum_mining_config = None;
    c.skip_sync_wait = Some(false);
    c.p2p_config.port = s.p2p_port;
    let peers: Vec<PeerAddr> = s
        .peers
        .iter()
        .filter_map(|p| p.trim().parse::<SocketAddr>().ok())
        .map(PeerAddr)
        .collect();
    if !peers.is_empty() {
        c.p2p_config.peers_preferred = Some(PeerAddrs { peers: peers.clone() });
        if s.only_these_peers {
            c.p2p_config.seeding_type = Seeding::List;
            c.p2p_config.seeds = Some(PeerAddrs { peers });
        }
    }
    Ok(c)
}

impl IntegratedNode {
    pub fn new(settings: NodeSettings) -> Self {
        IntegratedNode {
            shared: Arc::new(RwLock::new(Shared { state: "stopped".into(), ..Default::default() })),
            stop: Arc::new(AtomicBool::new(false)),
            thread: Mutex::new(None),
            settings,
        }
    }

    pub fn is_running(&self) -> bool {
        matches!(self.shared.read().unwrap().state.as_str(), "starting" | "running" | "stopping")
    }

    /// Start the node on its own thread. Returns at once; watch `view()`.
    pub fn start(&self) -> Result<()> {
        if self.is_running() {
            return Ok(());
        }
        if let Some(t) = self.thread.lock().unwrap().take() {
            let _ = t.join();
        }
        set_globals(self.settings.network);
        let config = server_config(&self.settings)?;
        if std::net::TcpListener::bind(&config.api_http_addr).is_err() {
            bail!(
                "{} portu kullanımda: bu bilgisayarda başka bir Grin node'u çalışıyor olabilir",
                config.api_http_addr
            );
        }
        let pool = config.pool_config.accept_fee_base;
        if !global::GLOBAL_ACCEPT_FEE_BASE.is_init() {
            global::init_global_accept_fee_base(pool);
        }
        if !global::GLOBAL_FUTURE_TIME_LIMIT.is_init() {
            global::init_global_future_time_limit(config.future_time_limit);
        }
        std::fs::create_dir_all(&self.settings.dir)?;
        self.stop.store(false, Ordering::SeqCst);
        {
            let mut sh = self.shared.write().unwrap();
            *sh = Shared { state: "starting".into(), started: Some(Instant::now()), ..Default::default() };
        }
        let shared = self.shared.clone();
        let stop = self.stop.clone();
        let t = std::thread::Builder::new().name("grin-node".into()).spawn(move || {
            let server = match Server::new(config, None, None, tokio::sync::mpsc::channel::<()>(1)) {
                Ok(s) => s,
                Err(e) => {
                    let mut sh = shared.write().unwrap();
                    sh.state = "failed".into();
                    sh.error = format!("{e:?}");
                    return;
                }
            };
            shared.write().unwrap().state = "running".into();
            while !stop.load(Ordering::SeqCst) {
                if let Ok(st) = server.get_server_stats() {
                    shared.write().unwrap().stats = Some(st);
                }
                std::thread::sleep(Duration::from_millis(1000));
            }
            shared.write().unwrap().state = "stopping".into();
            server.stop();
            let mut sh = shared.write().unwrap();
            sh.state = "stopped".into();
            sh.stats = None;
        })?;
        *self.thread.lock().unwrap() = Some(t);
        Ok(())
    }

    /// Ask the node to stop; with `wait` blocks until the chain is closed.
    pub fn stop(&self, wait: bool) {
        self.stop.store(true, Ordering::SeqCst);
        if wait {
            if let Some(t) = self.thread.lock().unwrap().take() {
                let _ = t.join();
            }
        }
    }

    pub fn view(&self) -> NodeView {
        let sh = self.shared.read().unwrap();
        let mut v = NodeView { state: sh.state.clone(), error: sh.error.clone(), ..Default::default() };
        v.uptime_secs = sh.started.map(|t| t.elapsed().as_secs()).unwrap_or(0);
        let Some(st) = &sh.stats else {
            if v.state == "starting" {
                v.sync_text = "Node başlatılıyor".into();
            }
            return v;
        };
        let (text, pct, synced) = sync_text(&st.sync_status, st.header_stats.height, st.chain_stats.height);
        v.sync_text = text;
        v.sync_percent = pct;
        v.synced = synced;
        v.block = ChainPoint {
            hash: st.chain_stats.last_block_h.to_hex(),
            height: st.chain_stats.height,
            difficulty: st.chain_stats.total_difficulty.to_num(),
            time: st.chain_stats.latest_timestamp.timestamp(),
        };
        v.header = ChainPoint {
            hash: st.header_stats.last_block_h.to_hex(),
            height: st.header_stats.height,
            difficulty: st.header_stats.total_difficulty.to_num(),
            time: st.header_stats.latest_timestamp.timestamp(),
        };
        v.peer_count = st.peer_count;
        v.peers = st
            .peer_stats
            .iter()
            .map(|p| PeerView {
                addr: p.addr.clone(),
                user_agent: p.user_agent.clone(),
                direction: p.direction.clone(),
                height: p.height,
                state: p.state.clone(),
                last_seen: p.last_seen.timestamp(),
                sent_bps: p.sent_bytes_per_sec,
                received_bps: p.received_bytes_per_sec,
            })
            .collect();
        v.blocks = st
            .diff_stats
            .last_blocks
            .iter()
            .rev()
            .take(12)
            .map(|b| BlockView {
                height: b.block_height,
                hash: b.block_hash.to_hex(),
                difficulty: b.difficulty,
                time: b.time,
                duration: b.duration,
                secondary: b.is_secondary,
            })
            .collect();
        // grin's own average includes the gap after genesis on young chains (showed
        // "261003 min" on a fresh usernet); average the listed blocks instead.
        let durs: Vec<u64> = v.blocks.iter().filter(|b| b.height > 1).map(|b| b.duration).collect();
        v.average_block_time = if durs.is_empty() {
            st.diff_stats.average_block_time
        } else {
            durs.iter().sum::<u64>() / durs.len() as u64
        };
        v.average_difficulty = st.diff_stats.average_difficulty;
        if let Some(tx) = &st.tx_stats {
            v.tx_pool_size = tx.tx_pool_size;
            v.stem_pool_size = tx.stem_pool_size;
        }
        v.disk_usage_gb = st.disk_usage_gb.clone();
        v
    }
}

fn pct(done: u64, total: u64) -> Option<u8> {
    (total > 0).then(|| ((done.min(total) * 100) / total) as u8)
}

/// (text, percent, synced)
fn sync_text(s: &SyncStatus, header_h: u64, chain_h: u64) -> (String, Option<u8>, bool) {
    match s {
        SyncStatus::Initial => ("Hazırlanıyor".into(), None, false),
        SyncStatus::NoSync => ("Senkronize".into(), Some(100), true),
        SyncStatus::AwaitingPeers(_) => ("Eş (peer) bekleniyor".into(), None, false),
        SyncStatus::HeaderSync { sync_head, highest_height, .. } => (
            format!("Blok başlıkları indiriliyor ({} / {})", sync_head.height, highest_height),
            pct(sync_head.height, *highest_height),
            false,
        ),
        SyncStatus::TxHashsetPibd { completed_to_height, required_height, .. } => (
            "Zincir durumu indiriliyor".into(),
            pct(*completed_to_height, *required_height),
            false,
        ),
        SyncStatus::TxHashsetDownload(d) => (
            "Zincir durumu indiriliyor".into(),
            pct(d.downloaded_size, d.total_size),
            false,
        ),
        SyncStatus::TxHashsetSetup { .. } => ("Zincir durumu kuruluyor".into(), None, false),
        SyncStatus::TxHashsetKernelsValidation { kernels, kernels_total } => {
            ("Kernel'ler doğrulanıyor".into(), pct(*kernels, *kernels_total), false)
        }
        SyncStatus::TxHashsetRangeProofsValidation { rproofs, rproofs_total } => {
            ("Range proof'lar doğrulanıyor".into(), pct(*rproofs, *rproofs_total), false)
        }
        SyncStatus::TxHashsetSave | SyncStatus::TxHashsetDone => {
            ("Zincir durumu kaydediliyor".into(), None, false)
        }
        SyncStatus::BodySync { current_height, highest_height } => (
            format!("Bloklar indiriliyor ({} / {})", current_height, highest_height),
            pct(*current_height, *highest_height),
            false,
        ),
        SyncStatus::Shutdown => ("Kapanıyor".into(), None, false),
        #[allow(unreachable_patterns)]
        _ => (format!("Senkronize ediliyor ({chain_h} / {header_h})"), pct(chain_h, header_h), false),
    }
}
