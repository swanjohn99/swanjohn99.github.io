import {uid, clone, clock, normalize, makeFeedback, feedbackTimestamp, studentPreviewTimeline, previewSectionAt, previewStudentTime, previewOutputTime, keepOneSectionClip, searchClips, canExport, visibleInSelectedFolder, isEvaluatedFolder, pathUnderVideo, DEFAULT_PAD, DEFAULT_KEYS} from './core.js';
import {GamepadInput} from './gamepad.js';
import {videoComposition} from './video-composition.js';
import {renderVideo} from './video-renderer.js';
import {mode} from './runtime-config.js';
import {ServerStorage} from './server-storage.js';
import {BrowserStorage} from './browser-storage.js';

const storage = mode === 'browser' ? new BrowserStorage() : new ServerStorage();
const browserStorage = storage.mode === 'browser';

const $ = id => document.getElementById(id);
const video = $('student-video');
const correctionVideo = $('correction-video');
const videoShell = () => $('video-shell');
const dialogs = [...document.querySelectorAll('dialog')];
let showingCorrection = false;
let state, revision = 0, assets = new Map(), capabilities = {}, history = [];
let selectedAsset = null, markedIn = null, markedOut = null, looping = false;
let editCount = 0, savedCount = 0, saveTimer, saving = null, busy = false;
let libraryFilter = 'recent', libraryTags = new Set(), libraryTarget = 'correction', previewEntry = null, editEntryId = null, newEntryAsset = null;
const libraryViewKey = 'still-library-view';
const libraryViews = ['large', 'small', 'list'];
function savedLibraryView() {
  try {const value = localStorage.getItem(libraryViewKey); return libraryViews.includes(value) ? value : 'small';}
  catch {return 'small';}
}
let libraryView = savedLibraryView();
let referenceReplace = null, libraryClipId = null;
let toastTimer, lastPositionSave = 0, bindCapture = null, detectedPad = null, testPadKey = '';
let padFocused = false;
let renderTask = null;
let previewOverlays = [], previewTail = null, previewKey = '', previewWaiting = false, previewRaf = 0;
let previewPlayback = null, previewSeeking = false;
let folderPaths = {source: '', output: ''};
let notSubmitted = [];
let trackingAsset = null, trackingTimer = null, trackingError = '', trackingLog = '', trackingStatus = null, pointsViewPending = null;
const trackingWait = new Set();
const exportJobs = new Map();
let rec = {phase: 'idle', stream: null, media: null, blob: null, url: null, interval: null, timeout: null, elapsed: 0, asset: null};
let recorderMode = 'submission';
const viewKeys = ['source_folder', 'assignment_id', 'submission_id', 'feedback_id', 'marked_in', 'marked_out'];
const windowViewKey = 'still-window-view';
let localPositions = {}, windowSession = null, evaluatedRefresh = null, evaluatedLoading = false;
let sourceRefresh = null, sourceLoading = false;
function storedWindowView() {
  try {return JSON.parse(sessionStorage.getItem(windowViewKey) || 'null');} catch {return null;}
}
function viewChanged() {
  if (!state) return;
  const session = Object.fromEntries(viewKeys.map(key => [key, state.session[key]]));
  windowSession = session;
  try {sessionStorage.setItem(windowViewKey, JSON.stringify({session, positions: localPositions}));} catch {}
}
function rememberPosition() {
  const item = submission();
  if (item) {item.position = position(); localPositions[item.id] = item.position;}
  viewChanged();
}
function restoreWindowView(view = windowSession ? {session: windowSession, positions: localPositions} : storedWindowView()) {
  if (browserStorage && !storage.folders.root) return;
  if (browserStorage && view?.session?.source_folder && storage.folders.root &&
      !view.session.source_folder.startsWith('/video/' + encodeURIComponent(storage.folders.root.name))) return;
  if (view?.session) Object.assign(state.session, view.session);
  localPositions = view?.positions || localPositions;
  for (const item of state.submissions) if (Number.isFinite(localPositions[item.id])) item.position = localPositions[item.id];
}

const currentAssignment = () => state?.assignments.find(item => item.id === state.session.assignment_id);
const visibleSubmission = item => visibleInSelectedFolder(item, assets.get(item.asset_id), state.session.source_folder || '', currentAssignment()?.demo);
const submissions = () => state?.submissions.filter(item => item.assignment_id === state.session.assignment_id && visibleSubmission(item)) || [];
const submission = () => submissions().find(item => item.id === state.session.submission_id);
const feedback = () => submission()?.feedback.find(item => item.id === state.session.feedback_id);
const currentDialog = () => dialogs.filter(dialog => dialog.open).at(-1);
const evaluatedFolderSelected = () => isEvaluatedFolder(state?.session.source_folder);
const evaluatedPlaybackControls = new Set(['play', 'back', 'forward', 'seek', 'speed', 'loop', 'fullscreen', 'student-preview', 'previous-student', 'next-student', 'video-folders']);
const evaluatedDisabledControls = new Map();
const cleanedDisabledControls = new Map();
const cleanedControlIds = new Set(['play', 'back', 'forward', 'seek', 'speed', 'loop', 'student-preview', /* 'mark-in', 'mark-out', */ 'add-feedback', 'export', 'track-motion', 'view-tracking', 'view-points', 'remove-feedback', 'editor-record', 'editor-library']);
function syncCleanedControls() {
  const cleaned = !!submission()?.cleaned_at;
  for (const id of ['feedback-start', 'feedback-end', 'feedback-note', 'private-note']) $(id).readOnly = cleaned;
  if (!cleaned) {
    for (const [node, disabled] of cleanedDisabledControls) node.disabled = disabled;
    cleanedDisabledControls.clear();
    return;
  }
  for (const id of cleanedControlIds) {
    const node = $(id);
    if (!cleanedDisabledControls.has(node)) cleanedDisabledControls.set(node, node.disabled);
    if (!node.disabled) node.disabled = true;
  }
}

