const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 10000;
const MAX_ARCHIVE_CONTENT = 512 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
const DOCUMENT_SUFFIXES = new Set(['.xml', '.json', '.csv', '.html', '.htm', '.txt']);
const decoder = new TextDecoder();

function extension(name) {
  const match = String(name).toLowerCase().match(/(\.[^./]+)$/);
  return match?.[1] || '';
}

function cleanText(value, maximum = 10000) {
  if (value == null) return '';
  const document = new DOMParser().parseFromString(`<body>${String(value)}</body>`, 'text/html');
  document.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  document.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6').forEach(node => node.append('\n'));
  return (document.body?.textContent || String(value))
    .replace(/\0/g, '').replace(/[ \t\f\v]+/g, ' ').replace(/ *\r?\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, maximum);
}

function firstValue(record, ...keys) {
  const entries = Object.fromEntries(Object.entries(record || {}).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const value = entries[key.toLowerCase()];
    if (value != null && value !== '' && (!Array.isArray(value) || value.length)) return value;
  }
  return '';
}

function safeName(name) {
  const normalized = String(name).replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = normalized.split('/');
  return normalized && parts.every(part => part && part !== '.' && part !== '..') ? normalized : null;
}

function uint32(view, offset) {
  return view.getUint32(offset, true);
}

async function decompress(bytes, format, maximum = MAX_ARCHIVE_CONTENT) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot open compressed LMS exports. Update Chrome, Edge, or Firefox and try again.');
  }
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    const reader = stream.getReader(), chunks = [];
    let length = 0;
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximum) {
        await reader.cancel();
        throw new Error('The expanded LMS package is too large.');
      }
      chunks.push(value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } catch (error) {
    if (error.message === 'The expanded LMS package is too large.') throw error;
    throw new Error('The compressed LMS export could not be opened in this browser.', {cause: error});
  }
}

function addDocument(documents, name, bytes, totals) {
  const normalized = safeName(name);
  if (!normalized || !DOCUMENT_SUFFIXES.has(extension(normalized)) || bytes.length > MAX_DOCUMENT_BYTES) return;
  totals.files += 1;
  totals.bytes += bytes.length;
  if (totals.files > MAX_ARCHIVE_FILES) throw new Error('This package contains too many files.');
  if (totals.bytes > MAX_ARCHIVE_CONTENT) throw new Error('The expanded LMS package is too large.');
  documents.set(normalized, bytes);
}

async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index -= 1) {
    if (uint32(view, index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) throw new Error('The ZIP export is invalid or uses unsupported ZIP64 metadata.');
  const count = view.getUint16(end + 10, true);
  if (count > MAX_ARCHIVE_FILES) throw new Error('This package contains too many files.');
  let cursor = uint32(view, end + 16);
  const documents = new Map(), totals = {files: 0, bytes: 0};
  let expanded = 0;
  for (let entry = 0; entry < count; entry += 1) {
    if (cursor + 46 > bytes.length || uint32(view, cursor) !== 0x02014b50) throw new Error('The ZIP directory is invalid.');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = uint32(view, cursor + 20);
    const size = uint32(view, cursor + 24);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = uint32(view, cursor + 42);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new Error('Password-protected LMS packages are not supported.');
    expanded += size;
    if (expanded > MAX_ARCHIVE_CONTENT) throw new Error('The expanded LMS package is too large.');
    if (!safeName(name) || !DOCUMENT_SUFFIXES.has(extension(name)) || size > MAX_DOCUMENT_BYTES) continue;
    if (localOffset + 30 > bytes.length || uint32(view, localOffset) !== 0x04034b50) throw new Error('The ZIP entry is invalid.');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(start, start + compressedSize);
    let content;
    if (method === 0) content = compressed.slice();
    else if (method === 8) content = await decompress(compressed, 'deflate-raw', size);
    else throw new Error(`The ZIP uses unsupported compression method ${method}.`);
    if (content.length !== size) throw new Error('A file in the ZIP export is incomplete.');
    addDocument(documents, name, content, totals);
  }
  return documents;
}

function readTar(bytes) {
  const documents = new Map(), totals = {files: 0, bytes: 0};
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) break;
    const field = (start, end) => decoder.decode(header.subarray(start, end)).replace(/\0.*$/, '').trim();
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join('/');
    const size = Number.parseInt(field(124, 136) || '0', 8);
    const type = field(156, 157);
    if (!Number.isFinite(size) || size < 0 || offset + 512 + size > bytes.length) throw new Error('The Moodle backup archive is invalid.');
    if (type === '' || type === '0') addDocument(documents, name, bytes.subarray(offset + 512, offset + 512 + size), totals);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return documents;
}

