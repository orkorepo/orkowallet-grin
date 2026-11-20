//! Orkoswap Grin wallet core.
//!
//! A thin layer over the official grin-wallet crates (5.5.x). It never implements any Grin
//! cryptography itself: every step (keys, slates, slatepacks, the Foreign API listener, the
//! integrated Arti Tor client and onion service) is the same code `grin-wallet` runs, so a wallet
//! made here opens in grin-wallet and Grim, and the other way round.
//!
//! Threading rule (learned on the exchange): the integrated Tor client calls `block_on` on the
//! calling thread, so every function here that can touch Tor must run on a plain OS thread, never
//! inside a tokio runtime (in Tauri: `spawn_blocking` or `std::thread`).

pub mod diag;
pub mod node;
pub mod pool;
pub mod remote;
pub mod tor;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{json, Value};
use pool::PoolNodeClient;
use tor::{BundledTor, TorBundle, TorLaunch, TorStatus};

use anyhow::{anyhow, bail, Context, Result};
use grin_core::global::{self, ChainTypes};
use grin_keychain::ExtKeychain;
use grin_util::secp::key::SecretKey;
use grin_util::{Mutex, ZeroingString};
use grin_wallet_api::{try_slatepack_sync_workflow, Foreign, Owner};
use grin_wallet_config::{TorConfig, WalletConfig, WALLET_CONFIG_FILE_NAME};
use grin_wallet_impls::{DefaultLCProvider, DefaultWalletImpl};
use grin_wallet_libwallet::api_impl::types::update_tx_slate_state;
use grin_wallet_libwallet::{
    InitTxArgs, Slate, SlateVersion, SlatepackAddress, VersionedSlate,
    WalletInfo, WalletInst,
};
use grin_wallet_util::OnionV3Address;

pub use grin_core::core::amount_to_hr_string;
pub use grin_wallet_libwallet::{SlateState, TxLogEntry};
pub use grin_core::core::amount_from_hr_string;

type Lc = DefaultLCProvider<PoolNodeClient, ExtKeychain>;
type Inst = Arc<Mutex<Box<dyn WalletInst<'static, Lc, PoolNodeClient, ExtKeychain>>>>;

/// Which Grin network a wallet lives on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Network {
    Mainnet,
    Testnet,
    /// Local private network (`--usernet`), for tests only.
    Usernet,
}

impl Network {
    pub fn chain(self) -> ChainTypes {
        match self {
            Network::Mainnet => ChainTypes::Mainnet,
            Network::Testnet => ChainTypes::Testnet,
            Network::Usernet => ChainTypes::UserTesting,
        }
    }
    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "main" | "mainnet" => Network::Mainnet,
            "test" | "testnet" => Network::Testnet,
            "user" | "usernet" => Network::Usernet,
            _ => bail!("unknown network '{s}' (mainnet, testnet, usernet)"),
        })
    }
}

/// Settings that decide where a wallet lives and how it talks to the outside world.
#[derive(Clone, Debug)]
pub struct Settings {
    /// Top level directory: holds `grin-wallet.toml`, `wallet_data/` and the Tor state (`arti/`).
    pub dir: PathBuf,
    pub network: Network,
    /// Nodes in order of preference. With more than one, the wallet fails over to the next on
    /// any error (see `pool`). The integrated node is a single-entry list.
    pub nodes: Vec<String>,
    /// Local port of the Foreign API; the onion service forwards to it.
    pub listen_port: u16,
    pub tor: TorMode,
    /// Tor bridge lines (obfs4 / webtunnel / snowflake / meek_lite); empty for a direct connection.
    pub bridges: Vec<String>,
}

/// Which Tor implementation carries the wallet's traffic.
#[derive(Clone, Debug)]
pub enum TorMode {
    /// The official C tor shipped with the app, run as one long-lived process (default: on
    /// 2026-11-13 the integrated Arti onion service answered only about 1 in 4 cold attempts).
    Bundled(TorBundle),
    /// grin-wallet's integrated Arti (no extra binary). Bridges: first line only.
    Integrated,
}

/// How long one Tor request may take; the first connection to an onion can take over a minute.
const TOR_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const TOR_BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(180);

impl Settings {
    fn config_path(&self) -> PathBuf {
        self.dir.join(WALLET_CONFIG_FILE_NAME)
    }

    fn tor_config(&self) -> TorConfig {
        let mut t = TorConfig::default();
        // Written to grin-wallet.toml too, so grin-wallet opening this folder behaves sensibly.
        t.use_integrated = Some(true);
        t.use_tor_listener = true;
        t.send_config_dir = self.dir.to_string_lossy().into_owned();
        t.request_timeout_secs = Some(TOR_REQUEST_TIMEOUT.as_secs());
        t.bootstrap_timeout_secs = Some(TOR_BOOTSTRAP_TIMEOUT.as_secs());
        t.bridge.bridge_line = self.bridges.first().cloned();
        t
    }

    fn wallet_config(&self) -> WalletConfig {
        let mut w = WalletConfig::default();
        w.chain_type = Some(self.network.chain());
        w.api_listen_port = self.listen_port;
        w.check_node_api_http_addr = self.nodes.first().cloned().unwrap_or_default();
        w.data_file_dir = self.dir.join("wallet_data").to_string_lossy().into_owned();
        w.api_secret_path = None;
        w.node_api_secret_path = None;
        w
    }
}

