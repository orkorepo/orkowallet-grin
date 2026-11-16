// OrkoWallet – Grin: UI logic. All wallet/node work happens in Rust; this file renders and calls.
// Text goes through t() (see i18n.js); text that comes back from Rust is passed through E().
'use strict';

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const $ = (id) => document.getElementById(id);
const E = (x) => t(String(x)); // an error / message that came from Rust
const NET_LABEL = () => ({ mainnet: t('Ana ağ'), testnet: t('Test ağı'), usernet: t('Yerel test ağı') });
const ONION_SPREAD_SECS = 150; // a fresh onion needs ~2 min to be findable

const state = {
  status: null, overview: null, tor: null, open: null,
  pendingSlate: null, unlockId: null, formMode: 'create', createdWords: [], txCache: [],
};

// ------------------------------------------------------------------ helpers
function show(screen) {
  document.querySelectorAll('[data-screen]').forEach((s) => { s.hidden = s.dataset.screen !== screen; });
}

async function busy(btn, fn) {
  btn.disabled = true; btn.setAttribute('aria-busy', 'true');
  try { return await fn(); } finally { btn.disabled = false; btn.removeAttribute('aria-busy'); }
}

function err(el, msg) { $(el).textContent = msg ? String(msg) : ''; }

let toastTimer;
function toast(text) {
  const el = $('toast'); el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(t('Kopyalandı')); }
  catch { toast(t('Kopyalanamadı; metni seçip Ctrl+C ile kopyala')); }
}

