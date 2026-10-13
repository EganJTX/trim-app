const express = require('express');
const path = require('path');
const app = express();

// The macro server assigns this via env var when it spawns this process.
// Falls back to 3002 for running trim-app standalone (node server.js) during development.
const PORT = process.env.PORT || 3002;
const SLUG = 'trim-app';

app.use(express.json({ limit: '10mb' })); // digest text + weekly summary can add up over a long history

// ── Config persistence — same pattern as job-tracker's config.json ──
const fs = require('fs');
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ── Bootstrap real (gitignored) config from the committed example template ──
// Only runs when config.json doesn't exist yet (a fresh clone) — never touches
// or overwrites a real config.json that's already there. data.json and
// recommendations.json need no equivalent: both already start empty and are
// created on first real write (see /api/refresh and coach-shared.js).
if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(path.join(__dirname, 'config.example.json'))) {
  fs.copyFileSync(path.join(__dirname, 'config.example.json'), CONFIG_PATH);
  console.log('config.json not found — created from config.example.json');
}

app.get(`/${SLUG}/api/config`, (req, res) => {
  if (!fs.existsSync(CONFIG_PATH)) return res.json(null);
  try {
    res.json(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (e) {
    res.status(500).json({ error: 'Failed to read config' });
  }
});

app.post(`/${SLUG}/api/config`, (req, res) => {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to write config' });
  }
});

// ── Serve static files from this folder, matching job-tracker's pattern ──
app.use(`/${SLUG}`, express.static(__dirname));

// ── Sheet CSV fetch (server-side, no browser CORS issue since this runs on the server) ──
function extractSheetId(url) {
  const m = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}
async function fetchSheetCsv(url, gidOverride){
  const sheetId = extractSheetId(url);
  if(!sheetId) return { text:null, error:'Could not parse a sheet ID from that URL' };
  const urlGidMatch = url.match(/gid=([0-9]+)/);
  const gid = gidOverride || (urlGidMatch ? urlGidMatch[1] : '0');
  const csvExportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  try{
    const upstream = await fetch(csvExportUrl);
    if(!upstream.ok) return { text:null, error:`Sheet fetch failed (${upstream.status}) — confirm it's shared as "Anyone with the link can view."` };
    return { text: await upstream.text(), error:null };
  }catch(err){
    return { text:null, error:`Could not reach Google Sheets: ${err.message}` };
  }
}

// ── CSV / date / value helpers (mirrors the logic formerly duplicated client-side) ──
function parseCSVLine(line){
  const out=[]; let cur=''; let inQ=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){ inQ=!inQ; continue; }
    if(ch===',' && !inQ){ out.push(cur); cur=''; continue; }
    cur+=ch;
  }
  out.push(cur);
  return out.map(v=>v.trim());
}
function normalizeDateKey(raw){
  if(!raw) return null;
  const d = new Date(raw);
  if(isNaN(d)) return null;
  return d.toISOString().slice(0,10);
}
function coerceValue(raw, type, col){
  if(type==='Number' || type==='Weight'){
    // blank/unparseable stays null — never silently becomes 0, so a day that
    // wasn't logged for this field can be told apart from a day logged as a real zero
    const n = parseFloat(raw);
    return isNaN(n) ? null : n;
  }
  if(type==='Y/N Daily Goal'){
    const trimmed = (raw||'').trim();
    // explicit tagging (from the Detect values picker) wins; anything not tagged
    // Yes — including new values that show up later — counts as No.
    if(col && Array.isArray(col.yesValues) && col.yesValues.length){
      return col.yesValues.some(v => v.trim().toLowerCase() === trimmed.toLowerCase());
    }
    // no explicit tagging saved yet — same "starts with y" fallback as before
    return /^y/i.test(trimmed);
  }
  return raw || '';
}
function letterToIndex(letter){
  let n = 0;
  for(let i=0;i<letter.length;i++){ n = n*26 + (letter.charCodeAt(i) - 64); }
  return n - 1; // 0-based
}
function parseSourceRows(src, csvText){
  const lines = csvText.split(/\r?\n/);
  // Explicit join column wins; falls back to "first Date column" for configs saved
  // before join columns were an explicit, user-confirmed choice.
  const dateCol = src.columns.find(c=>c && c.type==='Date' && c.isJoinKey)
    || src.columns.find(c=>c && c.type==='Date');
  const dateCsvIdx = dateCol ? letterToIndex(dateCol.letter) : -1;
  const records = {};
  let parsedCount = 0, skippedNoDate = 0;
  for(let i = src.startRow-1; i < lines.length; i++){
    const cells = parseCSVLine(lines[i] || '');
    if(cells.every(c=>!c)) continue;
    const dateKey = dateCsvIdx>=0 ? normalizeDateKey(cells[dateCsvIdx]) : null;
    if(!dateKey){ skippedNoDate++; continue; }
    const fields = {};
    src.columns.forEach(col=>{
      if(!col || col.type==='Date') return;
      const csvIdx = letterToIndex(col.letter); // always the true CSV position, never the array's own index
      const val = coerceValue(cells[csvIdx], col.type, col);
      fields[col.field] = val;                    // raw label — every KPI and goal reads by this key directly
      if(col.type==='Weight') fields.__weight = val; // the ONE special anchor — a real Type now, not a forgettable flag
    });
    records[dateKey] = fields;
    parsedCount++;
  }
  return { records, parsedCount, skippedNoDate, totalLines: lines.length };
}

