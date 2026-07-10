# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Momotepad is a macOS-only floating Markdown scratchpad (Raycast/Spotlight-style). A Tauri 2 + React 19 app: the Rust side owns the window as a non-activating `NSPanel`, the global hotkey, the menu-bar tray, and note file I/O; the React side is a single live-Markdown CodeMirror surface with two overlays — a `⌘K` Action Panel (all commands) and a `⌘P` notes-browse palette — plus a bottom Markdown-formatting toolbar.

## Commands

```bash
npm install              # install JS deps (also fetches Rust crates on first tauri run)
npm run tauri dev        # run the full app (spawns vite on :1420, then the Tauri shell)
npm run tauri build      # build .app / .dmg into src-tauri/target/release/bundle/
npm run build            # frontend-only: tsc typecheck + vite build (what tauri build calls)
npm run dev              # frontend-only vite server (blank without the Tauri shell — invoke() fails)
```

There is no test suite and no linter configured. Before submitting changes, run `npm run build` and `cargo check` (from `src-tauri/`) — this is what the README asks contributors to do.

To iterate quickly: `npm run tauri dev`. Rust changes trigger a recompile; frontend changes hot-reload via Vite.

## Architecture

**Two processes, bridged by Tauri commands.** The frontend never touches the filesystem directly — it calls `invoke("command_name", args)` and the Rust side ([src-tauri/src/lib.rs](src-tauri/src/lib.rs)) handles it. The commands: `list_notes`, `read_note`, `write_note`, `create_note`, `delete_note`, `export_note` (copies the note into `~/Downloads` and reveals it in Finder via `open -R`), `open_external` (opens a link from a rendered note, restricted to `http(s)`/`mailto`). When adding a command, register it in the `invoke_handler![]` macro at the bottom of `lib.rs`. Custom commands aren't gated by the capabilities allow-list — only `core:*`/plugin APIs are — so `export_note`/`open_external` needed no capability entry (both shell out to `open`, so their inputs are scheme-validated in Rust to keep untrusted note text from injecting flags/paths).

**Notes are plain files, no database.** Each note is `{id}.md` under `~/Library/Application Support/com.poom.momotepad/notes/`, where `id` is a nanosecond timestamp string. `list_notes` reads every file, derives a title (first non-empty line, heading marks stripped) and preview, and returns them sorted newest-first. Note ids must be ASCII-alphanumeric — `note_file()` enforces this, which also blocks path traversal. `migrate_legacy()` moves a pre-multi-note `note.md` into `notes/` on first `list_notes`.

**Title derivation is duplicated on purpose.** The Rust `derive()` (for the palette list) and the `activeTitle` memo in [src/App.tsx](src/App.tsx) must stay in sync — both take the first non-empty line and strip leading `#`. Change one, change the other.

**The window is a hand-rolled NSPanel, not a normal window.** `make_panel()` in `lib.rs` converts the main window into a non-activating `NSWindowStyleMaskNonactivatingPanel` so showing it floats over fullscreen apps without stealing focus or switching Spaces (Raycast behavior). Consequences that shape the code:
- `tao`'s native `startResizeDragging` is a no-op on this panel, so `ResizeHandles` in `App.tsx` implements drag-resize manually — tracking the pointer and calling `setSize`/`setPosition` itself. The `RESIZABLE` style-mask bit must also be set or macOS blocks resizing entirely.
- `MIN_W`/`MIN_H` in `App.tsx` must match `minWidth`/`minHeight` in [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json).
- The app runs as an `Accessory` activation policy (no Dock icon). `toggle_window()` shows/hides via the panel; it only hides when already visible *and* focused, so the hotkey pulls a buried note forward first.