function applyTheme(theme) {
  const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

const fmtNum = (n) => (n || n === 0 ? Number(n).toLocaleString(I18N.locale) : '–');
function fmtDate(secs) {
  if (!secs) return '';
  return new Date(secs * 1000).toLocaleString(I18N.locale, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtTime(secs) {
  if (!secs) return '–';
  return new Date(secs * 1000).toLocaleString(I18N.locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function ago(secs) {
  if (!secs) return '';
  const d = Math.max(0, Math.round(Date.now() / 1000 - secs));
  if (d < 60) return t('{n} sn önce', { n: d });
  if (d < 3600) return t('{n} dk önce', { n: Math.floor(d / 60) });
  if (d < 86400) return t('{n} sa önce', { n: Math.floor(d / 3600) });
  return t('{n} gün önce', { n: Math.floor(d / 86400) });
}
function dur(s) { return s ? (s < 120 ? t('{n} sn', { n: s }) : t('{n} dk', { n: Math.round(s / 60) })) : '–'; }
function bigNum(n) {
  if (!n) return '–';
  const u = [['E', 1e18], ['P', 1e15], ['T', 1e12], ['G', 1e9], ['M', 1e6], ['K', 1e3]].find(([, v]) => n >= v);
  return u ? `${(n / u[1]).toLocaleString(I18N.locale, { maximumFractionDigits: 1 })} ${u[0]}` : fmtNum(n);
}
const shortHash = (h) => (h && h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h || '–');
const amt = (s) => s || '0';
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function closeDialogs() { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); }
function hostOf(u) { try { return new URL(u).host; } catch { return u; } }

// ------------------------------------------------------------------ global clicks
document.addEventListener('click', (e) => {
  const tg = e.target;
  if (tg.closest('[data-close]')) { tg.closest('dialog')?.close(); return; }
  const go = tg.closest('[data-go]'); if (go) { show(go.dataset.go); return; }
  const open = tg.closest('[data-open]'); if (open) { openDialog(open.dataset.open); return; }
  const form = tg.closest('[data-form]'); if (form) { openForm(form.dataset.form); return; }
  const cp = tg.closest('[data-copy]'); if (cp) { copy($(cp.dataset.copy).value); return; }
  const cpt = tg.closest('[data-copy-text]'); if (cpt) { copy($(cpt.dataset.copyText).textContent); return; }
  const qt = tg.closest('[data-qr-toggle]'); if (qt) { const q = $(qt.dataset.qrToggle); q.hidden = !q.hidden; return; }
  const hb = tg.closest('.hashbtn'); if (hb && hb.dataset.hash) { copy(hb.dataset.hash); }
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.status) applyTheme(state.status.settings.theme); });

// ------------------------------------------------------------------ boot
async function boot() {
  state.status = await invoke('status');
  const s = state.status;
  setLanguage(s.settings.language);
  collectStatic(document.body);
  translateStatic();
  applyTheme(s.settings.theme);
  fillAutoLock();
  document.body.classList.remove('loading');
  const chip = $('net-chip');
  chip.hidden = s.network === 'mainnet';
  chip.textContent = NET_LABEL()[s.network] || s.network;
  pollNode();
  setupIdleLock();
  setupWindow();
  if (s.open_wallet) return enterWallet();
  renderWallets();
}

// ------------------------------------------------------------------ wallets list
function connLabel(w) {
  if (w.connection === 'integrated') return t('Kendi node\'u');
  if (w.connection === 'custom') return hostOf(w.custom_url);
  return t('Node havuzu');
}

function hue(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

function renderWallets() {
  const s = state.status;
  ['wallet-label', 'tor-pill', 'btn-lock', 'btn-logout'].forEach((id) => { $(id).hidden = true; });
  $('wl-net').textContent = t('{net} · {n} cüzdan', { net: NET_LABEL()[s.network] || s.network, n: s.wallets.length });
  $('wl-empty').hidden = s.wallets.length > 0;
  const ul = $('wl-list'); ul.replaceChildren();
  s.wallets.forEach((w) => {
    const li = el('li', `wrow${w.id === s.last_wallet ? ' last' : ''}`);
    const av = el('span', 'avatar', (w.name.trim()[0] || '?').toUpperCase()); av.style.setProperty('--h', hue(w.name));
    const mid = el('div', 'wmid'); mid.append(el('div', 'wname', w.name));
    const created = Number(w.created) ? t('Oluşturuldu {date}', { date: fmtDate(Number(w.created)) }) : t('İçe aktarıldı');
    mid.append(el('div', 'wmeta', `${created} · ${connLabel(w)}`));
    li.append(av, mid);
    if (w.id === s.last_wallet && s.wallets.length > 1) li.append(el('span', 'chip', t('Son kullanılan')));
    const b = el('button', 'btn btn-primary', t('Aç')); b.type = 'button';
    b.addEventListener('click', () => askUnlock(w));
    const rm = el('button', 'btn danger-text', t('Sil')); rm.type = 'button'; rm.title = t('Cüzdanı sil');
    rm.addEventListener('click', () => askRemove(w));
    li.append(rm, b); ul.append(li);
  });
  show('wallets');
}
// Delete a wallet from the list without opening it (needed when the password is forgotten): the user
// confirms by ticking the box and typing the wallet's name.
function askRemove(w) {
  state.removeW = w;
  $('wr-text').textContent = t('{name} bu bilgisayardan silinecek. Kurtarma ifaden yanında değilse içindeki para kaybolur. Bu işlem geri alınamaz.', { name: `“${w.name}”` });
  $('wr-ok').checked = false; $('wr-submit').disabled = true; $('wr-name').value = ''; err('wr-error');
  $('dlg-wremove').showModal();
}
$('wr-ok').addEventListener('change', (e) => { $('wr-submit').disabled = !e.target.checked; });
$('wr-form').addEventListener('submit', async (e) => {
  e.preventDefault(); err('wr-error');
  const w = state.removeW; if (!w) return;
  if ($('wr-name').value.trim() !== w.name.trim()) return err('wr-error', t('Cüzdanın adı tutmuyor.'));
  await busy($('wr-submit'), async () => {
    try {
      await invoke('wallet_remove', { id: w.id });
      state.removeW = null; $('dlg-wremove').close();
      state.status = await invoke('status'); renderWallets(); toast(t('Cüzdan silindi'));
    } catch (x) { err('wr-error', E(x)); }
  });
});

function askUnlock(w) {
  state.unlockId = w.id;
  $('ul-title').textContent = t('“{name}” cüzdanını aç', { name: w.name });
  $('ul-pass').value = ''; err('ul-error');
  $('dlg-unlock').showModal(); $('ul-pass').focus();
}

$('ul-form').addEventListener('submit', async (e) => {
  e.preventDefault(); err('ul-error');
  await busy($('ul-submit'), async () => {
    try {
      await invoke('wallet_open', { id: state.unlockId, password: $('ul-pass').value });
      $('ul-pass').value = ''; $('dlg-unlock').close();
      state.status = await invoke('status'); enterWallet();
    } catch (x) { err('ul-error', E(x)); $('ul-pass').select(); }
  });
});

// ------------------------------------------------------------------ create / restore / import
const FORM = {
  create: { title: 'Yeni cüzdan', desc: 'Bu parola cüzdan dosyanı bu bilgisayarda şifreler. Unutursan cüzdanı yalnızca kurtarma ifadesiyle açabilirsin.', submit: 'Oluştur', hint: '' },
  restore: { title: 'Cüzdanı geri yükle', desc: 'grin-wallet, Grim ya da bu uygulamadan aldığın kurtarma ifadesi çalışır; adresin aynı kalır.', submit: 'Geri yükle', hint: 'Geri yüklemeden sonra zincir taranır; uzak node ile birkaç dakika sürebilir.' },
  import: { title: 'Cüzdanı içe aktar', desc: 'grin-wallet ya da Grim cüzdan klasörünü kopyalayarak açar. Parola o cüzdanın mevcut parolasıdır.', submit: 'İçe aktar', hint: '' },
};
function openForm(mode) {
  state.formMode = mode;
  const f = FORM[mode];
  $('wf-title').textContent = t(f.title); $('wf-desc').textContent = t(f.desc);
  $('wf-submit').textContent = t(f.submit); $('wf-hint').textContent = t(f.hint);
  $('wf-words-f').hidden = mode !== 'restore';
  $('wf-since-f').hidden = mode !== 'restore';
  $('wf-len-f').hidden = mode !== 'create'; $('wf-len').value = '24';
  fillSince($('wf-since'), true);
  $('wf-since').value = 'all';
  $('wf-path-f').hidden = mode !== 'import';
  $('wf-pass2-f').hidden = mode === 'import';
  $('wf-pass-l').textContent = mode === 'import' ? t('Cüzdanın parolası') : t('Parola');
  ['wf-name', 'wf-words', 'wf-path', 'wf-pass', 'wf-pass2'].forEach((id) => { $(id).value = ''; });
  $('wf-conn').value = 'auto';
  err('wf-error'); closeDialogs(); show('form'); $('wf-name').focus();
}

/** "Since when" choices for restore / repair: from the start, a year, or (restore only) never. */
function fillSince(select, withNever) {
  select.replaceChildren();
  const opt = (v, text) => { const o = el('option', '', text); o.value = v; select.append(o); };
  opt('all', t('Bilmiyorum / emin değilim: en baştan (en uzun, en güvenli)'));
  if (state.status?.network === 'mainnet') {
    for (let y = new Date().getFullYear(); y >= 2020; y--) opt(String(y), t('{y} veya sonrasında', { y }));
  }
  if (withNever) opt('never', t('Bu cüzdan hiç kullanılmadı (tarama yok)'));
}

$('wf').addEventListener('submit', async (e) => {
  e.preventDefault(); err('wf-error');
  const mode = state.formMode;
  const name = $('wf-name').value.trim() || t('Cüzdan');
  const password = $('wf-pass').value, connection = $('wf-conn').value;
  if (mode !== 'import') {
    if (password.length < 4) return err('wf-error', t('Parola en az 4 karakter olmalı.'));
    if (password !== $('wf-pass2').value) return err('wf-error', t('Parolalar aynı değil.'));
  }
  await busy($('wf-submit'), async () => {
    try {
      if (mode === 'create') {
        state.createdWords = await invoke('wallet_create', { name, password, connection, words: Number($('wf-len').value) || 24 });
        showWords();
      } else if (mode === 'restore') {
        await invoke('wallet_restore', { name, password, words: $('wf-words').value, connection, since: $('wf-since').value });
        state.status = await invoke('status'); enterWallet();
      } else {
        await invoke('wallet_import', { name, path: $('wf-path').value, password, connection });
        state.status = await invoke('status'); enterWallet();
      }
      ['wf-pass', 'wf-pass2', 'wf-words'].forEach((id) => { $(id).value = ''; });
    } catch (x) { err('wf-error', E(x)); }
  });
});

function showWords() {
  invoke('set_protected', { on: true });
  const grid = $('words-grid'); grid.replaceChildren();
  state.createdWords.forEach((w) => grid.append(el('li', '', w)));
  $('words-ok').checked = false; $('words-next').disabled = true;
  $('words-show').hidden = false; $('words-verify').hidden = true;
  show('words');
}
$('words-ok').addEventListener('change', (e) => { $('words-next').disabled = !e.target.checked; });
$('words-next').addEventListener('click', () => {
  const idx = new Set();
  while (idx.size < 3) idx.add(Math.floor(Math.random() * state.createdWords.length));
  const box = $('verify-fields'); box.replaceChildren();
  [...idx].sort((a, b) => a - b).forEach((i) => {
    const l = el('label', 'field', t('{n}. kelime', { n: i + 1 }));
    const inp = el('input', 'mono'); inp.autocomplete = 'off'; inp.spellcheck = false; inp.dataset.idx = i;
    l.append(inp); box.append(l);
  });
  $('words-show').hidden = true; $('words-verify').hidden = false; err('verify-error');
  box.querySelector('input').focus();
});
$('verify-back').addEventListener('click', () => { $('words-verify').hidden = true; $('words-show').hidden = false; });
$('words-verify').addEventListener('submit', async (e) => {
  e.preventDefault(); err('verify-error');
  const bad = [...$('verify-fields').querySelectorAll('input')].filter((i) => i.value.trim().toLowerCase() !== state.createdWords[+i.dataset.idx]);
  bad.forEach((i) => i.setAttribute('aria-invalid', 'true'));
  if (bad.length) return err('verify-error', t('Bazı kelimeler tutmuyor. Kâğıdı kontrol et.'));
  state.createdWords = []; $('words-grid').replaceChildren();
  invoke('set_protected', { on: false });
  state.status = await invoke('status'); enterWallet();
});

// ------------------------------------------------------------------ open wallet
let walletTimers = [];
function enterWallet() {
  state.open = state.status.open_wallet;
  ['wallet-label', 'tor-pill', 'btn-lock', 'btn-logout'].forEach((id) => { $(id).hidden = false; });
  $('ws-name').textContent = state.open.name;
  fillWalletSettings();
  syncTorForm();
  show('wallet');
  selectTab('txs');
  refresh(); pollTor();
  walletTimers.forEach(clearInterval);
  fillSince($('rescan-since'), false);
  pollScan();
  const every = (fn, ms) => setInterval(() => { if (!document.hidden && !locked) fn(); }, ms);
  walletTimers = [every(pollTor, 3000), every(refresh, 30000), every(watchPending, 4000), every(pollScan, 3000), every(pollJobs, 5000)];
}

async function refresh() {
  if (locked) return;
  try {
    const o = await invoke('overview');
    state.overview = o;
    setText($('b-spendable'), amt(o.spendable));
    setText($('b-awaiting'), amt(o.awaiting));
    setText($('b-immature'), amt(o.immature));
    setText($('b-locked'), amt(o.locked));
    setText($('b-total'), amt(o.total));
    tweenNum($('b-height'), o.height);
    $('ws-account').textContent = o.account && o.account !== 'default' ? `· ${o.account}` : '';
    $('tc-addr').textContent = o.address;
    $('tc-onion').textContent = o.onion;
    $('tc-account').textContent = t('Hesap: {name} · her hesabın adresi ayrıdır', { name: o.account || 'default' });
    $('tc-node').textContent = t('Kullanılan node: {url}', { url: hostOf(o.node_in_use) });
    const warn = $('node-warn');
    warn.hidden = o.node_ok;
    warn.textContent = o.connection === 'integrated'
      ? t('Kendi node\'una ulaşılamıyor ya da node henüz senkronize değil; gösterilen bakiye son bilinen değer. Node panelinden node\'u başlat.')
      : t('Node\'a ulaşılamıyor; gösterilen bakiye son bilinen değer.');
  } catch (x) { toast(E(x)); }
  try { renderTxs(await invoke('transactions')); } catch { /* shown via overview */ }
}
$('btn-refresh').addEventListener('click', refresh);
$('tc-copy').addEventListener('click', () => copy($('tc-addr').textContent));
$('tc-onion-copy').addEventListener('click', () => copy($('tc-onion').textContent));
document.querySelector('[data-qr-toggle="tc-qr"]').addEventListener('click', async () => {
  if (state.overview) $('tc-qr').innerHTML = await invoke('address_qr', { text: state.overview.address });
});

// tabs
function selectTab(name) {
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  if (name === 'accounts') loadAccounts();
}
document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

// ------------------------------------------------------------------ lock / log out
let locked = false;
let lastActive = Date.now();
let autoLockMs = 0;

function lockScreen() {
  if (!state.open || locked) return;
  locked = true; closeDialogs();
  invoke('set_locked');
  $('lk-name').textContent = state.open.name;
  $('lk-pass').value = ''; err('lk-error');
  $('lockscreen').hidden = false;
  $('lk-pass').focus();
}
async function logout() {
  toast(t('Cüzdan kapanıyor…'));
  let restarted;
  try { restarted = await invoke('wallet_close'); } catch (x) { toast(E(x)); return; }
  if (!restarted) leaveWallet(); // true: the app restarts itself (a scan or Arti listener was running)
}
/** Back to the wallet list without restarting the app. */
async function leaveWallet() {
  walletTimers.forEach(clearInterval); walletTimers = [];
  locked = false; $('lockscreen').hidden = true; closeDialogs();
  state.open = null; state.overview = null; state.pendingSlate = null;
  state.status = await invoke('status');
  renderWallets();
}$('btn-lock').addEventListener('click', lockScreen);
$('btn-logout').addEventListener('click', logout);
$('lk-logout').addEventListener('click', logout);
$('lk-form').addEventListener('submit', async (e) => {
  e.preventDefault(); err('lk-error');
  await busy($('lk-submit'), async () => {
    try {
      await invoke('verify_password', { password: $('lk-pass').value });
      $('lk-pass').value = ''; $('lockscreen').hidden = true; locked = false; lastActive = Date.now();
    } catch (x) { err('lk-error', E(x)); $('lk-pass').select(); }
  });
});

function setupIdleLock() {
  autoLockMs = (state.status.settings.auto_lock_minutes || 0) * 60000;
  const bump = () => { lastActive = Date.now(); };
  ['pointerdown', 'keydown', 'wheel', 'pointermove'].forEach((ev) => window.addEventListener(ev, bump, { passive: true }));
  setInterval(() => {
    if (autoLockMs > 0 && state.open && !locked && Date.now() - lastActive > autoLockMs) lockScreen();
  }, 10000);
}

function fillAutoLock() {
  const sel = $('set-autolock'); sel.replaceChildren();
  const opt = (v, text) => { const o = el('option', '', text); o.value = String(v); sel.append(o); };
  opt(0, t('Kapalı')); opt(1, t('1 dakika'));
  [5, 10, 15, 30].forEach((n) => opt(n, t('{n} dakika', { n })));
  opt(60, t('1 saat'));
}

// ------------------------------------------------------------------ transactions
const ICON_IN = '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const ICON_OUT ='<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Payments waiting for an offline recipient (retried every minute), by transaction id.
state.jobs = {};
async function pollJobs() {
  let list;
  try { list = await invoke('send_jobs'); } catch { return; }
  const next = {};
  list.forEach((j) => { j.eta = Date.now() + j.next_in * 1000; next[j.slate_id] = j; });
  let changed = false;
  for (const j of list) {
    const was = state.jobs[j.slate_id];
    if (j.state === 'retrying' && was && was.attempts !== j.attempts) changed = true;
    if (was && was.state === 'retrying' && j.state !== 'retrying') {
      changed = true;
      if (j.state === 'done') toast(t('Alıcı çevrimiçi oldu, ödeme gönderildi'));
      else if (j.state === 'failed') toast(t('Gönderim başarısız: alıcıya ulaşılamadı. Tutar serbest bırakıldı.'));
    }
  }
  state.jobs = next;
  if (changed) refresh();
  else if (list.some((j) => j.state === 'retrying')) renderTxs();
}

function txTitle(x) {
  const job = state.jobs[x.slate_id];
  if (x.cancelled && job && job.state === 'failed') return t('Gönderim başarısız');
  if (x.cancelled) return x.incoming ? t('Alma iptal edildi') : t('Gönderim iptal edildi');
  if (x.kind === 'ConfirmedCoinbase') return t('Madencilik ödülü');
  return x.incoming ? t('Alındı') : t('Gönderildi');
}
function txStatus(x) {
  if (x.cancelled) return t('İptal edildi');
  if (x.confirmed) return t('Onaylandı');
  if (x.finalized || x.incoming) return t('Zincirde onay bekliyor');
  return t('Alıcının yanıtı bekleniyor (tutar kilitli)');
}

// Transaction list: filter chips + pages (page size is remembered).
// Rows per page = how many rows fit the card (measured), so it follows the window size.
const txView = { filter: 'all', page: 0, size: 1 };
const TX_FILTERS = {
  all: () => true,
  in: (x) => x.incoming && !x.cancelled,
  out: (x) => !x.incoming && !x.cancelled,
  pending: (x) => !x.confirmed && !x.cancelled,
};

let txSig = '';
const txSeen = new Set();
let txInit = false;
const txKey = (x) => x.slate_id || `id${x.id}`;
function renderTxs(list, measured) {
  if (list) state.txCache = list;
  const all = state.txCache;
  const rows = all.map((x, i) => ({ x, i })).filter((r) => TX_FILTERS[txView.filter](r.x));
  const pages = Math.max(1, Math.ceil(rows.length / txView.size));
  txView.page = Math.min(txView.page, pages - 1);
  const slice = rows.slice(txView.page * txView.size, (txView.page + 1) * txView.size);
  // Nothing visible changed (the usual case on a refresh): leave the DOM alone, so there is no flicker
  // and no work. The retry countdown is not part of this: it runs on the 1 s timer.
  const sig = JSON.stringify([txView.filter, txView.page, txView.size, rows.length, I18N.lang,
    slice.map(({ x }) => { const j = state.jobs[x.slate_id]; return [x.slate_id, x.id, x.amount, x.confirmed, x.cancelled, x.finalized, j ? `${j.state}${j.attempts}` : '']; })]);
  if (sig === txSig) return;
  txSig = sig;
  const ul = $('tx-list'); ul.replaceChildren();
  $('tx-empty').hidden = rows.length > 0;
  $('tx-count').textContent = all.length ? t('{n} işlem', { n: rows.length }) : '';
  slice.forEach(({ x, i }) => {
    const li = el('li');
    const fresh = txInit && !txSeen.has(txKey(x));
    const b = el('button', `tx ${x.incoming ? 'in' : 'out'}${x.cancelled ? ' cancelled' : ''}`);
    b.type = 'button'; b.dataset.i = i;
    const ico = el('span', 'tx-ico'); ico.innerHTML = x.cancelled ? ICON_X : x.incoming ? ICON_IN : ICON_OUT;
    const mid = el('span');
    const title = el('div', 'tx-title', txTitle(x));
    const job = state.jobs[x.slate_id];
    if (!x.confirmed && !x.cancelled) {
      title.append(el('span', 'badge pending', job && job.state === 'retrying'
        ? t('Alıcı aranıyor {a}/{b}', { a: job.attempts, b: job.max_attempts })
        : x.finalized || x.incoming ? t('Onay bekliyor') : t('Yanıt bekliyor')));
    }
    const meta = el('div', 'tx-meta', fmtDate(x.time));
    if (job && job.state === 'retrying') {
      const eta = el('span'); eta.dataset.eta = String(job.eta);
      eta.textContent = t('sonraki deneme {n} sn', { n: Math.max(0, Math.round((job.eta - Date.now()) / 1000)) });
      meta.append(' · ', eta);
    }
    mid.append(title, meta);
    b.append(ico, mid, el('span', 'tx-amt', `${x.incoming ? '+' : '−'}${amt(x.amount)} ツ`));
    li.append(b); ul.append(li);
    if (fresh) replay(li, 'enter'); // a transaction that just appeared slides in
  });
  all.forEach((x) => txSeen.add(txKey(x)));
  if (all.length) txInit = true;
  renderPager(rows.length, pages);
  // Measure one row, work out how many fit the card, and draw again once if that differs.
  if (!measured && slice.length) {
    const rh = ul.firstElementChild.offsetHeight;
    const fit = rh && ul.clientHeight ? Math.max(2, Math.floor(ul.clientHeight / (rh + 1))) : txView.size;
    if (fit !== txView.size) {
      const first = txView.page * txView.size;
      txView.size = fit; txView.page = Math.floor(first / fit);
      renderTxs(null, true);
    }
  }
}
let txResize;
window.addEventListener('resize', () => { clearTimeout(txResize); txResize = setTimeout(() => { txView.size = 1; txSig = ''; renderTxs(); }, 120); });

function renderPager(total, pages) {
  const pager = $('tx-pager');
  pager.hidden = total === 0;
  if (!total) return;
  const from = txView.page * txView.size + 1;
  $('tx-range').textContent = `${from}–${Math.min(total, from + txView.size - 1)} / ${total}`;
  const box = $('tx-pages'); box.replaceChildren();
  const go = (p) => { txView.page = p; renderTxs(); };
  const btn = (label, p, opts = {}) => {
    const b = el('button', `pg${opts.on ? ' on' : ''}`, label); b.type = 'button'; b.disabled = !!opts.off;
    if (opts.aria) b.setAttribute('aria-label', opts.aria);
    if (opts.on) b.setAttribute('aria-current', 'page');
    b.addEventListener('click', () => go(p)); box.append(b);
  };
  btn('‹', txView.page - 1, { off: txView.page === 0, aria: t('Önceki sayfa') });
  // 1 … c-1 c c+1 … last
  const want = new Set([0, pages - 1, txView.page - 1, txView.page, txView.page + 1]);
  let prev = -1;
  [...want].filter((p) => p >= 0 && p < pages).sort((p, q) => p - q).forEach((p) => {
    if (prev >= 0 && p - prev > 1) box.append(el('span', 'pg-gap', '…'));
    btn(String(p + 1), p, { on: p === txView.page });
    prev = p;
  });
  btn('›', txView.page + 1, { off: txView.page >= pages - 1, aria: t('Sonraki sayfa') });
}

$('tx-filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]'); if (!b) return;
  txView.filter = b.dataset.f; txView.page = 0;
  document.querySelectorAll('#tx-filters [data-f]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  renderTxs();
});
let txOpen = null;
$('tx-list').addEventListener('click', (e) => {
  const b = e.target.closest('.tx'); if (!b) return;
  const x = state.txCache[+b.dataset.i]; txOpen = x;
  const kv = $('tx-kv'); kv.replaceChildren();
  const add = (k, v) => { if (!v && v !== 0) return; kv.append(el('dt', '', t(k)), el('dd', '', String(v))); };
  add('Durum', txStatus(x));
  add('Tutar', `${x.incoming ? '+' : '−'}${amt(x.amount)} ツ`);
  if (!x.incoming && x.fee) add('Ağ ücreti', `${x.fee} ツ`);
  add('Oluşturuldu', fmtDate(x.time));
  if (x.confirmed_time) add('Onaylandı', fmtDate(x.confirmed_time));
  add('Girdi / çıktı', `${x.inputs} / ${x.outputs}`);
  if (x.ttl_height) add('Geçerlilik (blok)', fmtNum(x.ttl_height));
  add('İşlem kimliği', x.slate_id);
  add('Kernel', x.kernel);
  add('Yerel no', x.id);
  $('tx-title').textContent = txTitle(x);
  $('tx-proof-box').hidden = true;
  $('tx-proof-btn').hidden = !(x.has_proof && !x.incoming);
  $('tx-repost').hidden = !(x.finalized && !x.confirmed && !x.cancelled && x.has_stored_tx);
  $('tx-cancel').hidden = x.confirmed || x.cancelled || !x.slate_id;
  err('tx-error');
  showTxSlatepack(x);
  $('dlg-tx').showModal();
});

// An unfinished Slatepack exchange can be continued from the transaction: the text to hand over is shown
// again, and for our own payment there is a box for the recipient's reply.
async function showTxSlatepack(x) {
  const open = txOpen;
  ['tx-sp', 'tx-sp-saved', 'tx-sp-reply'].forEach((id) => { $(id).hidden = true; });
  $('tx-sp-in').value = ''; err('tx-sp-error'); $('tx-sp-qr').hidden = true;
  if (x.confirmed || x.cancelled || !x.slate_id) return;
  const awaitingReply = !x.incoming && !x.finalized;   // our payment, the recipient has not answered yet
  const awaitingSender = x.incoming && !x.finalized;   // we signed, the sender still has to finish it
  if (!awaitingReply && !awaitingSender) return;
  let saved = null;
  try { saved = await invoke('saved_slatepack', { slateId: x.slate_id }); } catch { /* optional */ }
  if (txOpen !== open) return;
  if (saved) {
    $('tx-sp-out').value = saved.message; $('tx-sp-qr').innerHTML = saved.qr;
    $('tx-sp-saved-l').textContent = t(awaitingReply ? 'Alıcıya ilettiğin Slatepack metni' : 'Gönderene vereceğin yanıt');
    $('tx-sp-saved').hidden = false;
  }
  $('tx-sp-reply').hidden = !awaitingReply;
  $('tx-sp').hidden = !(saved || awaitingReply);
}
$('tx-sp-finalize').addEventListener('click', async () => {
  err('tx-sp-error');
  const text = $('tx-sp-in').value.trim();
  if (!text) return err('tx-sp-error', t('Alıcının yanıtını yapıştır.'));
  await busy($('tx-sp-finalize'), async () => {
    try {
      const r = await invoke('process_slatepack', { text });
      if (r.kind !== 'finalized') return err('tx-sp-error', t('Bu metin bu gönderimin yanıtı değil.'));
      $('dlg-tx').close(); toast(t('İşlem tamamlandı ve zincire iletildi.')); refresh();
    } catch (x) { err('tx-sp-error', E(x)); }
  });
});
$('tx-proof-btn').addEventListener('click', async (e) => {
  await busy(e.currentTarget, async () => {
    try { $('tx-proof').value = await invoke('payment_proof', { slateId: txOpen.slate_id }); $('tx-proof-box').hidden = false; }
    catch (x) { err('tx-error', E(x)); }
  });
});
$('tx-repost').addEventListener('click', async (e) => {
  await busy(e.currentTarget, async () => {
    try { await invoke('repost', { slateId: txOpen.slate_id }); toast(t('Yeniden yayınlandı')); }
    catch (x) { err('tx-error', E(x)); }
  });
});
$('tx-cancel').addEventListener('click', async (e) => {
  await busy(e.currentTarget, async () => {
    try { await invoke('cancel_tx', { slateId: txOpen.slate_id }); $('dlg-tx').close(); toast(t('İşlem iptal edildi')); refresh(); }
    catch (x) { err('tx-error', E(x)); }
  });
});

// ------------------------------------------------------------------ accounts
async function loadAccounts() {
  err('acc-error');
  try {
    const list = await invoke('accounts');
    const ul = $('acc-list'); ul.replaceChildren();
    list.forEach((a) => {
      const li = el('li');
      const left = el('div');
      const name = el('div', 'tx-title', a.label);
      if (a.active) name.append(el('span', 'badge active', t('Etkin')));
      left.append(name, el('div', 'p', a.path));
      li.append(left);
      if (!a.active) {
        const b = el('button', 'btn btn-sm', t('Etkinleştir')); b.type = 'button';
        b.addEventListener('click', () => busy(b, async () => {
          try { await invoke('account_set', { label: a.label }); toast(t('“{name}” hesabı etkin; Tor adresi değişti', { name: a.label })); loadAccounts(); refresh(); }
          catch (x) { err('acc-error', E(x)); }
        }));
        li.append(b);
      }
      ul.append(li);
    });
  } catch (x) { err('acc-error', E(x)); }
}
$('acc-form').addEventListener('submit', async (e) => {
  e.preventDefault(); err('acc-error');
  const label = $('acc-name').value.trim();
  if (!label) return err('acc-error', t('Hesap adı yaz.'));
  try { await invoke('account_create', { label }); $('acc-name').value = ''; loadAccounts(); }
  catch (x) { err('acc-error', E(x)); }
});

// ------------------------------------------------------------------ wallet settings
async function fillNodeDatalist() {
  try {
    const list = await invoke('nodes_list');
    const dl = $('node-datalist'); dl.replaceChildren();
    list.forEach((n) => { const o = el('option'); o.value = n.url; dl.append(o); });
  } catch { /* optional */ }
}
function fillWalletSettings() {
  const w = state.open;
  const conn = w.connection === 'integrated' ? 'integrated' : w.connection === 'custom' ? 'custom' : 'auto';
  $('ws-f-name').value = w.name;
  $('ws-f-conn').value = conn;
  $('ws-f-url').value = w.custom_url;
  $('ws-f-url-f').hidden = conn !== 'custom';
  $('ws-note').hidden = true; err('ws-error');
  fillNodeDatalist();
}
$('ws-f-conn').addEventListener('change', () => { $('ws-f-url-f').hidden = $('ws-f-conn').value !== 'custom'; });
$('ws-form').addEventListener('submit', async (e) => {
  e.preventDefault(); err('ws-error');
  try {
    const reconnect = await invoke('wallet_update', {
      id: state.open.id, name: $('ws-f-name').value, connection: $('ws-f-conn').value,
      customUrl: $('ws-f-url').value,
    });
    state.status = await invoke('status'); state.open = state.status.open_wallet;
    $('ws-name').textContent = state.open.name;
    if (reconnect) {
      const note = $('ws-note'); note.hidden = false; note.textContent = `${t('Kaydedildi. Yeni node bağlantısı cüzdan yeniden açılınca geçerli olur.')} `;
      const b = el('button', 'link', t('Şimdi kapat')); b.type = 'button'; b.addEventListener('click', logout); note.append(b);
    } else toast(t('Kaydedildi'));
    refresh();
  } catch (x) { err('ws-error', E(x)); }
});
$('btn-rescan').addEventListener('click', async (e) => {
  await busy(e.currentTarget, async () => {
    try { await invoke('rescan', { since: $('rescan-since').value }); toast(t('Tarama başladı; ilerlemesi bakiye kartında')); pollScan(); }
    catch (x) { toast(E(x)); }
  });
});

$('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault(); err('pw-error');
  const n = $('pw-new').value;
  if (n.length < 4) return err('pw-error', t('Yeni parola en az 4 karakter olmalı.'));
  if (n !== $('pw-new2').value) return err('pw-error', t('Yeni parolalar aynı değil.'));
  await busy($('pw-submit'), async () => {
    try { await invoke('change_password', { old: $('pw-old').value, new: n }); $('dlg-password').close(); toast(t('Parola değiştirildi')); }
    catch (x) { err('pw-error', E(x)); }
  });
});

$('ph-form').addEventListener('submit', async (e) => {
  e.preventDefault(); err('ph-error');
  await busy($('ph-submit'), async () => {
    try {
      const words = await invoke('show_phrase', { password: $('ph-pass').value });
      $('ph-pass').value = '';
      invoke('set_protected', { on: true });
      const g = $('ph-words'); g.replaceChildren(); words.forEach((w) => g.append(el('li', '', w)));
      $('ph-ask').hidden = true; g.hidden = false;
    } catch (x) { err('ph-error', E(x)); }
  });
});
$('dlg-phrase').addEventListener('close', () => { invoke('set_protected', { on: false }); $('ph-words').replaceChildren(); $('ph-words').hidden = true; $('ph-ask').hidden = false; });

$('del-ok').addEventListener('change', (e) => { $('del-submit').disabled = !e.target.checked; });
$('del-form').addEventListener('submit', async (e) => {
  e.preventDefault(); err('del-error');
  await busy($('del-submit'), async () => {
    try {
      const restarted = await invoke('wallet_delete', { password: $('del-pass').value });
      if (!restarted) { toast(t('Cüzdan silindi')); leaveWallet(); }
    } catch (x) { err('del-error', E(x)); }
  });
});

// ------------------------------------------------------------------ background chain scan
let scanSeen = 0;
let scanStartedAt = 0;
async function pollScan() {
  let s;
  try { s = await invoke('scan_status'); } catch { return; }
  const banner = $('scan-banner');
  if (s.active) {
    if (!scanStartedAt) scanStartedAt = Date.now();
    const p = Math.max(0, s.progress);
    let eta = '';
    if (p > 2 && p < 100) {
      const left = Math.round(((Date.now() - scanStartedAt) / p) * (100 - p) / 60000);
      eta = left >= 1 ? t(' · yaklaşık {n} dk kaldı', { n: left }) : t(' · az kaldı');
    }
    banner.hidden = false; banner.dataset.state = '';
    $('scan-text').textContent = t('Eski işlemlerin taranıyor: %{p}{eta}. Bu sırada bakiye eksik görünebilir; cüzdanı kullanmaya devam edebilirsin.', { p, eta });
    $('scan-fill').style.width = `${p}%`;
    return;
  }
  scanStartedAt = 0;
  if (s.finished_at && s.finished_at !== scanSeen) {
    scanSeen = s.finished_at;
    if (s.error) {
      banner.hidden = false; banner.dataset.state = 'error';
      $('scan-text').textContent = t('Tarama yarıda kaldı: {e}. Cüzdanı yeniden açınca kaldığı yerden sürer; ya da Cüzdan ayarları > Bakım\'dan yeniden başlat.', { e: E(s.error) });
    } else {
      banner.hidden = true; toast(t('Tarama bitti, bakiye güncel')); refresh();
    }
    return;
  }
  if (!s.error) banner.hidden = true;
}

// ------------------------------------------------------------------ tor
function torView(x) {
  if (!x || x.state === 'off') return { state: 'off', chip: t('Kapalı'), text: t('Tor kapalı'), note: t('Tor kapalı: Tor üzerinden ödeme alınamaz, Slatepack ile alabilirsin.'), progress: false };
  if (x.state === 'failed') return { state: 'failed', chip: t('Hata'), text: t('Tor hatası'), note: t('Tor bağlanamadı. Aşağıdan bir köprü (Snowflake) seçip "Uygula"ya bas.'), progress: false };
  const p = x.overall;
  if (x.reachable) return { state: 'ready', chip: t('Çevrimiçi'), text: t('Tor çevrimiçi'), note: t('Adresin Tor ağında çevrimiçi: ödemeler doğrudan gelebilir.'), progress: true, p: 100, stage: 3 };
  if (x.stage === 1) return { state: 'starting', chip: `${p}%`, text: t('Tor bağlanıyor {p}%', { p }), note: t('Tor ağına bağlanılıyor; birkaç saniye sürer.'), progress: true, p, stage: 1 };
  const slow = Number(x.ready_for) > 150;
  return { state: 'publishing', chip: `${p}%`, text: t('Tor hazır · adres duyuruluyor {p}%', { p }),
    note: slow ? t('Adres uzun süredir ulaşılamıyor. Bilgisayarın saatini eşitle; olmazsa aşağıdan Snowflake köprüsünü seç ve “Uygula”ya bas.') : t('Adresin Tor ağına duyuruluyor. Ulaşılabilir olunca burada "Çevrimiçi" yazar; o zamana kadar gelen ödeme denemeleri başarısız olabilir.'), progress: true, p, stage: 2 };
}
async function pollTor() {
  try { state.tor = await invoke('tor_status'); } catch { return; }
  const v = torView(state.tor);
  $('tor-pill').dataset.state = v.state; $('tor-text').textContent = v.text;
  $('tc-state').dataset.state = v.state; $('tc-state').textContent = v.chip;
  ['tc-note', 'r-tor'].forEach((id) => { $(id).dataset.state = v.state; $(id).textContent = v.note; });
  $('tc-progress').hidden = !v.progress;
  if (v.progress) {
    $('tc-pct').textContent = `${v.p}%`; $('tc-bar-fill').style.width = `${v.p}%`;
    document.querySelectorAll('#tc-steps li').forEach((li) => {
      const n = Number(li.dataset.step);
      li.dataset.s = n < v.stage || (v.stage === 3 && n === 3) ? 'done' : n === v.stage ? 'active' : 'todo';
    });
  }
}$('tor-pill').addEventListener('click', () => $('tc-addr').scrollIntoView({ behavior: 'smooth', block: 'center' }));

function syncTorForm() {
  const s = state.status.settings;
  document.querySelectorAll('input[name="bridges"]').forEach((r) => { r.checked = r.value === s.bridges; });
  $('tor-custom').value = s.custom_bridges; $('tor-engine').value = s.tor;
  $('tor-custom').hidden = s.bridges !== 'custom'; err('tor-error');
}
document.querySelectorAll('input[name="bridges"]').forEach((r) => r.addEventListener('change', () => {
  $('tor-custom').hidden = document.querySelector('input[name="bridges"]:checked').value !== 'custom';
}));
$('tor-apply').addEventListener('click', async (e) => {
  err('tor-error');
  await busy(e.currentTarget, async () => {
    try {
      const reopen = await invoke('tor_apply', {
        bridges: document.querySelector('input[name="bridges"]:checked')?.value || 'none',
        customBridges: $('tor-custom').value, engine: $('tor-engine').value,
      });
      state.status = await invoke('status');
      toast(reopen ? t('Tor motoru cüzdan yeniden açılınca değişecek') : t('Tor yeni ayarlarla yeniden bağlanıyor'));
      pollTor();
    } catch (x) { err('tor-error', E(x)); }
  });
});

// ------------------------------------------------------------------ node panel
// Live feel at almost no cost: ages and counters run off one 1 s client timer (no re-poll needed), whole
// numbers glide to their new value, lists are updated row by row instead of being torn down, and a
// value that changed flashes once. Everything is skipped for "reduce motion" and while the window is hidden.
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
document.addEventListener('animationend', (e) => e.target.classList && e.target.classList.remove('flash', 'pulse', 'enter'));

function replay(node, cls) {
  if (REDUCED) return;
  node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls);
}
/** Set text only when it changed; a changed value flashes. */
function setText(node, text) {
  if (node.textContent === text) return;
  node.textContent = text; replay(node, 'flash');
}
const rafs = new WeakMap();
/** Glide a whole number from what is shown now to `to` (NaN shows a dash). */
function tweenNum(node, to, fmt = fmtNum, ms = 450) {
  if (!Number.isFinite(to)) { cancelAnimationFrame(rafs.get(node)); node.textContent = '–'; delete node.dataset.n; return; }
  const from = Number(node.dataset.n);
  node.dataset.n = String(to);
  if (REDUCED || !Number.isFinite(from) || from === to) { setText(node, fmt(to)); return; }
  cancelAnimationFrame(rafs.get(node));
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms), ease = 1 - (1 - k) ** 3;
    node.textContent = fmt(k < 1 ? Math.round(from + (to - from) * ease) : to);
    if (k < 1) rafs.set(node, requestAnimationFrame(step));
  };
  replay(node, 'flash'); rafs.set(node, requestAnimationFrame(step));
}

