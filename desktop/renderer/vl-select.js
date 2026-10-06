/**
 * VeraLux Custom Select  –  replaces native <select> dropdown popups
 * with fully-styleable custom dropdowns using the VeraLux dark/gold theme.
 *
 * Self-initialising: transforms every <select> on DOMContentLoaded and
 * watches for dynamically-added ones via MutationObserver.
 *
 * Preserves:
 *   • select.value / selectedIndex (read & write)
 *   • change / input events (dispatched on the hidden <select>)
 *   • onchange inline handlers
 *   • <optgroup> labels
 *   • disabled state
 *   • keyboard navigation (Enter, Space, Escape, ArrowUp/Down)
 */
(function vlSelectInit() {
  'use strict';

  /* ---------- palette ---------- */
  var GOLD       = '#C9A04E';
  var GOLD_HOVER = 'rgba(201,160,78,0.18)';
  var BG         = 'var(--bg, #070708)';
  var TEXT       = 'var(--text, #e2e6ed)';
  var BORDER     = 'rgba(201,160,78,0.22)';

  /* ---------- upgrade one <select> ---------- */
  function upgrade(sel) {
    if (sel.dataset.vlDone) return;
    sel.dataset.vlDone = '1';

    var cs = getComputedStyle(sel);

    /* ── wrapper ── */
    var wrap = document.createElement('div');
    wrap.className = 'vl-sel' + (sel.className ? ' ' + sel.className : '');
    wrap.style.cssText =
      'position:relative;display:' +
      (cs.display.indexOf('inline') >= 0 ? 'inline-block' : 'block') +
      ';width:' + (sel.style.width || cs.width) +
      ';min-width:' + (sel.style.minWidth || cs.minWidth || '0') +
      ';max-width:' + (sel.style.maxWidth || cs.maxWidth || 'none') +
      ';margin-bottom:' + cs.marginBottom +
      ';vertical-align:middle;box-sizing:border-box;';

    /* ── trigger (visible button) ── */
    var trig = document.createElement('div');
    trig.className = 'vl-sel-trigger';
    if (sel.title) trig.title = sel.title;
    trig.tabIndex = sel.tabIndex >= 0 ? sel.tabIndex : 0;
    trig.style.cssText =
      'padding:' + cs.padding +
      ';border:' + cs.border +
      ';border-radius:' + cs.borderRadius +
      ';background:' + cs.backgroundColor +
      ';color:' + cs.color +
      ';font-family:' + cs.fontFamily +
      ';font-size:' + cs.fontSize +
      ';font-weight:' + cs.fontWeight +
      ';cursor:pointer;display:flex;align-items:center;justify-content:space-between;' +
      'box-sizing:border-box;width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
      'transition:border-color 0.2s,box-shadow 0.2s;';

    var label = document.createElement('span');
    label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;flex:1;pointer-events:none;';

    var arrow = document.createElement('span');
    arrow.textContent = '\u25BE';
    arrow.style.cssText = 'margin-left:8px;opacity:0.50;font-size:11px;flex-shrink:0;color:' + GOLD + ';pointer-events:none;';
    trig.append(label, arrow);

    /* ── dropdown panel ── */
    var dd = document.createElement('div');
    dd.className = 'vl-sel-dd';
    dd.style.cssText =
      'position:absolute;left:0;right:0;z-index:99999;max-height:260px;overflow-y:auto;' +
      'background:' + BG + ';border:1px solid ' + BORDER + ';border-radius:10px;padding:4px 0;' +
      'box-shadow:0 12px 48px rgba(0,0,0,0.65),0 0 0 1px rgba(201,160,78,0.08);' +
      'display:none;scrollbar-width:thin;scrollbar-color:rgba(201,160,78,0.3) transparent;';

    /* ── helpers ── */
    function setLabel() {
      var o = sel.options[sel.selectedIndex];
      label.textContent = o ? o.text : '';
    }
    setLabel();

    function makeItem(opt) {
      var d = document.createElement('div');
      d.className = 'vl-sel-opt';
      d.textContent = opt.text;
      d.dataset.value = opt.value;
      var isCur = opt.value === sel.value;
      d.style.cssText =
        'padding:7px 14px;margin:2px 5px;border-radius:7px;cursor:pointer;' +
        'font-size:' + (cs.fontSize || '14px') + ';' +
        'color:' + (isCur ? '#fff' : TEXT) + ';' +
        'background:' + (isCur ? GOLD : 'transparent') + ';' +
        'transition:background 0.1s,color 0.1s;';

      d.addEventListener('mouseenter', function () {
        if (this.dataset.value !== sel.value) {
          this.style.background = GOLD_HOVER;
          this.style.color = '#fff';
        }
      });
      d.addEventListener('mouseleave', function () {
        if (this.dataset.value !== sel.value) {
          this.style.background = 'transparent';
          this.style.color = TEXT;
        }
      });
      d.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
      d.addEventListener('click', function (e) {
        e.stopPropagation();
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        sel.dispatchEvent(new Event('input',  { bubbles: true }));
        setLabel();
        close();
      });
      return d;
    }

    function buildDropdown() {
      dd.innerHTML = '';
      var children = sel.children;
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.tagName === 'OPTGROUP') {
          var gl = document.createElement('div');
          gl.textContent = child.label;
          gl.style.cssText =
            'padding:8px 14px 3px;font-weight:600;font-size:11px;color:' + GOLD +
            ';text-transform:uppercase;letter-spacing:0.04em;opacity:0.85;';
          dd.appendChild(gl);
          var opts = child.querySelectorAll('option');
          for (var j = 0; j < opts.length; j++) dd.appendChild(makeItem(opts[j]));
        } else if (child.tagName === 'OPTION') {
          dd.appendChild(makeItem(child));
        }
      }
      if (!dd.children.length) {
        var empty = document.createElement('div');
        empty.textContent = 'No options';
        empty.style.cssText = 'padding:10px 14px;color:rgba(255,255,255,0.3);font-style:italic;font-size:13px;';
        dd.appendChild(empty);
      }
    }

    var isOpen = false;
    var focusIdx = -1;

    function allOpts() { return dd.querySelectorAll('.vl-sel-opt'); }

    function highlightIdx(idx) {
      var items = allOpts();
      items.forEach(function (el) {
        var isCur = el.dataset.value === sel.value;
        el.style.background = isCur ? GOLD : 'transparent';
        el.style.color = isCur ? '#fff' : TEXT;
      });
      if (idx >= 0 && idx < items.length) {
        items[idx].style.background = GOLD_HOVER;
        items[idx].style.color = '#fff';
        items[idx].scrollIntoView({ block: 'nearest' });
      }
      focusIdx = idx;
    }

    function open() {
      if (sel.disabled) return;
      buildDropdown();
      dd.style.display = 'block';
      dd.style.top = '100%'; dd.style.bottom = 'auto';
      dd.style.marginTop = '4px'; dd.style.marginBottom = '0';

      requestAnimationFrame(function () {
        var r = dd.getBoundingClientRect();
        if (r.bottom > window.innerHeight - 8) {
          dd.style.top = 'auto'; dd.style.bottom = '100%';
          dd.style.marginTop = '0'; dd.style.marginBottom = '4px';
        }
        var cur = dd.querySelector('.vl-sel-opt[data-value="' + CSS.escape(sel.value) + '"]');
        if (cur) cur.scrollIntoView({ block: 'nearest' });
      });

      isOpen = true;
      focusIdx = -1;
      trig.style.borderColor = GOLD;
      trig.style.boxShadow = '0 0 0 3px rgba(201,160,78,0.15)';
    }

    function close() {
      dd.style.display = 'none';
      isOpen = false;
      trig.style.borderColor = '';
      trig.style.boxShadow = '';
    }

    /* ── events ── */
    trig.addEventListener('mousedown', function (e) {
      e.preventDefault(); e.stopPropagation();
      isOpen ? close() : open();
    });

    trig.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); isOpen ? close() : open(); return; }
      if (e.key === 'Escape') { close(); return; }
      if (!isOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); open(); return; }
      if (isOpen) {
        var items = allOpts();
        if (e.key === 'ArrowDown') { e.preventDefault(); highlightIdx(Math.min(focusIdx + 1, items.length - 1)); }
        if (e.key === 'ArrowUp')   { e.preventDefault(); highlightIdx(Math.max(focusIdx - 1, 0)); }
        if (e.key === 'Enter' && focusIdx >= 0 && focusIdx < items.length) {
          e.preventDefault();
          items[focusIdx].click();
        }
      }
    });

    document.addEventListener('mousedown', function (e) {
      if (isOpen && !wrap.contains(e.target)) close();
    });

    /* ── sync dynamic option changes ── */
    new MutationObserver(function () { setLabel(); if (isOpen) buildDropdown(); })
      .observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['selected'] });

    /* Intercept programmatic .value / .selectedIndex writes */
    try {
      var vd = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      var sd = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
      if (vd) Object.defineProperty(sel, 'value', {
        get: function () { return vd.get.call(this); },
        set: function (v) { vd.set.call(this, v); setLabel(); }
      });
      if (sd) Object.defineProperty(sel, 'selectedIndex', {
        get: function () { return sd.get.call(this); },
        set: function (v) { sd.set.call(this, v); setLabel(); }
      });
    } catch (_) { /* MutationObserver covers most cases */ }

    sel.addEventListener('change', setLabel);

    /* ── insert into DOM ── */
    sel.parentNode.insertBefore(wrap, sel);
    wrap.append(trig, dd, sel);
    sel.style.cssText += ';position:absolute!important;opacity:0!important;pointer-events:none!important;width:0!important;height:0!important;overflow:hidden!important;';
  }

  /* ---------- upgrade all ---------- */
  function upgradeAll() {
    document.querySelectorAll('select:not([data-vl-done])').forEach(upgrade);
  }

  /* ---------- boot ---------- */
  function init() {
    if (!document.body) return;
    upgradeAll();
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'SELECT') upgrade(n);
          else if (n.querySelectorAll) n.querySelectorAll('select:not([data-vl-done])').forEach(upgrade);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.vlUpgradeSelects = upgradeAll;
})();
