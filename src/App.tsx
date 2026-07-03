import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { noteTheme, noteHighlight, livePreview } from "./editor";
import "./App.css";

const editorExtensions = [
  markdown(),
  EditorView.lineWrapping,
  noteTheme,
  syntaxHighlighting(noteHighlight),
  livePreview,
];

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

function App() {
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
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
    if (activeIdRef.current) invoke("write_note", { id: activeIdRef.current, content: text });
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
    setPalette(false);
  }

  async function newNote() {
    flushSave(content);
    const id = await invoke<string>("create_note");
    await refreshNotes();
    await openNote(id, { save: false });
  }

  async function deleteNote(id: string) {
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
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused && !palette) editorRef.current?.view?.focus();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [palette]);

  // Keep focus on whichever pane is showing so shortcuts always land.
  useEffect(() => {
    if (palette) searchRef.current?.focus();
    else editorRef.current?.view?.focus();
  }, [palette]);

  // Apply + persist the note's translucency.
  useEffect(() => {
    document.documentElement.style.setProperty("--opacity", String(opacity));
    localStorage.setItem("opacity", String(opacity));
  }, [opacity]);

  const clampOpacity = (v: number) => Math.min(1, Math.max(0.4, Math.round(v * 100) / 100));

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

  // ---- search -----------------------------------------------------------
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter(
      (n) => n.title.toLowerCase().includes(q) || n.body.includes(q),
    );
  }, [notes, query]);

  function openPalette() {
    refreshNotes();
    setQuery("");
    setSelected(0);
    setPalette(true);
  }

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

    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      palette ? setPalette(false) : openPalette();
      return;
    }
    if (mod && e.key.toLowerCase() === "n") {
      e.preventDefault();
      newNote();
      return;
    }

    if (palette) {
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
        setPalette(false);
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      await getCurrentWindow().hide();
    }
  }

  // ---- render -----------------------------------------------------------
  return (
    <div className="wrap" onKeyDown={handleKeyDown}>
      <div className="card">
        <header className="bar" data-tauri-drag-region>
          <span className="bar-title" data-tauri-drag-region>
            {palette ? "Notes" : activeTitle}
          </span>
          <div className="bar-actions">
            <button
              type="button"
              title="Search notes (⌘K)"
              className={palette ? "on" : ""}
              onClick={() => (palette ? setPalette(false) : openPalette())}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <line x1="10.4" y1="10.4" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            <button type="button" title="New note (⌘N)" onClick={newNote}>
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="2.5" y1="8" x2="13.5" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>
        <div className="body">
          {palette ? (
        <div className="palette">
          <input
            ref={searchRef}
            className="search"
            value={query}
            placeholder="Search notes…"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
          />
          <ul className="results">
            {filtered.length === 0 && <li className="empty">No notes match</li>}
            {filtered.map((n, i) => (
              <li
                key={n.id}
                className={i === selected ? "sel" : ""}
                onMouseEnter={() => setSelected(i)}
                onClick={() => openNote(n.id)}
              >
                <div className="t">{n.title}</div>
                {n.preview && <div className="p">{n.preview}</div>}
              </li>
            ))}
          </ul>
          <div className="hint">↵ open · ⌘N new · ⌘⌫ delete · esc close</div>
        </div>
      ) : (
        <CodeMirror
          ref={editorRef}
          className="note"
          value={content}
          onChange={handleChange}
          extensions={editorExtensions}
          basicSetup={editorSetup}
          theme="none"
          height="100%"
          placeholder={
            "Write anything here…\n\n⌘K notes · ⌘1–3 size · ⌘± opacity · Esc hide"
          }
          autoFocus
        />
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