function ageShort(secs) {
  const d = Math.max(0, Math.round(Date.now() / 1000 - secs));
  if (d < 60) return t('{n} sn', { n: d });
  if (d < 3600) return t('{n} dk', { n: Math.floor(d / 60) });
  if (d < 86400) return t('{n} sa', { n: Math.floor(d / 3600) });
  return t('{n} gün', { n: Math.floor(d / 86400) });
}
/** The 1 s tick: block ages, "updated N s ago", retry countdowns. Only touches text that changed. */
function tickTimes() {
  document.querySelectorAll('[data-ago]').forEach((e) => {
    const v = e.dataset.fmt === 'long' ? ago(Number(e.dataset.ago)) : ageShort(Number(e.dataset.ago));
    if (e.textContent !== v) e.textContent = v;
  });
  const sy = $('nb-sync');
  if (sy.dataset.since) {
    const v = t('Bağlı · {n} sn önce güncellendi', { n: Math.max(0, Math.round((Date.now() - Number(sy.dataset.since)) / 1000)) });
    if (sy.textContent !== v) sy.textContent = v;
  }
  document.querySelectorAll('[data-eta]').forEach((e) => {
    const v = t('sonraki deneme {n} sn', { n: Math.max(0, Math.round((Number(e.dataset.eta) - Date.now()) / 1000)) });
    if (e.textContent !== v) e.textContent = v;
  });
}
setInterval(() => { if (!document.hidden) tickTimes(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tickTimes(); });

/** Keep `ul` equal to `items` by touching only what changed (rows keep identity, so nothing jumps). */
function syncList(ul, items, key, make, update) {
  const live = new Map([...ul.children].filter((li) => li.dataset.k).map((li) => [li.dataset.k, li]));
  const firstFill = !ul.dataset.init;
  const order = items.map((it) => {
    const k = String(key(it));
    let li = live.get(k);
    if (li) { live.delete(k); update(li, it); }
    else { li = make(it); li.dataset.k = k; update(li, it); if (!firstFill) replay(li, 'enter'); }
    return li;
  });
  live.forEach((li) => li.remove());
  order.forEach((li, i) => { if (ul.children[i] !== li) ul.insertBefore(li, ul.children[i] || null); });
  if (items.length) ul.dataset.init = '1';
}
function placeholder(ul, text) {
  let p = ul.querySelector(':scope > li.dim');
  if (!text) { if (p) p.remove(); return; }
  if (!p) { p = el('li', 'dim'); ul.append(p); }
  if (p.textContent !== text) p.textContent = text;
}

function setPoint(prefix, p) {
  const hash = $(`${prefix}-hash`);
  setText(hash, shortHash(p.hash)); hash.dataset.hash = p.hash || ''; hash.title = p.hash || '';
  tweenNum($(`${prefix}-height`), p.height || NaN);
  setText($(`${prefix}-diff`), bigNum(p.difficulty));
  const tm = $(`${prefix}-time`);
  if (!p.time) { tm.textContent = '–'; delete tm.dataset.k; return; }
  if (tm.dataset.k !== 'on') { tm.replaceChildren(document.createTextNode(''), el('small', '')); tm.dataset.k = 'on'; }
  tm.firstChild.nodeValue = fmtTime(p.time);
  const sm = tm.querySelector('small'); sm.dataset.ago = String(p.time); sm.dataset.fmt = 'long';
  const txt = ago(p.time); if (sm.textContent !== txt) sm.textContent = txt;
}

let lastBlockH = 0;
async function pollNode() {
  let n;
  try { n = await invoke('node_view'); } catch { return; }
  const v = n.view || {};
  const integrated = n.mode === 'integrated';
  $('nodebar').dataset.mode = integrated ? 'integrated' : 'remote';
  setText($('nb-mode'), integrated ? t('Gömülü') : t('Uzak'));
  setText($('nb-url'), n.url || '');
  const running = ['starting', 'running', 'stopping'].includes(n.integrated_state);
  $('nb-start').hidden = running; $('nb-stop').hidden = !running;
  $('nb-stop').disabled = n.integrated_state === 'stopping';
  const sy = $('nb-sync');
  let text, dot;
  delete sy.dataset.since;
  if (integrated) {
    if (n.integrated_state === 'failed') { text = t('Node başlatılamadı'); dot = 'bad'; }
    else if (n.integrated_state === 'stopping') { text = t('Node kapanıyor…'); dot = 'warn'; }
    else { text = v.sync_text ? t(v.sync_text) : t('Node başlatılıyor'); dot = v.synced ? 'ok' : 'warn'; }
  } else if (n.error) { text = t('Node\'a ulaşılamıyor'); dot = 'bad'; }
  else if (!n.view) { text = t('Bağlanıyor…'); dot = ''; }
  else { text = t('Bağlı · {n} sn önce güncellendi', { n: n.age }); dot = 'ok'; sy.dataset.since = String(Date.now() - n.age * 1000); }
  if (sy.textContent !== text) sy.textContent = text;
  const dotCls = `dot ${dot}`; if ($('nb-dot').className !== dotCls) $('nb-dot').className = dotCls;
  const showBar = integrated && !v.synced && v.sync_percent != null;
  $('nb-bar').hidden = !showBar;
  if (showBar) $('nb-bar-fill').style.width = `${v.sync_percent}%`;
  $('nb-error').textContent = n.error ? E(n.error) : '';

  // Header and Block: the same four values; they match once the node is in sync.
  const hd = v.header || {}, bk = v.block || {};
  setPoint('hd', hd); setPoint('bk', bk);
  if (bk.height) {
    if (lastBlockH && bk.height > lastBlockH) replay($('bk-hash').closest('.nb-card'), 'pulse'); // a new block
    lastBlockH = bk.height;
  }
  const chip = $('eq-chip');
  if (hd.height && bk.height) {
    const equal = hd.hash === bk.hash && hd.height === bk.height;
    chip.hidden = false; chip.dataset.state = equal ? 'ok' : 'ahead';
    setText(chip, equal ? t('Eşit') : t('Header önde (+{n})', { n: Math.max(0, hd.height - bk.height) }));
  } else chip.hidden = true;

  // Data
  tweenNum($('d-main'), n.view ? v.tx_pool_size : NaN);
  tweenNum($('d-stem'), integrated ? v.stem_pool_size : NaN);
  setText($('d-size'), integrated && v.disk_usage_gb ? `${v.disk_usage_gb} GB` : '–');
  tweenNum($('d-peers'), integrated ? v.peer_count : NaN);

  // Peers
  const pl = $('nb-peers');
  syncList(pl, v.peers || [], (p) => p.addr,
    (p) => { const li = el('li'); li.append(el('div', 'a', p.addr), el('div', 'm', '')); return li; },
    (li, p) => { setText(li.querySelector('.m'), `${p.user_agent} · ${p.direction === 'Inbound' ? t('gelen') : t('giden')} · ${fmtNum(p.height)}`); });
  placeholder(pl, (v.peers || []).length ? '' : integrated ? t('Henüz eş yok') : t('Eş bilgisi uzak node\'larda görünmez; kendi node\'unu çalıştırınca burada listelenir.'));

  // Blocks: the age of each block keeps counting by itself
  const bl = $('nb-blocks');
  syncList(bl, v.blocks || [], (b) => b.hash,
    (b) => {
      const li = el('li');
      const age = el('span', 'd'); age.dataset.ago = String(b.time); age.textContent = ageShort(b.time);
      li.append(el('span', 'h', fmtNum(b.height)), el('span', 'hash', b.hash), age);
      li.title = `${fmtDate(b.time)} · ${t('Difficulty')} ${fmtNum(b.difficulty)} · ${dur(b.duration)}`;
      return li;
    },
    () => {});
  placeholder(bl, (v.blocks || []).length ? '' : t('Henüz blok bilgisi yok'));
  fitList(pl); fitList(bl);
  if (!integrated) updatePool();
  // Polls fast only while a built-in node is syncing; slowly for a remote node or a hidden window.
  clearTimeout(nodeTimer);
  nodeTimer = setTimeout(pollNode, document.hidden ? 20000 : integrated ? 3000 : 10000);
}

let nodeTimer;
let poolAt = 0;
/** Hide list rows that do not fit the card: the left panel never scrolls. */
function fitList(ul) {
  const items = [...ul.children];
  items.forEach((li) => { li.hidden = false; });
  const max = ul.clientHeight;
  if (!max) return;
  items.forEach((li) => { if (li.offsetTop + li.offsetHeight > max + 1) li.hidden = true; });
}
/** Re-fit the left panel lists when the window size changes (rows that do not fit are hidden). */
function fitAll() { fitList($('nb-peers')); fitList($('nb-blocks')); fitList($('nb-pool')); }
window.addEventListener('resize', fitAll);

async function updatePool() {
  if (Date.now() - poolAt < 8000) return;
  poolAt = Date.now();
  try {
    const list = await invoke('nodes_list');
    const ul = $('nb-pool');
    const ms = (n) => t('{ms} ms', { ms: n });
    syncList(ul, list, (nd) => nd.url,
      (nd) => { const li = el('li'); li.append(el('span', 'dot'), el('span', 'pu', hostOf(nd.url)), el('span', 'pm', '–')); li.title = nd.url; return li; },
      (li, nd) => {
        li.classList.toggle('use', !!nd.in_use);
        const dotCls = `dot ${nd.ok === true ? 'ok' : nd.ok === false ? 'bad' : ''}`;
        if (li.firstChild.className !== dotCls) li.firstChild.className = dotCls;
        tweenNum(li.lastChild, nd.ok ? nd.latency_ms : NaN, ms);
      });
    fitList(ul);
  } catch { /* shown next time */ }
}
/** Frameless window: drag by the top bar, double click to maximize, our own min / max / close. */
function setupWindow() {
  $('win-min').addEventListener('click', () => invoke('win_min'));
  $('win-max').addEventListener('click', () => invoke('win_max'));
  $('win-close').addEventListener('click', () => invoke('win_close'));
  const bar = $('topbar');
  const interactive = 'button, input, select, a, summary';
  bar.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest(interactive)) invoke('win_drag'); });
  bar.addEventListener('dblclick', (e) => { if (!e.target.closest(interactive)) invoke('win_max'); });
}
$('nb-start').addEventListener('click', async (e) => {
  await busy(e.currentTarget, async () => {
    try { await invoke('node_start'); toast(t('Gömülü node başlatılıyor')); pollNode(); } catch (x) { $('nb-error').textContent = E(x); }
  });
});
$('nb-stop').addEventListener('click', async (e) => {
  await busy(e.currentTarget, async () => {
    try { await invoke('node_stop'); toast(t('Node durduruldu')); pollNode(); } catch (x) { $('nb-error').textContent = E(x); }
  });
});