function normalizeRecordToInternalShape(merged){
  const out = Object.assign({}, merged); // every raw label key passes through untouched
  if(merged.__weight !== undefined) out.weight = merged.__weight;
  delete out.__weight;
  return out;
}
function joinSources(parsedBySrc, sources){
  const anchorIdx = sources.findIndex(s=>s.isAnchor);
  if(anchorIdx<0 || !parsedBySrc[anchorIdx]) return [];
  const anchorRecords = parsedBySrc[anchorIdx].records;
  const dateKeys = Object.keys(anchorRecords).sort();
  return dateKeys.map(dateKey=>{
    let merged = { date: dateKey };
    sources.forEach((src, si)=>{
      const rec = parsedBySrc[si] && parsedBySrc[si].records[dateKey];
      if(rec) merged = Object.assign(merged, rec);
    });
    return normalizeRecordToInternalShape(merged);
  });
}

// ── programArc — an unwindowed, full-history diagnostic computed alongside the
//    28-day export window (never replaces it). Answers "has this person ever
//    reached goal, and where do they stand relative to their all-time low" —
//    context the rolling window structurally can't see. Recomputed on every
//    /api/refresh from the full realized data set, not the export's 4-week slice.
const PROGRAM_ARC_TOLERANCE_LBS = 5;      // "meaningfully above low" / "still near goal" threshold
const PROGRAM_ARC_PLATEAU_LBS = 3;        // all-time low moving less than this = plateaued, not progressing
const PROGRAM_ARC_PLATEAU_MIN_DAYS = 84;  // need at least 12 weeks of history before calling it a plateau

function computeProgramArc(records, goalWeight) {
  const withWeight = (records || [])
    .filter(r => typeof r.weight === 'number')
    .slice()
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  if (withWeight.length === 0 || typeof goalWeight !== 'number') return null;

  let allTimeLow = withWeight[0];
  withWeight.forEach(r => { if (r.weight < allTimeLow.weight) allTimeLow = r; });

  const current = withWeight[withWeight.length - 1];
  const distanceFromLowToday = current.weight - allTimeLow.weight;
  const daysSinceLow = Math.round((new Date(current.date) - new Date(allTimeLow.date)) / 86400000);

  const reachedGoal = allTimeLow.weight <= goalWeight;

  let status;
  if (reachedGoal) {
    const nearGoalNow = Math.abs(current.weight - goalWeight) <= PROGRAM_ARC_TOLERANCE_LBS;
    const meaningfullyAboveLow = distanceFromLowToday > PROGRAM_ARC_TOLERANCE_LBS;
    // Near goal now always reads as sustained, even if that's a long way from the
    // all-time low (e.g. the low itself was an overshoot past goal).
    status = (nearGoalNow || !meaningfullyAboveLow) ? 'reached_and_sustained' : 'reached_and_regained';
  } else {
    const spanDays = Math.round((new Date(current.date) - new Date(withWeight[0].date)) / 86400000);
    const midpoint = withWeight[Math.floor(withWeight.length / 2)];
    const firstHalf = withWeight.filter(r => r.date <= midpoint.date);
    const secondHalf = withWeight.filter(r => r.date > midpoint.date);
    const lowOf = arr => arr.reduce((min, r) => r.weight < min ? r.weight : min, arr[0].weight);
    const lowMoved = (secondHalf.length && firstHalf.length) ? Math.abs(lowOf(firstHalf) - lowOf(secondHalf)) : Infinity;
    status = (spanDays >= PROGRAM_ARC_PLATEAU_MIN_DAYS && lowMoved <= PROGRAM_ARC_PLATEAU_LBS)
      ? 'perpetual_plateau'
      : 'never_reached';
  }

  return {
    status,
    allTimeLow: { weight: allTimeLow.weight, date: allTimeLow.date },
    distanceFromLowToday: Math.round(distanceFromLowToday * 10) / 10,
    daysSinceLow
  };
}