function allowedInEvaluatedFolder(node) {
  return evaluatedPlaybackControls.has(node.id) || node.matches('.video-list-card') || !!node.closest('#video-path') || node.id === 'server' || !!node.closest('#server-dialog');
}
function syncEvaluatedControls() {
  syncCleanedControls();
  const locked = evaluatedFolderSelected();
  $('evaluated-warning').hidden = !locked;
  if (!locked) {
    for (const [node, disabled] of evaluatedDisabledControls) node.disabled = disabled;
    evaluatedDisabledControls.clear();
    return;
  }
  for (const node of evaluatedDisabledControls.keys()) if (!node.isConnected) evaluatedDisabledControls.delete(node);
  for (const node of document.querySelectorAll('button, input, select, textarea')) {
    if (allowedInEvaluatedFolder(node)) continue;
    if (!evaluatedDisabledControls.has(node)) evaluatedDisabledControls.set(node, node.disabled);
    if (!node.disabled) node.disabled = true;
  }
}
// Keep asynchronous status updates and newly rendered controls read-only too.
new MutationObserver(syncEvaluatedControls).observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['disabled']});
for (const type of ['click', 'input', 'change', 'submit', 'pointerdown']) {
  document.addEventListener(type, event => {
    if (!evaluatedFolderSelected()) return;
    const control = event.target.closest('button, input, select, textarea');
    if ((control && !allowedInEvaluatedFolder(control)) || event.type === 'submit' || event.target.closest('.teacher-overlay')) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
}
function activeDuration() {
  if (showingCorrection) {
    if (browserStorage) return clipAssetDuration(submission()?.correction?.asset_id);
    if (Number.isFinite(correctionVideo.duration) && correctionVideo.duration > 0) return correctionVideo.duration;
    return assets.get(submission()?.correction?.asset_id)?.duration || 0;
  }
  return Number.isFinite(video.duration) ? video.duration : assets.get(submission()?.asset_id)?.duration || 0;
}
function clipAssetDuration(id) {
  const asset = assets.get(id);
  return Math.max(0, (Number(asset?.trim_end) || Number(asset?.duration) || 0) - (Number(asset?.trim_start) || 0));
}
const now = () => Date.now() / 1000;
const padNames = {confirm: 'Play / select', back: 'Back / cancel', feedback: 'Feedback actions', library: 'Clip shelf', /* markIn: 'Mark start', markOut: 'Mark end', */ rewind: 'Seek backward', forward: 'Seek forward', menu: 'Server status'};

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}
function button(label, handler, className = 'small') {
  const node = element('button', className, label); node.type = 'button';
  node.addEventListener('click', handler); return node;
}
function notify(message, error = false) {
  $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => {$('toast').hidden = true;}, error ? 9000 : 4000);
}
const readWorkspace = () => {
  const folder = state?.session.source_folder ?? storedWindowView()?.session?.source_folder;
  return storage.loadWorkspace(folder);
};
function remember() {history.push(clone(state)); if (history.length > 30) history.shift();}
function touch(item = submission()) {
  if (item && ['Unreviewed', 'Ready', 'Exported'].includes(item.status)) item.status = 'In progress';
}
function dirty() {
  viewChanged();
  if (evaluatedFolderSelected()) return;
  if (studentPreviewOn()) syncStudentPreview(true);
  editCount++; $('save-state').textContent = 'Saving…'; $('save-state').classList.remove('failed');
  clearTimeout(saveTimer); saveTimer = setTimeout(() => saveNow().catch(error => notify(error.message, true)), 650);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (saving) {await saving; if (savedCount < editCount) return saveNow(); return;}
  if (savedCount === editCount) return;
  keepOneSectionClip(state);
  const count = editCount, snapshot = clone(state);
  saving = storage.saveWorkspace(snapshot, revision).then(result => {
    revision = result.revision; savedCount = count;
    $('save-state').textContent = savedCount === editCount ? 'Saved locally' : 'Saving…';
    $('save-state').classList.remove('failed');
    if (browserStorage) {storage.pendingDraft = null; $('download-draft').hidden = true; $('reconnect-folder').hidden = true;}
  }).catch(error => {
    if (browserStorage && error.revision) revision = error.revision;
    $('save-state').textContent = 'Save failed · changes pending'; $('save-state').classList.add('failed');
    if (browserStorage) {storage.pendingDraft ||= {document: snapshot}; $('download-draft').hidden = false; $('reconnect-folder').hidden = !/permission|disconnected|not found/i.test(error.message);}
    throw error;
  }).finally(() => {saving = null;});
  await saving;
  if (savedCount < editCount) return saveNow();
}
async function work(label, operation) {
  if (busy) return;
  busy = true; $('busy-label').textContent = label; $('busy').hidden = false; pausePreview(); correctionVideo.pause();
  document.querySelector('.workspace').inert = true;
  document.querySelector('.topbar').inert = true;
  const modal = currentDialog();
  if (modal) {modal.append($('busy')); modal.inert = true;}
  try {return await operation();}
  catch (error) {
    if (error.name === 'AbortError') return;
    notify(error.message, true);
    if (browserStorage && /permission|disconnected|not found/i.test(error.message || '')) $('reconnect-folder').hidden = false;
  }
  finally {busy = false; $('busy').hidden = true; document.body.append($('busy')); if (modal) modal.inert = false; document.querySelector('.workspace').inert = false; document.querySelector('.topbar').inert = false;}
}
function openDialog(id, focus = null) {
  hideCorrection(); pausePreview(); const dialog = $(id);
  if (!dialog.open) dialog.showModal();
  const target = focus ? $(focus) : dialog.querySelector('button:not([disabled]), input, select');
  requestAnimationFrame(() => target?.focus()); updateHint();
}
function closeDialog(dialog = currentDialog()) {
  if (!dialog) return;
  dialog.querySelectorAll('video').forEach(player => player.pause());
  dialog.close(); updateHint();
  if (!currentDialog()) requestAnimationFrame(() => {$('play').focus(); padFocused = false;});
}
function shortcutLetter(name) {
  return (state?.session.shortcuts?.[name] || DEFAULT_KEYS[name] || '').toUpperCase();
}
function exportCount(item) {
  return Number.isInteger(item?.evaluated_export_count) && item.evaluated_export_count > 0 ? item.evaluated_export_count : 0;
}
function labelExportButtons() {
  if (!state) return;
  const item = submission();
  const exporting = !!(item && exportJobs.has(item.id));
  const exportable = canExport(item) && !item?.cleaned_at;
  const count = exportCount(item);
  const exportLabel = exporting ? 'Exporting…' : count ? `Export feedback ${count}` : 'Export feedback';
  const letter = shortcutLetter('exportFeedback');
  for (const id of ['export']) {
    const node = $(id);
    node.disabled = !exportable || exporting;
    node.classList.toggle('primary', !count);
    node.classList.toggle('exported', !!count);
    node.title = exportable || exporting ? `Export feedback (${letter})` : 'Add a correction clip or written note before exporting feedback.';
    if (id === 'export') {
      node.replaceChildren(document.createTextNode(exportLabel + ' '), element('kbd', '', letter));
      node.setAttribute('aria-keyshortcuts', letter);
    } else node.textContent = exportLabel;
  }
}
function applyShortcutLabels() {
  const letter = shortcutLetter('browseVideos');
  const node = $('video-folders');
  node.replaceChildren(document.createTextNode('Browse for video '), element('kbd', '', letter));
  node.title = `Browse for video (${letter}) · use source files directly; audio is permanently removed when preparing MP4/MOV files`;
  node.setAttribute('aria-keyshortcuts', letter);
  labelExportButtons();
}
function updateHint() {
  const modal = currentDialog();
  const labels = state?.session.pad_labels || 'positions';
  const select = labels === 'xbox' ? 'A' : labels === 'playstation' ? 'Cross' : 'Lower button';
  const browse = shortcutLetter('browseVideos');
  const exportKey = shortcutLetter('exportFeedback');
  $('context-hint').textContent = evaluatedFolderSelected() ? `Read-only · Space Play/pause · Arrow keys Seek · [ / ] Previous / next video · ${browse} Browse` : modal ? detectedPad ? `${select} Select · Right button Back · Direction pad Move · ${modal === $('recorder-dialog') ? 'Put the controller down while signing' : 'Your review position is preserved'}` : 'Tab / arrows Navigate · Enter Select · Escape Back · Your review position is preserved' : detectedPad ? `${select} Play/pause · Left button Feedback · Upper button Library · Menu Server` : `Space Play/pause · [ / ] Previous / next video · R Record · F Library · ${browse} Browse · ${exportKey} Export`;
  applyShortcutLabels();
}
function libraryTagList() {
  const tags = new Map();
  for (const entry of state?.library || []) for (const tag of entry.tags || []) {
    const label = String(tag || '').trim();
    const key = normalize(label);
    if (key && !tags.has(key)) tags.set(key, label);
  }
  return [...tags.entries()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}
function renderLibraryTagFilters() {
  const tags = libraryTagList();
  const known = new Set(tags.map(([key]) => key));
  for (const key of libraryTags) if (!known.has(key)) libraryTags.delete(key);
  const box = $('library-tag-filters');
  const active = document.activeElement?.dataset?.tag;
  box.replaceChildren();
  for (const [key, label] of tags) {
    const node = element('button', '', label);
    node.type = 'button';
    node.dataset.tag = key;
    node.setAttribute('aria-pressed', String(libraryTags.has(key)));
    box.append(node);
  }
  if (active) box.querySelector(`[data-tag="${CSS.escape(active)}"]`)?.focus();
}
function renderTagChoices(entry) {
  const chosen = new Set((entry?.tags || []).map(tag => normalize(tag)));
  const box = $('library-tag-checks');
  box.replaceChildren();
  const tags = libraryTagList();
  $('library-tag-fieldset').hidden = !tags.length;
  for (const [key, label] of tags) {
    const input = element('input');
    input.type = 'checkbox';
    input.value = label;
    input.checked = chosen.has(key);
    const row = element('label', 'checkbox');
    row.append(input, document.createTextNode(label));
    box.append(row);
  }
}
function chosenLibraryTags() {
  const checked = [...$('library-tag-checks').querySelectorAll('input:checked')].map(input => input.value);
  const typed = $('library-tags').value.split(',').map(value => value.trim()).filter(Boolean);
  return [...new Map([...checked, ...typed].map(tag => [tag.toLowerCase(), tag])).values()];
}
function applyPreferences() {
  document.documentElement.style.setProperty('--scale', state.session.scale || 1);
  requestAnimationFrame(fitSofa);
}
function applyVideoAspect() {
  const shell = $('video-shell');
  const player = showingCorrection ? correctionVideo : video;
  if (player.videoWidth > 0 && player.videoHeight > 0) shell.style.setProperty('--ar', String(player.videoWidth / player.videoHeight));
  else shell.style.removeProperty('--ar');
}
function fitSofa() {
  $('video-shell').style.maxHeight = '';
}
function videoListCard(item, index) {
  const asset = assets.get(item.asset_id);
  let commentUrl = '';
  try {
    const url = new URL(asset?.comment || '');
    if (url.protocol === 'http:' || url.protocol === 'https:') commentUrl = url.href;
  } catch {}
  const card = element(commentUrl ? 'a' : 'button', `video-list-card${submission()?.id === item.id ? ' selected' : ''}`);
  card.addEventListener('click', event => {
    if (commentUrl && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
    event.preventDefault();
    selectSubmission(item.id);
  });
  if (commentUrl) {
    card.href = commentUrl;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.title = `${item.name} · Ctrl-click or right-click to open linked URL`;
    if (submission()?.id === item.id) card.setAttribute('aria-current', 'true');
  } else {
    card.type = 'button';
    card.setAttribute('aria-pressed', String(submission()?.id === item.id));
  }
  const thumbnail = element('img');
  thumbnail.alt = '';
  if (!item.cleaned_at) thumbnail.src = evaluatedFolderSelected() ? storage.evaluatedUrl(asset, true) : storage.thumbnailUrl(item.asset_id);
  thumbnail.loading = 'lazy';
  thumbnail.onerror = () => {thumbnail.removeAttribute('src'); thumbnail.style.visibility = 'hidden';};
  const preview = element('span', 'video-list-preview');
  preview.append(thumbnail,
    element('span', 'video-list-meta', clock(asset?.duration)));
  const exported = exportCount(item) > 0 || evaluatedFolderSelected();
  const statusLabel = item.evaluated_uploaded ? 'Uploaded' : exported ? 'Exported' : item.status === 'Exported' ? 'Not exported' : item.status;
  const status = element('span', `video-list-status${exported ? ' exported' : ''}`, item.cleaned_at && !item.evaluated_uploaded ? 'Cleaned up' : statusLabel);
  preview.append(status);
  if (item.status !== 'Unreviewed' && !exported && statusLabel !== 'Not exported') {
    preview.append(element('span', 'video-list-export-warning', 'Not exported'));
  }
  const details = element('span', 'video-list-details');
  const name = element('span', 'video-list-name', item.name.length > 20 ? `${item.name.slice(0, 19)}…` : item.name);
  name.title = item.name;
  details.append(name);
  card.append(element('span', 'video-list-count', String(index + 1)), preview, details);
  return card;
}
function updateProgressLabel() {
  const complete = submissions().filter(item => ['Ready', 'Exported'].includes(item.status)).length;
  $('review-progress').textContent = submissions().length ? `${complete} of ${submissions().length} reviews ready · your pace` : 'Manual review · your pace';
}
function renderProgress() {
  const list = $('video-list');
  const submittedNames = new Set(submissions().map(item => normalize(item.name)));
  const missing = currentAssignment()?.demo ? [] : notSubmitted.filter(item => !submittedNames.has(normalize(item.name)));
  const videos = [...submissions(), ...missing.map(item => ({...item, notSubmitted: true}))]
    .sort((a, b) => Number(!!a.notSubmitted) - Number(!!b.notSubmitted)
      || String(a.name || '').localeCompare(String(b.name || ''), undefined, {numeric: true, sensitivity: 'base'}));
  list.replaceChildren(...videos.map((item, index) => item.notSubmitted ? notSubmittedCard(item, index) : videoListCard(item, index)));
  if (!videos.length) list.append(element('p', 'muted', 'No videos in this folder.'));
  updateProgressLabel();
}
function notSubmittedCard(item, index) {
  const card = element('div', 'video-list-card');
  const details = element('span', 'video-list-details');
  const name = element('span', 'video-list-name', item.name);
  name.title = item.name;
  details.append(name, element('span', 'video-list-status', 'Not Submitted'));
  card.append(element('span', 'video-list-count', String(index + 1)), details);
  return card;
}
const folderChoices = new Map();
let pathRenderToken = 0;
function videoPathParts() {
  const folder = state?.session.source_folder || '';
  const match = folder.match(/^(.*?[\\/]video)[\\/](.+)$/i);
  if (!match) return null;
  const separator = match[1].includes('\\') ? '\\' : '/';
  return {root: match[1], separator, names: match[2].split(/[\\/]/).filter(Boolean)};
}
async function renderBrowserVideoPath() {
  const box = $('video-path');
  const token = ++pathRenderToken;
  const path = state?.session.source_folder || '';
  box.replaceChildren();
  if (!path) return;
  const names = path.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
  const rootPath = '/video/' + encodeURIComponent(names[0]);
  box.append(button(names[0], () => openPathChoice(rootPath), 'path-open'));
  let parent = rootPath;
  for (const name of names.slice(1)) {
    box.append(element('span', 'path-separator', '/'));
    const select = element('select', 'path-choice');
    const currentPath = parent + '/' + encodeURIComponent(name);
    const choices = await storage.listFolders(parent);
    if (token !== pathRenderToken) return;
    for (const child of choices.folders) {
      if (child.name.toLowerCase() === 'evaluated' && name.toLowerCase() !== 'evaluated') continue;
      const option = element('option', '', child.name);
      option.value = child.path;
      select.append(option);
    }
    select.value = currentPath;
    select.addEventListener('change', () => openPathChoice(select.value));
    box.append(select);
    parent = currentPath;
  }
  if (evaluatedFolderSelected()) box.append(button('Back to reviews', () => openPathChoice(path.slice(0, path.lastIndexOf('/'))), 'path-open'));
  else {
    const children = await storage.listFolders(path);
    if (token !== pathRenderToken) return;
    const reviewFolders = children.folders.filter(child => child.name.toLowerCase() !== 'evaluated');
    if (reviewFolders.length) {
      const select = element('select', 'path-choice');
      const placeholder = element('option', '', 'Open subfolder…'); placeholder.value = ''; select.append(placeholder);
      for (const child of reviewFolders) {const option = element('option', '', child.name); option.value = child.path; select.append(option);}
      select.setAttribute('aria-label', 'Open subfolder');
      select.addEventListener('change', () => {if (select.value) openPathChoice(select.value);});
      box.append(select);
    }
    if (children.folders.some(child => child.name.toLowerCase() === 'evaluated'))
      box.append(button('View evaluated videos', () => openPathChoice(path + '/evaluated'), 'path-open'));
  }
}
async function folderChildren(path) {
  if (!folderChoices.has(path)) folderChoices.set(path, storage.listFolders(path).catch(error => {folderChoices.delete(path); throw error;}));
  return (await folderChoices.get(path)).folders;
}
async function renderVideoPath() {
  if (browserStorage) {renderBrowserVideoPath().catch(error => notify(error.message, true)); return;}
  const box = $('video-path');
  const token = ++pathRenderToken;
  const path = videoPathParts();
  if (!path) {
    box.textContent = pathUnderVideo(assets.get(submission()?.asset_id)?.source_path || '') || state?.session.source_folder || '';
    if (state?.session.source_folder && !browserStorage) box.append(openFolderButton());
    return;
  }
  box.replaceChildren();
  let parent = path.root;
  for (const [index, name] of path.names.entries()) {
    if (index) box.append(element('span', 'path-separator', '/'));
    const select = element('select', 'path-choice');
    select.setAttribute('aria-label', `Folder level ${index + 1}`);
    select.title = `Choose a sibling of ${name}`;
    const current = element('option', '', name);
    current.value = parent + path.separator + name;
    select.append(current);
    select.value = current.value;
    const selectedParent = parent;
    select.addEventListener('change', () => openPathChoice(select.value));
    box.append(select);
    folderChildren(selectedParent).then(children => {
      if (token !== pathRenderToken || !select.isConnected) return;
      select.replaceChildren();
      for (const child of children.filter(child => child.name.toLowerCase() !== 'evaluated')) {
        const option = element('option', '', child.name);
        option.value = child.path;
        select.append(option);
      }
      if (![...select.options].some(option => option.value === current.value)) select.append(current);
      select.value = current.value;
    }).catch(error => console.error('Could not list sibling folders:', error));
    parent = current.value;
  }
  if (!browserStorage) box.append(openFolderButton());
}
function openFolderButton() {
  const control = button('Open folder', async () => {
    try {await storage.openNativeFolder(state.session.source_folder);}
    catch (error) {notify(error.message, true);}
  }, 'path-open');
  control.title = 'Open this folder in Finder or File Explorer';
  control.setAttribute('aria-label', 'Open current video folder in the file manager');
  return control;
}
async function openPathChoice(chosen) {
  if (isEvaluatedFolder(chosen) && !browserStorage) return;
  await work('Opening folder…', async () => {
    await saveNow();
    if (browserStorage) {
      renderTask?.controller.abort();
      const data = await storage.openFolder(chosen);
      rememberPosition();
      acceptFolderWorkspace(data);
      return;
    }
    let path = chosen;
    const visited = new Set();
    while (chosen !== state.session.source_folder && !visited.has(path)) {
      visited.add(path);
      const listing = await storage.listFolders(path);
      if (!listing.folders.length || listing.folders[0].name.toLowerCase() === 'evaluated') break;
      path = listing.folders[0].path;
    }
    const data = await storage.openFolder(path, currentAssignment()?.id, evaluatedFolderSelected() ? null : revision);
    rememberPosition();
    acceptFolderWorkspace(data);
  });
  renderVideoPath();
}
function renderPlayer() {
  const item = submission(), asset = assets.get(item?.asset_id);
  const name = item?.name || 'Your review studio';
  $('student-title').textContent = name;
  $('student-title').title = name;
  $('student-status').textContent = item?.cleaned_at ? 'Cleaned up · text retained' : item?.status || 'Ready when you are';
  $('student-status').classList.toggle('ready', ['Ready', 'Exported'].includes(item?.status));
  renderVideoPath();
  $('empty-stage').hidden = !!item;
  $('cleaned-stage').hidden = !item?.cleaned_at;
  $('cleaned-video').href = item?.cleaned_at ? '/evaluated-video/' + encodeURIComponent(item.id) : '#';
  $('cleaned-correction').textContent = item?.correction_subtitle || '';
  $('cleaned-correction').hidden = !item?.correction_subtitle;
  $('source-note').replaceChildren();
  if (asset?.direct_source && !item?.cleaned_at) $('source-note').append(document.createTextNode('Using the source video directly.'));
  if (asset?.attribution?.source_url) {
    const link = element('a', '', 'Public demo · ' + (asset.attribution.creator || 'source attribution'));
    link.href = asset.attribution.source_url; link.target = '_blank'; link.rel = 'noopener'; $('source-note').append(link);
  }
  const enabled = !!item && !item.cleaned_at;
  for (const id of ['play', /* 'mark-in', 'mark-out', */ 'add-feedback', 'student-preview']) $(id).disabled = !enabled;
  labelExportButtons();
  if (selectedAsset !== item?.asset_id) {
    $('student-preview').checked = false; destroyPreview();
    hideCorrection(); video.pause(); markedIn = markedOut = null; looping = false;
    selectedAsset = item?.asset_id || null;
    if (selectedAsset && !item.cleaned_at) {
      video.src = asset?.evaluated_version ? storage.evaluatedUrl(asset) : storage.mediaUrl(selectedAsset);
      video.load();
    } else {video.removeAttribute('src'); video.load(); $('video-shell').style.removeProperty('--ar');}
  }
  updateTransport();
  syncTracking();
  syncStudentPreview(true);
  syncCorrectionControl();
}
function syncTracking() {
  if (browserStorage) {
    for (const id of ['track-motion', 'view-tracking', 'view-points']) $(id).disabled = true;
    $('track-motion').title = 'Tracking requires the local Python server.';
    return;
  }
  const assetId = submission()?.cleaned_at || evaluatedFolderSelected() ? null : submission()?.asset_id || null;
  if (assetId === trackingAsset) return;
  trackingAsset = assetId;
  clearTimeout(trackingTimer);
  trackingError = '';
  refreshTracking();
}
async function refreshTracking() {
  const assetId = trackingAsset;
  const start = $('track-motion'), view = $('view-tracking'), points = $('view-points');
  if (!assetId) {
    start.disabled = true; view.disabled = true; points.disabled = true; points.textContent = 'View points only';
    start.textContent = 'Track fingers & mouth';
    return;
  }
  try {
    const data = await storage.trackingStatus(assetId);
    if (assetId !== trackingAsset) return;
    trackingStatus = data;
    logTracking(assetId, data);
    view.disabled = !data.ready;
    points.dataset.ready = data.points_ready ? '1' : '';
    points.textContent = pointsViewPending === assetId && !data.points_ready ? 'Preparing points…' : 'View points only';
    points.disabled = data.status === 'running' || (!data.ready && !data.points_ready);
    if (data.points_ready && pointsViewPending === assetId) {
      pointsViewPending = null;
      viewTracking(true);
    }
    if (data.status === 'running') {
      start.disabled = true;
      const percent = Math.round((data.progress || 0) * 100);
      start.textContent = percent > 0 ? `Tracking… ${percent}%` : 'Tracking…';
      clearTimeout(trackingTimer);
      trackingTimer = setTimeout(refreshTracking, 1000);
    } else if (data.status === 'error') {
      if (pointsViewPending === assetId) {pointsViewPending = null; points.textContent = 'View points only';}
      start.disabled = false; start.textContent = 'Retry tracking';
      if (trackingError !== data.error) {trackingError = data.error || 'Tracking failed.'; notify(trackingError, true);}
      trackingWait.delete(assetId);
    } else if (data.ready) {
      start.disabled = false; start.textContent = 'Track again';
      if (trackingWait.has(assetId)) {trackingWait.delete(assetId); notify('Tracking videos are ready.');}
    } else {
      start.disabled = false; start.textContent = 'Track fingers & mouth';
    }
  } catch (error) {
    if (assetId !== trackingAsset) return;
    start.disabled = false; view.disabled = true; points.disabled = true; points.textContent = 'View points only';
    start.textContent = 'Track fingers & mouth';
  }
}
function logTracking(assetId, data) {
  const percent = Math.round((data.progress || 0) * 100);
  const line = `Tracking ${assetId.slice(0, 8)}: ${data.status}${data.status === 'running' ? ' ' + percent + '%' : ''}${data.error ? ' - ' + data.error : ''}`;
  if (line === trackingLog) return;
  trackingLog = line;
  console.log(line);
}
function trackingFailure(error) {
  if (/unknown endpoint/i.test(error.message) || capabilities.tracking === undefined) return 'Restart Still using your launcher, then click Track fingers & mouth.';
  return error.message;
}
async function startTracking() {
  const assetId = submission()?.asset_id;
  if (!assetId || $('track-motion').disabled) return;
  if (capabilities.tracking === undefined) {notify(trackingFailure(new Error('Unknown endpoint')), true); console.error('Tracking route is missing. Restart Still using your launcher so this server loads the tracking endpoint.'); return;}
  $('track-motion').disabled = true; $('track-motion').textContent = 'Starting tracking…';
  console.log('Tracking ' + assetId.slice(0, 8) + ': requested');
  try {
    await storage.startTracking(assetId);
    trackingWait.add(assetId); trackingError = '';
    notify('Tracking started. You can keep reviewing.');
    refreshTracking();
  } catch (error) {if (pointsViewPending === assetId) pointsViewPending = null; console.error(error); notify(trackingFailure(error), true); refreshTracking();}
}
function viewTracking(points) {
  const assetId = submission()?.asset_id;
  if (!assetId) return;
  const button = $(points ? 'view-points' : 'view-tracking');
  if (points && button.dataset.ready !== '1') {
    if (button.disabled) return;
    if (!trackingStatus || !Object.prototype.hasOwnProperty.call(trackingStatus, 'points_ready')) {
      notify('Restart Still using your launcher, then click View points only.', true);
      return;
    }
    pointsViewPending = assetId;
    button.textContent = 'Preparing points…';
    if (!$('track-motion').disabled) startTracking();
    return;
  }
  if (button.disabled) return;
  const player = $('tracking-video');
  $('tracking-title').textContent = points ? 'Points only' : 'Tracking video';
  $('tracking-note').textContent = points
    ? 'Fingertips and mouth on an empty background. Amber dots are fingertips. Pink dots are the mouth.'
    : 'Amber dots are fingertips. Pink dots are the mouth. This is a guide for review, not a score.';
  player.setAttribute('aria-label', points ? 'Finger and mouth points' : 'Finger and mouth tracking video');
  player.src = storage.trackingUrl(assetId, points);
  openDialog('tracking-dialog');
  player.play().catch(() => {});
}
function renderSections() {
  $('timeline-markers').replaceChildren();
  for (const item of [...(submission()?.feedback || [])].sort((a, b) => a.start - b.start)) {
    const label = `${clock(item.start)}${item.end > item.start ? '–' + clock(item.end) : ''}`;
    const marker = button(label, () => selectFeedback(item.id));
    marker.setAttribute('aria-pressed', String(feedback()?.id === item.id));
    $('timeline-markers').append(marker);
  }
  requestAnimationFrame(fitSofa);
}
function renderEditor() {
  if (keepOneSectionClip(state)) dirty();
  const item = feedback(); $('no-feedback').hidden = !!item; $('feedback-editor').hidden = !item;
  if (!item) return;
  $('feedback-start').value = item.start.toFixed(2); $('feedback-end').value = item.end.toFixed(2);
  $('feedback-note').value = item.note; $('private-note').value = item.private_note || '';
  $('attached-clips').replaceChildren();
  const clip = item.clips?.[0];
  if (clip) {
    const card = element('div', 'attached-clip'); card.append(element('div', 'attached-clip-title', clip.title || 'Signed correction'));
    const saved = !!(clip.library_id && state.library.some(entry => entry.id === clip.library_id));
    const actions = element('div', 'row');
    actions.append(button('Preview', () => previewAsset(clip.asset_id, clip.title)), button(saved ? 'Edit title and tags' : 'Save to library', () => editLibrary(saved ? clip.library_id : null, clip.asset_id, clip.id)), button('Remove', () => {remember(); item.clips = []; touch(); dirty(); render();}));
    card.append(actions); $('attached-clips').append(card);
  } else $('attached-clips').append(element('p', 'muted', submission()?.cleaned_at ? 'Working media cleaned up. Timestamp and subtitle retained.' : 'Add a signed demonstration, a saved clip, or a written note.'));
  if (item.clip_subtitle && item.clip_subtitle !== item.note) $('attached-clips').append(element('p', 'muted', 'Clip subtitle: ' + item.clip_subtitle));
  syncCleanedControls();
  const replace = willReplaceSectionClip();
  $('editor-record').textContent = replace ? 'Replace recording' : 'Record';
  $('editor-library').textContent = replace ? 'Replace clip' : 'Find clip';
}
function alignSubmissionToFolder() {
  if (!state) return;
  if (submissions().some(item => item.id === state.session.submission_id)) return;
  const next = submissions()[0]?.id || null;
  if (state.session.submission_id === next) return;
  const previous = state.submissions.find(item => item.id === state.session.submission_id);
  if (previous && selectedAsset === previous.asset_id && video.readyState >= 1) {
    previous.position = Math.max(0, video.currentTime || 0); localPositions[previous.id] = previous.position;
  }
  state.session.submission_id = next;
  state.session.feedback_id = submissions()[0]?.feedback?.[0]?.id || null;
  selectedAsset = null; markedIn = markedOut = null; looping = false;
  viewChanged();
}
function render() {syncEvaluatedControls(); if (keepOneSectionClip(state)) dirty(); alignSubmissionToFolder(); applyPreferences(); renderProgress(); renderPlayer(); renderSections(); renderEditor(); updateHint(); syncEvaluatedControls();}
function showFeedback() {$('feedback-panel').hidden = false; document.querySelector('.workspace').classList.add('with-feedback'); renderEditor(); requestAnimationFrame(fitSofa);}
function hideFeedback() {$('feedback-panel').hidden = true; document.querySelector('.workspace').classList.remove('with-feedback'); requestAnimationFrame(fitSofa);}
function studentPosition() {return Math.max(0, video.readyState >= 1 ? video.currentTime : submission()?.position || 0);}
function position() {return showingCorrection ? Math.max(0, (correctionVideo.currentTime || 0) - (browserStorage ? Number(assets.get(submission()?.correction?.asset_id)?.trim_start) || 0 : 0)) : studentPosition();}
function seek(seconds, feedbackId) {
  if (submission()?.cleaned_at) return;
  const duration = activeDuration();
  const target = Math.max(0, Math.min(duration, seconds));
  if (showingCorrection) {correctionVideo.currentTime = target + (browserStorage ? Number(assets.get(submission()?.correction?.asset_id)?.trim_start) || 0 : 0); updateTransport(); return;}
  if (studentPreviewOn() && previewPlayback) {
    const timeline = previewTimeline();
    if (timeline) {setPreviewTime(feedbackId ? previewOutputTime(timeline, target, previewPlayback.time, feedbackId) : previewPlayback.time + seconds - studentPosition(), timeline); return;}
  }
  video.currentTime = target; rememberPosition(); updateTransport();
}
function stepVideo(delta) {
  if (!submission()) return;
  if (showingCorrection) {correctionVideo.pause(); seek(position() + delta); return;}
  if (video.readyState < 1) return;
  if (studentPreviewOn() && previewPlayback) {previewPlayback.playing = false; setPreviewTime(previewPlayback.time + delta); return;}
  video.pause();
  const target = Math.max(0, Math.min(activeDuration(), studentPosition() + delta));
  if (looping && feedback() && (target < feedback().start || target >= feedback().end)) looping = false;
  seek(target);
}
function updateTransport() {
  const player = showingCorrection ? correctionVideo : video;
  const timeline = studentPreviewOn() && previewPlayback ? previewTimeline() : null;
  const current = timeline ? previewPlayback.time : player.currentTime || 0;
  const end = timeline?.end ?? activeDuration();
  const paused = timeline ? !previewPlayback.playing : player.paused;
  $('time').textContent = clock(current); $('duration').textContent = clock(end);
  $('seek').min = timeline?.start ?? 0; $('seek').max = end || 1; $('seek').value = current;
  $('play').textContent = paused ? '▶' : 'Ⅱ';
  $('play').setAttribute('aria-label', showingCorrection ? (paused ? 'Play correction' : 'Pause correction') : (paused ? 'Play video' : 'Pause video'));
  $('loop').setAttribute('aria-pressed', String(looping));
  const range = markedIn !== null ? `Start ${clock(markedIn, true)}${markedOut !== null ? ' · End ' + clock(markedOut, true) : ' · mark an end or add a point'}` : feedback() ? `Selected ${clock(feedback().start, true)}–${clock(feedback().end, true)}` : 'Choose a moment worth revisiting';
  $('range-label').textContent = showingCorrection ? `Signed correction · ${range}` : range;
}
function playPause() {
  if (!submission() || submission().cleaned_at) return;
  if (showingCorrection) {
    if (correctionVideo.paused) correctionVideo.play().catch(error => notify('Correction could not play: ' + error.message, true));
    else correctionVideo.pause();
    return;
  }
  if (studentPreviewOn() && previewPlayback) {
    if (previewPlayback.time >= (previewTimeline()?.end || 0) - .01) setPreviewTime(previewTimeline().start);
    previewPlayback.playing = !previewPlayback.playing;
    previewPlayback.wall = performance.now();
    applyPreviewFrame(); updateTransport(); syncPlayback(true);
    return;
  }
  if (video.paused) video.play().catch(error => notify('Video could not play: ' + error.message, true)); else video.pause();
}
function selectSubmission(id) {
  hideCorrection(); video.pause();
  rememberPosition();
  const item = state.submissions.find(row => row.id === id); if (!item) return;
  state.session.submission_id = id; state.session.assignment_id = item.assignment_id; state.session.feedback_id = item.feedback[0]?.id || null;
  state.session.marked_in = state.session.marked_out = null;
  selectedAsset = null; render(); viewChanged();
}
function nextStudent(direction) {const list = submissions(); if (!list.length) return; const index = list.findIndex(item => item.id === submission()?.id); selectSubmission(list[(index + direction + list.length) % list.length].id);}
function selectFeedback(id) {state.session.feedback_id = id; if (feedback()) {seek(feedback().start, id); showFeedback(); renderSections(); renderEditor(); viewChanged();}}
function nextFeedback(direction) {const list = [...(submission()?.feedback || [])].sort((a, b) => a.start - b.start); if (!list.length) return; const index = list.findIndex(item => item.id === feedback()?.id); selectFeedback(list[(index + direction + list.length) % list.length].id);}
function mark(which) {
  if (!submission() || submission().cleaned_at) return;
  const at = position();
  if (which === 'in') {markedIn = at; markedOut = null;} else {markedOut = at; if (markedIn === null) markedIn = markedOut;}
  state.session.marked_in = markedIn; state.session.marked_out = markedOut; viewChanged(); updateTransport();
  notify(which === 'in' ? 'Section start marked' : 'Section end marked');
}
function addFeedback() {
  if (!submission() || submission().cleaned_at) return null;
  hideCorrection(); video.pause();
  correctionVideo.pause();
  pausePreview();
  updateTransport();
  if (markedIn !== null && markedOut !== null && markedOut < markedIn) {notify('Mark an end after the start of the section.', true); return null;}
  const at = position();
  remember(); const start = markedIn ?? at, end = markedOut ?? start;
  const item = makeFeedback(start, end); submission().feedback.push(item); state.session.feedback_id = item.id;
  markedIn = markedOut = null; state.session.marked_in = state.session.marked_out = null;
  touch(); dirty(); render(); showFeedback(); $('feedback-note').focus(); return item;
}
function ensureFeedback() {return feedback() || addFeedback();}
function hasResponseRange() {
  if (!submission()) return false;
  const item = feedback();
  if (item) {
    if (Number.isFinite(item.start) && Number.isFinite(item.end) && item.end >= item.start) return true;
    notify('Mark an end after the start of the section.', true);
    return false;
  }
  if (markedIn === null) {
    notify('Add feedback at a moment or mark a section on the original video before adding a teacher response.', true);
    return false;
  }
  if (markedOut === null) {
    notify('Mark an end on the original video, or press Feedback to use this moment.', true);
    return false;
  }
  if (markedOut < markedIn) {
    notify('Mark an end after the start of the section.', true);
    return false;
  }
  return true;
}
function willReplaceSectionClip() {return !!feedback()?.clips?.length;}
function undo() {if (submission()?.cleaned_at) return; if (!history.length) return notify('No earlier edit to undo.'); state = history.pop(); selectedAsset = null; dirty(); render(); notify('Last edit undone.');}
function updateFolderPaths(data) {
  folderPaths.source = state.session.source_folder || '';
  folderPaths.output = folderPaths.source || data.output_folder || '';
  notSubmitted = data.not_submitted || [];
}
function acceptFolderWorkspace(data) {
  state = data.state; revision = data.revision;
  assets = new Map(data.assets.map(asset => [asset.id, asset]));
  history = []; savedCount = editCount; clearTimeout(saveTimer);
  updateFolderPaths(data); selectedAsset = null;
  for (const item of state.submissions) if (Number.isFinite(localPositions[item.id])) item.position = localPositions[item.id];
  $('save-state').textContent = 'Saved locally'; $('save-state').classList.remove('failed');
  render(); viewChanged(); scheduleEvaluatedRefresh(); scheduleSourceRefresh();
}
async function browseForVideo() {
  await work('Choose a video folder…', async () => {
    await saveNow();
    if (browserStorage) renderTask?.controller.abort();
    const data = await storage.chooseFolder({assignmentId: state.session.assignment_id,
      revision: evaluatedFolderSelected() ? null : revision, localView: true,
      initial: folderPaths.source || state.session.source_folder || ''});
    if (data.cancelled) return;
    acceptFolderWorkspace(data);
    if (!submission() || submission().assignment_id !== state.session.assignment_id) {
      const first = submissions()[0];
      if (first) {selectSubmission(first.id); await saveNow();}
    }
    const errors = data.errors || [];
    const message = `${data.imported} video${data.imported === 1 ? '' : 's'} loaded${data.skipped ? ` · ${data.skipped} already loaded` : ''}${errors.length ? '. ' + errors.join(' · ') : '.'}`;
    notify(message + (data.storage_migration_deferred ? ' Reopen this folder after exports and tracking finish to move older working files.' : ''), !!errors.length);
  });
}
async function upload(file, kind) {
  const asset = await storage.saveAsset(file, kind, state.session.source_folder || '');
  assets.set(asset.id, asset); if (asset.warning) notify(asset.warning, true); return asset;
}
async function importSubmissions(files) {
  await work('Importing your videos…', async () => {
    if (!currentAssignment()) {remember(); const id = uid(); state.assignments.push({id, title: 'My ASL class', instructions: '', target: ''}); state.session.assignment_id = id; dirty();}
    const assignmentId = state.session.assignment_id; let firstId = null, count = 0; const failures = [];
    for (const [index, file] of [...files].entries()) {
      $('busy-label').textContent = `Importing ${index + 1} of ${files.length} · ${file.name}`;
      try {
        const asset = await upload(file, 'submission'); const id = uid();
        remember(); state.submissions.push({id, assignment_id: assignmentId, asset_id: asset.id, name: file.name.replace(/\.[^.]+$/, ''), status: 'Unreviewed', position: 0, feedback: []});
        firstId ||= id; count++; dirty(); await saveNow();
      } catch (error) {failures.push(file.name + ': ' + error.message);}
    }
    if (firstId) selectSubmission(firstId); else render();
    notify(`${count} video${count === 1 ? '' : 's'} imported${failures.length ? '. ' + failures.join(' · ') : ''}`, !!failures.length);
  });
}
function openLibrary(search = true, target = 'section') {
  libraryTarget = target;
  if (!submission() && !$('library-dialog').open) notify('You can organize the shelf before selecting a student.');
  renderLibrary(); openDialog('library-dialog', search ? 'library-search' : null);
  if (!search) requestAnimationFrame(() => $('library-tabs').querySelector('button')?.focus());
}
function libraryUseLabel() {
  return submission()?.correction?.asset_id ? 'Replace correction' : 'Use this clip';
}
function applyLibraryTarget() {
  const correction = libraryTarget === 'correction';
  $('library-help').textContent = correction
    ? 'Choose a saved clip. It plays beside Record a correction, and its subtitle fills the correction feedback.'
    : 'Teacher responses are kept separately from student submissions. Preview a response, then attach it to this section.';
  if (browserStorage) $('library-help').textContent += ' Cleanup and physical deletion require the local Python server; archive a clip to hide it.';
  $('clip-attach').textContent = correction ? libraryUseLabel() : (willReplaceSectionClip() ? "Replace this section's clip" : 'Attach to this section');
  $('library-save-add').textContent = correction ? 'Save and use this clip' : (willReplaceSectionClip() ? "Save and replace this section's clip" : 'Save and add to this section');
}
function renderLibrary() {
  applyLibraryTarget();
  renderLibraryTagFilters();
  const entries = searchClips(state.library, $('library-search').value, libraryFilter, [...libraryTags]);
  document.querySelectorAll('#library-tabs [data-filter]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.filter === libraryFilter)));
  document.querySelectorAll('[data-library-view]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.libraryView === libraryView)));
  const list = $('library-results'); list.dataset.view = libraryView; list.replaceChildren();
  for (const entry of entries) {
    const card = element('article', 'library-card');
    if (libraryView !== 'list') {
      const image = element('img'); image.src = storage.thumbnailUrl(entry.asset_id); image.alt = ''; image.loading = 'lazy'; image.onerror = () => {image.style.visibility = 'hidden';};
      card.append(image);
    }
    const content = element('div', 'library-card-content');
    content.append(element('h3', 'library-card-title', entry.title || 'Waiting for a title'), element('p', 'library-card-description', entry.description || `${clock(assets.get(entry.asset_id)?.duration)} · v${entry.version || 1}`));
    const tags = element('div', 'tag-row'); (entry.tags || []).slice(0, 5).forEach(tag => tags.append(element('span', 'tag', tag))); content.append(tags);
    const actions = element('div', 'row'); actions.append(button('Preview', () => previewLibrary(entry.id)), button('Edit', () => editLibrary(entry.id)), button(entry.favorite ? '★' : '☆', () => {remember(); entry.favorite = !entry.favorite; dirty(); renderLibrary();}));
    actions.children[2].setAttribute('aria-label', entry.favorite ? 'Remove favorite' : 'Favorite clip');
    if (submission() && !submission().cleaned_at && !entry.inbox && !entry.archived) actions.append(button(libraryTarget === 'correction' ? libraryUseLabel() : (willReplaceSectionClip() ? "Replace this section's clip" : 'Add to this section'), () => {
      if (attachLibraryEntry(entry.asset_id, entry.title, entry.id)) closeDialog($('library-dialog'));
    }, 'small primary'));
    const remove = button('Delete', () => deleteLibraryClip(entry.id), 'small danger');
    if (browserStorage) {remove.disabled = true; remove.title = 'Physical deletion requires the local Python server. Archive this clip to hide it.';}
    actions.append(remove);
    content.append(actions); card.append(content); list.append(card);
  }
  if (!entries.length) {
    const empty = element('div', 'library-empty'); empty.append(element('h3', '', 'Your next good explanation belongs here.'), element('p', '', $('library-search').value ? 'No matching clips. Try fewer words, another tag, or record a new explanation.' : 'Import a prerecorded clip, or save a correction after recording it.'));
    empty.append(button('Import a clip', () => beginReferenceImport())); list.append(empty);
  }
}
function previewLibrary(id) {const entry = state.library.find(item => item.id === id); if (!entry) return; previewEntry = id; previewAsset(entry.asset_id, entry.title, entry.description, entry.tags); $('clip-edit').hidden = false; $('clip-attach').disabled = !submission() || entry.inbox || entry.archived;}
function librarySubtitle(libraryId) {
  if (!libraryId || !state) return '';
  return (state.library.find(entry => entry.id === libraryId)?.description || '').trim();
}
function previewAsset(assetId, title, description = '', tags = []) {
  const entry = state.library.find(item => item.asset_id === assetId);
  previewEntry = entry?.id || null;
  $('clip-title').textContent = title || 'Signed feedback'; $('clip-video').src = storage.mediaUrl(assetId); $('clip-video').dataset.asset = assetId;
  if (browserStorage) $('clip-video').addEventListener('loadedmetadata', () => {$('clip-video').currentTime = Number(assets.get(assetId)?.trim_start) || 0;}, {once: true});
  const caption = (description || entry?.description || '').trim();
  $('clip-description').textContent = caption; $('clip-description').hidden = !caption;
  $('clip-tags').replaceChildren(); tags.forEach(tag => $('clip-tags').append(element('span', 'tag', tag)));
  $('clip-edit').hidden = !previewEntry;
  $('clip-attach').textContent = libraryTarget === 'correction' ? libraryUseLabel() : (willReplaceSectionClip() ? "Replace this section's clip" : 'Attach to this section');
  $('clip-attach').disabled = !submission(); openDialog('clip-dialog', 'clip-attach');
}
function attachAsset(assetId, title, libraryId = null) {
  if (submission()?.cleaned_at) return false;
  if (!hasResponseRange()) return false;
  const item = ensureFeedback(); if (!item) return false;
  const entry = libraryId ? state.library.find(row => row.id === libraryId) : null;
  const subtitle = (entry?.description || '').trim();
  const replaced = Array.isArray(item.clips) && item.clips.length > 0;
  remember(); item.clips = [{id: uid(), asset_id: assetId, title: (title || entry?.title || 'Signed correction').slice(0, 200), library_id: libraryId}];
  if (subtitle) item.note = subtitle;
  if (entry) entry.used_at = now();
  touch(); dirty(); render(); showFeedback(); notify(replaced ? 'Correction clip replaced.' : 'Correction clip attached to this section.');
  return true;
}
function correctionFeedbackText(correction) {
  if (!correction) return '';
  if (Object.hasOwn(correction, 'note')) return String(correction.note || '');
  return librarySubtitle(correction.library_id);
}
function attachSavedCorrection(assetId, title, libraryId = null) {
  if (submission()?.cleaned_at) return false;
  const item = submission();
  if (!item || !assetId) return false;
  const entry = libraryId ? state.library.find(row => row.id === libraryId) : null;
  const subtitle = (entry?.description || '').trim();
  remember();
  const correction = {asset_id: assetId, title: (title || entry?.title || 'Signed correction').slice(0, 200)};
  if (libraryId) correction.library_id = libraryId;
  if (subtitle) correction.note = subtitle;
  item.correction = correction;
  if (entry) entry.used_at = now();
  touch(); dirty(); render();
  hideCorrection();
  correctionVideo.removeAttribute('src'); correctionVideo.dataset.asset = '';
  notify(subtitle ? 'Saved clip ready. Its subtitle is in the correction feedback.' : 'Saved clip ready.');
  return true;
}
function attachLibraryEntry(assetId, title, libraryId = null) {
  return libraryTarget === 'correction' ? attachSavedCorrection(assetId, title, libraryId) : attachAsset(assetId, title, libraryId);
}
function editLibrary(id = null, assetId = null, clipId = null) {
  editEntryId = id; newEntryAsset = assetId; libraryClipId = clipId; const entry = state.library.find(item => item.id === id);
  $('library-title').value = entry?.title || ''; $('library-tags').value = '';
  $('library-description').value = entry?.description || ''; $('library-aliases').value = entry?.aliases?.join(', ') || '';
  $('library-favorite').checked = !!entry?.favorite; renderTagChoices(entry);
  $('replace-library-video').hidden = !entry; $('archive-library').hidden = !entry; $('delete-library').hidden = !entry || browserStorage; $('archive-library').textContent = entry?.archived ? 'Restore clip' : 'Archive clip';
  $('library-save-add').hidden = !!entry || !assetId || !submission() || !!clipId;
  openDialog('library-edit-dialog', 'library-title');
}
function onThisComputer() {
  if (browserStorage) return false;
  const host = location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}
function beginReferenceImport(replaceId = null) {
  referenceReplace = replaceId;
  if (onThisComputer()) pickReference();
  else $('reference-import').click();
}
function applyWorkspace(data) {
  const assetId = selectedAsset;
  state = data.state; revision = data.revision;
  restoreWindowView();
  assets = new Map(data.assets.map(item => [item.id, item]));
  if (!currentAssignment()) state.session.assignment_id = state.assignments[0]?.id || null;
  if (!submission()) state.session.submission_id = submissions()[0]?.id || null;
  history = []; savedCount = editCount; clearTimeout(saveTimer);
  updateFolderPaths(data);
  selectedAsset = assetId === submission()?.asset_id ? assetId : null;
  $('save-state').textContent = 'Saved locally'; $('save-state').classList.remove('failed');
  render();
}
function deletedClipUseCount(entry) {
  let count = 0;
  for (const row of state.submissions || []) {
    for (const item of row.feedback || []) count += (item.clips || []).filter(clip => clip.asset_id === entry.asset_id).length;
    const correction = row.correction;
    if (correction?.asset_id === entry.asset_id) count += 1;
  }
  return count;
}
async function deleteLibraryClip(id) {
  if (browserStorage) return notify('Physical library deletion requires the local Python app. Archive the clip to hide it.', true);
  const entry = state.library.find(item => item.id === id);
  if (!entry) return;
  const count = deletedClipUseCount(entry);
  const message = count
    ? `Delete this clip? It is used in ${count} student response${count === 1 ? '' : 's'}. The video moves to deleted files and those responses are removed.`
    : 'Delete this clip? The video moves to deleted files.';
  if (!confirm(message)) return;
  await work('Moving the clip to deleted files…', async () => {
    await saveNow();
    const data = await storage.deleteLibraryClip(id, revision);
    if ($('library-edit-dialog').open) closeDialog($('library-edit-dialog'));
    if ($('clip-dialog').open) closeDialog($('clip-dialog'));
    applyWorkspace(data);
    if ($('library-dialog').open) renderLibrary();
    notify('Clip deleted. The video is in deleted files.');
  });
}
async function openCleanup() {
  if (browserStorage) return notify('Cleanup requires the local Python app.', true);
  const ready = await work('Checking evaluated reviews…', async () => {
    await saveNow();
    const data = await storage.cleanupStatus();
    if (data.revision !== revision) throw new Error('The workspace changed in another window. Reload before cleanup.');
    const list = $('cleanup-reviews'); list.replaceChildren();
    for (const review of data.reviews) {
      const label = element('label', 'checkbox');
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = review.id; input.disabled = !!review.reason;
      input.addEventListener('change', () => {$('cleanup-confirm').disabled = !list.querySelector('input:checked');});
      label.append(input, document.createTextNode(review.name + (review.reason ? ' — ' + review.reason : ' — evaluated MP4 saved'))); list.append(label);
    }
    $('cleanup-empty').hidden = data.reviews.some(review => !review.reason);
    $('cleanup-confirm').disabled = true;
    return true;
  });
  if (ready) openDialog('cleanup-dialog');
}
async function cleanSelectedReviews() {
  if (browserStorage) return notify('Cleanup requires the local Python app.', true);
  const ids = [...$('cleanup-reviews').querySelectorAll('input:checked')].map(input => input.value);
  if (!ids.length) return;
  await work('Cleaning up working media…', async () => {
    await saveNow();
    const data = await storage.cleanupReviews(ids, revision);
    closeDialog($('cleanup-dialog'));
    selectedAsset = null; trackingAsset = null; destroyPreview();
    applyWorkspace(data);
    if ($('library-dialog').open) renderLibrary();
    notify(`${data.cleaned_reviews} review${data.cleaned_reviews === 1 ? '' : 's'} cleaned up. ${(data.removed_bytes / 1048576).toFixed(1)} MB freed. Timestamps and subtitles kept.`);
  });
}
async function pickReference() {
  if (browserStorage) return notify('Choose a clip file in the browser.', true);
  const replacing = referenceReplace;
  await work(replacing ? 'Choose a new clip version…' : 'Choose a clip…', async () => {
    const data = await storage.pickReference();
    if (data.cancelled) {referenceReplace = null; return;}
    const asset = data.asset;
    assets.set(asset.id, asset);
    if (asset.warning) notify(asset.warning, true);
    if (replacing) {
      remember();
      const entry = state.library.find(item => item.id === replacing);
      if (entry) {entry.asset_id = asset.id; entry.version = (entry.version || 1) + 1;}
      dirty(); await saveNow();
      notify('New version saved. Previously attached feedback keeps its original video.');
    } else editLibrary(null, asset.id);
    referenceReplace = null; renderLibrary();
  });
}
async function importReference(file) {
  let asset;
  await work(referenceReplace ? 'Saving a new clip version…' : 'Importing your reference clip…', async () => {
    asset = await upload(file, 'reference');
    if (referenceReplace) {remember(); const entry = state.library.find(item => item.id === referenceReplace); if (entry) {entry.asset_id = asset.id; entry.version = (entry.version || 1) + 1;} dirty(); await saveNow(); notify('New version saved. Previously attached feedback keeps its original video.');}
  });
  if (asset && !referenceReplace) editLibrary(null, asset.id);
  referenceReplace = null; renderLibrary();
}
function stopCamera() {rec.stream?.getTracks().forEach(track => track.stop()); rec.stream = null; $('camera-video').srcObject = null;}
function resetRecording() {
  clearInterval(rec.interval); clearTimeout(rec.timeout);
  if (rec.url) URL.revokeObjectURL(rec.url);
  rec.blob = rec.url = rec.asset = null; rec.elapsed = 0; rec.previewed = false;
  $('recorded-video').pause(); $('recorded-video').removeAttribute('src');
  syncRecordSubtitle();
}
function syncRecordSubtitle() {
  const caption = $('record-subtitle');
  if (!caption || rec.phase !== 'preview' || recorderMode !== 'submission') {
    if (caption) {caption.textContent = ''; caption.hidden = true;}
    return;
  }
  const note = $('record-note').value.trim();
  caption.textContent = note;
  caption.hidden = !note;
}
function syncCorrectionSubtitle() {
  const caption = $('correction-subtitle');
  if (!caption) return;
  const correction = showingCorrection ? submission()?.correction : null;
  const note = correction ? correctionFeedbackText(correction).trim() : '';
  caption.textContent = note;
  caption.hidden = !note;
}
async function prepareCamera() {
  stopCamera(); $('record-start').disabled = true; rec.phase = 'camera'; setRecorderView();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires HTTPS or localhost in a supported browser.');
    rec.stream = await navigator.mediaDevices.getUserMedia({video: {width: {ideal: 1280}, height: {ideal: 720}}, audio: $('microphone').checked});
    if (!$('recorder-dialog').open) {stopCamera(); return;}
    $('camera-video').srcObject = rec.stream; $('record-start').disabled = false; $('record-start').focus();
    $('recorder-message').textContent = cameraReadyMessage();
    rec.stream.getVideoTracks()[0].addEventListener('ended', () => {if (rec.phase === 'recording') stopRecording(); notify('Camera disconnected. Your review is preserved.', true);});
  } catch (error) {$('recorder-message').textContent = 'Camera unavailable. Check browser permission or use an existing clip; your review is preserved.'; notify(error.message, true);}
}
function cameraReadyMessage() {
  if (recorderMode !== 'submission') return 'Check that your face, hands, and signing space are visible. The countdown gives you time to put the controller down.';
  return submission()?.correction?.asset_id
    ? 'Recording again replaces the saved correction. It plays in the main video window and is not placed on the student timeline.'
    : 'This correction is not placed on the student timeline. Play it in the main video window from the button beside Record a correction.';
}
function previewReadyMessage() {
  if (recorderMode !== 'submission') return feedback()?.clips.length ? 'Your correction is ready. Choose "Replace this clip" to use it, or adjust the trim and preview again.' : 'Your correction is ready. Choose "Use this clip" to attach it, or adjust the trim and preview again.';
  return submission()?.correction?.asset_id
    ? 'Your correction is ready. Choose Replace correction to overwrite the saved video.'
    : 'Your correction is ready. Choose Use this clip to save it. It plays in the main video window and is not placed on the student timeline.';
}
async function openRecorder(mode = 'submission') {
  if (submission()?.cleaned_at) return;
  if (!submission()) return;
  const next = mode === 'section' ? 'section' : 'submission';
  if (next === 'section' && (!hasResponseRange() || !ensureFeedback())) return;
  recorderMode = next;
  $('recorder-title').textContent = next === 'submission' ? 'Record a correction' : 'Show the correction in ASL';
  $('recorder-message').textContent = cameraReadyMessage();
  $('record-title').value = ''; $('record-tags').value = '';
  $('record-note').value = next === 'submission' ? (submission()?.correction?.note || '') : '';
  $('record-note-field').hidden = next !== 'submission';
  resetRecording(); openDialog('recorder-dialog', 'record-start'); await prepareCamera();
}
function setRecorderView() {
  const preview = rec.phase === 'preview', recording = rec.phase === 'recording', counting = rec.phase === 'countdown';
  $('camera-video').hidden = preview; $('recorded-video').hidden = !preview; $('trim-controls').hidden = !preview;
  $('record-details').hidden = !preview;
  $('record-note-field').hidden = recorderMode !== 'submission' || !preview;
  $('camera-options').hidden = preview || recording || counting; $('record-start').hidden = preview || recording || counting;
  $('record-stop').hidden = !recording; $('record-retake').hidden = !preview; $('record-use').hidden = !preview;
  $('recording-badge').hidden = !recording; $('countdown-overlay').hidden = !counting;
  $('record-cancel').textContent = counting ? 'Cancel countdown' : recording ? 'Stop and preview' : 'Cancel';
  $('record-start').textContent = `Record${state.session.countdown ? ' · ' + state.session.countdown + ' second countdown' : ''}`;
  $('record-use').textContent = recorderMode === 'submission' && submission()?.correction?.asset_id ? 'Replace correction' : recorderMode !== 'submission' && feedback()?.clips.length ? 'Replace this clip' : 'Use this clip';
  syncRecordSubtitle();
}
function startCountdown() {
  if (!rec.stream || rec.phase !== 'camera') return;
  let remaining = Number(state.session.countdown ?? 3); rec.phase = 'countdown'; setRecorderView();
  const tick = () => {if (remaining <= 0) {clearInterval(rec.interval); startRecording();} else {$('countdown-overlay').textContent = remaining--;}};
  tick(); if (rec.phase === 'countdown') rec.interval = setInterval(tick, 1000);
}
function startRecording() {
  try {
    const mime = ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    rec.media = new MediaRecorder(rec.stream, mime ? {mimeType: mime} : undefined);
    const chunks = []; rec.phase = 'recording'; rec.started = performance.now();
    rec.media.ondataavailable = event => {if (event.data.size) chunks.push(event.data);};
    rec.media.onstop = () => {
      clearInterval(rec.interval); rec.elapsed = (performance.now() - rec.started) / 1000;
      rec.blob = new Blob(chunks, {type: rec.media.mimeType || 'video/webm'}); rec.url = URL.createObjectURL(rec.blob);
      rec.phase = 'preview'; stopCamera(); $('recorded-video').src = rec.url;
      $('trim-start').max = $('trim-end').max = rec.elapsed; $('trim-start').value = 0; $('trim-end').value = rec.elapsed;
      setRecorderView(); updateTrim(); $('play-trim').focus();
      $('recorder-message').textContent = 'Starting your preview… You can trim the beginning or end before using this clip.';
      $('recorded-video').play().catch(() => {
        if (rec.phase !== 'preview' || rec.previewed) return;
        const action = recorderMode === 'submission' && submission()?.correction?.asset_id ? 'Replace correction' : recorderMode !== 'submission' && feedback()?.clips.length ? 'Replace this clip' : 'Use this clip';
        $('recorder-message').textContent = `Select "Preview selected trim" to watch your recording and enable "${action}".`;
      });
    };
    rec.media.start(1000); setRecorderView(); $('record-stop').focus();
    rec.interval = setInterval(() => {$('recording-time').textContent = clock((performance.now() - rec.started) / 1000);}, 200);
  } catch (error) {rec.phase = 'camera'; setRecorderView(); notify('Recording could not start: ' + error.message, true);}
}
function stopRecording() {if (rec.phase === 'recording' && rec.media?.state !== 'inactive') rec.media.stop();}
function cancelRecorder() {
  if (rec.phase === 'recording') {stopRecording(); return;}
  if (rec.phase === 'countdown') {clearInterval(rec.interval); rec.phase = 'camera'; setRecorderView(); return;}
  if (rec.blob && !confirm('Discard this unaccepted take? Your existing feedback stays intact.')) return;
  resetRecording(); stopCamera(); rec.phase = 'idle'; closeDialog($('recorder-dialog'));
}
function updateTrim() {
  $('trim-start-label').value = `${Number($('trim-start').value).toFixed(2)} s`; $('trim-end-label').value = `${Number($('trim-end').value).toFixed(2)} s`;
  $('record-use').disabled = !rec.previewed || Number($('trim-end').value) <= Number($('trim-start').value);
}
async function useRecording() {
  if (!rec.blob || rec.phase !== 'preview') return;
  const tags = [...new Map($('record-tags').value.split(',').map(tag => tag.trim()).filter(Boolean).map(tag => [tag.toLowerCase(), tag])).values()];
  if (tags.length > 100 || tags.some(tag => tag.length > 200)) {notify('Use up to 100 tags, each 200 characters or fewer.', true); return;}
  const title = $('record-title').value.trim() || (tags.length ? tags.join(', ').slice(0, 200) : 'Signed correction');
  const note = recorderMode === 'submission' ? $('record-note').value.trim() : '';
  let libraryId = null;
  let result;
  let replaced = false;
  await work('Saving your signed correction…', async () => {
    const extension = rec.blob.type.includes('mp4') ? 'mp4' : 'webm';
    rec.asset ||= await upload(new File([rec.blob], `Correction-${Date.now()}.${extension}`, {type: rec.blob.type}), 'correction');
    const start = Number($('trim-start').value), end = Math.min(Number($('trim-end').value), rec.asset.duration || rec.elapsed);
    result = rec.asset;
    if (start > .04 || end < (rec.asset.duration || rec.elapsed) - .15) {
      result = await storage.trimAsset(rec.asset.id, start, end); assets.set(result.id, result);
    }
    if (recorderMode === 'submission') {
      if (!submission()) return;
      replaced = !!submission().correction?.asset_id;
      remember();
      submission().correction = {asset_id: result.id, title};
      if (note) submission().correction.note = note;
      if (tags.length) {
        libraryId = uid();
        state.library.push({id: libraryId, asset_id: result.id, title, tags, description: '', aliases: [], category: 'General feedback', favorite: false, archived: false, inbox: false, version: 1, used_at: now()});
        submission().correction.library_id = libraryId;
      }
      touch(); dirty(); render();
    } else {
      attachAsset(result.id, title);
      if (tags.length) {
        libraryId = uid();
        state.library.push({id: libraryId, asset_id: result.id, title, tags, description: '', aliases: [], category: feedback()?.category || 'General feedback', favorite: false, archived: false, inbox: false, version: 1, used_at: now()});
        feedback().clips.at(-1).library_id = libraryId;
        dirty(); renderEditor();
      }
    }
    await saveNow();
  });
  const saved = recorderMode === 'submission'
    ? submission()?.correction?.asset_id === result?.id
    : !!feedback()?.clips.some(clip => clip.asset_id === result?.id);
  if (result && saved) {
    resetRecording(); stopCamera(); rec.phase = 'idle'; closeDialog($('recorder-dialog'));
    if (recorderMode === 'submission') {
      hideCorrection();
      correctionVideo.removeAttribute('src'); correctionVideo.dataset.asset = '';
      notify(libraryId ? 'Saved to your clip shelf. The play button uses this correction.' : replaced ? 'Correction replaced.' : 'Correction saved.');
    } else if (libraryId) notify('Saved to your clip shelf. Find this recording again by searching its tags.');
  }
}
function syncCorrectionControl() {
  const correction = submission()?.correction;
  const ready = !!(submission() && correction?.asset_id);
  if (!ready && showingCorrection) hideCorrection();
  else if (ready && showingCorrection && correctionVideo.dataset.asset !== correction.asset_id) hideCorrection();
}
function hideCorrection() {
  if (!showingCorrection) return;
  correctionVideo.pause();
  showingCorrection = false;
  videoShell().classList.remove('showing-correction');
  correctionVideo.hidden = true;
  syncCorrectionSubtitle();
  syncCorrectionControl();
  updateTransport();
  syncStudentPreview(true);
}
function deleteCorrection() {
  const item = submission();
  if (!item?.correction?.asset_id) return;
  if (!confirm('Delete this correction? Library clips stay available.')) return;
  remember();
  delete item.correction;
  correctionVideo.pause();
  correctionVideo.removeAttribute('src');
  correctionVideo.dataset.asset = '';
  touch();
  dirty();
  render();
}
function playCorrection() {
  if (showingCorrection) {hideCorrection(); return;}
  const correction = submission()?.correction;
  if (!correction?.asset_id) return;
  video.pause();
  if (correctionVideo.dataset.asset !== correction.asset_id) {
    correctionVideo.dataset.asset = correction.asset_id;
    correctionVideo.src = storage.mediaUrl(correction.asset_id);
  }
  destroyPreview();
  showingCorrection = true;
  videoShell().classList.add('showing-correction');
  correctionVideo.hidden = false;
  correctionVideo.currentTime = browserStorage ? Number(assets.get(correction.asset_id)?.trim_start) || 0 : 0;
  syncCorrectionSubtitle();
  syncCorrectionControl();
  updateTransport();
  correctionVideo.play().catch(error => notify('Correction could not play: ' + error.message, true));
}
function rememberExport(id, data) {
  const local = state.submissions.find(row => row.id === id);
  if (!local) return;
  if (data.last_export) local.last_export = data.last_export;
  if (Number.isInteger(data.export_count)) local.export_count = data.export_count;
  if (data.submission_status && local.status !== 'In progress') local.status = data.submission_status;
  // A newer revision may include another window's edits. Keep conflict
  // protection until the entire local snapshot can be refreshed safely.
}
async function applyFinishedExport(id, data) {
  if (evaluatedFolderSelected()) {await refreshEvaluatedFolder(); return;}
  const fresh = await readWorkspace();
  if (savedCount !== editCount) {
    rememberExport(id, data);
    applyExportIndicators(fresh);
    render(); return;
  }
  state = fresh.state; revision = fresh.revision;
  restoreWindowView();
  assets = new Map(fresh.assets.map(asset => [asset.id, asset]));
  render();
}
function applyExportIndicators(data) {
  const indicators = new Map(data.state.submissions.map(item => [item.id, item]));
  let changed = false;
  for (const item of state.submissions) {
    const count = indicators.get(item.id)?.evaluated_export_count || 0;
    const uploaded = !!indicators.get(item.id)?.evaluated_uploaded;
    if (item.evaluated_export_count !== count || !!item.evaluated_uploaded !== uploaded) changed = true;
    item.evaluated_export_count = count;
    item.evaluated_uploaded = uploaded;
  }
  return changed;
}
async function refreshExportIndicators() {
  if (!state) return;
  const path = state.session.source_folder;
  try {
    const data = await readWorkspace();
    if (path !== state.session.source_folder) return;
    if (applyExportIndicators(data)) renderProgress();
    labelExportButtons();
  }
  catch (error) {console.error('Could not refresh evaluated files:', error);}
}
function scheduleEvaluatedRefresh() {
  clearTimeout(evaluatedRefresh);
  if (evaluatedFolderSelected()) evaluatedRefresh = setTimeout(refreshEvaluatedFolder, 2000);
}
function scheduleSourceRefresh() {
  clearTimeout(sourceRefresh);
  if (state?.session.source_folder && !evaluatedFolderSelected()) sourceRefresh = setTimeout(refreshSourceFolder, 10000);
}
async function refreshSourceFolder() {
  clearTimeout(sourceRefresh);
  if (!state?.session.source_folder || evaluatedFolderSelected()) return;
  if (sourceLoading || document.hidden || busy || saving || savedCount !== editCount) {scheduleSourceRefresh(); return;}
  const path = state.session.source_folder;
  const assignmentId = state.session.assignment_id;
  const startingEditCount = editCount;
  const startingRevision = revision;
  try {
    sourceLoading = true;
    const data = await storage.openFolder(path, assignmentId, startingRevision);
    if (busy || path !== state.session.source_folder || assignmentId !== state.session.assignment_id || startingEditCount !== editCount) return;
    revision = data.revision;
    const known = new Set(state.submissions.map(item => item.id));
    const added = data.state.submissions.filter(item => !known.has(item.id));
    const missing = data.not_submitted || [];
    const availabilityChanged = data.assets.some(asset => !!asset.source_missing !== !!assets.get(asset.id)?.source_missing);
    const exportsChanged = applyExportIndicators(data);
    const libraryChanged = browserStorage && JSON.stringify(data.state.library) !== JSON.stringify(state.library);
    if (!added.length && !availabilityChanged && !exportsChanged && !libraryChanged && JSON.stringify(missing) === JSON.stringify(notSubmitted)) return;
    state.submissions.push(...added);
    if (libraryChanged) state.library = data.state.library;
    assets = new Map(data.assets.map(asset => [asset.id, asset]));
    notSubmitted = missing;
    render();
  } catch (error) {
    // Empty folders stop importing once their optional log is removed.
    // Refresh the roster separately so old informational tiles still disappear.
    try {
      const data = await readWorkspace();
      if (!busy && path === state.session.source_folder && assignmentId === state.session.assignment_id) {
        assets = new Map(data.assets.map(asset => [asset.id, asset]));
        notSubmitted = data.not_submitted || [];
        applyExportIndicators(data);
        render();
      }
    } catch {}
    console.error('Could not refresh source folder:', error);
  }
  finally {sourceLoading = false; scheduleSourceRefresh();}
}
async function refreshEvaluatedFolder() {
  clearTimeout(evaluatedRefresh);
  if (!evaluatedFolderSelected()) return;
  if (evaluatedLoading) {scheduleEvaluatedRefresh(); return;}
  const path = state.session.source_folder;
  try {
    if (document.hidden || busy) return;
    evaluatedLoading = true;
    const data = await storage.openFolder(path);
    if (busy || state.session.source_folder !== path) return;
    const oldVersions = JSON.stringify([...assets.values()].map(asset => [asset.id, asset.evaluated_version]));
    const newVersions = JSON.stringify(data.assets.map(asset => [asset.id, asset.evaluated_version]));
    if (oldVersions === newVersions) return;
    const currentVersion = assets.get(selectedAsset)?.evaluated_version;
    rememberPosition();
    state.submissions = data.state.submissions;
    assets = new Map(data.assets.map(asset => [asset.id, asset]));
    for (const item of state.submissions) item.position = localPositions[item.id] || 0;
    if (currentVersion !== assets.get(selectedAsset)?.evaluated_version) selectedAsset = null;
    render(); viewChanged();
  } catch (error) {console.error('Could not refresh evaluated folder:', error);}
  finally {evaluatedLoading = false; scheduleEvaluatedRefresh();}
}
async function exportFeedback() {
  const item = submission();
  if (!item || exportJobs.has(item.id) || item.cleaned_at) return;
  if (!canExport(item)) {notify('Add a correction clip or written note before exporting feedback.', true); return;}
  const folder = state.session.source_folder || '';
  exportJobs.set(item.id, null); labelExportButtons();
  try {
    await saveNow();
    const snapshotRevision = revision;
    const snapshotEdits = editCount;
    const composition = await currentComposition(item);
    notify('Export started. Rendering video in this browser.');
    const result = await renderExportVideo(composition);
    if (browserStorage && (revision !== snapshotRevision || editCount !== snapshotEdits)) throw new Error('The review changed during rendering. Export again.');
    const data = await storage.saveExport({submissionId: item.id, sourceFolder: folder, revision: snapshotRevision}, result.blob);
    await applyFinishedExport(item.id, data);
    const drafts = item.feedback.filter(row => !row.note.trim() && !row.clips.length).length;
    notify(`${data.filename} exported. Saved in ${data.saved_directory}.${drafts ? ' Empty drafts remain saved for later.' : ''}`);
  } catch (error) {if (error.name !== 'AbortError') notify(error.message, true);}
  finally {exportJobs.delete(item.id); labelExportButtons();}
}
async function currentComposition(item = submission()) {
  if (!browserStorage) return videoComposition(item, assets, state.library);
  const ids = new Set([item.asset_id, ...(item.feedback || []).flatMap(row => (row.clips || []).map(clip => clip.asset_id)), item.correction?.asset_id].filter(Boolean));
  const media = await storage.resolveExportMedia(ids);
  return videoComposition(item, assets, state.library, id => media.get(id));
}
async function renderExportVideo(composition) {
  if (renderTask) throw new Error('Wait for the current export to finish rendering, or cancel it first.');
  const task = {controller: new AbortController()};
  renderTask = task;
  $('render-status').hidden = false; $('render-progress').value = 0;
  $('render-message').textContent = 'Preparing final export in this browser…';
  try {
    return await renderVideo(composition, {signal: task.controller.signal, onProgress: value => {
      $('render-progress').value = value; $('render-message').textContent = `Rendering final export · ${Math.floor(value * 100)}%`;
    }});
  } finally {if (renderTask === task) {renderTask = null; $('render-status').hidden = true;}}
}
function pausePreview() {
  if (previewPlayback) previewPlayback.playing = false;
  video.pause();
  for (const entry of previewOverlays) entry.video.pause();
  previewTail?.video.pause();
  updateTransport();
}
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
function studentPreviewOn() {return !submission()?.cleaned_at && !showingCorrection && $('student-preview').checked && !!submission();}
function previewTimeline() {
  const item = submission();
  if (!item) return null;
  const timeline = studentPreviewTimeline(item.feedback, activeDuration(), clip => {
    const entry = previewOverlays.find(row => row.clip.asset_id === clip.asset_id);
    return entry ? clipDuration(entry) : assets.get(clip.asset_id)?.duration || 0;
  }) || {start: 0, end: 0, items: []};
  if (item.correction?.asset_id) {
    const length = previewTail ? clipDuration(previewTail) : assets.get(item.correction.asset_id)?.duration || 0;
    const start = timeline.end;
    const note = correctionFeedbackText(item.correction);
    timeline.items.push({tail: true, item: {id: 'correction', note, clips: [item.correction]},
      sectionStart: start, start, end: start + length, sourceStart: activeDuration(), sourceEnd: activeDuration(), clipLength: length});
    timeline.end += length;
  }
  return timeline.items.length ? timeline : null;
}
function applyPreviewFrame(timeline = previewTimeline()) {
  if (!previewPlayback || !timeline || video.readyState < 1) return;
  const mapped = previewStudentTime(timeline, previewPlayback.time, activeDuration());
  if (mapped.holding || !previewPlayback.playing) video.pause();
  if (mapped.holding) previewWaiting = false;
  if (Math.abs(video.currentTime - mapped.student) > (mapped.holding || !previewPlayback.playing ? .005 : .15)) {
    previewSeeking = true;
    video.currentTime = mapped.student;
  }
  if (!mapped.holding && previewPlayback.playing && video.paused && !video.seeking && !video.ended) {
    video.play().catch(error => {previewPlayback.playing = false; notify('Video could not play: ' + error.message, true);});
  }
}
function setPreviewTime(time, timeline = previewTimeline()) {
  if (!previewPlayback || !timeline) return;
  previewPlayback.time = clamp(time, timeline.start, timeline.end);
  previewPlayback.wall = performance.now();
  if (previewPlayback.time >= timeline.end - .01) {previewPlayback.time = timeline.end; previewPlayback.playing = false;}
  applyPreviewFrame(timeline); syncPlayback(true); updateTransport();
}
function advancePreview() {
  const timeline = previewTimeline();
  if (!previewPlayback || !timeline) return;
  const now = performance.now(), elapsed = Math.max(0, (now - previewPlayback.wall) / 1000);
  previewPlayback.wall = now;
  if (previewPlayback.playing) {
    const mapped = previewStudentTime(timeline, previewPlayback.time, activeDuration());
    const section = previewSectionAt(timeline, previewPlayback.time);
    if (mapped.holding && !video.seeking) previewPlayback.time += elapsed * video.playbackRate;
    else if (!video.paused && !video.seeking && !previewWaiting) {
      // Stop at the hold boundary before advancing the response on wall time.
      previewPlayback.time = section.sectionStart + Math.min(video.currentTime, section.sourceEnd) - section.sourceStart;
    } else if (video.ended) {
      previewPlayback.time = section.sectionStart + section.sourceEnd - section.sourceStart;
    }
    const selected = looping && timeline.items.find(row => row.item.id === feedback()?.id);
    if (selected && previewPlayback.time >= selected.end) previewPlayback.time = selected.start;
    else if (previewPlayback.time >= timeline.end) {previewPlayback.time = timeline.end; previewPlayback.playing = false;}
  }
  applyPreviewFrame(timeline); syncPlayback(); updateTransport();
}
function destroyPreview() {
  previewPlayback = null; previewWaiting = false;
  cancelAnimationFrame(previewRaf); previewRaf = 0;
  if (previewTail) {previewTail.video.pause(); previewTail.box.remove(); previewTail = null;}
  for (const entry of previewOverlays) {entry.video.pause(); entry.box.remove(); entry.tools.remove();}
  previewOverlays = []; previewKey = '';
  $('feedback-subtitle').textContent = ''; $('feedback-subtitle').hidden = true;
  $('feedback-timestamp').textContent = ''; $('feedback-timestamp').hidden = true;
  $('preview-controls').replaceChildren(); $('preview-controls').hidden = true;
}
function previewSignature() {
  const item = submission();
  if (!item) return '';
  return item.id + '\n' + [...item.feedback].sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id))).map(row => [row.id, row.start, row.end, ...row.clips.map(clip => `${clip.id || ''}:${clip.asset_id}`)].join('|')).join('\n') + '\ntail:' + (item.correction?.asset_id || '');
}
function rebindPreview() {
  const rows = submission()?.feedback || [];
  for (const entry of previewOverlays) {
    const item = rows.find(row => row.id === entry.item.id);
    const clip = item?.clips.find(row => row.id === entry.clip.id);
    if (!item || !clip) return false;
    entry.item = item; entry.clip = clip;
  }
  if (previewTail) previewTail.clip = submission().correction;
  return true;
}
function clipDuration(entry) {
  if (browserStorage) return clipAssetDuration(entry.clip.asset_id);
  if (Number.isFinite(entry.video.duration) && entry.video.duration > 0) return entry.video.duration;
  return assets.get(entry.clip.asset_id)?.duration || 0;
}
function latestPreviewItem(current, timeline) {
  return timeline?.items.reduce((latest, row) => row.start <= current && current < row.end && (!latest || row.start >= latest.start) ? row : latest, null);
}
function subtitleText(row) {
  if (!row) return '';
  if (row.tail) return row.item.note;
  const clip = row.item.clips?.at(-1);
  return (clip && librarySubtitle(clip.library_id)) || (row.item.note || '').trim();
}
function positionOverlay(entry, commit = false) {
  if (entry === previewTail) return;
  const shell = $('video-shell');
  const width = shell.clientWidth, height = shell.clientHeight;
  let x = entry.x, y = entry.y;
  if (video.readyState >= 1 && entry.video.readyState >= 1 && width && height && entry.video.videoWidth) {
    const videoHeight = (width * entry.size - 2) * entry.video.videoHeight / entry.video.videoWidth + 2;
    x = clamp(x, 0, Math.max(0, 1 - entry.size));
    y = clamp(y, 0, Math.max(0, 1 - videoHeight / height));
  }
  if (commit) {entry.x = x; entry.y = y;}
  entry.box.style.left = x * 100 + '%';
  entry.box.style.top = y * 100 + '%';
}
function resizeOverlay(entry, delta, commit = true) {
  entry.size = clamp(entry.size + delta, .1, .8);
  entry.box.style.width = entry.size * 100 + '%';
  positionOverlay(entry, commit);
  if (commit) saveOverlay(entry);
}
function saveOverlay(entry) {
  rebindPreview();
  const overlay = {x: entry.x, y: entry.y, size: entry.size};
  if (![overlay.x, overlay.y, overlay.size].every(Number.isFinite) || overlay.x < 0 || overlay.x > 1 || overlay.y < 0 || overlay.y > 1 || overlay.size < .1 || overlay.size > .8) return;
  if (JSON.stringify(entry.clip.overlay) === JSON.stringify(overlay)) return;
  remember(); entry.clip.overlay = {...overlay}; dirty();
}
function moveOverlay(entry, dx, dy) {entry.x += dx; entry.y += dy; positionOverlay(entry, true); saveOverlay(entry);}
function makeTeacherOverlay(item, clip, index) {
  const box = element('div', 'teacher-overlay overlay-handle');
  box.hidden = true; box.tabIndex = 0; box.setAttribute('role', 'group');
  box.setAttribute('aria-label', (clip.title || 'Teacher response') + ' - drag or use arrow keys to move');
  const player = element('video');
  player.src = storage.mediaUrl(clip.asset_id); player.playsInline = true; player.muted = true; player.preload = 'auto';
  box.append(player); $('video-shell').append(box);
  const tools = element('div', 'overlay-tools'), label = element('span', 'response-title', clip.title || 'Teacher response');
  const smaller = element('button', 'small', '-'), larger = element('button', 'small', '+'), audio = element('button', 'small', 'Unmute');
  for (const node of [smaller, larger, audio]) node.type = 'button';
  smaller.setAttribute('aria-label', 'Shrink teacher response'); larger.setAttribute('aria-label', 'Enlarge teacher response');
  audio.setAttribute('aria-label', 'Unmute teacher response'); audio.setAttribute('aria-pressed', 'false');
  tools.append(label, smaller, larger); tools.hidden = true;
  const defaults = {x: .65 - (index % 2) * .34, y: .04 + (index % 3) * .22, size: .32};
  const entry = {item, clip, box, video: player, tools, label, ...defaults, ...clip.overlay, pending: false, failed: false};
  previewOverlays.push(entry); resizeOverlay(entry, 0, false);
  smaller.addEventListener('click', () => resizeOverlay(entry, -.05));
  larger.addEventListener('click', () => resizeOverlay(entry, .05));
  for (const [name, text, x, y] of [['left', '←', -.02, 0], ['up', '↑', 0, -.02], ['down', '↓', 0, .02], ['right', '→', .02, 0]]) {
    const control = element('button', 'small', text); control.type = 'button';
    control.setAttribute('aria-label', 'Move teacher response ' + name);
    control.addEventListener('click', () => moveOverlay(entry, x, y)); tools.append(control);
  }
  tools.append(audio); $('preview-controls').append(tools);
  audio.addEventListener('click', () => {
    player.muted = !player.muted; audio.textContent = player.muted ? 'Unmute' : 'Mute';
    audio.setAttribute('aria-label', audio.textContent + ' teacher response'); audio.setAttribute('aria-pressed', String(!player.muted));
  });
  let drag = null;
  box.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); drag = {x: event.clientX, y: event.clientY, left: entry.x, top: entry.y}; box.setPointerCapture(event.pointerId); box.focus();
  });
  box.addEventListener('pointermove', event => {
    if (!drag) return;
    entry.x = drag.left + (event.clientX - drag.x) / $('video-shell').clientWidth;
    entry.y = drag.top + (event.clientY - drag.y) / $('video-shell').clientHeight;
    positionOverlay(entry, true);
  });
  const endDrag = () => {if (!drag) return; drag = null; saveOverlay(entry);};
  box.addEventListener('pointerup', endDrag); box.addEventListener('pointercancel', endDrag); box.addEventListener('lostpointercapture', endDrag);
  box.addEventListener('keydown', event => {
    const shifts = {ArrowLeft: [-.02, 0], ArrowRight: [.02, 0], ArrowUp: [0, -.02], ArrowDown: [0, .02]};
    if (!shifts[event.key]) return;
    event.preventDefault(); event.stopPropagation(); moveOverlay(entry, ...shifts[event.key]);
  });
  player.addEventListener('loadedmetadata', () => syncPlayback(true));
  player.addEventListener('seeked', () => syncPlayback());
  player.addEventListener('error', () => {entry.failed = true; label.textContent = 'Teacher video unavailable';});
}
function rebuildPreview() {
  const key = previewSignature();
  if (key === previewKey) return;
  for (const entry of previewOverlays) {entry.video.pause(); entry.box.remove(); entry.tools.remove();}
  if (previewTail) {previewTail.video.pause(); previewTail.box.remove(); previewTail = null;}
  previewOverlays = []; previewKey = key; $('preview-controls').replaceChildren();
  if (!key) return;
  let index = 0;
  for (const item of [...submission().feedback].sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)))) {
    for (const clip of item.clips.slice(-1)) makeTeacherOverlay(item, clip, index++);
  }
  const correction = submission().correction;
  if (correction?.asset_id) {
    const box = element('div', 'preview-tail'), player = element('video');
    box.hidden = true; player.src = storage.mediaUrl(correction.asset_id);
    player.playsInline = true; player.muted = true; player.preload = 'auto';
    box.append(player); $('video-shell').append(box);
    previewTail = {box, video: player, clip: correction, tools: element('div'), label: element('span')};
    player.addEventListener('loadedmetadata', () => syncStudentPreview(true));
    player.addEventListener('seeked', () => syncPlayback());
    player.addEventListener('error', () => {if (previewTail?.video === player) {previewTail.failed = true; notify('The final correction could not play.', true);}});
  }
}
function syncPlayback(force = false) {
  if (!studentPreviewOn()) return;
  if (!rebindPreview()) {previewKey = ''; rebuildPreview(); if (!rebindPreview()) return;}
  const timeline = previewTimeline();
  const current = previewPlayback?.time ?? (video.currentTime || 0);
  const section = timeline ? previewSectionAt(timeline, current) : null;
  const timestamp = $('feedback-timestamp'), stamp = section && !section.tail ? feedbackTimestamp(section.item) : '';
  if (timestamp.textContent !== stamp) timestamp.textContent = stamp;
  timestamp.hidden = !stamp;
  const activeItem = latestPreviewItem(current, timeline);
  const activeEntry = activeItem?.tail ? previewTail : activeItem?.item.clips?.length ? previewOverlays.find(entry => entry.item === activeItem.item) : null;
  for (const entry of [...previewOverlays, ...(previewTail ? [previewTail] : [])]) {
    const active = activeEntry === entry;
    entry.box.hidden = !active; entry.tools.hidden = !active;
    if (!active) {entry.video.pause(); continue;}
    positionOverlay(entry);
    if (!Number.isFinite(entry.video.duration) || entry.video.duration <= 0 || entry.failed) continue;
    const elapsed = current - activeItem.start;
    const trimStart = browserStorage ? Number(assets.get(entry.clip.asset_id)?.trim_start) || 0 : 0;
    const target = trimStart + clamp(elapsed, 0, Math.max(0, clipDuration(entry) - .001));
    if (!entry.video.seeking && (force || Math.abs(entry.video.currentTime - target) > .08)) entry.video.currentTime = target;
    try {entry.video.playbackRate = video.playbackRate;} catch {}
    const shouldPlay = (previewPlayback?.playing ?? !video.paused) && !previewWaiting && elapsed < clipDuration(entry);
    if (!shouldPlay) entry.video.pause();
    else if (entry.video.paused && !entry.pending) {
      entry.pending = true;
      entry.video.play().catch(() => {entry.failed = true; entry.label.textContent = 'Teacher playback unavailable';}).finally(() => {entry.pending = false;});
    }
  }
  const note = subtitleText(activeItem), caption = $('feedback-subtitle');
  if (caption.textContent !== note) caption.textContent = note;
  caption.hidden = !note;
  $('preview-controls').hidden = !previewOverlays.some(entry => !entry.tools.hidden);
}
function startPreviewLoop() {
  if (previewRaf) return;
  const tick = () => {
    if (!studentPreviewOn()) {previewRaf = 0; return;}
    if (previewPlayback) advancePreview(); else syncPlayback(false);
    previewRaf = requestAnimationFrame(tick);
  };
  previewRaf = requestAnimationFrame(tick);
}
function syncStudentPreview(force = false) {
  if (!studentPreviewOn()) {previewPlayback = null; destroyPreview(); updateTransport(); return;}
  rebuildPreview();
  const timeline = previewTimeline();
  if (!timeline) {previewPlayback = null; video.pause(); syncPlayback(force); updateTransport(); return;}
  if (!previewPlayback || previewPlayback.submissionId !== submission().id) {
    const playing = !video.paused;
    previewPlayback = {submissionId: submission().id, time: timeline.start, playing, wall: performance.now()};
    applyPreviewFrame(timeline);
  }
  if (previewPlayback.time > timeline.end) setPreviewTime(timeline.end, timeline);
  syncPlayback(force); startPreviewLoop(); updateTransport();
}
function renderBindings() {
  $('pad-labels').value = state.session.pad_labels || 'positions'; $('countdown-setting').value = String(state.session.countdown ?? 3);
  $('pad-bindings').replaceChildren();
  for (const [key, label] of Object.entries(padNames)) {
    const row = element('div', 'binding-row'); const index = state.session.gamepad?.[key] ?? DEFAULT_PAD[key];
    row.append(element('span', '', label), button(bindCapture === key ? 'Press controller button…' : `Button ${index} · remap`, () => {bindCapture = key; renderBindings(); notify('Press the controller button to use for ' + label.toLowerCase());})); $('pad-bindings').append(row);
  }
  $('shortcut-bindings').replaceChildren();
  for (const [key, defaultValue] of Object.entries(DEFAULT_KEYS)) {
    const row = element('label', 'binding-row', key.replace(/[A-Z]/g, letter => ' ' + letter.toLowerCase()));
    const input = element('input'); input.maxLength = 1; input.value = state.session.shortcuts?.[key] || defaultValue; input.setAttribute('aria-label', `Shortcut for ${key}`);
    input.addEventListener('change', () => {
      const value = input.value.toLowerCase(); const others = {...DEFAULT_KEYS, ...state.session.shortcuts};
      if (!/^[a-z]$/.test(value) || Object.entries(others).some(([name, shortcut]) => name !== key && shortcut === value)) {notify('Choose a unique letter shortcut.', true); input.value = others[key]; return;}
      state.session.shortcuts ||= {}; state.session.shortcuts[key] = value; dirty(); applyShortcutLabels(); updateHint(); syncCorrectionControl();
    }); row.append(input); $('shortcut-bindings').append(row);
  }
}
function openControls() {renderBindings(); openDialog('controller-dialog');}
function padDispatch(command, argument) {
  if (busy || !state) return;
  if (evaluatedFolderSelected() && !['confirm', 'back', 'navigate', 'seek'].includes(command)) return;
  if (command === 'back') {
    if (currentDialog() === $('recorder-dialog')) cancelRecorder(); else if (currentDialog()) closeDialog(); else hideFeedback(); return;
  }
  if (command === 'menu') {if (['recording', 'countdown'].includes(rec.phase)) return notify('Finish recording before checking the server.'); openServer(); return;}
  const modal = currentDialog();
  if (command === 'confirm') {
    if (modal === $('recorder-dialog')) {
      if (rec.phase === 'recording') stopRecording(); else if (rec.phase === 'countdown') return;
      else if (document.activeElement?.tagName === 'BUTTON' && modal.contains(document.activeElement)) document.activeElement.click();
      return;
    }
    if (modal) {const active = document.activeElement; if (active?.tagName === 'BUTTON' && modal.contains(active)) active.click(); else modal.querySelector('button:not([disabled])')?.focus();}
    else if (padFocused && document.activeElement?.tagName === 'BUTTON' && document.activeElement.getClientRects().length) {document.activeElement.click(); padFocused = false;}
    else playPause(); return;
  }
  if (command === 'navigate') {navigateController(argument); return;}
  if (modal) return;
  if (command === 'feedback') {addFeedback(); showFeedback(); $('editor-record').focus();}
  if (command === 'library') openLibrary(false, 'section');
  // Mark range controller shortcuts temporarily disabled.
  // if (command === 'markIn') mark('in');
  // if (command === 'markOut') mark('out');
  if (command === 'seek') seek(position() + argument);
}
function navigateController({vertical, horizontal}) {
  const modal = currentDialog();
  if (!modal && horizontal) {seek(position() + horizontal * .1); return;}
  const scope = modal || document.querySelector('.workspace');
  const active = document.activeElement;
  if (modal && horizontal && active?.matches('input[type=range]')) {const step = Number(active.step) || .1; active.value = Math.max(Number(active.min), Math.min(Number(active.max), Number(active.value) + horizontal * step)); active.dispatchEvent(new Event('input', {bubbles: true})); return;}
  if (modal && horizontal && active?.tagName === 'SELECT') {active.selectedIndex = Math.max(0, Math.min(active.options.length - 1, active.selectedIndex + horizontal)); active.dispatchEvent(new Event('change', {bubbles: true})); return;}
  const targets = [...scope.querySelectorAll('button:not([disabled]), input[type=range], select')].filter(node => node.getClientRects().length && !node.closest('[hidden]'));
  if (!targets.length) return; const index = targets.indexOf(active); const direction = vertical || horizontal || 1;
  targets[(index + direction + targets.length) % targets.length].focus();
  padFocused = true;
}
function bindClick(id, callback) {$(id).addEventListener('click', callback);}
async function openServer() {
  if (browserStorage) {
    const status = await storage.status();
    $('server-heading').textContent = 'Storage';
    $('server-address').textContent = status.folder ? `Video folder: ${status.folder} (${status.folderAccess}) · Reusable library: ${status.library || 'not selected'} (${status.libraryAccess})` : 'Choose a video folder to begin.';
    $('server-status').textContent = status.ok ? 'Folder access is available.' : 'Folder access needs to be connected.';
    $('storage-reconnect').hidden = false;
    $('storage-library').hidden = false;
    $('browser-limits').hidden = false;
    openDialog('server-dialog');
    return;
  }
  $('server-address').textContent = location.origin;
  $('server-status').textContent = 'Checking connection…';
  openDialog('server-dialog');
  try {
    const health = await storage.status();
    $('server-status').textContent = health.ok ? 'Server is running.' : 'Server is unavailable.';
  } catch {
    $('server-status').textContent = 'Could not connect to the server.';
  }
}

