//! Opt-in "fast sync" for the built-in node: instead of syncing the whole chain over P2P, download a recent
//! pruned `chain_data` snapshot published by community servers and start the node from it. The node then only
//! catches up the last few days of blocks.
//!
//! It is never automatic. The user asks for it, and whatever goes wrong (no server, old snapshot, checksum
//! mismatch, no space, cancel) leaves the existing chain data untouched, so the normal P2P sync still works.
//!
//! Snapshots are described by a small `chaindata.json` next to each archive (see the Grin Node Toolkit):
//! the host list comes from its public registry (a built-in list is used when that cannot be reached), the
//! archive is checked against the sha256 from the manifest while it is downloaded, and anything older than
//! five days is skipped.

use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::Network;

const REGISTRY: &str = "https://raw.githubusercontent.com/noobvie/Grin-Node-Toolkit/main/extensions/grinmasternodes.json";
/// Used when the registry cannot be fetched.
const BUILTIN_MAIN: [&str; 4] = ["prunemain.grin.money", "prunemain.grinnode.org", "prunemain.grinily.com", "prunemain.onlygrins.com"];
const BUILTIN_TEST: [&str; 4] = ["prunetest.grin.money", "prunetest.grinnode.org", "prunetest.onlygrins.com", "prunetest.grinily.com"];
/// Older snapshots would leave a pruned node too far behind.
const MAX_AGE_SECS: i64 = 5 * 24 * 3600;
const MAX_SIZE: u64 = 40 * 1024 * 1024 * 1024;
const ATTEMPTS: u32 = 10;

/// What the UI shows.
#[derive(Clone, Debug, Serialize, Default)]
pub struct FastView {
    pub active: bool,
    /// "idle" | "find" | "download" | "unpack" | "swap" | "done" | "failed" | "paused"
    pub phase: String,
    pub done: u64,
    pub total: u64,
    pub host: String,
    pub error: String,
}

static VIEW: Mutex<Option<FastView>> = Mutex::new(None);
static CANCEL: AtomicBool = AtomicBool::new(false);

pub fn view() -> FastView {
    VIEW.lock().unwrap().clone().unwrap_or(FastView { phase: "idle".into(), ..Default::default() })
}

pub fn cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

fn set(f: impl FnOnce(&mut FastView)) {
    let mut g = VIEW.lock().unwrap();
    let v = g.get_or_insert_with(|| FastView { phase: "idle".into(), ..Default::default() });
    f(v);
}

#[derive(Deserialize)]
struct Manifest {
    network: Option<String>,
    node_type: Option<String>,
    archive: Option<String>,
    sha256: Option<String>,
    size_bytes: Option<u64>,
    generated_utc: Option<String>,
}

#[derive(Clone, Debug)]
struct Snapshot {
    host: String,
    archive: String,
    sha256: String,
    size: u64,
    generated: i64,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(45))
        .build()
}

fn valid_host(h: &str) -> bool {
    !h.is_empty() && h.len() < 100 && h.contains('.') && h.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

fn valid_archive(a: &str) -> bool {
    a.ends_with(".tar.gz") && a.len() < 120 && a.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

fn hosts(network: Network) -> Vec<String> {
    let key = if network == Network::Mainnet { "prunemain" } else { "prunetest" };
    let mut out: Vec<String> = Vec::new();
    let fetched: Result<serde_json::Value> = (|| {
        let r = agent().get(REGISTRY).timeout(Duration::from_secs(15)).call()?;
        let mut s = String::new();
        r.into_reader().take(1 << 20).read_to_string(&mut s)?;
        Ok(serde_json::from_str(&s)?)
    })();
    if let Ok(v) = fetched {
        if let Some(zones) = v.as_object() {
            for (zone, body) in zones {
                if zone.starts_with('_') {
                    continue;
                }
                if let Some(list) = body.get(key).and_then(|l| l.as_array()) {
                    out.extend(list.iter().filter_map(|h| h.as_str()).map(|h| h.trim().to_ascii_lowercase()));
                }
            }
        }
    }
    let builtin: &[&str] = if network == Network::Mainnet { &BUILTIN_MAIN } else { &BUILTIN_TEST };
    out.extend(builtin.iter().map(|h| h.to_string()));
    out.retain(|h| valid_host(h));
    let mut seen = std::collections::HashSet::new();
    out.retain(|h| seen.insert(h.clone()));
    out
}

fn manifest(host: &str, network: Network) -> Result<Snapshot> {
    let r = agent().get(&format!("https://{host}/chaindata.json")).timeout(Duration::from_secs(20)).call()?;
    let mut s = String::new();
    r.into_reader().take(1 << 16).read_to_string(&mut s)?;
    let m: Manifest = serde_json::from_str(&s)?;
    let want = if network == Network::Mainnet { "mainnet" } else { "testnet" };
    if m.network.as_deref() != Some(want) {
        bail!("wrong network");
    }
    if m.node_type.as_deref() != Some("pruned") {
        bail!("not a pruned snapshot");
    }
    let archive = m.archive.filter(|a| valid_archive(a)).ok_or_else(|| anyhow!("bad archive name"))?;
    let sha = m.sha256.map(|s| s.to_ascii_lowercase()).filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())).ok_or_else(|| anyhow!("bad checksum"))?;
    let size = m.size_bytes.filter(|n| *n > 0 && *n <= MAX_SIZE).ok_or_else(|| anyhow!("bad size"))?;
    let built = chrono::DateTime::parse_from_rfc3339(m.generated_utc.as_deref().unwrap_or("")).map_err(|_| anyhow!("bad date"))?.timestamp();
    let age = chrono::Utc::now().timestamp() - built;
    if age > MAX_AGE_SECS {
        bail!("snapshot is older than 5 days");
    }
    if age < -86_400 {
        bail!("snapshot date is in the future");
    }
    Ok(Snapshot { host: host.to_string(), archive, sha256: sha, size, generated: built })
}