/// How a payment is built and broadcast.
#[derive(Clone, Debug)]
pub struct SendOptions {
    /// Number of change outputs (more outputs = better privacy of later spends, higher fee).
    pub change_outputs: usize,
    /// Spend every available output instead of the smallest set that is enough.
    pub use_all: bool,
    /// Drop the transaction if it is not mined within this many blocks.
    pub ttl_blocks: Option<u64>,
    /// Broadcast at once (fluff) instead of through Dandelion stem relay.
    pub fluff: bool,
    /// Try to hand the payment to the recipient over Tor. False = only create the Slatepack text.
    pub tor: bool,
    /// The amount already includes the network fee: spend everything and let the fee come out of it
    /// ("send max"). Implies `use_all`.
    pub amount_includes_fee: bool,
}

impl Default for SendOptions {
    fn default() -> Self {
        SendOptions { change_outputs: 1, use_all: false, ttl_blocks: None, fluff: false, tor: true, amount_includes_fee: false }
    }
}

/// What the receiver of a send should do next.
#[derive(Debug)]
pub enum SendOutcome {
    /// Delivered over Tor, finalized and posted to the chain.
    PostedOverTor { tx_slate_id: String },
    /// Tor delivery was not possible: hand this Slatepack text to the receiver; their reply goes
    /// into `finalize`. The outputs stay locked until then (or until `cancel`).
    Slatepack { tx_slate_id: String, message: String, tor_error: Option<String> },
    /// Tor delivery failed (recipient offline?). The outputs are locked until the caller retries
    /// with `retry_send` or cancels the transaction.
    Unreached { tx_slate_id: String, error: String, pending: PendingSend },
}

/// Result of processing a Slatepack someone gave us.
/// A payment that has been built and locked but not yet handed to the recipient.
#[derive(Clone, Debug)]
pub struct PendingSend {
    slate: Slate,
    dest: SlatepackAddress,
    fluff: bool,
}

/// A signed incoming payment whose reply still has to reach the sender over Tor.
pub struct PendingReturn {
    signed: Slate,
    addr: SlatepackAddress,
}

#[derive(Debug)]
pub enum ReceiveOutcome {
    /// We signed and the sender got it back over Tor; nothing else to do.
    ReturnedOverTor,
    /// Give this Slatepack text back to the sender.
    Slatepack(String),
}

/// An opened wallet.
pub struct Wallet {
    settings: Settings,
    inst: Inst,
    owner: Owner<Lc, PoolNodeClient, ExtKeychain>,
    pool: PoolNodeClient,
    mask: Option<SecretKey>,
    /// grin-wallet's own listener thread (integrated Arti mode only; it cannot be stopped).
    listener: Option<JoinHandle<()>>,
    /// Our stoppable Foreign API server (bundled Tor mode).
    server: std::sync::Mutex<Option<(grin_api::ApiServer, JoinHandle<()>)>>,
    bundled_tor: std::sync::Mutex<Option<Arc<BundledTor>>>,
    /// Current bridge lines (changeable at runtime with restart_tor).
    bridges: std::sync::Mutex<Vec<String>>,
}

fn set_chain(network: Network) {
    // The chain type is process global in the grin crates; set it once, before any wallet call.
    if !global::GLOBAL_CHAIN_TYPE.is_init() {
        global::init_global_chain_type(network.chain());
    }
    global::set_local_chain_type(network.chain());
}

fn new_inst(s: &Settings) -> Result<(Inst, PoolNodeClient)> {
    let node = PoolNodeClient::new(&s.nodes, Duration::from_secs(25))?;
    let mut wallet = Box::new(DefaultWalletImpl::<PoolNodeClient>::new(node.clone())?)
        as Box<dyn WalletInst<'static, Lc, PoolNodeClient, ExtKeychain>>;
    let lc = wallet.lc_provider()?;
    lc.set_top_level_directory(&s.dir.to_string_lossy())?;
    Ok((Arc::new(Mutex::new(wallet)), node))
}

use std::sync::atomic::{AtomicI32, Ordering};

/// Percent of the chain scan running now in this process (0..100), -1 when none has started.
/// One wallet is open per process, so a process-wide value is enough.
static SCAN_PROGRESS: AtomicI32 = AtomicI32::new(-1);

pub fn scan_progress() -> i32 {
    SCAN_PROGRESS.load(Ordering::Relaxed)
}

/// First mainnet block height that can hold coins of a wallet made at `unix_secs`, with a 30 day
/// safety margin (mainnet launched 2019-01-15 16:01 UTC, one block per minute target). The real
/// chain runs behind that schedule (2026-11-13: 4,105,487 actual vs ~4,117,000 by the clock, about
/// 8 days), so a smaller margin could skip the first days after the chosen date.
/// Other networks have no fixed schedule: scan from the start.
pub fn start_height_for(network: Network, unix_secs: i64) -> u64 {
    const MAINNET_GENESIS: i64 = 1_547_568_086;
    const MARGIN_BLOCKS: i64 = 30 * 24 * 60;
    match network {
        Network::Mainnet => ((unix_secs - MAINNET_GENESIS) / 60 - MARGIN_BLOCKS).max(1) as u64,
        _ => 1,
    }
}