async function readPackage(file) {
  if (!file?.size) throw new Error('Choose an LMS export file to import.');
  if (file.size > MAX_PACKAGE_BYTES) throw new Error('The LMS export is larger than the 256 MB import limit.');
  let bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return readZip(bytes);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await decompress(bytes, 'gzip');
  if (decoder.decode(bytes.subarray(257, 262)) === 'ustar') return readTar(bytes);
  if (!DOCUMENT_SUFFIXES.has(extension(file.name))) throw new Error('Choose a ZIP, IMSCC, MBZ, XML, JSON, or CSV LMS export.');
  return new Map([[file.name, bytes]]);
}

function parseXml(bytes, label) {
  const document = new DOMParser().parseFromString(decoder.decode(bytes), 'application/xml');
  if (document.querySelector('parsererror')) throw new Error(`The ${label} XML is invalid.`);
  return document.documentElement;
}

const localName = node => (node?.localName || node?.nodeName || '').toLowerCase();
const children = node => [...(node?.children || [])];
const descendants = (node, name) => [node, ...node.querySelectorAll('*')].filter(item => localName(item) === name.toLowerCase());
const child = (node, name) => children(node).find(item => localName(item) === name.toLowerCase());
const nodeText = (node, name) => cleanText((name ? child(node, name) : node)?.textContent || '');
const textOf = node => nodeText(node);

function resolveDocument(documents, base, relative) {
  const clean = String(relative).replace('$IMS-CC-FILEBASE$/', '').replace(/^\/+/, '');
  const parts = [...base.split('/').filter(Boolean), ...clean.split('/')];
  const resolved = [];
  for (const part of parts) part === '..' ? resolved.pop() : part !== '.' && resolved.push(part);
  return documents.get(resolved.join('/')) || documents.get(clean);
}

function resourceDetails(resource, documents, base) {
  let title = nodeText(resource, 'title'), description = nodeText(resource, 'description');
  const candidates = [resource.getAttribute('href'), ...descendants(resource, 'file').map(item => item.getAttribute('href'))].filter(Boolean);
  for (const relative of candidates) {
    const bytes = resolveDocument(documents, base, relative);
    if (!bytes || !['.xml', '.html', '.htm', '.txt'].includes(extension(relative))) continue;
    if (extension(relative) === '.xml') {
      let root;
      try { root = parseXml(bytes, 'course resource'); } catch { continue; }
      title ||= descendants(root, 'title').map(textOf).find(Boolean) || descendants(root, 'name').map(textOf).find(Boolean) || '';
      for (const key of ['description', 'instructions', 'text', 'intro']) description ||= descendants(root, key).map(textOf).find(Boolean) || '';
    } else description ||= cleanText(decoder.decode(bytes));
    if (title && description) break;
  }
  return {title, instructions: description, target: ''};
}

function isAssignmentResource(resource) {
  const kind = `${resource.getAttribute('type') || ''} ${resource.getAttribute('href') || ''}`.toLowerCase();
  return ['assignment', 'assessment', 'imsqti', 'quiz', 'discussion', 'lti', 'externaltool'].some(marker => kind.includes(marker));
}

