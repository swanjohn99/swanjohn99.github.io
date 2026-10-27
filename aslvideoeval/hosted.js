import {clock, makeFeedback, feedbackTimestamp, studentPreviewTimeline, previewSectionAt, previewStudentTime, canExport, searchClips} from './core.js';
import {videoComposition} from './video-composition.js';
import {renderVideo} from './video-renderer.js';
import {LocalFolders, newId} from './hosted-files.js';

const $ = id => document.getElementById(id);
const folders = new LocalFolders();
let catalog = {revision: 0, library: [], assets: []};
let selected = null, selectedFeedback = null, evaluated = false, urls = new Map(), saveTimer;
let editCount = 0, savedCount = 0, saving = null, opening = 0, exporting = null;
let pendingDraft = null;
let stream = null, recorder = null, takeBlob = null, recordTarget = 'section', libraryTarget = 'section', libraryFile = null, libraryAsset = null, libraryEditId = null;
let recordStarted = 0, recordElapsed = 0;
let replacementEntryId = null;
let preview = {playing: false, time: 0, wall: 0, raf: 0};
let changingVideo = false;
let windowView = (() => {try {return JSON.parse(sessionStorage.getItem('still-hosted-window') || '{}');} catch {return {};}})();
const windowKey = () => folders.root?.name + '/' + folders.path.join('/');
function rememberView() {try {sessionStorage.setItem('still-hosted-window', JSON.stringify(windowView));} catch {}}
const allowed = /\.(mp4|m4v|mov|webm|mkv)$/i;
const token = () => newId().replaceAll('-', '');
const review = () => folders.document?.reviews.find(item => item.id === selected);
const clipAsset = id => folders.document?.assets.find(item => item.id === id) || catalog.assets.find(item => item.id === id);
const entryFor = id => catalog.library.find(item => item.id === id);
const effectiveDuration = asset => Math.max(0, (asset?.trim_end || asset?.duration || 0) - (asset?.trim_start || 0));
const localAsset = id => folders.document?.assets.find(item => item.id === id);
const toast = (message, error = false) => {const box = $('toast'); box.textContent = message; box.classList.toggle('error', error); box.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => box.hidden = true, error ? 9000 : 4500);};
const displayName = filename => filename.replace(/\.[^.]+$/, '');
async function loadCatalog() {
  await folders.restoreLibrary();
  try {catalog = await folders.readLibraryCatalog();}
  catch (error) {
    if (!['NotAllowedError', 'SecurityError'].includes(error.name)) throw error;
    catalog = {schema_version: 1, revision: 0, library: [], assets: []};
  }
  renderLibrary();
}
async function saveCatalog() {
  catalog = await folders.saveLibraryCatalog(catalog);
  renderLibrary();
}
function releaseUrls() {for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear();}
async function mediaUrl(asset) {
  if (asset?.kind === 'student' || asset?.kind === 'private' || asset?.filename) {
    if (!urls.has(asset.id)) urls.set(asset.id, URL.createObjectURL(asset.kind === 'student' || asset.kind === 'private' ? await folders.fileFor(asset) : await folders.libraryFileFor(asset)));
    return urls.get(asset.id);
  }
  throw new Error('The attached recording is unavailable.');
}
function ensureStudentAsset(item) {
  item.asset_id ||= token();
  let asset = localAsset(item.asset_id);
  if (!asset) {
    asset = {id: item.asset_id, kind: 'student', filename: item.filename, duration: 0, width: 0, height: 0};
    folders.document.assets.push(asset);
  }
  return asset;
}
async function probe(file) {
  const url = URL.createObjectURL(file), player = document.createElement('video');
  player.preload = 'metadata'; player.src = url;
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Video metadata timed out.')), 10000);
      player.onloadedmetadata = () => {clearTimeout(timeout); resolve({duration: player.duration, width: player.videoWidth, height: player.videoHeight});};
      player.onerror = () => {clearTimeout(timeout); reject(new Error('This browser cannot play this source codec. Keep the original file and convert a copy before review.'));};
    });
  } finally {player.removeAttribute('src'); player.load(); URL.revokeObjectURL(url);}
}
async function thumbnail(file) {
  const url = URL.createObjectURL(file), player = document.createElement('video');
  player.muted = true; player.preload = 'auto'; player.src = url;
  try {
    await new Promise((resolve, reject) => {player.onloadeddata = resolve; player.onerror = () => reject(new Error('Thumbnail unavailable.'));});
    if (player.duration > 1) {
      player.currentTime = Math.min(1, player.duration / 3);
      await new Promise(resolve => {player.onseeked = resolve; setTimeout(resolve, 1500);});
    }
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    canvas.getContext('2d').drawImage(player, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .7);
  } finally {player.removeAttribute('src'); player.load(); URL.revokeObjectURL(url);}
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (saving) {await saving; if (savedCount < editCount) return saveNow(); return;}
  if (savedCount >= editCount || evaluated || !folders.document) return;
  const count = editCount;
  saving = folders.save().then(() => {savedCount = count; pendingDraft = null; $('download-draft').hidden = true; $('save-state').textContent = savedCount === editCount ? 'Saved in folder' : 'Saving…';})
    .catch(error => {$('save-state').textContent = 'Unsaved edits · retry'; toast(error.message, true); throw error;})
    .finally(() => {saving = null;});
  await saving;
  if (savedCount < editCount) return saveNow();
}
function dirty() {
  editCount++; $('save-state').textContent = 'Saving…';
  clearTimeout(saveTimer); saveTimer = setTimeout(() => saveNow().catch(() => {}), 500);
  renderFeedback(); if ($('preview').checked) renderPreviewFrame();
}
async function openFolder(path = [], descend = false) {
  await saveNow();
  const order = ++opening;
  pausePreview(); releaseUrls(); selected = null; selectedFeedback = null;
  const result = await folders.open(path, descend);
  if (order !== opening) return;
  await loadCatalog().catch(showError);
  evaluated = result.evaluated;
  $('back-review').hidden = !evaluated; $('evaluated').hidden = evaluated;
  $('preview').checked = false; $('preview').disabled = evaluated;
  if (!evaluated) {
    let changed = result.document.reviews.some(row => !row.asset_id);
    for (const item of result.document.reviews) {
      const asset = ensureStudentAsset(item);
      if (!asset.duration || !asset.width || !asset.height) {
        try {Object.assign(asset, await probe(await folders.fileFor(asset))); changed = true;}
        catch (error) {asset.error = error.message;}
      }
    }
    if (changed || result.document.revision === 0) {editCount++; await saveNow();}
    const draft = await folders.recoveryDraft();
    if (draft && draft.revision === folders.revision && confirm('Recover unsaved edits from this browser?')) {
      await folders.acceptDraft(draft); editCount++; await saveNow();
    } else if (draft) {
      pendingDraft = draft; $('download-draft').hidden = false;
      if (draft.revision !== folders.revision) toast('An unsaved browser draft conflicts with the folder file. Download the draft to review its notes; the folder file was not changed.', true);
    } else {pendingDraft = null; $('download-draft').hidden = true;}
  }
  const preference = windowView[windowKey()];
  const rows = evaluated ? [...result.files.keys()] : result.document.reviews.map(row => row.id);
  const initialSelected = rows.includes(preference?.selected) ? preference.selected : rows[0] || null;
  selected = null;
  await renderFolders(); await selectReview(initialSelected);
  $('save-state').textContent = evaluated ? 'Read-only exports' : 'Saved in folder';
  $('reconnect').hidden = true;
}
async function renderFolders() {
  const root = folders.root;
  $('breadcrumbs').replaceChildren(); $('branches').replaceChildren();
  if (!root) return;
  const rootButton = document.createElement('button'); rootButton.textContent = root.name; rootButton.onclick = () => openFolder([]).catch(showError); $('breadcrumbs').append(rootButton);
  for (let i = 0; i < folders.path.length; i++) {
    $('breadcrumbs').append(document.createTextNode('/'));
    const button = document.createElement('button'); button.textContent = folders.path[i];
    const target = folders.path.slice(0, i + 1);
    button.onclick = () => openFolder(target).catch(showError); $('breadcrumbs').append(button);
    const siblings = await folders.children(folders.path.slice(0, i));
    if (siblings.length > 1) {
      const select = document.createElement('select'); select.setAttribute('aria-label', 'Choose folder level ' + (i + 1));
      for (const sibling of siblings) {
        const option = document.createElement('option'); option.value = sibling.name; option.textContent = sibling.name;
        select.append(option);
      }
      select.value = folders.path[i]; select.onchange = () => openFolder([...folders.path.slice(0, i), select.value], true).catch(showError);
      $('branches').append(select);
    }
  }
  const children = await folders.children();
  if (!evaluated && children.some(child => child.name.toLowerCase() !== 'evaluated')) {
    const select = document.createElement('select'); select.setAttribute('aria-label', 'Open subfolder');
    const placeholder = document.createElement('option'); placeholder.textContent = 'Open a subfolder…'; placeholder.value = ''; select.append(placeholder);
    for (const child of children.filter(row => row.name.toLowerCase() !== 'evaluated')) {
      const option = document.createElement('option'); option.value = child.name; option.textContent = child.name; select.append(option);
    }
    select.onchange = () => openFolder([...folders.path, select.value], true).catch(showError);
    $('branches').append(select);
  }
  $('evaluated').disabled = !children.some(child => child.name.toLowerCase() === 'evaluated');
  $('videos').replaceChildren();
  const rows = evaluated ? [...folders.files.keys()].map(filename => ({id: filename, filename})) : folders.document.reviews;
  rows.sort((a, b) => a.filename.localeCompare(b.filename, undefined, {numeric: true, sensitivity: 'base'}));
  for (const row of rows) {
    const button = document.createElement('button'); button.className = 'video-row'; button.textContent = `${displayName(row.filename)}${row.exports?.length ? ' · Exported' : ''}`;
    button.dataset.id = row.id; button.onclick = () => selectReview(row.id).catch(showError); $('videos').append(button);
    const handle = folders.files.get(row.filename);
    if (handle) handle.getFile().then(thumbnail).then(src => {
      if (!button.isConnected) return;
      const image = document.createElement('img'); image.src = src; image.alt = ''; button.prepend(image);
    }).catch(() => {});
  }
}
function showError(error) {toast(error.message || String(error), true); if (/permission|not found|disconnected/i.test(error.message || '')) $('reconnect').hidden = false;}
async function selectReview(id) {
  if (selected && folders.root && $('student').readyState >= 1) {
    const previous = windowView[windowKey()] ||= {};
    previous.positions ||= {}; previous.positions[selected] = $('student').currentTime;
  }
  changingVideo = true;
  selected = id; selectedFeedback = null; pausePreview(); $('preview').checked = false;
  windowView[windowKey()] = {...windowView[windowKey()], selected: id}; rememberView();
  const order = ++opening;
  $('videos').querySelectorAll('button').forEach(button => button.classList.toggle('active', button.dataset.id === id));
  const item = review(), filename = evaluated ? id : item?.filename;
  $('video-name').textContent = filename || 'No videos in this folder';
  $('review-status').textContent = evaluated ? 'Evaluated video · read only' : item?.status || '';
  $('feedback-list').hidden = evaluated; $('add-point').disabled = $('add-range').disabled = $('record-correction').disabled = $('attach-correction').disabled = !item || evaluated;
  $('export').disabled = !item || !canExport(item) || evaluated;
  $('correction-label').textContent = item?.correction?.asset_id ? 'Untimed correction attached' : '';
  $('save-correction-library').hidden = !localAsset(item?.correction?.asset_id);
  const player = $('student'); player.pause(); player.removeAttribute('src'); player.load();
  if (filename) {
    try {
      const asset = evaluated ? {id: filename, kind: 'student', filename} : ensureStudentAsset(item);
      if (asset.error) toast(asset.error, true);
      const file = evaluated ? await (await folders.files.get(filename)).getFile() : await folders.fileFor(asset);
      if (order !== opening) return;
      if (urls.has('student-player')) URL.revokeObjectURL(urls.get('student-player'));
      const url = URL.createObjectURL(file); urls.set('student-player', url);
      player.src = url; player.load();
      player.onloadedmetadata = () => {if (selected === id) player.currentTime = Math.min(windowView[windowKey()]?.positions?.[id] || 0, Math.max(0, player.duration - .1)); changingVideo = false;};
    } catch (error) {changingVideo = false; showError(error);}
  } else changingVideo = false;
  renderFeedback();
}
function renderFeedback() {
  const item = review(); $('feedback-list').replaceChildren();
  if (!item || evaluated) return;
  for (const feedback of [...(item.feedback || [])].sort((a, b) => a.start - b.start)) {
    const row = document.createElement('div'); row.className = 'feedback-row';
    const title = document.createElement('strong'); title.textContent = `${feedbackTimestamp(feedback)} · ${feedback.note || feedback.clips?.[0]?.title || 'Draft'}`;
    const edit = document.createElement('button'); edit.textContent = 'Edit'; edit.onclick = () => editFeedback(feedback.id);
    row.append(title, document.createElement('br'), edit); $('feedback-list').append(row);
  }
  $('export').disabled = !canExport(item) || !!exporting;
  $('review-status').textContent = item.status || 'Unreviewed';
  $('correction-label').textContent = item.correction?.asset_id ? 'Untimed correction attached' : '';
  $('save-correction-library').hidden = !localAsset(item.correction?.asset_id);
}
function editFeedback(id) {
  const feedback = review()?.feedback.find(row => row.id === id); if (!feedback) return;
  selectedFeedback = id; $('start').value = feedback.start; $('end').value = feedback.end;
  $('note').value = feedback.note || ''; $('private-note').value = feedback.private_note || '';
  $('attached').textContent = feedback.clips?.[0] ? `Attached: ${feedback.clips[0].title || 'Signed response'}` : 'No response recording attached.';
  $('save-private-library').hidden = !localAsset(feedback.clips?.[0]?.asset_id);
  $('feedback-dialog').showModal();
}
function currentFeedback() {return review()?.feedback.find(row => row.id === selectedFeedback);}
function updateFeedbackField(key, value) {const row = currentFeedback(); if (!row) return; row[key] = value; review().status = 'In progress'; dirty();}
function addFeedback(range) {
  const item = review(); if (!item) return;
  const at = Number($('student').currentTime) || 0;
  let start = at, end = at;
  if (range) {
    const raw = prompt('End of feedback range in seconds:', String(Math.min(at + 2, $('student').duration || at + 2)));
    if (raw === null) return;
    end = Number(raw);
    if (!Number.isFinite(end) || end < start) return toast('Enter an end time after the start.', true);
  }
  const row = makeFeedback(start, end); item.feedback.push(row); item.status = 'In progress'; dirty(); editFeedback(row.id);
}
function previewTimeline() {
  const item = review(); if (!item) return null;
  const student = clipAsset(item.asset_id);
  const timeline = studentPreviewTimeline(item.feedback, student?.duration || $('student').duration || 0, clip => effectiveDuration(clipAsset(clip.asset_id))) || {start: 0, end: 0, items: []};
  if (item.correction?.asset_id) {
    const length = effectiveDuration(clipAsset(item.correction.asset_id)), start = timeline.end;
    timeline.items.push({tail: true, item: {id: 'correction', clips: [item.correction]}, sectionStart: start, start, end: start + length, sourceStart: student?.duration || 0, sourceEnd: student?.duration || 0});
    timeline.end += length;
  }
  return timeline.items.length ? timeline : null;
}
function pausePreview() {preview.playing = false; cancelAnimationFrame(preview.raf); preview.raf = 0; $('teacher').pause(); $('student').pause(); $('preview-play').textContent = 'Play preview';}
async function renderPreviewFrame() {
  if (!$('preview').checked || !review()) return;
  const timeline = previewTimeline(); if (!timeline) return;
  preview.time = Math.min(preview.time, timeline.end);
  const row = previewSectionAt(timeline, Math.min(preview.time, timeline.end - .001));
  const studentTime = previewStudentTime(timeline, preview.time, clipAsset(review().asset_id)?.duration || 0);
  if (Math.abs($('student').currentTime - studentTime.student) > .1) $('student').currentTime = studentTime.student;
  if (studentTime.holding || row.tail) $('student').pause();
  else if (preview.playing && $('student').paused) $('student').play().catch(() => {});
  const clip = row.item.clips?.at(-1), teacher = $('teacher');
  if (clip) {
    if (teacher.dataset.asset !== clip.asset_id) {
      teacher.pause(); teacher.src = await mediaUrl(clipAsset(clip.asset_id)); teacher.dataset.asset = clip.asset_id; teacher.load();
    }
    const asset = clipAsset(clip.asset_id);
    const elapsed = Math.max(0, preview.time - row.start);
    const clipTime = (asset?.trim_start || 0) + Math.min(elapsed, Math.max(0, effectiveDuration(asset) - .01));
    if (Math.abs(teacher.currentTime - clipTime) > .1) teacher.currentTime = clipTime;
    if (preview.playing && elapsed < effectiveDuration(asset) - .03) teacher.play().catch(() => {});
    else teacher.pause();
    teacher.hidden = preview.time < row.start && !row.tail;
    teacher.style.width = row.tail ? '100%' : '34%'; teacher.style.right = row.tail ? '0' : '2%'; teacher.style.bottom = row.tail ? '0' : '3%'; teacher.style.maxHeight = row.tail ? '100%' : '45%';
  } else {teacher.pause(); teacher.hidden = true;}
  const caption = row.tail ? (review().correction.note || review().correction.subtitle || '') : (clip?.subtitle ?? row.item.note ?? '');
  $('caption').textContent = preview.time < row.start && !row.tail ? '' : caption;
  $('caption').hidden = !$('caption').textContent;
  $('timestamp').textContent = row.tail ? '' : feedbackTimestamp(row.item);
  $('timestamp').hidden = row.tail;
  $('preview-seek').max = timeline.end; $('preview-seek').value = preview.time;
  $('preview-time').textContent = `${clock(preview.time)} / ${clock(timeline.end)}`;
}
function previewTick() {
  if (!$('preview').checked || !preview.playing) return;
  const now = performance.now(), timeline = previewTimeline();
  preview.time = Math.min(timeline.end, preview.time + (now - preview.wall) / 1000);
  preview.wall = now;
  renderPreviewFrame().catch(showError);
  if (preview.time >= timeline.end) pausePreview();
  else preview.raf = requestAnimationFrame(previewTick);
}
function togglePreview() {
  pausePreview(); const on = $('preview').checked;
  $('student').controls = !on; $('preview-play').hidden = $('preview-seek').hidden = !on;
  if (!on) {preview.time = 0; $('teacher').hidden = $('caption').hidden = $('timestamp').hidden = true; $('preview-time').textContent = ''; return;}
  if (!previewTimeline()) {toast('Add a written note or response before previewing.', true); $('preview').checked = false; return togglePreview();}
  preview.time = 0; renderPreviewFrame().catch(showError);
}
async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({video: true, audio: false});
  $('camera').srcObject = stream;
}
function stopCamera() {stream?.getTracks().forEach(track => track.stop()); stream = null; $('camera').srcObject = null;}
async function openRecorder(target) {
  recordTarget = target; takeBlob = null; $('camera').hidden = false; $('take').hidden = $('trim-fields').hidden = $('use-recording').hidden = $('record-retake').hidden = true;
  $('record-start').hidden = false; $('record-stop').hidden = true;
  $('recorder-dialog').showModal();
  try {await startCamera();} catch (error) {showError(error); $('recorder-dialog').close();}
}
function stopRecorder() {if (recorder?.state === 'recording') recorder.stop();}
async function useRecording() {
  if (!takeBlob) return;
  const extension = takeBlob.type.includes('mp4') ? '.mp4' : '.webm';
  const file = new File([takeBlob], 'correction' + extension, {type: takeBlob.type});
  const metadata = await probe(file);
  if (!Number.isFinite(metadata.duration)) metadata.duration = recordElapsed;
  const start = Number($('trim-start').value), end = Number($('trim-end').value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > metadata.duration + .1) throw new Error('Choose a valid trim range.');
  const asset = await folders.savePrivate(file, {...metadata, trim_start: start, trim_end: end});
  if (recordTarget === 'section') {
    const row = currentFeedback(); if (!row) throw new Error('Select feedback before recording.');
    row.clips = [{id: newId(), asset_id: asset.id, title: 'Signed response'}];
    $('attached').textContent = 'Attached: Signed response'; $('save-private-library').hidden = false;
  } else review().correction = {asset_id: asset.id, title: 'Signed correction'};
  review().status = 'In progress'; dirty(); await saveNow(); closeRecorder(); toast('Recording saved privately in this folder.');
}
function closeRecorder() {stopRecorder(); stopCamera(); $('take').pause(); $('take').removeAttribute('src'); $('take').load(); if ($('recorder-dialog').open) $('recorder-dialog').close();}
async function openLibrary(target) {
  libraryTarget = target;
  try {await folders.chooseLibrary(); await loadCatalog(); renderLibrary(); $('library-dialog').showModal();}
  catch (error) {showError(error);}
}
async function setupLibraryFolder() {
  try {
    const directory = await folders.selectLibrary();
    await loadCatalog();
    toast(`Reusable library folder is set to ${directory.name}.`);
  } catch (error) {showError(error);}
}
function renderLibrary() {
  const list = $('library-list'); list.replaceChildren();
  for (const entry of searchClips(catalog.library, $('library-search').value, 'all')) {
    const row = document.createElement('div'); row.className = 'library-row';
    const title = document.createElement('strong'); title.textContent = `${entry.title || 'Untitled'}${entry.archived ? ' · Archived' : ''}`;
    const detail = document.createElement('p'); detail.textContent = `${entry.description || ''} ${(entry.tags || []).join(', ')}`;
    row.append(title, detail);
    const previewButton = document.createElement('button'); previewButton.textContent = 'Preview'; previewButton.onclick = () => previewLibrary(entry); row.append(previewButton);
    const use = document.createElement('button'); use.textContent = libraryTarget === 'correction' ? 'Use as correction' : 'Attach to feedback'; use.disabled = !review() || entry.archived;
    use.onclick = () => attachLibrary(entry); row.append(use);
    const edit = document.createElement('button'); edit.textContent = 'Edit'; edit.onclick = () => openLibraryEdit(null, entry.asset_id, entry.id); row.append(edit);
    const replace = document.createElement('button'); replace.textContent = 'New version'; replace.onclick = () => {replacementEntryId = entry.id; $('library-replace').click();}; row.append(replace);
    const archive = document.createElement('button'); archive.textContent = entry.archived ? 'Restore' : 'Archive'; archive.onclick = () => mutateEntry(entry, {archived: !entry.archived}); row.append(archive);
    const remove = document.createElement('button'); remove.textContent = 'Remove from shelf'; remove.onclick = async () => {
      if (!confirm('Remove this entry from the shelf? Existing reviews keep their pinned recording and subtitle.')) return;
      const previous = catalog.library; catalog.library = catalog.library.filter(item => item.id !== entry.id);
      try {await saveCatalog();} catch (error) {catalog.library = previous; showError(error);}
    }; row.append(remove); list.append(row);
  }
  if (!catalog.library.length) list.textContent = 'No reusable clips yet.';
}
async function previewLibrary(entry) {
  const asset = clipAsset(entry.asset_id), player = $('library-preview-video');
  if (!asset) return toast('This library recording is unavailable.', true);
  $('library-preview-title').textContent = entry.title || 'Clip preview';
  $('library-preview-caption').textContent = entry.description || '';
  try {player.src = await mediaUrl(asset);}
  catch (error) {return showError(error);}
  player.dataset.trimStart = String(asset.trim_start || 0);
  player.dataset.trimEnd = String(asset.trim_end || asset.duration || 0);
  player.onloadedmetadata = () => {player.currentTime = Number(player.dataset.trimStart) || 0;};
  $('library-preview-dialog').showModal();
}
async function mutateEntry(entry, changes) {const previous = structuredClone(entry); Object.assign(entry, changes); try {await saveCatalog();} catch (error) {Object.assign(entry, previous); showError(error);}}
function attachLibrary(entry) {
  const clip = {id: newId(), asset_id: entry.asset_id, library_id: entry.id, title: entry.title, subtitle: entry.description || ''};
  if (libraryTarget === 'correction') review().correction = clip;
  else {
    const row = currentFeedback(); if (!row) return toast('Select a feedback item first.', true);
    row.clips = [clip]; $('attached').textContent = `Attached: ${entry.title}`; $('save-private-library').hidden = true;
  }
  review().status = 'In progress'; dirty(); $('library-dialog').close(); toast('Reusable clip attached.');
}
function openLibraryEdit(file = null, assetId = null, entryId = null) {
  libraryFile = file; libraryAsset = assetId; libraryEditId = entryId;
  const entry = entryFor(entryId);
  $('library-title').value = entry?.title || (file ? displayName(file.name) : 'Signed response');
  $('library-subtitle').value = entry?.description || '';
  $('library-tags').value = (entry?.tags || []).join(', ');
  $('library-edit-dialog').showModal();
}
async function commitLibraryEdit() {
  let assetId = libraryAsset;
  await folders.chooseLibrary();
  const title = $('library-title').value.trim(); if (!title) throw new Error('Enter a clip title.');
  const description = $('library-subtitle').value.trim(), tags = $('library-tags').value.split(',').map(tag => tag.trim()).filter(Boolean);
  let newAsset = null;
  if (libraryFile) {
    const metadata = await probe(libraryFile);
    newAsset = await folders.writeLibraryMedia(libraryFile, metadata); assetId = newAsset.id; libraryFile = null; libraryAsset = assetId;
  } else if (localAsset(assetId)) {
    const asset = localAsset(assetId);
    const file = await folders.fileFor(asset);
    newAsset = await folders.writeLibraryMedia(file, {duration: asset.duration, width: asset.width, height: asset.height, trim_start: asset.trim_start || 0, trim_end: asset.trim_end || asset.duration});
    assetId = newAsset.id; libraryAsset = assetId;
  }
  if (!assetId) throw new Error('Choose a recording first.');
  catalog = await folders.readLibraryCatalog();
  if (newAsset) catalog.assets.push(newAsset);
  const existing = entryFor(libraryEditId);
  const previous = structuredClone(catalog.library);
  if (existing) {Object.assign(existing, {asset_id: assetId, title, description, tags, version: (existing.version || 1) + (existing.asset_id === assetId ? 0 : 1)});}
  else catalog.library.push({id: newId(), asset_id: assetId, title, description, tags, aliases: [], category: 'General feedback', favorite: false, archived: false, inbox: false, version: 1});
  try {await saveCatalog();} catch (error) {catalog.library = previous; throw error;}
  $('library-edit-dialog').close();
  toast('Saved to the reusable library on this computer.');
}
async function exportReview() {
  const item = review(); if (!item || exporting || !canExport(item)) return;
  await saveNow();
  const revision = folders.revision, itemId = item.id, snapshot = structuredClone(item);
  const ids = new Set([item.asset_id, ...(item.feedback || []).flatMap(row => row.clips || []).map(clip => clip.asset_id), item.correction?.asset_id].filter(Boolean));
  const media = new Map();
  for (const id of ids) {
    const asset = clipAsset(id); if (!asset) throw new Error('An attached recording is missing.');
    media.set(id, asset.kind === 'student' || asset.kind === 'private' ? {file: await folders.fileFor(asset)} : {file: await folders.libraryFileFor(asset)});
  }
  const assets = new Map([...ids].map(id => [id, clipAsset(id)]));
  const composition = videoComposition(snapshot, assets, catalog.library, id => media.get(id));
  const controller = new AbortController(); exporting = controller;
  $('cancel-export').hidden = false; $('export-progress').hidden = false; $('export').disabled = true;
  $('progress').value = 0; $('progress-label').textContent = 'Rendering final MP4…';
  try {
    const result = await renderVideo(composition, {signal: controller.signal, onProgress: value => {$('progress').value = value; $('progress-label').textContent = `Rendering · ${Math.floor(value * 100)}%`;}});
    if (controller.signal.aborted) return;
    if ((await folders.readDocument()).revision !== revision || editCount !== savedCount || review()?.id !== itemId) throw new Error('The review changed during rendering. Export again from the latest saved review.');
    $('progress-label').textContent = 'Saving MP4 in evaluated…';
    const filename = await folders.writeExport(item.filename, result.blob);
    item.exports ||= []; item.exports.push({filename, at: new Date().toISOString(), revision});
    item.status = item.feedback.every(row => row.note?.trim() || row.clips?.length) ? 'Exported' : 'In progress';
    dirty(); await saveNow(); renderFolders();
    toast(`${filename} saved in this folder's evaluated directory.`);
  } catch (error) {if (error.name !== 'AbortError') showError(error);}
  finally {exporting = null; $('cancel-export').hidden = true; $('export-progress').hidden = true; renderFeedback();}
}