// ── data.json — the local cache the app actually reads from ──
const DATA_PATH = path.join(__dirname, 'data.json');

app.get(`/${SLUG}/api/data`, (req, res) => {
  if (!fs.existsSync(DATA_PATH)) return res.json({ data: [], diagnostics: [], generatedAt: null });
  try {
    res.json(JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')));
  } catch (e) {
    res.status(500).json({ error: 'Failed to read data.json' });
  }
});

// ── /refresh — does the real work: fetch every source fresh, parse, join, write data.json ──
app.post(`/${SLUG}/api/refresh`, async (req, res) => {
  if (!fs.existsSync(CONFIG_PATH)) return res.status(400).json({ error: 'No config.json yet — add a source in Settings first.' });

  let config;
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { return res.status(500).json({ error: 'Failed to read config.json' }); }

  const sources = config.sources || [];
  const parsedBySrc = [];
  const diagnostics = [];

  for (const src of sources) {
    if (!src.url || !src.url.trim() || !src.columns || src.columns.filter(c=>c).length===0) {
      diagnostics.push({ name: src.name||'(unnamed)', status: 'skipped — no URL or no mapped columns' });
      parsedBySrc.push(null);
      continue;
    }
    const { text, error } = await fetchSheetCsv(src.url);
    if (!text) {
      diagnostics.push({ name: src.name||'(unnamed)', status: `fetch failed — ${error}` });
      parsedBySrc.push(null);
      continue;
    }
    const parsed = parseSourceRows(src, text);
    parsedBySrc.push(parsed);
    diagnostics.push({
      name: src.name||'(unnamed)', status: 'ok', isAnchor: !!src.isAnchor,
      rowsParsed: parsed.parsedCount, skippedNoDate: parsed.skippedNoDate, totalLinesInSheet: parsed.totalLines
    });
  }

  const joined = joinSources(parsedBySrc, sources);
  const todayKey = new Date().toISOString().slice(0,10);
  const realized = joined.filter(r => r.date <= todayKey && r.weight);

  const hasAnchor = sources.some(s => s.isAnchor);
  const hasWeightType = sources.some(s => (s.columns||[]).some(c => c && c.type==='Weight'));

  let warning = null;
  if (!hasAnchor) {
    warning = 'No source is set as the join anchor — go to Settings and click "Set as join anchor" on your primary sheet (usually the one with Weight).';
  } else if (joined.length === 0) {
    const anchorSrc = sources.find(s=>s.isAnchor);
    warning = `The join anchor ("${anchorSrc.name||'(unnamed)'}") parsed 0 dated rows — check its Data starts at row / Header row settings.`;
  } else if (!hasWeightType) {
    warning = `${joined.length} dates joined from the anchor, but 0 kept — no column anywhere is Typed as Weight. Set one in Settings.`;
  } else if (realized.length === 0) {
    warning = `${joined.length} dates joined and a Weight column exists, but every matched row came back empty or in the future — check that dates actually line up between your sheets.`;
  }

  diagnostics.push({
    name: '— join summary —', status: 'info',
    rowsParsed: `${joined.length} dates joined -> ${realized.length} kept (have weight + not future)`,
    skippedNoDate: warning ? `⚠ ${warning}` : 'looks fine',
    totalLinesInSheet: ''
  });

  const goalWeight = config.coachProfile && config.coachProfile.goalWeight;
  const programArc = computeProgramArc(realized, goalWeight);

  const payload = { data: realized, diagnostics, warning, generatedAt: new Date().toISOString(), programArc };
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(payload, null, 2), 'utf8');
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: 'Failed to write data.json' });
  }
});

