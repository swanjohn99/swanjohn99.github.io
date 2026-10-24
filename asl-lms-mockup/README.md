# SignPath — ASL Learning LMS Mockup

This is a **visual, nonfunctional prototype** of a video-first LMS for American Sign Language classes. It is designed to be viewed on a phone or a Chromebook.

## Open

Open `index.html` in any modern browser. There is no build step, server, account, or API key.

## Prototype screens

**Student mode:** dashboard, lesson journey, sample video-recognition quiz, practice playground, video assignments, and progress report.

**Teacher mode:** dashboard, video-first lesson builder, grading studio with mock rubric controls, and class analytics.

Use the Student/Teacher role toggle in the top bar to switch between demo personas.

## Scope & limitations

- All student names, scores, submission statuses, and videos are fictitious.
- There is **no functioning ASL video content** in this prototype. The illustrated person is a decorative graphic, not an example of an ASL sign.
- No login, database, file upload, camera recording, grading persistence, or lesson generation is implemented.
- Some clicks navigate between static screens or display a prototype message to help inspect UI flows.
- The one HTML file contains HTML, CSS, JavaScript, SVG artwork, and sample data. It can be split into a real codebase later.

## Suggested next steps

1. Validate student recording flow on managed Chromebooks.
2. Build an approved ASL video-content model (rights, sign variants, skill tags, captions and descriptions).
3. Implement video assignment uploads and the teacher grading queue.
4. Implement teacher-authored receptive quizzes, matching games, spaced repetition, and progress tracking.
5. Add roster and grade integrations (Google Workspace, Google Classroom and/or LTI 1.3) after privacy/security review.

**Do not use this prototype with actual student data.**

## Interactive video quiz prototype (October 2026 update)

An Edpuzzle-inspired video-quiz flow is now mocked up, accessible from the **Video quiz** navigation in Student mode and **Video quizzes** in Teacher mode. The student screen shows timeline checkpoints for multiple choice, typed reflections, and a proposed ASL webcam response. The teacher screen shows a timeline with three question markers, question-type choices, preview, and illustrative analytics. Some buttons switch mock panels but no changes persist.

This is an original, self-contained visual mockup of a general interactive-video learning pattern, **not** an Edpuzzle integration and **not** a claim to access or transfer existing Edpuzzle assignments or data. Videos, grades, student accounts and webcam recording are not connected. This demo intentionally uses a decorative drawing in place of an ASL instructional video. Production needs teacher-owned/licensed ASL clips, teacher-reviewed questions, approved access controls and retention policy, and a genuine recording pipeline.