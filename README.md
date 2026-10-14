# Trim

A local, single-user dashboard for tracking a weight-loss goal against whatever else you log alongside it (steps, calories, protein, stress, streaks, whatever your sheet has). Cut the noise, trust the trend.

## What this is (and isn't)

Trim is **not** an AI app by itself — it has no built-in LLM calls for anything the dashboard itself does. It reads your data straight from one or more Google Sheets (public CSV export links, no API keys), joins them by date, and turns the result into a weekly-anchored dashboard: KPIs, a trend chart, and a Y/N daily-goal compliance card, all following the same week selector.

The one optional AI feature is the **Coach**: click "Analyze Week" and it shells out locally to the [Claude Code CLI](https://claude.com/product/claude-code) in headless mode to write a short weekly assessment (verdict + recommendation), stored per-week so it can check your last few weeks of history before writing a new one. On the **Profile** tab you tell the coach your story and targets, and set five style dials (warmth, delivery, directiveness, pace, and accountability) that control how it sounds and how hard it pushes. This requires the `claude` CLI installed and authenticated on your own machine. The app itself never calls a hosted API, but the CLI does: it sends that week's logged data, a summary of your all-time progress, your profile, any weekly notes you write, and recent recommendations to Anthropic under your own account. If you don't have the CLI installed, or don't want that data leaving your machine, everything else in Trim still works without it.

## Setup

```bash
npm install
npm start
```

Then open `http://localhost:3002/trim-app`.

On first run, `config.json` doesn't exist yet — the server creates it automatically from the committed `config.example.json` template, which is just an empty shell (no sources, no profile). Open **Settings → Data** and add your first Google Sheet: a name, a public share link, and which columns map to what (Date, Number, Weight, Y/N Daily Goal, or Text). One column across all your sources needs to be Typed as Weight — it drives the trend chart and KPIs.

Your sheet must be shared as "Anyone with the link can view" for the CSV export fetch to work — nothing else about the sheet needs to change.

If you plan to use the Coach, fill in the **Profile** tab too: where you started, what you're working toward, and which tracked numbers matter most. The coach reads it as written, and the style dials there are optional.

## Data and privacy

`config.json`, `data.json`, and `recommendations.json` are gitignored — once you fill them in with your real sheets and data, none of it is tracked by git or leaves your machine except for the two things you explicitly point it at: the Google Sheets CSV export fetch (server-side, no browser CORS issue) and, only when you click "Analyze Week," a headless Claude Code CLI call (which sends that data to Anthropic under your own account). Everything else is a small Express server (`server.js`) doing local file reads/writes; there's no database and no other external API calls anywhere in the app.

`data.json` and `recommendations.json` aren't bootstrapped from a template — they start genuinely empty and are created the first time you refresh data or run an analysis, same as `config.json` starts as an empty shell rather than a fake pre-filled profile.

## How the week works

Every KPI, comparison, and "All Time" total is anchored to a shared week selector — complete weeks are the atomic unit, not a rolling day-window. The current in-progress week shows a live numerator (days elapsed so far) but no comparison; comparisons only appear once a week is complete. Week start (Sunday/Monday) is configurable in **Settings → Display**.

## License

[CC BY-NC 4.0](LICENSE) — Attribution-NonCommercial.
