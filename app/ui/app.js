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
  document.body.dataset.view = screen;
  // Phone layout: a new screen starts on the wallet tab (the Node tab stays where the user put it).
  if (document.body.dataset.mtab !== 'node') setMobileTab('wallet');
  $('app').scrollTop = 0;
}

// Compact layout (<= 1140px): bottom tabs switch between the wallet, the Tor card and the node panel.
const PHONE = matchMedia('(max-width: 1140px)'); // compact layout: a small desktop window, a tablet or a phone
if (/Android|iPhone|iPad/i.test(navigator.userAgent)) document.documentElement.dataset.platform = "mobile"; // no window buttons there
/** Tell the Rust side which language the interface uses (tray menu and desktop notifications are worded there). */
function reportLang() { invoke("ui_lang", { lang: I18N.lang }).catch(() => {}); }
function setMobileTab(tab) {
  document.body.dataset.mtab = tab;
  document.querySelectorAll('#mnav [data-mtab]').forEach((b) => {
    if (b.dataset.mtab === tab) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  });
  if (tab === 'node') requestAnimationFrame(() => fitAll());
}

// Phone: pull the page down at the top to refresh (wallet: balance and history; list: wallets; node tab:
// the node panel). The browser's own pull-to-refresh is off (overscroll-behavior), this one reloads data only.
(function pullToRefresh() {
  const PULL = 70;
  let y0 = null, dy = 0, area = null;
  const ind = $('ptr');
  const reset = () => { y0 = null; dy = 0; ind.style.transform = ''; ind.classList.remove('ready'); ind.hidden = true; };
  document.addEventListener('touchstart', (e) => {
    area = scrollArea();
    if (!area || area.scrollTop > 0 || document.querySelector('dialog[open]') || !$('lockscreen').hidden || e.touches.length !== 1) { y0 = null; return; }
    y0 = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0 || area.scrollTop > 0) { ind.hidden = true; return; }
    ind.hidden = false;
    const d = Math.min(dy, PULL * 1.6);
    ind.style.transform = `translateY(${d * 0.6}px) rotate(${d * 3}deg)`;
    ind.classList.toggle('ready', dy >= PULL);
  }, { passive: true });
  document.addEventListener('touchend', async () => {
    if (y0 === null) return;
    const go = dy >= PULL;
    reset();
    if (!go) return;
    ind.hidden = false; ind.classList.add('spin');
    try {
      if (document.body.dataset.mtab === 'node') await pollNode();
      else if (document.body.dataset.view === 'wallet') await Promise.all([refresh(), pollTor(), pollScan()]);
      else if (document.body.dataset.view === 'wallets') { state.status = await invoke('status'); renderWallets(); }
      toast(t('Yenilendi'));
    } finally { ind.classList.remove('spin'); ind.hidden = true; }
  });
})();

// Phone: a round button over the bottom tabs shows that the page goes on below. A tap scrolls one screen
// down; at the bottom it turns into "back to top". It follows whichever area is shown (page or node panel).
function scrollArea() {
  if (!PHONE.matches) return null;
  if (document.body.dataset.mtab === 'node' && ['wallet', 'wallets'].includes(document.body.dataset.view)) return $('nodebar');
  return $('app');
}
let fabRaf = 0;
function syncScrollFab() {
  cancelAnimationFrame(fabRaf);
  fabRaf = requestAnimationFrame(() => {
    const fab = $('scroll-fab'), a = scrollArea();
    const room = a ? a.scrollHeight - a.clientHeight : 0;
    if (!a || room < 80 || document.querySelector('dialog[open]') || !$('lockscreen').hidden) { fab.hidden = true; return; }
    const atEnd = a.scrollTop >= room - 24;
    fab.hidden = false;
    fab.dataset.dir = atEnd ? 'up' : 'down';
    const label = atEnd ? t('Başa dön') : t('Aşağı kaydır');
    if (fab.getAttribute('aria-label') !== label) { fab.setAttribute('aria-label', label); fab.title = label; }
  });
}
$('scroll-fab').addEventListener('click', () => {
  const a = scrollArea(); if (!a) return;
  const up = $('scroll-fab').dataset.dir === 'up';
  a.scrollBy({ top: up ? -a.scrollHeight : a.clientHeight * 0.8, behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
});
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
['app', 'nodebar'].forEach((id) => $(id).addEventListener('scroll', syncScrollFab, { passive: true }));
window.addEventListener('resize', syncScrollFab);
new MutationObserver(syncScrollFab).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'open', 'data-mtab', 'data-view'] });

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

/** Colour set: "grin" (black and yellow, default) or "orko" (blue). The logo images follow it. */
function applyPalette(p) {
  const palette = p === 'orko' ? 'orko' : 'grin';
  document.documentElement.dataset.palette = palette;
  document.querySelectorAll('img[src^="logo-mark"]').forEach((img) => {
    img.setAttribute('src', palette === 'grin' ? 'logo-mark-grin.svg' : 'logo-mark.svg');
  });
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = palette === 'grin' ? '#000000' : '#0a0e15';
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
  reportLang();
  collectStatic(document.body);
  translateStatic();
  applyTheme(s.settings.theme);
  applyPalette(s.settings.palette);
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
    const live = !!(s.open_wallet && s.open_wallet.id === w.id); // still open in the background
    if (live) { li.classList.add('live'); li.append(el('span', 'chip', t('Arka planda açık'))); }
    else if (w.id === s.last_wallet && s.wallets.length > 1) li.append(el('span', 'chip', t('Son kullanılan')));
    if (live) {
      const shut = el('button', 'btn', t('Kapat')); shut.type = 'button'; shut.title = t('Cüzdanı tamamen kapat; Tor adresin çevrimdışı olur.');
      shut.addEventListener('click', closeWallet);
      const enter = el('button', 'btn btn-primary', t('Gir')); enter.type = 'button';
      enter.addEventListener('click', () => enterWallet());
      li.append(shut, enter);
    } else {
      const b = el('button', 'btn btn-primary', t('Aç')); b.type = 'button';
      b.addEventListener('click', () => askUnlock(w));
      const rm = el('button', 'btn danger-text', t('Sil')); rm.type = 'button'; rm.title = t('Cüzdanı sil');
      rm.addEventListener('click', () => askRemove(w));
      li.append(rm, b);
    }
    ul.append(li);
  });
  show('wallets');
  loadTrash();
}
// Recently deleted wallets (kept 30 days): restore or remove for good.
async function loadTrash() {
  let items = [];
  try { items = await invoke('trash_list'); } catch (_) { /* older backend */ }
  $('wl-trash').hidden = !items.length;
  const ul = $('wl-trash-list'); ul.replaceChildren();
  items.forEach((it) => {
    const li = el('li', 'wrow');
    const av = el('span', 'avatar', (it.name.trim()[0] || '?').toUpperCase()); av.style.setProperty('--h', hue(it.name));
    const mid = el('div', 'wmid'); mid.append(el('div', 'wname', it.name));
    mid.append(el('div', 'wmeta', t('{n} gün kaldı', { n: it.days_left })));
    li.append(av, mid);
    const del = el('button', 'btn danger-text', t('Kalıcı olarak sil')); del.type = 'button';
    let armed = 0;
    del.addEventListener('click', async () => {
      if (!armed) { // second click within 4 s confirms
        armed = setTimeout(() => { armed = 0; del.textContent = t('Kalıcı olarak sil'); }, 4000);
        del.textContent = t('Emin misin? Tekrar tıkla'); return;
      }
      clearTimeout(armed);
      try { await invoke('trash_purge', { id: it.id }); loadTrash(); } catch (x) { toast(E(x)); }
    });
    const back = el('button', 'btn btn-primary', t('Geri al')); back.type = 'button';
    back.addEventListener('click', async () => {
      await busy(back, async () => {
        try {
          await invoke('trash_restore', { id: it.id });
          state.status = await invoke('status'); renderWallets(); toast(t('Cüzdan geri alındı. Açınca bakiye yeniden taranır.'));
        } catch (x) { toast(E(x)); }
      });
    });
    li.append(del, back); ul.append(li);
  });
}
// Delete a wallet from the list without opening it (needed when the password is forgotten): the user
// confirms by ticking the box and typing the wallet's name.
function askRemove(w) {
  state.removeW = w;
  $('wr-text').textContent = t('{name} listeden kaldırılacak. Şifreli anahtar dosyası 30 gün saklanır ve “Son silinenler” bölümünden geri alınabilir. Kurtarma ifaden yoksa bu süreden sonra içindeki para kaybolur.', { name: `“${w.name}”` });
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
      try { window.OrkoAndroid?.bioRemove?.(w.id); } catch { /* not on Android */ }
      state.removeW = null; $('dlg-wremove').close();
      state.status = await invoke('status'); renderWallets(); toast(t('Cüzdan silindi'));
    } catch (x) { err('wr-error', E(x)); }
  });
});

