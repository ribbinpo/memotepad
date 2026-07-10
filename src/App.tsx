import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import {
  markdownExtension,
  noteTheme,
  noteHighlight,
  livePreview,
  tableView,
  codeBackground,
} from "./editor";
import "./App.css";

const editorExtensions = [
  markdownExtension,
  EditorView.lineWrapping,
  noteTheme,
  syntaxHighlighting(noteHighlight),
  livePreview,
  tableView,
  codeBackground,
];

const toolbarBtn =
  "inline-flex h-6 w-[26px] cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-card-fg active:translate-y-[0.5px]";

// Markdown-toolbar button: sizes to its glyph (letters, `</>`, icons) rather
// than a fixed square, and never grabs focus off the editor (mousedown default
// is prevented at the call site) so the current selection stays put.
const fmtBtn =
  "inline-flex h-6 min-w-[26px] flex-none cursor-pointer items-center justify-center rounded-md px-1.5 text-[0.9em] leading-none text-muted transition-colors hover:bg-hover hover:text-card-fg active:translate-y-[0.5px]";

// ---- module-scope icons (constant JSX) ------------------------------------
const IconSearch = (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <line x1="10.4" y1="10.4" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const IconPlus = (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <line x1="2.5" y1="8" x2="13.5" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

// Stacked lines = the "all actions" command menu.
const IconActions = (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <line x1="3" y1="4.5" x2="13" y2="4.5" />
    <line x1="3" y1="8" x2="13" y2="8" />
    <line x1="3" y1="11.5" x2="13" y2="11.5" />
  </svg>
);

const IconLink = (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <path d="M6.6 9.4 9.4 6.6" />
    <path d="M7.3 4.6 8.5 3.4a2.3 2.3 0 0 1 3.3 3.3L10.6 7.9" />
    <path d="M8.7 11.4 7.5 12.6a2.3 2.3 0 0 1-3.3-3.3L5.4 8.1" />
  </svg>
);

const IconList = (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <line x1="6" y1="4.5" x2="13" y2="4.5" />
    <line x1="6" y1="8" x2="13" y2="8" />
    <line x1="6" y1="11.5" x2="13" y2="11.5" />
    <circle cx="3" cy="4.5" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="3" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="3" cy="11.5" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

const IconTrash = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 4.5h10" />
    <path d="M6.5 4.5V3.2a0.7 0.7 0 0 1 0.7-0.7h1.6a0.7 0.7 0 0 1 0.7 0.7V4.5" />
    <path d="M4.3 4.5l0.6 8a0.9 0.9 0 0 0 0.9 0.8h4.4a0.9 0.9 0 0 0 0.9-0.8l0.6-8" />
    <line x1="6.6" y1="6.8" x2="6.8" y2="11" />
    <line x1="9.4" y1="6.8" x2="9.2" y2="11" />
  </svg>
);

type ResizeDir =
  | "North" | "South" | "East" | "West"
  | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

// Keep in sync with tauri.conf.json minWidth/minHeight.
const MIN_W = 240;
const MIN_H = 200;

type DragState = {
  dir: ResizeDir;
  sx: number; sy: number;              // pointer origin (screen, logical px)
  x: number; y: number; w: number; h: number; // window origin (logical px)
  lastX: number; lastY: number;
  raf: number | null;
};

// The window is a borderless NSPanel, and tao's startResizeDragging is a no-op
// on macOS — so we resize manually: track the pointer and drive setSize /
// setPosition ourselves. The strips sit in the transparent inset margin,
// behind the card, so they never cover the toolbar or editor.
function ResizeHandles() {
  const drag = useRef<DragState | null>(null);

  const apply = () => {
    const d = drag.current;
    if (!d) return;
    d.raf = null;
    const dx = d.lastX - d.sx;
    const dy = d.lastY - d.sy;
    const right = d.x + d.w;
    const bottom = d.y + d.h;
    let x = d.x, y = d.y, w = d.w, h = d.h;
    if (d.dir.includes("East")) w = Math.max(MIN_W, d.w + dx);
    if (d.dir.includes("West")) { w = Math.max(MIN_W, d.w - dx); x = right - w; }
    if (d.dir.includes("South")) h = Math.max(MIN_H, d.h + dy);
    if (d.dir.includes("North")) { h = Math.max(MIN_H, d.h - dy); y = bottom - h; }
    const win = getCurrentWindow();
    if (d.dir.includes("West") || d.dir.includes("North"))
      win.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
    win.setSize(new LogicalSize(Math.round(w), Math.round(h)));
  };

  const onDown = (dir: ResizeDir) => async (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const win = getCurrentWindow();
    const [scale, pos, size] = await Promise.all([
      win.scaleFactor(), win.outerPosition(), win.outerSize(),
    ]);
    drag.current = {
      dir,
      sx: e.screenX, sy: e.screenY,
      x: pos.x / scale, y: pos.y / scale,
      w: size.width / scale, h: size.height / scale,
      lastX: e.screenX, lastY: e.screenY, raf: null,
    };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.lastX = e.screenX;
    d.lastY = e.screenY;
    if (d.raf == null) d.raf = requestAnimationFrame(apply);
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d?.raf != null) cancelAnimationFrame(d.raf);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    drag.current = null;
  };

  const strip = (dir: ResizeDir, cls: string) => (
    <div
      onPointerDown={onDown(dir)}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      className={`absolute z-0 ${cls}`}
    />
  );
  return (
    <>
      {strip("North", "-top-[9px] left-0 right-0 h-[14px] cursor-ns-resize")}
      {strip("South", "-bottom-[9px] left-0 right-0 h-[14px] cursor-ns-resize")}
      {strip("West", "-left-[9px] top-0 bottom-0 w-[14px] cursor-ew-resize")}
      {strip("East", "-right-[9px] top-0 bottom-0 w-[14px] cursor-ew-resize")}
      {strip("NorthWest", "-top-[9px] -left-[9px] h-[18px] w-[18px] cursor-nwse-resize")}
      {strip("NorthEast", "-top-[9px] -right-[9px] h-[18px] w-[18px] cursor-nesw-resize")}
      {strip("SouthWest", "-bottom-[9px] -left-[9px] h-[18px] w-[18px] cursor-nesw-resize")}
      {strip("SouthEast", "-bottom-[9px] -right-[9px] h-[18px] w-[18px] cursor-nwse-resize")}
    </>
  );
}

const editorSetup = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  bracketMatching: false,
  closeBrackets: false,
  autocompletion: false,
  searchKeymap: false,
  indentOnInput: false,
  highlightSelectionMatches: false,
};

