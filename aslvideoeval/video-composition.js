import {studentPreviewTimeline, feedbackTimestamp} from './core.js';

export const FRAME_RATE = 30;
const even = value => Math.max(2, Math.round(value / 2) * 2);

// Capture the saved final form for one export. Private notes and playback
// position never enter the renderer; visible captions and media do.
export function videoComposition(submission, assets, library, resolveMedia = id => ({url: `/media/${id}`})) {
  const media = id => {
    const asset = assets.get(id);
    if (!asset) throw new Error('A video needed for this review is unavailable.');
    const trimStart = Number(asset.trim_start) || 0;
    const trimEnd = Number(asset.trim_end) || Number(asset.duration) || 0;
    return {id, ...resolveMedia(id), duration: Math.max(0, trimEnd - trimStart),
      sourceDuration: asset.duration, trimStart, trimEnd, width: asset.width, height: asset.height};
  };
  const subtitle = id => (library.find(entry => entry.id === id)?.description || '').trim();
  return {
    id: submission.id,
    student: media(submission.asset_id),
    feedback: submission.feedback.filter(item => item.note?.trim() || item.clips?.length).map(item => {
      const clip = item.clips?.at(-1);
      return {id: item.id, start: item.start, end: item.end, note: (item.note || '').trim(),
        clips: clip ? [{asset_id: clip.asset_id, media: media(clip.asset_id), subtitle: clip.subtitle ?? subtitle(clip.library_id)}] : []};
    }),
    correction: submission.correction?.asset_id ? {media: media(submission.correction.asset_id),
      subtitle: (submission.correction.note || '').trim() || submission.correction.subtitle || subtitle(submission.correction.library_id)} : null,
  };
}

export function compositionPlan(composition) {
  const student = composition.student;
  const timeline = studentPreviewTimeline(composition.feedback, student.duration, clip => clip.media.duration);
  const sections = (timeline?.items || []).map(row => {
    const teacher = row.item.clips[0]?.media;
    let sw = even(student.width), sh = even(student.height);
    if (!teacher && sh > 720) {sw = even(sw * 720 / sh); sh = 720;}
    const tw = teacher ? even(teacher.width) : 0, th = teacher ? even(teacher.height) : 0;
    if (teacher && tw * th < sw * sh) {sw = even(sw * th / sh); sh = th;}
    return {...row, teacher, sw, sh, tw, th, width: sw + tw, height: Math.max(sh, th),
      timestamp: feedbackTimestamp(row.item), caption: row.item.clips[0]?.subtitle || row.item.note};
  });
  const tail = composition.correction;
  const width = Math.max(...sections.map(row => row.width), tail ? even(tail.media.width) : 2);
  const height = Math.max(...sections.map(row => row.height), tail ? even(tail.media.height) : 2);
  // Each independent section has a whole number of frames. The same rounded
  // boundaries determine the final MP4 duration independently of live preview.
  let frames = 0;
  for (const row of sections) {
    const length = row.end - row.sectionStart, context = row.start - row.sectionStart;
    row.sectionStart = frames / FRAME_RATE;
    row.start = row.sectionStart + Math.ceil(context * FRAME_RATE - 1e-6) / FRAME_RATE;
    row.frames = Math.max(1, Math.ceil(length * FRAME_RATE - 1e-6));
    frames += row.frames;
    row.end = frames / FRAME_RATE;
  }
  const tailFrames = tail ? Math.max(1, Math.ceil(tail.media.duration * FRAME_RATE - 1e-6)) : 0;
  return {sections, width, height, tail, tailFrames, frames: frames + tailFrames, duration: (frames + tailFrames) / FRAME_RATE};
}

export function wrapCaption(context, text, width) {
  const lines = [];
  for (const paragraph of String(text).split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && context.measureText(line + ' ' + word).width <= width) {line += ' ' + word; continue;}
      if (line) {lines.push(line); line = '';}
      for (const character of word) {
        if (line && context.measureText(line + character).width > width) {lines.push(line); line = '';}
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function drawCaption(context, text, width, height, timestamp = false) {
  if (!text) return;
  let font = Math.max(16, Math.round(height * .045));
  const margin = Math.min(24, width * .04), available = Math.max(1, width - margin * 2 - 8);
  let lines;
  do {
    context.font = `${font}px Arial, sans-serif`;
    lines = wrapCaption(context, text, available);
    if (lines.length * font * 1.25 < height * (timestamp ? .25 : .65) || font <= 8) break;
    font--;
  } while (true);
  const lineHeight = font * 1.25;
  const top = timestamp ? margin : Math.max(margin, height - margin - lines.length * lineHeight);
  context.textBaseline = 'top'; context.textAlign = timestamp ? 'left' : 'center';
  context.lineJoin = 'round'; context.lineWidth = Math.max(2, font * .12);
  lines.forEach((line, index) => {
    const x = timestamp ? margin : width / 2, y = top + index * lineHeight;
    context.strokeStyle = '#000'; context.fillStyle = '#fff';
    context.strokeText(line, x, y); context.fillText(line, x, y);
  });
}