// ------------------------------------------------------------------ node pool dialog
function renderNodeList(list) {
  const ul = $('nd-list'); ul.replaceChildren();
  list.forEach((n) => {
    const li = el('li');
    li.append(el('span', `dot ${n.ok === true ? 'ok' : n.ok === false ? 'bad' : ''}`), el('span', 'u', n.url));
    const meta = n.ok === true ? t('{ms} ms · blok {h}', { ms: n.latency_ms, h: fmtNum(n.height) })
      : n.ok === false ? t('Ulaşılamıyor') : t('Kontrol ediliyor…');
    li.append(el('span', 'm', meta));
    const act = el('span', 'act');
    if (n.in_use) act.append(el('span', 'badge use', t('Kullanımda')));
    else if (n.preferred) act.append(el('span', 'badge pref', t('Tercih edilen')));
    act.append(el('span', `badge${n.builtin ? '' : ' own'}`, n.builtin ? t('Yerleşik') : t('Eklediğin')));
    if (!n.in_use && n.ok !== false) {
      const use = el('button', 'btn btn-sm', t('Bunu kullan')); use.type = 'button';
      use.addEventListener('click', async () => {
        try { renderNodeList(await invoke('node_use', { url: n.url })); toast(t('Node değiştirildi')); setTimeout(() => loadNodeList(false), 400); }
        catch (x) { err('nd-list-error', E(x)); }
      });
      act.append(use);
    }
    if (!n.builtin) {
      const rm = el('button', 'btn btn-sm', t('Sil')); rm.type = 'button';
      rm.addEventListener('click', async () => {
        try { renderNodeList(await invoke('node_remove', { url: n.url })); toast(t('Node silindi')); } catch (x) { err('nd-list-error', E(x)); }
      });
      act.append(rm);
    }
    li.append(act); ul.append(li);
  });
}
async function loadNodeList(probe) {
  err('nd-list-error');
  try {
    renderNodeList(await invoke('nodes_list'));
    if (probe) renderNodeList(await invoke('nodes_probe'));
  } catch (x) { err('nd-list-error', E(x)); }
}
$('nd-add').addEventListener('click', async (e) => {
  err('nd-list-error');
  const url = $('nd-new').value.trim();
  if (!url) return;
  await busy(e.currentTarget, async () => {
    try { renderNodeList(await invoke('node_add', { url })); $('nd-new').value = ''; toast(t('Node eklendi')); fillNodeDatalist(); }
    catch (x) { err('nd-list-error', E(x)); }
  });
});
$('nd-check').addEventListener('click', (e) => busy(e.currentTarget, () => loadNodeList(true)));
$('nd-auto-pick').addEventListener('click', async () => {
  try { renderNodeList(await invoke('node_use', { url: null })); toast(t('Otomatik seçim açık')); } catch (x) { err('nd-list-error', E(x)); }
});

