'use strict';
// Static validation of a generated version against the request's scope and protections.
// Everything here is site-agnostic: it works from the registry (sections/shared areas) and the request record.
const vm = require('vm');
const cheerio = require('cheerio');
const parse5 = require('parse5');

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const outer = ($, el) => norm($.html(el));
const isExternal = (u) => /^(https?:)?\/\//i.test(u || '');
const isSpecial = (u) => /^(#|mailto:|tel:|data:|javascript:)/i.test(u || '') || !u;
const areaKey = (tag, id, cls) => `shared:${tag}${id ? '#' + id : ''}${(cls || '').trim() ? '.' + cls.trim().split(/\s+/).join('.') : ''}`;

function parseErrors(html) {
  const errs = {};
  parse5.parse(html, { onParseError: (e) => { errs[e.code] = (errs[e.code] || 0) + 1; } });
  return errs;
}

function bodyKids($) {
  return $('body').children().toArray().map((el) => ({
    el, tag: el.tagName, key: areaKey(el.tagName, $(el).attr('id'), $(el).attr('class')), html: outer($, el),
  }));
}

function withoutEditorStyle($) {
  const head = $('head').clone();
  head.find('style[data-editor]').remove();
  return norm($.html(head));
}

// Multiset of normalized outerHTML of an element and all its descendants.
function descendantsBag($, root) {
  const bag = new Map();
  const add = (el) => { const h = outer($, el); bag.set(h, (bag.get(h) || 0) + 1); };
  if (root) { add(root); $(root).find('*').each((_i, el) => add(el)); }
  return bag;
}
const take = (bag, h) => { const n = bag.get(h) || 0; if (!n) return false; bag.set(h, n - 1); return true; };
const openTag = ($, el) => `${el.tagName} ${Object.entries(el.attribs || {}).sort().map(([k, v]) => `${k}="${v}"`).join(' ')}`;


const MARK = '<editor-target></editor-target>';
// Serialize `area` with `node` swapped for a marker (or removed when node is null-replaced).
function withMarker($, area, node, remove = false) {
  const saved = $(node).clone();
  const ph = $(MARK);
  if (remove) $(node).remove(); else $(node).replaceWith(ph);
  const h = outer($, area);
  if (remove) return h; // caller works on a disposable document
  ph.replaceWith(saved);
  return h;
}
function markerMatch($b, areaB, t, $n, areaN, cr) {
  const sel = cr.target.selector;
  const fresh = (doc, s) => { const $ = cheerio.load(doc.html()); return { $, el: $(s)[0] }; };
  const areaSelB = (() => { const i = $b(areaB).parent().children().toArray().indexOf(areaB); return { i }; })();
  const pick = ($, i) => $('main').first().children().toArray()[i];
  const iN = $n(areaN).parent().children().toArray().indexOf(areaN);
  const B = fresh($b, sel); const SB = withMarker(B.$, pick(B.$, areaSelB.i), B.el);
  const candidates = [];
  const n0 = $n(sel)[0];
  if (n0) { candidates.push(n0); let x = n0.next; while (x && x.type !== 'tag') x = x.next; if (x && x.tagName === n0.tagName) candidates.push(x); }
  const adding = cr.changeTypes.includes('add') && ['before', 'after'].includes(cr.placement);
  for (const c of candidates) {
    const path = []; let x = c; while (x && x !== areaN) { path.unshift($n(x).parent().children().toArray().indexOf(x)); x = x.parent; }
    const N = cheerio.load($n.html()); let el = pick(N, iN); const areaCopy = el;
    for (const k of path) el = N(el).children().toArray()[k];
    if (withMarker(N, areaCopy, el) === SB) return true;
    if (adding) { // drop up to two newly inserted siblings on the requested side of the item
      const N2 = cheerio.load($n.html()); let e2 = pick(N2, iN); const a2 = e2;
      for (const k of path) e2 = N2(e2).children().toArray()[k];
      const side = cr.placement === 'before' ? 'prev' : 'next';
      for (let d = 0; d < 2; d++) {
        let s2 = e2[side]; while (s2 && s2.type !== 'tag') s2 = s2[side];
        if (!s2) break;
        N2(s2).remove();
        if (withMarker(N2, a2, e2) === SB) return true;
      }
    }
  }
  if (cr.changeTypes.includes('remove')) {
    const B2 = fresh($b, sel); const area2 = pick(B2.$, areaSelB.i); B2.$(B2.el).remove();
    if (outer(B2.$, area2) === outer($n, areaN)) return true;
  }
  return false;
}

/**
 * @param {object} o
 *   page: registry page for the request; pages: all registry pages; site
 *   cr: serialized request (area, target, changeTypes, placement, protectedElements, allowSharedFiles)
 *   base: { [path]: text } original contents of changed text files; next: { [path]: text } new contents
 *   newFileList: all file paths in the generated version; binaries: [paths] of inserted images
 *   writable: Set of paths that were allowed to change
 */
function validateStatic(o) {
  const checks = [];
  const add = (id, label, status, detail = '') => checks.push({ id, label, status, detail });
  const { cr, page, pages, site } = o;
  const area = o.area; // resolved selection: { kind, key, index, selector }
  const changed = Object.keys(o.next);
  const shared = new Set(site.sharedFiles || []);

  // 0. Something changed at all
  if (!changed.length && !o.binaries.length) add('nothing', 'A change was made', 'fail', 'The AI did not change anything.');

  // 1. File scope
  const outOfScope = changed.filter((p) => !o.writable.has(p));
  const badImages = o.binaries.filter((p) => !/^editor-r\d+-\d+\.(png|jpg|webp|gif)$/.test(p));
  if (outOfScope.length || badImages.length) add('files', 'Only permitted files changed', 'fail', `Not permitted: ${[...outOfScope, ...badImages].join(', ')}`);
  else add('files', 'Only permitted files changed', 'pass', changed.concat(o.binaries).join(', '));
  const sharedChanged = changed.filter((p) => shared.has(p));
  if (sharedChanged.length && !cr.allowSharedFiles) add('shared', 'Shared files need permission', 'fail', `${sharedChanged.join(', ')} changed without permission.`);
  else if (sharedChanged.length) add('shared', 'Shared design changed (with permission)', 'warn', `${sharedChanged.join(', ')} affects every page. Review all pages before publishing.`);

  // 2. HTML integrity, security and links for each changed HTML file
  const fileSet = new Set(o.newFileList);
  for (const p of changed.filter((f) => f.endsWith('.html'))) {
    const before = parseErrors(o.base[p]); const after = parseErrors(o.next[p]);
    const worse = Object.keys(after).filter((k) => after[k] > (before[k] || 0));
    if (worse.length) add(`html:${p}`, `Valid HTML (${p})`, 'fail', `New HTML errors: ${worse.join(', ')}`);
    const $b = cheerio.load(o.base[p]); const $n = cheerio.load(o.next[p]);
    const structural = ['html', 'head', 'body', 'main'].filter((t) => $b(t).length !== $n(t).length);
    if (structural.length) add(`struct:${p}`, `Page structure intact (${p})`, 'fail', `Changed number of <${structural.join('>, <')}> elements.`);
    if (!worse.length && !structural.length) add(`html:${p}`, `Valid HTML (${p})`, 'pass');

    const sec = [];
    const extScripts = (S) => S('script[src],iframe,object,embed').toArray().map((e) => `${e.tagName}:${S(e).attr('src') || S(e).attr('data') || ''}`);
    const baseExt = new Set(extScripts($b));
    extScripts($n).filter((x) => !baseExt.has(x)).forEach((x) => sec.push(`new embedded resource ${x}`));
    const handlers = (S) => S('*').toArray().reduce((n, e) => n + Object.keys(e.attribs || {}).filter((a) => /^on/i.test(a)).length, 0);
    if (handlers($n) > handlers($b)) sec.push('new inline event handlers (on…= attributes)');
    if ($n('[href^="javascript:"],[src^="javascript:"]').length > $b('[href^="javascript:"],[src^="javascript:"]').length) sec.push('javascript: links');
    $n('style[data-editor]').each((_i, e) => { if (/@import|url\(\s*['"]?(https?:)?\/\//i.test($n(e).html())) sec.push('external resources in page styles'); });
    add(`sec:${p}`, `No unsafe code added (${p})`, sec.length ? 'fail' : 'pass', sec.join('; '));

    const refs = (S) => S('[href],[src]').toArray().map((e) => S(e).attr('href') || S(e).attr('src'));
    const baseRefs = new Set(refs($b));
    const broken = refs($n).filter((u) => !baseRefs.has(u) && !isExternal(u) && !isSpecial(u))
      .map((u) => u.split(/[?#]/)[0]).filter((u) => u && !fileSet.has(u.replace(/^\.?\//, '')));
    add(`links:${p}`, `New links and images resolve (${p})`, broken.length ? 'fail' : 'pass', broken.length ? `Missing: ${[...new Set(broken)].join(', ')}` : '');

    const badJs = [];
    $n('script:not([src])').each((_i, e) => {
      const t = ($n(e).attr('type') || '').toLowerCase();
      if (t && !/javascript|^module$/.test(t)) return;
      try { new vm.Script($n(e).html(), { filename: p }); } catch (er) { badJs.push(er.message); }
    });
    if (badJs.length) add(`inlinejs:${p}`, `Inline scripts are valid (${p})`, 'fail', badJs.join('; '));
  }

  // 3. JS / CSS syntax (compiled, never executed here)
  for (const p of changed.filter((f) => f.endsWith('.js'))) {
    try { new vm.Script(o.next[p], { filename: p }); add(`js:${p}`, `Script is valid (${p})`, 'pass'); } catch (er) { add(`js:${p}`, `Script is valid (${p})`, 'fail', er.message); }
  }
  for (const p of changed.filter((f) => f.endsWith('.css'))) {
    const t = o.next[p].replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '');
    let depth = 0, ok = true;
    for (const ch of t) { if (ch === '{') depth++; else if (ch === '}' && --depth < 0) { ok = false; break; } }
    const ext = /@import[^;]*(https?:)?\/\//i.test(t);
    add(`css:${p}`, `Stylesheet is valid (${p})`, ok && depth === 0 && !ext ? 'pass' : 'fail', !ok || depth ? 'Unbalanced braces.' : ext ? 'External @import.' : '');
  }

  // 4. Scope: nothing outside the selection changed; protections intact
  const scopeIssues = [];
  for (const p of changed.filter((f) => f.endsWith('.html'))) {
    const $b = cheerio.load(o.base[p]); const $n = cheerio.load(o.next[p]);
    const isReqPage = p === page.path;
    if (withoutEditorStyle($b) !== withoutEditorStyle($n) || (!isReqPage && $n('head style[data-editor]').length)) scopeIssues.push(`${p}: the page head (title, fonts, metadata) changed`);
    const bk = bodyKids($b).filter((k) => k.tag !== 'main'); const nk = bodyKids($n).filter((k) => k.tag !== 'main');
    const sharedArea = area.kind === 'shared' ? area.key : null;
    if (bk.length !== nk.length) scopeIssues.push(`${p}: parts outside the main content were added or removed`);
    else bk.forEach((k, i) => { if (k.html !== nk[i].html && !(sharedArea && k.key === sharedArea)) scopeIssues.push(`${p}: “${k.key.replace('shared:', '')}” changed but was not selected`); });

    if (!isReqPage || area.kind === 'shared') {
      if (outer($b, $b('main')[0]) !== outer($n, $n('main')[0])) scopeIssues.push(`${p}: the main page content changed, but only a shared area was selected`);
      if (!isReqPage && area.kind !== 'shared') scopeIssues.push(`${p}: another page was changed`);
      continue;
    }
    // Section-level check on the request page.
    const mainB = $b(site.sectionSelector).first().parent(); const mainN = $n('main').first();
    const B = mainB.children().toArray(); const N = mainN.children().toArray();
    const areaEl = $b(area.selector)[0];
    const i = B.indexOf(areaEl);
    const hb = B.map((e) => outer($b, e)); const hn = N.map((e) => outer($n, e));
    let pre = 0; while (pre < hb.length && pre < hn.length && hb[pre] === hn[pre]) pre++;
    let suf = 0; while (suf < hb.length - pre && suf < hn.length - pre && hb[hb.length - 1 - suf] === hn[hn.length - 1 - suf]) suf++;
    const cb = [pre, hb.length - suf]; const cn = [pre, hn.length - suf];
    const nb = cb[1] - cb[0]; const nn = cn[1] - cn[0];
    const adding = cr.changeTypes.includes('add') && ['before', 'after'].includes(cr.placement);
    const removing = cr.changeTypes.includes('remove') && !cr.target;
    let newArea = null;
    if (nb > 1 || (nb === 1 && cb[0] !== i)) {
      const names = page.sections.filter((s, k) => k >= cb[0] && k < cb[1] && k !== i).map((s) => s.name);
      scopeIssues.push(`Sections outside the selection changed: ${names.join(', ') || 'unknown'}`);
    } else if (nb === 0 && nn > 0) {
      if (!adding || (cn[0] !== i && cn[0] !== i + 1)) scopeIssues.push('A new section was added, but adding a section next to the selection was not requested');
      newArea = cn[0] === i ? N[i + nn] : N[i]; // unchanged selection, shifted by the inserted section(s)
    } else if (nb === 1) {
      if (nn === 0 && !removing) scopeIssues.push('The selected section was removed, but removal was not requested');
      if (nn > 1 && !adding) scopeIssues.push('Extra sections were added, but adding was not requested');
      if (nn > 3) scopeIssues.push('More new sections were added than expected');
      const cand = N.slice(cn[0], cn[1]);
      newArea = cand.find((e) => ['id', 'aria-labelledby', 'class'].every((a) => $n(e).attr(a) === $b(areaEl).attr(a))) || cand[0] || null;
    } else newArea = N[i];

    // Element-level check inside the selected section when a specific item was selected: the section with the
    // item replaced by a marker must be identical before and after (tolerating only requested insertions/removal).
    if (cr.target && newArea) {
      const t = $b(cr.target.selector)[0];
      if (t && !markerMatch($b, areaEl, t, $n, newArea, cr)) {
        scopeIssues.push('Inside the selected section, content outside the selected item was changed or moved');
      }
    } else if (cr.target && !newArea) scopeIssues.push('The section containing the selected item was removed');
  }
  add('scope', 'Nothing outside the selection changed', scopeIssues.length ? 'fail' : 'pass', scopeIssues.slice(0, 8).join('; '));

  // Protected items must be present exactly as before.
  const lost = [];
  const reqNew = o.next[page.path];
  if (reqNew) {
    const $b = cheerio.load(o.base[page.path]); const $n = cheerio.load(reqNew);
    const bag = descendantsBag($n, $n('html')[0]);
    for (const pe of cr.protectedElements) {
      const el = $b(pe.selector)[0];
      if (el && !take(bag, outer($b, el))) lost.push(pe.label);
    }
  }
  add('protected', 'Protected items unchanged', lost.length ? 'fail' : 'pass', lost.join('; '));

  // Other pages: list them for review (only ever changed for shared areas with permission).
  const otherPages = changed.filter((p) => p.endsWith('.html') && p !== page.path);
  if (otherPages.length) add('pages', 'Other pages changed (shared area)', 'warn', otherPages.map((p) => (pages.find((x) => x.path === p) || {}).title || p).join(', '));
  return checks;
}

module.exports = { validateStatic, norm };
