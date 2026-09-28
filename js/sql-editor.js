import {
  EditorView, EditorState, Compartment, Prec, keymap, drawSelection, highlightSpecialChars, placeholder, lineNumbers,
  defaultKeymap, history, historyKeymap, syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput,
  autocompletion, acceptCompletion, startCompletion, closeBrackets, closeBracketsKeymap,
  sql, SQLite, tags as t,
} from '../lib/codemirror.js';

// Colors reference the theme's CSS custom properties, so the config color pickers
// restyle the editor live.
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--surface)', color: 'var(--text)', fontSize: '12px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: "'JetBrains Mono','Consolas',monospace", lineHeight: '1.4' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '6px 0' },
  '.cm-line': { padding: '0 8px' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--muted)', border: 'none',
                   borderRight: '1px solid var(--border)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    { backgroundColor: 'var(--border)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--border)', outline: 'none' },
  '.cm-placeholder': { color: 'var(--muted)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--bg)' },
  '.cm-completionDetail': { color: 'var(--muted)' },
}, { dark: true });

const highlight = HighlightStyle.define([
  { tag: t.keyword,                            color: 'var(--accent)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)],      color: 'var(--tab-icon)' },
  { tag: [t.number, t.bool, t.null],           color: 'var(--win-icon)' },
  { tag: [t.typeName, t.standard(t.name)],     color: 'var(--note-icon)' },
  { tag: [t.lineComment, t.blockComment],      color: 'var(--muted)', fontStyle: 'italic' },
  { tag: t.special(t.name),                    color: 'var(--dup-url)' },
]);

const sqlLang = schema => sql({ dialect: SQLite, schema, upperCaseKeywords: true });

// Textarea-like wrapper: `.value` get/set, plus setSchema({ table: [col, …] }) to
// feed table/column completion. Tab accepts the open completion or opens one;
// Mod-Enter runs (highest precedence so it beats insertBlankLine).
export function createSqlEditor(parent, { onRun, placeholderText = '' }) {
  const schemaConf = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      extensions: [
        lineNumbers(), highlightSpecialChars(), history(), drawSelection(), indentOnInput(),
        bracketMatching(), closeBrackets(), autocompletion(),
        EditorView.lineWrapping, placeholder(placeholderText),
        schemaConf.of(sqlLang({})),
        syntaxHighlighting(highlight), theme,
        Prec.highest(keymap.of([
          { key: 'Mod-Enter', run: () => { onRun(); return true; } },
          { key: 'Tab',       run: v => acceptCompletion(v) || startCompletion(v) },
        ])),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
      ],
    }),
  });
  return {
    get value() { return view.state.doc.toString(); },
    set value(s) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s ?? '' } }); },
    focus() { view.focus(); },
    setSchema(schema) { view.dispatch({ effects: schemaConf.reconfigure(sqlLang(schema)) }); },
  };
}
