// Live-markdown styling for the single always-editable note surface.
// Raw markdown stays in the document (source of truth); we just render it
// styled inline — headings grow, **bold** is bold, syntax marks dim, and a few
// block/inline constructs (tables, dividers, checkboxes, radios, links) render
// as real components — so the editor reads like Notion/Raycast with no separate
// preview mode. Every rendered component reveals its raw markdown the moment the
// cursor lands on its line, so editing always stays raw.
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxTree } from "@codemirror/language";
import { StateField, type EditorState, type Range } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import { invoke } from "@tauri-apps/api/core";

// GitHub-flavored markdown (tables, task lists, strikethrough, autolinks) — the
// `markdownLanguage` base turns those on so the parser produces `Table` nodes etc.
export const markdownExtension = markdown({ base: markdownLanguage });

// Transparent chrome so the frosted card shows through; inherit the app font.
export const noteTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--card-fg)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "1.6",
    overflow: "auto",
  },
  ".cm-content": {
    padding: "16px 20px 20px",
    caretColor: "var(--accent)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--card-fg)" },
  ".cm-placeholder": { color: "var(--muted)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--sel)",
  },
  // Inline `code` — a rounded pill so it stands out from body text.
  ".cm-inline-code": {
    background: "var(--code-bg)",
    borderRadius: "5px",
    padding: "0.1em 0.35em",
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
  },
  // Fenced ``` code blocks — full-width tinted band, rounded at the ends.
  ".cm-code-block": { background: "var(--code-bg)" },
  ".cm-code-block.cm-code-first": {
    borderTopLeftRadius: "8px",
    borderTopRightRadius: "8px",
  },
  ".cm-code-block.cm-code-last": {
    borderBottomLeftRadius: "8px",
    borderBottomRightRadius: "8px",
  },
  // Empty ``` delimiter lines: a thin tinted strip instead of a full row.
  ".cm-code-block.cm-code-fence": { fontSize: "0", lineHeight: "10px" },

  // ---- rendered components -------------------------------------------------
  // Clickable link (opens externally). Raw `[text](url)` shows on the active line.
  ".cm-md-link": {
    color: "var(--accent)",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
  },
  // Thematic break (`---`, `***`, `___`).
  ".cm-md-divider": {
    display: "inline-block",
    width: "100%",
    height: "1px",
    verticalAlign: "middle",
    background: "var(--rule)",
  },
  // Task checkbox (`- [ ]` / `- [x]`).
  ".cm-md-checkbox": {
    display: "inline-block",
    width: "13px",
    height: "13px",
    verticalAlign: "-2px",
    marginRight: "3px",
    boxSizing: "border-box",
    borderRadius: "3px",
    border: "1.5px solid var(--muted)",
    position: "relative",
    cursor: "pointer",
  },
  ".cm-md-checkbox.cm-md-checked": {
    background: "var(--accent)",
    borderColor: "var(--accent)",
  },
  ".cm-md-checkbox.cm-md-checked::after": {
    content: '""',
    position: "absolute",
    left: "3.5px",
    top: "0.5px",
    width: "3px",
    height: "6px",
    border: "solid #fff",
    borderWidth: "0 1.6px 1.6px 0",
    transform: "rotate(45deg)",
  },
  // Radio (`- ( )` / `- (x)`) — non-standard markdown, rendered for convenience.
  ".cm-md-radio": {
    display: "inline-block",
    width: "13px",
    height: "13px",
    verticalAlign: "-2px",
    marginRight: "3px",
    boxSizing: "border-box",
    borderRadius: "50%",
    border: "1.5px solid var(--muted)",
    position: "relative",
    cursor: "pointer",
  },
  ".cm-md-radio.cm-md-checked": { borderColor: "var(--accent)" },
  ".cm-md-radio.cm-md-checked::after": {
    content: '""',
    position: "absolute",
    left: "50%",
    top: "50%",
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    background: "var(--accent)",
    transform: "translate(-50%, -50%)",
  },
  // GFM table.
  ".cm-md-table-wrap": { padding: "3px 0", overflowX: "auto" },
  ".cm-md-table": {
    borderCollapse: "collapse",
    fontSize: "0.92em",
    cursor: "text",
  },
  ".cm-md-table th, .cm-md-table td": {
    border: "1px solid var(--rule)",
    padding: "3px 9px",
    textAlign: "left",
  },
  ".cm-md-table th": { background: "var(--code-bg)", fontWeight: "600" },
});

