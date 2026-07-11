// Shared logic used by both the service worker (bg-db.js / bg-rules.js / bg-sync.js)
// and the sidebar (helpers.js). Add only code that has no DOM, Chrome API, or SQL dependency.

export function parseSearchTerms(q) {
  const terms = [];
  const re = /(\w+):(\S+)|(\S+)/gi;
  let m;
  while ((m = re.exec((q ?? ''))) !== null) {
    if (m[1]) terms.push({ field: m[1], value: m[2] });
    else      terms.push({ field: null, value: m[3] });
  }
  return terms;
}
