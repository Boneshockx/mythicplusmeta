# MythicPlusMeta

A local guild tool for exploring the composition of Raider.IO's published top Mythic+ runs across regions. The first version uses Vue 3 + Vite, a small Node/Express API and MySQL. The API key stays on the server and is read from `.env`.

## Start locally

1. Create the database configured in `.env`, then run `npm run db:setup` to create the tables (or import `database/schema.sql` in HeidiSQL/phpMyAdmin).
2. Copy `.env.example` to `.env` and enter your local MySQL settings. Add a newly rotated Raider.IO app key as `RIO_API_KEY`.
3. Run `npm install` once. Start Laragon's Apache and MySQL, then run `npm run dev` in this project to start the dashboard and local API.
4. Open `http://mythicplusmeta.test` to use the dashboard through Laragon. Run `npm run sync` to import the Raider.IO current-run sample and the latest weekly period from Blizzard for US, EU, KR and TW, plus CN from Raider.IO. The Raider.IO sample defaults to 20 pages per region; weekly imports follow Blizzard's current season and newest period automatically.

Repeat `npm run sync` when you want to refresh both datasets. This is the single command to schedule for routine imports. `npm run sync:history` remains a separate, manual historical backfill.

## Data notes

- `All regions` combines the imported regional samples; it is not an additional `world` query, so sampled CN/TW/KR data cannot be omitted by a world-only request.
- Raider.IO uses `us`, `eu`, `cn`, `tw` and `kr` as region codes. Oceanic is not a separate Mythic+ region code in this endpoint; Oceanic runs need to be present in Raider.IO's `us` data to be included.
- These are top-run snapshots, not every completed Mythic+ run. Rankings are subject to the underlying Blizzard leaderboard capacity, and duplicate/repeated teams may occur. Treat percentages as frequency within this sample, not the player population.
- The dashboard calculates exact-five-spec composition frequency, average and peak key level per comp/dungeon, class/spec pick rates, run and character-slot counts, and a spec-pick Gini index at each key level. The Gini index is 0 for an even split and approaches 1 as appearances concentrate in fewer specs.
- The default ranking uses a 0–100 Meta score: 40% logarithmic popularity, 40% average-key difficulty, and 20% highest-key difficulty. Popularity is relative to the most-played comp, with diminishing returns as counts grow.
- The dashboard can cap the sample at 250, 500, 1,000 or 2,000 highest Raider.IO scores from the combined selected-region sample after the date-window and minimum-key filters. `All available` includes every matching imported run. With all regions selected, the imported runs are combined first and the cap is applied globally across that pool.
- Average and highest key are each pulled toward the weighted average key of the selected sample by `n / (n + 50)`, reducing the influence of small samples. Each key level is treated as roughly 15% harder, using `1.15^(adjusted key − highest adjusted key) × 100` for the difficulty score. The final score is `0.40 × popularity + 0.40 × average-key difficulty + 0.20 × highest-key difficulty`. This is a transparent ranking heuristic, not a causal score or success rate; the 15% step is an approximation.
- Date filters are rolling 7-day and 30-day windows. Raider.IO's top-runs endpoint does not provide MythicStats' exact weekly-reset cohort selector, so these filters are not labeled as reset weeks.
- The importer currently handles common run/roster response shapes. If an API response doesn't include the roster or specs in the expected fields, it skips that row; check the `imported_count` and inspect the API payload before interpreting an empty result.
- `npm run sync` - import the Raider.IO current-run sample, then the latest Blizzard weekly leaderboards for US, EU, KR and TW and CN data from Raider.IO. The weekly importer follows Blizzard's latest season and newest period automatically; it also refreshes dashboard, periods and history caches.
- `npm run sync:history` is a separate, one-time historical backfill. It enumerates Blizzard seasons, periods, connected realms, and each season's dungeons. For US, EU, TW, and KR it checks every connected-realm/dungeon/period leaderboard; for all five regions it also imports Raider.IO's paginated seasonal run feed to fill gaps. It deduplicates the combined results and stores at most the top 2,000 runs per region and period. Blizzard's leaderboard is capped per realm/dungeon, and Raider.IO's runs endpoint is capped at 100 pages without an access key or 1,000 pages with one, so neither source guarantees every run completed in-game. Set `RIO_API_KEY` to use the extended page limit; the importer scans pages 0–99 without a key or 0–999 with one (lower the cap with `RIO_HISTORY_MAX_PAGE` if needed). The import logs season, period, board, and pagination progress; it may take many hours. Board, Raider.IO coverage, and period checkpoints are stored in the database. Reruns skip completed coverage, retry failed boards, and expand old Raider.IO coverage if the configured page limit is higher. Use `BLIZZARD_HISTORY_CONCURRENCY` (default `3`, maximum `8`) and `BLIZZARD_HISTORY_REQUEST_DELAY_MS` (default `350`) to tune Blizzard request pacing. To refresh expansion-specific names and reset windows without fetching run leaderboards again, use `npm run sync:history -- --labels-only`. Requires the existing Blizzard credentials and a Raider.IO access key for the 1,000-page limit.
- The `/periods` page lists only weeks actually imported. `/period/:id` summarizes those weekly leaderboard entries, while `/history` charts imported weekly spec shares and diversity. Historical results are only available for periods the Blizzard API still returns and that you have imported. The Blizzard leaderboard source is capped per connected realm and dungeon, so its combined dataset is a high-key sample, not every run.
- Raider.IO requires attribution for public-facing use and disallows competing services under its API terms. This project is configured as a local/private guild tool; don't publish it as a public MythicStats replacement without written permission from Raider.IO.

## Commands

- `npm run dev` — local Vue dashboard and Node API.
- `npm run build` — production frontend build.
- `npm start` — serve the built frontend and API in production mode.
- `npm run db:setup` — create the app database and tables from the schema.
- `npm run sync` - import the Raider.IO current-run sample, then the latest Blizzard weekly leaderboards for US, EU, KR and TW and CN data from Raider.IO. The weekly importer follows Blizzard's latest season and newest period automatically; it also refreshes dashboard, periods and history caches.
- `npm run sync:history` - manual historical backfill; keep it separate from the daily schedule.
