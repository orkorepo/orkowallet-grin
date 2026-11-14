//! Bundled C Tor (`tor.exe` from the official Tor Expert Bundle), run by the app as ONE long-lived
//! process: it publishes the wallet's onion service and carries every outgoing send, so circuits
//! stay warm. grin-wallet's own external-Tor mode starts a fresh tor for every send instead.
//!
//! Only transport lives here. The onion key files are written by grin-wallet's own
//! `output_onion_service_config` (so the onion address is exactly grin-wallet's), and the slate
//! handling in `foreign_call` mirrors `TorSlateSender::send_tx` (grin_wallet_impls 5.5.1).

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};

/// Where tor is in its start-up.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TorStatus {
    /// Bootstrap percentage reported by tor.
    Starting(u8),
    Ready,
    Failed(String),
}

/// Layout of the Tor Expert Bundle as extracted (`tor/tor.exe`, `tor/pluggable_transports/`,
/// `data/geoip*`).
#[derive(Clone, Debug)]
pub struct TorBundle {
    pub dir: PathBuf,
}

impl TorBundle {
    fn tor_exe(&self) -> PathBuf {
        let name = if cfg!(windows) { "tor.exe" } else { "tor" };
        self.dir.join("tor").join(name)
    }
    fn lyrebird(&self) -> PathBuf {
        let name = if cfg!(windows) { "lyrebird.exe" } else { "lyrebird" };
        self.dir.join("tor").join("pluggable_transports").join(name)
    }
}

/// What to run.
pub struct TorLaunch<'a> {
    pub bundle: &'a TorBundle,
    /// Tor's state (consensus cache, guards). Kept between runs so later starts are fast.
    pub data_dir: &'a Path,
    /// (hidden service directory with grin-wallet's key files, local Foreign API port)
    pub hidden_service: Option<(PathBuf, u16)>,
    /// Bridge lines as shown on bridges.torproject.org (obfs4 / webtunnel / snowflake / meek_lite).
    pub bridges: &'a [String],
}

pub struct BundledTor {
    child: Child,
    socks: SocketAddr,
    status: Arc<Mutex<TorStatus>>,
}

/// torrc values are C strings when quoted: quote every path so spaces and backslashes survive.
fn q(p: &Path) -> String {
    format!("\"{}\"", p.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\""))
}

/// grin's logger only keeps records whose module path starts with "grin", so tag ours that way.
pub fn glog(level: log::Level, msg: &str) {
    log::logger().log(
        &log::Record::builder()
            .args(format_args!("{msg}"))
            .level(level)
            .target("grin_orko")
            .module_path_static(Some("grin_orko::tor"))
            .build(),
    );
}

fn free_port() -> Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

impl BundledTor {
    pub fn start(l: TorLaunch) -> Result<BundledTor> {
        let exe = l.bundle.tor_exe();
        if !exe.exists() {
            bail!("Tor is missing: {}", exe.display());
        }
        std::fs::create_dir_all(l.data_dir)?;
        let socks: SocketAddr = format!("127.0.0.1:{}", free_port()?).parse()?;

        let mut rc = String::new();
        writeln!(rc, "SocksPort {socks}")?;
        writeln!(rc, "DataDirectory {}", q(&l.data_dir.join("data")))?;
        writeln!(rc, "GeoIPFile {}", q(&l.bundle.dir.join("data").join("geoip")))?;
        writeln!(rc, "GeoIPv6File {}", q(&l.bundle.dir.join("data").join("geoip6")))?;
        // tor exits by itself when the app dies, even if the app is killed.
        writeln!(rc, "__OwningControllerProcess {}", std::process::id())?;
        writeln!(rc, "Log notice stdout")?;
        if let Some((dir, port)) = &l.hidden_service {
            writeln!(rc, "HiddenServiceDir {}", q(dir))?;
            writeln!(rc, "HiddenServicePort 80 127.0.0.1:{port}")?;
        }
        let bridges: Vec<&str> =
            l.bridges.iter().map(|b| b.trim()).filter(|b| !b.is_empty()).collect();
        if !bridges.is_empty() {
            let pt = l.bundle.lyrebird();
            if !pt.exists() {
                bail!("bridge transport is missing: {}", pt.display());
            }
            writeln!(rc, "UseBridges 1")?;
            // Same plugin mapping as the bundle's pt_config.json. `exec` takes a raw command
            // line (no C-string quoting) split on spaces, so name the plugin relative to tor's
            // working directory (bundle/tor, set below): install paths like
            // "C:\Program Files\..." contain spaces.
            let pt_rel = Path::new("pluggable_transports").join(pt.file_name().unwrap());
            let pt_rel = pt_rel.display();
            writeln!(rc, "ClientTransportPlugin meek_lite,obfs2,obfs3,obfs4,scramblesuit,webtunnel exec {pt_rel}")?;
            writeln!(rc, "ClientTransportPlugin snowflake exec {pt_rel}")?;
            for b in bridges {
                let b = b.strip_prefix("Bridge ").unwrap_or(b);
                writeln!(rc, "Bridge {b}")?;
            }
        }
        let torrc = l.data_dir.join("torrc");
        std::fs::write(&torrc, rc)?;

        let mut cmd = Command::new(&exe);
        cmd.arg("-f").arg(&torrc).arg("--defaults-torrc").arg(l.data_dir.join("torrc-defaults-none"));
        // Every path in the torrc is absolute except the transport plugin (see above).
        cmd.current_dir(exe.parent().unwrap()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().with_context(|| format!("could not start {}", exe.display()))?;

        let status = Arc::new(Mutex::new(TorStatus::Starting(0)));
        let stdout = child.stdout.take().context("no tor stdout")?;
        let st = status.clone();
        std::thread::Builder::new().name("tor-log".into()).spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
                let level = if line.contains("[warn]") || line.contains("[err]") {
                    log::Level::Warn
                } else {
                    log::Level::Info
                };
                glog(level, &format!("tor: {line}"));
                let mut s = st.lock().unwrap();
                if let Some(i) = line.find("Bootstrapped ") {
                    let pct: u8 = line[i + 13..]
                        .split('%')
                        .next()
                        .and_then(|n| n.trim().parse().ok())
                        .unwrap_or(0);
                    *s = if pct >= 100 { TorStatus::Ready } else { TorStatus::Starting(pct) };
                } else if line.contains("[err]") {
                    *s = TorStatus::Failed(line.clone());
                }
            }
            // stdout closed: tor has exited.
            let mut s = st.lock().unwrap();
            if !matches!(*s, TorStatus::Failed(_)) {
                *s = TorStatus::Failed("tor stopped".into());
            }
        })?;
        Ok(BundledTor { child, socks, status })
    }

    pub fn status(&self) -> TorStatus {
        self.status.lock().unwrap().clone()
    }

    /// Block until tor has bootstrapped (or failed / timed out).
    pub fn wait_ready(&self, timeout: Duration) -> Result<()> {
        let t = Instant::now();
        loop {
            match self.status() {
                TorStatus::Ready => return Ok(()),
                TorStatus::Failed(e) => bail!("Tor failed: {e}"),
                TorStatus::Starting(p) if t.elapsed() > timeout => {
                    bail!("Tor did not connect in {}s (stuck at {p}%)", timeout.as_secs())
                }
                _ => std::thread::sleep(Duration::from_millis(250)),
            }
        }
    }

    /// POST a JSON-RPC body to http://<host>/v2/foreign through this tor.
    pub fn post_foreign(&self, host: &str, body: &str, timeout: Duration) -> Result<String> {
        post_via_socks(self.socks, host, 80, "/v2/foreign", body, timeout)
    }
}

