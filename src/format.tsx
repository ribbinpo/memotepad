// Markdown formatting commands shared by the bottom toolbar and the editor
// keymap. Everything here is a module-scope CodeMirror `Command` — no closure
// over React state — so a button click and a keypress run the same function.
//
// Every tool is a *toggle*: pressing it twice returns the document to exactly
// where it started.
import type { ReactNode } from "react";
import { EditorState, Prec, type ChangeDesc, type Line } from "@codemirror/state";
import { keymap, type Command } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

// ---- module-scope icons (constant JSX) ------------------------------------
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

// Every dispatch carries this so two consecutive toggles stay two undo steps.
const FORMAT_EVENT = "input.format";

// ---- inline marks (bold / italic / strike / code) -------------------------

// Longest emphasis run markdown gives a meaning to: *** = bold + italic.
const MAX_RUN = 3;

// Consecutive `ch` starting at `pos` walking in `dir` (dir = -1 counts the
// characters *before* `pos`), never crossing `limit`, never past MAX_RUN.
function runLen(state: EditorState, pos: number, dir: 1 | -1, ch: string, limit: number) {
  let k = 0;
  while (k < MAX_RUN) {
    const p = dir < 0 ? pos - k - 1 : pos + k;
    if (dir < 0 ? p < limit : p >= limit) break;
    if (state.sliceDoc(p, p + 1) !== ch) break;
    k++;
  }
  return k;
}

// How long the marker run should be after toggling. Asterisks are special:
// markdown reads a run of 1 as italic, 2 as bold, 3 as both — so bold and
// italic are two bits of *one* run, not two nested wrappers. That is what makes
// ⌘I inside **bold** give ***bold*** rather than a broken ***​*bold*​***.
function nextRun(ch: string, k: number, n: number) {
  if (ch !== "*") return k >= n ? k - n : k + n; // ~~ and ` are plain on/off
  const on = n === 1 ? k === 1 || k === 3 : k >= 2;
  return on ? k - n : k + n;
}

const WORD = /[\p{L}\p{N}_]/u;

// The word under `pos` — ⌘B with no selection toggles the whole word. Returns
// an empty range in whitespace, which the caller handles as "drop an empty pair
// in and put the cursor between the marks".
function wordAt(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  let i = pos - line.from;
  let j = i;
  while (i > 0 && WORD.test(line.text[i - 1])) i--;
  while (j < line.text.length && WORD.test(line.text[j])) j++;
  return { from: line.from + i, to: line.from + j };
}

// A cursor parked *inside* a marker run (`*|*text**`) would measure bogus half
// runs, so slide it out to the end of the run — except at the exact midpoint of
// an even run, which is the empty-wrapper case (`**|**`) we keep so a second ⌘B
// removes the pair.
function escapeRun(state: EditorState, pos: number, ch: string) {
  let rs = pos;
  let re = pos;
  while (rs > 0 && state.sliceDoc(rs - 1, rs) === ch) rs--;
  while (re < state.doc.length && state.sliceDoc(re, re + 1) === ch) re++;
  if (rs === pos || re === pos) return pos; // not inside a run
  if (pos - rs === re - pos) return pos; // **|**
  return re;
}

function toggleInline(ch: string, n: number): Command {
  return (view) => {
    if (view.state.readOnly) return false; // read mode
    const { state } = view;
    const sel = state.selection.main;
    const cursor = sel.empty ? escapeRun(state, sel.head, ch) : -1;
    const word = sel.empty ? wordAt(state, cursor) : null;

    // Shrink past marker chars the user selected along with the text
    // (`|**bold**|`) so from/to always bound the *inner* text.
    let from = word ? word.from : sel.from;
    let to = word ? word.to : sel.to;
    const lead = runLen(state, from, 1, ch, to);
    from += lead;
    const trail = runLen(state, to, -1, ch, from);
    to -= trail;

    // Then measure the full run on each side, inside + outside the selection.
    // The min() is the ambiguity guard: `**a**b` with the cursor in `b` sees
    // left=2 / right=0 → k=0, so italic inserts instead of stealing the bold's
    // closing marker.
    const left = lead + runLen(state, from - lead, -1, ch, 0);
    const right = trail + runLen(state, to + trail, 1, ch, state.doc.length);
    const k = Math.min(left, right, MAX_RUN);
    const marks = ch.repeat(nextRun(ch, k, n));
    const shift = marks.length - k;

    const fwd = sel.anchor <= sel.head;
    const at = word ? Math.min(Math.max(cursor, from), to) + shift : 0;
    view.dispatch({
      changes: [
        { from: from - k, to: from, insert: marks },
        { from: to, to: to + k, insert: marks },
      ],
      selection: word
        ? { anchor: at }
        : { anchor: (fwd ? from : to) + shift, head: (fwd ? to : from) + shift },
      scrollIntoView: true,
      userEvent: FORMAT_EVENT,
    });
    return true;
  };
}