function askUnlock(w) {
  state.unlockId = w.id;
  $('ul-title').textContent = t('“{name}” cüzdanını aç', { name: w.name });
  $('ul-pass').value = ''; err('ul-error');
  $('dlg-unlock').showModal();
  const bio = bioReady(w.id);
  $('ul-bio').hidden = !bio;
  if (bio) bioFill('ul', w.id); else $('ul-pass').focus();
}

$('ul-form').addEventListener('submit', async (e) => {
  e.preventDefault(); err('ul-error');
  await busy($('ul-submit'), async () => {
    try {
      if (!(await closeOpenFirst())) return;
      await invoke('wallet_open', { id: state.unlockId, password: $('ul-pass').value });
      $('ul-pass').value = ''; $('dlg-unlock').close();
      state.status = await invoke('status'); enterWallet();
    } catch (x) { bioStale('ul', state.unlockId, x); err('ul-error', E(x)); $('ul-pass').select(); }
  });
});

// ------------------------------------------------------------------ create / restore / import
const FORM = {
  create: { title: 'Yeni cüzdan', desc: 'Bu parola cüzdan dosyanı bu bilgisayarda şifreler. Unutursan cüzdanı yalnızca kurtarma ifadesiyle açabilirsin.', submit: 'Oluştur', hint: '' },
  // Import = from the recovery phrase (numbered boxes); Restore = from a wallet folder (desktop only).
  seed: { title: 'Cüzdanı içe aktar', desc: 'grin-wallet, Grim ya da bu uygulamadan aldığın kurtarma ifadesi çalışır; adresin aynı kalır.', submit: 'İçe aktar', hint: 'Geri yüklemeden sonra zincir taranır; uzak node ile birkaç dakika sürebilir.' },
  folder: { title: 'Klasörden geri yükle', desc: 'grin-wallet ya da Grim cüzdan klasörünü kopyalayarak açar. Parola o cüzdanın mevcut parolasıdır.', submit: 'Geri yükle', hint: '' },
};
function openForm(mode) {
  if (mode === 'folder' && document.documentElement.dataset.platform === 'mobile') mode = 'seed'; // no folder restore on phones
  state.formMode = mode;
  const f = FORM[mode];
  $('wf-title').textContent = t(f.title); $('wf-desc').textContent = t(f.desc);
  $('wf-submit').textContent = t(f.submit); $('wf-hint').textContent = t(f.hint);
  $('wf-words-f').hidden = mode !== 'seed';
  $('wf-since-f').hidden = mode !== 'seed';
  $('wf-len-f').hidden = mode !== 'create'; $('wf-len').value = '24';
  fillSince($('wf-since'), true);
  $('wf-since').value = 'all';
  $('wf-path-f').hidden = mode !== 'folder';
  $('wf-pass2-f').hidden = mode === 'folder';
  $('wf-pass-l').textContent = mode === 'folder' ? t('Cüzdanın parolası') : t('Parola');
  ['wf-name', 'wf-path', 'wf-pass', 'wf-pass2'].forEach((id) => { $(id).value = ''; });
  if (mode === 'seed') buildSeedGrid(24, false);
  $('wf-conn').value = 'auto';
  err('wf-error'); closeDialogs(); show('form'); $('wf-name').focus();
}

// ---- recovery phrase entry: numbered boxes, a word-count switch and a paste button
const SEED_LENS = [12, 15, 18, 21, 24];
let seedLen = 24;
const seedBoxes = () => [...$('wf-grid').querySelectorAll('input')];
function buildSeedGrid(n, keep) {
  const old = keep ? seedBoxes().map((i) => i.value) : [];
  seedLen = n;
  const grid = $('wf-grid'); grid.replaceChildren();
  for (let i = 0; i < n; i++) {
    const cell = el('label', 'seed-cell'); cell.append(el('i', '', String(i + 1)));
    const inp = el('input'); inp.type = 'text'; inp.value = old[i] || ''; inp.dataset.i = String(i);
    inp.autocomplete = 'off'; inp.spellcheck = false; inp.autocapitalize = 'off'; inp.setAttribute('autocorrect', 'off');
    inp.setAttribute('aria-label', t('{n}. kelime', { n: i + 1 }));
    inp.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
      if (/\s/.test(text.trim())) { e.preventDefault(); fillSeed(text, i); }
    });
    inp.addEventListener('input', () => {
      if (/\s/.test(inp.value.trim())) { fillSeed(inp.value, i); return; } // a typed or auto-filled "word word"
      if (/\s$/.test(inp.value)) { inp.value = inp.value.trim(); seedBoxes()[i + 1]?.focus(); } // space = next box
      inp.removeAttribute('aria-invalid');
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const nx = seedBoxes()[i + 1]; if (nx) nx.focus(); else $('wf-pass').focus(); }
      else if (e.key === 'Backspace' && !inp.value && i > 0) { e.preventDefault(); seedBoxes()[i - 1].focus(); }
    });
    cell.append(inp); grid.append(cell);
  }
  const bar = $('wf-count'); bar.replaceChildren();
  SEED_LENS.forEach((k) => {
    const bt = el('button', '', String(k)); bt.type = 'button'; bt.setAttribute('aria-pressed', String(k === n));
    bt.title = t('{n} kelime', { n: k });
    bt.addEventListener('click', () => buildSeedGrid(k, true));
    bar.append(bt);
  });
}
/** Spread pasted text over the boxes from box `from`. Numbers and punctuation are ignored; a full phrase at box 1 picks the matching length. */
function fillSeed(text, from) {
  const words = String(text).toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (!words.length) return;
  err('wf-error');
  if (from === 0 && words.length > 1 && !SEED_LENS.includes(words.length)) { // not a recovery phrase: leave the boxes alone
    return err('wf-error', t('Yapıştırdığın metinde {n} kelime var; kurtarma ifadesi 12, 15, 18, 21 ya da 24 kelime olur.', { n: words.length }));
  }
  if (from === 0 && words.length > 1 && words.length !== seedLen) buildSeedGrid(words.length, false);
  const boxes = seedBoxes();
  words.slice(0, boxes.length - from).forEach((w, k) => { boxes[from + k].value = w; boxes[from + k].removeAttribute('aria-invalid'); });
  if (words.length > boxes.length - from) {
    err('wf-error', t('Yapıştırdığın metinde {n} kelime var; kurtarma ifadesi 12, 15, 18, 21 ya da 24 kelime olur.', { n: words.length }));
  }
  boxes[Math.min(from + words.length, boxes.length - 1)].focus();
}
async function readClipboardText() {
  try { if (window.OrkoAndroid && window.OrkoAndroid.readClipboard) return String(window.OrkoAndroid.readClipboard() || ''); } catch { /* fall through */ }
  return navigator.clipboard.readText();
}
$('wf-paste').addEventListener('click', async () => {
  let text = '';
  try { text = await readClipboardText(); } catch { return toast(t('Panoya erişilemedi; ilk kutuya yapıştır (Ctrl+V ya da uzun basış).')); }
  if (!/[a-zA-Z]/.test(text)) return toast(t('Panoda kurtarma ifadesi yok.'));
  fillSeed(text, 0);
});
$('wf-clear').addEventListener('click', () => { buildSeedGrid(seedLen, false); err('wf-error'); seedBoxes()[0].focus(); });

