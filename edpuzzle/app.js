import { parseYoutubeUrl, formatTime, parseTime, dueQuestion, validLesson } from './quiz.js';

const $ = id => document.getElementById(id);
const storageKey = 'frame.lesson.v1';
let lesson = null;
let player = null;
let playerReady = false;
let apiPromise;
let mode = 'edit';
let editingId = null;
let activeQuestion = null;
let checked = false;
let answers = new Map();
let toastTimer;
let duration = 0;

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

function save() {
  try { localStorage.setItem(storageKey, JSON.stringify(lesson)); }
  catch { toast('Browser storage is unavailable. Keep this tab open to retain your lesson.'); }
}

function button(text, className, action) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  element.className = className;
  element.addEventListener('click', action);
  return element;
}

function render() {
  const questions = lesson?.questions ?? [];
  $('question-count').textContent = questions.length;
  $('questions-empty').hidden = questions.length > 0;
  $('add-question').disabled = !lesson || mode === 'preview';
  $('preview-mode').disabled = !lesson || questions.length === 0;
  $('lesson-title').disabled = !lesson || mode === 'preview';
  $('edit-mode').classList.toggle('active', mode === 'edit');
  $('preview-mode').classList.toggle('active', mode === 'preview');
  $('edit-mode').setAttribute('aria-pressed', mode === 'edit');
  $('preview-mode').setAttribute('aria-pressed', mode === 'preview');
  $('question-list').replaceChildren();
  $('timeline-track').replaceChildren();
  for (const [index, question] of [...questions].sort((a, b) => a.time - b.time).entries()) {
    const card = document.createElement('article');
    card.className = 'question-card';
    const header = document.createElement('div');
    header.className = 'question-card-header';
    const seek = button(formatTime(question.time), 'time-chip', () => {
      if (playerReady) player.seekTo(question.time, true);
      else toast('The video is still loading. You can keep editing your questions.');
    });
    seek.disabled = mode === 'preview';
    header.append(seek);
    const number = document.createElement('span');
    number.className = 'question-number';
    number.textContent = mode === 'preview' && answers.has(question.id) ? 'Answered' : `QUESTION ${index + 1}`;
    header.append(number);
    const prompt = document.createElement('p');
    prompt.textContent = question.prompt;
    card.append(header, prompt);
    if (mode === 'edit') {
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      actions.append(button('Edit', 'text-button', () => openEditor(question)), button('Delete', 'text-button delete', () => {
        lesson.questions = lesson.questions.filter(q => q.id !== question.id);
        save(); render();
      }));
      card.append(actions);
    }
    $('question-list').append(card);
    if (duration > 0) {
      const marker = button('', 'timeline-marker', () => {
        if (mode === 'edit') openEditor(question);
      });
      marker.style.left = `${Math.min(100, question.time / duration * 100)}%`;
      marker.title = `${formatTime(question.time)} · ${question.prompt}`;
      marker.setAttribute('aria-label', marker.title);
      marker.disabled = mode === 'preview';
      $('timeline-track').append(marker);
    }
  }
  $('duration-label').textContent = duration ? formatTime(duration) : '–:––';
}

function loadApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('YouTube took too long to load. Check your connection and import the link again.')), 15000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timeout); resolve(); };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => { clearTimeout(timeout); reject(new Error('Could not connect to YouTube. Check your connection and import the link again.')); };
    document.head.append(script);
  }).catch(error => { apiPromise = null; throw error; });
  return apiPromise;
}

