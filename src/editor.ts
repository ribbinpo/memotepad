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
import { RangeSetBuilder, StateField, type EditorState } from "@codemirror/state";
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
        // Fenced-code backticks live on their own line, which the code plugin
        // collapses wholesale — hiding them here too would overlap-replace.
        if (node.name === "CodeMark" && node.node.parent?.name === "FencedCode")
          return;
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