pub fn reset_scan_progress() {
    SCAN_PROGRESS.store(-1, Ordering::Relaxed);
}

/// Is `s` a Slatepack address of the network this process runs on (grin1... / tgrin1...)?
pub fn is_valid_address(s: &str) -> bool {
    SlatepackAddress::try_from(s.trim()).is_ok_and(|a| a.valid_network())
}

/// Must be called once before any address check when no wallet is open yet.
pub fn select_network(network: Network) {
    set_chain(network);
}

/// Forget tor's saved state of a wallet folder that is not open.
pub fn wipe_tor_state_in(wallet_dir: &Path) -> Result<()> {
    tor::wipe_state(&wallet_dir.join("tor").join("bundled"))
}

/// True when `dir` already holds a wallet (ours or one made by grin-wallet / Grim).
pub fn wallet_exists(dir: &Path) -> bool {
    dir.join("wallet_data").join("wallet.seed").exists()
}

impl Wallet {
    /// Create a new wallet. With `recovery` = Some(words) the wallet is restored from those words
    /// (run `scan` afterwards); otherwise a new phrase is generated: `words` = 12 or 24 (anything else
    /// gives 24).
    /// Returns the opened wallet and the recovery phrase to show the user once.
    pub fn create(
        settings: Settings,
        password: &str,
        recovery: Option<&str>,
        words: usize,
    ) -> Result<(Wallet, ZeroingString)> {
        set_chain(settings.network);
        if wallet_exists(&settings.dir) {
            bail!("a wallet already exists in {}", settings.dir.display());
        }
        std::fs::create_dir_all(&settings.dir)?;
        let (inst, pool) = new_inst(&settings)?;
        {
            let mut w = inst.lock();
            let lc = w.lc_provider()?;
            lc.create_config(
                &settings.network.chain(),
                WALLET_CONFIG_FILE_NAME,
                Some(settings.wallet_config()),
                None,
                Some(settings.tor_config()),
            )?;
            let words_in = recovery.map(|r| ZeroingString::from(r.trim()));
            if let Some(w) = &words_in {
                lc.validate_mnemonic(w.clone())
                    .map_err(|_| anyhow!("the recovery phrase is not valid"))?;
            }
            // Entropy bytes: 16 = 12 words, 32 = 24 words.
            let entropy = if words == 12 { 16 } else { 32 };
            lc.create_wallet(None, words_in, entropy, ZeroingString::from(password), false)?;
        }
        let wallet = Self::open_inst(settings, inst, pool, password)?;
        let phrase = {
            let mut w = wallet.inst.lock();
            w.lc_provider()?
                .get_mnemonic(None, ZeroingString::from(password))?
        };
        Ok((wallet, phrase))
    }

    /// Open an existing wallet directory.
    pub fn open(settings: Settings, password: &str) -> Result<Wallet> {
        set_chain(settings.network);
        if !wallet_exists(&settings.dir) {
            bail!("no wallet in {}", settings.dir.display());
        }
        if !settings.config_path().exists() {
            // A bare wallet_data folder copied from elsewhere: give it a config.
            let (inst, _) = new_inst(&settings)?;
            let mut w = inst.lock();
            w.lc_provider()?.create_config(
                &settings.network.chain(),
                WALLET_CONFIG_FILE_NAME,
                Some(settings.wallet_config()),
                None,
                Some(settings.tor_config()),
            )?;
        }
        let (inst, pool) = new_inst(&settings)?;
        Self::open_inst(settings, inst, pool, password)
    }

