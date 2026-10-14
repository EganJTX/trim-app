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

You have "Program Arc" (an unwindowed, all-time record: all-time low weight, distance from
that low today, days since, and a status of reached_and_regained / never_reached /
reached_and_sustained / perpetual_plateau) for diagnostic reasoning, and the user's own
"Program History" free-text for their narrated context. Treat the free-text as their story,
Program Arc as the objective record; don't restate one as if it were the other.

Use Program Arc to calibrate confidence, not to narrate history. Only surface it explicitly
when it changes the actual recommendation this week, never as a standalone callback ("you've
been here before"). When comparing to a prior period, compare consistency, not parameters:
logging reliability and adherence patterns, not raw thresholds (steps/calorie targets
legitimately change as the program matures; a threshold shift is not a regression).

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

// ── Coach style: five dials, each 1 to 5, set on the Profile tab. When the person has set any of them, the
// "Your voice" paragraph and the two bullets that fix the size and framing of feedback are replaced with text
// built from their settings. When nothing is set, COACH_PERSONA is used exactly as written. Method and safety
// (weigh weeks over single days, never extreme restriction or overhauls, never shaming) stay in every version.
// Keep this table in step with COACH_DIALS in index.html: the fragments are the same sentences the UI shows.
const COACH_STYLE = [
  { key: "warmth", def: 4, frags: [
    "sticks to the numbers and what they show, without cheerleading",
    "keeps to the facts and adds a light note of encouragement",
    "balances what is going well with what needs attention, in an even tone",
    "leads with what is going well and keeps a warm, positive tone",
    "celebrates your progress and keeps an upbeat tone, even through a rough week"
  ] },
  { key: "delivery", def: 4, frags: [
    "says plainly what the data shows, including what is not working, without softening it",
    "says what it sees clearly and keeps the wording short and to the point",
    "names what the data shows, good and hard, in an even, matter-of-fact way",
    "names what the data shows, including the harder parts, and frames it kindly",
    "introduces harder points with care and frames each one around what you can do next"
  ] },
  { key: "directive", def: 2, frags: [
    "reflects the week back and asks what you think before suggesting anything",
    "offers a recommendation with its reasoning and leaves room for your take",
    "gives a clear recommendation and explains why, while welcoming your input",
    "gives a clear recommendation for the week and expects you to run with it",
    "gives you a specific plan for the week and what to do first"
  ] },
  { key: "pace", def: 2, frags: [
    "suggests a single, very small change and lets it settle before the next",
    "suggests one or two small, sustainable changes at a time, starting with what is working",
    "suggests a couple of meaningful changes that fit your current routine",
    "suggests a few stretching changes and moves at a quicker pace, while staying realistic about your week",
    "pushes for faster results with a real stretch each week, always keeping it sustainable and safe"
  ] },
  { key: "accountability", def: 2, frags: [
    "mentions last week's focus in passing and moves on",
    "checks last week's focus against what happened and encourages you from there",
    "reviews last week's focus against what happened and talks plainly about the gap",
    "holds you to last week's focus and asks what will change if it slipped",
    "holds you firmly to last week's focus and corrects course directly, always on your side"
  ] }
];

function validDial(v) { return Number.isInteger(v) && v >= 1 && v <= 5; }

function personaFor(style) {
  if (!style || typeof style !== 'object') return COACH_PERSONA;
  if (!COACH_STYLE.some(d => validDial(style[d.key]))) return COACH_PERSONA;
  const pick = d => d.frags[(validDial(style[d.key]) ? style[d.key] : d.def) - 1];
  const [warmth, delivery, directive, pace, accountability] = COACH_STYLE.map(pick);
  const voice = 'Your voice, as the person has set it: the coach ' + warmth + '. It ' + delivery + '. It ' + directive +
    '. It ' + pace + '. It ' + accountability + ". Whatever the settings, you are on the person's side, and the aim is to " +
    'keep them oriented toward the goal and honest with themselves, never to shame them or punish a rough week.';
  const swaps = [
    [/Your voice: supportive[\s\S]*?never to punish a rough week\./, voice],
    [/- Recommend small, specific, sustainable adjustments[\s\S]*?suggesting what to change\./,
      '- Size the adjustments to the pace described in your voice guidance, and keep them specific and sustainable. ' +
      'Never recommend extreme restriction, overhauls, or "never do X again." Reinforce what is already working ' +
      'before suggesting what to change.'],
    [/Frame this as encouragement and course-correction, never\s+as a scorecard or a callout\./,
      "Frame it the way your voice guidance describes, always on the person's side and never as shaming."]
  ];
  let out = COACH_PERSONA;
  for (const [rx, rep] of swaps) {
    if (!rx.test(out)) return COACH_PERSONA; // if the persona text ever changes shape, fall back to it unmodified
    out = out.replace(rx, () => rep);
  }
  return out;
}

function buildCoachPrompt({ profileText, digestText, weeklySummary, recentHistory, weekStart, weekEnd, style }) {
  const parts = [personaFor(style), '', `Assessing the week of ${weekStart} through ${weekEnd}.`];

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
    const prompt = buildCoachPrompt({ profileText, digestText, weeklySummary, recentHistory, weekStart, weekEnd,
      style: config.coachProfile && config.coachProfile.style });

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
        // Some failures (e.g. an expired CLI login) come back as exit code 1 with
        // an empty stderr — the actual reason is JSON on stdout instead. Surface
        // that instead of a bare "no stderr output".
        let cliMessage = null;
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && parsed.is_error && typeof parsed.result === 'string') cliMessage = parsed.result;
        } catch (e) { /* stdout wasn't JSON — fall through to stderr/generic message */ }

        if (cliMessage && /oauth|authenticat/i.test(cliMessage)) {
          return resolve({
            ok: false,
            status: 500,
            error: `Claude Code CLI is not authenticated (${cliMessage}). Run "claude" in a terminal on this machine and complete the login prompt, then retry.`
          });
        }

        return resolve({
          ok: false,
          status: 500,
          error: `Claude Code exited with code ${code}: ${cliMessage || stderr.slice(0, 500) || 'no stderr output'}`
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

module.exports = { runCoachAnalysis, buildCoachPrompt, COACH_PERSONA, personaFor };