export const noteHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.5em", fontWeight: "700", lineHeight: "1.3" },
  { tag: t.heading2, fontSize: "1.25em", fontWeight: "700", lineHeight: "1.3" },
  { tag: t.heading3, fontSize: "1.1em", fontWeight: "700" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
  { tag: t.url, color: "var(--accent)" },
  {
    tag: t.monospace,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: "0.9em",
  },
  { tag: t.quote, color: "var(--muted)", fontStyle: "italic" },
  // Markdown syntax marks that remain visible (revealed line) — dimmed.
  { tag: [t.processingInstruction, t.meta], color: "var(--muted)" },
]);

// ---- widgets --------------------------------------------------------------
class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly from: number) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.from === this.from;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-checkbox" + (this.checked ? " cm-md-checked" : "");
    el.dataset.mdToggle = "check";
    el.dataset.from = String(this.from);
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

class RadioWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly from: number) {
    super();
  }
  eq(o: RadioWidget) {
    return o.checked === this.checked && o.from === this.from;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-radio" + (this.checked ? " cm-md-checked" : "");
    el.dataset.mdToggle = "radio";
    el.dataset.from = String(this.from);
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

class DividerWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-divider";
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

class LinkWidget extends WidgetType {
  constructor(readonly text: string, readonly href: string) {
    super();
  }
  eq(o: LinkWidget) {
    return o.text === this.text && o.href === this.href;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-link";
    el.textContent = this.text;
    el.dataset.mdLink = "1";
    el.dataset.href = this.href;
    el.title = this.href;
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

// Renders a GFM table from its raw markdown. Cell contents stay plain text (the
// source is still the truth); clicking drops the cursor in to edit the raw rows.
class TableWidget extends WidgetType {
  constructor(readonly md: string, readonly from: number) {
    super();
  }
  eq(o: TableWidget) {
    return o.md === this.md && o.from === this.from;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    wrap.dataset.mdTable = "1";
    wrap.dataset.from = String(this.from);

    const table = document.createElement("table");
    table.className = "cm-md-table";

    const rows = this.md.split("\n").filter((l) => l.trim().length);
    const cells = (line: string) => {
      let s = line.trim();
      if (s.startsWith("|")) s = s.slice(1);
      if (s.endsWith("|")) s = s.slice(0, -1);
      return s.split("|").map((c) => c.trim());
    };
    const isDelim = (line: string) => /^[\s|:-]+$/.test(line) && line.includes("-");
    const bodyStart = rows[1] && isDelim(rows[1]) ? 2 : 1;

    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    for (const c of rows[0] ? cells(rows[0]) : []) {
      const th = document.createElement("th");
      th.textContent = c;
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (let i = bodyStart; i < rows.length; i++) {
      const tr = document.createElement("tr");
      for (const c of cells(rows[i])) {
        const td = document.createElement("td");
        td.textContent = c;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

// ---- shared helpers -------------------------------------------------------
const HIDE_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "QuoteMark",
]);
const hideMark = Decoration.replace({});

// A list item: (indent)(bullet)(marker), where marker is `[ ]`/`[x]` (checkbox)
// or `( )`/`(x)` (radio). Group 1 = indent, group 2 = bullet, group 3 = state —
// the whole `(indent)(bullet)[ ]` is replaced by the widget so the raw bullet
// doesn't sit next to the rendered box.
const CHECK_RE = /^(\s*)((?:[-*+]|\d+[.)])\s+)\[([ xX])\]/;
const RADIO_RE = /^(\s*)((?:[-*+]|\d+[.)])\s+)\(([ xX])\)/;
const DIVIDER_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

// Byte offset of the `[`/`(` marker within a line matched by CHECK_RE/RADIO_RE.
const markerAt = (lineFrom: number, m: RegExpExecArray) =>
  lineFrom + m[1].length + m[2].length;

const overlaps = (state: EditorState, from: number, to: number) =>
  state.selection.ranges.some((r) => r.from <= to && r.to >= from);

// ---- inline live preview (marks, dividers, checkboxes, radios, links) -----
// These are all single-line decorations, so they're safe to serve from a view
// plugin. (Block/multi-line decorations — the tables — must come from a state
// field instead; CodeMirror forbids plugins from changing block layout.)
function inlineDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const ranges: Range<Decoration>[] = [];

  // Inactive tables render as block widgets (state field below); collect their
  // spans so we don't also decorate the raw text sitting underneath them.
  const tableSpans: [number, number][] = [];
  syntaxTree(state).iterate({
    from: 0,
    to: doc.length,
    enter(node) {
      if (node.name !== "Table") return;
      if (!overlaps(state, node.from, node.to)) tableSpans.push([node.from, node.to]);
      return false;
    },
  });
  const inTable = (pos: number) => tableSpans.some(([f, to]) => pos >= f && pos <= to);

  for (const { from, to } of view.visibleRanges) {
    // Hide syntax marks + render links, walking the syntax tree.
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name === "Link") {
          const line = doc.lineAt(node.from);
          if (inTable(line.from) || overlaps(state, line.from, line.to)) return;
          const slice = doc.sliceString(node.from, node.to);
          const m = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+[^)]*)?\)$/.exec(slice);
          if (!m) return;
          ranges.push(
            Decoration.replace({ widget: new LinkWidget(m[1] || m[2], m[2]) }).range(
              node.from,
              node.to,
            ),
          );
          return false;
        }
        if (!HIDE_MARKS.has(node.name)) return;
        if (node.name === "CodeMark" && node.node.parent?.name === "FencedCode") return;
        const line = doc.lineAt(node.from);
        if (inTable(line.from) || overlaps(state, line.from, line.to)) return;
        let end = node.to;
        if (
          (node.name === "HeaderMark" || node.name === "QuoteMark") &&
          doc.sliceString(end, end + 1) === " "
        ) {
          end += 1;
        }
        ranges.push(hideMark.range(node.from, end));
      },
    });
  }

  // Line-scan for dividers / checkboxes / radios (independent of the parser, so
  // it behaves the same whether or not GFM tokenized a given line).
  const startLine = doc.lineAt(view.visibleRanges[0]?.from ?? 0).number;
  const endLine = doc.lineAt(
    view.visibleRanges[view.visibleRanges.length - 1]?.to ?? 0,
  ).number;
  for (let n = startLine; n <= endLine; n++) {
    const line = doc.line(n);
    if (inTable(line.from) || overlaps(state, line.from, line.to)) continue;
    const text = line.text;

    if (DIVIDER_RE.test(text) && text.trim().length >= 3) {
      ranges.push(
        Decoration.replace({ widget: new DividerWidget() }).range(line.from, line.to),
      );
      continue;
    }
    let m = CHECK_RE.exec(text);
    if (m) {
      const bullet = line.from + m[1].length;
      const at = markerAt(line.from, m);
      ranges.push(
        Decoration.replace({
          widget: new CheckboxWidget(m[3].toLowerCase() === "x", at),
        }).range(bullet, at + 3),
      );
      continue;
    }
    m = RADIO_RE.exec(text);
    if (m) {
      const bullet = line.from + m[1].length;
      const at = markerAt(line.from, m);
      ranges.push(
        Decoration.replace({
          widget: new RadioWidget(m[3].toLowerCase() === "x", at),
        }).range(bullet, at + 3),
      );
    }
  }

  return Decoration.set(ranges, true);
}

