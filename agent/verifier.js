// Independent verifier. It never trusts the agent's "done": it reads the system of record directly
// and (optionally) re-checks the values against the source document's text.
const { extractText, safePath } = require('./tools');

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function numEqual(a, b) {
  const x = Number(String(a).replace(/,/g, '')), y = Number(String(b).replace(/,/g, ''));
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 0.005;
}
function isNumeric(v) { return v !== '' && v !== null && Number.isFinite(Number(String(v).replace(/,/g, ''))); }
function valuesEqual(expected, actual) {
  if (isNumeric(expected) && isNumeric(actual)) return numEqual(expected, actual);
  return String(expected ?? '').trim().toLowerCase() === String(actual ?? '').trim().toLowerCase();
}

function variants(value) {
  const s = String(value).trim();
  if (isNumeric(s)) {
    const n = Number(s.replace(/,/g, ''));
    const fixed = n.toFixed(2);
    const [int, dec] = fixed.split('.');
    const grouped = Number(int).toLocaleString('en-US');
    return [String(n), fixed, `${grouped}.${dec}`, grouped];
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [, y, mo, d] = m;
    const name = MONTHS[Number(mo) - 1];
    return [s, `${d} ${name} ${y}`, `${Number(d)} ${name} ${y}`, `${name} ${Number(d)}, ${y}`, `${d}/${mo}/${y}`];
  }
  return [s];
}

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Match a value as a whole token: "250" must not match inside "1,250.00".
function containsToken(hay, v) {
  return new RegExp(`(?<![\\d.,])${escapeRe(v.toLowerCase())}(?!\\d)`).test(hay.toLowerCase());
}
function inSource(value, text) {
  const hay = text.replace(/\s+/g, ' ');
  return variants(value).some((v) => containsToken(hay, v));
}