/** "Since when" choices for restore / repair: from the start, a year, or (restore only) never. */
function fillSince(select, withNever) {
  select.replaceChildren();
  const opt = (v, text) => { const o = el('option', '', text); o.value = v; select.append(o); };
  const years = () => {
    const net = state.status?.network;
    if (net !== 'mainnet' && !(net === 'testnet' && !withNever)) return;
    for (let y = new Date().getFullYear(); y >= 2020; y--) opt(String(y), t('{y} veya sonrasında', { y }));
  };
  if (withNever) { // restoring: when unsure, the whole chain is the safe choice
    opt('all', t('Bilmiyorum / emin değilim: en baştan (en uzun, en güvenli)'));
    years();
    opt('never', t('Bu cüzdan hiç kullanılmadı (tarama yok)'));
  } else { // repairing an open wallet: start with the latest year (fastest), the whole chain last
    years();
    opt('all', t('En baştan (en uzun)'));
  }
  select.value = select.options[0].value;
}

$('wf').addEventListener('submit', async (e) => {
  e.preventDefault(); err('wf-error');
  const mode = state.formMode;
  const name = $('wf-name').value.trim() || t('Cüzdan');
  const password = $('wf-pass').value, connection = $('wf-conn').value;
  let phrase = '';
  if (mode === 'seed') {
    const boxes = seedBoxes();
    const empty = boxes.filter((i) => !i.value.trim());
    if (empty.length) {
      empty.forEach((i) => i.setAttribute('aria-invalid', 'true')); empty[0].focus();
      return err('wf-error', t('Tüm kutuları doldur ({n} / {m}).', { n: boxes.length - empty.length, m: boxes.length }));
    }
    phrase = boxes.map((i) => i.value.trim().toLowerCase()).join(' ');
  }
  if (mode !== 'folder') {
    if (password.length < 4) return err('wf-error', t('Parola en az 4 karakter olmalı.'));
    if (password !== $('wf-pass2').value) return err('wf-error', t('Parolalar aynı değil.'));
  }
  await busy($('wf-submit'), async () => {
    try {
      if (!(await closeOpenFirst())) return;
      if (mode === 'create') {
        state.createdWords = await invoke('wallet_create', { name, password, connection, words: Number($('wf-len').value) || 24 });
        showWords();
      } else if (mode === 'seed') {
        await invoke('wallet_restore', { name, password, words: phrase, connection, since: $('wf-since').value });
        state.status = await invoke('status'); enterWallet();
      } else {
        await invoke('wallet_import', { name, path: $('wf-path').value, password, connection });
        state.status = await invoke('status'); enterWallet();
      }
      ['wf-pass', 'wf-pass2'].forEach((id) => { $(id).value = ''; });
      if (mode === 'seed') buildSeedGrid(seedLen, false); // the words do not stay in the page
    } catch (x) { err('wf-error', E(x)); }
  });
});

function showWords() {
  protect(true);
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
  protect(false);
  state.status = await invoke('status'); enterWallet();
});

// ------------------------------------------------------------------ open wallet
let walletTimers = [];
/** Keep secrets out of screenshots and screen recordings (desktop window flag, Android FLAG_SECURE). */
function protect(on) {
  invoke('set_protected', { on });
  try { if (window.OrkoAndroid) window.OrkoAndroid.setSecure(on); } catch { /* not on Android */ }
}
/** Android: while a wallet is open a foreground service keeps the app (and its Tor address) alive in the background. */
function androidKeepAlive(on) {
  try {
    if (!window.OrkoAndroid) return;
    const title = t('OrkoWallet çalışıyor');
    const text = t('Tor üzerinden ödeme alabilmen için açık tutuluyor. Tamamen kapatmak için “Cüzdanı kapat”a bas.');
    if (!on) window.OrkoAndroid.serviceOff();
    else if (window.OrkoAndroid.serviceStart) window.OrkoAndroid.serviceStart(title, text, t('Cüzdanı kapat'));
    else window.OrkoAndroid.serviceOn(title, text);
  } catch { /* not on Android */ }
}
/** Quit for good: close the wallet and Tor cleanly, then end the app. Android calls this from the
 *  notification's "Close wallet" button; Settings > General has the same button. */
let quitting = false;
async function quitApp() {
  if (quitting) return;
  quitting = true;
  toast(t('Cüzdan kapanıyor…'));
  try { await invoke('app_shutdown'); } catch { /* end the app anyway */ }
  try { if (window.OrkoAndroid && window.OrkoAndroid.exitApp) { window.OrkoAndroid.exitApp(); return; } } catch { /* fall through */ }
  invoke('close_choice', { choice: 'quit', remember: false });
}
window.orkoQuit = quitApp;
function enterWallet() {
  state.open = state.status.open_wallet;
  androidKeepAlive(true);
  ['wallet-label', 'tor-pill', 'btn-lock', 'btn-logout'].forEach((id) => { $(id).hidden = false; });
  $('ws-name').textContent = state.open.name;
  fillWalletSettings();
  syncTorForm();
  show('wallet');
  refresh(); pollTor();
  walletTimers.forEach(clearInterval);
  fillSince($('rescan-since'), false);
  pollScan();
  const every = (fn, ms) => setInterval(() => { if (!document.hidden && !locked) fn(); }, ms);
  // A phone asks less often: every call wakes the app, and the screen rarely shows anything that fast.
  const k = PHONE.matches ? 2.5 : 1;
  walletTimers = [every(pollTor, 3000 * k), every(refresh, 30000 * (PHONE.matches ? 2 : 1)), every(watchPending, 4000 * k), every(pollScan, 3000 * k), every(pollJobs, 5000 * k)];
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
    // Money of this wallet was just spent on another device: warn once per event (remembered per wallet).
    const seenKey = `orko.elsewhere.${state.open?.id}`;
    let seenAt = 0;
    try { seenAt = Number(localStorage.getItem(seenKey) || 0); } catch { /* private mode */ }
    $('elsewhere-warn').hidden = !(o.elsewhere_at > seenAt);
    $('elsewhere-warn').dataset.at = String(o.elsewhere_at || 0);
  } catch (x) { toast(E(x)); }
  try { renderTxs(await invoke('transactions')); } catch { /* shown via overview */ }
}
$('btn-refresh').addEventListener('click', refresh);
$('elsewhere-ok').addEventListener('click', () => {
  try { localStorage.setItem(`orko.elsewhere.${state.open?.id}`, $('elsewhere-warn').dataset.at || '0'); } catch { /* private mode */ }
  $('elsewhere-warn').hidden = true;
});
$('tc-copy').addEventListener('click', () => copy($('tc-addr').textContent));
$('tc-onion-copy').addEventListener('click', () => copy($('tc-onion').textContent));
document.querySelector('[data-qr-toggle="tc-qr"]').addEventListener('click', async () => {
  if (state.overview) $('tc-qr').innerHTML = await invoke('address_qr', { text: state.overview.address });
});

// ------------------------------------------------------------------ fingerprint (Android)
// The Kotlin side keeps the wallet password encrypted under a key that only a fingerprint can use (see BioLock.kt).
const BIO = window.OrkoAndroid && window.OrkoAndroid.bioAvailable ? window.OrkoAndroid : null;
const bioWaits = new Map();
let bioSeq = 0;
window.orkoBio = (req, r) => { const f = bioWaits.get(req); if (f) { bioWaits.delete(req); f(r); } };
const bioCall = (fn, ...args) => new Promise((res) => {
  const req = `b${++bioSeq}`; bioWaits.set(req, res);
  try { BIO[fn](req, ...args); } catch { bioWaits.delete(req); res({ ok: false }); }
});
const bioReady = (id) => { try { return !!BIO && !!id && BIO.bioAvailable() && BIO.bioHas(id); } catch { return false; } };
const bioFilled = {}; // which form got its password from the fingerprint
/** Ask for the fingerprint; on success put the password in the form and submit it like a typed one. */
async function bioFill(prefix, id) {
  const r = await bioCall('bioUnlock', id, t('Parmak iziyle aç'), t('Parolayı kullan'));
  if (!r.ok || !r.secret) { if (!$(`${prefix}-bio`).hidden) $(`${prefix}-pass`).focus(); return; }
  $(`${prefix}-pass`).value = r.secret; bioFilled[prefix] = true;
  $(`${prefix}-form`).requestSubmit();
}
/** The stored password stopped working (it was changed elsewhere): forget it and say so. */
function bioStale(prefix, id, x) {
  if (!bioFilled[prefix]) return;
  bioFilled[prefix] = false;
  if (String(x?.message ?? x).includes('Parola yanlış')) {
    try { BIO.bioRemove(id); } catch { /* ignore */ }
    $(`${prefix}-bio`).hidden = true;
    toast(t('Parmak izi kapatıldı: parola değişmiş. Parolayı yaz.'));
  }
}
['lk', 'ul'].forEach((p) => $(`${p}-pass`).addEventListener('input', () => { bioFilled[p] = false; }));
$('lk-bio').addEventListener('click', () => bioFill('lk', state.open.id));
$('ul-bio').addEventListener('click', () => bioFill('ul', state.unlockId));

