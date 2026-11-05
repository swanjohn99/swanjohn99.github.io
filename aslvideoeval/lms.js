import {parseLmsPackage} from './lms-import.js';

const $ = id => document.getElementById(id);
let status, user, data, selectedAssignmentId = null, selectedStudentVideoKey = null, pendingUploads = [];
let studentVideoUrl = null;
let studentDBPromise;
const sections = ['setup', 'login', 'change-password', 'admin', 'teacher', 'student'];

function show(id) {
  sections.forEach(key => $(key).hidden = key !== id);
  $('nav').hidden = !user;
}

function message(text, error = false) {
  const box = $('message');
  box.textContent = text;
  box.classList.toggle('danger', error);
  box.hidden = false;
  clearTimeout(message.timer);
  message.timer = setTimeout(() => box.hidden = true, 5000);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {...(options.body instanceof Blob ? {} : {'Content-Type': 'application/json'}), ...options.headers},
  });
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}

const fields = form => Object.fromEntries(new FormData(form));

function openStudentDB() {
  if (!studentDBPromise) studentDBPromise = new Promise((resolve, reject) => {
    const opening = indexedDB.open('still-student-submissions', 1);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains('uploads')) {
        opening.result.createObjectStore('uploads', {keyPath: 'key'});
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error || new Error('Browser storage is unavailable.'));
  });
  return studentDBPromise;
}

async function pendingForStudent() {
  const db = await openStudentDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('uploads', 'readonly');
    const query = transaction.objectStore('uploads').getAll();
    query.onsuccess = () => resolve(query.result.filter(item => item.user_id === user.id));
    query.onerror = () => reject(query.error || new Error('Could not read saved uploads.'));
  });
}

async function savePending(item) {
  const db = await openStudentDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('uploads', 'readwrite');
    transaction.objectStore('uploads').put(item);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not save this video in browser storage.'));
    transaction.onabort = () => reject(transaction.error || new Error('Could not save this video in browser storage.'));
  });
}

async function removePending(key) {
  const db = await openStudentDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('uploads', 'readwrite');
    transaction.objectStore('uploads').delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not clear the local upload.'));
  });
}

async function requestPersistentStorage() {
  try { await navigator.storage?.persist?.(); } catch {}
}

async function boot() {
  status = await request('/api/auth/status');
  user = status.user;
  if (!user) { show(status.setup_required ? 'setup' : 'login'); return; }
  $('identity').textContent = `${user.display_name} · ${user.role}`;
  if (user.must_change_password) {
    $('temporary-note').textContent = 'Your administrator issued a temporary password. Choose a new password to continue.';
    show('change-password');
    return;
  }
  if (user.role === 'student') await requestPersistentStorage();
  await refresh();
}

async function refresh() {
  data = await request('/api/lms/dashboard');
  user = data.user;
  show(user.role);
  if (user.role === 'admin') renderAdmin();
  if (user.role === 'teacher') renderTeacher();
  if (user.role === 'student') await renderStudent();
}

function submitJSON(form, path, after) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await request(path, {method: 'POST', body: JSON.stringify(fields(form))});
      form.reset();
      await after?.();
    } catch (error) { message(error.message, true); }
  });
}

submitJSON($('setup-form'), '/api/auth/setup', () => location.assign('/admin'));
submitJSON($('login-form'), '/api/auth/login', () => location.assign('/'));
submitJSON($('password-form'), '/api/auth/change-password', async () => { message('Password changed.'); await boot(); });
$('logout').onclick = async () => {
  await request('/api/auth/logout', {method: 'POST', body: '{}'});
  location.assign('/login');
};
$('password-button').onclick = () => show('change-password');
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());
$('add-account').onclick = () => $('account-dialog').showModal();
submitJSON($('account-form'), '/api/admin/users', async () => { $('account-dialog').close(); await refresh(); message('Account created with a temporary password.'); });