async function mountVideo() {
  playerReady = false;
  duration = 0;
  if (player) { player.destroy(); player = null; }
  if (!$('player')) {
    const target = document.createElement('div');
    target.id = 'player';
    $('video-shell').prepend(target);
  }
  $('video-empty').hidden = true;
  $('player-status').textContent = 'Connecting to YouTube…';
  render();
  try {
    await loadApi();
    player = new window.YT.Player('player', {
      videoId: lesson.videoId,
      playerVars: { playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: () => {
          playerReady = true;
          $('player-status').textContent = '';
          duration = player.getDuration() || 0;
          render();
        },
        onStateChange: event => {
          if (player.getDuration() > 0 && duration !== player.getDuration()) {
            duration = player.getDuration(); render();
          }
          if (mode === 'preview' && activeQuestion && event.data === 1) player.pauseVideo();
          if (mode === 'preview' && event.data === 0) tick(true);
        },
        onError: event => {
          playerReady = false;
          $('player-status').textContent = [101, 150].includes(event.data)
            ? 'The owner has disabled embedding for this video. Import another YouTube video.'
            : 'This video could not be played. It may be private, restricted, unavailable, or blocked by your connection. Try another video.';
        }
      }
    });
  } catch (error) { $('player-status').textContent = error.message; }
}

$('import-form').addEventListener('submit', async event => {
  event.preventDefault();
  const videoId = parseYoutubeUrl($('video-url').value);
  $('import-error').textContent = '';
  if (!videoId) { $('import-error').textContent = 'Enter a valid YouTube watch, share, Shorts, or embed URL.'; return; }
  if (lesson?.videoId === videoId) {
    if (!playerReady) await mountVideo();
    else toast('This video is already in your lesson.');
    return;
  }
  if (lesson && !confirm('Replace this lesson? Its saved title and questions will be removed from this device.')) return;
  mode = 'edit';
  answers = new Map();
  lesson = { videoId, title: 'Untitled video lesson', questions: [] };
  $('lesson-title').value = lesson.title;
  $('video-meta').textContent = 'YouTube video · Add questions at any moment';
  $('preview-summary').hidden = true;
  save(); render();
  await mountVideo();
});

$('lesson-title').addEventListener('input', () => {
  if (!lesson) return;
  lesson.title = $('lesson-title').value;
  save();
});

function openEditor(question = null) {
  if (!lesson || mode !== 'edit') return;
  if (playerReady) player.pauseVideo();
  editingId = question?.id ?? null;
  $('question-form').reset();
  $('dialog-title').textContent = question ? 'Edit question' : 'Add a question';
  $('question-time').value = formatTime(question?.time ?? (playerReady ? player.getCurrentTime() : 0));
  $('question-prompt').value = question?.prompt ?? '';
  $('question-error').textContent = '';
  $('answer-fields').replaceChildren();
  for (let i = 0; i < 4; i++) {
    const row = document.createElement('div');
    row.className = 'answer-row';
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'correct'; radio.value = i;
    radio.checked = (question?.correct ?? 0) === i;
    radio.setAttribute('aria-label', `Mark option ${i + 1} as correct`);
    const option = document.createElement('input');
    option.type = 'text'; option.id = `option-${i}`; option.maxLength = 500;
    option.placeholder = `Option ${i + 1}${i > 1 ? ' (optional)' : ''}`;
    option.setAttribute('aria-label', `Answer option ${i + 1}`);
    option.value = question?.options[i] ?? '';
    option.required = i < 2;
    row.append(radio, option); $('answer-fields').append(row);
  }
  $('question-dialog').showModal();
}

$('add-question').addEventListener('click', () => openEditor());
for (const id of ['close-dialog', 'cancel-question']) $(id).addEventListener('click', () => $('question-dialog').close());
$('question-form').addEventListener('submit', event => {
  event.preventDefault();
  const time = parseTime($('question-time').value);
  const prompt = $('question-prompt').value.trim();
  const rawOptions = Array.from({ length: 4 }, (_, i) => $(`option-${i}`).value.trim());
  const selected = Number(new FormData($('question-form')).get('correct'));
  if (time === null || (duration > 0 && time > duration)) {
    $('question-error').textContent = duration ? `Choose a timestamp between 0:00 and ${formatTime(duration)}.` : 'Enter a timestamp in minutes:seconds, such as 1:30.'; return;
  }
  if (!prompt || rawOptions.filter(Boolean).length < 2 || !rawOptions[selected]) {
    $('question-error').textContent = 'Add a question, at least two answers, and select a filled answer as correct.'; return;
  }
  const question = { id: editingId ?? crypto.randomUUID(), time, prompt, options: rawOptions.filter(Boolean), correct: rawOptions.slice(0, selected).filter(Boolean).length };
  if (editingId) lesson.questions = lesson.questions.map(q => q.id === editingId ? question : q);
  else lesson.questions.push(question);
  save(); render(); $('question-dialog').close();
});

