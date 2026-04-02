# Changelog

## 1.0.0-beat.10 - 2026-04-02

- Collapsed table-internal block handling into a single table-level handler so one table now uses one shared handle anchored at the table's top-left corner.
- Kept table formatting actions scoped to the active text cell while table drag and delete operations continue to target the whole table block.
- Downgraded Vite and the React plugin to Node 18-compatible versions so `npm run dev` and `tauri dev` no longer fail on `crypto.hash`.

## 1.0.0-beat.9 - 2026-03-31

- Moved the block handle activation model from mouse hover to the current editor selection so the active handle follows the caret line or selected block.
- Repositioned the custom block handle against the current line anchor, preventing it from covering document content while keeping the menu aligned with the active block.
- Moved slash-menu density overrides into the Milkdown component stylesheet chain so current-line menus and native menus share the same effective styling.
- Fixed menu-open anchoring so the handle no longer shifts with mouse hover after the current-line menu is activated.

## 1.0.0-beat.8 - 2026-03-30

- Reworked block handle dragging to use pointer-based reordering, fixing the blocked drag cursor issue inside the editor.
- Rebuilt the current-line block menu to match the native slash menu style while keeping actions scoped to the current block instead of inserting a new line.
- Fixed current-line menu positioning and scroll behavior so the menu no longer stretches the page or closes unexpectedly on wheel scroll.

## 1.0.0-beat.7 - 2026-03-30

- Added recently closed tab tracking with `Ctrl+Shift+T` restore support, including recovery for saved and temporary documents.
- Reworked app close handling into a configurable flow with `Ask Every Time`, `Exit`, and `Keep in Tray` preferences.
- Added a close dialog option to remember the selected exit behavior so the app can persist the user’s preferred close action.

## 1.0.0-beat.6 - 2026-03-28

- Added single-instance startup handling so repeated launches reactivate the existing main window instead of spawning duplicate app processes.
- Forwarded Markdown file arguments from a blocked second launch to the running instance, preserving file-association opens while the app is already running.
- Switched the close confirmation dialog to default to keeping the app in the system tray, including default focus and Enter-key behavior.

## 1.0.0-beat.5 - 2026-03-27

- Added block-style attachment cards in Milkdown, with file metadata, context menu actions, and native block handle compatibility.
- Reworked asset import into a unified pipeline covering local-path copy, background import, chunked upload, and inline import status updates.
- Split document identity into `sourcePath`, `path`, and `storageKind` so saved documents, temporary working files, and recovered tabs are handled consistently.
- Reworked drag-and-drop routing so Markdown files open through the native path-aware flow while asset insertion stays aligned with the active editor.
- Switched the default attachment directory to `_assets` and tightened first-use prompts so they are based on current document content instead of only checking folder existence.
- Replaced several blocking native confirmation prompts with in-app dialogs for attachment opening, temporary-document save gating, and exit handling.
