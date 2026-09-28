// Re-export surface bundled into lib/codemirror.js by `npm run build:cm`. One bundle
// keeps a single @codemirror/state instance (duplicates break extension identity);
// the editor setup itself lives in js/sql-editor.js so it can change without a rebuild.
export { EditorView, keymap, drawSelection, highlightSpecialChars, placeholder, lineNumbers } from '@codemirror/view';
export { EditorState, Compartment, Prec } from '@codemirror/state';
export { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
export { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
export { autocompletion, acceptCompletion, startCompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
export { sql, SQLite } from '@codemirror/lang-sql';
export { tags } from '@lezer/highlight';