function parseCommonCartridge(documents) {
  const manifestName = [...documents.keys()].find(name => name.toLowerCase().endsWith('imsmanifest.xml'));
  if (!manifestName) return null;
  const root = parseXml(documents.get(manifestName), 'IMS manifest');
  if (localName(root) !== 'manifest') return null;
  const base = manifestName.includes('/') ? manifestName.slice(0, manifestName.lastIndexOf('/')) : '';
  const resources = new Map(descendants(root, 'resource').filter(item => item.getAttribute('identifier'))
    .map(item => [item.getAttribute('identifier'), item]));
  const organization = descendants(root, 'organization')[0];
  const courseName = nodeText(organization, 'title') || descendants(root, 'title').map(textOf).find(Boolean) || 'Imported LMS course';
  const units = [], assigned = new Set();
  const assignmentsBelow = item => {
    const found = [];
    for (const nested of descendants(item, 'item')) {
      const reference = nested.getAttribute('identifierref'), resource = resources.get(reference);
      if (!resource || !isAssignmentResource(resource) || assigned.has(reference)) continue;
      const assignment = resourceDetails(resource, documents, base);
      assignment.title = nodeText(nested, 'title') || assignment.title;
      if (assignment.title) { assigned.add(reference); found.push(assignment); }
    }
    return found;
  };
  const moduleName = [...documents.keys()].find(name => name.toLowerCase().endsWith('course_settings/module_meta.xml'));
  if (moduleName) {
    const moduleRoot = parseXml(documents.get(moduleName), 'course module');
    for (const module of descendants(moduleRoot, 'module')) {
      const found = [];
      for (const item of descendants(module, 'item')) {
        const reference = item.getAttribute('identifierref') || nodeText(item, 'identifierref');
        const contentType = nodeText(item, 'content_type').toLowerCase(), resource = resources.get(reference);
        if (!reference || assigned.has(reference) || !resource) continue;
        if (!isAssignmentResource(resource) && !['assignment', 'quiz', 'discussion', 'externaltool', 'contextmoduleexternaltool'].includes(contentType)) continue;
        const assignment = resourceDetails(resource, documents, base);
        assignment.title = nodeText(item, 'title') || assignment.title;
        if (assignment.title) { assigned.add(reference); found.push(assignment); }
      }
      if (found.length) units.push({title: nodeText(module, 'title') || 'Imported assignments', assignments: found});
    }
  }
  if (organization && !units.length) {
    for (const item of children(organization).filter(node => localName(node) === 'item')) {
      const found = assignmentsBelow(item);
      if (found.length) units.push({title: nodeText(item, 'title') || 'Imported assignments', assignments: found});
    }
  }
  const remaining = [];
  for (const [reference, resource] of resources) {
    if (assigned.has(reference) || !isAssignmentResource(resource)) continue;
    const assignment = resourceDetails(resource, documents, base);
    if (assignment.title) remaining.push(assignment);
  }
  if (remaining.length) units.push({title: 'Imported assignments', assignments: remaining});
  if (!units.length) throw new Error('The IMS/Common Cartridge package does not contain recognizable assignments.');
  return {format: 'IMS Common Cartridge', courses: [{name: courseName, units}]};
}

function parseMoodle(documents) {
  const backup = [...documents.keys()].find(name => name.toLowerCase().endsWith('moodle_backup.xml'));
  const activities = [...documents].filter(([name]) => /(^|\/)activities\/[^/]+\/(assign|quiz|lesson|workshop|forum|choice|data)\.xml$/i.test(name));
  if (!backup && !activities.length) return null;
  let courseName = 'Imported Moodle course';
  const course = [...documents].find(([name]) => /(^|\/)course\/course\.xml$/i.test(name));
  if (course) {
    const root = parseXml(course[1], 'Moodle course');
    courseName = ['fullname', 'shortname'].flatMap(key => descendants(root, key)).map(textOf).find(Boolean) || courseName;
  }
  const sectionNames = new Map();
  for (const [name, bytes] of documents) {
    if (!/(^|\/)sections\/[^/]+\/section\.xml$/i.test(name)) continue;
    const root = parseXml(bytes, 'Moodle section');
    const id = ['sectionid', 'id'].flatMap(key => descendants(root, key)).map(textOf).find(Boolean);
    const title = descendants(root, 'name').map(textOf).find(Boolean) || 'Course content';
    if (id) sectionNames.set(id, title);
  }
  const grouped = new Map();
  for (const [, bytes] of activities) {
    const root = parseXml(bytes, 'Moodle activity');
    const activity = ['assign', 'quiz', 'lesson', 'workshop', 'forum', 'choice', 'data']
      .flatMap(key => descendants(root, key)).find(Boolean) || root;
    const title = descendants(activity, 'name').map(textOf).find(Boolean);
    if (!title) continue;
    const instructions = ['intro', 'description', 'instructions'].flatMap(key => descendants(activity, key)).map(textOf).find(Boolean) || '';
    const sectionId = ['sectionid', 'section'].flatMap(key => descendants(root, key)).map(textOf).find(Boolean) || '';
    const unit = sectionNames.get(sectionId) || 'Imported assignments';
    if (!grouped.has(unit)) grouped.set(unit, []);
    grouped.get(unit).push({title, instructions, target: ''});
  }
  if (!grouped.size) throw new Error('The Moodle backup does not contain recognizable assignments or activities.');
  return {format: 'Moodle backup', courses: [{name: courseName, units: [...grouped].map(([title, assignments]) => ({title, assignments}))}]};
}