function syncBioForm() {
  let ok = false;
  try { ok = !!BIO && !!state.open && BIO.bioAvailable(); } catch { /* ignore */ }
  $('bio-box').hidden = !ok;
  if (!ok) return;
  $('bio-on').checked = bioReady(state.open.id);
  $('bio-pw').hidden = true; $('bio-pass').value = ''; err('bio-error');
}
$('bio-on').addEventListener('change', () => {
  if ($('bio-on').checked) { $('bio-pw').hidden = false; $('bio-pass').focus(); return; }
  try { BIO.bioRemove(state.open.id); } catch { /* ignore */ }
  $('bio-pw').hidden = true; toast(t('Parmak izi kapatıldı'));
});
$('bio-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('bio-go').click(); } });
$('bio-go').addEventListener('click', async () => {
  err('bio-error');
  await busy($('bio-go'), async () => {
    const pw = $('bio-pass').value;
    try { await invoke('verify_password', { password: pw }); } catch (x) { err('bio-error', E(x)); return; }
    const r = await bioCall('bioEnroll', state.open.id, pw, t('Parmak izini onayla'), t('Vazgeç'));
    $('bio-pass').value = ''; $('bio-pw').hidden = true;
    if (r.ok) toast(t('Parmak izi açıldı'));
    else { $('bio-on').checked = false; toast(t('Parmak izi açılamadı')); }
  });
});

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
  const bio = bioReady(state.open.id);
  $('lk-bio').hidden = !bio;
  if (bio) bioFill('lk', state.open.id); else $('lk-pass').focus();
}
/** Log out: back to the wallet list WITHOUT locking. The wallet stays open in the background (Tor, receiving, the
 *  Android service keep running); "Gir" on the list returns to it without a password. */