// ---- tabs of the node dialog
function selectNodeTab(name) {
  document.querySelectorAll('.snav [data-ntab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.ntab === name)));
  document.querySelectorAll('[data-npane]').forEach((p) => { p.hidden = p.dataset.npane !== name; });
}
document.querySelectorAll('.snav [data-ntab]').forEach((b) => b.addEventListener('click', () => selectNodeTab(b.dataset.ntab)));

// ---- this wallet's connection: pool / one node / own node
function fillConnTab() {
  const w = state.open;
  $('nd-conn-box').hidden = !w; $('nd-conn-none').hidden = !!w;
  $('nd-conn-note').hidden = true; err('nd-conn-error');
  if (!w) return;
  const mode = w.connection === 'integrated' ? 'integrated' : w.connection === 'custom' ? 'custom' : 'auto';
  document.querySelectorAll('input[name="ndconn"]').forEach((r) => { r.checked = r.value === mode; });
  invoke('nodes_list').then((list) => {
    const sel = $('nd-conn-url'); sel.replaceChildren();
    list.forEach((n) => { const o = el('option', '', n.url); o.value = n.url; sel.append(o); });
    if (w.custom_url) sel.value = w.custom_url;
    sel.hidden = mode !== 'custom';
  }).catch(() => {});
}
document.querySelectorAll('input[name="ndconn"]').forEach((r) => r.addEventListener('change', () => {
  $('nd-conn-url').hidden = document.querySelector('input[name="ndconn"]:checked').value !== 'custom';
}));
$('nd-conn-apply').addEventListener('click', async (e) => {
  err('nd-conn-error');
  const mode = document.querySelector('input[name="ndconn"]:checked')?.value || 'auto';
  await busy(e.currentTarget, async () => {
    try {
      const reconnect = await invoke('wallet_update', {
        id: state.open.id, name: state.open.name, connection: mode,
        customUrl: mode === 'custom' ? $('nd-conn-url').value : '',
      });
      state.status = await invoke('status'); state.open = state.status.open_wallet;
      if (reconnect) {
        const note = $('nd-conn-note'); note.hidden = false; note.textContent = `${t('Kaydedildi. Yeni node bağlantısı cüzdan yeniden açılınca geçerli olur.')} `;
        const b = el('button', 'link', t('Şimdi kapat')); b.type = 'button'; b.addEventListener('click', logout); note.append(b);
      } else toast(t('Kaydedildi'));
      fillWalletSettings();
    } catch (x) { err('nd-conn-error', E(x)); }
  });
});

$('nd-form').addEventListener('submit', async (e) => {
  e.preventDefault(); err('nd-error');
  const peers = $('nd-peers').value;
  const badPeer = peers.split('\n').map((l) => l.trim()).filter(Boolean).find((l) => !/^[\w.\-[\]:]+:\d{1,5}$/.test(l));
  if (badPeer) return err('nd-error', t('Eş adresi host:port olmalı: {p}', { p: badPeer }));
  try {
    const s = state.status.settings;
    await invoke('save_settings', {
      theme: s.theme, language: s.language, autoLockMinutes: s.auto_lock_minutes,
      node: { autostart: $('nd-auto').checked, peers, only_peers: $('nd-only').checked, archive: $('nd-archive').checked },
      send: s.send,
    });
    state.status = await invoke('status'); $('dlg-node').close(); toast(t('Node ayarları kaydedildi'));
  } catch (x) { err('nd-error', E(x)); }
});

// ------------------------------------------------------------------ dialogs
function openDialog(name) {
  if (name === 'settings') {
    const s = state.status.settings;
    $('set-lang').value = s.language;
    document.querySelectorAll('input[name="theme"]').forEach((r) => { r.checked = r.value === s.theme; });
    $('set-network').value = s.network;
    $('opt-usernet').hidden = s.network !== 'usernet';
    $('set-net-apply').disabled = true;
    $('set-autolock').value = String(s.auto_lock_minutes);
    $('set-lock-box').hidden = !state.open;
    $('set-backup-none').hidden = !!state.open;
    selectSettingsTab('general');
    $('set-confirm-pw').checked = s.send.confirm_password; $('set-fluff').checked = s.send.fluff;
    $('set-minconf').value = String(s.send.min_confirmations || 10); $('set-change').value = String(s.send.change_outputs); $('set-strategy').value = s.send.strategy; $('set-ttl').value = s.send.ttl_blocks;
    $('set-retry').checked = s.send.retry; $('set-retry-min').value = s.send.retry_minutes; $('set-retry-min').disabled = !s.send.retry;
    $('set-backup-box').hidden = !state.open; err('set-backup-note');
    return $('dlg-settings').showModal();
  }
  if (name === 'node') {
    const s = state.status.settings;
    $('nd-pool-title').textContent = t('Node havuzu ({net})', { net: NET_LABEL()[state.status.network] });
    $('nd-auto').checked = s.node.autostart; $('nd-archive').checked = s.node.archive;
    $('nd-peers').value = s.node.peers; $('nd-only').checked = s.node.only_peers;
    err('nd-error'); err('nd-list-error'); $('nd-new').value = '';
    selectNodeTab('pool'); fillConnTab();
    $('dlg-node').showModal();
    return loadNodeList(true);
  }
  if (name === 'password') { ['pw-old', 'pw-new', 'pw-new2'].forEach((id) => { $(id).value = ''; }); err('pw-error'); return $('dlg-password').showModal(); }
  if (name === 'phrase') { $('ph-pass').value = ''; err('ph-error'); return $('dlg-phrase').showModal(); }
  if (name === 'delete') {
    $('del-text').textContent = t('{name} bu bilgisayardan silinecek. Kurtarma ifaden yanında değilse içindeki para kaybolur. Bu işlem geri alınamaz.', { name: `“${state.open.name}”` });
    $('del-ok').checked = false; $('del-submit').disabled = true;
    $('del-pass').value = ''; err('del-error'); return $('dlg-delete').showModal();
  }
  if (name === 'send') {
    ['send-step-done', 'send-step-sp', 'send-step-queued'].forEach((id) => { $(id).hidden = true; });
    $('send-step-form').hidden = false;
    $('s-avail').textContent = amt(state.overview?.spendable);
    $('s-pass-f').hidden = !state.status.settings.send.confirm_password; $('s-pass').value = '';
    setSendMethod('tor');
    err('send-error'); stopRecipientCheck(); $('s-recipient-box').hidden = true; $('s-recipient').dataset.state = ''; pingSeq++;
    $('dlg-send').showModal(); $('s-addr').focus();
    return;
  }
  if (name === 'receive') {
    const a = state.overview?.address || '';
    $('r-addr').textContent = a || '–';
    if (a) invoke('address_qr', { text: a }).then((svg) => { $('r-qr').innerHTML = svg; });
    pollTor(); $('dlg-receive').showModal();
    return;
  }
  if (name === 'slatepack') {
    $('pp-step-form').hidden = false; $('pp-step-reply').hidden = true; $('pp-step-done').hidden = true;
    $('pp-in').value = ''; err('pp-error');
    $('dlg-slatepack').showModal(); $('pp-in').focus();
  }
}

// ---- settings dialog
$('set-network').addEventListener('change', () => { $('set-net-apply').disabled = $('set-network').value === state.status.network; });
$('set-net-apply').addEventListener('click', async () => {
  toast(state.open ? t('Ağ değişince açık cüzdan kapanır ve uygulama yeniden başlar.') : t('Uygulama seçtiğin ağ ile yeniden başlayacak.'));
  await invoke('switch_network', { network: $('set-network').value });
});
document.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener('change', () => applyTheme(r.value)));
$('dlg-settings').addEventListener('close', () => applyTheme(state.status.settings.theme));
// Donations go to the project's Grin address; the normal Send dialog opens with it filled in, the amount is up to the user.
const DONATE_ADDRESS = 'grin1tzlscdyzl0pgns8rw9sl7q9wqptftjez2xsdrszj9se4vmvwj8wqajj4yz';
$('set-donate-copy').addEventListener('click', () => copy(DONATE_ADDRESS));
$('set-donate').addEventListener('click', () => {
  if (state.status.network !== 'mainnet') return toast(t('Bağış yalnızca Mainnet üzerinde gönderilebilir.'));
  if (!state.open) return toast(t('Bağış göndermek için önce bir cüzdan aç.'));
  $('dlg-settings').close();
  openDialog('send');
  $('s-addr').value = DONATE_ADDRESS;
  $('s-addr').dispatchEvent(new Event('input', { bubbles: true }));
  $('s-amount').focus();
});

