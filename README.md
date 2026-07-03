<p align="center">
  <img src="src-tauri/app-icon.png" alt="memonotepad app icon" width="140" height="140">
</p>

<h1 align="center">Memonotepad</h1>

<p align="center">
  A tiny, always-on-top Markdown scratchpad for macOS — summon it with a<br>
  keystroke, jot a thought, and it floats over everything without stealing focus.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-black.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Platform-macOS-000000?logo=apple" alt="Platform: macOS">
  <img src="https://img.shields.io/badge/Built%20with-Tauri%202-24C8DB?logo=tauri&logoColor=white" alt="Built with Tauri 2">
  <img src="https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white" alt="React 19">
</p>

Memonotepad is a Raycast/Spotlight-style floating note. It lives in your menu bar, appears on top of any app — even fullscreen ones — when you hit the global shortcut, and disappears just as fast. Everything you type is plain Markdown, saved instantly to local `.md` files. There's no "edit mode" and no "preview mode": Markdown styles itself live as you type, the way Notion and Raycast Notes work.

---

## ⬇️ Download

| Build | For | |
| --- | --- | --- |
| **Apple Silicon** | M1 / M2 / M3 / M4 Macs | [Download .dmg](https://r2-dev.ribbinpo.dev/memotepad/memonotepad-0.1.0-apple-silicon.dmg) |
| **Universal** | Apple Silicon **and** Intel Macs | [Download .dmg](https://r2-dev.ribbinpo.dev/memotepad/memonotepad_0.1.0_universal.dmg) |

> **First launch:** memonotepad isn't code-signed yet, so macOS Gatekeeper will warn you. After dragging the app to **Applications**, right-click it → **Open** → **Open**. If macOS says the app is "damaged," open Terminal and run:
> ```bash
> xattr -dr com.apple.quarantine /Applications/memonotepad.app
> ```

---

## ✨ Features

- **Always-on-top floating panel** — a frosted-glass window that stays above your other apps.
- **Floats over fullscreen apps** — built as a non-activating macOS `NSPanel`, so showing it never yanks you out of a fullscreen Space or steals focus.
- **Global show/hide hotkey** — summon or dismiss the note from anywhere with `⌥.` (Option + Period).
- **Menu bar app** — runs as a background agent with no Dock icon; left-click the tray icon to toggle, or use its Show / Quit menu.
- **Live Markdown editing** — a single always-editable surface (CodeMirror 6). Headings grow, `**bold**` renders bold, and syntax marks dim on inactive lines. No mode switching.
- **Styled code** — inline `` `code` `` gets a pill background and fenced ` ``` ` blocks get a tinted band.
- **Multiple notes + search** — a `⌘K` command palette to search, open, create, and delete notes.
- **Auto-save** — every keystroke is debounced and written to disk; nothing to save manually.
- **Plain-text storage** — notes are just Markdown files in your app-data folder. No lock-in, no database.
- **Manual & snap resizing** — drag any edge/corner to resize, or snap to preset sizes with `⌘1`–`⌘3`.
- **Adjustable translucency** — dial the panel's opacity up or down with `⌘+` / `⌘-`.
- **Remembers its place** — window size and position persist between launches.
- **Light & dark mode** — follows the system appearance automatically.

## ⌨️ Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌥.` | Show / hide the note (global, works anywhere) |
| `⌘K` | Open the notes search palette |
| `⌘N` | New note |
| `↑` / `↓` · `↵` | Navigate / open a note (in the palette) |
| `⌘⌫` | Delete the selected note (in the palette) |
| `⌘1` · `⌘2` · `⌘3` | Snap to compact / default / large size |
| `⌘+` / `⌘-` | Increase / decrease opacity |
| `Esc` | Close the palette, or hide the window |

## 🚀 Getting started

**Prerequisites:** [Node.js](https://nodejs.org) 18+, [Rust](https://www.rust-lang.org/tools/install), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for macOS (Xcode Command Line Tools).

```bash
# install dependencies
npm install

# run in development
npm run tauri dev

# build a distributable .app / .dmg
npm run tauri build
```

The bundled app is produced under `src-tauri/target/release/bundle/`.

## 🗂️ Where notes live

Notes are stored as individual Markdown files under the app's data directory:

```
~/Library/Application Support/com.poom.memonotepad/notes/*.md
```

Because they're plain `.md` files, you can back them up, sync them, or edit them in any other editor.

## 🧱 Tech stack

- **[Tauri 2](https://tauri.app)** (Rust) — native shell, menu bar, global shortcut, `NSPanel`
- **[React 19](https://react.dev)** + **[TypeScript](https://www.typescriptlang.org)** + **[Vite](https://vitejs.dev)**
- **[CodeMirror 6](https://codemirror.net)** — the live-Markdown editor
- **[Tailwind CSS 4](https://tailwindcss.com)** — styling

## 🗺️ Roadmap

Done so far:

- [x] Floating always-on-top panel with global hotkey
- [x] Menu bar icon + background agent
- [x] Multiple notes with search palette
- [x] Live Markdown editing (no separate preview mode)
- [x] Auto-save to local Markdown files
- [x] Opacity control, snap sizes, and manual resize

Planned / ideas:

- [ ] Pin / unpin favourite notes
- [ ] iCloud or Git folder sync
- [ ] Tags and quick filtering
- [ ] Slash / command menu for Markdown blocks (checklists, tables, dividers)
- [ ] Per-note or global themes
- [ ] Optional password lock / encryption
- [ ] Export & share (Markdown, PDF)
- [ ] First-class Windows & Linux builds

Have an idea? Open an issue — suggestions are welcome.

## 🤝 Contributing

Contributions, bug reports, and feature requests are welcome. Fork the repo, create a branch, and open a pull request. Please keep changes focused and run `npm run build` (and `cargo check` in `src-tauri/`) before submitting.

## ❤️ Support / Donation

If memonotepad saves you a few keystrokes a day and you'd like to say thanks, you can support development here:

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](buymeacoffee.com/ribbinpo)

> Replace the links above with your own donation pages. Every bit is appreciated — thank you!

## 📄 License

Released under the [MIT License](LICENSE). © 2026 Teerawut Saesim.
