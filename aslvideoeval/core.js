export const uid = () => crypto.randomUUID();
export const clone = value => structuredClone(value);
export function clock(seconds, precise = false) {
  const value = Math.max(0, Number(seconds) || 0);
  const mins = String(Math.floor(value / 60)).padStart(2, '0');
  const secs = String(Math.floor(value % 60)).padStart(2, '0');
  return `${mins}:${secs}${precise ? '.' + String(Math.floor((value % 1) * 1000)).padStart(3, '0') : ''}`;
}
export function normalize(value) {
  return String(value || '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
export function searchClips(entries, query, filter = 'recent', tags = []) {
  const normalized = normalize(query);
  const tokens = normalized.split(' ').filter(Boolean);
  const selected = (Array.isArray(tags) ? tags : []).map(normalize).filter(Boolean);
  return entries.filter(entry => {
    if (filter !== 'all' && (entry.inbox || entry.archived)) return false;
    if (filter === 'favorites' && !entry.favorite) return false;
    if (selected.length && !selected.some(tag => (entry.tags || []).some(item => normalize(item) === tag))) return false;
    const all = normalize([entry.title, entry.description, entry.category, ...(entry.tags || []), ...(entry.aliases || [])].join(' '));
    return tokens.every(token => all.includes(token));
  }).map(entry => {
    const title = normalize(entry.title);
    const tags = normalize([...(entry.tags || []), ...(entry.aliases || [])].join(' '));
    const score = normalized ? (title === normalized ? 100 : title.includes(normalized) ? 50 : 0) + tokens.reduce((sum, token) => sum + (title.includes(token) ? 10 : tags.includes(token) ? 5 : 1), 0) : 0;
    return {entry, score};
  }).sort((a, b) => b.score - a.score || (b.entry.used_at || 0) - (a.entry.used_at || 0) || a.entry.title.localeCompare(b.entry.title)).map(item => item.entry);
}
export function makeFeedback(start, end = start) {
  return {id: uid(), start, end, purpose: 'Correction', category: 'General feedback', label: '', note: '', private_note: '', clips: []};
}
export function keepOneSectionClip(state) {
  let changed = false;
  for (const submission of state?.submissions || []) {
    for (const item of submission?.feedback || []) {
      if (Array.isArray(item?.clips) && item.clips.length > 1) {
        item.clips = item.clips.slice(-1);
        changed = true;
      }
    }
  }
  return changed;
}
export function feedbackNoteEnd(start, end, plannedEnd) {
  const marked = end > start ? end : start;
  return Math.max(plannedEnd ?? marked, start + 2);
}
export function feedbackTimestamp(item) {
  const stamp = value => {
    const seconds = Math.max(0, Math.floor(value));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  return item.end > item.start ? `${stamp(item.start)} – ${stamp(item.end)}` : stamp(item.start);
}
export function studentPreviewTimeline(feedback, duration, clipDuration) {
  const completed = (feedback || []).filter(item => (item.note || '').trim() || item.clips?.length).sort((a, b) => a.start - b.start);
  if (!completed.length) return null;
  let cursor = 0;
  // Export renders each section independently, including repeated context for
  // nearby feedback. Use the same output clock instead of playing the gaps.
  const items = completed.map(item => {
    const sourceStart = Math.max(0, item.start - 3);
    const clipLength = item.clips?.length ? Math.max(0, clipDuration(item.clips.at(-1))) : 0;
    const sourceEnd = Math.min(duration, item.clips?.length ? item.end : feedbackNoteEnd(item.start, item.end));
    const visible = item.clips?.length ? Math.max(sourceEnd - item.start, clipLength) : feedbackNoteEnd(item.start, item.end) - item.start;
    const sectionStart = cursor, start = sectionStart + item.start - sourceStart;
    const end = start + visible;
    cursor = end;
    return {item, sectionStart, start, end, sourceStart, sourceEnd, clipLength};
  });
  return {start: 0, end: cursor, items};
}
export function previewSectionAt(timeline, time) {
  return timeline.items.find(row => time < row.end) || timeline.items.at(-1);
}
export function previewStudentTime(timeline, time, duration) {
  const section = previewSectionAt(timeline, time);
  const source = section.sourceStart + Math.max(0, time - section.sectionStart);
  const end = Math.min(duration, section.sourceEnd);
  return {student: Math.min(source, end), holding: source >= end};
}
export function previewOutputTime(timeline, student, current, feedbackId) {
  const section = timeline.items.find(row => row.item.id === feedbackId) || previewSectionAt(timeline, current);
  return section.sectionStart + Math.max(0, Math.min(student, section.sourceEnd) - section.sourceStart);
}
export function isFinished(submission) {
  return submission.feedback.every(item => item.note.trim() || item.clips.length);
}
export function canExport(submission) {
  if (!submission) return false;
  const sections = (submission.feedback || []).some(item => String(item.note || '').trim() || (item.clips || []).length);
  return sections || !!submission.correction?.asset_id;
}
function pathParts(value) {
  const path = String(value || '').replace(/\\/g, '/');
  const parts = path.split('/').filter(Boolean);
  if (path.startsWith('//')) return ['//', ...parts];
  return path.startsWith('/') ? ['/', ...parts] : parts;
}
export function isEvaluatedFolder(folder) {
  return pathParts(folder).some(part => part.toLowerCase() === 'evaluated');
}
function samePath(left, right) {
  if (left.length !== right.length || !left.length) return false;
  const windows = left[0] === '//' || right[0] === '//' || /^[A-Za-z]:/.test(left[0]) || /^[A-Za-z]:/.test(right[0]);
  const same = (a, b) => windows ? a.toLowerCase() === b.toLowerCase() : a === b;
  return left.every((part, index) => same(part, right[index]));
}
export function videoInSelectedFolder(asset, folder) {
  const selected = pathParts(folder);
  const file = pathParts(asset?.source_path);
  const tagged = pathParts(asset?.source_folder);
  if (!selected.length) return !file.length && !tagged.length;
  if (file.length) return file.length === selected.length + 1 && samePath(file.slice(0, -1), selected);
  return samePath(tagged, selected);
}
export function visibleInSelectedFolder(submission, asset, folder, assignmentDemo = false) {
  if (asset?.source_missing && !submission?.cleaned_at) return false;
  if (String(folder || '')) return videoInSelectedFolder(asset, folder);
  return !!(submission?.demo || assignmentDemo) || videoInSelectedFolder(asset, '');
}
export function pathUnderVideo(fullPath) {
  const parts = String(fullPath || '').split(/[\\/]/).filter(Boolean);
  const index = parts.findIndex(part => part.toLowerCase() === 'video');
  if (index < 0 || index >= parts.length - 1) return '';
  const relative = parts.slice(index + 1);
  if (relative.length > 1 && /\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(relative.at(-1))) relative.pop();
  return relative.join(' / ');
}
export const DEFAULT_PAD = {confirm: 0, back: 1, feedback: 2, library: 3, /* markIn: 4, markOut: 5, */ rewind: 6, forward: 7, menu: 9};
export const DEFAULT_KEYS = {/* markIn: 'i', markOut: 'o', */ feedback: 'm', record: 'r', library: 'f', previous: 'p', next: 'n', browseVideos: 'b', exportFeedback: 'e'};