$('set-save').addEventListener('click', async () => {
  const s = state.status.settings;
  const theme = document.querySelector('input[name="theme"]:checked')?.value || 'system';
  const language = $('set-lang').value;
  const minutes = Number($('set-autolock').value) || 0;
  try {
    const send = {
      confirm_password: $('set-confirm-pw').checked, fluff: $('set-fluff').checked, change_outputs: Number($('set-change').value) || 1,
      strategy: $('set-strategy').value, ttl_blocks: Math.max(0, Number($('set-ttl').value) || 0),
      min_confirmations: Math.min(10, Math.max(1, Number($('set-minconf').value) || 10)),
      retry: $('set-retry').checked, retry_minutes: Math.min(240, Math.max(1, Number($('set-retry-min').value) || 30)),
    };
    await invoke('save_settings', { theme, language, autoLockMinutes: minutes, node: s.node, send });
    state.status = await invoke('status'); applyTheme(theme);
    if (language !== s.language) applyLanguage(language);
    autoLockMs = minutes * 60000;
    $('dlg-settings').close(); toast(t('Kaydedildi'));
  } catch (x) { toast(E(x)); }
});

/** Switch language without reloading: static text is re-translated, dynamic parts re-rendered. */
function applyLanguage(pref) {
  setLanguage(pref);
  translateStatic();
  fillAutoLock();
  $('set-autolock').value = String(state.status.settings.auto_lock_minutes);
  const chip = $('net-chip');
  chip.textContent = NET_LABEL()[state.status.network] || state.status.network;
  if (state.open) {
      fillSince($('rescan-since'), false);
    refresh(); pollTor(); pollScan();
    if (document.querySelector('.tabs [data-tab="accounts"][aria-selected="true"]')) loadAccounts();
  } else if (document.querySelector('[data-screen="form"]') && !document.querySelector('[data-screen="form"]').hidden) { openForm(state.formMode); } else renderWallets();
  pollNode();
}