function renderAdmin() {
  const box = $('users');
  box.replaceChildren(...data.users.map(item => {
    const row = document.createElement('div');
    row.className = 'user';
    row.innerHTML = `<div><strong>${escapeHTML(item.display_name)}</strong><div>${escapeHTML(item.username)} · ${item.role}${item.must_change_password ? ' · temporary password' : ''}</div></div>`;
    const reset = document.createElement('button');
    reset.className = 'secondary';
    reset.textContent = 'Reset password';
    reset.onclick = async () => {
      const password = prompt(`Temporary password for ${item.display_name} (10+ characters)`);
      if (!password) return;
      try {
        await request('/api/admin/reset-password', {method: 'POST', body: JSON.stringify({user_id: item.id, password})});
        message('Password reset; existing sessions were signed out.');
      } catch (error) { message(error.message, true); }
    };
    row.append(reset);
    return row;
  }));
}

$('roster-form').onsubmit = async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget), file = form.get('file');
  try {
    const result = await request('/api/admin/roster', {method: 'POST', body: JSON.stringify({csv: await file.text(), temporary_password: form.get('temporary_password')})});
    await refresh();
    message(`Created ${result.created.length} account(s)${result.errors.length ? `; ${result.errors.length} row(s) skipped` : '.'}`);
  } catch (error) { message(error.message, true); }
};

function openText(action, parent, title, label, assignment = false) {
  const form = $('text-form');
  form.reset();
  form.action.value = action;
  form.parent.value = parent || '';
  $('text-title').textContent = title;
  $('text-label').firstChild.textContent = label;
  $('instructions-label').hidden = !assignment;
  $('target-label').hidden = !assignment;
  $('text-dialog').showModal();
}

$('add-class').onclick = () => openText('class', '', 'Create class', 'Class name');
$('import-course').onclick = () => {
  $('import-form').reset();
  $('import-status').textContent = '';
  $('import-dialog').showModal();
};
$('import-form').onsubmit = async event => {
  event.preventDefault();
  const file = $('import-file').files?.[0];
  if (!file) return;
  if (file.size > 256 * 1024 * 1024) {
    message('The LMS export is larger than the 256 MB import limit.', true);
    return;
  }
  const submit = $('import-submit');
  submit.disabled = true;
  submit.textContent = 'Importing…';
  $('import-status').textContent = `Opening ${file.name} locally…`;
  try {
    const imported = await parseLmsPackage(file, text => { $('import-status').textContent = text; });
    $('import-status').textContent = 'Uploading the class structure…';
    const payload = JSON.stringify(imported);
    if (new Blob([payload]).size > 32 * 1024 * 1024) throw new Error('The extracted course structure is too large to upload at once. Import smaller course packages.');
    const result = await request('/api/teacher/import-course-package', {
      method: 'POST',
      body: payload,
    });
    $('import-dialog').close();
    await refresh();
    const summary = `Imported ${result.classes} class${result.classes === 1 ? '' : 'es'}, ${result.units} unit${result.units === 1 ? '' : 's'}, and ${result.assignments} assignment${result.assignments === 1 ? '' : 's'} from ${result.format}.`;
    message(summary);
  } catch (error) {
    $('import-status').textContent = error.message;
    message(error.message, true);
  } finally {
    submit.disabled = false;
    submit.textContent = 'Import courses';
  }
};
$('text-form').onsubmit = async event => {
  event.preventDefault();
  const values = fields(event.currentTarget);
  let path, payload;
  if (values.action === 'class') { path = '/api/teacher/classes'; payload = {name: values.name}; }
  else if (values.action === 'unit') { path = '/api/teacher/units'; payload = {class_id: values.parent, title: values.name}; }
  else { path = '/api/teacher/assignments'; payload = {unit_id: values.parent, title: values.name, instructions: values.instructions, target: values.target}; }
  try {
    await request(path, {method: 'POST', body: JSON.stringify(payload)});
    $('text-dialog').close();
    await refresh();
    message('Saved.');
  } catch (error) { message(error.message, true); }
};

