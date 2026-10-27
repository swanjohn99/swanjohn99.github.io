import {Input, ALL_FORMATS, UrlSource, BlobSource, CanvasSink, Output, Mp4OutputFormat, BufferTarget, CanvasSource, canEncodeVideo} from './vendor/mediabunny.mjs';
import {compositionPlan, drawCaption, FRAME_RATE} from './video-composition.js';

self.onmessage = async ({data: composition}) => {
  const inputs = new Map();
  let output;
  try {
    // Use decoded dimensions/durations, including rotation and video tracks that
    // end before audio. The latter holds its final picture through the file end.
    const open = async media => {
      if (inputs.has(media.id)) {const entry = inputs.get(media.id); Object.assign(media, entry.metadata); return entry;}
      const input = new Input({formats: ALL_FORMATS, source: media.file ? new BlobSource(media.file) : new UrlSource(media.url, {maxCacheSize: 16 * 1024 * 1024})});
      const entry = {input}; inputs.set(media.id, entry);
      const track = await input.getPrimaryVideoTrack();
      if (!track || !await track.canDecode()) throw new Error('This browser cannot decode one of the review videos. Use Chrome or Edge with support for the source codec.');
      Object.assign(entry, {sink: new CanvasSink(track, {poolSize: 2}), first: await track.getFirstTimestamp(), end: await track.computeDuration()});
      media.width = await track.getDisplayWidth(); media.height = await track.getDisplayHeight();
      const sourceDuration = Math.max(media.sourceDuration || 0, await input.computeDuration());
      media.duration = media.trimEnd ? Math.max(0, Math.min(media.trimEnd, sourceDuration) - (media.trimStart || 0)) : sourceDuration;
      entry.metadata = {width: media.width, height: media.height, duration: media.duration};
      return entry;
    };
    const allMedia = [composition.student, ...composition.feedback.flatMap(row => row.clips.map(clip => clip.media)), composition.correction?.media].filter(Boolean);
    for (const media of allMedia) await open(media);
    const plan = compositionPlan(composition);
    const {width, height} = plan;
    const bitrate = Math.max(1_000_000, Math.min(20_000_000, width * height * 4));
    if (!await canEncodeVideo('avc', {width, height, bitrate})) throw new Error('This browser cannot encode H.264 at this video size. Try current Chrome or Edge on this computer.');
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d', {alpha: false});
    const target = new BufferTarget();
    output = new Output({format: new Mp4OutputFormat({fastStart: 'in-memory'}), target});
    const source = new CanvasSource(canvas, {codec: 'avc', bitrate, keyFrameInterval: 2});
    output.addVideoTrack(source, {frameRate: FRAME_RATE});
    await output.start();
    let frame = 0;
    const encode = async () => {
      await source.add(frame / FRAME_RATE, 1 / FRAME_RATE);
      frame++;
      if (frame % 15 === 0) self.postMessage({type: 'progress', value: frame / plan.frames});
    };
    async function* timestamps(row, teacher = false) {
      const media = teacher ? row.teacher : composition.student;
      const entry = inputs.get(media.id);
      for (let index = 0; index < row.frames; index++) {
        const elapsed = index / FRAME_RATE;
        const time = teacher ? Math.max(0, elapsed - (row.start - row.sectionStart)) : Math.min(row.sourceStart + elapsed, row.sourceEnd);
        yield Math.max(entry.first, Math.min(time + (media.trimStart || 0), entry.end - .000001));
      }
    }
    for (const row of plan.sections) {
      const studentFrames = inputs.get(composition.student.id).sink.canvasesAtTimestamps(timestamps(row));
      const teacherFrames = row.teacher ? inputs.get(row.teacher.id).sink.canvasesAtTimestamps(timestamps(row, true)) : null;
      try {
        for (let index = 0; index < row.frames; index++) {
          const student = (await studentFrames.next()).value;
          const teacher = teacherFrames ? (await teacherFrames.next()).value : null;
          if (!student || (teacherFrames && !teacher)) throw new Error('A video frame could not be decoded.');
          context.fillStyle = '#000'; context.fillRect(0, 0, width, height);
          const active = index / FRAME_RATE >= row.start - row.sectionStart - 1e-6;
          if (active && teacher) {
            const left = (width - row.width) / 2;
            context.drawImage(student.canvas, left, (height - row.sh) / 2, row.sw, row.sh);
            context.drawImage(teacher.canvas, left + row.sw, (height - row.th) / 2, row.tw, row.th);
          } else {
            const scale = Math.min(row.width / row.sw, row.height / row.sh);
            const w = row.sw * scale, h = row.sh * scale;
            context.drawImage(student.canvas, (width - w) / 2, (height - h) / 2, w, h);
          }
          drawCaption(context, row.timestamp, width, height, true);
          if (active) drawCaption(context, row.caption, width, height);
          await encode();
        }
      } finally {await studentFrames.return(); await teacherFrames?.return();}
    }
    if (plan.tail) {
      const media = plan.tail.media, entry = inputs.get(media.id);
      function* times() {for (let index = 0; index < plan.tailFrames; index++) yield Math.max(entry.first, Math.min(index / FRAME_RATE + (media.trimStart || 0), entry.end - .000001));}
      for await (const picture of entry.sink.canvasesAtTimestamps(times())) {
        if (!picture) throw new Error('The final correction could not be decoded.');
        context.fillStyle = '#000'; context.fillRect(0, 0, width, height);
        const scale = Math.min(width / media.width, height / media.height), w = media.width * scale, h = media.height * scale;
        context.drawImage(picture.canvas, (width - w) / 2, (height - h) / 2, w, h);
        drawCaption(context, plan.tail.subtitle, width, height);
        await encode();
      }
    }
    source.close(); await output.finalize();
    self.postMessage({type: 'ready', buffer: target.buffer, plan}, [target.buffer]);
  } catch (error) {
    try {await output?.cancel();} catch {}
    self.postMessage({type: 'error', message: error.message || 'Video rendering failed.'});
  } finally {for (const {input} of inputs.values()) input.dispose();}
};