$('browse').onclick = async () => {try {const root = await folders.choose(); await saveNow(); await folders.activate(root); await openFolder([], true);} catch (error) {if (error.name !== 'AbortError') showError(error);}};
$('reconnect').onclick = async () => {try {await folders.reconnect(); await openFolder(folders.path);} catch (error) {showError(error);}};
$('download-draft').onclick = () => {
  if (!pendingDraft) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(pendingDraft.document, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'still-unsaved-draft.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
};
$('save-state').onclick = () => saveNow().catch(showError);
$('evaluated').onclick = () => openFolder([...folders.path, 'evaluated']).catch(showError);
$('back-review').onclick = () => openFolder(folders.path.slice(0, -1)).catch(showError);
$('add-point').onclick = () => addFeedback(false); $('add-range').onclick = () => addFeedback(true);
$('preview').onchange = togglePreview;
$('preview-play').onclick = () => {if (preview.time >= (previewTimeline()?.end || 0) - .01) preview.time = 0; preview.playing = !preview.playing; preview.wall = performance.now(); $('preview-play').textContent = preview.playing ? 'Pause preview' : 'Play preview'; if (preview.playing) previewTick(); else pausePreview();};
$('preview-seek').oninput = () => {preview.time = Number($('preview-seek').value); preview.wall = performance.now(); renderPreviewFrame().catch(showError);};
$('start').oninput = event => {const value = Number(event.target.value); if (Number.isFinite(value) && value >= 0) updateFeedbackField('start', value);};
$('end').oninput = event => {const value = Number(event.target.value); if (Number.isFinite(value) && value >= (currentFeedback()?.start || 0)) updateFeedbackField('end', value);};
$('note').oninput = event => updateFeedbackField('note', event.target.value);
$('private-note').oninput = event => updateFeedbackField('private_note', event.target.value);
$('close-feedback').onclick = () => $('feedback-dialog').close();
$('retry-save').onclick = () => saveNow().catch(showError);
$('delete-feedback').onclick = () => {const item = review(); item.feedback = item.feedback.filter(row => row.id !== selectedFeedback); dirty(); $('feedback-dialog').close();};
$('remove-clip').onclick = () => {const row = currentFeedback(); if (row) {row.clips = []; dirty(); editFeedback(row.id);}};
$('record-section').onclick = () => openRecorder('section');
$('record-correction').onclick = () => openRecorder('correction');
$('attach-section').onclick = () => openLibrary('section');
$('attach-correction').onclick = () => openLibrary('correction');
$('save-correction-library').onclick = () => {const id = review()?.correction?.asset_id; if (localAsset(id)) openLibraryEdit(null, id);};
$('save-private-library').onclick = () => {const id = currentFeedback()?.clips?.[0]?.asset_id; if (localAsset(id)) openLibraryEdit(null, id);};
$('record-start').onclick = () => {
  const mime = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type));
  recorder = new MediaRecorder(stream, mime ? {mimeType: mime} : undefined); const chunks = [];
  recorder.ondataavailable = event => {if (event.data.size) chunks.push(event.data);};
  recorder.onstop = async () => {try {recordElapsed = (performance.now() - recordStarted) / 1000; takeBlob = new Blob(chunks, {type: recorder.mimeType || 'video/webm'}); stopCamera(); $('camera').hidden = true; $('take').hidden = $('trim-fields').hidden = $('use-recording').hidden = $('record-retake').hidden = false; $('record-stop').hidden = true; $('take').src = URL.createObjectURL(takeBlob); const duration = (await probe(new File([takeBlob], 'take.webm', {type: takeBlob.type}))).duration; $('trim-start').value = 0; $('trim-end').value = (Number.isFinite(duration) ? duration : recordElapsed).toFixed(2);} catch (error) {showError(error);}};
  recordStarted = performance.now(); recorder.start(1000); $('record-start').hidden = true; $('record-stop').hidden = false;
};
$('record-stop').onclick = stopRecorder;
$('record-retake').onclick = async () => {takeBlob = null; $('take').pause(); URL.revokeObjectURL($('take').src); $('take').hidden = $('trim-fields').hidden = $('use-recording').hidden = $('record-retake').hidden = true; $('camera').hidden = false; $('record-start').hidden = false; await startCamera().catch(showError);};
$('use-recording').onclick = () => useRecording().catch(showError);
$('close-recorder').onclick = closeRecorder;
$('library-open').onclick = () => openLibrary('section'); $('close-library').onclick = () => $('library-dialog').close();
$('library-setup').onclick = setupLibraryFolder;
$('library-search').oninput = renderLibrary;
$('library-import').onchange = event => {const file = event.target.files[0]; if (!file) return; if (!allowed.test(file.name)) return toast('Choose a video file.', true); openLibraryEdit(file); event.target.value = '';};
$('library-replace').onchange = event => {const file = event.target.files[0], id = replacementEntryId; replacementEntryId = null; event.target.value = ''; if (file && allowed.test(file.name)) openLibraryEdit(file, null, id); else if (file) toast('Choose a video file.', true);};
$('library-save').onclick = () => commitLibraryEdit().catch(showError);
$('library-edit-cancel').onclick = () => $('library-edit-dialog').close();
$('close-library-preview').onclick = () => {$('library-preview-video').pause(); $('library-preview-dialog').close();};
$('library-preview-video').ontimeupdate = () => {const player = $('library-preview-video'), end = Number(player.dataset.trimEnd); if (end && player.currentTime >= end) player.pause();};
$('student').onerror = () => {changingVideo = false; if (selected) toast('This browser cannot play the source video. Convert a copy to a supported format and reconnect the folder; the original was not changed.', true);};
$('student').ontimeupdate = () => {
  if (changingVideo || !selected || !folders.root) return;
  const entry = windowView[windowKey()] ||= {};
  entry.positions ||= {}; entry.positions[selected] = $('student').currentTime;
  rememberView();
};
$('export').onclick = () => exportReview().catch(showError);
$('cancel-export').onclick = () => exporting?.abort();
window.addEventListener('beforeunload', event => {if (editCount !== savedCount) {event.preventDefault(); event.returnValue = '';}});

try {await loadCatalog();} catch (error) {showError(error);}
try {
  if (await folders.restore()) await openFolder(folders.path);
  else if (folders.root) {$('reconnect').hidden = false; $('save-state').textContent = 'Reconnect folder';}
} catch (error) {showError(error);}
