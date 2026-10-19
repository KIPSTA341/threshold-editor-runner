'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

async function api(url, opts = {}) {
  const headers = { 'X-Requested-With': 'editor', ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) };
  const r = await fetch(url, { ...opts, headers, body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body });
  if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

const CHANGE_TYPES = [['text', 'Text / wording'], ['image', 'Image'], ['typography', 'Font & typography'], ['colour', 'Colour'],
  ['spacing', 'Spacing & alignment'], ['layout', 'Layout'], ['animation', 'Animation & effects'], ['responsive', 'Mobile / responsive'],
  ['add', 'Add something new'], ['remove', 'Remove something'], ['link', 'Link or button action'], ['other', 'Something else']];

const S = {
  me: null, sites: [], siteId: null, registry: null, previewOrigin: null,
  page: null, area: null, options: [], optIdx: -1, protectedElements: [], changeTypes: [], devices: 'all',
  mode: 'change', device: 'desktop', request: null, pendingFiles: [], readOnly: false, dirty: false,
};
const page = () => S.registry && S.registry.pages.find((p) => p.path === S.page);
const target = () => { const o = S.options[S.optIdx]; return o && !o.root ? { selector: o.selector, label: o.label, kind: o.kind } : null; };

// Resolve an area reference ({kind,index|key}) to its registry entry for the current page.
function areaInfo(ref) {
  const p = page(); if (!p || !ref) return null;
  if (ref.kind === 'shared') {
    // Match by position first: live class names can change at runtime (e.g. a header that hides on scroll).
    const sh = (ref.selector && p.shared.find((x) => x.selector === ref.selector)) || p.shared.find((x) => x.key === ref.key);
    return sh && { kind: 'shared', key: sh.key, index: -1, selector: sh.selector, name: sh.name, shared: sh.shared, pageCount: sh.pageCount };
  }
  const sec = p.sections[ref.index];
  return sec && { kind: 'section', key: sec.key, index: sec.index, selector: sec.selector, name: sec.name, heading: sec.heading, shared: false, pageCount: 1 };
}

// ---------- preview ----------
const frame = $('#frame');
function sendState(extra = {}) {
  if (!frame.contentWindow || !S.previewOrigin) return;
  const t = target();
  frame.contentWindow.postMessage({
    type: 'state', mode: S.readOnly ? 'off' : S.mode, area: S.area ? S.area.selector : null, target: t ? t.selector : null,
    protectedSelectors: S.protectedElements.map((e) => e.selector), ...extra,
  }, S.previewOrigin);
}
const sha = () => (S.request ? S.request.baseSha : S.registry.sha);
async function loadPreview() {
  const { url, previewOrigin } = await api(`/api/sites/${S.siteId}/preview-url?page=${encodeURIComponent(S.page)}&sha=${sha()}`);
  S.previewOrigin = previewOrigin;
  frame.src = url;
  const site = S.sites.find((s) => s.id === S.siteId);
  $('#live').href = `${site.liveUrl.replace(/\/$/, '')}/${S.page === 'index.html' ? '' : S.page}`;
}

async function resolve(msg) {
  const { valid } = await api(`/api/sites/${S.siteId}/resolve`, { method: 'POST', body: { sha: sha(), page: S.page, areaSelector: msg.area.selector, chain: msg.chain } });
  return msg.chain.filter((c, i) => valid[i] || c.root).map(({ sig, ...c }) => c);
}
const fallbackMsg = 'That exact item is created by the page’s interactive code, so it can’t be selected on its own. The nearest selectable area is chosen instead. Describe the exact item in your own words below.';

window.addEventListener('message', async (e) => {
  if (e.origin !== S.previewOrigin || e.source !== frame.contentWindow || !e.data) return;
  const d = e.data;
  if (d.type === 'ready') {
    if (d.page !== S.page && S.registry.pages.some((p) => p.path === d.page) && !S.readOnly) { setPage(d.page, false); }
    sendState({ scrollTo: target() ? target().selector : S.area ? S.area.selector : undefined });
    return;
  }
  if (S.readOnly || d.page !== S.page || !d.area || !Array.isArray(d.chain)) return;
  try {
    const opts = await resolve(d);
    const lost = !d.chain[0].root && opts[0] && opts[0].selector !== d.chain[0].selector;
    if (d.type === 'target-picked') {
      const info = areaInfo(d.area);
      if (!info) throw new Error('That part of the page cannot be selected. Choose an area from the list instead.');
      S.area = info; S.options = opts; S.optIdx = 0;
      S.protectedElements = S.protectedElements.filter((p) => p.selector !== opts[0].selector);
      showNote(lost ? fallbackMsg : '');
      markDirty(); renderTarget(); renderProtect(); sendState();
    } else if (d.type === 'protect-picked') {
      const first = opts[0];
      const info = areaInfo(d.area);
      const tsel = target() ? target().selector : S.area && S.area.selector;
      if (first.selector === tsel) { showNote('That is the item you are changing, so it can’t also be kept unchanged.'); return; }
      if (!S.protectedElements.some((x) => x.selector === first.selector)) {
        S.protectedElements.push({ selector: first.selector, label: `${first.root ? `Whole ${info ? info.name : 'area'}` : first.label}${info ? ` — in ${info.name}` : ''}`, sectionIndex: info ? info.index : -1 });
        showNote(lost ? 'That exact item can’t be protected on its own, so the nearest area around it is protected instead.' : '');
        markDirty(); renderProtect(); sendState();
      }
    }
  } catch (er) { showNote(er.message); }
});
function showNote(t) { $('#sel-note').textContent = t; $('#sel-note').hidden = !t; }