// Toggle a radio: turn the clicked one on and every other radio in the same
// contiguous run off (real single-select behaviour).
function toggleRadio(view: EditorView, from: number) {
  const doc = view.state.doc;
  const clicked = doc.lineAt(from).number;
  let start = clicked;
  let end = clicked;
  while (start > 1 && RADIO_RE.test(doc.line(start - 1).text)) start--;
  while (end < doc.lines && RADIO_RE.test(doc.line(end + 1).text)) end++;

  const changes: { from: number; to: number; insert: string }[] = [];
  for (let n = start; n <= end; n++) {
    const line = doc.line(n);
    const m = RADIO_RE.exec(line.text);
    if (!m) continue;
    const at = markerAt(line.from, m);
    const want = at === from ? "(x)" : "( )";
    if (doc.sliceString(at, at + 3) !== want) changes.push({ from: at, to: at + 3, insert: want });
  }
  if (changes.length) view.dispatch({ changes });
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = inlineDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = inlineDecorations(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(e, view) {
        const target = (e.target as HTMLElement).closest(
          "[data-md-toggle], [data-md-link], [data-md-table]",
        ) as HTMLElement | null;
        if (!target) return false;
        e.preventDefault();

        if (target.dataset.mdLink) {
          const href = target.dataset.href ?? "";
          if (/^(https?:|mailto:)/i.test(href))
            invoke("open_external", { url: href }).catch(() => {});
          return true;
        }
        if (target.dataset.mdTable) {
          view.dispatch({ selection: { anchor: Number(target.dataset.from) } });
          view.focus();
          return true;
        }

        const at = Number(target.dataset.from);
        if (target.dataset.mdToggle === "check") {
          const checked = /[xX]/.test(view.state.doc.sliceString(at, at + 3));
          view.dispatch({ changes: { from: at, to: at + 3, insert: checked ? "[ ]" : "[x]" } });
        } else {
          toggleRadio(view, at);
        }
        view.focus();
        return true;
      },
    },
  },
);