function logout() {
  if (!state.open || locked) return;
  closeDialogs();
  renderWallets();
}
/** Close the wallet completely (Tor address goes offline), then show the list. */
async function closeWallet() {
  toast(t('Cüzdan kapanıyor…'));
  let restarted;
  try { restarted = await invoke('wallet_close'); } catch (x) { toast(E(x)); return; }
  if (!restarted) leaveWallet(); // true: the app restarts itself (a scan or Arti listener was running)
}
/** Close a wallet that waits in the background before another one is created or opened. false = the app is restarting. */
async function closeOpenFirst() {
  if (!state.status?.open_wallet) return true;
  const restarted = await invoke('wallet_close');
  if (restarted) { toast(t('Uygulama yeniden başlıyor…')); return false; }
  resetOpenState();
  return true;
}
function resetOpenState() {
  walletTimers.forEach(clearInterval); walletTimers = [];
  androidKeepAlive(false);
  locked = false; $('lockscreen').hidden = true; closeDialogs();
  state.open = null; state.overview = null; state.pendingSlate = null;
  if (state.status) state.status.open_wallet = null;
}
/** Back to the wallet list after the wallet was closed completely. */
async function leaveWallet() {
  resetOpenState();
  state.status = await invoke('status');
  renderWallets();
}
$('btn-lock').addEventListener('click', lockScreen);
$('btn-logout').addEventListener('click', logout);
$('lk-logout').addEventListener('click', closeWallet);
$('lk-form').addEventListener('submit', async (e) => {
  e.preventDefault(); err('lk-error');
  await busy($('lk-submit'), async () => {
    try {
      await invoke('verify_password', { password: $('lk-pass').value });
      $('lk-pass').value = ''; $('lockscreen').hidden = true; locked = false; lastActive = Date.now();
    } catch (x) { bioStale('lk', state.open?.id, x); err('lk-error', E(x)); $('lk-pass').select(); }
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
  [3, 6, 12].forEach((n) => opt(n * 60, t('{n} saat', { n })));
}

// ------------------------------------------------------------------ transactions
const ICON_IN = '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_EXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_X ='<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
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

/** An output the chain scan found (restore / repair): it has no transaction id, and the scan cannot know
 *  which payment it came from, nor anything about payments that went out. */
const fromScan = (x) => x.incoming && !x.slate_id && x.kind === 'TxReceived';
/** Money of this wallet that another device (same recovery phrase) spent; made up by the backend from spent outputs. */
const elsewhere = (x) => x.kind === 'SpentElsewhere';
function txTitle(x) {
  const job = state.jobs[x.slate_id];
  if (x.cancelled && job && job.state === 'failed') return t('Gönderim başarısız');
  if (x.cancelled) return x.incoming ? t('Alma iptal edildi') : t('Gönderim iptal edildi');
  if (x.kind === 'ConfirmedCoinbase') return t('Madencilik ödülü');
  if (fromScan(x)) return t('Taramayla bulundu');
  if (elsewhere(x)) return t('Başka bir cihazda harcandı');
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
const TX_PHONE_PAGE = 8; // on a phone the page scrolls, so the list has a fixed page size
const txView = { filter: 'all', page: 0, size: PHONE.matches ? TX_PHONE_PAGE : 1 };
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
    const meta = el('div', 'tx-meta', elsewhere(x) ? t('fark edildi {date}', { date: fmtDate(x.time) }) : fmtDate(x.time));
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
  if (!measured && slice.length && !PHONE.matches) {
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
window.addEventListener('resize', () => { clearTimeout(txResize); txResize = setTimeout(() => { txView.size = PHONE.matches ? TX_PHONE_PAGE : 1; txSig = ''; renderTxs(); }, 120); });

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
  const kv2 = $('tx-kv2'); kv2.replaceChildren(); $('tx-more').hidden = true; $('tx-more').open = false;
  const put = (box) => (k, v) => { if (!v && v !== 0) return; box.append(el('dt', '', t(k)), el('dd', '', String(v))); };
  const add = put(kv);
  if (elsewhere(x)) return showElsewhere(x, add);
  // First what matters: state, amount, fee, when. The technical rest is folded away.
  add('Durum', txStatus(x));
  add('Tutar', `${x.incoming ? '+' : '−'}${amt(x.amount)} ツ`);
  if (!x.incoming && x.fee) add('Ağ ücreti', `${x.fee} ツ`);
  add(x.confirmed_time ? 'Onaylandı' : 'Oluşturuldu', fmtDate(x.confirmed_time || x.time));
  const more = put(kv2);
  if (x.confirmed_time) more('Oluşturuldu', fmtDate(x.time));
  more('Girdi / çıktı', `${x.inputs} / ${x.outputs}`);
  if (x.ttl_height) more('Geçerlilik (blok)', fmtNum(x.ttl_height));
  more('İşlem kimliği', x.slate_id);
  more('Kernel', x.kernel);
  if (x.kernel && state.status.network === 'mainnet') { // link to the block explorer, next to the kernel text
    const dd = kv2.lastElementChild;
    const a = el('button', 'kernel-link'); a.type = 'button';
    a.title = t('Grin Scan\'de aç'); a.setAttribute('aria-label', t('Grin Scan\'de aç'));
    a.innerHTML = ICON_EXT;
    a.addEventListener('click', async () => {
      try {
        const url = await invoke('open_kernel', { kernel: x.kernel });
        // Android: the WebView cannot open the system browser itself; the bridge does (Grin Scan pages only).
        if (window.OrkoAndroid && window.OrkoAndroid.openUrl && !window.OrkoAndroid.openUrl(url)) toast(t('Tarayıcı açılamadı'));
      } catch (e) { toast(E(e)); }
    });
    dd.append(' ', a);
  }
  more('Yerel no', x.id);
  $('tx-more').hidden = !kv2.children.length;
  if (fromScan(x)) {
    kv.append(el('dt', '', t('Not')), el('dd', '', t('Zincir taramasıyla bulundu. Tarama yalnızca şu an sahip olduğun parayı görür; giden ödemeler yalnızca onları yapan cihazda listelenir.')));
  }
  $('tx-title').textContent = txTitle(x);
  $('tx-proof-box').hidden = true;
  $('tx-proof-btn').hidden = !(x.has_proof && !x.incoming);
  $('tx-repost').hidden = !(x.finalized && !x.confirmed && !x.cancelled && x.has_stored_tx);
  $('tx-cancel').hidden = x.confirmed || x.cancelled || !x.slate_id;
  err('tx-error');
  showTxSlatepack(x);
  $('dlg-tx').showModal();
});

/** Details of a "spent on another device" entry: what is known, and what cannot be known here. */
function showElsewhere(x, add) {
  add('Tutar', `−${amt(x.amount)} ツ`);
  add('Harcanan çıktı', x.inputs);
  add(x.early ? 'İlk kontrol' : 'Fark edildi', fmtDate(x.time));
  $('tx-kv').append(el('dt', '', t('Not')), el('dd', '', t('Bu para başka bir cihazda (aynı kurtarma ifadesiyle) harcandı. Alıcı, ağ ücreti ve tam tarih yalnızca o cihazda kayıtlı. Kalan para üstü bu cüzdana döndüyse ayrıca “Taramayla bulundu” olarak görünür.')));
  $('tx-title').textContent = txTitle(x);
  ['tx-proof-box', 'tx-proof-btn', 'tx-repost', 'tx-cancel', 'tx-sp'].forEach((id) => { $(id).hidden = true; });
  err('tx-error');
  $('dlg-tx').showModal();
}

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
    const all = await invoke('accounts');
    const hiddenN = all.filter((a) => a.hidden).length;
    const list = all.filter((a) => !a.hidden || showHiddenAccounts);
    const ul = $('acc-list'); ul.replaceChildren();
    list.forEach((a) => {
      const li = el('li', a.hidden ? 'acc-hidden' : '');
      const left = el('div');
      const name = el('div', 'tx-title', a.label);
      if (a.active) name.append(el('span', 'badge active', t('Etkin')));
      left.append(name, el('div', 'p', a.path));
      li.append(left);
      const acts = el('div', 'acc-acts');
      if (!a.active && !a.hidden) {
        const b = el('button', 'btn btn-sm', t('Etkinleştir')); b.type = 'button';
        b.addEventListener('click', () => busy(b, async () => {
          try { await invoke('account_set', { label: a.label }); toast(t('“{name}” hesabı etkin; Tor adresi değişti', { name: a.label })); loadAccounts(); refresh(); }
          catch (x) { err('acc-error', E(x)); }
        }));
        acts.append(b);
      }
      if (!a.active && a.label !== 'default') {
        const h = el('button', `btn btn-sm${a.hidden ? '' : ' danger-text'}`, a.hidden ? t('Listeye geri al') : t('Listeden kaldır')); h.type = 'button';
        h.title = t('Hesap yalnızca gizlenir; parası ve adresi kaybolmaz.');
        h.addEventListener('click', () => busy(h, async () => {
          try { await invoke('account_hide', { label: a.label, hide: !a.hidden }); loadAccounts(); }
          catch (x) { err('acc-error', E(x)); }
        }));
        acts.append(h);
      }
      if (acts.childElementCount) li.append(acts);
      ul.append(li);
    });
    const tog = $('acc-hidden-toggle');
    tog.hidden = hiddenN === 0;
    tog.textContent = showHiddenAccounts ? t('Gizli hesapları sakla') : t('Gizli hesapları göster ({n})', { n: hiddenN });
  } catch (x) { err('acc-error', E(x)); }
}
let showHiddenAccounts = false;
$('acc-hidden-toggle').addEventListener('click', () => { showHiddenAccounts = !showHiddenAccounts; loadAccounts(); });
$('acc-form').addEventListener('submit', async (e) => {
  e.preventDefault(); err('acc-error');
  const label = $('acc-name').value.trim();
  if (!label) return err('acc-error', t('Hesap adı yaz.'));
  try { await invoke('account_create', { label }); $('acc-name').value = ''; loadAccounts(); }
  catch (x) { err('acc-error', E(x)); }
});

// ------------------------------------------------------------------ wallet settings (Settings > Wallet)
function fillWalletSettings() {
  if (!state.open) return;
  $('ws-f-name').value = state.open.name;
  err('ws-error');
}
$('ws-rename').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  err('ws-error');
  const name = $('ws-f-name').value.trim();
  if (!name) return err('ws-error', t('Cüzdan adı yaz.'));
  try {
    await invoke('wallet_update', { id: state.open.id, name, connection: state.open.connection, customUrl: state.open.custom_url || '' });
    state.status = await invoke('status'); state.open = state.status.open_wallet;
    $('ws-name').textContent = state.open.name; toast(t('Kaydedildi'));
  } catch (x) { err('ws-error', E(x)); }
}));
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
    try {
      await invoke('change_password', { old: $('pw-old').value, new: n });
      try { if (state.open) window.OrkoAndroid?.bioRemove?.(state.open.id); } catch { /* not on Android */ }
      $('dlg-password').close(); toast(t('Parola değiştirildi'));
    }
    catch (x) { err('pw-error', E(x)); }
  });
});

$('ph-form').addEventListener('submit', async (e) => {
  e.preventDefault(); err('ph-error');
  await busy($('ph-submit'), async () => {
    try {
      const words = await invoke('show_phrase', { password: $('ph-pass').value });
      $('ph-pass').value = '';
      protect(true);
      const g = $('ph-words'); g.replaceChildren(); words.forEach((w) => g.append(el('li', '', w)));
      $('ph-ask').hidden = true; g.hidden = false; $('ph-after').hidden = false;
    } catch (x) { err('ph-error', E(x)); }
  });
});
$('dlg-phrase').addEventListener('close', () => { protect(false); $('ph-words').replaceChildren(); $('ph-words').hidden = true; $('ph-after').hidden = true; $('ph-ask').hidden = false; });

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
let scanShown = 0;      // the percentage shown: never goes back during one scan
let scanEta = null;     // the remaining minutes shown: only goes down, so it does not jump about
let scanSamples = [];   // [time, percent] over the last minutes, for a steady speed
async function pollScan() {
  let s;
  try { s = await invoke('scan_status'); } catch { return; }
  const banner = $('scan-banner');
  if (s.active) {
    const now = Date.now();
    if (!scanStartedAt) { scanStartedAt = now; scanShown = 0; scanEta = null; scanSamples = []; }
    scanShown = Math.max(scanShown, Math.min(99, Math.max(0, s.progress)));
    const p = scanShown;
    scanSamples.push([now, p]);
    scanSamples = scanSamples.filter(([t0]) => now - t0 <= 5 * 60000);
    let eta = '';
    const [t0, p0] = scanSamples[0];
    if (now - t0 >= 30000 && p > p0) { // at least 30 s of movement: speed over the window, not since the start
      const left = ((100 - p) / ((p - p0) / (now - t0))) / 60000;
      scanEta = scanEta === null ? left : Math.min(scanEta, left);
      const m = Math.max(1, Math.round(scanEta));
      eta = t(' · yaklaşık {n} dk kaldı', { n: m });
    } else if (scanEta !== null) {
      eta = t(' · yaklaşık {n} dk kaldı', { n: Math.max(1, Math.round(scanEta)) });
    }
    banner.hidden = false; banner.dataset.state = '';
    $('scan-text').textContent = t('Eski işlemlerin taranıyor: %{p}{eta}. Bu sırada bakiye eksik görünebilir; cüzdanı kullanmaya devam edebilirsin.', { p, eta });
    $('scan-fill').style.width = `${p}%`;
    return;
  }
  scanStartedAt = 0; scanEta = null; scanSamples = [];
  if (s.finished_at && s.finished_at !== scanSeen) {
    scanSeen = s.finished_at;
    if (s.error) {
      banner.hidden = false; banner.dataset.state = 'error';
      $('scan-text').textContent = t('Tarama yarıda kaldı: {e}. Cüzdanı yeniden açınca kaldığı yerden sürer; ya da Ayarlar > Bakım ve onarım bölümünden yeniden başlat.', { e: E(s.error) });
    } else {
      $('scan-fill').style.width = '100%';
      banner.hidden = true; toast(t('Tarama bitti, bakiye güncel')); refresh();
    }
    return;
  }
  if (!s.error) banner.hidden = true;
}

