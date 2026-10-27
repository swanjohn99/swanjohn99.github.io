export class ServerStorage {
  constructor() { this.mode = 'server'; }
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
  mediaUrl(id, suffix = '') { return `/media/${id}${suffix}`; }
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
  dispose() {}
}