impl Drop for BundledTor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Tor's SOCKS5 reply codes, including its onion-service extensions (tor proposal 304).
fn socks_error(code: u8) -> String {
    match code {
        1 => "general failure".into(),
        3 => "network unreachable".into(),
        4 => "recipient wallet unreachable".into(),
        5 => "connection refused".into(),
        6 => "timed out".into(),
        0xF0 => "recipient is offline (onion descriptor not found)".into(),
        0xF1 => "recipient onion descriptor is invalid".into(),
        0xF2 => "recipient is offline (introduction failed)".into(),
        0xF3 => "recipient is offline (rendezvous failed)".into(),
        0xF4 => "onion service needs client authorization".into(),
        0xF5 => "wrong onion client authorization".into(),
        0xF6 => "not a valid onion address".into(),
        0xF7 => "onion introduction timed out".into(),
        c => format!("SOCKS error {c}"),
    }
}

fn post_via_socks(
    socks: SocketAddr,
    host: &str,
    port: u16,
    path: &str,
    body: &str,
    timeout: Duration,
) -> Result<String> {
    let mut s = TcpStream::connect_timeout(&socks, Duration::from_secs(5))
        .context("Tor is not running")?;
    s.set_read_timeout(Some(timeout))?;
    s.set_write_timeout(Some(timeout))?;

    // SOCKS5, no auth, CONNECT by name (tor resolves the .onion).
    s.write_all(&[5, 1, 0])?;
    let mut hello = [0u8; 2];
    s.read_exact(&mut hello)?;
    if hello != [5, 0] {
        bail!("Tor SOCKS refused the handshake");
    }
    let h = host.as_bytes();
    if h.len() > 255 {
        bail!("host name too long");
    }
    let mut req = vec![5, 1, 0, 3, h.len() as u8];
    req.extend_from_slice(h);
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req)?;
    let mut head = [0u8; 4];
    s.read_exact(&mut head).map_err(|e| anyhow!("no answer from Tor in time ({e})"))?;
    if head[1] != 0 {
        bail!("{}", socks_error(head[1]));
    }
    let skip = match head[3] {
        1 => 4 + 2,
        4 => 16 + 2,
        3 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l)?;
            l[0] as usize + 2
        }
        _ => bail!("bad SOCKS reply"),
    };
    let mut rest = vec![0u8; skip];
    s.read_exact(&mut rest)?;

    let http = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(http.as_bytes())?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw)?;
    let raw = String::from_utf8_lossy(&raw).into_owned();
    let (headers, payload) = raw.split_once("\r\n\r\n").context("bad HTTP answer")?;
    let status_line = headers.lines().next().unwrap_or_default();
    if !status_line.contains(" 200") {
        bail!("recipient wallet answered: {status_line}");
    }
    if headers.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        return dechunk(payload);
    }
    Ok(payload.to_string())
}

fn dechunk(mut s: &str) -> Result<String> {
    let mut out = String::new();
    loop {
        let (size, rest) = s.split_once("\r\n").context("bad chunk")?;
        let n = usize::from_str_radix(size.trim(), 16).context("bad chunk size")?;
        if n == 0 {
            return Ok(out);
        }
        out.push_str(rest.get(..n).context("short chunk")?);
        s = rest.get(n + 2..).context("short chunk")?;
    }
}
