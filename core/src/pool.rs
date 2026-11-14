//! A node client that spreads one wallet over several nodes and fails over on its own.
//!
//! Public Grin nodes sometimes answer a request with a cut-off or non-JSON body (seen on
//! 2026-11-14 on grinnode.live and main.gri.mw: "Cannot parse response: error decoding response
//! body"). grin-wallet's own client gives up on the first such error, which aborted a mainnet
//! restore scan 25 minutes in. Here every call is retried on the next node of the pool, so a bad
//! answer from one node never reaches the wallet.

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use grin_core::core::{Transaction, TxKernel};
use grin_util::secp::pedersen;
use grin_wallet_impls::HTTPNodeClient;
use grin_wallet_libwallet::{Error, NodeClient, NodeVersionInfo};

use crate::tor::glog;

struct Pool {
    urls: Vec<String>,
    clients: Vec<HTTPNodeClient>,
    current: AtomicUsize,
    failovers: AtomicUsize,
    version: Mutex<Option<NodeVersionInfo>>,
}

/// Wallet node client over an ordered list of nodes (the first is preferred).
#[derive(Clone)]
pub struct PoolNodeClient {
    pool: Arc<Pool>,
}

impl PoolNodeClient {
    pub fn new(urls: &[String], timeout: Duration) -> Result<Self, Error> {
        if urls.is_empty() {
            return Err(Error::GenericError("no node configured".into()));
        }
        let clients = urls
            .iter()
            .map(|u| HTTPNodeClient::new(u, None, timeout))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(PoolNodeClient {
            pool: Arc::new(Pool {
                urls: urls.to_vec(),
                clients,
                current: AtomicUsize::new(0),
                failovers: AtomicUsize::new(0),
                version: Mutex::new(None),
            }),
        })
    }

    /// The node answering right now.
    pub fn current_url(&self) -> String {
        self.pool.urls[self.pool.current.load(Ordering::Relaxed)].clone()
    }

    /// Make `url` the node that answers now (it still fails over as usual). False if it is not in the pool.
    pub fn prefer(&self, url: &str) -> bool {
        match self.pool.urls.iter().position(|u| u == url) {
            Some(i) => {
                self.pool.current.store(i, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// How many times the pool had to switch to another node.
    pub fn failovers(&self) -> usize {
        self.pool.failovers.load(Ordering::Relaxed)
    }

    /// Run `f` on the current node; on error try the next ones, two rounds over the whole pool
    /// (a short pause between rounds, so a single node still gets one retry).
    fn run<T>(&self, what: &str, f: impl Fn(&HTTPNodeClient) -> Result<T, Error>) -> Result<T, Error> {
        let n = self.pool.urls.len();
        let start = self.pool.current.load(Ordering::Relaxed);
        let mut last = None;
        for attempt in 0..n * 2 {
            let idx = (start + attempt) % n;
            match f(&self.pool.clients[idx]) {
                Ok(v) => {
                    if idx != start {
                        self.pool.current.store(idx, Ordering::Relaxed);
                        self.pool.failovers.fetch_add(1, Ordering::Relaxed);
                        glog(
                            log::Level::Warn,
                            &format!("node pool: switched to {} after errors on {}", self.pool.urls[idx], self.pool.urls[start]),
                        );
                    }
                    return Ok(v);
                }
                Err(e) => {
                    glog(log::Level::Warn, &format!("node pool: {} failed on {}: {}", self.pool.urls[idx], what, e));
                    last = Some(e);
                    if (attempt + 1) % n == 0 && attempt + 1 < n * 2 {
                        std::thread::sleep(Duration::from_millis(1500));
                    }
                }
            }
        }
        Err(last.unwrap())
    }
}

/// A node that says "already known" for a transaction another node of ours just accepted.
fn is_duplicate(e: &Error) -> bool {
    let s = e.to_string().to_lowercase();
    s.contains("already") || s.contains("duplicate")
}

impl NodeClient for PoolNodeClient {
    fn node_url(&self) -> &str {
        &self.pool.urls[self.pool.current.load(Ordering::Relaxed)]
    }

    fn set_node_url(&mut self, _node_url: &str) {
        // The pool is fixed when the wallet opens.
    }

    fn node_api_secret(&self) -> Option<String> {
        None
    }

    fn set_node_api_secret(&mut self, _node_api_secret: Option<String>) {}

    fn post_tx(&self, tx: &Transaction, fluff: bool) -> Result<(), Error> {
        let tried = Cell::new(false);
        self.run("post_tx", |c| match c.post_tx(tx, fluff) {
            Err(e) if tried.get() && is_duplicate(&e) => Ok(()),
            r => {
                tried.set(true);
                r
            }
        })
    }

    fn get_version_info(&mut self) -> Option<NodeVersionInfo> {
        let r = self.run("get_version_info", |c| {
            let mut c = c.clone();
            c.get_version_info().ok_or_else(|| Error::GenericError("no version info".into()))
        });
        match r {
            Ok(v) => {
                *self.pool.version.lock().unwrap() = Some(v.clone());
                Some(v)
            }
            Err(_) => self.pool.version.lock().unwrap().clone(),
        }
    }

    fn get_chain_tip(&self) -> Result<(u64, String), Error> {
        self.run("get_chain_tip", |c| c.get_chain_tip())
    }

    fn get_kernel(
        &mut self,
        excess: &pedersen::Commitment,
        min_height: Option<u64>,
        max_height: Option<u64>,
    ) -> Result<Option<(TxKernel, u64, u64)>, Error> {
        self.run("get_kernel", |c| {
            let mut c = c.clone();
            c.get_kernel(excess, min_height, max_height)
        })
    }

    fn get_outputs_from_node(
        &self,
        wallet_outputs: Vec<pedersen::Commitment>,
    ) -> Result<HashMap<pedersen::Commitment, (String, u64, u64)>, Error> {
        self.run("get_outputs_from_node", |c| c.get_outputs_from_node(wallet_outputs.clone()))
    }

    fn get_outputs_by_pmmr_index(
        &self,
        start_height: u64,
        end_height: Option<u64>,
        max_outputs: u64,
    ) -> Result<(u64, u64, Vec<(pedersen::Commitment, pedersen::RangeProof, bool, u64, u64)>), Error> {
        // Big answers (outputs with range proofs, ~1.4 KB each) are what public nodes cut off or the
        // client fails to decode. Ask for small batches and go smaller after each failure; the
        // wallet's scan loop continues from `last_retrieved_index`, so fewer outputs per call is fine.
        let attempt = Cell::new(0usize);
        self.run("get_outputs_by_pmmr_index", |c| {
            let sizes = [250u64, 100, 40, 15];
            let n = sizes[attempt.get().min(sizes.len() - 1)].min(max_outputs.max(1));
            attempt.set(attempt.get() + 1);
            c.get_outputs_by_pmmr_index(start_height, end_height, n)
        })
    }

    fn height_range_to_pmmr_indices(
        &self,
        start_height: u64,
        end_height: Option<u64>,
    ) -> Result<(u64, u64), Error> {
        self.run("height_range_to_pmmr_indices", |c| {
            c.height_range_to_pmmr_indices(start_height, end_height)
        })
    }
}