function fitFrame() {
  const wrap = $('#frame-wrap'), box = $('#frame-box');
  const w = S.device === 'mobile' ? 390 : 1280, h = 844;
  const scale = Math.min(1, (wrap.clientWidth - 24) / w, S.device === 'mobile' ? (wrap.clientHeight - 24) / h : 1);
  frame.style.width = w + 'px'; frame.style.height = (S.device === 'mobile' ? h : (wrap.clientHeight - 24) / scale) + 'px';
  frame.style.transform = `scale(${scale})`;
  box.style.width = w * scale + 'px'; box.style.height = (S.device === 'mobile' ? h * scale : wrap.clientHeight - 24) + 'px';
  box.classList.toggle('phone', S.device === 'mobile');
}
window.addEventListener('resize', fitFrame);

const HINTS = {
  change: 'Click what you want to change. Use “Browse” first to open menus or scroll to hidden parts.',
  protect: 'Click anything that must stay exactly as it is.',
  off: 'Browse the page normally: open the menu, follow links between pages.',
};
function setMode(m) {
  S.mode = m;
  $$('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('#mode-hint').textContent = S.readOnly ? 'Viewing a saved request (read only).' : HINTS[m];
  sendState();
}

// ---------- form rendering ----------
function renderPages() {
  $('#page').innerHTML = S.registry.pages.map((p) => `<option value="${esc(p.path)}">${esc(p.title)}</option>`).join('');
  $('#page').value = S.page;
}
function renderAreas() {
  const p = page();
  const item = (a, ref, on) => `<button type="button" role="radio" aria-checked="${on}" class="choice${on ? ' on' : ''}" data-ref='${esc(JSON.stringify(ref))}'>
    <b>${esc(a.name)}${a.shared ? `<span class="badge">all ${a.pageCount} pages</span>` : ''}</b>${a.heading && a.heading !== a.name ? `<span>${esc(a.heading)}</span>` : ''}</button>`;
  const isOn = (ref) => !!S.area && !target() && S.area.kind === ref.kind && (ref.kind === 'shared' ? S.area.key === ref.key : S.area.index === ref.index);
  $('#sections').innerHTML = '<div class="group-h">Sections of this page</div>'
    + p.sections.map((s) => item(s, { kind: 'section', index: s.index }, isOn({ kind: 'section', index: s.index }))).join('')
    + (p.shared.length ? '<div class="group-h">Parts outside the main content</div>' : '')
    + p.shared.map((s) => item(s, { kind: 'shared', key: s.key }, isOn({ kind: 'shared', key: s.key }))).join('');
}
function renderTarget() {
  const a = S.area, t = target(), sel = $('#selection');
  if (!a) { sel.className = 'selection empty'; sel.textContent = 'Nothing selected yet.'; $('#scope').innerHTML = ''; }
  else {
    sel.className = 'selection';
    sel.innerHTML = `<b>${esc(t ? t.label : a.kind === 'section' ? `Whole section: ${a.name}` : `Whole ${a.name}`)}</b>
      <span class="where">${esc(page().title)} → ${esc(a.name)}${a.shared ? `<span class="badge">shared · all ${a.pageCount} pages</span>` : ''}</span>`;
    $('#scope').innerHTML = S.options.length > 1 ? '<div class="group-h">How much should change?</div>' + S.options.map((o, i) => `
      <label><input type="radio" name="scope" value="${i}" ${i === S.optIdx ? 'checked' : ''}> ${esc(o.root ? (a.kind === 'section' ? 'The whole section, including its background' : `The whole ${a.name}`) : i === 0 ? `Just this: ${o.label}` : `The larger block: ${o.label}`)}</label>`).join('') : '';
  }
  renderAreas(); renderAuto();
}
function renderAuto() {
  const a = S.area, p = page();
  if (!a) { $('#auto-protect').textContent = 'Choose what to change first. Everything else will be kept unchanged automatically.'; }
  else {
    const others = p.sections.length - (a.kind === 'section' ? 1 : 0);
    const sharedNames = p.shared.filter((s) => s.shared && s.key !== a.key).map((s) => s.name.split(' (')[0].split(':')[0].toLowerCase());
    $('#auto-protect').innerHTML = `<b>Kept unchanged automatically:</b> everything outside your selection — ${a.kind === 'section' ? `the other ${others} sections of this page, ` : 'the main content of every page, '}`
      + `${a.shared ? '' : `all other pages, `}${sharedNames.length ? `the ${sharedNames.join(', ')}, ` : ''}and the site-wide styles.`
      + (target() ? ' Only the selected item should change.' : '');
  }
  const need = !!(a && a.shared);
  $('#shared-box').classList.toggle('required', need && !$('#allow-shared').checked);
}
function renderTypes() {
  $('#types').innerHTML = CHANGE_TYPES.map(([v, l]) => `<label><input type="checkbox" value="${v}" ${S.changeTypes.includes(v) ? 'checked' : ''}> ${esc(l)}</label>`).join('');
  $('#placement-row').hidden = !S.changeTypes.includes('add');
  $$('#devices button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.devices));
}
function renderProtect() {
  $('#protect-items').innerHTML = S.protectedElements.map((e, i) => `
    <li><span>${esc(e.label)}</span><button class="x" data-i="${i}" aria-label="Remove">×</button></li>`).join('');
}
function renderThumbs() {
  const opt = (v) => `<option value="reference" ${v !== 'use' ? 'selected' : ''}>Reference only</option><option value="use" ${v === 'use' ? 'selected' : ''}>Use on the website</option>`;
  const saved = (S.request ? S.request.attachments : []).map((a) => `
    <li><img src="/api/attachments/${a.id}" alt=""><span>${esc(a.original_name)}</span><select data-aid="${a.id}" aria-label="How to use this image">${opt(a.purpose)}</select><button class="x" data-aid="${a.id}" aria-label="Remove">×</button></li>`);
  const pending = S.pendingFiles.map((f, i) => `
    <li><img src="${URL.createObjectURL(f.file)}" alt=""><span>${esc(f.file.name)} <em>(not saved yet)</em></span><select data-pi="${i}" aria-label="How to use this image">${opt(f.purpose)}</select><button class="x" data-pi="${i}" aria-label="Remove">×</button></li>`);
  $('#thumbs').innerHTML = saved.concat(pending).join('');
}
function renderStatus() {
  const r = S.request;
  $('#status').innerHTML = r
    ? `Request #${r.id} · <b class="pill ${r.status}">${r.status === 'draft' ? 'Draft' : 'Ready for changes'}</b> · saved ${when(r.updatedAt)}${S.dirty ? ' · <em>unsaved edits</em>' : ''}`
    : `New request${S.dirty ? ' · <em>not saved yet</em>' : ''}`;
  $('#new-req').hidden = !r;
  $('#version').textContent = `Showing the published version from ${r ? 'when this request was made' : 'the latest update'} (${sha().slice(0, 7)}).`;
  const ro = S.readOnly;
  $$('#view-edit .panel textarea, #view-edit .panel select, #view-edit .panel input, #view-edit .panel .choice, #devices button, #save, #generate, #pick-items').forEach((el) => { el.disabled = ro; });
  $('#drop').classList.toggle('disabled', ro);
}
function renderAll() { renderPages(); renderTarget(); renderTypes(); renderProtect(); renderThumbs(); renderStatus(); setMode(S.mode); }
function markDirty() { S.dirty = true; $('#form-ok').textContent = ''; renderStatus(); }

function setPage(path, reload = true) {
  S.page = path; S.area = null; S.options = []; S.optIdx = -1; S.protectedElements = [];
  showNote(''); renderAll(); setMode('change');
  if (reload) loadPreview();
}
function selectArea(ref) {
  const info = areaInfo(ref); if (!info) return;
  S.area = info; S.options = [{ selector: info.selector, label: info.name, kind: 'area', root: true }]; S.optIdx = 0;
  S.protectedElements = S.protectedElements.filter((p) => p.selector !== info.selector);
  showNote(''); markDirty(); renderTarget(); sendState({ scrollTo: info.selector });
}

// ---------- events ----------
$('#page').addEventListener('change', (e) => { setPage(e.target.value); markDirty(); });
$('#sections').addEventListener('click', (e) => { const b = e.target.closest('[data-ref]'); if (b && !S.readOnly) selectArea(JSON.parse(b.dataset.ref)); });
$('#scope').addEventListener('change', (e) => { S.optIdx = Number(e.target.value); markDirty(); renderTarget(); sendState({ scrollTo: S.options[S.optIdx].selector }); });
$('#types').addEventListener('change', (e) => {
  S.changeTypes = $$('#types input:checked').map((i) => i.value);
  $('#placement-row').hidden = !S.changeTypes.includes('add'); markDirty();
});
$('#devices').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b || S.readOnly) return; S.devices = b.dataset.v; renderTypes(); markDirty(); });
$('#placement').addEventListener('change', markDirty);
$('#protect-items').addEventListener('click', (e) => {
  const b = e.target.closest('.x'); if (!b || S.readOnly) return;
  S.protectedElements.splice(Number(b.dataset.i), 1); markDirty(); renderProtect(); sendState();
});
$('#pick-items').addEventListener('click', () => setMode('protect'));
$$('#mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$$('#device button').forEach((b) => b.addEventListener('click', () => {
  S.device = b.dataset.device; $$('#device button').forEach((x) => x.classList.toggle('on', x === b)); fitFrame();
}));
$('#instruction').addEventListener('input', markDirty);
$('#allow-shared').addEventListener('change', () => { markDirty(); renderAuto(); });

