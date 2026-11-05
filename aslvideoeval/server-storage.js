import {cachedThumbnailUrl, localThumbnailUrl} from './local-thumbnails.js';

export class ServerStorage {
  constructor() {
    this.mode = 'server';
    this.mediaUrls = new Map();
    this.mediaDownloads = new Map();
    this.mediaCacheName = 'still-local-media-v1';
    this.evaluatedCacheName = 'still-evaluated-videos-v1';
    this.storagePersistence = null;
  }
  async request(path, options = {}) {
    const response = await fetch(path, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The operation failed.');
    return data;
  }
  loadWorkspace(folder) {return this.request('/api/state' + (folder === undefined ? '' : '?source_folder=' + encodeURIComponent(folder)));}
  saveWorkspace(state, revision) {return this.request('/api/state', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({state, revision, local_view: true})});}
  chooseFolder({assignmentId, revision, initial, localView = true}) {
    return this.request('/api/pick-source-folder', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({assignment_id: assignmentId, revision, initial, local_view: localView})});
  }
  openFolder(path, assignmentId, revision) {
    return this.request('/api/folder-view', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({path, assignment_id: assignmentId, revision})});
  }
  listFolders(path) {return this.request('/api/folders', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({path})});}
  async saveAsset(file, kind, sourceFolder) {
    const result = await this.request('/api/assets', {method: 'POST', headers: {'X-Filename': encodeURIComponent(file.name || `correction.${file.type.includes('mp4') ? 'mp4' : 'webm'}`), 'X-Kind': kind, 'X-Source-Folder': encodeURIComponent(sourceFolder || '')}, body: file});
    await this.cacheUploadedMedia(result.asset.id, file);
    return result.asset;
  }
  async trimAsset(id, start, end) {
    const result = await this.request('/api/trim', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({asset_id: id, start, end})});
    await this.cacheTeacherMedia([result.asset.id]);
    return result.asset;
  }
  async saveExport({submissionId, filename = 'evaluated.mp4', submissionStatus, exportCount}, blob) {
    if (!('caches' in globalThis)) throw new Error('Chrome local storage is unavailable. Open the teacher studio in current Chrome or Edge.');
    if (!this.storagePersistence) this.storagePersistence = Promise.resolve().then(() => navigator.storage?.persist?.()).catch(() => false);
    await this.storagePersistence;
    const exportId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const cacheUrl = new URL(`/browser-exports/${encodeURIComponent(submissionId)}/${encodeURIComponent(exportId)}/${encodeURIComponent(filename)}`, location.origin);
    const request = new Request(cacheUrl);
    const cache = await caches.open(this.evaluatedCacheName);
    await cache.put(request, new Response(blob, {headers: {'Content-Type': 'video/mp4', 'Content-Length': String(blob.size)}}));
    const lastExport = {id: exportId, time: Date.now() / 1000, filename, storage: 'chrome', cache_url: request.url};
    return {filename, saved_directory: 'Chrome local storage', submission_id: submissionId,
      last_export: lastExport, submission_status: submissionStatus,
      export_count: exportCount, cache_request: request.url};
  }
  mediaUrl(id, suffix = '') {
    if (!suffix && this.mediaUrls.has(id)) return this.mediaUrls.get(id);
    return suffix ? `/media/${id}${suffix}` : '';
  }
  async mediaCache() {
    if (!('caches' in globalThis)) throw new Error('Chrome local video storage is unavailable.');
    if (!this.storagePersistence) this.storagePersistence = Promise.resolve().then(() => navigator.storage?.persist?.()).catch(() => false);
    await this.storagePersistence;
    return caches.open(this.mediaCacheName);
  }
  async cacheUploadedMedia(id, blob) {
    const request = new Request(new URL(`/media/${id}`, location.origin));
    const cache = await this.mediaCache();
    await cache.put(request, new Response(blob, {headers: {'Content-Type': blob.type || 'application/octet-stream'}}));
    const prior = this.mediaUrls.get(id);
    if (prior) URL.revokeObjectURL(prior);
    const url = URL.createObjectURL(blob);
    this.mediaUrls.set(id, url);
    void localThumbnailUrl(id, blob).catch(error => console.warn(`Could not create local thumbnail ${id}:`, error));
    return url;
  }
  async cacheTeacherMedia(ids, onCached = () => {}) {
    let cache;
    try {cache = await this.mediaCache();}
    catch (error) {console.warn('Chrome persistent video storage is unavailable:', error); return;}
    const unique = [...new Set(ids.filter(Boolean))];
    let cursor = 0;
    const worker = async () => {
      while (cursor < unique.length) {
        const id = unique[cursor++];
        try {
          let url = this.mediaUrls.get(id);
          if (!url) {
            let pending = this.mediaDownloads.get(id);
            if (!pending) {
              pending = (async () => {
                const request = new Request(new URL(`/media/${id}`, location.origin));
                let response = await cache.match(request);
                if (!response) {
                  response = await fetch(request, {credentials: 'same-origin'});
                  if (!response.ok) throw new Error(`Could not download ${id} (${response.status}).`);
                  await cache.put(request, response.clone());
                }
                const objectUrl = URL.createObjectURL(await response.blob());
                this.mediaUrls.set(id, objectUrl);
                return objectUrl;
              })().finally(() => this.mediaDownloads.delete(id));
              this.mediaDownloads.set(id, pending);
            }
            url = await pending;
          }
          onCached(id, url);
        } catch (error) {
          console.warn(`Could not keep teacher video ${id} in Chrome storage:`, error);
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }
  async evaluatedExport(submission) {
    if (!submission?.last_export?.filename) throw new Error('Export this review before submitting it.');
    const filename = submission.last_export.filename;
    const browserExport = submission.last_export.storage === 'chrome';
    if (browserExport && !submission.last_export.cache_url) throw new Error('This evaluated video is no longer available in Chrome local storage. Export it again.');
    const request = new Request(browserExport
      ? submission.last_export.cache_url
      : new URL('/exports/' + encodeURIComponent(filename) + '?evaluated=' + encodeURIComponent(submission.last_export.id || submission.last_export.time || ''), location.origin));
    const cache = await caches.open(this.evaluatedCacheName);
    let response = await cache.match(request);
    if (!response && !browserExport) {
      response = await fetch(request, {credentials: 'same-origin'});
      if (!response.ok) throw new Error('Could not load the evaluated video from this review.');
      await cache.put(request, response.clone());
    }
    if (!response) throw new Error('This evaluated video is no longer available in Chrome local storage. Export it again.');
    return {request, response, filename};
  }
  async discardExport(result) {
    const url = result?.cache_request || (result?.last_export?.storage === 'chrome' && result.last_export.cache_url);
    if (!url || !('caches' in globalThis)) return;
    const cache = await caches.open(this.evaluatedCacheName);
    await cache.delete(new Request(url));
  }
  async submitEvaluated(submission, evaluated) {
    const blob = await evaluated.response.clone().blob();
    const response = await fetch('/api/teacher/submit-evaluated', {method: 'POST',
      headers: {'Content-Type': 'video/mp4', 'X-Submission-Id': submission.id,
        'X-Filename': encodeURIComponent(evaluated.filename)}, body: blob});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The evaluated video could not be submitted.');
    await this.cacheUploadedMedia(result.asset_id, blob);
    const cache = await caches.open(this.evaluatedCacheName);
    await cache.delete(evaluated.request);
    return result;
  }
  thumbnailUrl(id) { return cachedThumbnailUrl(id); }
  async ensureThumbnail(id, asset = null) {
    const key = asset?.evaluated_version ? `evaluated:${id}:${asset.evaluated_version}` : id;
    const existing = cachedThumbnailUrl(key);
    if (existing) return existing;
    let mediaUrl;
    if (asset?.evaluated_version) {
      await this.cacheEvaluatedMedia(asset);
      mediaUrl = this.evaluatedUrl(asset);
    } else {
      await this.cacheTeacherMedia([id]);
      mediaUrl = this.mediaUrl(id);
    }
    if (!mediaUrl) return localThumbnailUrl(key);
    const response = await fetch(mediaUrl);
    return localThumbnailUrl(key, await response.blob());
  }
  evaluatedUrl(asset, thumbnail = false) {
    if (thumbnail) return `/evaluated-thumbnail?path=${encodeURIComponent(asset.source_path)}&v=${encodeURIComponent(asset.evaluated_version)}`;
    return this.mediaUrls.get(`evaluated:${asset.id}:${asset.evaluated_version}`) || '';
  }
  async cacheEvaluatedMedia(asset, onCached = () => {}) {
    const key = `evaluated:${asset.id}:${asset.evaluated_version}`;
    if (this.mediaUrls.has(key)) {onCached(this.mediaUrls.get(key)); return;}
    if (!this.mediaDownloads.has(key)) {
      this.mediaDownloads.set(key, (async () => {
        const request = new Request(new URL(`/evaluated-media?path=${encodeURIComponent(asset.source_path)}&v=${encodeURIComponent(asset.evaluated_version)}`, location.origin));
        const cache = await this.mediaCache();
        let response = await cache.match(request);
        if (!response) {
          response = await fetch(request, {credentials: 'same-origin'});
          if (!response.ok) throw new Error(`Could not download evaluated video ${asset.id} (${response.status}).`);
          await cache.put(request, response.clone());
        }
        const url = URL.createObjectURL(await response.blob());
        this.mediaUrls.set(key, url);
        return url;
      })().finally(() => this.mediaDownloads.delete(key)));
    }
    onCached(await this.mediaDownloads.get(key));
  }
  async resolveExportMedia() { return null; }
  async status() { return this.request('/api/health', {cache: 'no-store', signal: AbortSignal.timeout(5000)}); }
  openNativeFolder(path) {return this.request('/api/open-source-folder', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({path})});}
  trackingStatus(id) {return this.request('/api/tracking/' + id);}
  startTracking(id) {return this.request('/api/tracking', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({asset_id: id})});}
  trackingUrl(id, points = false) {return this.mediaUrl(id, `/${points ? 'tracking-points' : 'tracking'}?t=${Date.now()}`);}
  deleteLibraryClip(id, revision) {return this.request('/api/delete-library-clip', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id, revision})});}
  cleanupStatus() {return this.request('/api/cleanup');}
  cleanupReviews(submissionIds, revision) {return this.request('/api/cleanup', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({submission_ids: submissionIds, revision})});}
  pickReference() {return this.request('/api/pick-reference', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});}
  reportPlaybackError(assetId, reason) {return this.request('/api/playback-error', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({asset_id: assetId, reason})});}
  dispose() { for (const url of this.mediaUrls.values()) URL.revokeObjectURL(url); this.mediaUrls.clear(); }
}
