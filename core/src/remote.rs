//! Read-only view of an external node through its public Foreign API v2
//! (get_tip, get_version, get_header, get_pool_size), plus health probes for the node pool.
//! Peers, stem pool and disk size are not exposed by that API, so they stay empty for remote nodes.

use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use serde_json::{json, Value};

use crate::node::{BlockView, ChainPoint, NodeView};

fn call(agent: &ureq::Agent, url: &str, method: &str, params: Value) -> Result<Value> {
    let body = json!({"jsonrpc": "2.0", "method": method, "params": params, "id": 1});
    let res: Value = agent
        .post(&format!("{}/v2/foreign", url.trim_end_matches('/')))
        .send_json(body)
        .map_err(|e| anyhow!("node'a ulaşılamadı: {e}"))?
        .into_json()?;
    if !res["error"].is_null() {
        bail!("node hatası: {}", res["error"]["message"]);
    }
    let ok = &res["result"]["Ok"];
    if ok.is_null() {
        bail!("node beklenmeyen yanıt verdi");
    }
    Ok(ok.clone())
}

fn parse_time(s: &str) -> u64 {
    chrono::DateTime::parse_from_rfc3339(s).map(|t| t.timestamp() as u64).unwrap_or(0)
}

/// Result of asking one node for its tip.
#[derive(Clone, Debug, Serialize, Default)]
pub struct NodeProbe {
    pub url: String,
    pub ok: bool,
    pub latency_ms: u64,
    pub height: u64,
    pub error: String,
}

fn probe_one(url: &str) -> NodeProbe {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(6)).build();
    let t = Instant::now();
    match call(&agent, url, "get_tip", json!([])) {
        Ok(tip) => NodeProbe {
            url: url.to_string(),
            ok: true,
            latency_ms: t.elapsed().as_millis() as u64,
            height: tip["height"].as_u64().unwrap_or(0),
            error: String::new(),
        },
        Err(e) => NodeProbe { url: url.to_string(), error: e.to_string(), ..Default::default() },
    }
}

/// Ask every node for its tip at the same time (6 s limit each).
pub fn probe_nodes(urls: &[String]) -> Vec<NodeProbe> {
    std::thread::scope(|s| {
        let handles: Vec<_> = urls.iter().map(|u| s.spawn(move || probe_one(u))).collect();
        handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
    })
}

/// Same ordering as `order_by_health`, from health checks that were already made.
pub fn order_from_probes(urls: &[String], probes: &[NodeProbe]) -> Vec<String> {
    let of = |u: &String| probes.iter().find(|p| &p.url == u).cloned().unwrap_or_default();
    let best = urls.iter().map(|u| of(u)).filter(|p| p.ok).map(|p| p.height).max().unwrap_or(0);
    let mut good: Vec<NodeProbe> = urls.iter().map(|u| of(u)).filter(|p| p.ok && p.height + 10 >= best).collect();
    good.sort_by_key(|p| p.latency_ms);
    let mut out: Vec<String> = good.into_iter().map(|p| p.url).collect();
    for u in urls {
        if !out.contains(u) {
            out.push(u.clone());
        }
    }
    out
}

/// Healthy nodes first, fastest first. A node more than 10 blocks behind the best one counts as
/// unhealthy (it would show a stale balance). Unreachable nodes keep their order at the end, so a
/// node that was only briefly down is still tried when everything else fails.
pub fn order_by_health(urls: &[String]) -> Vec<String> {
    let probes = probe_nodes(urls);
    let best = probes.iter().filter(|p| p.ok).map(|p| p.height).max().unwrap_or(0);
    let mut good: Vec<&NodeProbe> = probes.iter().filter(|p| p.ok && p.height + 10 >= best).collect();
    good.sort_by_key(|p| p.latency_ms);
    let mut out: Vec<String> = good.iter().map(|p| p.url.clone()).collect();
    for u in urls {
        if !out.contains(u) {
            out.push(u.clone());
        }
    }
    out
}

fn point(hash: &str, height: u64, difficulty: u64, time: i64) -> ChainPoint {
    ChainPoint { hash: hash.to_string(), height, difficulty, time }
}

/// Snapshot of a remote node: tip, version and the last `blocks` headers.
pub fn remote_view(url: &str, blocks: u64) -> Result<(NodeView, String)> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).build();
    let tip = call(&agent, url, "get_tip", json!([]))?;
    let version = call(&agent, url, "get_version", json!([]))
        .ok()
        .and_then(|v| v["node_version"].as_str().map(String::from))
        .unwrap_or_default();
    let height = tip["height"].as_u64().unwrap_or(0);
    let hash = tip["last_block_pushed"].as_str().unwrap_or_default().to_string();
    let total_diff = tip["total_difficulty"].as_u64().unwrap_or(0);
    let mut v = NodeView {
        state: "remote".into(),
        synced: true,
        sync_text: "Uzak node".into(),
        sync_percent: Some(100),
        ..Default::default()
    };
    v.tx_pool_size = call(&agent, url, "get_pool_size", json!([]))
        .ok()
        .and_then(|p| p.as_u64())
        .unwrap_or(0) as usize;

    let heights: Vec<u64> = (height.saturating_sub(blocks)..=height).rev().collect();
    let headers: Vec<Option<Value>> = std::thread::scope(|s| {
        let hs: Vec<_> = heights
            .iter()
            .map(|&h| {
                let agent = agent.clone();
                s.spawn(move || call(&agent, url, "get_header", json!([h, null, null])).ok())
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap_or(None)).collect()
    });
    let mut prev: Option<(u64, u64)> = None; // (time, total_difficulty) of the block above
    let mut out = Vec::new();
    let mut tip_time = 0i64;
    for (h, hd) in heights.iter().zip(headers) {
        let Some(hd) = hd else { break };
        let time = parse_time(hd["timestamp"].as_str().unwrap_or_default());
        let td = hd["total_difficulty"].as_u64().unwrap_or(0);
        if let Some((pt, ptd)) = prev {
            if let Some(last) = out.last_mut() {
                let b: &mut BlockView = last;
                b.duration = pt.saturating_sub(time);
                b.difficulty = ptd.saturating_sub(td);
            }
        }
        if *h == height {
            tip_time = time as i64;
        }
        out.push(BlockView {
            height: *h as i64,
            hash: hd["hash"].as_str().unwrap_or_default().into(),
            time,
            ..Default::default()
        });
        prev = Some((time, td));
    }
    out.pop(); // the oldest one has no duration/difficulty
    let durations: Vec<u64> = out.iter().map(|b| b.duration).collect();
    if !durations.is_empty() {
        v.average_block_time = durations.iter().sum::<u64>() / durations.len() as u64;
        v.average_difficulty = out.iter().map(|b| b.difficulty).sum::<u64>() / out.len() as u64;
    }
    v.blocks = out;
    // A public node only reports its chain head; a node that serves a tip is in sync with itself.
    v.header = point(&hash, height, total_diff, tip_time);
    v.block = v.header.clone();
    Ok((v, version))
}
