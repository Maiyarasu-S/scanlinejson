/* keys.js: which action a page-wide shortcut means. No page access: app.js runs the action it names.
   Keeping the map here means a test can check every shortcut, and a shortcut keeps working whether or not
   the button for its action is on screen. */
(() => {
'use strict';

/* Alt+key, by physical key (Alt changes the character on some layouts) */
const ALT = { KeyQ: 'query', KeyC: 'copy', KeyM: 'minify', KeyS: 'sort', KeyF: 'fold', KeyT: 'theme', Digit1: 'tabA', Digit2: 'tabB' };

/* e: { key, code, ctrl, meta, alt, shift }.  typing: focus is in a text field.
   Returns an action id, or null when the key is not ours. */
function lookup(e, typing) {
  const mod = !!(e.ctrl || e.meta), alt = !!e.alt, k = String(e.key || '').toLowerCase();
  if (mod && !alt && !e.shift) {
    if (k === 'f') return 'find';
    if (k === 's') return 'save';
    if (k === 'enter') return 'format';
  }
  if (alt && !mod) return ALT[e.code] || null;
  if (mod && !alt && !typing) {                 /* undo and redo also work when focus is on a button or the tree */
    if (k === 'z' && !e.shift) return 'undo';
    if (k === 'y' || (k === 'z' && e.shift)) return 'redo';
    return null;
  }
  if (typing || mod) return null;
  if (e.key === '/') return 'find';
  if (e.key === '?') return 'help';
  if (e.key === 'Escape') return 'closeInsp';
  return null;
}

JF.keys = { ALT, lookup };
})();