function selectSettingsTab(name) {
  document.querySelectorAll('.snav [data-stab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.stab === name)));
  document.querySelectorAll('[data-spane]').forEach((p) => { p.hidden = p.dataset.spane !== name; });
}
document.querySelectorAll('.snav [data-stab]').forEach((b) => b.addEventListener('click', () => selectSettingsTab(b.dataset.stab)));

// ---- repair: forget tor's saved state and restart
$('set-repair').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  try { toast(t('Uygulama yeniden başlatılıyor…')); await invoke('repair_restart'); }
  catch (x) { toast(E(x)); }
}));

$('set-retry').addEventListener('change', () => { $('set-retry-min').disabled = !$('set-retry').checked; });

// ---- backup, export, support
$('set-backup').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  try { const p = await invoke('backup_wallet'); $('set-backup-note').textContent = t('Yedek kaydedildi: {path}', { path: p }); }
  catch (x) { $('set-backup-note').textContent = E(x); }
}));
$('set-csv').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  try { const p = await invoke('export_transactions'); $('set-backup-note').textContent = t('Dışa aktarıldı: {path}', { path: p }); }
  catch (x) { $('set-backup-note').textContent = E(x); }
}));
$('set-logs').addEventListener('click', () => invoke('open_data_folder'));

// ---- send
let sendMethod = 'tor';
/** The note under "Send over Tor": what happens when the recipient is offline (from the settings). */
function torNote() {
  const s = state.status.settings.send;
  const base = t('Alıcının Grin adresini yaz; ödeme Tor üzerinden doğrudan gider, alıcı imzalar ve işlem zincire iletilir.');
  return s.retry
    ? `${base} ${t('Alıcı çevrimdışıysa dakikada bir yeniden denenir (en fazla {n} dk); olmazsa işlem başarısız olur ve tutar serbest kalır.', { n: s.retry_minutes })}`
    : `${base} ${t('Alıcı çevrimdışıysa işlem başarısız olur ve tutar serbest kalır.')}`;
}
/** Tor: pay straight to an address. Slatepack: make a text to hand over (address optional). */
function setSendMethod(m) {
  sendMethod = m;
  document.querySelectorAll('#s-method [data-m]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.m === m)));
  const tor = m === 'tor';
  $('s-method-desc').textContent = tor ? torNote() : t('Alıcı çevrimdışıysa ya da Tor kullanamıyorsa: bir Slatepack metni oluşturulur. Onu alıcıya mesajla, e-postayla ya da QR ile ilet; alıcı yanıtı geri verince buraya yapıştırıp tamamlarsın.');
  $('s-addr-field').hidden = !tor; // Slatepack mode needs only the amount
  if (!tor) $('s-addr').value = '';
  $('s-addr-l').textContent = t('Alıcının adresi');
  $('s-addr-hint').textContent = t('grin1… ile başlar. Adresi yazınca alıcının çevrimiçi olup olmadığı otomatik kontrol edilir.');
  $('s-submit').textContent = tor ? t('Gönder') : t('Slatepack oluştur');
  stopRecipientCheck(); $('s-recipient-box').hidden = true; pingSeq++; err('send-error');
  if (tor && $('s-addr').value.trim()) checkRecipient();
}
$('s-method').addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (b) setSendMethod(b.dataset.m); });