async function setupBrowserLibrary() {
  if (!browserStorage) return;
  try {
    await saveNow();
    renderTask?.controller.abort();
    const data = await storage.chooseLibrary();
    applyWorkspace(data);
    notify('Reusable library folder connected.');
  } catch (error) {if (error.name !== 'AbortError') notify(error.message, true);}
}

async function boot() {
  try {
    if (browserStorage) {
      $('server').textContent = 'Storage';
      $('library-setup').hidden = false;
      $('library-cleanup').disabled = true;
      $('library-cleanup').title = 'Cleanup requires the local Python server.';
      $('delete-library').disabled = true;
      $('delete-library').title = 'Physical library deletion requires the local Python server.';
      $('library-help').textContent = 'Reviews and recordings stay on this computer. Cleanup and physical deletion require the local Python server.';
    }
    let data = await readWorkspace(); state = data.state; revision = data.revision; capabilities = data.capabilities;
    if (browserStorage) {
      $('reconnect-folder').hidden = !(storage.folders.root && !storage.folders.folder);
      $('download-draft').hidden = !storage.pendingDraft;
    }
    restoreWindowView();
    assets = new Map(data.assets.map(asset => [asset.id, asset]));
    if (state.session.source_folder) {
      try {
        data = await storage.openFolder(state.session.source_folder, state.session.assignment_id, revision);
        state = data.state; revision = data.revision;
        assets = new Map(data.assets.map(asset => [asset.id, asset])); restoreWindowView();
      } catch (error) {console.error('Could not refresh folder on reload:', error);}
    }
    updateFolderPaths(data);
    state.session.gamepad ||= {}; state.session.shortcuts ||= {};
    if (!currentAssignment()) state.session.assignment_id = state.assignments[0]?.id || null;
    if (!submission()) state.session.submission_id = submissions()[0]?.id || null;
    render(); viewChanged(); scheduleEvaluatedRefresh(); scheduleSourceRefresh(); $('save-state').textContent = 'Saved locally';
    // Optional standard controller support. Actual hardware is validated by the instructor.
    new GamepadInput({dispatch: padDispatch, bindings: () => state.session.gamepad, modal: () => !!currentDialog(), capture: fresh => {
      if (!bindCapture) return false; const index = fresh.findIndex(Boolean);
      if (index >= 0) {const prior = state.session.gamepad[bindCapture] ?? DEFAULT_PAD[bindCapture]; const occupied = Object.keys(DEFAULT_PAD).find(key => key !== bindCapture && (state.session.gamepad[key] ?? DEFAULT_PAD[key]) === index); if (occupied) state.session.gamepad[occupied] = prior; state.session.gamepad[bindCapture] = index; bindCapture = null; dirty(); renderBindings(); notify('Controller mapping saved.');} return true;
    }, status: (pad, disconnected) => {
      detectedPad = pad; $('controller-status').textContent = pad ? 'Controller connected' : 'Setup';
      $('pad-detail').textContent = pad ? `${pad.id} · ${pad.mapping || 'Device-specific mapping'} · last input shown below` : 'Connect your controller, then press a button with this app focused.';
      if (disconnected) {pausePreview(); correctionVideo.pause(); notify('Controller disconnected. Your place is saved; keyboard controls remain available.', true);} updateHint();
    }});
  } catch (error) {$('save-state').textContent = 'Connection failed'; notify(error.message + (browserStorage ? ' Reconnect the folder and retry.' : ' Start app.py and reload this page.'), true); if (browserStorage) $('reconnect-folder').hidden = false;}
}

