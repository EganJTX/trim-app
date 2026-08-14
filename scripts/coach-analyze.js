// Core logic for the agentic weekly coach. Shells out to the Claude Code CLI
// in headless/print mode, the same pattern job-tracker's evaluate-ghosted.js
// uses — no API key, no built-in LLM call in server.js itself. Claude Code is
// given no file/tool access here either; it only sees the assembled prompt
// text and returns JSON. This module is solely responsible for reading the
// profile/history and writing recommendations.json, so a malformed or
// unexpected model response can never touch the file beyond what's explicitly
// done with it below.

const fs = require('fs');
const { spawn } = require('child_process');
const { upsertRecommendation, recentHistoryFor, renderCoachProfile } = require('./coach-shared');

const CLAUDE_BIN = process.env.CLAUDE_CLI_PATH || 'claude';
const COACH_TIMEOUT_MS = Number(process.env.COACH_TIMEOUT_MS) || 240000;

const COACH_PERSONA = `
You are a personal coach reviewing someone's weekly self-tracked data (weight, and whatever
other habits they track — steps, nutrition, workouts, etc.) alongside their own free-text
notes and a short summary they wrote about how the week felt.

Your voice: supportive, consultative — a sounding board and a partner working toward their
goal with them, not a critic grading them. You are their biggest fan, not their biggest
critic. The aim is to keep them motivated, oriented toward the goal, and honest with
themselves — never to punish a rough week.

How to reason:
- Weigh the actual data (weekly averages, compliance counts, notable notes) over any single
  day in isolation. A one-day spike or dip is usually noise, not signal — say so explicitly
  when that is what the data supports.
- If the person's own written summary is more negative than the data supports, say so and
  unpack why. If it's more positive than the data supports, say that too. Pressure-test their
  self-assessment against the facts either direction — that is part of the job.
- If a prior recommendation appears in the history below, explicitly check it against what
  actually happened this week — moved toward it, stayed flat, or moved away — and let that
  inform this week's recommendation. Frame this as encouragement and course-correction, never
  as a scorecard or a callout.
- Recommend small, specific, sustainable adjustments — one or two at most. No overhauls, no
  extreme restriction, no "never do X again." Reinforce what is already working before
  suggesting what to change.
- A structural observation (a metric worth tracking that isn't tracked yet, a target that
  looks stale against recent data) is fine to mention, but it is never the primary
  deliverable: the verdict and recommendation are.

Writing style: never use an em dash. Restructure the sentence into two sentences, a comma,
a colon, or parentheses instead.

Output format — respond with ONLY a JSON object, no prose outside the JSON, no markdown code
fences, in exactly this shape:
{
  "verdict": "<one or two sentences — the headline determination for the assessed week>",
  "recommendation": "<a short paragraph or a few short sentences — what to focus on for the
    coming week, specific and actionable, forward-looking>",
  "fullReport": "<the complete narrative reasoning behind the verdict and recommendation, as
    long as it needs to be — markdown formatting is fine here>"
}
`.trim();

function buildCoachPrompt({ profileText, digestText, weeklySummary, recentHistory, weekStart, weekEnd }) {
  const parts = [COACH_PERSONA, '', `Assessing the week of ${weekStart} through ${weekEnd}.`];

  if (profileText) {
    parts.push('', 'PERSON PROFILE & TARGETS', profileText);
  }

  if (recentHistory && recentHistory.length) {
    parts.push('', 'RECENT COACHING HISTORY (most recent last — check compliance against the most recent entry)');
    recentHistory.forEach(h => {
      parts.push(`\nWeek of ${h.weekStart} – ${h.weekEnd}:`);
      parts.push(`  Verdict: ${h.verdict}`);
      parts.push(`  Recommendation given: ${h.recommendation}`);
    });
  } else {
    parts.push('', 'RECENT COACHING HISTORY: none yet — this is the first assessment.');
  }

  parts.push('', "THIS WEEK'S DATA", digestText);

  if (weeklySummary && weeklySummary.trim()) {
    parts.push('', "PERSON'S OWN SUMMARY OF HOW THE WEEK WENT", weeklySummary.trim());
  }

  return parts.join('\n');
}

// Resolves to { ok: true, entry } or { ok: false, status, error, raw? } — never
// rejects, so the Express route always gets a plain result to report.
function runCoachAnalysis({ configPath, recommendationsPath, weekStart, weekEnd, digestText, weeklySummary, now = new Date() }) {
  return new Promise((resolve) => {
    if (!weekStart || !weekEnd || !digestText) {
      return resolve({ ok: false, status: 400, error: 'Missing weekStart/weekEnd/digestText' });
    }

    let config = {};
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { /* no config yet — profile stays empty */ }

    const profileText = renderCoachProfile(config.coachProfile);
    const recentHistory = recentHistoryFor(recommendationsPath, weekStart);
    const prompt = buildCoachPrompt({ profileText, digestText, weeklySummary, recentHistory, weekStart, weekEnd });

    // Same Windows shell:true / `--tools ""` handling as job-tracker's
    // evaluate-ghosted.js — see that file's comment for the full rationale.
    const child = spawn(CLAUDE_BIN, ['-p', '--output-format', 'json', '--tools', '""'], {
      cwd: __dirname,
      shell: true
    });

    let stdout = '', stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, status: 504, error: `Coach analysis timed out after ${COACH_TIMEOUT_MS / 1000}s` });
    }, COACH_TIMEOUT_MS);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, status: 500, error: `Failed to launch Claude Code: ${err.message}` });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        return resolve({
          ok: false,
          status: 500,
          error: `Claude Code exited with code ${code}: ${stderr.slice(0, 500) || 'no stderr output'}`
        });
      }

      let envelope;
      try {
        envelope = JSON.parse(stdout);
      } catch (e) {
        return resolve({ ok: false, status: 502, error: 'Could not parse Claude Code output as JSON', raw: stdout.slice(0, 1000) });
      }

      const resultText = envelope.result || '';
      let parsed;
      try {
        const match = resultText.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match ? match[0] : resultText);
      } catch (e) {
        return resolve({ ok: false, status: 502, error: 'Could not parse coach response JSON', raw: resultText.slice(0, 1000) });
      }

      if (!parsed || typeof parsed.verdict !== 'string' || typeof parsed.recommendation !== 'string') {
        return resolve({ ok: false, status: 502, error: 'Coach response was missing verdict/recommendation', raw: resultText.slice(0, 1000) });
      }

      const entry = {
        weekStart,
        weekEnd,
        verdict: parsed.verdict.trim(),
        recommendation: parsed.recommendation.trim(),
        fullReport: String(parsed.fullReport || '').trim(),
        generatedAt: now.toISOString()
      };

      try {
        upsertRecommendation(recommendationsPath, entry);
      } catch (e) {
        return resolve({ ok: false, status: 500, error: `Analysis succeeded but failed to write recommendations.json: ${e.message}` });
      }

      resolve({ ok: true, entry });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

if (require.main === module) {
  const [configPath, recommendationsPath, weekStart, weekEnd] = process.argv.slice(2);
  if (!configPath || !recommendationsPath || !weekStart || !weekEnd) {
    console.error('Usage: node scripts/coach-analyze.js <config.json> <recommendations.json> <weekStart> <weekEnd>');
    process.exit(1);
  }
  runCoachAnalysis({
    configPath, recommendationsPath, weekStart, weekEnd,
    digestText: 'Weight avg 200.0, Steps avg 10000, Protein avg 100g (test digest — CLI standalone run)',
    weeklySummary: ''
  }).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  });
}

module.exports = { runCoachAnalysis, buildCoachPrompt, COACH_PERSONA };