function addFiles(list) {
  const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const err = [];
  for (const f of list) {
    if (!ok.includes(f.type)) err.push(`${f.name}: only PNG, JPEG, WebP or GIF.`);
    else if (f.size > 8 * 1024 * 1024) err.push(`${f.name}: larger than 8 MB.`);
    else S.pendingFiles.push({ file: f, purpose: S.changeTypes.includes('image') ? 'use' : 'reference' });
  }
  const total = S.pendingFiles.length + (S.request ? S.request.attachments.length : 0);
  if (total > 6) { S.pendingFiles = S.pendingFiles.slice(0, 6 - (total - S.pendingFiles.length)); err.push('Up to 6 images per request.'); }
  $('#form-err').textContent = err.join(' ');
  markDirty(); renderThumbs();
}
$('#files').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('#drop').addEventListener('dragover', (e) => { e.preventDefault(); $('#drop').classList.add('over'); });
$('#drop').addEventListener('dragleave', () => $('#drop').classList.remove('over'));
$('#drop').addEventListener('drop', (e) => { e.preventDefault(); $('#drop').classList.remove('over'); if (!S.readOnly) addFiles(e.dataTransfer.files); });
$('#thumbs').addEventListener('change', async (e) => {
  const s = e.target.closest('select'); if (!s || S.readOnly) return;
  if (s.dataset.pi !== undefined) { S.pendingFiles[Number(s.dataset.pi)].purpose = s.value; markDirty(); return; }
  try { S.request = await api(`/api/requests/${S.request.id}/attachments/${s.dataset.aid}`, { method: 'PATCH', body: { purpose: s.value } }); renderStatus(); }
  catch (er) { $('#form-err').textContent = er.message; }
});
$('#thumbs').addEventListener('click', async (e) => {
  const b = e.target.closest('.x'); if (!b || S.readOnly) return;
  if (b.dataset.pi !== undefined) { S.pendingFiles.splice(Number(b.dataset.pi), 1); renderThumbs(); return; }
  try { await api(`/api/requests/${S.request.id}/attachments/${b.dataset.aid}`, { method: 'DELETE' }); S.request = await api(`/api/requests/${S.request.id}`); renderThumbs(); renderStatus(); }
  catch (er) { $('#form-err').textContent = er.message; }
});

