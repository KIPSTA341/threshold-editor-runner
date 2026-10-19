/* Injected into previews only (never into the live site). Lets the editor pick what to change and what to keep
   by clicking. Talks to the parent editor via postMessage, restricted to the editor's origin. Site-agnostic:
   the section selector comes from the site's configuration. */
(function () {
  'use strict';
  var me = document.currentScript;
  var EDITOR = me && me.getAttribute('data-editor-origin');
  var SECTION_SEL = (me && me.getAttribute('data-section-selector')) || 'main > section';
  if (!EDITOR || window.parent === window) return;

  var SKIP = { MAIN: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, LINK: 1, META: 1 };
  var state = { mode: 'off', area: null, target: null, protectedSelectors: [] };

  var css = document.createElement('style');
  css.textContent =
    '[data-tse-hover]{outline:3px dashed #E2472A !important;outline-offset:-3px;cursor:pointer !important}' +
    '[data-tse-hover-p]{outline:3px dashed #2F7DE1 !important;outline-offset:-3px;cursor:pointer !important}' +
    '[data-tse-area]{outline:2px dashed rgba(226,71,42,.75) !important;outline-offset:-2px}' +
    '[data-tse-sel]{outline:4px solid #E2472A !important;outline-offset:-4px}' +
    '[data-tse-prot]{outline:3px solid #2F7DE1 !important;outline-offset:-3px}' +
    '#tse-tip{position:fixed;z-index:2147483647;pointer-events:none;background:#111;color:#fff;font:600 12px/1.35 system-ui,sans-serif;' +
    'padding:6px 9px;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.3);display:none;max-width:300px}';
  document.head.appendChild(css);
  var tip = document.createElement('div');
  tip.id = 'tse-tip';
  document.documentElement.appendChild(tip);

  function sections() { return Array.prototype.slice.call(document.querySelectorAll(SECTION_SEL)); }
  function post(msg) { window.parent.postMessage(msg, EDITOR); }
  function pagePath() { var p = location.pathname.split('/').pop(); return p || 'index.html'; }
  function cssEscape(s) { return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function q(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }

  function nthOfType(el) { var i = 1, s = el; while ((s = s.previousElementSibling)) if (s.tagName === el.tagName) i++; return i; }
  function uniqueSelector(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      if (el.id && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) { parts.unshift('#' + cssEscape(el.id)); return parts.join(' > '); }
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + nthOfType(el) + ')');
      el = el.parentElement;
    }
    parts.unshift('body');
    return parts.join(' > ');
  }

  // Which area an element belongs to: a page section, or a shared area outside the main content.
  function areaOf(el) {
    var sec = el.closest && el.closest(SECTION_SEL);
    if (sec) {
      var i = sections().indexOf(sec);
      return { kind: 'section', index: i, el: sec, selector: SECTION_SEL + ':nth-of-type(' + (i + 1) + ')' };
    }
    var top = el;
    while (top && top.parentElement && top.parentElement !== document.body) top = top.parentElement;
    if (!top || top.parentElement !== document.body || SKIP[top.tagName] || top.id === 'tse-tip') return null;
    var cls = clean(top.getAttribute('class'));
    var key = 'shared:' + top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + (cls ? '.' + cls.split(' ').join('.') : '');
    return { kind: 'shared', key: key, el: top, selector: 'body > ' + top.tagName.toLowerCase() + ':nth-of-type(' + nthOfType(top) + ')' };
  }

  function kindOf(el) {
    var t = el.tagName.toLowerCase(), cls = ' ' + (el.getAttribute('class') || '') + ' ';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'img' || t === 'picture' || t === 'svg' || t === 'video') return 'image';
    if (t === 'canvas') return 'animation';
    if (t === 'button' || (t === 'a' && /\sbtn/.test(cls))) return 'button';
    if (t === 'a') return 'link';
    if (t === 'p' || t === 'blockquote') return 'paragraph';
    if (t === 'ul' || t === 'ol' || t === 'dl') return 'list';
    if (t === 'li' || t === 'article' || /card|tile|item/.test(cls)) return 'card';
    if (t === 'table') return 'table';
    if (t === 'tr' || t === 'td' || t === 'th') return 'table cell';
    if (t === 'input' || t === 'textarea' || t === 'select' || t === 'form' || t === 'label') return 'form';
    if (t === 'nav') return 'navigation';
    if (t === 'header') return 'header';
    if (t === 'footer') return 'footer';
    if (t === 'section') return 'section';
    if (t === 'span' || t === 'small' || t === 'em' || t === 'b' || t === 'strong' || t === 'i' || t === 'time') return 'label';
    return 'block';
  }
  var NAMES = { heading: 'Heading', image: 'Image', animation: 'Background animation', button: 'Button', link: 'Link', paragraph: 'Paragraph',
    list: 'List', card: 'Card / item', table: 'Table', 'table cell': 'Table row/cell', form: 'Form field', navigation: 'Navigation',
    header: 'Header', footer: 'Footer', section: 'Whole section (incl. background)', label: 'Label / text', block: 'Block' };
  function describe(el) {
    var k = kindOf(el);
    var t = k === 'image' ? clean(el.getAttribute('alt') || el.getAttribute('aria-label') || (el.getAttribute('src') || '').split('/').pop())
      : k === 'animation' ? '' : clean(el.innerText || el.getAttribute('aria-label') || '');
    if (k === 'block' && !t && el.querySelector('img,picture,svg,video')) return 'Image area';
    return NAMES[k] + (t ? ': “' + (t.length > 60 ? t.slice(0, 59) + '…' : t) + '”' : '');
  }
  function sig(el) {
    return { tag: el.tagName.toLowerCase(), text: clean(el.textContent).slice(0, 80), src: el.getAttribute('src') || '' };
  }
  // From the clicked element up to its area root: lets the user widen the scope ("this heading" → "the block" → "whole section").
  function chainFor(el, area) {
    var chain = [], n = el, guard = 0;
    while (n && n !== area.el && guard++ < 6) {
      if (!(n.tagName === 'DIV' && chain.length && clean(n.textContent) === clean(chain[chain.length - 1].text))) {
        chain.push({ selector: uniqueSelector(n), label: describe(n), kind: kindOf(n), sig: sig(n), text: clean(n.textContent) });
      }
      n = n.parentElement;
    }
    chain.forEach(function (c) { delete c.text; });
    chain.push({ selector: area.selector, label: area.kind === 'section' ? 'Whole section (incl. background)' : 'The whole ' + describe(area.el).split(':')[0].toLowerCase(), kind: 'area', sig: sig(area.el), root: true });
    return chain;
  }

  function clearMarks(attr) { document.querySelectorAll('[' + attr + ']').forEach(function (n) { n.removeAttribute(attr); }); }
  function paint() {
    ['data-tse-sel', 'data-tse-area', 'data-tse-prot'].forEach(clearMarks);
    var a = state.area && q(state.area);
    var t = state.target && q(state.target);
    if (t) { t.setAttribute('data-tse-sel', ''); if (a && a !== t) a.setAttribute('data-tse-area', ''); } else if (a) a.setAttribute('data-tse-sel', '');
    state.protectedSelectors.forEach(function (sel) { var n = q(sel); if (n) n.setAttribute('data-tse-prot', ''); });
  }

  var hovered = null;
  function setHover(el, label, x, y) {
    if (hovered && hovered !== el) { hovered.removeAttribute('data-tse-hover'); hovered.removeAttribute('data-tse-hover-p'); }
    hovered = el;
    if (!el) { tip.style.display = 'none'; return; }
    el.setAttribute(state.mode === 'protect' ? 'data-tse-hover-p' : 'data-tse-hover', '');
    tip.textContent = label;
    tip.style.display = 'block';
    tip.style.left = Math.min(x + 14, window.innerWidth - 310) + 'px';
    tip.style.top = Math.min(y + 16, window.innerHeight - 50) + 'px';
  }
  function pickable(e) {
    var el = e.target;
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement || el.id === 'tse-tip') return null;
    var area = areaOf(el);
    return area ? { el: el, area: area } : null;
  }

  document.addEventListener('mousemove', function (e) {
    if (state.mode === 'off') return setHover(null);
    var p = pickable(e);
    if (!p) return setHover(null);
    setHover(p.el, (state.mode === 'protect' ? 'Keep unchanged → ' : 'Change → ') + describe(p.el), e.clientX, e.clientY);
  }, true);
  document.addEventListener('mouseleave', function () { setHover(null); }, true);

  document.addEventListener('click', function (e) {
    if (state.mode === 'off') return;
    e.preventDefault();
    e.stopPropagation();
    var p = pickable(e);
    if (!p) return;
    var area = { kind: p.area.kind, index: p.area.index, key: p.area.key, selector: p.area.selector };
    post({ type: state.mode === 'protect' ? 'protect-picked' : 'target-picked', page: pagePath(), area: area, chain: chainFor(p.el, p.area) });
  }, true);

  window.addEventListener('message', function (e) {
    if (e.origin !== EDITOR || !e.data || e.data.type !== 'state') return;
    var d = e.data;
    state.mode = d.mode === 'change' || d.mode === 'protect' ? d.mode : 'off';
    state.area = typeof d.area === 'string' ? d.area : null;
    state.target = typeof d.target === 'string' ? d.target : null;
    state.protectedSelectors = Array.isArray(d.protectedSelectors) ? d.protectedSelectors : [];
    if (state.mode === 'off') setHover(null);
    paint();
    if (typeof d.scrollY === 'number') { quietUntil = Date.now() + 250; window.scrollTo({ top: d.scrollY, behavior: 'instant' }); }
    if (typeof d.scrollTo === 'string') {
      quietUntil = Date.now() + 400;
      var n = q(d.scrollTo);
      if (n === sections()[0] || (n && n.parentElement === document.body && n.getBoundingClientRect().top < 200)) window.scrollTo(0, 0);
      else if (n && n.offsetParent !== null) { var r = n.getBoundingClientRect(); window.scrollTo(0, Math.max(0, r.top + window.scrollY - (window.innerHeight - Math.min(r.height, window.innerHeight)) / 2)); }
    }
  });

  // Report user scrolling so the editor can keep a before/after pair aligned (ignored right after programmatic scrolls).
  var quietUntil = 0; var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking || Date.now() < quietUntil) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; post({ type: 'scroll', y: window.scrollY }); });
  }, { passive: true });

  function ready() { post({ type: 'ready', page: pagePath(), sectionCount: sections().length }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