// Pull comparable values out of a line of document text (used to detect conflicting values).
const MONTH_RE = MONTHS.join('|');
const pad = (n) => String(n).padStart(2, '0');
function extractDates(line) {
  const found = []; let rest = line;
  const take = (re, toIso) => { rest = rest.replace(re, (...m) => { const iso = toIso(m); if (iso) found.push(iso); return ' '; }); };
  const monthNo = (name) => MONTHS.findIndex((x) => x.toLowerCase() === name.toLowerCase()) + 1;
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => `${m[1]}-${m[2]}-${m[3]}`);
  take(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_RE})\\s+(\\d{4})\\b`, 'gi'), (m) => `${m[3]}-${pad(monthNo(m[2]))}-${pad(m[1])}`);
  take(new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'gi'), (m) => `${m[3]}-${pad(monthNo(m[1]))}-${pad(m[2])}`);
  take(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (m) => `${m[3]}-${pad(m[2])}-${pad(m[1])}`); // day-first assumption
  return { dates: found, rest };
}
function extractNumbers(line) {
  const { rest } = extractDates(line); // dates must not be read as amounts
  return (rest.match(/\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+\.\d{1,2}|\d{4,}/g) || []).map((x) => Number(x.replace(/,/g, '')).toFixed(2));
}
const valuesOnLine = (type, line) => (type === 'date' ? extractDates(line).dates : type === 'number' ? extractNumbers(line) : []);

// Label-anchored check: the value must sit on (or just after) a line carrying the field's label,
// so "42,500.00" can't be accepted as the due date, or the subtotal as the total.
// It also reports every distinct value printed next to that label ("values"), so conflicting documents
// (e.g. an original and a revised total) can be detected instead of silently picking one.
function labelCheck(field, expected, text, fieldLabels, fieldTypes) {
  const labels = fieldLabels && fieldLabels[field];
  if (!labels || expected === '' || expected == null) return { status: 'not_applicable' };
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const re = new RegExp(`(^|[^a-z])(${labels.map(escapeRe).join('|')})(?![a-z])`, 'i');
  const type = fieldTypes && fieldTypes[field];
  let sawLabel = false, matched = false;
  const values = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    sawLabel = true;
    const window = `${lines[i]} ${lines[i + 1] || ''}`;
    if (variants(expected).some((v) => containsToken(window, v))) matched = true;
    let here = valuesOnLine(type, lines[i]);
    if (!here.length) here = valuesOnLine(type, lines[i + 1] || ''); // value wrapped onto the next line
    here.forEach((v) => values.add(v));
  }
  const distinct = [...values];
  return { status: matched ? 'ok' : sawLabel ? 'mismatch' : 'no_label_found', labels, values: distinct, ambiguous: distinct.length > 1 };
}

async function verify(claims, adapter, { stateChanged, humanResolvedAmbiguity } = {}) {
  if (!claims || claims.length === 0) {
    if (stateChanged) {
      return { passed: false, checks: [], problems: ['You performed state-changing actions but listed no claims. Provide claims describing what should now be stored.'] };
    }
    return { passed: true, checks: [], problems: [], note: 'No state change claimed (read-only task); nothing to verify against the system of record.' };
  }
  const checks = [], problems = [];
  let ambiguous = false;
  for (const claim of claims) {
    let row;
    try { row = adapter.lookup(claim.entity, claim.key); } catch (e) { problems.push(`Could not look up ${claim.entity} ${JSON.stringify(claim.key)}: ${e.message}`); continue; }
    if (!row) { problems.push(`${claim.entity} ${JSON.stringify(claim.key)} was NOT found in the system.`); continue; }
    // Fields that normally come from a document (the adapter has printed labels for them) must name their source,
    // otherwise the claim would skip every document check, including the ambiguous-source check.
    // Status-only claims (e.g. mark as paid) need no document.
    const docFields = Object.keys(claim.fields || {}).filter((f) => adapter.fieldLabels && adapter.fieldLabels[f]);
    if (stateChanged && docFields.length && !claim.source_file) {
      problems.push(`Claim for ${claim.entity} ${JSON.stringify(claim.key)} sets ${docFields.join(', ')} but gives no source_file. Name the document these values came from, or use ask_human if there is none.`);
      continue;
    }
    let sourceText = null;
    if (claim.source_file) {
      try { sourceText = await extractText(safePath(claim.source_file)); } catch (e) { problems.push(`Could not read source file ${claim.source_file}: ${e.message}`); }
    }
    // Also check identifying values (e.g. invoice number) against the document, when the adapter knows their labels.
    if (sourceText && adapter.fieldLabels) {
      for (const [f, v] of Object.entries(claim.key || {})) {
        if (!adapter.fieldLabels[f]) continue;
        const lc = labelCheck(f, v, sourceText, adapter.fieldLabels, adapter.fieldTypes);
        checks.push({ entity: claim.entity, key: claim.key, field: f, expected: v, label_check: lc.status });
        if (lc.status === 'mismatch') problems.push(`Identifier "${f}" = ${JSON.stringify(v)} does not appear next to its label (${lc.labels.join(' / ')}) in ${claim.source_file}. Re-read the document.`);
      }
    }
    for (const [field, expected] of Object.entries(claim.fields || {})) {
      const actual = row[field];
      const dbOk = valuesEqual(expected, actual);
      const hasExpected = expected !== '' && expected != null;
      const srcOk = sourceText && field !== 'status' && hasExpected ? inSource(expected, sourceText) : null;
      const lc = sourceText && field !== 'status' ? labelCheck(field, expected, sourceText, adapter.fieldLabels, adapter.fieldTypes) : { status: 'not_applicable' };
      checks.push({ entity: claim.entity, key: claim.key, field, expected, stored_in_system: actual, matches_system: dbOk, found_in_source: srcOk, label_check: lc.status, ...(lc.ambiguous && adapter.fieldTypes && adapter.fieldTypes[field] ? { conflicting_values_in_source: lc.values } : {}) });
      if (lc.status === 'mismatch') problems.push(`Field "${field}" value ${JSON.stringify(expected)} does not appear next to its label (${lc.labels.join(' / ')}) in ${claim.source_file}; it may belong to a different field. Re-read the document.`);
      if (lc.ambiguous && adapter.fieldTypes && adapter.fieldTypes[field]) {
        ambiguous = true;
        if (!humanResolvedAmbiguity) problems.push(`AMBIGUOUS SOURCE: ${claim.source_file} shows several different values for "${field}" next to its label (${lc.values.join(' vs ')}). Do not guess: use ask_human to confirm which one applies, then finish again.`);
      }
      if (!dbOk) problems.push(`${claim.entity} ${JSON.stringify(claim.key)}: field "${field}" is stored as ${JSON.stringify(actual)} in the system but you claimed ${JSON.stringify(expected)}.`);
      if (srcOk === false) problems.push(`Field "${field}" value ${JSON.stringify(expected)} was not found in source file ${claim.source_file}; re-read the document.`);
    }
  }
  return { passed: problems.length === 0, checks, problems, ambiguous };
}

module.exports = { verify };
