const cacheName = 'still-local-thumbnails-v1';
const thumbnailUrls = new Map();
const thumbnailJobs = new Map();

function thumbnailRequest(key) {
  return new Request(new URL(`/browser-thumbnails/${encodeURIComponent(key)}.jpg`, location.origin));
}

function waitFor(target, success, failure = 'error') {
  return new Promise((resolve, reject) => {
    const done = () => {cleanup(); resolve();};
    const failed = () => {cleanup(); reject(new Error('The browser could not read this video for a thumbnail.'));};
    const cleanup = () => {
      target.removeEventListener(success, done);
      target.removeEventListener(failure, failed);
    };
    target.addEventListener(success, done, {once: true});
    target.addEventListener(failure, failed, {once: true});
  });
}

async function renderThumbnail(videoBlob) {
  const source = URL.createObjectURL(videoBlob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = source;
  try {
    await waitFor(video, 'loadedmetadata');
    const target = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(1, video.duration * .1) : 0;
    if (target > 0) {
      const seeked = waitFor(video, 'seeked');
      video.currentTime = target;
      await seeked;
    } else if (video.readyState < 2) {
      await waitFor(video, 'loadeddata');
    }
    if (!video.videoWidth || !video.videoHeight) throw new Error('The video has no readable picture for a thumbnail.');
    const width = 320, height = 180;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#0b1110'; context.fillRect(0, 0, width, height);
    const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
    const drawWidth = video.videoWidth * scale, drawHeight = video.videoHeight * scale;
    context.drawImage(video, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    const thumbnail = await new Promise((resolve, reject) => canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('The browser could not create a thumbnail.')), 'image/jpeg', .82));
    return thumbnail;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(source);
  }
}

export function cachedThumbnailUrl(key) {
  return thumbnailUrls.get(String(key)) || '';
}

export async function localThumbnailUrl(key, videoBlob = null) {
  key = String(key);
  if (thumbnailUrls.has(key)) return thumbnailUrls.get(key);
  if (!thumbnailJobs.has(key)) {
    thumbnailJobs.set(key, (async () => {
      if (!('caches' in globalThis)) throw new Error('Local thumbnail storage is unavailable.');
      const cache = await caches.open(cacheName);
      const request = thumbnailRequest(key);
      let response = await cache.match(request);
      if (!response) {
        if (!videoBlob) return '';
        const thumbnail = await renderThumbnail(videoBlob);
        response = new Response(thumbnail, {headers: {'Content-Type': 'image/jpeg'}});
        await cache.put(request, response.clone());
      }
      const url = URL.createObjectURL(await response.blob());
      thumbnailUrls.set(key, url);
      return url;
    })().finally(() => thumbnailJobs.delete(key)));
  }
  return thumbnailJobs.get(key);
}