async function save(status) {
  $('#form-err').textContent = ''; $('#form-ok').textContent = '';
  if (!S.area) { $('#form-err').textContent = 'Choose what to change: click it in the preview.'; return; }
  const body = {
    siteId: S.siteId, page: S.page, area: { kind: S.area.kind, index: S.area.index, key: S.area.key }, target: target(),
    changeTypes: S.changeTypes, placement: $('#placement').value || null, devices: S.devices,
    instruction: $('#instruction').value, protectedElements: S.protectedElements, allowSharedFiles: $('#allow-shared').checked, status,
  };
  $$('#save,#generate').forEach((b) => { b.disabled = true; });
  try {
    let r = S.request ? await api(`/api/requests/${S.request.id}`, { method: 'PUT', body }) : await api('/api/requests', { method: 'POST', body });
    if (S.pendingFiles.length) {
      const fd = new FormData();
      fd.append('purposes', JSON.stringify(S.pendingFiles.map((f) => f.purpose)));
      S.pendingFiles.forEach((f) => fd.append('files', f.file));
      try { r = await api(`/api/requests/${r.id}/attachments`, { method: 'POST', body: fd }); S.pendingFiles = []; }
      catch (er) { S.request = r; throw new Error(`Request saved, but images were not: ${er.message}`); }
    }
    S.request = r; S.dirty = false;
    history.replaceState(null, '', `/#request=${r.id}`);
    renderThumbs(); renderStatus();
    if (status === 'submitted' && S.ai && S.ai.enabled) {
      $('#form-ok').textContent = 'Saved.';
      await startGeneration(r.id);
    } else {
      $('#form-ok').textContent = status === 'submitted'
        ? 'Saved and marked ready. AI generation is not switched on yet, so no change was made. Nothing on the website has changed.'
        : 'Draft saved. You can come back to it any time from Requests.';
    }
  } catch (er) { $('#form-err').textContent = er.message; renderStatus(); }
  finally { if (!S.readOnly) $$('#save,#generate').forEach((b) => { b.disabled = false; }); }
}
$('#save').addEventListener('click', () => save('draft'));
$('#generate').addEventListener('click', () => save('submitted'));

