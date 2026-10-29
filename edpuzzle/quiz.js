export function parseYoutubeUrl(value) {
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let id;
  if (host === 'youtu.be') id = url.pathname.split('/')[1];
  else if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host)) {
    id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(embed|shorts|live)\/([^/]+)/.exec(url.pathname)?.[2];
  }
  return /^[\w-]{11}$/.test(id ?? '') ? id : null;
}

export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function parseTime(value) {
  const match = /^(\d+):([0-5]\d)$/.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function dueQuestion(questions, answered, time) {
  return [...questions].sort((a, b) => a.time - b.time).find(q => !answered.has(q.id) && q.time <= time);
}

export function playbackLimit(questions, answered, duration) {
  const next = dueQuestion(questions, answered, Infinity);
  return Math.max(0, Math.min(duration, next?.time ?? duration));
}

export function validLesson(lesson) {
  return lesson && typeof lesson.title === 'string' && /^[\w-]{11}$/.test(lesson.videoId)
    && Array.isArray(lesson.questions) && lesson.questions.every(q =>
      typeof q.id === 'string' && typeof q.prompt === 'string' && q.prompt.trim()
      && Number.isFinite(q.time) && q.time >= 0 && Array.isArray(q.options)
      && q.options.length >= 2 && q.options.length <= 4 && q.options.every(o => typeof o === 'string' && o.trim())
      && Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length)
    && new Set(lesson.questions.map(q => q.id)).size === lesson.questions.length;
}