type NoteMeta = {
  id: string;
  title: string;
  preview: string;
  body: string;
  modified: number;
};

// null = the editor; "notes" = browse palette; "actions" = command panel.
type Overlay = null | "notes" | "actions";

type ActionItem = {
  id: string;
  label: string;
  hint: string;
  run: () => void;
};

function App() {
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  // Note id awaiting a second click to confirm deletion (guards accidental taps).
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [opacity, setOpacity] = useState<number>(() => {
    const v = parseFloat(localStorage.getItem("opacity") ?? "1");
    return Number.isNaN(v) ? 1 : Math.min(1, Math.max(0.4, v));
  });

  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<number | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const didInit = useRef(false);

  activeIdRef.current = activeId;

  // ---- persistence helpers ---------------------------------------------
  function clearPendingSave() {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
  }

  function flushSave(text: string) {
    clearPendingSave();
    if (activeIdRef.current)
      invoke("write_note", { id: activeIdRef.current, content: text });
  }

  async function refreshNotes(): Promise<NoteMeta[]> {
    const metas = await invoke<NoteMeta[]>("list_notes");
    setNotes(metas);
    return metas;
  }

  async function openNote(id: string, { save = true } = {}) {
    if (save) flushSave(content);
    else clearPendingSave();
    const text = await invoke<string>("read_note", { id });
    setActiveId(id);
    activeIdRef.current = id;
    setContent(text);
    setOverlay(null);
  }

  async function newNote() {
    flushSave(content);
    const id = await invoke<string>("create_note");
    await refreshNotes();
    await openNote(id, { save: false });
  }

  async function deleteNote(id: string) {
    setConfirmId(null);
    const wasActive = id === activeIdRef.current;
    if (wasActive) clearPendingSave(); // don't let a pending save resurrect it
    await invoke("delete_note", { id });
    const metas = await refreshNotes();
    if (wasActive) {
      if (metas.length) {
        await openNote(metas[0].id, { save: false });
      } else {
        const nid = await invoke<string>("create_note");
        await refreshNotes();
        await openNote(nid, { save: false });
      }
    }
    setSelected(0);
  }

  // Flush the latest text to disk, then hand the note off to Rust to copy into
  // Downloads and reveal it in Finder.
  async function exportNote() {
    const id = activeIdRef.current;
    if (!id) return;
    clearPendingSave();
    try {
      await invoke("write_note", { id, content });
      await invoke("export_note", { id });
    } catch {
      /* export is best-effort; a failure just leaves the note where it is */
    }
  }

  // ---- init -------------------------------------------------------------
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    (async () => {
      let metas = await refreshNotes();
      if (metas.length === 0) {
        await invoke<string>("create_note");
        metas = await refreshNotes();
      }
      await openNote(metas[0].id, { save: false });
    })();
  }, []);

  // Re-focus editor when the window regains focus (e.g. via ⌥. hotkey).
  useEffect(() => {
    const unlisten = getCurrentWindow().onFocusChanged(
      ({ payload: focused }) => {
        if (focused && !overlay) editorRef.current?.view?.focus();
      },
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, [overlay]);

  // Keep focus on whichever pane is showing so shortcuts always land.
  useEffect(() => {
    if (overlay) searchRef.current?.focus();
    else editorRef.current?.view?.focus();
  }, [overlay]);

  // Apply + persist the note's translucency.
  useEffect(() => {
    document.documentElement.style.setProperty("--opacity", String(opacity));
    localStorage.setItem("opacity", String(opacity));
  }, [opacity]);

  const clampOpacity = (v: number) =>
    Math.min(1, Math.max(0.4, Math.round(v * 100) / 100));

  function snapSize(w: number, h: number) {
    getCurrentWindow().setSize(new LogicalSize(w, h));
  }

  // Live title for the toolbar — first non-empty line, heading marks stripped.
  // Mirrors the Rust `derive()` so the bar matches the palette list.
  const activeTitle = useMemo(() => {
    const first = content
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean);
    const t = first?.replace(/^#+\s*/, "").trim();
    return t || "Untitled note";
  }, [content]);

  // ---- overlays ---------------------------------------------------------
  function openNotes() {
    refreshNotes();
    setQuery("");
    setSelected(0);
    setConfirmId(null);
    setOverlay("notes");
  }

  function openActions() {
    setQuery("");
    setSelected(0);
    setOverlay("actions");
  }

  function closeOverlay() {
    setOverlay(null);
  }

  // Every command the app can run, surfaced (searchable) in the ⌘K action panel
  // and driven directly by the shortcuts in handleKeyDown. One source of truth
  // for "what can I do here" — add a row and it shows up in the panel.
  const actions: ActionItem[] = [
    { id: "new", label: "New Note", hint: "⌘N", run: () => newNote() },
    { id: "browse", label: "Browse Notes", hint: "⌘P", run: () => openNotes() },
    { id: "export", label: "Export Note to Downloads", hint: "⌘E", run: () => { closeOverlay(); exportNote(); } },
    { id: "size1", label: "Compact Size", hint: "⌘1", run: () => { closeOverlay(); snapSize(300, 360); } },
    { id: "size2", label: "Default Size", hint: "⌘2", run: () => { closeOverlay(); snapSize(360, 440); } },
    { id: "size3", label: "Large Size", hint: "⌘3", run: () => { closeOverlay(); snapSize(480, 600); } },
    { id: "opac-up", label: "Increase Opacity", hint: "⌘+", run: () => setOpacity((o) => clampOpacity(o + 0.1)) },
    { id: "opac-down", label: "Decrease Opacity", hint: "⌘−", run: () => setOpacity((o) => clampOpacity(o - 0.1)) },
    { id: "hide", label: "Hide Window", hint: "esc", run: () => { getCurrentWindow().hide(); } },
  ];

  const visibleActions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(q));
    // `actions` is rebuilt each render; `query` is the real filter input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, content, notes, opacity]);

  // ---- markdown formatting (bottom toolbar) -----------------------------
  // Wrap the selection with `before`/`after` (e.g. ** … **) and leave the inner
  // text selected so the user can keep typing over it.
  function surround(before: string, after = before) {
    const view = editorRef.current?.view;
    if (!view) return;
    const { state } = view;
    const r = state.selection.main;
    const inner = state.sliceDoc(r.from, r.to);
    view.dispatch({
      changes: { from: r.from, to: r.to, insert: before + inner + after },
      selection: { anchor: r.from + before.length, head: r.from + before.length + inner.length },
      scrollIntoView: true,
    });
    view.focus();
  }

  // Add a line prefix (`# `, `- `, `> `, `- [ ] `) to every line the selection
  // touches — the building block for headings, lists and quotes.
  function prefixLines(prefix: string) {
    const view = editorRef.current?.view;
    if (!view) return;
    const { state } = view;
    const r = state.selection.main;
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    const changes = [];
    for (let n = first; n <= last; n++)
      changes.push({ from: state.doc.line(n).from, insert: prefix });
    const added = prefix.length;
    view.dispatch({
      changes,
      selection: { anchor: r.from + added, head: r.to + added * (last - first + 1) },
      scrollIntoView: true,
    });
    view.focus();
  }

  function insertLink() {
    const view = editorRef.current?.view;
    if (!view) return;
    const { state } = view;
    const r = state.selection.main;
    const text = state.sliceDoc(r.from, r.to) || "text";
    const urlAt = r.from + text.length + 3; // "[" + text + "]("
    view.dispatch({
      changes: { from: r.from, to: r.to, insert: `[${text}](url)` },
      selection: { anchor: urlAt, head: urlAt + 3 }, // select "url"
      scrollIntoView: true,
    });
    view.focus();
  }

  function codeBlock() {
    const view = editorRef.current?.view;
    if (!view) return;
    const { state } = view;
    const r = state.selection.main;
    const inner = state.sliceDoc(r.from, r.to);
    view.dispatch({
      changes: { from: r.from, to: r.to, insert: "```\n" + inner + "\n```" },
      selection: { anchor: r.from + 4, head: r.from + 4 + inner.length }, // after "```\n"
      scrollIntoView: true,
    });
    view.focus();
  }

  const formatTools = [
    { key: "h", title: "Heading", node: <span className="font-bold">H</span>, run: () => prefixLines("# ") },
    { key: "b", title: "Bold", node: <span className="font-bold">B</span>, run: () => surround("**") },
    { key: "i", title: "Italic", node: <span className="italic" style={{ fontFamily: "Georgia, serif" }}>I</span>, run: () => surround("*") },
    { key: "s", title: "Strikethrough", node: <span className="line-through">S</span>, run: () => surround("~~") },
    { key: "code", title: "Inline code", node: <span className="font-mono text-[0.8em]">{"</>"}</span>, run: () => surround("`") },
    { key: "link", title: "Link", node: IconLink, run: () => insertLink() },
    { key: "ul", title: "Bullet list", node: IconList, run: () => prefixLines("- ") },
    { key: "task", title: "Checklist", node: <span className="text-[0.95em]">☑</span>, run: () => prefixLines("- [ ] ") },
    { key: "quote", title: "Quote", node: <span style={{ fontFamily: "Georgia, serif" }} className="text-[1.1em] leading-none">”</span>, run: () => prefixLines("> ") },
    { key: "codeblock", title: "Code block", node: <span className="font-mono text-[0.8em]">{"{ }"}</span>, run: () => codeBlock() },
  ];

  // ---- search -----------------------------------------------------------
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter(
      (n) => n.title.toLowerCase().includes(q) || n.body.includes(q),
    );
  }, [notes, query]);

  // ---- editing ----------------------------------------------------------
  function handleChange(next: string) {
    setContent(next);
    const id = activeIdRef.current;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (id) invoke("write_note", { id, content: next });
    }, 400);
  }

  async function handleKeyDown(e: React.KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    // Opacity: ⌘+ / ⌘- (work in any view).
    if (mod && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      setOpacity((o) => clampOpacity(o + 0.1));
      return;
    }
    if (mod && e.key === "-") {
      e.preventDefault();
      setOpacity((o) => clampOpacity(o - 0.1));
      return;
    }
    // Snap sizes: ⌘1 compact · ⌘2 default · ⌘3 large.
    if (mod && (e.key === "1" || e.key === "2" || e.key === "3")) {
      e.preventDefault();
      if (e.key === "1") snapSize(300, 360);
      else if (e.key === "2") snapSize(360, 440);
      else snapSize(480, 600);
      return;
    }

    // Global command shortcuts.
    if (mod && key === "k") {
      e.preventDefault();
      overlay === "actions" ? closeOverlay() : openActions();
      return;
    }
    if (mod && key === "p") {
      e.preventDefault();
      overlay === "notes" ? closeOverlay() : openNotes();
      return;
    }
    if (mod && key === "n") {
      e.preventDefault();
      newNote();
      return;
    }
    if (mod && key === "e") {
      e.preventDefault();
      exportNote();
      return;
    }

    if (overlay === "notes") {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const n = filtered[selected];
        if (n) openNote(n.id);
      } else if (mod && e.key === "Backspace") {
        e.preventDefault();
        const n = filtered[selected];
        if (n) deleteNote(n.id);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeOverlay();
      }
      return;
    }

    if (overlay === "actions") {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, visibleActions.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        visibleActions[selected]?.run();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeOverlay();
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      await getCurrentWindow().hide();
    }
  }

  // ---- render -----------------------------------------------------------
  const headerTitle =
    overlay === "notes" ? "Notes" : overlay === "actions" ? "Actions" : activeTitle;

  return (
    <div
      className="relative h-full [opacity:var(--opacity,1)] transition-opacity duration-[120ms]"
      onKeyDown={handleKeyDown}
    >
      <ResizeHandles />
      <div className="relative z-10 flex h-full flex-col overflow-hidden rounded-[13px] bg-card text-card-fg antialiased backdrop-blur-[30px] backdrop-saturate-[1.8] shadow-[0_1px_2px_rgba(0,0,0,0.06),0_3px_6px_-2px_rgba(0,0,0,0.10),0_8px_16px_-6px_rgba(0,0,0,0.16),inset_0_0_0_0.5px_var(--ring),inset_0_1px_0_0_var(--hi)]">
        <header
          className="grid h-8 flex-none select-none grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-rule bg-bar px-2"
          data-tauri-drag-region
        >
          {/* left — macOS-style close button (hides the panel) */}
          <div className="flex items-center pl-1">
            <button
              type="button"
              title="Hide window (esc)"
              aria-label="Hide window"
              onClick={() => getCurrentWindow().hide()}
              className="group flex h-[13px] w-[13px] items-center justify-center rounded-full bg-[#ff5f57] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.2)] transition-[filter] hover:brightness-95 active:brightness-90"
            >
              <svg
                viewBox="0 0 10 10"
                width="7"
                height="7"
                aria-hidden="true"
                className="opacity-0 transition-opacity group-hover:opacity-100"
              >
                <path
                  d="M2.6 2.6 7.4 7.4 M7.4 2.6 2.6 7.4"
                  stroke="rgba(0,0,0,0.55)"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {/* center — active note / overlay name */}
          <span
            className="min-w-0 cursor-default truncate text-center text-[0.8em] font-[590] tracking-[0.01em] text-muted"
            data-tauri-drag-region
          >
            {headerTitle}
          </span>

          {/* right — quick actions */}
          <div className="flex items-center gap-px">
            <button
              type="button"
              title="Browse notes (⌘P)"
              className={`${toolbarBtn}${overlay === "notes" ? " text-accent" : ""}`}
              onClick={() => (overlay === "notes" ? closeOverlay() : openNotes())}
            >
              {IconSearch}
            </button>
            <button
              type="button"
              title="New note (⌘N)"
              className={toolbarBtn}
              onClick={newNote}
            >
              {IconPlus}
            </button>
            <button
              type="button"
              title="Actions (⌘K)"
              className={`${toolbarBtn}${overlay === "actions" ? " text-accent" : ""}`}
              onClick={() => (overlay === "actions" ? closeOverlay() : openActions())}
            >
              {IconActions}
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {overlay === "notes" ? (
            <div className="flex h-full w-full flex-col overflow-hidden text-card-fg">
              <input
                ref={searchRef}
                className="border-b border-rule bg-transparent px-[18px] py-3 text-[1.05em] text-card-fg outline-none placeholder:text-muted"
                value={query}
                placeholder="Search notes…"
                spellCheck={false}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelected(0);
                  setConfirmId(null);
                }}
              />
              <ul className="flex-1 list-none overflow-y-auto p-1.5">
                {filtered.length === 0 && (
                  <li className="cursor-default px-3 py-2 text-muted">
                    No notes match
                  </li>
                )}
                {filtered.map((n, i) => (
                  <li
                    key={n.id}
                    className={`group flex items-center gap-2 rounded-lg px-3 py-2${
                      i === selected
                        ? " bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]"
                        : ""
                    }`}
                    onMouseEnter={() => setSelected(i)}
                  >
                    <div
                      className="min-w-0 flex-1 cursor-pointer"
                      onClick={() => openNote(n.id)}
                    >
                      <div className="truncate font-[550]">{n.title}</div>
                      {n.preview && (
                        <div className="mt-0.5 truncate text-[0.85em] text-muted">
                          {n.preview}
                        </div>
                      )}
                    </div>
                    {confirmId === n.id ? (
                      <div className="flex flex-none items-center gap-1">
                        <button
                          type="button"
                          className="cursor-pointer rounded-md bg-[#ff5f57] px-2 py-1 text-[0.75em] font-[550] text-white transition-[filter] hover:brightness-95 active:translate-y-[0.5px]"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteNote(n.id);
                          }}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          className="cursor-pointer rounded-md px-2 py-1 text-[0.75em] font-[550] text-muted transition-colors hover:bg-hover hover:text-card-fg active:translate-y-[0.5px]"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmId(null);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        title="Delete note"
                        aria-label="Delete note"
                        className={`flex-none cursor-pointer rounded-md p-1 text-muted transition-colors hover:bg-hover hover:text-[#ff5f57] active:translate-y-[0.5px] group-hover:opacity-100${
                          i === selected ? " opacity-100" : " opacity-0"
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected(i);
                          setConfirmId(n.id);
                        }}
                      >
                        {IconTrash}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <div className="border-t border-rule px-3.5 py-2 text-center text-[0.75em] text-muted">
                ↵ open · ⌘N new · ⌘⌫ delete · esc close
              </div>
            </div>
          ) : overlay === "actions" ? (
            <div className="flex h-full w-full flex-col overflow-hidden text-card-fg">
              <input
                ref={searchRef}
                className="border-b border-rule bg-transparent px-[18px] py-3 text-[1.05em] text-card-fg outline-none placeholder:text-muted"
                value={query}
                placeholder="Search actions…"
                spellCheck={false}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelected(0);
                }}
              />
              <ul className="flex-1 list-none overflow-y-auto p-1.5">
                {visibleActions.length === 0 && (
                  <li className="cursor-default px-3 py-2 text-muted">
                    No actions match
                  </li>
                )}
                {visibleActions.map((a, i) => (
                  <li
                    key={a.id}
                    className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2${
                      i === selected
                        ? " bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]"
                        : ""
                    }`}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => a.run()}
                  >
                    <span className="truncate font-[550]">{a.label}</span>
                    <kbd className="flex-none font-sans text-[0.75em] text-muted">
                      {a.hint}
                    </kbd>
                  </li>
                ))}
              </ul>
              <div className="border-t border-rule px-3.5 py-2 text-center text-[0.75em] text-muted">
                ↵ run · esc close
              </div>
            </div>
          ) : (
            <CodeMirror
              ref={editorRef}
              className="h-full w-full"
              value={content}
              onChange={handleChange}
              extensions={editorExtensions}
              basicSetup={editorSetup}
              theme="none"
              height="100%"
              placeholder={
                "Write anything here…\n\n⌘K actions · ⌘P notes · ⌘N new · esc hide"
              }
              autoFocus
            />
          )}
        </div>

        {/* bottom — markdown formatting toolbar (editor view only) */}
        {overlay === null && (
          <footer className="flex h-9 flex-none items-center justify-between gap-2 border-t border-rule bg-bar pl-1.5 pr-2">
            <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
              {formatTools.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  title={f.title}
                  className={fmtBtn}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={f.run}
                >
                  {f.node}
                </button>
              ))}
            </div>
            <button
              type="button"
              title="Actions (⌘K)"
              className="flex flex-none cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[0.75em] text-muted transition-colors hover:bg-hover hover:text-card-fg active:translate-y-[0.5px]"
              onMouseDown={(e) => e.preventDefault()}
              onClick={openActions}
            >
              Actions
              <kbd className="font-sans text-[0.95em]">⌘K</kbd>
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

export default App;