**Live Markdown, no preview mode.** [src/editor.ts](src/editor.ts) styles/renders raw Markdown inline (the document always stays raw Markdown — it's the source of truth). Parsing uses GFM: `markdownExtension = markdown({ base: markdownLanguage })` — the `markdownLanguage` base (not the default commonmark) is what turns on tables, task lists, strikethrough, and autolinks, so `Table` nodes exist for the renderer. The extensions:
- `noteHighlight` — a `HighlightStyle` sizing headings, bolding `**strong**`, etc.
- `livePreview` — a `ViewPlugin` that *hides* syntax marks (`#`, `**`, ` ``` `) on inactive lines and *replaces* single-line constructs with rendered widgets: clickable links (`[t](url)` → an anchor that invokes `open_external`), dividers (`---`), task checkboxes (`- [ ]`/`- [x]`), and radios (`- ( )`/`- (x)`, non-standard, single-select within a contiguous run). Its `eventHandlers.mousedown` handles all widget clicks (toggle checkbox/radio text, open link, or drop the cursor into a table). Everything reveals its raw source the moment the cursor's line becomes active.
- `tableView` — a **`StateField`**, deliberately *not* part of `livePreview`. GFM tables render as block widgets spanning multiple lines, and CodeMirror forbids a `ViewPlugin` from providing block/line-spanning decorations (they change vertical layout) — it throws at runtime if you try. So tables live in their own state field; every other (single-line) component stays in the plugin.
- `codeBackground` — a `StateField` (keyed on selection, so fence lines expand when the cursor lands on them) that tints inline `` `code` `` and fenced blocks.

Checkbox/radio/divider detection is done by **line regex** (`CHECK_RE`/`RADIO_RE`/`DIVIDER_RE`), not the parse tree, so it's independent of GFM tokenization quirks; links and tables come from the syntax tree. All widget click targets carry `data-*` attributes (`data-md-toggle`/`data-md-link`/`data-md-table` + `data-from`) that the single `mousedown` handler reads.

**Auto-save is debounced in the frontend.** `handleChange` in `App.tsx` debounces a `write_note` invoke by 400ms. `flushSave`/`clearPendingSave` guard the edge cases: switching/deleting notes flushes or cancels the pending write so a stale save can't resurrect a deleted note or clobber the wrong file. `activeIdRef` mirrors `activeId` as a ref so async saves target the right note.

**Frontend-owned UI state:** opacity (persisted to `localStorage`, applied via the `--opacity` CSS var, clamped 0.4–1.0), snap sizes (`⌘1/2/3`), and all keyboard shortcuts live in `handleKeyDown` in `App.tsx`. Window *geometry* (size/position, not visibility) is persisted by the `tauri-plugin-window-state` plugin on the Rust side.

**One `overlay` state, one action list.** The editor/notes-palette/action-panel are a single `overlay: null | "notes" | "actions"` in `App.tsx` (they're mutually exclusive, so it's one state, not several booleans). The `actions` array is the single source of truth for "what can the app do": the Action Panel renders it *and* the `⌘K`-panel shortcut hints come from it, but the raw key shortcuts themselves are still dispatched in `handleKeyDown` — so a new command means adding both the `actions` row (for discoverability) and, if it has a shortcut, a `handleKeyDown` branch. The bottom formatting toolbar (`formatTools`) drives CodeMirror directly through `surround`/`prefixLines`/`insertLink`/`codeBlock`, which dispatch transactions against `editorRef.current.view`; its buttons `preventDefault` on mousedown so the editor keeps focus and selection.

## Constraints

- **macOS-only in practice.** The panel behavior, tray, and global shortcut are gated behind `#[cfg(target_os = "macos")]` / `#[cfg(desktop)]`. `tauri-nspanel` is a macOS-only git dependency (pinned to the `v2` branch). Cross-platform builds are a roadmap item, not a current reality.
- New Tauri window/core APIs called from JS must be allow-listed in [src-tauri/capabilities/default.json](src-tauri/capabilities/default.json), or the `invoke` will be denied at runtime.
- Styling is Tailwind CSS 4 (via `@tailwindcss/vite`, no config file) plus CSS variables (`--card`, `--accent`, `--muted`, `--code-bg`, etc.) defined in [src/App.css](src/App.css); the app follows system light/dark automatically.