    fn open_inst(settings: Settings, inst: Inst, pool: PoolNodeClient, password: &str) -> Result<Wallet> {
        let mask = {
            let mut w = inst.lock();
            w.lc_provider()?
                .open_wallet(None, ZeroingString::from(password), false, false)
                .map_err(|_| anyhow!("wrong password or damaged wallet"))?
        };
        // Progress of chain scans (restore / repair can take many minutes on mainnet).
        let (status_tx, status_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            use grin_wallet_libwallet::StatusMessage;
            for m in status_rx {
                match m {
                    StatusMessage::Scanning(_, p) => SCAN_PROGRESS.store(p as i32, Ordering::Relaxed),
                    StatusMessage::ScanningComplete(_) => SCAN_PROGRESS.store(100, Ordering::Relaxed),
                    _ => {}
                }
            }
        });
        let owner = Owner::new(inst.clone(), Some(status_tx), settings.config_path());
        let settings_bridges = settings.bridges.clone();
        Ok(Wallet {
            settings,
            inst,
            owner,
            pool,
            mask,
            listener: None,
            server: std::sync::Mutex::new(None),
            bundled_tor: std::sync::Mutex::new(None),
            bridges: std::sync::Mutex::new(settings_bridges),
        })
    }

    fn mask(&self) -> Option<&SecretKey> {
        self.mask.as_ref()
    }

    /// The node the wallet is talking to right now (changes when the pool fails over).
    pub fn node_in_use(&self) -> String {
        self.pool.current_url()
    }

    /// Switch the open wallet to `url` at once (false when that node is not in its pool).
    pub fn prefer_node(&self, url: &str) -> bool {
        self.pool.prefer(url)
    }

    /// How many times the wallet switched to another node since it was opened.
    pub fn node_failovers(&self) -> usize {
        self.pool.failovers()
    }

    /// The wallet's Slatepack address (index 0, like grin-wallet) and its onion address.
    pub fn address(&self) -> Result<(String, String)> {
        let sp = self.owner.get_slatepack_address(self.mask(), 0)?;
        let onion = OnionV3Address::from(&sp);
        Ok((sp.to_string(), format!("{onion}.onion")))
    }

    /// Start the Foreign API listener on 127.0.0.1:<listen_port> (grin-wallet's own listener)
    /// and publish it as the wallet's onion service. Runs for the life of the process.
    /// With the bundled tor this returns once tor is launched; `tor_status` shows its progress.
    pub fn start_listener(&mut self) -> Result<()> {
        if self.listening() {
            return Ok(());
        }
        if let TorMode::Bundled(bundle) = &self.settings.tor {
            // Plain HTTP on localhost; our own tor publishes it as the onion service. Unlike
            // grin-wallet's `foreign_listener` this server can be stopped, so logging out does
            // not need an app restart.
            let handler = grin_wallet_controller::controller::ForeignAPIHandlerV2::new(
                self.inst.clone(),
                self.settings.config_path().into(),
                Arc::new(Mutex::new(self.mask.clone())),
                false,
            );
            let mut router = grin_api::Router::new();
            router
                .add_route("/v2/foreign", Arc::new(handler))
                .map_err(|_| anyhow!("could not register the Foreign API route"))?;
            let mut apis = grin_api::ApiServer::new();
            let addr: std::net::SocketAddr = format!("127.0.0.1:{}", self.settings.listen_port).parse()?;
            let handle = apis
                .start(addr, router, None, tokio::sync::mpsc::channel::<()>(1))
                .map_err(|_| anyhow!("the Foreign API server could not start"))?;
            *self.server.lock().unwrap() = Some((apis, handle));
            let hs_dir = self.write_onion_keys()?;
            let tor = BundledTor::start(TorLaunch {
                bundle,
                data_dir: &self.settings.dir.join("tor").join("bundled"),
                hidden_service: Some((hs_dir, self.settings.listen_port)),
                bridges: &self.bridges.lock().unwrap().clone(),
            })?;
            *self.bundled_tor.lock().unwrap() = Some(Arc::new(tor));
            return Ok(());
        }
        let integrated = matches!(self.settings.tor, TorMode::Integrated);
        let inst = self.inst.clone();
        let config_path = self.settings.config_path();
        let mask = Arc::new(Mutex::new(self.mask.clone()));
        let addr = format!("127.0.0.1:{}", self.settings.listen_port);
        let bridge = self.bridges.lock().unwrap().first().cloned();
        let handle = std::thread::Builder::new()
            .name("grin-foreign-listener".into())
            .spawn(move || {
                // Bundled mode: grin-wallet serves plain HTTP, our tor publishes it.
                if let Err(e) = grin_wallet_controller::controller::foreign_listener(
                    inst, config_path, bridge, Some(integrated), mask, &addr, None, false,
                ) {
                    log::error!("Foreign listener stopped: {e}");
                }
            })?;
        self.listener = Some(handle);
        if let TorMode::Bundled(bundle) = &self.settings.tor {
            let hs_dir = self.write_onion_keys()?;
            let tor = BundledTor::start(TorLaunch {
                bundle,
                data_dir: &self.settings.dir.join("tor").join("bundled"),
                hidden_service: Some((hs_dir, self.settings.listen_port)),
                bridges: &self.bridges.lock().unwrap().clone(),
            })?;
            // Replaces a send-only tor started earlier, if any.
            *self.bundled_tor.lock().unwrap() = Some(Arc::new(tor));
        }
        Ok(())
    }

    fn listening(&self) -> bool {
        self.listener.is_some() || self.server.lock().unwrap().is_some()
    }

    /// Stop everything this wallet runs (Foreign API server, Tor). Returns false when it cannot
    /// be stopped inside the process (grin-wallet's integrated Arti listener): the app must
    /// then restart to close the wallet.
    pub fn shutdown(&self) -> bool {
        if self.listener.is_some() {
            return false;
        }
        if let Some((mut apis, handle)) = self.server.lock().unwrap().take() {
            apis.stop();
            let _ = handle.join();
        }
        if let Some(t) = self.bundled_tor.lock().unwrap().take() {
            t.stop(); // explicit: a background check may still hold a reference
        }
        true
    }

    /// Bundled tor progress (None in Integrated mode or before anything started it).
    pub fn tor_status(&self) -> Option<TorStatus> {
        self.bundled_tor.lock().unwrap().as_ref().map(|t| t.status())
    }

    /// Write the onion service key files with grin-wallet's own helper, from the same key
    /// (address index 0) grin-wallet's listener uses. Returns the hidden service directory.
    fn write_onion_keys(&self) -> Result<PathBuf> {
        let key = {
            let mut w = self.inst.lock();
            let lc = w.lc_provider()?;
            let inst = lc.wallet_inst()?;
            let k = inst.keychain(self.mask())?;
            let parent = inst.parent_key_id();
            grin_wallet_libwallet::address::address_from_derivation_path(&k, &parent, 0)?
        };
        let root = self.settings.dir.join("tor").join("bundled");
        std::fs::create_dir_all(&root)?;
        let onion = grin_wallet_impls::tor::config::output_onion_service_config(
            &root.to_string_lossy(),
            &key,
        )
        .map_err(|e| anyhow!("could not write onion keys: {e}"))?;
        Ok(root.join("onion_service_addresses").join(onion.to_string()))
    }

    /// The running bundled tor, started send-only if the listener did not start it.
    fn bundled(&self, bundle: &TorBundle) -> Result<Arc<BundledTor>> {
        let tor = {
            let mut slot = self.bundled_tor.lock().unwrap();
            let dead = matches!(slot.as_ref().map(|t| t.status()), Some(TorStatus::Failed(_)));
            if slot.is_none() || dead {
                *slot = Some(Arc::new(BundledTor::start(TorLaunch {
                    bundle,
                    data_dir: &self.settings.dir.join("tor").join("bundled"),
                    hidden_service: None,
                    bridges: &self.bridges.lock().unwrap().clone(),
                })?));
            }
            slot.as_ref().unwrap().clone()
        };
        tor.wait_ready(TOR_BOOTSTRAP_TIMEOUT)?;
        Ok(tor)
    }

    /// Hand a slate to the wallet behind `dest` over Tor and get its answer:
    /// `finalize` = false asks it to sign (receive_tx), true asks it to finalize (finalize_tx).
    fn deliver(&self, slate: &Slate, dest: &SlatepackAddress, finalize: bool, reach: Duration) -> Result<Slate> {
        let bundle = match &self.settings.tor {
            TorMode::Integrated => {
                return Ok(try_slatepack_sync_workflow(
                    slate,
                    dest,
                    Some(self.tor_config()),
                    None,
                    finalize,
                )?)
            }
            TorMode::Bundled(b) => b,
        };
        let tor = self.bundled(bundle)?;
        let host = format!("{}.onion", OnionV3Address::from(dest));
        check_version(&tor, &host, reach)?;
        // From here on: the same request TorSlateSender::send_tx makes.
        let slate_send = VersionedSlate::into_version(slate.clone(), SlateVersion::V4)?;
        let req = if finalize {
            json!({"jsonrpc": "2.0", "method": "finalize_tx", "id": 1, "params": [slate_send]})
        } else {
            json!({"jsonrpc": "2.0", "method": "receive_tx", "id": 1,
                   "params": [slate_send, null, null]})
        };
        let res = rpc(&tor, &host, &req, TOR_REQUEST_TIMEOUT)?;
        let s = serde_json::to_string(&res["result"]["Ok"])?;
        Slate::deserialize_upgrade(&s).map_err(|e| anyhow!("bad slate from recipient: {e}"))
    }

    /// Balances, refreshed from the node.
    pub fn balance(&self, min_confirmations: u64) -> Result<(bool, WalletInfo)> {
        Ok(self
            .owner
            .retrieve_summary_info(self.mask(), true, min_confirmations)?)
    }

    pub fn transactions(&self, refresh_from_node: bool) -> Result<Vec<TxLogEntry>> {
        Ok(self.owner.retrieve_txs(self.mask(), refresh_from_node, None, None, None)?.1)
    }

    /// Rescan the chain for this wallet's outputs (needed after a restore). With
    /// `delete_unconfirmed` (grin-wallet `scan -d`) outputs and transactions the chain does not
    /// know are dropped, which repairs a wallet that is out of step with its node.
    pub fn scan(&self, delete_unconfirmed: bool) -> Result<()> {
        self.scan_from(1, delete_unconfirmed)
    }

    /// Scan from `start_height` only (much faster when the wallet is known to be younger).
    pub fn scan_from(&self, start_height: u64, delete_unconfirmed: bool) -> Result<()> {
        SCAN_PROGRESS.store(0, Ordering::Relaxed);
        Ok(self
            .owner
            .scan(self.mask(), Some(start_height.max(1)), delete_unconfirmed)?)
    }

    fn tor_config(&self) -> TorConfig {
        self.settings.tor_config()
    }

    /// Send `amount` nanogrin to a Slatepack address. Tries Tor first (exactly what
    /// `grin-wallet send -d grin1...` does); if that fails, returns an encrypted Slatepack to
    /// hand over manually. `dest = None` always gives an unencrypted Slatepack.
    pub fn send(&self, amount: u64, dest: Option<&str>, min_confirmations: u64, opts: &SendOptions) -> Result<SendOutcome> {
        let dest = dest
            .map(|d| SlatepackAddress::try_from(d.trim()))
            .transpose()
            .map_err(|_| anyhow!("not a valid Grin address"))?;
        let args = InitTxArgs {
            src_acct_name: None,
            amount,
            minimum_confirmations: min_confirmations,
            max_outputs: 500,
            num_change_outputs: opts.change_outputs.clamp(1, 8) as u32,
            selection_strategy_is_use_all: opts.use_all || opts.amount_includes_fee,
            amount_includes_fee: Some(opts.amount_includes_fee),
            ttl_blocks: opts.ttl_blocks,
            // Proof of payment whenever we know the receiver, like grin-wallet.
            payment_proof_recipient_address: dest.clone(),
            ..Default::default()
        };
        let slate = self.owner.init_send_tx(self.mask(), args)?;
        self.owner.tx_lock_outputs(self.mask(), &slate)?;
        let id = slate.id.to_string();

        // Over Tor there is no fallback to a Slatepack: if the recipient cannot be reached the caller
        // decides (retry later, or cancel and unlock the funds).
        if let (true, Some(d)) = (opts.tor, &dest) {
            let pending = PendingSend { slate: slate.clone(), dest: d.clone(), fluff: opts.fluff };
            return Ok(match self.retry_send(&pending, 60) {
                Ok(()) => SendOutcome::PostedOverTor { tx_slate_id: id },
                Err(e) => SendOutcome::Unreached { tx_slate_id: id, error: e.to_string(), pending },
            });
        }
        let tor_error: Option<String> = None;        let recipients = dest.into_iter().collect();
        let message = self
            .owner
            .create_slatepack_message(self.mask(), &slate, Some(0), recipients)?;
        Ok(SendOutcome::Slatepack { tx_slate_id: id, message, tor_error })
    }

    /// The most that can be sent in one payment: every spendable output (with `min_confirmations`)
    /// minus the network fee. Returns (amount to send in the transaction, what to pass as `amount`
    /// together with `amount_includes_fee`, fee).
    pub fn max_sendable(&self, min_confirmations: u64) -> Result<(u64, u64, u64)> {
        let (_, info) = self.balance(min_confirmations)?;
        let spendable = info.amount_currently_spendable;
        if spendable == 0 {
            return Ok((0, 0, 0));
        }
        let args = InitTxArgs {
            src_acct_name: None,
            amount: spendable,
            minimum_confirmations: min_confirmations,
            max_outputs: 500,
            num_change_outputs: 1,
            selection_strategy_is_use_all: true,
            amount_includes_fee: Some(true),
            estimate_only: Some(true),
            ..Default::default()
        };
        let slate = self.owner.init_send_tx(self.mask(), args)?;
        let total = slate.amount;
        let fee = slate.fee_fields.fee();
        Ok((total.saturating_sub(fee), total, fee))
    }

    /// Hand a locked payment to the recipient over Tor, finalize it and post it to the chain.
    pub fn retry_send(&self, p: &PendingSend, reach_secs: u64) -> Result<()> {
        let s = self.deliver(&p.slate, &p.dest, false, Duration::from_secs(reach_secs))?;
        let fin = self.owner.finalize_tx(self.mask(), &s)?;
        self.owner.post_tx(self.mask(), &fin, p.fluff)?;
        Ok(())
    }

    /// The transaction id a Slatepack text belongs to (an initial slate and its reply share it).
    pub fn slatepack_id(&self, text: &str) -> Result<String> {
        Ok(self.read_slatepack(text)?.0.id.to_string())
    }

    fn read_slatepack(&self, text: &str) -> Result<(Slate, Option<SlatepackAddress>)> {
        let slate = self
            .owner
            .slate_from_slatepack_message(self.mask(), text.trim().to_string(), vec![0])
            .context("could not read this Slatepack")?;
        let pack = self
            .owner
            .decode_slatepack_message(self.mask(), text.trim().to_string(), vec![0])?;
        Ok((slate, pack.sender))
    }

    /// Process a Slatepack: an incoming payment (step 1) gets signed and returned (over Tor when
    /// the sender gave an address, else as text); a reply to our own send (step 2) gets finalized
    /// and posted.
    pub fn process_slatepack(&self, text: &str) -> Result<(ProcessOutcome, Option<PendingReturn>)> {
        if text.len() > 2_000_000 {
            bail!("the Slatepack text is too large");
        }
        let (slate, sender) = self.read_slatepack(text)?;
        match slate.state {
            SlateState::Standard1 => {
                let (r, pending) = self.receive(slate, sender)?;
                Ok((ProcessOutcome::Received(r), pending))
            }
            SlateState::Standard2 => {
                let fin = self.owner.finalize_tx(self.mask(), &slate)?;
                self.owner.post_tx(self.mask(), &fin, false)?;
                Ok((ProcessOutcome::Finalized { tx_slate_id: fin.id.to_string() }, None))
            }
            SlateState::Invoice1 | SlateState::Invoice2 => {
                bail!("invoices are not supported yet")
            }
            _ => bail!("this Slatepack is already finished"),
        }
    }

    fn receive(&self, slate: Slate, sender: Option<SlatepackAddress>) -> Result<(ReceiveOutcome, Option<PendingReturn>)> {
        let foreign = Foreign::new(
            self.inst.clone(),
            self.settings.config_path(),
            self.mask.clone(),
            None,
            false,
        );
        let signed = foreign.receive_tx(&slate, None, None)?;
        // The reply text is ready now. Reaching the sender over Tor can take minutes (or never
        // work), so it is not waited for: the caller shows the text at once and runs
        // `finish_return` in the background.
        let recipients = sender.iter().cloned().collect();
        let message = self.owner.create_slatepack_message(self.mask(), &signed, Some(0), recipients)?;
        let pending = sender.map(|addr| PendingReturn { signed, addr });
        Ok((ReceiveOutcome::Slatepack(message), pending))
    }

    /// Send the signed slate back to the sender over Tor and record that it was finalized there.
    /// Slow; run it on a background thread.
    pub fn finish_return(&self, p: PendingReturn) -> Result<()> {
        let s = self.deliver(&p.signed, &p.addr, true, TOR_REQUEST_TIMEOUT)?;
        let mut w = self.inst.lock();
        let inst = w.lc_provider()?.wallet_inst()?;
        let parent = inst.parent_key_id();
        update_tx_slate_state(inst, self.mask(), &parent, &s)
            .map_err(|e| anyhow!("could not update slate state: {e}"))?;
        Ok(())
    }

    /// Can this wallet's own onion address be reached over Tor right now? True once the address
    /// has spread through the Tor network, so payments can actually arrive.
    pub fn self_check(&self, timeout_secs: u64) -> Result<()> {
        let TorMode::Bundled(b) = &self.settings.tor else { bail!("self check needs the bundled Tor") };
        let tor = self.bundled(b)?;
        let (sp, _) = self.address()?;
        let addr = SlatepackAddress::try_from(sp.as_str()).map_err(|_| anyhow!("bad own address"))?;
        let host = format!("{}.onion", OnionV3Address::from(&addr));
        check_version(&tor, &host, Duration::from_secs(timeout_secs))
    }

    /// Is the wallet behind this Slatepack address reachable over Tor right now? (The same
    /// `check_version` call a Tor send starts with.)
    pub fn ping(&self, dest: &str, timeout_secs: u64) -> Result<()> {
        let addr = SlatepackAddress::try_from(dest.trim())
            .map_err(|_| anyhow!("not a valid Grin address"))?;
        match &self.settings.tor {
            TorMode::Integrated => {
                let url = OnionV3Address::from(&addr).to_http_str();
                let mut sender = grin_wallet_impls::TorSlateSender::new(&url, self.tor_config())?;
                sender.check_other_version(&format!("{url}/v2/foreign"))?;
            }
            TorMode::Bundled(b) => {
                let tor = self.bundled(b)?;
                check_version(&tor, &format!("{}.onion", OnionV3Address::from(&addr)), Duration::from_secs(timeout_secs))?;
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------ accounts

    /// (label, BIP32 path, active?) for every account in this wallet.
    pub fn accounts(&self) -> Result<Vec<(String, String, bool)>> {
        let active = {
            let mut w = self.inst.lock();
            w.lc_provider()?.wallet_inst()?.parent_key_id()
        };
        Ok(self
            .owner
            .accounts(self.mask())?
            .into_iter()
            .map(|a| (a.label, a.path.to_bip_32_string(), a.path == active))
            .collect())
    }

    pub fn create_account(&self, label: &str) -> Result<()> {
        let label = label.trim();
        if label.is_empty() {
            bail!("hesap adı boş olamaz");
        }
        self.owner.create_account_path(self.mask(), label)?;
        Ok(())
    }

    /// Switch the active account. Each account has its own Slatepack/onion address, so a running
    /// onion service is restarted with the new key.
    pub fn set_account(&self, label: &str) -> Result<()> {
        self.owner.set_active_account(self.mask(), label)?;
        if self.listening() {
            if let TorMode::Bundled(bundle) = &self.settings.tor {
                let hs_dir = self.write_onion_keys()?;
                let mut slot = self.bundled_tor.lock().unwrap();
                *slot = None; // stop the old tor first: same data dir
                *slot = Some(Arc::new(BundledTor::start(TorLaunch {
                    bundle,
                    data_dir: &self.settings.dir.join("tor").join("bundled"),
                    hidden_service: Some((hs_dir, self.settings.listen_port)),
                    bridges: &self.bridges.lock().unwrap().clone(),
                })?));
            }
        }
        Ok(())
    }

    /// Apply new bridge lines (empty = direct) by restarting the bundled tor. The onion address
    /// stays the same; it needs ~2 minutes to be findable again.
    /// Stop tor and forget its saved state (entry relays, cached consensus); the onion keys are kept.
    pub fn wipe_tor_state(&self) -> Result<()> {
        // The slot stays locked while the folder is removed: send, ping and the reachability check call
        // `bundled()`, which would otherwise start a new tor on the same folder at once.
        let mut slot = self.bundled_tor.lock().unwrap();
        if let Some(t) = slot.take() {
            t.stop(); // explicit: a background check may still hold a reference
        }
        tor::wipe_state(&self.settings.dir.join("tor").join("bundled"))
    }

    /// Wipe tor's saved state and start it again (with the onion service when this wallet listens).
    pub fn reset_tor(&self) -> Result<()> {
        let TorMode::Bundled(bundle) = &self.settings.tor else {
            bail!("the integrated Arti engine has no saved state to reset");
        };
        let bridges = self.bridges.lock().unwrap().clone();
        let hs = if self.listening() {
            Some((self.write_onion_keys()?, self.settings.listen_port))
        } else {
            None
        };
        let dir = self.settings.dir.join("tor").join("bundled");
        let mut slot = self.bundled_tor.lock().unwrap();
        if let Some(t) = slot.take() {
            t.stop();
        }
        tor::wipe_state(&dir)?;
        *slot = Some(Arc::new(BundledTor::start(TorLaunch { bundle, data_dir: &dir, hidden_service: hs, bridges: &bridges })?));
        Ok(())
    }

    /// Start tor again with the bridges it already uses and the state it already has (circuits are rebuilt, the
    /// onion address is published again). Used when tor exited by itself or the computer woke from sleep.
    pub fn restart_tor_same(&self) -> Result<()> {
        let bridges = self.bridges.lock().unwrap().clone();
        self.restart_tor(bridges)
    }

    pub fn restart_tor(&self, bridges: Vec<String>) -> Result<()> {
        *self.bridges.lock().unwrap() = bridges;
        let TorMode::Bundled(bundle) = &self.settings.tor else {
            bail!("the integrated Arti engine picks up bridge changes on the next start");
        };
        let hs = if self.listening() {
            Some((self.write_onion_keys()?, self.settings.listen_port))
        } else {
            None
        };
        let mut slot = self.bundled_tor.lock().unwrap();
        *slot = None;
        *slot = Some(Arc::new(BundledTor::start(TorLaunch {
            bundle,
            data_dir: &self.settings.dir.join("tor").join("bundled"),
            hidden_service: hs,
            bridges: &self.bridges.lock().unwrap().clone(),
        })?));
        Ok(())
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    // ------------------------------------------------------------ security

    pub fn change_password(&self, old: &str, new: &str) -> Result<()> {
        let mut w = self.inst.lock();
        w.lc_provider()?
            .change_password(None, ZeroingString::from(old), ZeroingString::from(new))
            .map_err(|_| anyhow!("wrong password"))?;
        Ok(())
    }

    /// The recovery phrase (asks for the password again).
    pub fn recovery_phrase(&self, password: &str) -> Result<ZeroingString> {
        let mut w = self.inst.lock();
        w.lc_provider()?
            .get_mnemonic(None, ZeroingString::from(password))
            .map_err(|_| anyhow!("wrong password"))
    }

    // ------------------------------------------------------------ transactions

    fn slate_uuid(id: &str) -> Result<uuid::Uuid> {
        id.trim().parse().map_err(|_| anyhow!("bad transaction id"))
    }

    pub fn transaction(&self, slate_id: &str) -> Result<TxLogEntry> {
        let id = Self::slate_uuid(slate_id)?;
        self.owner
            .retrieve_txs(self.mask(), false, None, Some(id), None)?
            .1
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("transaction not found"))
    }

    /// Payment proof of a sent transaction as JSON (grin-wallet `export_proof` format).
    pub fn payment_proof(&self, slate_id: &str) -> Result<String> {
        let id = Self::slate_uuid(slate_id)?;
        let proof = self.owner.retrieve_payment_proof(self.mask(), true, None, Some(id))?;
        Ok(serde_json::to_string_pretty(&proof)?)
    }

    /// Post a finalized transaction to the chain again (when it got stuck in the mempool).
    pub fn repost(&self, slate_id: &str) -> Result<()> {
        let id = Self::slate_uuid(slate_id)?;
        let slate = self
            .owner
            .get_stored_tx(self.mask(), None, Some(&id))?
            .ok_or_else(|| anyhow!("no stored transaction to repost"))?;
        Ok(self.owner.post_tx(self.mask(), &slate, false)?)
    }

    /// Cancel an unfinished transaction and unlock its outputs.
    pub fn cancel(&self, tx_slate_id: &str) -> Result<()> {
        let id = tx_slate_id.parse().map_err(|_| anyhow!("bad transaction id"))?;
        Ok(self.owner.cancel_tx(self.mask(), None, Some(id))?)
    }
}

/// One JSON-RPC call to a recipient's Foreign API; errors reported by the wallet become Err.
fn rpc(tor: &BundledTor, host: &str, req: &Value, timeout: Duration) -> Result<Value> {
    let body = tor.post_foreign(host, &req.to_string(), timeout)?;
    let res: Value =
        serde_json::from_str(&body).map_err(|_| anyhow!("recipient sent a bad answer"))?;
    if !res["error"].is_null() {
        bail!("recipient wallet error {}: {}", res["error"]["code"], res["error"]["message"]);
    }
    if let Some(e) = res["result"].get("Err") {
        bail!("recipient wallet refused: {e}");
    }
    Ok(res)
}

/// Same compatibility test as TorSlateSender::check_other_version.
fn check_version(tor: &BundledTor, host: &str, timeout: Duration) -> Result<()> {
    let req = json!({"jsonrpc": "2.0", "method": "check_version", "id": 1, "params": []});
    let res = rpc(tor, host, &req, timeout)?;
    let v = &res["result"]["Ok"];
    if v["foreign_api_version"].as_u64().unwrap_or(0) < 2 {
        bail!("recipient wallet is too old");
    }
    let ok = v["supported_slate_versions"]
        .as_array()
        .is_some_and(|a| a.iter().any(|s| s == "V4"));
    if !ok {
        bail!("recipient wallet does not support slate V4");
    }
    Ok(())
}

#[derive(Debug)]
pub enum ProcessOutcome {
    Received(ReceiveOutcome),
    Finalized { tx_slate_id: String },
}