function switchMode(nextMode) {
  mode = nextMode;
  if (playerReady) player.pauseVideo();
  activeQuestion = null;
  $('answer-dialog').close();
  $('preview-summary').hidden = true;
  if (mode === 'preview') {
    answers = new Map();
    if (playerReady) player.seekTo(0, true);
    $('video-meta').textContent = 'Student preview · Press play to begin';
    toast('Press play. The video will pause for each question.');
  } else $('video-meta').textContent = 'YouTube video · Add questions at any moment';
  render();
}
$('edit-mode').addEventListener('click', () => switchMode('edit'));
$('preview-mode').addEventListener('click', () => switchMode('preview'));

function showQuestion(question) {
  activeQuestion = question; checked = false;
  player.pauseVideo();
  player.seekTo(question.time, true);
  $('answer-timestamp').textContent = `PAUSE & THINK · ${formatTime(question.time)}`;
  $('answer-title').textContent = question.prompt;
  $('answer-feedback').textContent = '';
  $('submit-answer').textContent = 'Check answer';
  $('student-options').replaceChildren();
  question.options.forEach((option, index) => {
    const row = document.createElement('div'); row.className = 'answer-row';
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'student-answer'; radio.value = index;
    radio.id = `student-${index}`; radio.required = true;
    const label = document.createElement('label'); label.htmlFor = radio.id; label.textContent = option;
    row.append(radio, label); $('student-options').append(row);
  });
  $('answer-dialog').showModal();
}

function tick(ended = false) {
  if (mode !== 'preview' || !playerReady || activeQuestion || !lesson) return;
  const current = ended ? duration : player.getCurrentTime();
  const next = dueQuestion(lesson.questions, new Set(answers.keys()), current);
  if (next) { showQuestion(next); return; }
  if (answers.size === lesson.questions.length && lesson.questions.length) {
    const score = [...answers.values()].filter(Boolean).length;
    $('preview-summary').textContent = `All questions answered! ${score} of ${lesson.questions.length} correct. Switch to Edit lesson to make changes, or click Student preview to try again.`;
    $('preview-summary').hidden = false;
  }
}
setInterval(() => tick(), 250);
$('answer-dialog').addEventListener('cancel', event => event.preventDefault());
$('answer-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!activeQuestion) return;
  if (!checked) {
    const selected = Number(new FormData($('answer-form')).get('student-answer'));
    const correct = selected === activeQuestion.correct;
    answers.set(activeQuestion.id, correct);
    $('answer-feedback').textContent = correct ? 'That’s right! Nicely done.' : `Good try. The correct answer is: ${activeQuestion.options[activeQuestion.correct]}`;
    $('student-options').querySelectorAll('input').forEach(input => { input.disabled = true; });
    $('submit-answer').textContent = 'Continue video →';
    checked = true; render();
  } else {
    activeQuestion = null;
    $('answer-dialog').close();
    tick();
    if (!activeQuestion) player.playVideo();
  }
});

try {
  const stored = JSON.parse(localStorage.getItem(storageKey));
  if (validLesson(stored)) {
    lesson = stored;
    $('lesson-title').value = lesson.title;
    $('video-url').value = `https://www.youtube.com/watch?v=${lesson.videoId}`;
    $('video-meta').textContent = 'YouTube video · Add questions at any moment';
    mountVideo();
  }
} catch { toast('The saved lesson could not be loaded. Import a video to start a new lesson.'); }
render();
