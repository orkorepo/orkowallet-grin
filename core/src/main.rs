//! `orko-grin` test CLI over the wallet core. Not the product UI; used to prove each flow
//! (including Tor both ways) against real grin-wallet before the desktop app is built on top.
//!
//!   orko-grin --dir D --net usernet --node http://127.0.0.1:23413 --port 23435 -p PASS <command>
//!   commands: create [--words "..."] | address | balance | txs | scan | listen
//!             send <amount> [<grin1 address>] | process <slatepack file> | cancel <slate id>
//!             ping <grin1 address>
//!
//! `listen` keeps one process alive, like the desktop app: the listener and every later send share
//! the same in-process Tor client. While it runs, write a command line (e.g. `send 5 tgrin1...`)
//! into <dir>/cmd.txt; the result is appended to <dir>/cmd.out.

use std::fmt::Write as _;

use anyhow::{bail, Context, Result};
use orko_grin_core::{
    amount_from_hr_string, amount_to_hr_string, Network, ProcessOutcome, ReceiveOutcome,
    SendOutcome, Settings, TorMode, Wallet,
};
use orko_grin_core::tor::TorBundle;

fn main() -> Result<()> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut take = |flag: &str| -> Option<String> {
        let i = args.iter().position(|a| a == flag)?;
        args.remove(i);
        (i < args.len()).then(|| args.remove(i))
    };
    let dir = take("--dir").context("--dir is required")?;
    let net = Network::parse(&take("--net").unwrap_or("testnet".into()))?;
    // --node may be repeated: the wallet fails over from one to the next.
    let mut nodes = Vec::new();
    while let Some(n) = take("--node") {
        nodes.push(n);
    }
    if nodes.is_empty() {
        nodes.push("http://127.0.0.1:13413".into());
    }
    let port: u16 = take("--port").unwrap_or("3415".into()).parse()?;
    let pass = take("-p").context("-p password is required")?;
    let words = take("--words");
    let mut bridges = Vec::new();
    while let Some(b) = take("--bridge") {
        bridges.push(b);
    }
    let tor = match take("--tor").as_deref() {
        Some("arti") => TorMode::Integrated,
        _ => TorMode::Bundled(TorBundle {
            dir: take("--tor-bundle")
                .unwrap_or_else(|| {
                    concat!(env!("CARGO_MANIFEST_DIR"), "/../vendor/tor-16.0.1").into()
                })
                .into(),
        }),
    };
    let log_level = take("--log").unwrap_or("Warning".into());

    let mut log = grin_util::logger::LoggingConfig::default();
    log.stdout_log_level = match log_level.as_str() {
        "Info" => log::Level::Info,
        "Debug" => log::Level::Debug,
        _ => log::Level::Warn,
    };
    log.log_file_path = format!("{dir}/orko-grin.log");
    log.log_to_file = true;
    log.file_log_level = log::Level::Info;
    std::fs::create_dir_all(&dir)?;
    grin_util::init_logger(Some(log), None);

    let settings = Settings {
        dir: dir.clone().into(),
        network: net,
        nodes,
        listen_port: port,
        tor,
        bridges,
    };
    let cmd = args.first().cloned().unwrap_or_default();

    let mut w = if cmd == "create" {
        let (w, phrase) = Wallet::create(settings, &pass, words.as_deref(), 24)?;
        println!("recovery phrase: {}", &*phrase);
        w
    } else {
        Wallet::open(settings, &pass)?
    };

    if cmd == "listen" {
        let (sp, onion) = w.address()?;
        w.start_listener()?;
        println!("listening: {sp}\n           {onion}  (Ctrl+C to stop)");
        let cmd_file = std::path::Path::new(&dir).join("cmd.txt");
        let out_file = std::path::Path::new(&dir).join("cmd.out");
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let Ok(line) = std::fs::read_to_string(&cmd_file) else { continue };
            let _ = std::fs::remove_file(&cmd_file);
            let parts: Vec<String> = line.split_whitespace().map(String::from).collect();
            let t = std::time::Instant::now();
            let res = run(&mut w, &parts).unwrap_or_else(|e| format!("ERROR: {e:#}\n"));
            let entry = format!("> {} ({}s)\n{res}", line.trim(), t.elapsed().as_secs());
            print!("{entry}");
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&out_file)?;
            f.write_all(entry.as_bytes())?;
        }
    }
    print!("{}", run(&mut w, &args)?);
    Ok(())
}