// ── Sheet CSV proxy — still used by Settings' column-detection preview ──
// Client calls: GET /trim-app/api/sheet-csv?url=<sheet share URL>
const CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map();

app.get(`/${SLUG}/api/sheet-csv`, async (req, res) => {
  const { url, gid } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  const sheetId = extractSheetId(url);
  if (!sheetId) return res.status(400).json({ error: 'Could not parse a sheet ID from that URL' });

  const urlGidMatch = url.match(/gid=([0-9]+)/);
  const resolvedGid = gid || (urlGidMatch ? urlGidMatch[1] : '0');
  const cacheKey = `${sheetId}:${resolvedGid}`;

  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    res.set('Content-Type', 'text/csv');
    res.set('X-Trim-Cache', 'hit');
    return res.send(cached.text);
  }

  const { text, error } = await fetchSheetCsv(url, gid);
  if (!text) return res.status(502).json({ error });

  cache.set(cacheKey, { text, expires: Date.now() + CACHE_TTL_MS });
  res.set('Content-Type', 'text/csv');
  res.set('X-Trim-Cache', 'miss');
  res.send(text);
});

// ── Column value detection — scans a full column (not just one sampled row) and
//    returns distinct values with counts, so Y/N Daily Goal mapping can be based
//    on what's actually in the sheet instead of guessing at a "starts with y" rule ──
app.post(`/${SLUG}/api/column-values`, async (req, res) => {
  const { url, startRow, letter } = req.body || {};
  if (!url || !letter) return res.status(400).json({ error: 'Missing url or column letter' });

  const { text, error } = await fetchSheetCsv(url);
  if (!text) return res.status(502).json({ error });

  const lines = text.split(/\r?\n/);
  const colIdx = letterToIndex(letter);
  const counts = new Map();
  for (let i = (startRow || 1) - 1; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i] || '');
    if (cells.every(c => !c)) continue;
    const raw = (cells[colIdx] || '').trim();
    if (!raw) continue;
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }

  const values = Array.from(counts, ([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
  res.json({ values });
});

// ── Coach recommendations — the agentic weekly loop. Digest text is built
//    client-side (it already needs the same week-aware logic the dashboard
//    uses) and posted in; this route only assembles the profile/history and
//    hands off to coach-analyze.js, which does the actual Claude Code call. ──
const { runCoachAnalysis } = require('./scripts/coach-analyze');
const { readRecommendations, countRecordsInWeek } = require('./scripts/coach-shared');
const RECOMMENDATIONS_PATH = path.join(__dirname, 'recommendations.json');

app.get(`/${SLUG}/api/recommendations`, (req, res) => {
  res.json(readRecommendations(RECOMMENDATIONS_PATH));
});

app.post(`/${SLUG}/api/coach-analyze`, async (req, res) => {
  const { weekStart, weekEnd, digestText, weeklySummary } = req.body || {};

  // Gate: never spend a Claude call (or overwrite a prior analysis) on a week
  // with no real data. data.json is the source of truth, not the client's digest.
  if (weekStart && weekEnd && countRecordsInWeek(DATA_PATH, weekStart, weekEnd) === 0) {
    return res.status(409).json({
      ok: false,
      code: 'no_data',
      error: `No data has been loaded for ${weekStart} – ${weekEnd} yet. Refresh your data first, then run the analysis again.`
    });
  }

  const result = await runCoachAnalysis({
    configPath: CONFIG_PATH,
    recommendationsPath: RECOMMENDATIONS_PATH,
    weekStart, weekEnd, digestText, weeklySummary
  });
  if (!result.ok) return res.status(result.status || 500).json(result);
  res.json(result);
});

// ── Start (the macro server spawns this as its own `node server.js` process
//    via child_process.spawn, passing PORT through env — so this listen call
//    always runs, whether launched by the macro server or standalone) ──
app.listen(PORT, () => {
  console.log(`[trim-app] running at http://localhost:${PORT}/${SLUG}`);
});