// ---- line prefixes (heading / list / checklist / quote) --------------------
// `on` = "this line already carries exactly this prefix"; `family` = the
// sibling prefixes that get *swapped out* rather than stacked on top of.
type LinePrefix = { insert: string; on: RegExp; family?: RegExp };

const HEADING: LinePrefix = { insert: "# ", on: /^#\s+/, family: /^#{1,6}\s+/ };
const BULLET: LinePrefix = {
  insert: "- ",
  on: /^[-*+]\s+(?!\[[ xX]\]\s)/,
  family: /^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/,
};
const TASK: LinePrefix = {
  insert: "- [ ] ",
  on: /^[-*+]\s+\[[ xX]\]\s+/,
  family: /^(?:[-*+]|\d+[.)])\s+/,
};
const QUOTE: LinePrefix = { insert: "> ", on: /^>\s?/ };

// Every line the selection really touches. A selection that stops exactly at a
// line start (drag-selecting whole lines) must not drag the next line in.
function touchedLines(state: EditorState) {
  const sel = state.selection.main;
  const first = state.doc.lineAt(sel.from).number;
  let last = state.doc.lineAt(sel.to).number;
  if (last > first && state.doc.line(last).from === sel.to) last--;
  const out: Line[] = [];
  for (let n = first; n <= last; n++) out.push(state.doc.line(n));
  return out;
}

const indentOf = (text: string) => text.length - text.trimStart().length;

// Keep the selection where the user sees it once the prefixes shift: a bare
// cursor lands *after* an inserted prefix, while a range keeps its outer edges
// so a whole-line selection stays whole instead of starting after the `- `.
function mapSel(state: EditorState, changes: ChangeDesc) {
  const sel = state.selection.main;
  if (sel.empty) return { anchor: changes.mapPos(sel.head, 1) };
  const fwd = sel.anchor <= sel.head;
  return {
    anchor: changes.mapPos(sel.anchor, fwd ? -1 : 1),
    head: changes.mapPos(sel.head, fwd ? 1 : -1),
  };
}

function togglePrefix(p: LinePrefix): Command {
  return (view) => {
    if (view.state.readOnly) return false; // read mode
    const { state } = view;
    const lines = touchedLines(state);
    // Blank lines can never carry a prefix, so counting them would make "every
    // line is already on" impossible — skip them, unless that's all there is.
    let targets = lines.filter((l) => l.text.trim().length);
    if (!targets.length) targets = lines;

    const bodies = targets.map((l) => l.text.slice(indentOf(l.text)));
    const allOn = bodies.every((b) => p.on.test(b));

    const specs: { from: number; to: number; insert?: string }[] = [];
    targets.forEach((l, i) => {
      const at = l.from + indentOf(l.text); // keep the indentation
      const on = p.on.exec(bodies[i]);
      if (allOn && on) {
        specs.push({ from: at, to: at + on[0].length });
      } else if (!on) {
        const fam = p.family?.exec(bodies[i]);
        specs.push({ from: at, to: at + (fam ? fam[0].length : 0), insert: p.insert });
      }
    });
    if (!specs.length) return true;

    // Per-line deltas vary (swaps, removals, skipped blanks), so let CodeMirror
    // map the selection rather than doing the offset math by hand.
    const changes = state.changes(specs);
    view.dispatch({
      changes,
      selection: mapSel(state, changes),
      scrollIntoView: true,
      userEvent: FORMAT_EVENT,
    });
    return true;
  };
}

// ---- fenced code block ----------------------------------------------------
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*$/;

// Walk up to the enclosing FencedCode node — the same node `codeBackground` in
// editor.ts keys off.
// Both sides, because a cursor at the very end of the block (an unclosed fence,
// or just after the closing one) resolves *forward* out of the node and lands
// on Document. The node stops at the last backtick — it never swallows the
// trailing newline — so side -1 can't reach it from the line below.
function fenceAt(state: EditorState, pos: number) {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    let n: ReturnType<typeof syntaxTree>["topNode"] | null = tree.resolveInner(pos, side);
    while (n) {
      if (n.name === "FencedCode") return n;
      n = n.parent;
    }
  }
  return null;
}