fn run(w: &mut Wallet, args: &[String]) -> Result<String> {
    let mut out = String::new();
    match args.first().map(|s| s.as_str()).unwrap_or_default() {
        "create" | "address" => {
            let (sp, onion) = w.address()?;
            writeln!(out, "slatepack: {sp}\nonion:     {onion}")?;
        }
        "balance" => {
            let (fresh, i) = w.balance(1)?;
            writeln!(
                out,
                "spendable {} | awaiting confirmation {} | locked {} | height {}{}",
                amount_to_hr_string(i.amount_currently_spendable, false),
                amount_to_hr_string(i.amount_awaiting_confirmation, false),
                amount_to_hr_string(i.amount_locked, false),
                i.last_confirmed_height,
                if fresh { "" } else { " (node unreachable, cached)" }
            )?;
        }
        "txs" => {
            for t in w.transactions(true)? {
                writeln!(
                    out,
                    "#{} {:?} confirmed={} +{} -{} slate={}",
                    t.id,
                    t.tx_type,
                    t.confirmed,
                    amount_to_hr_string(t.amount_credited, false),
                    amount_to_hr_string(t.amount_debited, false),
                    t.tx_slate_id.map(|u| u.to_string()).unwrap_or_default()
                )?;
            }
        }
        "scan" => {
            w.scan(args.get(1).is_some_and(|a| a == "-d"))?;
            writeln!(out, "scan done")?;
        }
        "send" => {
            let amount = amount_from_hr_string(args.get(1).context("amount missing")?)?;
            match w.send(amount, args.get(2).map(|s| s.as_str()), 1, &orko_grin_core::SendOptions::default())? {
                SendOutcome::PostedOverTor { tx_slate_id } => {
                    writeln!(out, "SENT over Tor, posted. slate {tx_slate_id}")?
                }
                SendOutcome::Unreached { tx_slate_id, error, .. } => {
                    let _ = w.cancel(&tx_slate_id);
                    writeln!(out, "FAILED: recipient not reached ({error}); transaction cancelled")?
                }
                SendOutcome::Slatepack { tx_slate_id, message, tor_error } => {
                    if let Some(e) = tor_error {
                        writeln!(out, "Tor delivery failed: {e}")?;
                    }
                    writeln!(out, "slate {tx_slate_id}\n{message}")?;
                }
            }
        }
        "process" => {
            let text = std::fs::read_to_string(args.get(1).context("slatepack file missing")?)?;
            let (outcome, pending) = w.process_slatepack(&text)?;
            if let Some(p) = pending {
                let _ = w.finish_return(p);
            }
            match outcome {
                ProcessOutcome::Received(ReceiveOutcome::ReturnedOverTor) => {
                    writeln!(out, "RECEIVED, returned to sender over Tor")?
                }
                ProcessOutcome::Received(ReceiveOutcome::Slatepack(m)) => {
                    writeln!(out, "RECEIVED, give this back to the sender:\n{m}")?
                }
                ProcessOutcome::Finalized { tx_slate_id } => {
                    writeln!(out, "FINALIZED and posted. slate {tx_slate_id}")?
                }
            }
        }
        "tor" => {
            writeln!(out, "tor: {:?}", w.tor_status())?;
        }
        "ping" => {
            let t = std::time::Instant::now();
            let r = w.ping(args.get(1).context("address missing")?, 60);
            writeln!(out, "ping: {:?} in {}s", r.map_err(|e| e.to_string()), t.elapsed().as_secs())?;
        }
        "cancel" => {
            w.cancel(args.get(1).context("slate id missing")?)?;
            writeln!(out, "cancelled")?;
        }
        other => bail!("unknown command '{other}'"),
    }
    Ok(out)
}