function normalizedJsonCourses(value) {
  const source = Array.isArray(value) ? value : value?.courses;
  if (!Array.isArray(source)) return [];
  const courses = [];
  for (const course of source) {
    const name = cleanText(firstValue(course, 'name', 'title', 'course_name'), 200);
    const unitSource = firstValue(course, 'units', 'modules', 'topics', 'sections');
    if (!name || !Array.isArray(unitSource)) continue;
    const units = [];
    for (const unit of unitSource) {
      const assignmentSource = firstValue(unit, 'assignments', 'coursework', 'activities', 'items');
      if (!Array.isArray(assignmentSource)) continue;
      const assignments = assignmentSource.map(item => ({
        title: cleanText(firstValue(item, 'title', 'name', 'assignment_name'), 200),
        instructions: cleanText(firstValue(item, 'instructions', 'description', 'text', 'details')),
        target: cleanText(firstValue(item, 'target', 'prompt')),
      })).filter(item => item.title);
      if (assignments.length) units.push({title: cleanText(firstValue(unit, 'title', 'name', 'unit_name', 'module_name'), 200) || 'Imported assignments', assignments});
    }
    if (units.length) courses.push({name, units});
  }
  return courses;
}

function parseJsonDocuments(documents) {
  const parsed = [];
  for (const [name, bytes] of documents) {
    if (extension(name) !== '.json') continue;
    let value;
    try { value = JSON.parse(decoder.decode(bytes)); } catch { continue; }
    parsed.push([name, value]);
    const courses = normalizedJsonCourses(value);
    if (courses.length) return {format: 'LMS JSON export', courses};
  }
  const courseNames = new Map(), topics = new Map(), work = [];
  for (const [name, value] of parsed) {
    for (const record of Array.isArray(value) ? value : [value]) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      const courseId = String(firstValue(record, 'courseId', 'course_id', 'ownerId') || '');
      const title = cleanText(firstValue(record, 'title', 'name'), 200);
      const inferred = name.split('/').slice(0, -1).reverse().find(part => !['classroom', 'courses', 'coursework', 'assignments', 'topics'].includes(part.toLowerCase())) || '';
      if (('courseState' in record || 'course_state' in record) && title) {
        courseNames.set(String(firstValue(record, 'id', 'courseId') || courseId || inferred), title);
        continue;
      }
      const topicId = String(firstValue(record, 'topicId', 'topic_id', 'id') || '');
      if (name.split('/').at(-1).toLowerCase().includes('topic') && title && topicId) { topics.set(`${courseId}:${topicId}`, title); continue; }
      const instructions = cleanText(firstValue(record, 'description', 'instructions', 'text', 'details'));
      if (title && (instructions || ['workType', 'work_type', 'dueDate', 'due_date', 'materials', 'maxPoints', 'state'].some(key => key in record))) {
        work.push({courseId: courseId || inferred || 'course', topicId, inferred, title, instructions, target: ''});
      }
    }
  }
  if (!work.length) return null;
  const grouped = new Map();
  for (const item of work) {
    const course = courseNames.get(item.courseId) || item.inferred || 'Imported Google Classroom course';
    const unit = topics.get(`${item.courseId}:${item.topicId}`) || 'Imported assignments';
    if (!grouped.has(course)) grouped.set(course, new Map());
    if (!grouped.get(course).has(unit)) grouped.get(course).set(unit, []);
    grouped.get(course).get(unit).push({title: item.title, instructions: item.instructions, target: ''});
  }
  return {format: 'Google Classroom Takeout', courses: [...grouped].map(([name, units]) => ({name,
    units: [...units].map(([title, assignments]) => ({title, assignments}))}))};
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let index = 0; index <= text.length; index += 1) {
    const character = text[index] ?? '\n';
    if (quoted && character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === ',') { row.push(field); field = ''; }
    else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); field = ''; if (row.some(value => value !== '')) rows.push(row); row = [];
    } else field += character;
  }
  if (quoted) throw new Error('A CSV file in the export has an unterminated quoted value.');
  const [headers = [], ...values] = rows;
  return values.map(items => Object.fromEntries(headers.map((header, index) => [header.trim(), items[index] || ''])));
}