function renderTeacher() {
  const root = $('classes');
  root.replaceChildren(...data.classes.map(course => {
    const node = document.createElement('article');
    node.className = 'course';
    node.innerHTML = `<div class="course-head"><div><h2>${escapeHTML(course.name)}</h2><span class="status">${course.student_ids.length} student(s)</span></div><button class="secondary add-unit">Add unit</button></div>`;
    node.querySelector('.add-unit').onclick = () => openText('unit', course.id, 'Add unit', 'Unit title');
    const roster = document.createElement('div');
    roster.className = 'student-list';
    for (const student of data.students) {
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" value="${student.id}" ${course.student_ids.includes(student.id) ? 'checked' : ''}> ${escapeHTML(student.display_name)}`;
      roster.append(label);
    }
    const save = document.createElement('button');
    save.className = 'secondary';
    save.textContent = 'Save enrollment';
    save.onclick = async () => {
      const student_ids = [...roster.querySelectorAll(':checked')].map(input => input.value);
      try {
        await request('/api/teacher/enroll', {method: 'POST', body: JSON.stringify({class_id: course.id, student_ids})});
        await refresh();
        message('Enrollment saved.');
      } catch (error) { message(error.message, true); }
    };
    node.append(roster, save);
    for (const unit of course.units) {
      const section = document.createElement('section');
      section.className = 'unit';
      section.innerHTML = `<div class="unit-head"><h3>${escapeHTML(unit.title)}</h3><button class="secondary">Add assignment</button></div>`;
      section.querySelector('button').onclick = () => openText('assignment', unit.id, 'Add assignment', 'Assignment title', true);
      for (const assignment of unit.assignments) {
        const row = document.createElement('div');
        row.className = 'assignment';
        row.innerHTML = `<div><strong>${escapeHTML(assignment.title)}</strong><p>${escapeHTML(assignment.instructions || '')}</p></div><a class="button" href="/?assignment=${assignment.id}">Review</a>`;
        section.append(row);
      }
      node.append(section);
    }
    return node;
  }));
}

function studentAssignments() {
  return data.classes.flatMap(course => course.units.flatMap(unit => unit.assignments.map(assignment => ({
    ...assignment,
    course_id: course.id,
    course_name: course.name,
    unit_id: unit.id,
    unit_title: unit.title,
  }))));
}

