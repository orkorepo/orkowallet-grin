// Themed drop-down lists. The native <select> popup is drawn by the OS and ignores the app theme, so
// every <select> keeps working as before (value, change event, options) but is hidden behind a button
// and a list that use the theme colours. The list is a popover inside the select's own dialog (so it is
// clickable in a modal dialog) and is placed with fixed coordinates (so the dialog cannot clip it).
(function () {
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const indexDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  let openDd = null;

  function closeOpen() {
    if (!openDd) return;
    const d = openDd; openDd = null;
    try { d.list.hidePopover(); } catch { d.list.hidden = true; }
    d.btn.setAttribute('aria-expanded', 'false');
  }

  /** Scroll only the list itself (never a page or dialog behind it) just enough to show `row`. */
  function scrollRowIntoView(list, row) {
    const top = row.offsetTop, bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top - 4;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
  }

  function enhance(sel) {
    if (sel.dataset.dd || sel.multiple) return;
    sel.dataset.dd = '1';
    const wrap = document.createElement('span'); wrap.className = 'dd';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'dd-btn';
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span'); label.className = 'dd-label';
    const chev = document.createElement('span'); chev.className = 'dd-chev'; chev.setAttribute('aria-hidden', 'true');
    btn.append(label, chev);
    const list = document.createElement('div'); list.className = 'dd-list'; list.setAttribute('role', 'listbox');
    list.setAttribute('popover', 'manual');
    sel.before(wrap); wrap.append(sel, btn, list);
    sel.classList.add('dd-native'); sel.tabIndex = -1;
    const al = sel.getAttribute('aria-label'); if (al) btn.setAttribute('aria-label', al);
    const dd = { sel, btn, list, active: -1 };

    const refresh = () => {
      const o = sel.options[indexDesc.get.call(sel)];
      label.textContent = o ? o.textContent : '';
      btn.disabled = sel.disabled;
    };
    const items = () => [...list.children];
    // `scroll` is true only for the keyboard (and when the list opens). With the mouse the row under the
    // pointer is just marked: scrolling it into view moved the list under the pointer, which marked the next
    // row, which scrolled again, so the list ran away at its edges.
    const highlight = (i, scroll = true) => {
      const it = items(); if (!it.length) return;
      dd.active = Math.max(0, Math.min(it.length - 1, i));
      it.forEach((x, k) => x.classList.toggle('on', k === dd.active));
      if (scroll) scrollRowIntoView(list, it[dd.active]);
    };
    const choose = (i) => {
      const o = sel.options[i]; if (!o || o.disabled) return;
      const changed = indexDesc.get.call(sel) !== i;
      indexDesc.set.call(sel, i); refresh(); closeOpen(); btn.focus();
      if (changed) { sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); }
    };
    const place = () => {
      const r = btn.getBoundingClientRect();
      const below = innerHeight - r.bottom - 8, above = r.top - 8;
      const max = Math.min(280, Math.max(below, above));
      const up = below < Math.min(180, list.scrollHeight) && above > below;
      Object.assign(list.style, {
        left: r.left + 'px', width: r.width + 'px', maxHeight: max + 'px',
        top: up ? 'auto' : r.bottom + 4 + 'px', bottom: up ? innerHeight - r.top + 4 + 'px' : 'auto',
      });
    };
    const open = () => {
      if (btn.disabled) return;
      closeOpen();
      list.replaceChildren();
      [...sel.options].forEach((o, i) => {
        const it = document.createElement('div'); it.className = 'dd-opt'; it.setAttribute('role', 'option');
        it.textContent = o.textContent; if (o.disabled) it.classList.add('off');
        if (i === indexDesc.get.call(sel)) { it.classList.add('sel'); it.setAttribute('aria-selected', 'true'); }
        it.addEventListener('pointerdown', (e) => e.preventDefault());
        it.addEventListener('click', () => choose(i));
        it.addEventListener('pointermove', () => { if (dd.active !== i) highlight(i, false); });
        list.append(it);
      });
      try { list.showPopover(); } catch { list.hidden = false; }
      place(); openDd = dd; btn.setAttribute('aria-expanded', 'true');
      highlight(indexDesc.get.call(sel));
    };
    btn.addEventListener('click', () => (openDd === dd ? closeOpen() : open()));
    btn.addEventListener('keydown', (e) => {
      const isOpen = openDd === dd, cur = indexDesc.get.call(sel);
      if (e.key === 'Escape' && isOpen) { e.preventDefault(); e.stopPropagation(); closeOpen(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen) return open();
        return highlight(dd.active + (e.key === 'ArrowDown' ? 1 : -1));
      }
      if (e.key === 'Home' && isOpen) { e.preventDefault(); return highlight(0); }
      if (e.key === 'End' && isOpen) { e.preventDefault(); return highlight(1e6); }
      if ((e.key === 'Enter' || e.key === ' ') && isOpen) { e.preventDefault(); return choose(dd.active); }
      if (e.key === 'Tab' && isOpen) closeOpen();
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
        const k = e.key.toLowerCase(); const n = sel.options.length;
        for (let s = 1; s <= n; s++) {
          const i = (cur + s) % n;
          if (sel.options[i].textContent.trim().toLowerCase().startsWith(k)) { if (isOpen) highlight(i); else choose(i); break; }
        }
      }
    });
    sel.addEventListener('focus', () => btn.focus());
    sel.addEventListener('change', refresh);
    Object.defineProperty(sel, 'value', { configurable: true, get() { return valueDesc.get.call(this); }, set(v) { valueDesc.set.call(this, v); refresh(); } });
    Object.defineProperty(sel, 'selectedIndex', { configurable: true, get() { return indexDesc.get.call(this); }, set(v) { indexDesc.set.call(this, v); refresh(); } });
    new MutationObserver(refresh).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled'] });
    refresh();
  }

  const scan = (root) => { if (root.querySelectorAll) root.querySelectorAll('select').forEach(enhance); };
  scan(document);
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => {
    if (n.nodeType !== 1) return;
    if (n.tagName === 'SELECT') enhance(n); else scan(n);
  }))).observe(document.body, { childList: true, subtree: true });

  document.addEventListener('pointerdown', (e) => {
    if (openDd && !openDd.btn.contains(e.target) && !openDd.list.contains(e.target)) closeOpen();
  }, true);
  addEventListener('resize', closeOpen);
  document.addEventListener('scroll', (e) => { if (openDd && !openDd.list.contains(e.target)) closeOpen(); }, true);
  document.addEventListener('close', closeOpen, true);
})();