function parseCsvDocuments(documents, fallbackName) {
  const rows = [];
  for (const [name, bytes] of documents) {
    if (extension(name) !== '.csv') continue;
    for (const record of parseCsv(decoder.decode(bytes))) {
      const title = cleanText(firstValue(record, 'assignment', 'assignment_title', 'title', 'name'), 200);
      if (!title) continue;
      rows.push({course: cleanText(firstValue(record, 'course', 'class', 'course_name', 'class_name'), 200) || fallbackName,
        unit: cleanText(firstValue(record, 'unit', 'module', 'topic', 'section'), 200) || 'Imported assignments', title,
        instructions: cleanText(firstValue(record, 'instructions', 'description', 'details', 'text')),
        target: cleanText(firstValue(record, 'target', 'prompt', 'sentence'))});
    }
  }
  if (!rows.length) return null;
  const grouped = new Map();
  for (const item of rows) {
    if (!grouped.has(item.course)) grouped.set(item.course, new Map());
    if (!grouped.get(item.course).has(item.unit)) grouped.get(item.course).set(item.unit, []);
    grouped.get(item.course).get(item.unit).push({title: item.title, instructions: item.instructions, target: item.target});
  }
  return {format: 'LMS CSV export', courses: [...grouped].map(([name, units]) => ({name,
    units: [...units].map(([title, assignments]) => ({title, assignments}))}))};
}

function normalizeResult(result) {
  const courses = [], seen = new Set();
  for (const course of result?.courses || []) {
    const name = cleanText(course.name, 200) || 'Imported LMS course', units = [];
    for (const unit of course.units || []) {
      const title = cleanText(unit.title, 200) || 'Imported assignments', assignments = [];
      for (const assignment of unit.assignments || []) {
        const item = {title: cleanText(assignment.title, 200), instructions: cleanText(assignment.instructions), target: cleanText(assignment.target)};
        const fingerprint = `${name.toLowerCase()}\0${title.toLowerCase()}\0${item.title.toLowerCase()}`;
        if (!item.title || seen.has(fingerprint)) continue;
        seen.add(fingerprint); assignments.push(item);
      }
      if (assignments.length) units.push({title, assignments});
    }
    if (units.length) courses.push({name, units});
  }
  if (!courses.length) throw new Error('No recognizable classes, units, and assignments were found in this export.');
  const assignmentCount = courses.flatMap(course => course.units).flatMap(unit => unit.assignments).length;
  if (assignmentCount > 10000) throw new Error('This export contains more than 10,000 assignments. Import smaller course packages.');
  return {format: cleanText(result.format, 100) || 'LMS export', courses};
}

export async function parseLmsPackage(file, onProgress = () => {}) {
  onProgress(`Opening ${file.name} locally…`);
  const documents = await readPackage(file);
  if (!documents.size) throw new Error('The LMS export does not contain readable course metadata.');
  onProgress('Reading classes, units, and assignments locally…');
  let result = parseCommonCartridge(documents);
  result ||= parseMoodle(documents);
  result ||= parseJsonDocuments(documents);
  const fallback = cleanText(file.name.replace(/\.[^.]+$/, ''), 200) || 'Imported LMS course';
  result ||= parseCsvDocuments(documents, fallback);
  if (!result) throw new Error('This archive is not a recognized IMS/Common Cartridge, Moodle, Google Classroom, CSV, or JSON export.');
  return normalizeResult(result);
}
