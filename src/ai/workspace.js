'use strict';
// Isolated working copy for one generation. Files are read from git objects at the request's base version and
// edits are held in memory; nothing touches the published site. The model can only use the tools defined here:
// no shell, no network, no file system outside this copy, no credentials.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const sites = require('../sites');
const { REPO_DIR, UPLOAD_DIR } = require('../config');

const run = promisify(execFile);
const MAX_READ = Number(process.env.AI_MAX_READ_CHARS || 150000); // keep within small models' context windows
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

class Workspace {
  constructor({ site, sha, crId, writable, attachments }) {
    this.site = site; this.sha = sha; this.crId = crId;
    this.writable = new Set(writable); // paths the model may edit
    this.attachments = attachments; // [{id, stored_name, mime, purpose, original_name}]
    this.changes = new Map(); // path -> string (text edits)
    this.binaries = new Map(); // path -> Buffer (inserted images)
    this.files = null;
    this.permissionRequest = null;
    this.finished = null;
  }

  async init() {
    this.files = (await sites.listFiles(this.site, this.sha)).filter((f) => sites.isAllowedPath(this.site, f));
    return this;
  }

  async current(p) {
    if (this.changes.has(p)) return this.changes.get(p);
    const b = await sites.readFile(this.site, this.sha, p);
    return b ? b.toString('utf8') : null;
  }

  // ---- tools exposed to the model ----
  static toolDefs() {
    return [
      { name: 'list_files', description: 'List the website files you may read, and which of them you may edit.', input_schema: { type: 'object', properties: {} } },
      { name: 'read_file', description: 'Read a website file. Optionally a line range (1-based, inclusive).',
        input_schema: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } },
      { name: 'edit_file', description: 'Replace one exact, unique piece of text in an editable file. old_text must match the current file exactly once (include enough surrounding text). Use an empty new_text to delete.',
        input_schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
      { name: 'insert_image', description: 'Add one of the user\'s attached images (marked "use on the website") to the site. Returns the file name to reference in HTML (e.g. <img src="NAME">).',
        input_schema: { type: 'object', properties: { attachment_id: { type: 'integer' } }, required: ['attachment_id'] } },
      { name: 'request_permission', description: 'Stop and ask the user for permission when the change cannot be done well without editing a file you are not allowed to edit (for example the shared site-wide stylesheet or script used by every page). Explain why in plain English.',
        input_schema: { type: 'object', properties: { reason: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, required: ['reason'] } },
      { name: 'finish', description: 'Call once when the change is complete. summary: 1-3 plain-English sentences for a non-technical reader describing what you changed.',
        input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
    ];
  }

  async runTool(name, input = {}) {
    try {
      switch (name) {
        case 'list_files':
          return this.files.map((f) => `${f}${this.writable.has(f) ? '  (editable)' : '  (read-only)'}`).join('\n');
        case 'read_file': {
          const p = String(input.path || '');
          if (!this.files.includes(p) && !this.binaries.has(p)) return err(`"${p}" is not available. Use list_files.`);
          if (this.binaries.has(p)) return err('That is an image file.');
          const text = await this.current(p);
          let lines = text.split('\n');
          const s = Math.max(1, Number(input.start_line) || 1);
          const e = Math.min(lines.length, Number(input.end_line) || lines.length);
          lines = lines.slice(s - 1, e).map((l, i) => `${s + i}\t${l}`);
          const out = lines.join('\n');
          return out.length > MAX_READ ? `${out.slice(0, MAX_READ)}\n[truncated: read a smaller line range]` : out;
        }
        case 'edit_file': {
          const p = String(input.path || '');
          if (!this.writable.has(p)) {
            const shared = (this.site.sharedFiles || []).includes(p);
            return err(shared
              ? `"${p}" is shared by every page and you do not have permission to edit it. Use a scoped <style data-editor> block in the page instead, or call request_permission if the change truly needs it.`
              : `"${p}" is outside the scope of this request and cannot be edited.`);
          }
          const oldText = String(input.old_text ?? ''); const newText = String(input.new_text ?? '');
          if (!oldText) return err('old_text must not be empty.');
          const text = await this.current(p);
          const n = text.split(oldText).length - 1;
          if (n !== 1) return err(n === 0 ? 'old_text was not found. Read the file again and copy the text exactly.' : `old_text matches ${n} places; include more surrounding text.`);
          this.changes.set(p, text.replace(oldText, () => newText));
          return `Edited ${p}.`;
        }
        case 'insert_image': {
          const a = this.attachments.find((x) => x.id === Number(input.attachment_id));
          if (!a) return err('Unknown attachment id.');
          if (a.purpose !== 'use') return err('That image was attached for reference only, not for use on the website.');
          const name = `editor-r${this.crId}-${a.id}.${EXT[a.mime] || 'img'}`;
          this.binaries.set(name, fs.readFileSync(path.join(UPLOAD_DIR, a.stored_name)));
          return `Image added as "${name}". Reference it with src="${name}".`;
        }
        case 'request_permission':
          this.permissionRequest = { reason: String(input.reason || '').slice(0, 600), files: Array.isArray(input.files) ? input.files.map(String).slice(0, 10) : [] };
          return 'Permission request recorded. Stop now.';
        case 'finish':
          this.finished = { summary: String(input.summary || '').slice(0, 800) };
          return 'Done.';
        default:
          return err(`Unknown tool "${name}".`);
      }
    } catch (e) {
      return err(`Tool failed: ${e.message}`);
    }
  }

  changedFiles() {
    return [...this.changes.keys(), ...this.binaries.keys()];
  }

  // Save the generated version as a separate commit on a private local branch (never pushed, never published).
  async commit(message) {
    const repo = path.join(REPO_DIR, `${this.site.id}.git`);
    const idx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tse-idx-')), 'index');
    const env = { ...process.env, GIT_INDEX_FILE: idx, GIT_AUTHOR_NAME: 'Website Editor', GIT_AUTHOR_EMAIL: 'editor@localhost',
      GIT_COMMITTER_NAME: 'Website Editor', GIT_COMMITTER_EMAIL: 'editor@localhost', GIT_TERMINAL_PROMPT: '0' };
    const git = (args, input) => new Promise((resolve, reject) => {
      const p = execFile('git', args, { cwd: repo, env, maxBuffer: 20 * 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(out.trim())));
      if (input !== undefined) { p.stdin.end(input); }
    });
    await git(['read-tree', this.sha]);
    const all = [...this.changes.entries(), ...this.binaries.entries()];
    for (const [p, content] of all) {
      const blob = await git(['hash-object', '-w', '--stdin'], content);
      await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${p}`]);
    }
    const tree = await git(['write-tree']);
    const commit = await git(['commit-tree', tree, '-p', this.sha, '-m', message]);
    fs.rmSync(path.dirname(idx), { recursive: true, force: true });
    return commit;
  }
}

async function setRef(site, ref, sha) {
  await run('git', ['update-ref', ref, sha], { cwd: path.join(REPO_DIR, `${site.id}.git`) });
}

const err = (m) => ({ error: m });
module.exports = { Workspace, setRef };