// ---------- AI generation ----------
let pollTimer = null;
const ICON = { pass: '✓', fail: '✕', warn: '!' };
function renderGen(g) {
  const box = $('#gen');
  if (!g) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const busy = g.status === 'queued' || g.status === 'running';
  const head = {
    queued: 'Waiting to start…', running: 'Generating the change… This usually takes under a minute. The live website is not affected.',
    ready: 'Change generated and checked. It is saved as a separate version and is not published.',
    needs_permission: 'This change needs your permission to edit shared design used on every page.',
    failed: 'The change could not be completed.',
  }[g.status];
  const files = (g.changedFiles || []).map((f) => (f.endsWith('.html') ? (S.registry.pages.find((p) => p.path === f) || {}).title || f : /\.(css|js)$/.test(f) ? 'Shared site design (all pages)' : 'New image')).filter((v, i, a) => a.indexOf(v) === i);
  box.className = `gen ${g.status}`;
  box.innerHTML = `<div class="gen-h">${busy ? '<span class="spin" aria-hidden="true"></span>' : ''}<b>${esc(head)}</b>${g.provider === 'mock' ? ' <span class="badge">test mode – not real AI</span>' : ''}</div>
    ${g.status === 'needs_permission' ? `<p>${esc(g.message || '')}</p><p class="muted small">Tick “Allow changes to shared parts used on every page” above, then click Generate Changes again.</p>` : ''}
    ${g.status === 'failed' && g.message ? `<p>${esc(g.message)}</p>` : ''}
    ${g.summary ? `<p><b>What changed:</b> ${esc(g.summary)}</p>` : ''}
    ${files.length ? `<p class="small"><b>Affects:</b> ${esc(files.join(', '))}</p>` : ''}
    ${g.checks && g.checks.length ? `<ul class="checks">${g.checks.map((c) => `<li class="${c.status}"><span>${ICON[c.status]}</span> ${esc(c.label)}${c.detail && c.status !== 'pass' ? `<em>${esc(c.detail)}</em>` : ''}</li>`).join('')}</ul>` : ''}
    ${g.flagged && g.flagged.some((f) => f.page) ? `<p class="small"><b>Please review before publishing:</b> ${esc(g.flagged.filter((f) => f.page).map((f) => `${f.page} → ${f.area}`).join('; '))}</p>` : ''}
    ${g.usage && g.usage.turns ? `<p class="muted small">Attempt ${g.n} · AI cost about $${Number(g.usage.costUsd || 0).toFixed(3)} (limit $${Number(g.usage.limitUsd || 0).toFixed(2)})</p>` : ''}
    ${g.status === 'ready' ? '<div id="rv-panel"></div>' : ''}`;
  if (g.status === 'ready') loadReview(g.id);
  $('#generate').disabled = busy || S.readOnly;
}
async function pollGen(id) {
  clearTimeout(pollTimer);
  if (!S.request || S.request.id !== id) return;
  try {
    const [g] = await api(`/api/requests/${id}/generations`);
    renderGen(g);
    if (g && (g.status === 'queued' || g.status === 'running')) pollTimer = setTimeout(() => pollGen(id), 2000);
    else if (g) S.request.latestGeneration = g;
  } catch (er) { $('#form-err').textContent = er.message; }
}
async function startGeneration(id) {
  try { renderGen(await api(`/api/requests/${id}/generate`, { method: 'POST' })); $('#gen').scrollIntoView({ block: 'nearest' }); pollTimer = setTimeout(() => pollGen(id), 1500); }
  catch (er) { $('#form-err').textContent = er.message; }
}