fn newest(network: Network) -> Result<Vec<Snapshot>> {
    let mut found: Vec<Snapshot> = Vec::new();
    for h in hosts(network) {
        if CANCEL.load(Ordering::SeqCst) {
            bail!("cancelled");
        }
        match manifest(&h, network) {
            Ok(s) => found.push(s),
            Err(e) => log::info!("fast sync: {h}: {e}"),
        }
    }
    if found.is_empty() {
        bail!("no recent snapshot is available right now");
    }
    found.sort_by(|a, b| b.generated.cmp(&a.generated));
    Ok(found)
}

/// Reads an archive, counting what was read and stopping when cancelled.
struct Counting<R> {
    inner: R,
}
impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if CANCEL.load(Ordering::SeqCst) {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled"));
        }
        let n = self.inner.read(buf)?;
        set(|v| v.done += n as u64);
        Ok(n)
    }
}

/// Download to `part` (resuming what is already there), hashing as we go. Returns the sha256 of the whole file.
fn download(s: &Snapshot, part: &Path) -> Result<String> {
    let mut have = part.metadata().map(|m| m.len()).unwrap_or(0);
    if have > s.size {
        let _ = fs::remove_file(part);
        have = 0;
    }
    let mut hasher = Sha256::new();
    if have > 0 {
        // A part left from an earlier run: hash it once, then carry on from its end.
        let mut f = BufReader::new(File::open(part)?);
        let mut buf = vec![0u8; 1 << 20];
        loop {
            if CANCEL.load(Ordering::SeqCst) {
                bail!("cancelled");
            }
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
    }
    set(|v| { v.phase = "download".into(); v.done = have; v.total = s.size; });
    let url = format!("https://{}/{}", s.host, s.archive);
    let mut attempt = 0;
    while have < s.size {
        if CANCEL.load(Ordering::SeqCst) {
            bail!("cancelled");
        }
        attempt += 1;
        let r: Result<()> = (|| {
            let mut req = agent().get(&url);
            if have > 0 {
                req = req.set("Range", &format!("bytes={have}-"));
            }
            let resp = req.call()?;
            if have > 0 && resp.status() != 206 {
                // The server ignores Range: take the whole file again.
                have = 0;
                hasher = Sha256::new();
                set(|v| v.done = 0);
            }
            let mut f = OpenOptions::new().create(true).write(true).open(part)?;
            f.set_len(have)?;
            f.seek(SeekFrom::Start(have))?;
            let mut rd = resp.into_reader();
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                if CANCEL.load(Ordering::SeqCst) {
                    bail!("cancelled");
                }
                let n = rd.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                if have + n as u64 > s.size {
                    bail!("the server sent more than announced");
                }
                f.write_all(&buf[..n])?;
                hasher.update(&buf[..n]);
                have += n as u64;
                set(|v| v.done = have);
            }
            f.flush()?;
            Ok(())
        })();
        match r {
            Ok(()) if have >= s.size => break,
            Ok(()) => {} // ended early: try again from where it stopped
            Err(e) if e.to_string() == "cancelled" => return Err(e),
            Err(e) => {
                log::info!("fast sync: download interrupted at {have}: {e}");
            }
        }
        if attempt >= ATTEMPTS {
            bail!("the download kept failing");
        }
        std::thread::sleep(Duration::from_secs(2 * attempt as u64));
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Where the unpacked chain data is: the `chain_data/` folder inside (the usual layout), or the folder itself.
fn chain_root(dir: &Path) -> Option<PathBuf> {
    let inner = dir.join("chain_data");
    if inner.is_dir() {
        return Some(inner);
    }
    let looks_like_chain = |p: &Path| ["lmdb", "multi_lmdb", "txhashset"].iter().any(|n| p.join(n).is_dir());
    if looks_like_chain(dir) {
        return Some(dir.to_path_buf());
    }
    for e in fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() && looks_like_chain(&p) {
            return Some(p);
        }
    }
    None
}

fn unpack(part: &Path, size: u64, dest: &Path) -> Result<()> {
    set(|v| { v.phase = "unpack".into(); v.done = 0; v.total = size; });
    let _ = fs::remove_dir_all(dest);
    fs::create_dir_all(dest)?;
    let f = File::open(part)?;
    let gz = flate2::read::GzDecoder::new(BufReader::new(Counting { inner: f }));
    let mut ar = tar::Archive::new(gz);
    ar.set_preserve_permissions(false);
    ar.set_overwrite(true);
    ar.unpack(dest).context("could not unpack the snapshot")
}

/// Run a fast sync into `node_dir` (the node's folder; its `chain_data` is replaced). Blocks until done.
fn run(node_dir: &Path, network: Network) -> Result<()> {
    if !matches!(network, Network::Mainnet | Network::Testnet) {
        bail!("fast sync is only available on mainnet and testnet");
    }
    fs::create_dir_all(node_dir)?;
    set(|v| { *v = FastView { active: true, phase: "find".into(), ..Default::default() }; });
    let list = newest(network)?;
    let mut last = anyhow!("no snapshot");
    for s in list {
        set(|v| { v.host = s.host.clone(); v.done = 0; v.total = s.size; });
        // One part file per archive name; parts of older snapshots are not useful any more.
        let part = node_dir.join(format!("fastsync-{}-{}.part", s.host, s.archive));
        if let Ok(rd) = fs::read_dir(node_dir) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if n.starts_with("fastsync-") && n.ends_with(".part") && e.path() != part {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
        let got = match download(&s, &part) {
            Ok(h) => h,
            Err(e) => {
                if e.to_string() == "cancelled" {
                    return Err(e);
                }
                last = e;
                continue;
            }
        };
        if got != s.sha256 {
            let _ = fs::remove_file(&part);
            last = anyhow!("the downloaded file does not match its checksum");
            continue;
        }
        let tmp = node_dir.join("chain_data.fast");
        let root_dir = node_dir.join("chain_data");
        let old = node_dir.join("chain_data.old");
        let r = (|| -> Result<()> {
            unpack(&part, s.size, &tmp)?;
            let new_root = chain_root(&tmp).ok_or_else(|| anyhow!("the snapshot has an unexpected layout"))?;
            set(|v| v.phase = "swap".into());
            let _ = fs::remove_dir_all(&old);
            if root_dir.exists() {
                fs::rename(&root_dir, &old).context("could not move the old chain data")?;
            }
            if let Err(e) = fs::rename(&new_root, &root_dir) {
                if old.exists() {
                    let _ = fs::rename(&old, &root_dir);
                }
                return Err(anyhow!(e).context("could not put the snapshot in place"));
            }
            Ok(())
        })();
        let _ = fs::remove_dir_all(&tmp);
        match r {
            Ok(()) => {
                let _ = fs::remove_dir_all(&old);
                let _ = fs::remove_file(&part);
                return Ok(());
            }
            Err(e) => {
                if e.to_string() == "cancelled" || format!("{e:?}").contains("cancelled") {
                    return Err(anyhow!("cancelled"));
                }
                // A snapshot that checks out but cannot be unpacked will not work from another host either.
                let _ = fs::remove_file(&part);
                return Err(e);
            }
        }
    }
    Err(last)
}

/// Start a fast sync on its own thread. `on_done` runs after a successful one (the app starts the node there).
/// Fails at once when one is already running.
pub fn start(node_dir: PathBuf, network: Network, on_done: impl FnOnce() + Send + 'static) -> Result<()> {
    {
        let mut g = VIEW.lock().unwrap();
        if g.as_ref().map(|v| v.active).unwrap_or(false) {
            bail!("a fast sync is already running");
        }
        *g = Some(FastView { active: true, phase: "find".into(), ..Default::default() });
    }
    CANCEL.store(false, Ordering::SeqCst);
    std::thread::Builder::new().name("fast-sync".into()).spawn(move || {
        match run(&node_dir, network) {
            Ok(()) => {
                set(|v| { v.active = false; v.phase = "done".into(); v.done = v.total; });
                on_done();
            }
            Err(e) if e.to_string() == "cancelled" => {
                set(|v| { v.active = false; v.phase = "paused".into(); });
            }
            Err(e) => {
                log::warn!("fast sync failed: {e:#}");
                set(|v| { v.active = false; v.phase = "failed".into(); v.error = format!("{e:#}"); });
            }
        }
    })?;
    Ok(())
}