function formatStudentTime(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  const value = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function updateStudentVideo(source, pending = false) {
  const video = $('student-video');
  const empty = $('student-empty');
  if (studentVideoUrl?.startsWith('blob:')) URL.revokeObjectURL(studentVideoUrl);
  studentVideoUrl = source?.startsWith('blob:') ? source : null;
  if (source) {
    video.src = source;
    video.hidden = false;
    empty.hidden = true;
    $('student-upload-status').textContent = pending ? 'This video is saved on this Chromebook and waiting to upload.' : '';
  } else {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.hidden = true;
    empty.hidden = false;
    $('student-upload-status').textContent = '';
  }
  $('student-current-time').textContent = '00:00';
  $('student-duration').textContent = '00:00';
  $('student-seek').value = 0;
}

function studentVideoEntries(assignment) {
  if (!assignment) return [];
  const entries = [];
  const pending = pendingUploads.filter(item => item.assignment_id === assignment.id).sort((a, b) => b.updated_at - a.updated_at)[0];
  if (pending) entries.push({key: `pending:${pending.key}`, type: 'pending', label: 'Your upload', status: 'Upload pending', source: () => URL.createObjectURL(pending.blob), pending});
  const submission = assignment.submission;
  if (submission?.original_asset_id) entries.push({key: 'original', type: 'original', label: 'Your upload', status: 'Submitted', source: `/media/${submission.original_asset_id}`});
  if (submission?.evaluated_asset_id) entries.push({key: 'evaluated', type: 'evaluated', label: 'Teacher evaluated', status: 'Evaluation complete', source: `/media/${submission.evaluated_asset_id}`});
  return entries;
}

function chooseStudentAssignment(assignment, {renderList = true} = {}) {
  if (!assignment) return;
  if (selectedAssignmentId !== assignment.id) selectedStudentVideoKey = null;
  selectedAssignmentId = assignment.id;
  $('student-assignment-title').textContent = assignment.title;
  $('student-instructions').textContent = assignment.instructions || '';
  renderStudentBreadcrumb();
  const entries = studentVideoEntries(assignment);
  let selected = entries.find(item => item.key === selectedStudentVideoKey);
  if (!selected) selected = entries.find(item => item.type === 'evaluated') || entries[0];
  selectedStudentVideoKey = selected?.key || null;
  updateStudentVideo(selected ? (typeof selected.source === 'function' ? selected.source() : selected.source) : null, selected?.type === 'pending');
  if (renderList) renderStudentSubmissions();
}

function makeBreadcrumbSelect(label, options, value, onChange) {
  const select = document.createElement('select');
  select.setAttribute('aria-label', label);
  for (const option of options) {
    const item = document.createElement('option');
    item.value = option.id;
    item.textContent = option.name;
    select.append(item);
  }
  select.value = value;
  select.onchange = () => onChange(select.value);
  return select;
}

function renderStudentBreadcrumb() {
  const root = $('student-breadcrumb');
  root.replaceChildren();
  const assignments = studentAssignments();
  const selected = assignments.find(item => item.id === selectedAssignmentId);
  if (!selected) return;
  const courseOptions = data.classes.filter(course => assignments.some(item => item.course_id === course.id)).map(course => ({id: course.id, name: course.name}));
  root.append(makeBreadcrumbSelect('Class', courseOptions, selected.course_id, courseId => {
    const next = assignments.find(item => item.course_id === courseId);
    if (next) chooseStudentAssignment(next);
  }));
  root.append(Object.assign(document.createElement('span'), {className: 'separator', textContent: '/'}));
  const selectedCourse = data.classes.find(course => course.id === selected.course_id);
  const unitOptions = selectedCourse.units.filter(unit => assignments.some(item => item.course_id === selected.course_id && item.unit_id === unit.id))
    .map(unit => ({id: unit.id, name: unit.title}));
  root.append(makeBreadcrumbSelect('Unit', unitOptions, selected.unit_id, unitId => {
    const next = assignments.find(item => item.course_id === selected.course_id && item.unit_id === unitId);
    if (next) chooseStudentAssignment(next);
  }));
  root.append(Object.assign(document.createElement('span'), {className: 'separator', textContent: '/'}));
  const assignmentOptions = assignments.filter(item => item.course_id === selected.course_id && item.unit_id === selected.unit_id)
    .map(item => ({id: item.id, name: item.title}));
  root.append(makeBreadcrumbSelect('Assignment', assignmentOptions, selected.id, id => {
    const next = assignments.find(item => item.id === id);
    if (next) chooseStudentAssignment(next);
  }));
  const evaluated = !!selected.submission?.evaluated_asset_id;
  const closed = evaluated || !!selected.submission?.locked;
  const upload = $('student-upload');
  upload.textContent = closed ? 'Upload closed' : 'Upload';
  upload.disabled = closed;
  upload.title = upload.disabled ? 'This assignment is closed for uploads.' : 'Upload or replace your assignment video.';
  $('student-review-status').textContent = evaluated ? 'Evaluation complete' : closed ? 'Submission closed' : selected.submission ? 'Submitted' : 'Ready when you are';
  $('student-review-status').classList.toggle('evaluated', evaluated);
}

function renderStudentSubmissions() {
  const root = $('student-submissions');
  const assignment = studentAssignments().find(item => item.id === selectedAssignmentId);
  const entries = studentVideoEntries(assignment);
  root.replaceChildren();
  for (const entry of entries) {
    const card = document.createElement('div');
    card.className = 'student-submission';
    const button = document.createElement('button');
    button.className = 'student-submission-select';
    button.setAttribute('aria-current', String(selectedStudentVideoKey === entry.key));
    const path = document.createElement('strong');
    path.textContent = entry.label;
    const badge = document.createElement('span');
    badge.className = entry.type === 'pending' ? 'pending' : 'status';
    badge.textContent = entry.status;
    button.append(path, badge);
    button.onclick = () => {
      selectedStudentVideoKey = entry.key;
      updateStudentVideo(typeof entry.source === 'function' ? entry.source() : entry.source, entry.type === 'pending');
      renderStudentSubmissions();
    };
    if (entry.type === 'pending') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'student-submission-retry';
      retry.textContent = 'Retry upload';
      const retryUpload = event => {
        event.stopPropagation();
        uploadPending(entry.pending).catch(error => message(error.message, true));
      };
      retry.onclick = retryUpload;
      card.append(retry);
    }
    card.prepend(button);
    root.append(card);
  }
  if (!entries.length) root.append(Object.assign(document.createElement('p'), {className: 'empty-panel', textContent: 'No videos for this assignment yet.'}));
}