async function watchPending() {
  if (locked || !state.pendingSlate || $('send-step-sp').hidden || !$('dlg-send').open) return;
  try {
    const list = await invoke('transactions');
    const tx = list.find((x) => x.slate_id === state.pendingSlate);
    if (tx && tx.finalized && !tx.cancelled) {
      state.pendingSlate = null;
      $('send-step-sp').hidden = true; $('send-step-done').hidden = false;
      renderTxs(list);
    }
  } catch { /* next tick */ }
}

// Enter in the amount field sends; never let the form reload the page.
$('send-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!$('send-step-form').hidden) $('s-submit').click();
});

// Is the recipient online? A first contact with an onion takes 10-30 s, so a percentage shows how
// far the check is (it gives up after CHECK_SECS).
let pingSeq = 0;
let pingTimer;
let pingProg;
const CHECK_SECS = 60;
function stopRecipientCheck() {
  clearTimeout(pingTimer); clearInterval(pingProg);
  $('s-rbar').hidden = true; $('s-recheck').hidden = true;
}
function checkRecipient() {
  stopRecipientCheck();
  const a = $('s-addr').value.trim();
  const box = $('s-recipient-box'), r = $('s-recipient');
  $('s-addr').removeAttribute('aria-invalid');
  pingSeq++; r.dataset.state = '';
  if (!a || sendMethod !== 'tor') { box.hidden = true; return; }
  box.hidden = false;
  pingTimer = setTimeout(async () => {
    if (!(await invoke('check_address', { address: a }))) {
      $('s-addr').setAttribute('aria-invalid', 'true');
      r.dataset.state = 'bad'; r.textContent = t('Bu, bu ağ için geçerli bir Grin adresi değil.');
      return;
    }
    const seq = ++pingSeq, t0 = Date.now();
    const tick = () => {
      const p = Math.min(99, Math.round(((Date.now() - t0) / (CHECK_SECS * 1000)) * 100));
      $('s-rbar-fill').style.width = `${p}%`;
      r.textContent = t('Alıcının çevrimiçi olup olmadığına bakılıyor… {p}% · genelde 10-30 sn, en fazla {s} sn sürer', { p, s: CHECK_SECS });
    };
    r.dataset.state = ''; $('s-rbar').hidden = false; tick(); pingProg = setInterval(tick, 500);
    try {
      await invoke('ping', { address: a });
      if (seq !== pingSeq) return;
      clearInterval(pingProg); $('s-rbar').hidden = true;
      r.dataset.state = 'ok'; r.textContent = t('Alıcı çevrimiçi; ödeme Tor üzerinden doğrudan gidecek.');
    } catch {
      if (seq !== pingSeq) return;
      clearInterval(pingProg); $('s-rbar').hidden = true; $('s-recheck').hidden = false;
      r.dataset.state = 'bad';
      const rs = state.status.settings.send;
      r.textContent = `${t('Alıcıya {s} sn içinde Tor ile ulaşılamadı; çevrimdışı olabilir.', { s: CHECK_SECS })} ${rs.retry
        ? t('Yine de gönderirsen dakikada bir yeniden denenir (en fazla {n} dk).', { n: rs.retry_minutes })
        : t('Şimdi gönderirsen işlem başarısız olur.')}`;
    }
  }, 350);
}
$('s-addr').addEventListener('input', checkRecipient);
$('s-recheck').addEventListener('click', checkRecipient);

// "Maks": the whole spendable balance minus the network fee; the backend recomputes it when sending.
let sendMax = false;
$('s-amount').addEventListener('input', () => { sendMax = false; });
$('s-max').addEventListener('click', async () => {
  err('send-error');
  await busy($('s-max'), async () => {
    try {
      const v = await invoke('max_sendable');
      if (Number(v) <= 0) return err('send-error', t('Gönderilebilir bakiye yok.'));
      $('s-amount').value = v; sendMax = true;
    } catch (x) { err('send-error', E(x)); }
  });
});

$('s-submit').addEventListener('click', async () => {
  err('send-error');
  const amount = $('s-amount').value.trim(), address = $('s-addr').value.trim();
  if (!amount) return err('send-error', t('Tutar gir.'));
  if (sendMethod === 'tor' && !address) return err('send-error', t('Tor ile göndermek için alıcının adresini yaz.'));
  await busy($('s-submit'), async () => {
    try {
      const r = await invoke('send', { amount, address, password: $('s-pass').value || null, method: sendMethod, sendMax });
      sendMax = false;
      $('s-pass').value = '';
      $('send-step-form').hidden = true;
      $('s-amount').value = ''; $('s-addr').value = ''; stopRecipientCheck(); $('s-recipient-box').hidden = true;
      if (r.kind === 'tor') $('send-step-done').hidden = false;
      else if (r.kind === 'queued') {
        $('q-text').textContent = t('Dakikada bir yeniden denenecek (en fazla {n} dk). Bu pencereyi kapatabilirsin; sonuç İşlemler listesinde görünür. Yeniden deneme için uygulama ve cüzdan açık kalmalı.', { n: r.retry_minutes });
        $('send-step-queued').hidden = false;
      } else {
        state.pendingSlate = r.slate_id;
        $('sp-why').textContent = r.tor_error
          ? t('Alıcıya Tor üzerinden ulaşılamadı, bu yüzden ödeme Slatepack ile tamamlanacak. Tutar, işlem bitene ya da iptal edilene kadar kilitli kalır.')
          : t('Ödeme Slatepack ile tamamlanacak. Tutar, işlem bitene ya da iptal edilene kadar kilitli kalır.');
        $('sp-out').value = r.message; $('sp-qr').innerHTML = r.qr; $('sp-qr').hidden = true;
        $('sp-reply').value = ''; err('sp-error');
        $('send-step-sp').hidden = false;
      }
      refresh();
    } catch (x) { err('send-error', E(x)); }
  });
});

$('sp-finalize').addEventListener('click', async () => {
  err('sp-error');
  const text = $('sp-reply').value.trim();
  if (!text) return err('sp-error', t('Alıcının yanıtını yapıştır.'));
  await busy($('sp-finalize'), async () => {
    try {
      const r = await invoke('process_slatepack', { text });
      if (r.kind !== 'finalized') return err('sp-error', t('Bu metin bu gönderimin yanıtı değil.'));
      $('send-step-sp').hidden = true; $('send-step-done').hidden = false; state.pendingSlate = null; refresh();
    } catch (x) { err('sp-error', E(x)); }
  });
});

$('sp-cancel').addEventListener('click', async () => {
  if (!state.pendingSlate) return;
  await busy($('sp-cancel'), async () => {
    try { await invoke('cancel_tx', { slateId: state.pendingSlate }); state.pendingSlate = null; $('dlg-send').close(); toast(t('İşlem iptal edildi, tutar serbest')); refresh(); }
    catch (x) { err('sp-error', E(x)); }
  });
});

// ---- paste slatepack
$('pp-submit').addEventListener('click', async () => {
  err('pp-error');
  const text = $('pp-in').value.trim();
  if (!text) return err('pp-error', t('Slatepack metnini yapıştır.'));
  await busy($('pp-submit'), async () => {
    try {
      const r = await invoke('process_slatepack', { text });
      $('pp-step-form').hidden = true;
      if (r.kind === 'reply') {
        $('pp-out').value = r.message; $('pp-qr').innerHTML = r.qr; $('pp-qr').hidden = true;
        $('pp-reply-hint').textContent = r.auto_return
          ? t('Yanıt ayrıca gönderene Tor ile iletilmeye çalışılıyor; ulaşırsa işlem kendiliğinden tamamlanır. Ulaşamazsa bu metni gönderene ver.')
          : t('Bu metni gönderene ver; o da işlemi tamamlar.');
        $('pp-step-reply').hidden = false;
      } else {
        const d = $('pp-done-text'); d.replaceChildren();
        d.append(el('strong', '', r.kind === 'returned' ? t('Ödeme alındı.') : t('Tamamlandı.')), document.createTextNode(' '),
          document.createTextNode(r.kind === 'returned' ? t('İmzalı yanıt gönderene Tor üzerinden iletildi.') : t('İşlem zincire iletildi.')));
        $('pp-step-done').hidden = false;
      }
      refresh();
    } catch (x) { err('pp-error', E(x)); }
  });
});

boot().catch((e) => { document.body.classList.remove('loading'); document.body.textContent = t('Başlatılamadı: {e}', { e }); });