// ---- tables (block widgets — must be a state field, not a view plugin) -----
function tableDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    from: 0,
    to: doc.length,
    enter(node) {
      if (node.name !== "Table") return;
      if (overlaps(state, node.from, node.to)) return false; // active → show raw
      // Block replacements must cover whole lines, so snap to line boundaries
      // (a table may carry up to 3 spaces of leading indent).
      const from = doc.lineAt(node.from).from;
      const to = doc.lineAt(Math.max(node.from, node.to - 1)).to;
      ranges.push(
        Decoration.replace({
          widget: new TableWidget(doc.sliceString(node.from, node.to), node.from),
          block: true,
        }).range(from, to),
      );
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

export const tableView = StateField.define<DecorationSet>({
  create: (state) => tableDecorations(state),
  update(deco, tr) {
    if (tr.docChanged || tr.selection) return tableDecorations(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---- Code backgrounds: tint inline `code` and fenced ``` blocks -----------
const inlineCode = Decoration.mark({ class: "cm-inline-code" });

const isFenceLine = (text: string) => /^\s{0,3}(`{3,}|~{3,})/.test(text);

// One tinted band line. `fenceInactive` shrinks the empty ``` delimiter lines
// to a thin strip, so the band reads as padding rather than full empty rows.
function lineDeco(isFirst: boolean, isLast: boolean, fenceInactive: boolean) {
  let cls = "cm-code-block";
  if (isFirst) cls += " cm-code-first";
  if (isLast) cls += " cm-code-last";
  if (fenceInactive) cls += " cm-code-fence";
  return Decoration.line({ class: cls });
}

function buildCodeDecorations(state: EditorState): DecorationSet {
  const sel = state.selection;
  const doc = state.doc;
  const ranges: ReturnType<Decoration["range"]>[] = [];
  const onActiveLine = (from: number, to: number) =>
    sel.ranges.some((r) => r.from <= to && r.to >= from);

  syntaxTree(state).iterate({
    from: 0,
    to: doc.length,
    enter(node) {
      if (node.name === "InlineCode") {
        ranges.push(inlineCode.range(node.from, node.to));
        return;
      }
      if (node.name !== "FencedCode" && node.name !== "CodeBlock") return;

      const startNum = doc.lineAt(node.from).number;
      const endNum = doc.lineAt(Math.max(node.from, node.to - 1)).number;
      const fenced = node.name === "FencedCode";

      for (let n = startNum; n <= endNum; n++) {
        const line = doc.line(n);
        const isFirst = n === startNum;
        const isLast = n === endNum;
        // Opening line is always a fence; closing line only if it looks like
        // one (an unclosed block's last line is really content).
        const isFence =
          fenced && (isFirst || (isLast && isFenceLine(line.text)));
        const fenceInactive = isFence && !onActiveLine(line.from, line.to);
        ranges.push(lineDeco(isFirst, isLast, fenceInactive).range(line.from));
      }
    },
  });
  return Decoration.set(ranges, true);
}

// A StateField keyed on selection so fence lines expand back to full height
// when the cursor lands on them (to edit the ``` or its language).
export const codeBackground = StateField.define<DecorationSet>({
  create: (state) => buildCodeDecorations(state),
  update(deco, tr) {
    if (tr.docChanged || tr.selection) return buildCodeDecorations(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