async function uploadPending(pending) {
  const assignment = studentAssignments().find(item => item.id === pending.assignment_id);
  if (!assignment) throw new Error('This assignment is no longer available.');
  pending.status = 'uploading';
  await savePending(pending);
  pendingUploads = await pendingForStudent();
  renderStudentSubmissions();
  $('student-upload-status').textContent = 'Uploading video…';
  try {
    // Future client-side compression belongs immediately before the local save and upload stages.
    const uploadFile = pending.blob;
    await request('/api/student/submit', {
      method: 'POST',
      body: uploadFile,
      headers: {
        'Content-Type': uploadFile.type || 'application/octet-stream',
        'X-Assignment-Id': pending.assignment_id,
        'X-Filename': encodeURIComponent(pending.original_filename),
      },
    });
    await removePending(pending.key);
    pendingUploads = await pendingForStudent();
    await refresh();
    const submitted = studentAssignments().find(item => item.id === pending.assignment_id);
    if (submitted) chooseStudentAssignment(submitted);
    message('Video submitted.');
  } catch (error) {
    pending.status = 'pending';
    pending.error = error.message;
    await savePending(pending);
    pendingUploads = await pendingForStudent();
    renderStudentSubmissions();
    $('student-upload-status').textContent = `Saved on this Chromebook. Upload failed: ${error.message}`;
    message('Video is saved on this Chromebook. Retry the upload when you are connected.', true);
  }
}

async function renderStudent() {
  pendingUploads = await pendingForStudent();
  const assignments = studentAssignments();
  if (!assignments.some(item => item.id === selectedAssignmentId)) {
    const firstSubmitted = assignments.find(item => item.submission);
    selectedAssignmentId = firstSubmitted?.id || assignments[0]?.id || null;
  }
  if (selectedAssignmentId) chooseStudentAssignment(assignments.find(item => item.id === selectedAssignmentId), {renderList: false});
  else {
    $('student-breadcrumb').replaceChildren();
    $('student-assignment-title').textContent = 'Choose an assignment';
    $('student-instructions').textContent = '';
    $('student-upload').disabled = true;
    $('student-upload').title = 'Choose an assignment first.';
    $('student-review-status').textContent = 'No assignment selected';
    $('student-review-status').classList.remove('evaluated');
    updateStudentVideo(null);
  }
  renderStudentSubmissions();
}

$('student-upload').onclick = () => $('student-video-file').click();
$('student-video-file').onchange = async event => {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = '';
  if (!file || !selectedAssignmentId) return;
  const assignment = studentAssignments().find(item => item.id === selectedAssignmentId);
  if (!assignment) return;
  if (assignment.submission?.evaluated_asset_id || assignment.submission?.locked) { message('This assignment already has an evaluated video and is closed for uploads.', true); return; }
  const existingPending = pendingUploads.find(item => item.assignment_id === assignment.id);
  if ((assignment.submission || existingPending) && !confirm('Replace your existing video submission? A successful upload clears its previous teacher feedback.')) return;
  const extension = file.name.includes('.') ? file.name.split('.').pop() : 'mp4';
  const key = `${user.id}:${assignment.id}`;
  const pending = {
    key,
    user_id: user.id,
    assignment_id: assignment.id,
    original_filename: file.name,
    extension,
    blob: file,
    status: 'pending',
    updated_at: Date.now(),
  };
  try {
    await savePending(pending);
    pendingUploads = await pendingForStudent();
    chooseStudentAssignment(assignment);
    await uploadPending(pending);
  } catch (error) {
    message(`Could not save this video in browser storage: ${error.message}`, true);
  }
};

$('student-video').addEventListener('loadedmetadata', event => {
  $('student-duration').textContent = formatStudentTime(event.currentTarget.duration);
});
$('student-video').addEventListener('timeupdate', event => {
  const video = event.currentTarget;
  $('student-current-time').textContent = formatStudentTime(video.currentTime);
  $('student-duration').textContent = formatStudentTime(video.duration);
  $('student-seek').value = Number.isFinite(video.duration) && video.duration > 0 ? video.currentTime / video.duration : 0;
});

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

boot().catch(error => message(error.message, true));