// ------------------------------------------------------------------ tor
const slatepackOnly = () => !!state.status?.settings?.tor_off;
function torView(x) {
  if (slatepackOnly()) return { state: 'off', chip: t('Slatepack'), text: t('Slatepack modu'), note: t('Tor kapalı (yalnızca Slatepack modu). Ödemeler Slatepack metniyle gönderilir ve alınır: gönderen sana bir metin verir, sen yanıtı geri verirsin. Adresini yine paylaşabilirsin; Slatepack metinleri ona göre şifrelenir.'), progress: false };
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
  syncTorMode();
  const title = slatepackOnly() ? t('Slatepack adresin') : t('Tor adresin');
  if ($('tc-title').textContent !== title) $('tc-title').textContent = title;
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
}$('tor-pill').addEventListener('click', () => {
  if (PHONE.matches) { setMobileTab('tor'); return; } // phone: the pill opens the Tor tab
  $('tc-addr').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

function syncTorMode() {
  const off = slatepackOnly();
  document.querySelectorAll('#tor-mode [data-tm], #set-tor-mode [data-tm]').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.tm === 'off') === off)));
  $('tor-on-only').hidden = off;
  $('tor-mode-hint').textContent = off
    ? t('Tor hiç çalışmaz; Tor adresin çevrimdışıdır. Node bağlantısı için internet yine gerekir.')
    : t('Ödemeler Tor üzerinden doğrudan gelir ve gider. Tor engelliyse ya da kullanmak istemiyorsan “Yalnızca Slatepack”i seç.');
}
async function onTorModeClick(e) {
  const b = e.target.closest('[data-tm]'); if (!b) return;
  const off = b.dataset.tm === 'off';
  if (off === slatepackOnly()) return;
  err('tor-error');
  try {
    const applied = await invoke('tor_mode', { off });
    state.status = await invoke('status');
    syncTorMode(); pollTor();
    toast(!applied ? t('Değişiklik cüzdan yeniden açılınca geçerli olur') : off ? t('Tor kapatıldı: yalnızca Slatepack') : t('Tor açılıyor; adresin birkaç dakikada çevrimiçi olur'));
  } catch (x) { err('tor-error', E(x)); toast(E(x)); }
}
$('tor-mode').addEventListener('click', onTorModeClick);
$('set-tor-mode').addEventListener('click', onTorModeClick);
function syncTorForm() {
  syncTorMode();
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
  document.querySelectorAll('#mnav [data-mtab]').forEach((b) => b.addEventListener('click', () => setMobileTab(b.dataset.mtab)));
  $('win-min').addEventListener('click', () => invoke('win_min'));
  $('win-max').addEventListener('click', () => invoke('win_max'));
  $('win-close').addEventListener('click', () => invoke('win_close'));
// X button / Alt+F4 with "ask" on: the Rust side keeps the window and sends "close-ask".
function askClose() { closeDialogs(); $('cl-remember').checked = false; $('dlg-close').showModal(); $('cl-min').focus(); }
try { window.__TAURI__.event.listen('close-ask', askClose); } catch { /* not on the desktop shell */ }
// Android: the backend cannot relaunch the app by itself (network change, repair); MainActivity does it.
try {
  window.__TAURI__.event.listen('restart-app', () => {
    toast(t('Uygulama yeniden başlıyor…'));
    try { if (window.OrkoAndroid && window.OrkoAndroid.restartApp) window.OrkoAndroid.restartApp(); } catch { /* not on Android */ }
  });
} catch { /* no event bus */ }
const closeChoice = (choice) => { const remember = $('cl-remember').checked; $('dlg-close').close(); invoke('close_choice', { choice, remember }); };
$('cl-quit').addEventListener('click', () => closeChoice('quit'));
$('cl-min').addEventListener('click', () => closeChoice('tray'));
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

// ------------------------------------------------------------------ fast sync (opt-in snapshot for the built-in node)
let fsTimer = 0;
async function fsRefresh() {
  let v;
  try { v = await invoke('fastsync_view'); } catch { return; }
  const gb = (n) => (n / 1e9).toFixed(1);
  const pct = v.total ? Math.min(100, Math.floor((v.done / v.total) * 100)) : 0;
  $('fs-bar').hidden = !(v.active && v.total);
  $('fs-bar-fill').style.width = `${pct}%`;
  let msg = '';
  if (v.phase === 'find') msg = t('Sunucular kontrol ediliyor…');
  else if (v.phase === 'download') msg = t('İndiriliyor: {a} / {b} GB ({host})', { a: gb(v.done), b: gb(v.total), host: v.host });
  else if (v.phase === 'unpack') msg = t('Açılıyor… %{p}', { p: pct });
  else if (v.phase === 'swap') msg = t('Yerleştiriliyor…');
  else if (v.phase === 'done') msg = t('Hazır. Node başlatıldı, son blokları tamamlıyor.');
  else if (v.phase === 'paused') msg = t('Durduruldu. Tekrar başlatırsan kaldığı yerden devam eder.');
  $('fs-state').textContent = msg;
  $('fs-error').textContent = v.phase === 'failed' ? t('Olmadı: {e}. Normal eşitleme etkilenmedi.', { e: v.error }) : '';
  $('fs-go').disabled = v.active;
  $('fs-cancel').hidden = !v.active;
  if (v.active && !fsTimer) fsTimer = setInterval(fsRefresh, 1500);
  if (!v.active && fsTimer) { clearInterval(fsTimer); fsTimer = 0; }
}
let fsArmed = 0;
$('fs-go').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  if (!fsArmed) { // second tap confirms: it replaces a half-synced chain
    b.textContent = t('Emin misin? Tekrar dokun');
    fsArmed = setTimeout(() => { fsArmed = 0; b.textContent = t('Anlık görüntüden indir'); }, 5000);
    return;
  }
  clearTimeout(fsArmed); fsArmed = 0; b.textContent = t('Anlık görüntüden indir');
  $('fs-error').textContent = '';
  try { await invoke('fastsync_start'); fsRefresh(); } catch (x) { $('fs-error').textContent = E(x); }
});
$('fs-cancel').addEventListener('click', async () => { try { await invoke('fastsync_cancel'); } catch { /* ignore */ } });

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
    try { renderNodeList(await invoke('node_add', { url })); $('nd-new').value = ''; toast(t('Node eklendi')); }
    catch (x) { err('nd-list-error', E(x)); }
  });
});
$('nd-check').addEventListener('click', (e) => busy(e.currentTarget, () => loadNodeList(true)));
$('nd-auto-pick').addEventListener('click', async () => {
  try { renderNodeList(await invoke('node_use', { url: null })); toast(t('Otomatik seçim açık')); } catch (x) { err('nd-list-error', E(x)); }
});

// ---- this wallet's connection: pool / one node / own node
function fillConnTab() {
  const w = state.open;
  $('nd-conn-note').hidden = true; err('nd-conn-error');
  if (!w) return;
  const mode = w.connection === 'integrated' ? 'integrated' : w.connection === 'custom' ? 'custom' : 'auto';
  document.querySelectorAll('input[name="ndconn"]').forEach((r) => { r.checked = r.value === mode; });
  invoke('nodes_list').then((list) => {
    const sel = $('nd-conn-url'); sel.replaceChildren();
    list.forEach((n) => { const o = el('option', '', n.url); o.value = n.url; sel.append(o); });
    if (w.custom_url) sel.value = w.custom_url;
    showConnUrl(mode === 'custom');
  }).catch(() => {});
}
/** The node list for "one node" is only shown with that choice (the select sits inside a themed drop-down). */
function showConnUrl(on) { const s = $('nd-conn-url'); (s.closest('.dd') || s).hidden = !on; }
document.querySelectorAll('input[name="ndconn"]').forEach((r) => r.addEventListener('change', () => {
  showConnUrl(document.querySelector('input[name="ndconn"]:checked').value === 'custom');
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
        const b = el('button', 'link', t('Şimdi kapat')); b.type = 'button'; b.addEventListener('click', closeWallet); note.append(b);
      } else toast(t('Kaydedildi'));
      fillWalletSettings();
    } catch (x) { err('nd-conn-error', E(x)); }
  });
});

