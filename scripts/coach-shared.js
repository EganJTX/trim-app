// Shared helpers for the coach recommendation loop — reading/writing
// recommendations.json and building the profile section of the prompt.
// Kept separate from coach-analyze.js so the storage rules (sort by
// weekStart, not insertion order; keep a rolling window; upsert by week)
// are in one place and easy to reason about independent of the Claude call.

const fs = require('fs');

const MAX_RETAINED_WEEKS = 12; // how many assessed weeks recommendations.json keeps for browsing
const WEEKS_FED_INTO_PROMPT = 4; // how many of those get fed back into a new analysis

function readRecommendations(recommendationsPath) {
  if (!fs.existsSync(recommendationsPath)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(recommendationsPath, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

// Sorted ascending by weekStart — "latest" is always the last element,
// regardless of what order analyses were actually run in.
function sortByWeekStart(entries) {
  return [...entries].sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0));
}

// Insert or replace the entry for this weekStart, then trim to the retained window.
function upsertRecommendation(recommendationsPath, entry) {
  const existing = readRecommendations(recommendationsPath);
  const withoutThisWeek = existing.filter(e => e.weekStart !== entry.weekStart);
  const merged = sortByWeekStart([...withoutThisWeek, entry]);
  const trimmed = merged.slice(-MAX_RETAINED_WEEKS);
  fs.writeFileSync(recommendationsPath, JSON.stringify(trimmed, null, 2), 'utf8');
  return trimmed;
}

// The last N assessed weeks strictly before targetWeekStart — verdict + recommendation
// only (never fullReport, so the prompt doesn't grow unbounded as history accumulates).
function recentHistoryFor(recommendationsPath, targetWeekStart, n = WEEKS_FED_INTO_PROMPT) {
  const sorted = sortByWeekStart(readRecommendations(recommendationsPath));
  return sorted
    .filter(e => e.weekStart < targetWeekStart)
    .slice(-n)
    .map(e => ({ weekStart: e.weekStart, weekEnd: e.weekEnd, verdict: e.verdict, recommendation: e.recommendation }));
}

// Age is derived from DOB at prompt time rather than stored directly, so it's
// always correct without needing a yearly manual update.
function ageFromDob(dob) {
  const birth = new Date(dob);
  if (isNaN(birth)) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const beforeBirthdayThisYear = (today.getMonth() < birth.getMonth()) ||
    (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate());
  if (beforeBirthdayThisYear) age--;
  return age;
}

// Renders the coach profile (config.json's coachProfile block) as prompt text,
// omitting any field that isn't set — an absent field should never read as a
// value to reason from.
function renderCoachProfile(coachProfile) {
  if (!coachProfile) return '';
  const p = coachProfile;
  const lines = [];
  if (p.dob) {
    const age = ageFromDob(p.dob);
    if (age !== null) lines.push(`Age: ${age}`);
  }
  if (p.height) lines.push(`Height: ${p.height}`);
  if (p.programStartDate) lines.push(`Program start date: ${p.programStartDate}`);
  if (p.startingWeight) lines.push(`Starting weight: ${p.startingWeight}`);
  if (p.goalWeight) lines.push(`Goal weight: ${p.goalWeight}`);
  if (p.programHistory && p.programHistory.trim()) lines.push(`\nProgram History / Context:\n${p.programHistory.trim()}`);
  if (p.targetsAndThresholds && p.targetsAndThresholds.trim()) lines.push(`\nTargets & Thresholds:\n${p.targetsAndThresholds.trim()}`);
  return lines.join('\n');
}

module.exports = {
  MAX_RETAINED_WEEKS,
  WEEKS_FED_INTO_PROMPT,
  readRecommendations,
  sortByWeekStart,
  upsertRecommendation,
  recentHistoryFor,
  renderCoachProfile
};