const toggleCodeBlock: Command = (view) => {
  if (view.state.readOnly) return false; // read mode
  const { state } = view;
  const doc = state.doc;
  const sel = state.selection.main;
  const node = fenceAt(state, sel.from);

  if (node) {
    // Unwrap: drop the opening fence line with its newline, and the closing
    // fence line with the newline before it (an unclosed block has neither).
    const open = doc.lineAt(node.from);
    const close = doc.lineAt(Math.max(node.from, node.to - 1));
    const openEnd = Math.min(open.to + 1, doc.length);
    const specs = [{ from: open.from, to: openEnd }];
    if (close.number > open.number && FENCE_RE.test(close.text))
      // Clamp: on a bare ```/``` pair `close.from - 1` sits inside the first
      // span, and ChangeSet.of throws "Overlapping changes" at runtime.
      specs.push({ from: Math.max(openEnd, close.from - 1), to: close.to });
    const changes = state.changes(specs);
    view.dispatch({
      changes,
      selection: mapSel(state, changes),
      scrollIntoView: true,
      userEvent: FORMAT_EVENT,
    });
    return true;
  }

  // Wrap — snapped to whole lines, because a fence has to start at a line
  // boundary (wrapping mid-line produces an unparseable block).
  const lines = touchedLines(state);
  const from = lines[0].from;
  const to = lines[lines.length - 1].to;
  const inner = doc.sliceString(from, to);
  view.dispatch({
    changes: { from, to, insert: "```\n" + inner + "\n```" },
    selection: { anchor: from + 4, head: from + 4 + inner.length }, // after "```\n"
    scrollIntoView: true,
    userEvent: FORMAT_EVENT,
  });
  return true;
};

// ---- link -----------------------------------------------------------------
// Deliberately *not* a toggle: unlinking is rare and an accidental second press
// eating a real URL is worse than the placeholder churn it would save.
const URL_RE = /^(?:https?:\/\/|mailto:)\S+$/i;

const insertLink: Command = (view) => {
  if (view.state.readOnly) return false; // read mode
  const { state } = view;
  const sel = state.selection.main;
  const picked = state.sliceDoc(sel.from, sel.to).trim();
  const isUrl = URL_RE.test(picked); // selected a URL? make it the target
  const text = isUrl ? "" : picked || "text";
  const url = isUrl ? picked : "url";
  const anchor = isUrl ? sel.from + 1 : sel.from + text.length + 3; // "[" or "]("
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: `[${text}](${url})` },
    selection: isUrl ? { anchor } : { anchor, head: anchor + url.length }, // select "url"
    scrollIntoView: true,
    userEvent: FORMAT_EVENT,
  });
  return true;
};

// ---- the tool list --------------------------------------------------------
// Single source of truth for the toolbar: the button, its tooltip and its key
// binding all come from one row, so adding a tool means editing one array.
export type FormatTool = {
  id: string;
  title: string;
  hint: string;
  keys: string;
  node: ReactNode;
  run: Command;
};

export const formatTools: FormatTool[] = [
  { id: "h", title: "Heading", hint: "⌘⇧H", keys: "Mod-Shift-h", node: <span className="font-bold">H</span>, run: togglePrefix(HEADING) },
  { id: "b", title: "Bold", hint: "⌘B", keys: "Mod-b", node: <span className="font-bold">B</span>, run: toggleInline("*", 2) },
  { id: "i", title: "Italic", hint: "⌘I", keys: "Mod-i", node: <span className="italic" style={{ fontFamily: "Georgia, serif" }}>I</span>, run: toggleInline("*", 1) },
  { id: "s", title: "Strikethrough", hint: "⌘⇧X", keys: "Mod-Shift-x", node: <span className="line-through">S</span>, run: toggleInline("~", 2) },
  { id: "code", title: "Inline code", hint: "⌘⇧C", keys: "Mod-Shift-c", node: <span className="font-mono text-[0.8em]">{"</>"}</span>, run: toggleInline("`", 1) },
  { id: "link", title: "Link", hint: "⌘⇧K", keys: "Mod-Shift-k", node: IconLink, run: insertLink },
  { id: "ul", title: "Bullet list", hint: "⌘⇧8", keys: "Mod-Shift-8", node: IconList, run: togglePrefix(BULLET) },
  { id: "task", title: "Checklist", hint: "⌘⇧7", keys: "Mod-Shift-7", node: <span className="text-[0.95em]">☑</span>, run: togglePrefix(TASK) },
  { id: "quote", title: "Quote", hint: "⌘⇧9", keys: "Mod-Shift-9", node: <span style={{ fontFamily: "Georgia, serif" }} className="text-[1.1em] leading-none">”</span>, run: togglePrefix(QUOTE) },
  { id: "codeblock", title: "Code block", hint: "⌘⌥⇧C", keys: "Mod-Alt-Shift-c", node: <span className="font-mono text-[0.8em]">{"{ }"}</span>, run: toggleCodeBlock },
];

// Prec.highest because basicSetup installs defaultKeymap at default precedence,
// and it already claims Mod-i (selectParentSyntax) and Shift-Mod-k (deleteLine)
// with preventDefault — a lower-precedence binding would simply never fire.
export const formatKeymap = Prec.highest(
  keymap.of(
    formatTools.map((t) => ({
      key: t.keys,
      run: t.run,
      preventDefault: true,
      // CodeMirror's keydown handler lives on contentDOM while React delegates
      // at the root, so CM sees the event first but it still bubbles on to
      // handleKeyDown. stopPropagation is what keeps ⌘⇧K from *also* opening
      // the ⌘K action panel.
      stopPropagation: true,
    })),
  ),
);