// ---------- review (before/after, approve / reject / revise) ----------
const rvA = $('#rv-a'); const rvB = $('#rv-b');
async function loadReview(gid) {
  try {
    const data = await api(`/api/generations/${gid}/review`);
    S.review = { ...(S.review && S.review.gid === gid ? S.review : { page: data.requestPage, device: 'desktop' }), gid, data };
    renderReviewPanel();
  } catch (er) { const p = $('#rv-panel'); if (p) p.textContent = er.message; }
}
function reviewOutcome(g) {
  const r = g.review || {}; const when2 = r.at ? when(r.at) : '';
  if (r.status === 'approved') return `<p class="outcome">✓ Approved by ${esc(r.byName || 'a reviewer')} · ${when2}. Ready to publish in the next stage — nothing has been published yet.</p>`;
  if (r.status === 'rejected') return `<p class="outcome">✕ Rejected by ${esc(r.byName || 'a reviewer')} · ${when2}${r.note ? `: “${esc(r.note)}”` : ''}. The website is unchanged.</p>`;
  if (r.status === 'revision_requested') return `<p class="outcome">↺ Revision requested by ${esc(r.byName || 'a reviewer')} · ${when2}: “${esc(r.note)}”</p><p class="small muted">Adjust the request if needed, then click Generate Changes to create a new version. The feedback is passed to the AI.</p>`;
  return '';
}
function renderReviewPanel() {
  const box = $('#rv-panel'); if (!box || !S.review) return;
  const { data } = S.review; const g = data.generation;
  const item = (i) => (i.kind === 'text' ? `<li><b>Text${i.page ? ` · ${esc(i.page)}` : ''}:</b> ${i.before ? `<del>${esc(i.before)}</del>` : ''} ${i.after ? `→ <ins>${esc(i.after)}</ins>` : '(removed)'}</li>`
    : i.kind === 'image' && i.after ? `<li><b>Image${i.page ? ` · ${esc(i.page)}` : ''}:</b> ${esc(i.before)} → <ins>${esc(i.after)}</ins></li>` : `<li>${esc(i.text)}</li>`);
  const reasons = [...new Set(Object.values(data.allowed).filter(Boolean))];
  const pending = g.review.status === 'pending';
  box.innerHTML = `<div class="group-h">Changes in this version</div><ul class="rv-items">${data.items.map(item).join('') || '<li>No visible differences found.</li>'}</ul>
    ${g.sharedChange ? '<p class="note">This change affects shared parts used on every page. A <b>Publisher</b> must approve it.</p>' : ''}
    <button class="btn" id="rv-open" type="button">Compare before &amp; after</button>
    ${reviewOutcome(g)}
    ${g.review.status === 'approved' ? publishHtml(data) : ''}
    ${pending ? `<div class="decide">
      <button class="btn approve" data-d="approve" ${data.allowed.approve ? 'disabled' : ''}>Approve</button>
      <button class="btn" data-d="revise" ${data.allowed.revise ? 'disabled' : ''}>Request revision</button>
      <button class="btn reject" data-d="reject" ${data.allowed.reject ? 'disabled' : ''}>Reject</button></div>
      ${reasons.length ? `<p class="why">${reasons.map(esc).join(' ')}</p>` : ''}
      <div id="rv-note" hidden><textarea id="rv-text" rows="3" placeholder="What should be different? (sent to the AI for the next version)"></textarea>
        <div class="decide"><button class="btn primary" id="rv-send">Send revision request</button><button class="link small" id="rv-cancel">Cancel</button></div></div>` : ''}`;
}
let pubTimer = null;
function publishHtml(data) {
  const pubs = (data.publications || []).slice().reverse();
  const busy = pubs.some((p) => ['publishing', 'deploying'].includes(p.status));
  const active = pubs.find((p) => p.kind === 'publish' && ['publishing', 'deploying', 'live', 'unverified'].includes(p.status));
  clearTimeout(pubTimer);
  if (busy) pubTimer = setTimeout(() => loadReview(S.review.gid), 4000);
  const page = data.requestPage === 'index.html' ? '' : data.requestPage;
  const view = data.pagesUrl ? `<a href="${esc(data.pagesUrl.replace(/\/?$/, '/') + page)}" target="_blank" rel="noopener">View the published page ↗</a>` : '';
  const line = (p) => {
    const what = p.kind === 'restore' ? 'Restore' : 'Publish';
    return {
      publishing: `<p class="outcome"><span class="spin"></span> ${what}: sending the change to the website…</p>`,
      deploying: `<p class="outcome"><span class="spin"></span> ${what}: waiting for the website to show the change (usually 1–3 minutes)…</p>`,
      live: `<p class="outcome">✓ ${p.kind === 'restore' ? 'Previous version restored' : 'Live on the website'} · ${when(p.liveAt)} by ${esc(p.byName || '')}. ${view}</p>`
        + (p.kind === 'publish' && !data.publishBlocked ? '<button class="btn" data-pub="restore" data-id="' + p.id + '">Restore previous version</button>' : ''),
      unverified: `<p class="outcome">! ${esc(p.message || 'Published, but the website has not shown the change yet.')}</p>${!data.publishBlocked ? `<button class="btn" data-pub="recheck" data-id="${p.id}">Check website</button>${p.kind === 'publish' ? ` <button class="btn" data-pub="restore" data-id="${p.id}">Restore previous version</button>` : ''}` : ''}`,
      failed: `<p class="outcome">✕ ${what} failed: ${esc(p.message || '')}</p>`,
      restored: `<p class="outcome">↺ Published ${when(p.createdAt)}, later restored to the previous version${p.restoredBy && p.restoredBy.liveAt ? ` (${when(p.restoredBy.liveAt)})` : ''}.</p>`,
    }[p.status];
  };
  const canPublish = !active && !busy;
  return `<div class="group-h">Publish</div>${pubs.map(line).join('')}
    ${canPublish ? `<div class="decide"><button class="btn primary" data-pub="publish" ${data.publishBlocked ? 'disabled' : ''}>Publish to website</button></div>
      ${data.publishBlocked ? `<p class="why">${esc(data.publishBlocked)}</p>` : ''}` : ''}`;
}
$('#gen').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pub]'); if (!b) return;
  const act = b.dataset.pub;
  const msg = { publish: 'Publish this approved change to the live website now?', restore: 'Restore the website to how it was before this change?', recheck: null }[act];
  if (msg && !confirm(msg)) return;
  b.disabled = true;
  try {
    if (act === 'publish') await api(`/api/generations/${S.review.gid}/publish`, { method: 'POST' });
    else await api(`/api/publications/${b.dataset.id}/${act}`, { method: 'POST' });
  } catch (er) { $('#form-err').textContent = er.message; }
  loadReview(S.review.gid);
});

async function decideReview(decision, note) {
  try {
    await api(`/api/generations/${S.review.gid}/review`, { method: 'POST', body: { decision, note } });
    const [g] = await api(`/api/requests/${S.request.id}/generations`);
    S.request.latestGeneration = g; renderGen(g);
  } catch (er) { $('#form-err').textContent = er.message; }
}
$('#gen').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'rv-open') openCompare();
  else if (b.dataset.d === 'approve') { if (confirm('Approve this version? It will be ready to publish in the next stage (nothing is published now).')) decideReview('approve'); }
  else if (b.dataset.d === 'reject') { if (confirm('Reject this version? The website stays as it is.')) decideReview('reject'); }
  else if (b.dataset.d === 'revise') { $('#rv-note').hidden = false; $('#rv-text').focus(); }
  else if (b.id === 'rv-cancel') $('#rv-note').hidden = true;
  else if (b.id === 'rv-send') decideReview('revise', $('#rv-text').value);
});

