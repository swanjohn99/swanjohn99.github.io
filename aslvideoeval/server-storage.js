export class ServerStorage {
  constructor() {
    this.mode = 'server';
    this.mediaUrls = new Map();
    this.mediaDownloads = new Map();
    this.mediaCacheName = 'still-teacher-media-v1';
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
    return result.asset;
  }
  async trimAsset(id, start, end) {
    const result = await this.request('/api/trim', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({asset_id: id, start, end})});
    return result.asset;
  }
  async saveExport({submissionId, sourceFolder, revision}, blob) {
    return this.request('/api/export/rendered?submission_id=' + encodeURIComponent(submissionId) + '&source_folder=' + encodeURIComponent(sourceFolder || ''),
      {method: 'POST', headers: {'Content-Type': 'video/mp4', 'X-Revision': String(revision)}, body: blob});
  }
  mediaUrl(id, suffix = '') {
    if (!suffix && this.mediaUrls.has(id)) return this.mediaUrls.get(id);
    return `/media/${id}${suffix}`;
  }
  async cacheTeacherMedia(ids, onCached = () => {}) {
    if (!('caches' in globalThis) || !globalThis.navigator?.storage) return;
    if (!this.storagePersistence) this.storagePersistence = Promise.resolve().then(() => navigator.storage.persist?.()).catch(() => false);
    let cache;
    try {await this.storagePersistence; cache = await caches.open(this.mediaCacheName);}
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
    const request = new Request(new URL('/exports/' + encodeURIComponent(filename) + '?evaluated=' + encodeURIComponent(submission.last_export.id || submission.last_export.time || ''), location.origin));
    const cache = await caches.open(this.evaluatedCacheName);
    let response = await cache.match(request);
    if (!response) {
      response = await fetch(request, {credentials: 'same-origin'});
      if (!response.ok) throw new Error('Could not load the evaluated video from this review.');
      await cache.put(request, response.clone());
    }
    return {request, response, filename};
  }
  async submitEvaluated(submission, evaluated) {
    const response = await fetch('/api/teacher/submit-evaluated', {method: 'POST',
      headers: {'Content-Type': 'video/mp4', 'X-Submission-Id': submission.id,
        'X-Filename': encodeURIComponent(evaluated.filename)}, body: await evaluated.response.clone().blob()});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The evaluated video could not be submitted.');
    const cache = await caches.open(this.evaluatedCacheName);
    await cache.delete(evaluated.request);
    return result;
  }
  thumbnailUrl(id) { return this.mediaUrl(id, '/thumb'); }
  evaluatedUrl(asset, thumbnail = false) {
    return `${thumbnail ? '/evaluated-thumbnail' : '/evaluated-media'}?path=${encodeURIComponent(asset.source_path)}&v=${encodeURIComponent(asset.evaluated_version)}`;
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
