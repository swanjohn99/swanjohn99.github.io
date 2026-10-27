import {compositionPlan} from './video-composition.js';

export function renderVideo(composition, {signal, onProgress = () => {}} = {}) {
  if (!globalThis.isSecureContext || !globalThis.VideoEncoder || !globalThis.VideoDecoder) {
    return Promise.reject(new Error('Video rendering needs a browser with WebCodecs support. Open this app in current Chrome or Edge at localhost, or use HTTPS.'));
  }
  if (signal?.aborted) return Promise.reject(new DOMException('Rendering cancelled.', 'AbortError'));
  const plan = compositionPlan(composition);
  if (!plan.frames) return Promise.reject(new Error('Add a correction clip or written note before rendering feedback.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./video-render-worker.js', import.meta.url), {type: 'module'});
    const finish = (callback, value) => {worker.terminate(); signal?.removeEventListener('abort', abort); callback(value);};
    const abort = () => finish(reject, new DOMException('Rendering cancelled.', 'AbortError'));
    signal?.addEventListener('abort', abort, {once: true});
    worker.onerror = event => finish(reject, new Error(event.message || 'The video renderer stopped.'));
    worker.onmessage = ({data}) => {
      if (data.type === 'progress') onProgress(data.value);
      else if (data.type === 'error') finish(reject, new Error(data.message));
      else if (data.type === 'ready') finish(resolve, {blob: new Blob([data.buffer], {type: 'video/mp4'}), plan: data.plan});
    };
    // Workers resolve media URLs against their own URL, rather than the page.
    const snapshot = structuredClone(composition);
    for (const media of [snapshot.student, ...snapshot.feedback.flatMap(row => row.clips.map(clip => clip.media)), snapshot.correction?.media].filter(Boolean)) {
      if (media.url) media.url = new URL(media.url, location.href).href;
    }
    worker.postMessage(snapshot);
  });
}