// ------------------------------------------------------------------ dialogs
function openDialog(name) {
  if (name === 'settings' || name.startsWith('settings:') || name === 'node') {
    return openSettings(name === 'node' ? 'node' : name.split(':')[1] || null);
  }
  if (name === 'password') { ['pw-old', 'pw-new', 'pw-new2'].forEach((id) => { $(id).value = ''; }); err('pw-error'); return $('dlg-password').showModal(); }
  if (name === 'phrase') { $('ph-pass').value = ''; err('ph-error'); return $('dlg-phrase').showModal(); }
  if (name === 'delete') {
    $('del-text').textContent = t('{name} listeden kaldırılacak. Şifreli anahtar dosyası 30 gün saklanır ve “Son silinenler” bölümünden geri alınabilir. Kurtarma ifaden yoksa bu süreden sonra içindeki para kaybolur.', { name: `“${state.open.name}”` });
    $('del-ok').checked = false; $('del-submit').disabled = true;
    $('del-pass').value = ''; err('del-error'); return $('dlg-delete').showModal();
  }
  if (name === 'send') {
    ['send-step-done', 'send-step-sp', 'send-step-queued'].forEach((id) => { $(id).hidden = true; });
    $('send-step-form').hidden = false;
    $('s-avail').textContent = amt(state.overview?.spendable);
    $('s-pass-f').hidden = !state.status.settings.send.confirm_password; $('s-pass').value = '';
    $('s-method').hidden = slatepackOnly();
    setSendMethod(slatepackOnly() ? 'slatepack' : 'tor');
    err('send-error'); stopRecipientCheck(); $('s-recipient-box').hidden = true; $('s-recipient').dataset.state = ''; pingSeq++;
    prefetchMax();
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
$('set-notify-test').addEventListener('click', async () => { try { await invoke('notify_test'); } catch (e) { toast(E(e)); } });
document.querySelectorAll('input[name="palette"]').forEach((r) => r.addEventListener('change', () => applyPalette(r.value)));
$('dlg-settings').addEventListener('close', () => { applyTheme(state.status.settings.theme); applyPalette(state.status.settings.palette); });
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
  const peers = $('nd-peers').value;
  const badPeer = peers.split('\n').map((l) => l.trim()).filter(Boolean).find((l) => !/^[\w.\-[\]:]+:\d{1,5}$/.test(l));
  if (badPeer) { selectSettingsTab('node'); $('set-box').dataset.level = 'pane'; syncSettingsChrome(); return err('nd-error', t('Eş adresi host:port olmalı: {p}', { p: badPeer })); }
  const node = { autostart: $('nd-auto').checked, peers, only_peers: $('nd-only').checked, archive: $('nd-archive').checked };
  const theme = document.querySelector('input[name="theme"]:checked')?.value || 'system';
  const palette = document.querySelector('input[name="palette"]:checked')?.value || 'grin';
  const notifyPayments = $('set-notify-pay').checked, notifyTor = $('set-notify-tor').checked, closeMode = $('set-close').value, closeToTray = closeMode !== 'quit', closeAsk = closeMode === 'ask';
  const language = $('set-lang').value;
  const minutes = Number($('set-autolock').value) || 0;
  try {
    const send = {
      confirm_password: $('set-confirm-pw').checked, fluff: $('set-fluff').checked, change_outputs: Number($('set-change').value) || 1,
      strategy: $('set-strategy').value, ttl_blocks: Math.max(0, Number($('set-ttl').value) || 0),
      min_confirmations: Math.min(10, Math.max(1, Number($('set-minconf').value) || 10)),
      retry: $('set-retry').checked, retry_minutes: Math.min(240, Math.max(1, Number($('set-retry-min').value) || 30)),
    };
    await invoke('save_settings', { theme, palette, notifyPayments, notifyTor, closeToTray, closeAsk, language, autoLockMinutes: minutes, node, send });
    state.status = await invoke('status'); applyTheme(theme); applyPalette(palette);
    if (language !== s.language) applyLanguage(language);
    autoLockMs = minutes * 60000;
    $('dlg-settings').close(); toast(t('Kaydedildi'));
  } catch (x) { toast(E(x)); }
});

/** Switch language without reloading: static text is re-translated, dynamic parts re-rendered. */
function applyLanguage(pref) {
  setLanguage(pref);
  reportLang();
  translateStatic();
  fillAutoLock();
  $('set-autolock').value = String(state.status.settings.auto_lock_minutes);
  const chip = $('net-chip');
  chip.textContent = NET_LABEL()[state.status.network] || state.status.network;
  const listShown = document.querySelector('[data-screen="wallets"]') && !document.querySelector('[data-screen="wallets"]').hidden;
  if (state.open && !listShown) {
      fillSince($('rescan-since'), false);
    refresh(); pollTor(); pollScan();
    if ($('dlg-settings').open && $('set-box').dataset.tab === 'wallet') loadAccounts();
  } else if (document.querySelector('[data-screen="form"]') && !document.querySelector('[data-screen="form"]').hidden) { openForm(state.formMode); } else renderWallets();
  pollNode();
}

