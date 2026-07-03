// Live-markdown styling for the single always-editable note surface.
// Raw markdown stays in the document (source of truth); we just render it
// styled inline — headings grow, **bold** is bold, syntax marks dim — so the
// editor reads like Notion/Raycast with no separate preview mode.
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { HighlightStyle, syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

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
    backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)",
  },
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

// ---- Live preview: hide the markdown syntax marks off the active line -----
// So `# Heading` reads as a heading, `**bold**` as bold — Notion/Raycast style.
// The marks reappear only on the line the cursor is on, so editing stays raw.
const HIDE_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "QuoteMark",
]);

const hideMark = Decoration.replace({});

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  const sel = state.selection;
  // A line is "active" (marks revealed) when a cursor/selection touches it.
  const onActiveLine = (from: number, to: number) =>
    sel.ranges.some((r) => r.from <= to && r.to >= from);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (!HIDE_MARKS.has(node.name)) return;
        const line = state.doc.lineAt(node.from);
        if (onActiveLine(line.from, line.to)) return;
        // For headers/quotes, swallow the single space after the mark too.
        let end = node.to;
        if (
          (node.name === "HeaderMark" || node.name === "QuoteMark") &&
          state.doc.sliceString(end, end + 1) === " "
        ) {
          end += 1;
        }
        builder.add(node.from, end, hideMark);
      },
    });
  }
  return builder.finish();
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
