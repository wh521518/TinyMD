# Changelog

## 1.0.0-beat.5 - 2026-03-27

- Added block-style attachment cards in Milkdown, with file metadata, context menu actions, and native block handle compatibility.
- Reworked asset import into a unified pipeline covering local-path copy, background import, chunked upload, and inline import status updates.
- Split document identity into `sourcePath`, `path`, and `storageKind` so saved documents, temporary working files, and recovered tabs are handled consistently.
- Reworked drag-and-drop routing so Markdown files open through the native path-aware flow while asset insertion stays aligned with the active editor.
- Switched the default attachment directory to `_assets` and tightened first-use prompts so they are based on current document content instead of only checking folder existence.
- Replaced several blocking native confirmation prompts with in-app dialogs for attachment opening, temporary-document save gating, and exit handling.
