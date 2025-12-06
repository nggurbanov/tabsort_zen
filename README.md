# Advanced Tab Sort (Zen + Sine)

AI-assisted tab grouping for Zen Browser that plays nicely with Advanced Tab Groups. It lets you pick between Gemini, OpenAI, Ollama, or Firefox Local AI, then sorts your open tabs into groups (or previews the plan in dry-run mode).

## What’s included
- `JS/Advanced-Tab-Sort.uc.js` — core logic and provider adapters.
- `preferences.json` — settings schema for Sine (surface these via the settings icon).
- `userChrome.css` / `theme.json` — styling hooks + mod metadata.

## Setup
1) Install Sine (Zen mod manager) and Advanced Tab Groups.
2) Drop this folder into your Sine mods directory and enable it.
3) Configure provider + credentials in Sine settings (or edit `preferences.json` before enabling).

## Quick settings
- Provider: `openai` | `gemini` | `ollama` | `firefox-local`
- Per-provider: API key/host/model/timeout.
- Safety: `includePageText` (off by default), `maxCharsPerTab`, `maxGroups`, `mergeExisting`, `renameGroups`, `dryRun`.
- Triggers: manual `sortNow()`, optional auto-sort on tab bursts or idle, debounced.

## Manual command
Open the browser console and run:
```
window.AdvancedTabSort?.sortNow({ dryRun: true })
```
Use `dryRun: false` to apply moves.

## Notes
- Pinned tabs are never moved.
- If the chosen provider fails or times out, it falls back to a domain-based heuristic.
- Secrets stay local; nothing is logged unless `logLevel` is set to `debug`.

## Manual test matrix
- Providers: OpenAI, Gemini, Ollama, Firefox local (happy path, timeout, invalid key).
- Volume: 50–100 tabs to confirm responsiveness and grouping stability.
- Behavior: pinned tabs untouched, duplicate titles/domains grouped sanely, dry-run preview works.
- ATG: animations on/off, existing groups present, no duplicate/empty groups after sort.
- Edge: about:blank/internal pages should be ignored or dropped into `Other`.