// ---- Settings: one dialog, the same categories on every screen size.
// Wide window: categories on the left, the chosen one on the right. Phone (<= 720px): first the list
// of categories (data-level="menu"), a tap opens one (data-level="pane"), the back arrow returns.
const SHEET = matchMedia('(max-width: 720px)');
function fillSettingsForm() {
  const s = state.status.settings;
  syncTorMode();
  fsRefresh();
  syncBioForm();
  $('set-box').dataset.wallet = state.open ? '1' : '0';
  $('set-lang').value = s.language;
  document.querySelectorAll('input[name="theme"]').forEach((r) => { r.checked = r.value === s.theme; });
  document.querySelectorAll('input[name="palette"]').forEach((r) => { r.checked = r.value === (s.palette === 'orko' ? 'orko' : 'grin'); });
  $('set-notify-pay').checked = s.notify_payments !== false;
  $('set-notify-tor').checked = s.notify_tor !== false;
  $('set-close').value = s.close_ask !== false ? 'ask' : (s.close_to_tray !== false ? 'tray' : 'quit');
  $('set-network').value = s.network;
  $('opt-usernet').hidden = s.network !== 'usernet';
  $('set-net-apply').disabled = true;
  $('set-autolock').value = String(s.auto_lock_minutes);
  $('set-confirm-pw').checked = s.send.confirm_password; $('set-fluff').checked = s.send.fluff;
  $('set-minconf').value = String(s.send.min_confirmations || 10); $('set-change').value = String(s.send.change_outputs); $('set-strategy').value = s.send.strategy; $('set-ttl').value = s.send.ttl_blocks;
  $('set-retry').checked = s.send.retry; $('set-retry-min').value = s.send.retry_minutes; $('set-retry-min').disabled = !s.send.retry;
  $('nd-pool-title').textContent = t('Node havuzu ({net})', { net: NET_LABEL()[state.status.network] });
  $('nd-auto').checked = s.node.autostart; $('nd-archive').checked = s.node.archive;
  $('nd-peers').value = s.node.peers; $('nd-only').checked = s.node.only_peers;
  ['nd-error', 'nd-list-error', 'set-backup-note', 'acc-error'].forEach((id) => err(id)); $('nd-new').value = '';
  fillWalletSettings();
}
function openSettings(tab) {
  closeDialogs();
  fillSettingsForm();
  selectSettingsTab(tab || 'general');
  // Phone: always the category list first (the asked category is marked); desktop: the category itself.
  $('set-box').dataset.level = SHEET.matches ? 'menu' : 'pane';
  syncSettingsChrome();
  $('dlg-settings').showModal();
  $('set-panes').scrollTop = 0;
}
/** Title, back arrow and the Save bar follow the level and the category. */
function syncSettingsChrome() {
  const box = $('set-box');
  const inPane = box.dataset.level === 'pane' || !SHEET.matches;
  const cur = document.querySelector(`.snav [data-stab="${box.dataset.tab}"] b`);
  $('set-title').textContent = SHEET.matches && inPane && cur ? cur.textContent : t('Ayarlar');
  $('set-back').hidden = !(SHEET.matches && inPane);
  $('set-foot').hidden = !(inPane && document.querySelector(`[data-spane="${box.dataset.tab}"]`)?.hasAttribute('data-save'));
}
function selectSettingsTab(name) {
  $('set-box').dataset.tab = name;
  document.querySelectorAll('.snav [data-stab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.stab === name)));
  document.querySelectorAll('[data-spane]').forEach((p) => { p.hidden = p.dataset.spane !== name; });
  if (name === 'wallet' && state.open) loadAccounts();
  if (name === 'node') { fillConnTab(); loadNodeList(true); }
}
document.querySelectorAll('.snav [data-stab]').forEach((b) => b.addEventListener('click', () => {
  selectSettingsTab(b.dataset.stab);
  $('set-box').dataset.level = 'pane'; syncSettingsChrome(); $('set-panes').scrollTop = 0;
}));
$('set-back').addEventListener('click', () => { $('set-box').dataset.level = 'menu'; syncSettingsChrome(); });
SHEET.addEventListener('change', () => { if ($('dlg-settings').open) syncSettingsChrome(); });

// ---- connection diagnosis: facts come from the backend, the wording lives here (so it is translated)
function diagRows(r) {
  const rows = []; // [level, text]  level: ok | warn | fail
  rows.push(r.internet ? ['ok', t('İnternet bağlantısı var.')] : ['fail', t('İnternet bağlantısı yok ya da engelleniyor.')]);
  if (r.internet) {
    if (r.skew === null || r.skew === undefined) rows.push(['warn', t('Saat doğrulanamadı.')]);
    else if (Math.abs(r.skew) > 300) rows.push(['fail', t('Bilgisayar saatin yaklaşık {n} dakika farklı. Tor bu yüzden bağlanamaz.', { n: Math.round(Math.abs(r.skew) / 60) })]);
    else rows.push(['ok', t('Bilgisayar saati doğru (fark {n} sn).', { n: Math.abs(r.skew) })]);
    if (r.reach_ok > 0) rows.push(['ok', t('Tor ağına doğrudan ulaşılabiliyor ({ok}/{total}).', { ok: r.reach_ok, total: r.reach_total })]);
    else if (r.bridges !== 'none') rows.push(['warn', t('Doğrudan ulaşım yok ama köprü kullanıyorsun.')]);
    else rows.push(['fail', t('Tor ağına doğrudan ulaşılamıyor (0/{total}). Ağın Tor\'u engelliyor olabilir.', { total: r.reach_total })]);
  }
  if (r.tor_state === 'off') rows.push(['warn', t('Tor çalışmıyor. Tor durumu için önce bir cüzdan aç.')]);
  else if (r.tor_state === 'starting') rows.push(['warn', t('Tor bağlanıyor (%{p}).', { p: r.tor_percent })]);
  else if (r.tor_state === 'failed') rows.push(['fail', t('Tor başlatılamadı: {msg}', { msg: E(r.tor_message || '') })]);
  else if (r.tor_reachable) rows.push(['ok', t('Tor çevrimiçi; adresin dışarıdan erişilebilir.')]);
  else rows.push(['warn', t('Tor bağlı ama adresin henüz dışarıdan erişilebilir değil ({n} sn).', { n: r.tor_ready_for })]);
  const HINT = {
    clock: 'Günlükte saat hatası var.',
    tls: 'Günlükte şifreleme (TLS) hataları var; bir antivirüs, proxy ya da VPN trafiği bozuyor olabilir.',
    unreach: 'Günlükte “ağa ulaşılamıyor” hataları var; güvenlik duvarı ya da IPv6/VPN ayarı olabilir.',
    stuck: 'Günlükte Tor\'un açılışta takıldığı kayıtlar var.',
  };
  (r.hints || []).forEach((h) => HINT[h] && rows.push(['warn', t(HINT[h])]));
  return rows;
}
const DIAG_ADVICE = {
  internet: 'Önce internet bağlantını düzelt, sonra tanıyı tekrar çalıştır.',
  clock: 'Windows Ayarlar → Zaman ve dil → Tarih ve saat → “Şimdi eşitle” düğmesine bas, sonra uygulamayı yeniden başlat.',
  bridge: 'Ağın Tor\'u engelliyor gibi görünüyor. Cüzdan açıkken Tor kartında Snowflake ya da obfs4 köprüsünü seç ve Uygula\'ya bas.',
  ok: 'Her şey yolunda görünüyor.',
  connecting: 'Tor hâlâ bağlanıyor. Bir iki dakika bekleyip tanıyı tekrar çalıştır.',
  wait: 'Tor bağlı; adresin duyurulması 3-5 dakika sürebilir. Biraz bekle.',
  repair: 'Aşağıdaki “Bağlantıyı yeniden kur ve yeniden başlat” düğmesini dene.',
};
$('set-diag').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const ul = $('diag-list'); ul.replaceChildren(); $('diag-advice').hidden = true; $('set-diag-copy').hidden = true;
  try {
    const r = await invoke('tor_diagnose');
    const rows = diagRows(r);
    const mark = { ok: '✓', warn: '!', fail: '✗' };
    rows.forEach(([lv, text]) => { const li = el('li', `diag-${lv}`); li.append(el('span', 'diag-mark', mark[lv]), el('span', '', text)); ul.append(li); });
    const adv = $('diag-advice'); adv.textContent = t(DIAG_ADVICE[r.advice] || DIAG_ADVICE.repair); adv.hidden = false;
    state.diagReport = rows.map(([lv, text]) => `[${mark[lv]}] ${text}`).concat('', adv.textContent).join('\n');
    $('set-diag-copy').hidden = false;
  } catch (x) { toast(E(x)); }
}));
$('set-diag-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText('OrkoWallet diagnosis\n' + (state.diagReport || '')); toast(t('Kopyalandı')); } catch (x) { toast(E(x)); }
});

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
$('set-quit').addEventListener('click', quitApp);

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
  $('s-method-desc').textContent = tor ? torNote() : slatepackOnly() ? t('Yalnızca Slatepack modu: bir Slatepack metni oluşturulur. Onu alıcıya mesajla, e-postayla ya da QR ile ilet; alıcının geri verdiği yanıtı buraya yapıştırınca ödeme tamamlanır.') : t('Alıcı çevrimdışıysa ya da Tor kullanamıyorsa: bir Slatepack metni oluşturulur. Onu alıcıya mesajla, e-postayla ya da QR ile ilet; alıcı yanıtı geri verince buraya yapıştırıp tamamlarsın.');
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
// The amount is worked out as soon as the Send dialog opens (from the wallet's own records, no node round
// trip), so the button fills the field at once.
let sendMax = false;
let maxPromise = null;
function prefetchMax() {
  maxPromise = invoke('max_sendable');
  maxPromise.catch(() => {}); // an error is shown when the button is pressed
}
$('s-amount').addEventListener('input', () => { sendMax = false; });
$('s-max').addEventListener('click', async () => {
  err('send-error');
  if (!maxPromise) prefetchMax();
  const fill = (v) => {
    if (Number(v) <= 0) return err('send-error', t('Gönderilebilir bakiye yok.'));
    $('s-amount').value = v; sendMax = true;
  };
  let settled = false, v;
  maxPromise.then((x) => { settled = true; v = x; }, () => {});
  await Promise.resolve();
  if (settled) return fill(v); // already known: no spinner at all
  await busy($('s-max'), async () => {
    try { fill(await maxPromise); } catch (x) { maxPromise = null; err('send-error', E(x)); }
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