function openCompare() {
  const { data } = S.review;
  $('#rv-page').innerHTML = data.pages.map((p) => `<option value="${esc(p.path)}">${esc(p.title)}</option>`).join('');
  $('#rv-page').value = S.review.page;
  $('.stage').classList.add('reviewing'); $('#review').hidden = false;
  loadCompare();
}
function closeCompare() { $('.stage').classList.remove('reviewing'); $('#review').hidden = true; rvA.src = 'about:blank'; rvB.src = 'about:blank'; requestAnimationFrame(fitFrame); }
async function loadCompare() {
  const g = S.review.data.generation; const p = S.review.page;
  const [a, b] = await Promise.all([g.baseSha, g.resultSha].map((sha) => api(`/api/sites/${S.siteId}/preview-url?page=${encodeURIComponent(p)}&sha=${sha}`)));
  S.previewOrigin = a.previewOrigin;
  rvA.src = a.url; rvB.src = b.url;
  fitCompare();
}
function fitCompare() {
  const wrap = $('#rv-wrap'); if ($('#review').hidden) return;
  const mobile = S.review.device === 'mobile';
  const figW = (wrap.clientWidth - 32) / (getComputedStyle(wrap).gridTemplateColumns.split(' ').length);
  const figH = wrap.clientHeight - 40;
  const w = mobile ? 390 : 1280; const h = mobile ? 844 : null;
  const scale = Math.min(1, figW / w, mobile ? figH / h : 1);
  [rvA, rvB].forEach((f) => {
    f.style.width = `${w}px`; f.style.height = `${mobile ? h : figH / scale}px`; f.style.transform = `scale(${scale})`;
    const box = f.parentElement; box.style.width = `${w * scale}px`; box.style.height = `${mobile ? h * scale : figH}px`; box.classList.toggle('phone', mobile);
  });
}
window.addEventListener('resize', fitCompare);
function compareState(extra = {}) {
  const onReqPage = S.review.page === S.review.data.requestPage;
  const sel = S.area && onReqPage ? S.area.selector : null; const t = onReqPage ? target() : null;
  return { type: 'state', mode: 'off', area: sel, target: t ? t.selector : null, protectedSelectors: onReqPage ? S.protectedElements.map((x) => x.selector) : [], ...extra };
}
window.addEventListener('message', (e) => {
  if (e.origin !== S.previewOrigin || !e.data || $('#review').hidden) return;
  const from = e.source === rvA.contentWindow ? rvA : e.source === rvB.contentWindow ? rvB : null; if (!from) return;
  if (e.data.type === 'ready') {
    const t = target(); const onReq = S.review.page === S.review.data.requestPage;
    from.contentWindow.postMessage(compareState({ scrollTo: onReq ? (t ? t.selector : S.area && S.area.selector) : undefined }), S.previewOrigin);
  } else if (e.data.type === 'scroll' && $('#rv-sync').checked) {
    const other = from === rvA ? rvB : rvA;
    other.contentWindow.postMessage(compareState({ scrollY: e.data.y }), S.previewOrigin);
  }
});
$('#rv-close').addEventListener('click', closeCompare);
$('#rv-page').addEventListener('change', (e) => { S.review.page = e.target.value; loadCompare(); });
$$('#rv-device button').forEach((b) => b.addEventListener('click', () => {
  S.review.device = b.dataset.device; $$('#rv-device button').forEach((x) => x.classList.toggle('on', x === b)); fitCompare();
}));

function resetForm() {
  clearTimeout(pollTimer); renderGen(null); S.review = null; if (!$('#review').hidden) closeCompare();
  S.request = null; S.readOnly = false; S.pendingFiles = []; S.dirty = false; S.changeTypes = []; S.devices = 'all';
  $('#instruction').value = ''; $('#allow-shared').checked = false; $('#placement').value = '';
  $('#form-err').textContent = ''; $('#form-ok').textContent = ''; showNote('');
  history.replaceState(null, '', '/');
}
async function freshRequest() {
  resetForm();
  S.registry = await api(`/api/sites/${S.siteId}/registry`);
  S.readOnly = S.me.role === 'viewer';
  setPage(S.registry.pages.some((p) => p.path === S.page) ? S.page : S.registry.pages[0].path);
}
$('#new-req').addEventListener('click', () => {
  if (S.dirty && !confirm('Discard unsaved edits?')) return;
  freshRequest();
});

async function openRequest(id) {
  const r = await api(`/api/requests/${id}`);
  resetForm();
  S.request = r; S.siteId = r.siteId;
  S.readOnly = !(r.createdBy === S.me.id || S.me.role === 'admin') || S.me.role === 'viewer';
  if (r.baseSha !== S.registry.sha) S.registry = await api(`/api/sites/${S.siteId}/registry?sha=${r.baseSha}`); // areas as they were
  S.page = r.page;
  S.area = areaInfo(r.area);
  S.options = S.area ? [...(r.target ? [{ ...r.target }] : []), { selector: S.area.selector, label: S.area.name, kind: 'area', root: true }] : [];
  S.optIdx = 0;
  S.protectedElements = r.protectedElements; S.changeTypes = r.changeTypes; S.devices = r.devices || 'all';
  $('#instruction').value = r.instruction; $('#allow-shared').checked = r.allowSharedFiles; $('#placement').value = r.placement || '';
  history.replaceState(null, '', `/#request=${r.id}`);
  renderGen(r.latestGeneration);
  if (r.latestGeneration && ['queued', 'running'].includes(r.latestGeneration.status)) pollTimer = setTimeout(() => pollGen(r.id), 1500);
  show('edit'); renderAll(); setMode('off'); loadPreview();
}

