import {LocalFolders, newId} from './hosted-files.js';

const clone = value => structuredClone(value);
const initialSession = () => ({scale: 1, countdown: 3, gamepad: {}, shortcuts: {}, assignment_id: null, submission_id: null, feedback_id: null});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function probe(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  try {
    video.preload = 'metadata'; video.src = url;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Video metadata timed out.')), 10000);
      video.onloadedmetadata = () => { clearTimeout(timer); resolve({duration: video.duration, width: video.videoWidth, height: video.videoHeight}); };
      video.onerror = () => { clearTimeout(timer); reject(new Error('This browser cannot play this video. Convert a copy to H.264 MP4 and reconnect the folder.')); };
    });
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}

export class BrowserStorage {
  constructor() {
    this.mode = 'browser';
    this.folders = new LocalFolders();
    this.catalog = {schema_version: 1, revision: 0, library: [], assets: []};
    this.urls = new Map();
    this.thumbnails = new Map();
    this.ready = false;
    this.evaluated = false;
    this.session = initialSession();
    this.roster = [];
    this.evaluatedVersions = new Map();
    this.savedAssets = '[]';
    this.pendingDocumentSave = false;
    this.mediaGeneration = 0;
  }
  get path() {
    if (!this.folders.root) return '';
    return '/video/' + [this.folders.root.name, ...this.folders.path].map(encodeURIComponent).join('/');
  }
  pathParts(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    if (parts[0] !== 'video' || decodeURIComponent(parts[1] || '') !== this.folders.root?.name) throw new Error('Choose a folder inside the connected video root.');
    return parts.slice(2).map(decodeURIComponent);
  }
  revision() { return `${this.folders.revision}:${this.catalog.revision}`; }
  async initialize() {
    if (this.ready) return;
    try {
      try { this.session = {...initialSession(), ...JSON.parse(localStorage.getItem('still-browser-session') || '{}')}; }
      catch { this.session = initialSession(); }
      this.session.assignment_id = null;
      this.session.submission_id = null;
      this.session.feedback_id = null;
      if (await this.folders.restore()) {
        await this.open(this.folders.path);
        const draft = await this.folders.recoveryDraft();
        if (draft?.revision === this.folders.revision && confirm('Recover unsaved edits from this browser?')) {
          await this.folders.acceptDraft(draft);
          await this.folders.save();
        } else this.pendingDraft = draft;
      } else {
        await this.loadCatalog();
      }
      this.ready = true;
    } catch (error) {
      this.ready = false;
      throw error;
    }
  }
  async loadWorkspace() {await this.initialize(); return this.workspace();}
  async loadCatalog() {
    await this.folders.restoreLibrary();
    const rootGranted = this.folders.root && (await this.folders.root.queryPermission({mode: 'readwrite'})) === 'granted';
    if (!this.folders.library && !this.folders.savedLibrary && rootGranted) {
      const data = await this.folders.root.getDirectoryHandle('data', {create: true});
      const directory = await data.getDirectoryHandle('library', {create: true});
      const catalog = await directory.getFileHandle('catalog.json', {create: true});
      if (!(await catalog.getFile()).size) {
        const writer = await catalog.createWritable();
        try {await writer.write(JSON.stringify({schema_version: 1, revision: 0, library: [], assets: []})); await writer.close();}
        catch (error) {await writer.abort().catch(() => {}); throw error;}
      }
      await directory.getDirectoryHandle('media', {create: true});
      this.folders.library = directory;
    }
    this.catalog = await this.folders.readLibraryCatalog();
  }
  async cacheAsset(asset, file) {
    if (this.urls.has(asset.id)) return this.urls.get(asset.id);
    const generation = this.mediaGeneration;
    const url = URL.createObjectURL(file);
    this.urls.set(asset.id, url);
    try {await this.makeThumbnail(asset.id, url, generation);} catch {}
    return url;
  }
  async makeThumbnail(id, url, generation) {
    const player = document.createElement('video');
    player.muted = true;
    player.preload = 'auto';
    player.src = url;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Thumbnail timed out.')), 5000);
        player.onloadeddata = () => {clearTimeout(timer); resolve();};
        player.onerror = () => {clearTimeout(timer); reject(new Error('Thumbnail unavailable.'));};
      });
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
      canvas.getContext('2d').drawImage(player, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .7));
      if (blob && generation === this.mediaGeneration && this.urls.get(id) === url) this.thumbnails.set(id, URL.createObjectURL(blob));
    } finally {player.removeAttribute('src'); player.load();}
  }
  releaseUrls() {
    this.mediaGeneration++;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    for (const url of this.thumbnails.values()) URL.revokeObjectURL(url);
    this.urls.clear(); this.thumbnails.clear();
  }
  async open(parts, descend = false) {
    if (!same(parts, this.folders.path)) this.releaseUrls();
    const result = await this.folders.open(parts, descend);
    this.evaluated = result.evaluated;
    this.roster = this.evaluated ? [] : await this.notSubmitted();
    await this.loadCatalog();
    if (this.evaluated) {
      for (const [name, handle] of result.files) {
        const file = await handle.getFile();
        const version = `${file.lastModified}-${file.size}`;
        if (this.evaluatedVersions.get(name) !== version) {
          const previous = this.urls.get(name), previousThumbnail = this.thumbnails.get(name);
          if (previous) URL.revokeObjectURL(previous);
          if (previousThumbnail) URL.revokeObjectURL(previousThumbnail);
          this.urls.delete(name); this.thumbnails.delete(name);
        }
        this.evaluatedVersions.set(name, version);
        const asset = {id: name, filename: name};
        await this.cacheAsset(asset, file);
      }
      return this.workspace();
    }
    let changed = this.folders.document.revision === 0;
    for (const review of result.document.reviews) {
      review.asset_id ||= newId().replaceAll('-', '');
      let asset = result.document.assets.find(item => item.id === review.asset_id);
      if (!asset) {
        asset = {id: review.asset_id, kind: 'student', filename: review.filename, duration: 0, width: 0, height: 0};
        result.document.assets.push(asset); changed = true;
      }
      try {
        const file = await this.folders.fileFor(asset);
        await this.cacheAsset(asset, file);
        if (!asset.duration || !asset.width || !asset.height) {Object.assign(asset, await probe(file)); changed = true;}
      } catch (error) {asset.source_missing = true; asset.error = error.message;}
    }
    if (changed) await this.folders.save();
    this.savedAssets = JSON.stringify(this.folders.document.assets);
    this.pendingDocumentSave = false;
    for (const asset of result.document.assets) if (asset.kind === 'private' && !this.urls.has(asset.id)) {
      try {await this.cacheAsset(asset, await this.folders.fileFor(asset));} catch {}
    }
    for (const asset of this.catalog.assets) if (!this.urls.has(asset.id)) {
      try {await this.cacheAsset(asset, await this.folders.libraryFileFor(asset));} catch {}
    }
    return this.workspace();
  }
  async notSubmitted() {
    let log;
    try {
      const data = await this.folders.folder.getDirectoryHandle('data');
      log = JSON.parse((await (await (await data.getFileHandle('student_submission_log.json')).getFile()).text()).replace(/^\uFEFF/, ''));
    } catch {return [];}
    if (!log || Array.isArray(log) || typeof log !== 'object') return [];
    const submittedIds = new Set(), submittedNames = new Set();
    for (const filename of this.folders.files.keys()) {
      if (filename.toLowerCase().includes('.partial.')) continue;
      const stem = filename.replace(/\.[^.]+$/, '');
      const match = stem.match(/^.+?_(\d+)_.+/);
      if (match) submittedIds.add(match[1]); else submittedNames.add(stem.trim().toLocaleLowerCase());
    }
    const seen = new Set(), students = [];
    for (const [key, entry] of Object.entries(log)) {
      if (!entry || entry.hasAttachments !== false || entry.downloaded === true || typeof entry.studentName !== 'string' || !entry.studentName.trim()) continue;
      const id = String(entry.studentId || key), name = entry.studentName.trim();
      if (seen.has(id) || submittedIds.has(id) || submittedNames.has(name.toLocaleLowerCase())) continue;
      seen.add(id); students.push({id, name, status: 'Not Submitted'});
    }
    return students;
  }
  workspace() {
    const session = {...this.session, source_folder: this.path};
    if (!this.folders.root || !this.folders.folder) {
      session.source_folder = '';
      return {revision: this.revision(), state: {assignments: [], submissions: [], library: clone(this.catalog.library), session}, assets: clone(this.catalog.assets), capabilities: this.capabilities(), categories: [], purposes: [], source_folder: '', output_folder: '', not_submitted: []};
    }
    if (this.evaluated) {
      const assignmentId = 'evaluated-' + (this.folders.root.name + this.folders.path.join('/'));
      const assets = [...this.folders.files.keys()].map(name => ({id: name, kind: 'submission', name, filename: name, source_path: `${this.path}/${encodeURIComponent(name)}`, source_folder: this.path, evaluated_version: this.evaluatedVersions.get(name)}));
      const submissions = assets.map(asset => ({id: asset.id, asset_id: asset.id, assignment_id: assignmentId, name: asset.name.replace(/\.[^.]+$/, ''), status: 'Exported', feedback: [], position: 0}));
      session.assignment_id = assignmentId;
      return {revision: this.revision(), state: {assignments: [{id: assignmentId, title: 'Evaluated videos'}], submissions, library: clone(this.catalog.library), session}, assets, capabilities: this.capabilities(), categories: [], purposes: [], source_folder: this.path, output_folder: this.path, not_submitted: [], read_only_folder: true};
    }
    const document = this.folders.document;
    const assignmentId = document.folder_id;
    const submissions = document.reviews.map(review => ({...clone(review), asset_id: review.asset_id, assignment_id: assignmentId, name: (review.filename || '').replace(/\.[^.]+$/, ''), position: 0}));
    const localAssets = document.assets.map(asset => ({...clone(asset), kind: asset.kind === 'student' ? 'submission' : asset.kind === 'private' ? 'correction' : asset.kind, name: asset.filename, source_folder: this.path, source_path: asset.kind === 'student' ? `${this.path}/${encodeURIComponent(asset.filename)}` : undefined}));
    const libraryAssets = this.catalog.assets.map(asset => ({...clone(asset), kind: 'reference', name: asset.filename}));
    const uniqueAssets = new Map([...libraryAssets, ...localAssets].map(asset => [asset.id, asset]));
    session.assignment_id = assignmentId;
    return {revision: this.revision(), state: {assignments: [{id: assignmentId, title: 'My ASL class', instructions: '', target: ''}], submissions, library: clone(this.catalog.library), session}, assets: [...uniqueAssets.values()], capabilities: this.capabilities(), categories: [], purposes: [], source_folder: this.path, output_folder: this.path, not_submitted: this.roster, imported: submissions.length, skipped: 0, errors: []};
  }
  capabilities() {return {ffmpeg: false, ffprobe: false, tracking: false, cleanup: false, delete_library: false, open_folder: false, browser_storage: true};}
  async chooseFolder() {
    const root = await this.folders.choose();
    await this.folders.activate(root);
    return this.open([], true);
  }
  async openFolder(path) {return this.open(this.pathParts(path));}
  async listFolders(path) {
    const base = this.pathParts(path);
    return {folders: (await this.folders.children(base)).map(handle => ({name: handle.name, path: '/video/' + [this.folders.root.name, ...base, handle.name].map(encodeURIComponent).join('/')}))};
  }
  async chooseLibrary() {
    await this.folders.selectLibrary();
    await this.loadCatalog();
    return this.open(this.folders.path);
  }
  async saveAsset(file, kind) {
    if (!this.folders.root || this.evaluated) throw new Error('Choose an editable video folder first.');
    const details = await probe(file);
    if (kind === 'submission') {
      if (this.folders.files.has(file.name)) throw new Error('This source video already exists. Browse to its folder to review it; the original was not changed.');
      const handle = await this.folders.folder.getFileHandle(file.name, {create: true});
      const writer = await handle.createWritable();
      try {await writer.write(file); await writer.close();} catch (error) {await writer.abort().catch(() => {}); throw error;}
      this.folders.files.set(file.name, handle);
      const asset = {id: newId().replaceAll('-', ''), kind: 'student', filename: file.name, ...details};
      this.folders.document.assets.push(asset);
      await this.cacheAsset(asset, file);
      return {...asset, kind: 'submission', name: file.name, source_path: `${this.path}/${encodeURIComponent(file.name)}`, source_folder: this.path};
    }
    if (kind === 'reference') {
      const asset = await this.folders.writeLibraryMedia(file, details);
      this.catalog.assets.push(asset);
      await this.cacheAsset(asset, file);
      return {...asset, kind: 'reference', name: file.name};
    }
    const asset = await this.folders.savePrivate(file, details);
    await this.cacheAsset(asset, file);
    return {...asset, kind: 'correction', name: file.name, source_folder: this.path};
  }
  async trimAsset(id, start, end) {
    const original = [...(this.folders.document?.assets || []), ...this.catalog.assets].find(asset => asset.id === id);
    if (!original) throw new Error('The recording is unavailable.');
    const asset = {...clone(original), id: newId().replaceAll('-', ''), trim_start: start, trim_end: end};
    (original.kind === 'private' ? this.folders.document.assets : this.catalog.assets).push(asset);
    if (this.urls.has(id)) this.urls.set(asset.id, this.urls.get(id));
    if (this.thumbnails.has(id)) this.thumbnails.set(asset.id, this.thumbnails.get(id));
    return {...asset, kind: asset.kind === 'private' ? 'correction' : 'reference'};
  }
  async saveWorkspace(state, revision) {
    if (this.evaluated) throw new Error('Choose an editable video folder first.');
    const document = this.folders.document;
    const nextReviews = state.submissions.map(row => {
      if (!document) throw new Error('Choose a video folder before saving a review.');
      const prior = document.reviews.find(item => item.id === row.id) || {};
      const next = {...prior, ...clone(row)};
      delete next.assignment_id; delete next.name; delete next.position;
      return next;
    });
    const catalogIds = new Set(this.catalog.assets.map(asset => asset.id));
    const libraryChanged = !same(state.library, this.catalog.library);
    const docChanged = document && (this.pendingDocumentSave || !same(nextReviews, document.reviews) || JSON.stringify(document.assets) !== this.savedAssets);
    const [folderRevision, libraryRevision] = String(revision).split(':').map(Number);
    if (docChanged && folderRevision !== this.folders.revision) throw new Error('This folder changed. Reload before saving.');
    if (libraryChanged && libraryRevision !== this.catalog.revision) throw new Error('The reusable library changed. Reload before saving.');
    if (libraryChanged) {
      for (const entry of state.library) if (!catalogIds.has(entry.asset_id)) {
        const asset = document?.assets.find(item => item.id === entry.asset_id);
        if (!asset) throw new Error('A library recording is missing.');
        const file = await this.folders.fileFor(asset);
        const media = await this.folders.chooseLibrary();
        const directory = await media.getDirectoryHandle('media');
        const handle = await directory.getFileHandle(asset.filename, {create: true});
        const writer = await handle.createWritable();
        try {await writer.write(file); await writer.close();} catch (error) {await writer.abort().catch(() => {}); throw error;}
        this.catalog.assets.push({...clone(asset), kind: 'correction'});
        catalogIds.add(entry.asset_id);
      }
      this.catalog = await this.folders.saveLibraryCatalog({...this.catalog, library: clone(state.library)});
    }
    if (docChanged) {
      document.reviews = nextReviews;
      try {await this.folders.save(); this.savedAssets = JSON.stringify(document.assets); this.pendingDocumentSave = false;}
      catch (error) {
        this.pendingDocumentSave = true;
        await this.folders.rememberDraft(document).catch(() => {});
        this.pendingDraft = await this.folders.recoveryDraft().catch(() => null);
        error.revision = this.revision();
        throw error;
      }
    }
    this.session = {...this.session, ...clone(state.session)};
    delete this.session.source_folder;
    const preferences = {...this.session};
    delete preferences.assignment_id;
    delete preferences.submission_id;
    delete preferences.feedback_id;
    try {localStorage.setItem('still-browser-session', JSON.stringify(preferences));} catch {}
    return {revision: this.revision()};
  }
  mediaUrl(id) {return this.urls.get(id) || '';
  }
  thumbnailUrl(id) {return this.thumbnails.get(id) || '';}
  evaluatedUrl(asset) {return this.mediaUrl(asset.id);}
  async resolveExportMedia(ids) {
    const media = new Map();
    for (const id of ids) {
      const local = this.folders.document?.assets.find(asset => asset.id === id);
      const library = this.catalog.assets.find(asset => asset.id === id);
      if (!local && !library) throw new Error('An attached recording is missing.');
      media.set(id, {file: local ? await this.folders.fileFor(local) : await this.folders.libraryFileFor(library)});
    }
    return media;
  }
  async saveExport(snapshot, blob) {
    if (this.evaluated || snapshot.sourceFolder !== this.path) throw new Error('The source folder changed during rendering. Export again.');
    if (snapshot.revision !== this.revision()) throw new Error('The review changed during rendering. Export again.');
    const current = await this.folders.readDocument();
    if (current.revision !== this.folders.revision) throw new Error('The review changed in another window. Export again.');
    const currentCatalog = await this.folders.readLibraryCatalog();
    if (currentCatalog.revision !== this.catalog.revision) throw new Error('The reusable library changed in another window. Export again.');
    const document = this.folders.document;
    const item = document.reviews.find(row => row.id === snapshot.submissionId);
    if (!item) throw new Error('The review is no longer available.');
    const filename = await this.folders.writeExport(item.filename, blob);
    item.exports ||= [];
    item.exports.push({filename, at: new Date().toISOString(), revision: document.revision});
    item.status = item.feedback.every(row => row.note?.trim() || row.clips?.length) ? 'Exported' : 'In progress';
    item.evaluated_export_count = (item.evaluated_export_count || 0) + 1;
    await this.folders.save();
    return {filename, saved_directory: this.path + '/evaluated', revision: this.revision(), submission_status: item.status, export_count: item.evaluated_export_count};
  }
  async status() {
    const permission = async handle => {
      if (!handle) return 'not selected';
      try {return await handle.queryPermission({mode: 'readwrite'});} catch {return 'unavailable';}
    };
    const folderAccess = await permission(this.folders.root);
    return {ok: folderAccess === 'granted', folder: this.folders.root?.name || '',
      folderAccess, library: this.folders.library?.name || '', libraryAccess: await permission(this.folders.library)};
  }
  async reconnect() {
    const missingRoot = !this.folders.root;
    await this.folders.reconnect();
    return this.open(missingRoot ? [] : this.folders.path, missingRoot);
  }
  dispose() {this.releaseUrls();}
}
