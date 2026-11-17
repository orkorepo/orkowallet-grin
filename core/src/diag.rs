//! Connection diagnostics: small, side-effect-free checks that help find out why Tor will not come up.
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

fn can_connect(addr: &str, secs: u64) -> bool {
    addr.to_socket_addrs()
        .ok()
        .and_then(|mut a| a.next())
        .is_some_and(|a: SocketAddr| TcpStream::connect_timeout(&a, Duration::from_secs(secs)).is_ok())
}

/// Try several hosts in parallel; true as soon as one of them accepts a connection.
fn any_connects(addrs: &[&str], secs: u64) -> (usize, usize) {
    let handles: Vec<_> = addrs
        .iter()
        .map(|a| {
            let a = a.to_string();
            std::thread::spawn(move || can_connect(&a, secs))
        })
        .collect();
    let ok = handles.into_iter().filter_map(|h| h.join().ok()).filter(|b| *b).count();
    (ok, addrs.len())
}

/// Is there an internet connection at all (plain TCP to well-known public resolvers)?
pub fn internet_ok() -> bool {
    any_connects(&["1.1.1.1:443", "8.8.8.8:443", "9.9.9.9:443"], 4).0 > 0
}

/// How many of the Tor directory authorities can be reached directly, out of how many were tried.
/// Zero means the network blocks Tor and a bridge is needed.
pub fn tor_direct_reach() -> (usize, usize) {
    any_connects(
        &[
            "171.25.193.9:80",   // maatuska
            "193.23.244.244:80", // dannenberg
            "131.188.40.189:80", // gabelmoo
            "199.58.81.140:80",  // longclaw
            "45.66.35.11:80",    // dizum
            "204.13.164.118:80", // bastet
        ],
        5,
    )
}

/// Local clock minus the clock of a web server (seconds), from the HTTP `Date` header. None when no
/// server answered. Tor refuses to work when the clock is off by more than a few minutes.
pub fn clock_skew_secs() -> Option<i64> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).build();
    for url in ["https://1.1.1.1/", "https://www.microsoft.com/", "https://grincoin.org/"] {
        let resp = match agent.head(url).call() {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(_) => continue,
        };
        if let Some(d) = resp.header("Date").and_then(|d| chrono::DateTime::parse_from_rfc2822(d).ok()) {
            return Some(chrono::Utc::now().timestamp() - d.timestamp());
        }
    }
    None
}

/// Known problems in the recent Tor log lines (ids the interface turns into text).
pub fn log_hints(log: &str) -> Vec<&'static str> {
    let tor: Vec<&str> = log.lines().filter(|l| l.contains("grin_orko::tor - tor:")).collect();
    let tail = &tor[tor.len().saturating_sub(250)..];
    let any = |pats: &[&str]| tail.iter().any(|l| pats.iter().any(|p| l.contains(p)));
    let mut v = Vec::new();
    if any(&["clock", "skew", "not yet valid", "has expired"]) {
        v.push("clock");
    }
    if any(&["Unable to decompress", "TLS error", "SSL_ERROR", "certificate verify failed"]) {
        v.push("tls");
    }
    if any(&["WSAENETUNREACH", "Network is unreachable"]) {
        v.push("unreach");
    }
    if any(&["Problem bootstrapping", "Stuck at"]) {
        v.push("stuck");
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hints_from_log() {
        let log = "20261117 INFO grin_orko::tor - tor: [warn] Problem bootstrapping. Stuck at 30% (loading_status) (Network is unreachable [WSAENETUNREACH ])\n20261117 INFO other line";
        let h = log_hints(log);
        assert!(h.contains(&"stuck") && h.contains(&"unreach") && !h.contains(&"clock"));
        assert!(log_hints("nothing here").is_empty());
    }
}