// ---------- other views ----------
function show(view) {
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  if (view === 'edit') requestAnimationFrame(fitFrame);
  if (view === 'list') loadList();
  if (view === 'people') loadPeople();
  if (view === 'activity') loadAudit();
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.view === 'edit' && S.request && !S.dirty) freshRequest();
  show(b.dataset.view);
}));

async function loadList() {
  const rows = await api(`/api/requests?site=${S.siteId}`);
  $('#req-rows').innerHTML = rows.length ? rows.map((r) => `
    <tr data-id="${r.id}" tabindex="0"><td>${r.id}</td><td>${esc(r.sectionLabel)}</td><td class="clip">${esc(r.instruction)}</td>
    <td><span class="pill ${r.status}">${r.status === 'draft' ? 'Draft' : 'Ready'}</span></td><td>${esc(r.author)}</td><td>${when(r.updatedAt)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="muted">No requests yet.</td></tr>';
}
$('#req-rows').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openRequest(tr.dataset.id); });
$('#req-rows').addEventListener('keydown', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr && e.key === 'Enter') openRequest(tr.dataset.id); });

async function loadPeople() {
  const users = await api('/api/admin/users');
  $('#user-rows').innerHTML = users.map((u) => `
    <tr data-id="${u.id}"><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
    <td><select data-act="role">${['viewer', 'editor', 'publisher', 'admin'].map((r) => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
    <td>${u.disabled ? 'Disabled' : 'Active'}</td>
    <td><button class="link" data-act="toggle">${u.disabled ? 'Enable' : 'Disable'}</button> · <button class="link" data-act="reset">Reset password</button></td></tr>`).join('');
}
$('#user-rows').addEventListener('change', async (e) => {
  if (e.target.dataset.act !== 'role') return;
  try { await api(`/api/admin/users/${e.target.closest('tr').dataset.id}`, { method: 'PATCH', body: { role: e.target.value } }); }
  catch (er) { $('#user-err').textContent = er.message; } loadPeople();
});
$('#user-rows').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return;
  const id = b.closest('tr').dataset.id;
  try {
    if (b.dataset.act === 'toggle') await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { disabled: b.textContent === 'Disable' } });
    if (b.dataset.act === 'reset') { const pw = prompt('New temporary password (12+ characters):'); if (pw) await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { password: pw } }); }
    $('#user-err').textContent = '';
  } catch (er) { $('#user-err').textContent = er.message; }
  loadPeople();
});
$('#add-user').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = e.target;
  try { await api('/api/admin/users', { method: 'POST', body: Object.fromEntries(new FormData(f)) }); f.reset(); $('#user-err').textContent = ''; loadPeople(); }
  catch (er) { $('#user-err').textContent = er.message; }
});
async function loadAudit() {
  const rows = await api('/api/admin/audit');
  $('#audit-rows').innerHTML = rows.map((a) => `<tr><td>${when(a.ts)}</td><td>${esc(a.email || '—')}</td><td>${esc(a.action.replace(/_/g, ' '))}</td><td class="clip mono">${esc(a.details)}</td></tr>`).join('');
}

$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); location.href = '/login'; });
window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ---------- boot ----------
(async function boot() {
  S.me = await api('/api/me');
  S.ai = await api('/api/ai/status');
  $('#who').textContent = `${S.me.name} · ${S.me.role}`;
  if (S.me.role === 'admin') $$('.admin-only').forEach((b) => { b.hidden = false; });
  S.sites = await api('/api/sites');
  $('#site').innerHTML = S.sites.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  S.siteId = S.sites[0].id;
  $('#site').addEventListener('change', async (e) => {
    if (S.dirty && !confirm('Discard unsaved edits?')) { e.target.value = S.siteId; return; }
    const prev = S.siteId; S.siteId = e.target.value;
    try { resetForm(); S.registry = await api(`/api/sites/${S.siteId}/registry`); S.readOnly = S.me.role === 'viewer'; setPage(S.registry.pages[0].path); }
    catch (er) { alert(`This website can't be opened yet: ${er.message}`); S.siteId = prev; e.target.value = prev; }
  });
  S.registry = await api(`/api/sites/${S.siteId}/registry`);
  if (S.me.role === 'viewer') { S.readOnly = true; }
  const m = location.hash.match(/request=(\d+)/);
  if (m) { await openRequest(m[1]).catch(() => setPage(S.registry.pages[0].path)); }
  else setPage(S.registry.pages[0].path);
  fitFrame();
})().catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<p class="err banner">${esc(e.message)}</p>`); });
