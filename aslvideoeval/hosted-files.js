// The browser owns student reviews. The hosted service never receives these files.
const DB_NAME = 'still-hosted-folders';
const VIDEO = /\.(mp4|m4v|mov|webm|mkv)$/i;
const HIDDEN = new Set(['data', 'deleted files']);
const byName = (a, b) => a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'});
export const newId = () => crypto.randomUUID();

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function setting(key, value) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('settings', value === undefined ? 'readonly' : 'readwrite');
      const request = value === undefined ? transaction.objectStore('settings').get(key) : transaction.objectStore('settings').put(value, key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {db.close();}
}

export class LocalFolders {
  constructor() {this.root = null; this.path = []; this.folder = null; this.document = null; this.revision = 0; this.files = new Map(); this.library = null; this.savedLibrary = null;}
  async restore() {
    this.root = await setting('root') || null;
    this.path = await setting('path') || [];
    if (!this.root) return false;
    return (await this.root.queryPermission({mode: 'readwrite'})) === 'granted';
  }
  async choose() {
    if (!window.showDirectoryPicker) throw new Error('Choose a folder in current desktop Chrome or Edge over HTTPS.');
    const root = await window.showDirectoryPicker({mode: 'readwrite'});
    if (HIDDEN.has(root.name.toLowerCase()) || root.name.toLowerCase() === 'evaluated') throw new Error('Choose the parent folder containing original videos, not data, deleted files, or evaluated.');
    if ((await root.queryPermission({mode: 'readwrite'})) !== 'granted' &&
        (await root.requestPermission({mode: 'readwrite'})) !== 'granted') throw new Error('Read/write folder permission is required.');
    return root;
  }
  async activate(root) {
    this.root = root;
    this.path = [];
    await setting('root', this.root);
    await setting('path', this.path);
  }
  async restoreLibrary() {
    this.library = null;
    if (await setting('libraryOverride')) {
      this.savedLibrary = await setting('library') || null;
      if (this.savedLibrary && (await this.savedLibrary.queryPermission({mode: 'readwrite'})) === 'granted') {
        this.library = this.savedLibrary;
        return true;
      }
      return false;
    }
    if (this.root && (await this.root.queryPermission({mode: 'readwrite'})) === 'granted') {
      try {
        const data = await this.root.getDirectoryHandle('data');
        const directory = await data.getDirectoryHandle('library');
        await directory.getFileHandle('catalog.json');
        this.library = directory;
        return true;
      } catch (error) {if (error.name !== 'NotFoundError') throw error;}
    }
    this.savedLibrary = await setting('library') || null;
    if (this.savedLibrary && (await this.savedLibrary.queryPermission({mode: 'readwrite'})) === 'granted') {
      this.library = this.savedLibrary;
      return true;
    }
    return false;
  }
  async chooseLibrary() {
    if (!this.library) await this.restoreLibrary();
    const candidate = this.library || this.savedLibrary;
    if (candidate) {
      if ((await candidate.queryPermission({mode: 'readwrite'})) === 'granted' ||
          (await candidate.requestPermission({mode: 'readwrite'})) === 'granted') {
        this.library = candidate;
        return candidate;
      }
    }
    return this.selectLibrary();
  }
  async selectLibrary() {
    if (!window.showDirectoryPicker) throw new Error('Choose a reusable library folder in current desktop Chrome or Edge over HTTPS.');
    const directory = await window.showDirectoryPicker({id: 'still-library', mode: 'readwrite'});
    if ((await directory.queryPermission({mode: 'readwrite'})) !== 'granted' &&
        (await directory.requestPermission({mode: 'readwrite'})) !== 'granted') throw new Error('Read/write library permission is required.');
    let catalogHandle;
    try {catalogHandle = await directory.getFileHandle('catalog.json');}
    catch (error) {if (error.name !== 'NotFoundError') throw error; catalogHandle = await directory.getFileHandle('catalog.json', {create: true});}
    await directory.getDirectoryHandle('media', {create: true});
    if (!(await catalogHandle.getFile()).size) {
      const writer = await catalogHandle.createWritable({keepExistingData: false});
      await writer.write(JSON.stringify({schema_version: 1, revision: 0, library: [], assets: []}, null, 2));
      await writer.close();
    }
    this.library = directory;
    this.savedLibrary = directory;
    await setting('library', directory);
    await setting('libraryOverride', true);
    return directory;
  }
  async readLibraryCatalog() {
    if (!this.library) return {schema_version: 1, revision: 0, library: [], assets: []};
    const handle = await this.library.getFileHandle('catalog.json');
    const file = await handle.getFile();
    if (!file.size) return {schema_version: 1, revision: 0, library: [], assets: []};
    const catalog = JSON.parse(await file.text());
    if (catalog.schema_version !== 1 || !Array.isArray(catalog.library) || !Array.isArray(catalog.assets) ||
        (catalog.revision !== undefined && !Number.isInteger(catalog.revision))) throw new Error('Unsupported or damaged catalog.json. The file was not changed.');
    catalog.revision ??= 0;
    return catalog;
  }
  async writeLibraryMedia(file, metadata = {}) {
    const directory = await this.chooseLibrary();
    const id = newId().replaceAll('-', '');
    const extension = file.name.match(/\.[^.]+$/)?.[0]?.toLowerCase() || '.webm';
    const filename = `${id}${extension}`;
    const media = await directory.getDirectoryHandle('media');
    const handle = await media.getFileHandle(filename, {create: true});
    const writer = await handle.createWritable({keepExistingData: false});
    try {await writer.write(file); await writer.close();}
    catch (error) {await writer.abort().catch(() => {}); throw error;}
    return {id, filename, kind: 'correction', ...metadata};
  }
  async saveLibraryCatalog(catalog) {
    const directory = await this.chooseLibrary();
    const save = async () => {
      const current = await this.readLibraryCatalog();
      if (current.revision !== catalog.revision) throw new Error('The reusable library changed in another window. Reload it before saving again.');
      const next = {...catalog, revision: current.revision + 1};
      let handle;
      try {handle = await directory.getFileHandle('catalog.json');}
      catch (error) {if (error.name !== 'NotFoundError') throw error; handle = await directory.getFileHandle('catalog.json', {create: true});}
      const writer = await handle.createWritable({keepExistingData: false});
      try {
        if ((await this.readLibraryCatalog()).revision !== current.revision) throw new Error('The reusable library changed in another window. Reload it before saving again.');
        await writer.write(JSON.stringify(next, null, 2)); await writer.close();
      } catch (error) {await writer.abort().catch(() => {}); throw error;}
      return next;
    };
    const key = 'still-library-' + (directory.name || 'library');
    return navigator.locks ? navigator.locks.request(key, save) : save();
  }
  async libraryFileFor(asset) {
    const directory = await this.chooseLibrary();
    const media = await directory.getDirectoryHandle('media');
    return (await (await media.getFileHandle(asset.filename)).getFile());
  }
  async reconnect() {
    if (!this.root) return this.activate(await this.choose());
    if ((await this.root.requestPermission({mode: 'readwrite'})) !== 'granted') throw new Error('Folder access was denied. Choose Browse for video to reconnect.');
    this.path = await setting('path') || this.path;
  }
  async directory(path = this.path) {
    if (!this.root) throw new Error('Choose a video folder first.');
    let handle = this.root;
    for (const name of path) handle = await handle.getDirectoryHandle(name);
    return handle;
  }
  async children(path = this.path) {
    const folder = await this.directory(path), children = [];
    for await (const handle of folder.values()) if (handle.kind === 'directory' && !HIDDEN.has(handle.name.toLowerCase())) children.push(handle);
    return children.sort(byName);
  }
  async open(path = [], descend = false) {
    if (!this.root) throw new Error('Choose a video folder first.');
    if (path.some(name => HIDDEN.has(name.toLowerCase())) || path.slice(0, -1).some(name => name.toLowerCase() === 'evaluated')) throw new Error('Application data and evaluated videos cannot be opened as review folders.');
    if ((await this.root.queryPermission({mode: 'readwrite'})) !== 'granted') throw new Error('Folder permission expired. Click Reconnect folder.');
    let chosen = [...path];
    if (descend) {
      for (let depth = 0; depth < 64; depth++) {
        const first = (await this.children(chosen)).find(handle => handle.name.toLowerCase() !== 'evaluated');
        if (!first) break;
        chosen.push(first.name);
      }
    }
    const folder = await this.directory(chosen);
    const evaluated = chosen.at(-1)?.toLowerCase() === 'evaluated';
    const files = new Map();
    for await (const handle of folder.values()) if (handle.kind === 'file' && VIDEO.test(handle.name)) files.set(handle.name, handle);
    this.path = chosen; this.folder = folder; this.files = files;
    await setting('path', chosen);
    if (evaluated) {this.document = null; this.revision = 0; return {evaluated: true, files};}
    const data = await this.readDocument(folder);
    this.document = data; this.revision = data.revision;
    const known = new Set(data.reviews.map(review => review.filename));
    for (const filename of files.keys()) if (!known.has(filename)) {
      data.reviews.push({id: newId(), filename, status: 'Unreviewed', feedback: [], correction: null, exports: []});
    }
    return {evaluated: false, files, document: data};
  }
  async readDocument(folder = this.folder) {
    let dataHandle;
    try {dataHandle = await folder.getDirectoryHandle('data');}
    catch (error) {if (error.name === 'NotFoundError') return {schema_version: 1, revision: 0, folder_id: newId(), reviews: [], assets: []}; throw error;}
    let handle;
    try {handle = await dataHandle.getFileHandle('still-reviews.json');}
    catch (error) {if (error.name === 'NotFoundError') return {schema_version: 1, revision: 0, folder_id: newId(), reviews: [], assets: []}; throw error;}
    const file = await handle.getFile();
    if (!file.size) return {schema_version: 1, revision: 0, folder_id: newId(), reviews: [], assets: []};
    const data = JSON.parse(await file.text());
    if (data.schema_version !== 1 || !Array.isArray(data.reviews) || !Array.isArray(data.assets) || !Number.isInteger(data.revision)) throw new Error('Unsupported or damaged still-reviews.json. The file was not changed.');
    return data;
  }
  async save() {
    if (!this.document || !this.folder) throw new Error('Open an editable folder first.');
    const save = async () => {
      const current = await this.readDocument();
      if (current.revision !== this.revision) throw new Error('This folder changed in another window. Your edits remain open; reload and resolve the conflict before saving.');
      const next = structuredClone(this.document);
      next.revision = this.revision + 1;
      const data = await this.folder.getDirectoryHandle('data', {create: true});
      let handle;
      try {handle = await data.getFileHandle('still-reviews.json');}
      catch (error) {
        if (error.name !== 'NotFoundError') throw error;
        handle = await data.getFileHandle('still-reviews.json', {create: true});
      }
      const writer = await handle.createWritable({mode: 'exclusive'});
      try {
        if ((await this.readDocument()).revision !== this.revision) throw new Error('This folder changed in another window. Your edits remain open.');
        await writer.write(JSON.stringify(next, null, 2)); await writer.close();
      }
      catch (error) {await writer.abort().catch(() => {}); throw error;}
      this.document.revision = next.revision; this.revision = next.revision;
      await setting('draft', null);
      return next.revision;
    };
    try {
      const key = 'still-review-' + this.root.name + '/' + this.path.join('/');
      return await (navigator.locks ? navigator.locks.request(key, save) : save());
    } catch (error) {
      await setting('draft', {root: this.root.name, path: [...this.path], revision: this.revision, document: structuredClone(this.document)}).catch(() => {});
      throw error;
    }
  }
  async recoveryDraft() {
    const draft = await setting('draft');
    return draft?.root === this.root?.name && JSON.stringify(draft.path) === JSON.stringify(this.path) ? draft : null;
  }
  async rememberDraft(document) {
    await setting('draft', {root: this.root?.name, path: [...this.path], revision: this.revision, document: structuredClone(document)});
  }
  async acceptDraft(draft) {
    if (draft.revision !== this.revision) throw new Error('The review file changed since this draft. Resolve the conflict before restoring it.');
    this.document = draft.document;
  }
  async fileFor(asset) {
    if (asset.kind === 'student') {
      const handle = this.files.get(asset.filename);
      if (!handle) throw new Error(`Source video ${asset.filename} is missing. Reconnect or restore this folder; the review remains saved.`);
      return handle.getFile();
    }
    if (asset.kind === 'private') {
      const data = await this.folder.getDirectoryHandle('data');
      const media = await data.getDirectoryHandle('media');
      return (await (await media.getFileHandle(asset.filename)).getFile());
    }
    throw new Error('Unknown local media kind.');
  }
  async savePrivate(file, metadata = {}) {
    const extension = file.name.match(/\.[^.]+$/)?.[0] || '.webm';
    const id = newId().replaceAll('-', '');
    const filename = id + extension.toLowerCase();
    const data = await this.folder.getDirectoryHandle('data', {create: true});
    const media = await data.getDirectoryHandle('media', {create: true});
    const handle = await media.getFileHandle(filename, {create: true});
    const writer = await handle.createWritable();
    try {await writer.write(file); await writer.close();}
    catch (error) {await writer.abort().catch(() => {}); throw error;}
    const asset = {id, kind: 'private', filename, ...metadata};
    this.document.assets.push(asset);
    return asset;
  }
  async writeExport(sourceName, blob) {
    const directory = await this.folder.getDirectoryHandle('evaluated', {create: true});
    const filename = sourceName.replace(/\.[^.]+$/, '') + '.mp4';
    let existing = null;
    try {existing = await (await directory.getFileHandle(filename)).getFile();}
    catch (error) {if (error.name !== 'NotFoundError') throw error;}
    if (existing) {
      let index = 1;
      while (true) {
        const backup = filename.replace(/\.mp4$/i, ` (${index}).mp4`);
        try {await directory.getFileHandle(backup); index++;}
        catch (error) {
          if (error.name !== 'NotFoundError') throw error;
          const backupHandle = await directory.getFileHandle(backup, {create: true});
          const backupWriter = await backupHandle.createWritable();
          try {await backupWriter.write(existing); await backupWriter.close();}
          catch (failure) {await backupWriter.abort().catch(() => {}); throw failure;}
          break;
        }
      }
    }
    const handle = await directory.getFileHandle(filename, {create: true});
    const writer = await handle.createWritable();
    try {await writer.write(blob); await writer.close();}
    catch (error) {await writer.abort().catch(() => {}); throw error;}
    return filename;
  }
}