dialogs.forEach(dialog => {dialog.querySelectorAll('[data-close]').forEach(node => node.addEventListener('click', () => closeDialog(dialog))); dialog.addEventListener('close', updateHint); dialog.addEventListener('cancel', event => {if (busy) {event.preventDefault(); return;} if (dialog === $('recorder-dialog')) {event.preventDefault(); cancelRecorder();}});});
bindClick('play', playPause); bindClick('back', () => stepVideo(-.1)); bindClick('forward', () => stepVideo(.1));
$('seek').addEventListener('input', event => {
  if (studentPreviewOn() && previewPlayback) setPreviewTime(Number(event.target.value));
  else seek(Number(event.target.value));
});
video.addEventListener('loadedmetadata', () => {applyVideoAspect(); video.currentTime = Math.min(submission()?.position || 0, activeDuration()); if (state.session.marked_in !== undefined) {markedIn = state.session.marked_in; markedOut = state.session.marked_out;} updateTransport(); syncStudentPreview(true);});
video.addEventListener('play', () => {updateTransport(); syncStudentPreview(true);}); video.addEventListener('pause', () => {updateTransport(); syncStudentPreview(true); if (submission() && selectedAsset === submission().asset_id && video.readyState >= 2) rememberPosition();});
video.addEventListener('seeked', () => {
  if (studentPreviewOn() && previewPlayback && !previewSeeking) {
    const timeline = previewTimeline();
    if (timeline) setPreviewTime(previewOutputTime(timeline, video.currentTime, previewPlayback.time), timeline);
  }
  previewSeeking = false;
  syncStudentPreview(true);
});
video.addEventListener('ratechange', () => syncStudentPreview(true));
video.addEventListener('ended', () => syncStudentPreview(true));
video.addEventListener('waiting', () => {previewWaiting = true; syncStudentPreview();});
video.addEventListener('playing', () => {previewWaiting = false; syncStudentPreview(true);});
bindClick('cancel-render', () => {renderTask?.controller.abort(); notify('Export rendering cancelled.');});
video.addEventListener('timeupdate', () => {
  const item = feedback(); if (!studentPreviewOn() && looping && item && item.end > item.start && video.currentTime >= item.end) video.currentTime = item.start;
  updateTransport(); if (submission() && selectedAsset === submission().asset_id && video.readyState >= 2 && Date.now() - lastPositionSave > 5000) {rememberPosition(); lastPositionSave = Date.now();}
});
video.addEventListener('error', async () => {
  const assetId = selectedAsset, asset = assets.get(assetId);
  if (!asset || !video.error || video.error.code === 1) return;
  const reason = `Browser playback error ${video.error.code}: ${video.error.message || 'Video could not play.'}`;
  const message = `Failed to load ${asset.name}. Its original is preserved.`;
  notify(message, true);
  if (evaluatedFolderSelected() || browserStorage) return;
  try {
    const result = await storage.reportPlaybackError(assetId, reason);
    if (result.log_error) notify(`${message} ${result.log_error}`, true);
  } catch (error) {notify(`${message} Could not save the error log: ${error.message}`, true);}
});
correctionVideo.addEventListener('timeupdate', () => {
  if (!browserStorage || !showingCorrection) return;
  const end = Number(assets.get(submission()?.correction?.asset_id)?.trim_end);
  if (end && correctionVideo.currentTime >= end) correctionVideo.pause();
});
$('clip-video').addEventListener('timeupdate', () => {
  if (!browserStorage) return;
  const end = Number(assets.get($('clip-video').dataset.asset)?.trim_end);
  if (end && $('clip-video').currentTime >= end) $('clip-video').pause();
});
bindClick('loop', () => {if (!feedback() || feedback().end <= feedback().start) return notify('Select a marked range before looping.'); looping = !looping; if (looping) seek(feedback().start); updateTransport();});
bindClick('fullscreen', () => {if (document.fullscreenElement) document.exitFullscreen(); else $('video-shell').requestFullscreen().catch(error => notify(error.message, true));});
bindClick('track-motion', startTracking); bindClick('view-tracking', () => viewTracking(false)); bindClick('view-points', () => viewTracking(true));
$('tracking-video').addEventListener('error', () => {if ($('tracking-dialog').open && $('tracking-video').getAttribute('src')) notify('The tracking video could not play.', true);});
correctionVideo.addEventListener('error', () => {if (showingCorrection && correctionVideo.getAttribute('src')) notify('This correction could not play.', true);});
correctionVideo.addEventListener('play', () => updateTransport());
correctionVideo.addEventListener('pause', () => updateTransport());
correctionVideo.addEventListener('timeupdate', () => {if (showingCorrection) updateTransport();});
correctionVideo.addEventListener('loadedmetadata', () => {if (showingCorrection) updateTransport();});
correctionVideo.addEventListener('ended', () => hideCorrection());
$('speed').addEventListener('change', event => {
  const rate = Number(event.target.value);
  video.playbackRate = rate;
  correctionVideo.playbackRate = rate;
});
// Mark range buttons temporarily disabled.
// bindClick('mark-in', () => mark('in')); bindClick('mark-out', () => mark('out'));
bindClick('add-feedback', addFeedback);
bindClick('previous-student', () => nextStudent(-1)); bindClick('next-student', () => nextStudent(1));
bindClick('empty-import', () => browserStorage ? browseForVideo() : $('video-import').click());
bindClick('video-folders', browseForVideo);
$('video-import').addEventListener('change', event => {if (event.target.files.length) importSubmissions(event.target.files); event.target.value = '';});
bindClick('close-feedback', hideFeedback);
for (const [id, key] of [['feedback-note', 'note'], ['private-note', 'private_note']]) {
  $(id).addEventListener('focus', () => {if (state) remember();});
  $(id).addEventListener('input', event => {if (!feedback()) return; feedback()[key] = event.target.value; touch(); dirty(); renderProgress(); renderSections(); renderPlayer();});
}
$('record-note').addEventListener('input', syncRecordSubtitle);
for (const id of ['feedback-start', 'feedback-end']) $(id).addEventListener('change', () => {if (!feedback()) return; const start = Number($('feedback-start').value), end = Number($('feedback-end').value); if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > activeDuration()) {notify('Choose a range within the student video.', true); renderEditor(); return;} remember(); Object.assign(feedback(), {start, end}); touch(); dirty(); renderSections(); updateTransport();});
bindClick('remove-feedback', () => {if (!feedback() || !confirm('Remove this feedback item? Library clips stay available.')) return; remember(); submission().feedback = submission().feedback.filter(item => item.id !== feedback().id); state.session.feedback_id = submission().feedback[0]?.id || null; touch(); dirty(); render();});
bindClick('editor-record', () => openRecorder('section'));
bindClick('editor-library', () => openLibrary(true, 'section'));
$('library-search').addEventListener('input', renderLibrary);
$('library-tabs').addEventListener('click', event => {
  const tag = event.target.closest('[data-tag]');
  const view = event.target.closest('[data-filter]');
  if (tag && $('library-tabs').contains(tag)) {const key = tag.dataset.tag; if (libraryTags.has(key)) libraryTags.delete(key); else libraryTags.add(key); renderLibrary(); return;}
  if (view && $('library-tabs').contains(view)) {libraryFilter = view.dataset.filter; renderLibrary();}
});
document.querySelectorAll('[data-library-view]').forEach(node => node.addEventListener('click', () => {
  libraryView = node.dataset.libraryView;
  try {localStorage.setItem(libraryViewKey, libraryView);} catch {}
  renderLibrary();
}));
bindClick('library-cleanup', openCleanup);
bindClick('library-setup', setupBrowserLibrary);
bindClick('reconnect-folder', async () => {
  try {const data = await storage.reconnect(); applyWorkspace(data); $('reconnect-folder').hidden = true;}
  catch (error) {notify(error.message, true);}
});
bindClick('storage-reconnect', async () => {closeDialog($('server-dialog')); $('reconnect-folder').click();});
bindClick('storage-library', async () => {closeDialog($('server-dialog')); await setupBrowserLibrary();});
bindClick('download-draft', () => {
  const draft = storage.pendingDraft;
  if (!draft) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(draft.document, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'still-unsaved-draft.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});
bindClick('cleanup-confirm', cleanSelectedReviews);
bindClick('library-import', () => beginReferenceImport());
$('reference-import').addEventListener('change', event => {if (event.target.files[0]) importReference(event.target.files[0]); event.target.value = '';});
bindClick('clip-attach', () => {if (attachLibraryEntry($('clip-video').dataset.asset, $('clip-title').textContent, previewEntry)) {closeDialog($('clip-dialog')); closeDialog($('library-dialog'));}});
bindClick('clip-edit', () => editLibrary(previewEntry));
$('library-form').addEventListener('submit', event => {
  event.preventDefault(); const title = $('library-title').value.trim(); if (!title) return;
  const tags = chosenLibraryTags();
  if (tags.length > 100 || tags.some(tag => tag.length > 200)) {notify('Use up to 100 tags, each 200 characters or fewer.', true); return;}
  remember(); const values = {title, tags, aliases: $('library-aliases').value.split(',').map(value => value.trim()).filter(Boolean), description: $('library-description').value, favorite: $('library-favorite').checked, inbox: false};
  let entry;
  if (editEntryId) {entry = state.library.find(item => item.id === editEntryId); Object.assign(entry, values);}
  else if (newEntryAsset) {
    entry = {id: uid(), asset_id: newEntryAsset, ...values, category: 'General feedback', archived: false, version: 1, used_at: 0}; state.library.push(entry);
    const clip = submission()?.feedback.flatMap(item => item.clips).find(row => row.id === libraryClipId);
    if (clip) {clip.library_id = entry.id; entry.used_at = now();}
  }
  dirty(); closeDialog($('library-edit-dialog')); renderLibrary(); renderEditor(); notify('Clip details saved to the shelf.');
  if (event.submitter?.id === 'library-save-add' && entry && attachLibraryEntry(entry.asset_id, entry.title, entry.id)) closeDialog($('library-dialog'));
});
bindClick('archive-library', () => {const entry = state.library.find(item => item.id === editEntryId); if (!entry) return; remember(); entry.archived = !entry.archived; dirty(); closeDialog($('library-edit-dialog')); closeDialog($('clip-dialog')); renderLibrary(); notify(entry.archived ? 'Clip archived. Existing student feedback remains playable.' : 'Clip restored.');});
bindClick('replace-library-video', () => beginReferenceImport(editEntryId));
bindClick('delete-library', () => deleteLibraryClip(editEntryId));
bindClick('record-start', startCountdown); bindClick('record-stop', stopRecording); bindClick('record-cancel', cancelRecorder); bindClick('recorder-close', cancelRecorder); bindClick('record-use', useRecording);
bindClick('record-retake', () => {resetRecording(); prepareCamera();}); $('microphone').addEventListener('change', prepareCamera);
$('mirror-preview').addEventListener('change', event => {$('camera-video').style.transform = event.target.checked ? 'scaleX(-1)' : '';});
$('trim-start').addEventListener('input', () => {updateTrim(); $('recorded-video').currentTime = Number($('trim-start').value);}); $('trim-end').addEventListener('input', updateTrim);
bindClick('play-trim', () => {$('recorded-video').currentTime = Number($('trim-start').value); $('recorded-video').play().catch(error => notify(error.message, true));});
$('recorded-video').addEventListener('timeupdate', () => {if ($('recorded-video').currentTime >= Number($('trim-end').value)) $('recorded-video').pause();});
$('recorded-video').addEventListener('playing', () => {
  if (rec.phase !== 'preview') return;
  rec.previewed = true; updateTrim();
  $('recorder-message').textContent = previewReadyMessage();
});
$('recorded-video').addEventListener('loadedmetadata', () => {if (Number.isFinite($('recorded-video').duration)) {$('trim-start').max = $('trim-end').max = $('recorded-video').duration; $('trim-end').value = $('recorded-video').duration; updateTrim();}});
bindClick('export', exportFeedback);
$('student-preview').addEventListener('change', () => syncStudentPreview(true));
bindClick('server', openServer); bindClick('controller-status', openControls);

$('pad-labels').addEventListener('change', event => {state.session.pad_labels = event.target.value; dirty(); updateHint();});
$('countdown-setting').addEventListener('change', event => {state.session.countdown = Number(event.target.value); dirty();});
bindClick('reset-pad', () => {state.session.gamepad = {}; state.session.shortcuts = {}; bindCapture = null; dirty(); renderBindings();});
document.addEventListener('keydown', event => {
  if (busy || !state || event.target.closest('.teacher-overlay')) return;
  const typing = event.target.closest('input, textarea, select, [contenteditable=true]');
  if (typing && event.target.id !== 'seek' && !(event.target.id === 'student-preview' && event.key.startsWith('Arrow'))) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {event.preventDefault(); if (!evaluatedFolderSelected()) undo(); return;}
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const modal = currentDialog(); if (modal) {
    if (event.key.startsWith('Arrow')) {event.preventDefault(); navigateController({vertical: event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0, horizontal: event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0});}
    if (event.key === 'Escape' && modal === $('recorder-dialog')) {event.preventDefault(); cancelRecorder();} return;
  }
  if (event.key === 'Escape' && showingCorrection) {event.preventDefault(); hideCorrection(); return;}
  if (event.key === ' ' && event.target.closest('button')) return;
  const keys = {...DEFAULT_KEYS, ...state.session.shortcuts}, key = event.key.toLowerCase();
  if (evaluatedFolderSelected()) {
    const playback = {'[': () => nextStudent(-1), ']': () => nextStudent(1), ' ': playPause, arrowleft: () => stepVideo(-(event.shiftKey ? 1 : .1)), arrowright: () => stepVideo(event.shiftKey ? 1 : .1), [keys.browseVideos]: browseForVideo};
    if (playback[key]) {event.preventDefault(); if (!event.repeat || ['arrowleft', 'arrowright'].includes(key)) playback[key]();}
    return;
  }
  const handlers = {'[': () => nextStudent(-1), ']': () => nextStudent(1), ' ': playPause, arrowleft: () => stepVideo(-(event.shiftKey ? 1 : .1)), arrowright: () => stepVideo(event.shiftKey ? 1 : .1), /* [keys.markIn]: () => mark('in'), [keys.markOut]: () => mark('out'), */ [keys.feedback]: addFeedback, [keys.record]: () => openRecorder('section'), [keys.library]: () => openLibrary(true, 'section'), [keys.previous]: () => nextFeedback(-1), [keys.next]: () => nextFeedback(1), [keys.browseVideos]: browseForVideo, [keys.exportFeedback]: exportFeedback};
  if (handlers[key]) {event.preventDefault(); if (!event.repeat || ['arrowleft', 'arrowright'].includes(key)) handlers[key]();}
});
window.addEventListener('blur', () => {pausePreview(); correctionVideo.pause();});
window.addEventListener('focus', () => {if (evaluatedFolderSelected()) refreshEvaluatedFolder(); else {refreshExportIndicators(); refreshSourceFolder();}});
window.addEventListener('resize', () => requestAnimationFrame(fitSofa));
document.addEventListener('fullscreenchange', () => requestAnimationFrame(fitSofa));

document.addEventListener('visibilitychange', () => {if (document.hidden) {pausePreview(); correctionVideo.pause();} else if (evaluatedFolderSelected()) refreshEvaluatedFolder(); else refreshSourceFolder();});
window.addEventListener('beforeunload', event => {if (renderTask || exportJobs.size || savedCount < editCount || rec.blob || ['recording', 'countdown'].includes(rec.phase)) {event.preventDefault(); event.returnValue = '';}});
boot();

new ResizeObserver(() => previewOverlays.forEach(entry => positionOverlay(entry))).observe($('video-shell'));
window.addEventListener('pagehide', () => {renderTask?.controller.abort(); pausePreview(); destroyPreview();});
