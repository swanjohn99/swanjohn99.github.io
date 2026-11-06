const teacherOnlyControlIds = [
  'server', 'reconnect-folder', 'download-draft', 'submission-mode', 'controller-status', 'video-folders',
  'classes-link', 'ready-review', 'publish-review', 'add-feedback', 'export', 'upload-r2',
  'track-motion', 'view-tracking', 'view-points',
];

function isEditableTarget(target) {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable=true]');
}

export function applyVideoMode(mode, root = document) {
  if (mode !== 'student') return;
  for (const control of root.querySelectorAll?.('[data-teacher-only]') || []) control.hidden = true;
  for (const id of teacherOnlyControlIds) {
    const control = root.getElementById?.(id) || root.querySelector?.(`#${id}`);
    if (control) control.hidden = true;
  }
}

export function configureVideoInterface({
  mode,
  previousButton,
  nextButton,
  onNavigate,
  canUseShortcut = () => true,
  root = document,
}) {
  applyVideoMode(mode, root);

  previousButton.addEventListener('click', () => onNavigate(-1));
  nextButton.addEventListener('click', () => onNavigate(1));

  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key !== '[' && event.key !== ']') return;
    if (isEditableTarget(event.target) || !canUseShortcut(event)) return;
    event.preventDefault();
    onNavigate(event.key === '[' ? -1 : 1);
  });

  return {
    setNavigationEnabled(enabled) {
      previousButton.disabled = !enabled;
      nextButton.disabled = !enabled;
    },
  };
}
