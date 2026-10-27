import { createHash } from 'node:crypto';
import { getRegionPeriods, getTopRuns, normalizeRun } from './rio.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const args = new Map(process.argv.slice(2).filter((x) => x.startsWith('--')).map((x) => {
  const [key, ...rest] = x.slice(2).split('=');
  return [key, rest.join('=') || 'true'];
}));

function timestamp(value) {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function periodWindows(payload) {
  const region = (payload?.periods || []).find((item) => String(item.region).toLowerCase() === 'cn');
  if (!region) throw new Error('Raider.IO did not return CN reset periods.');
  return ['previous', 'current', 'next'].map((key) => region[key]).filter((window) =>
    Number(window?.period) > 0 && timestamp(window.start) && timestamp(window.end)
  ).map((window) => ({ period: Number(window.period), start: timestamp(window.start), end: timestamp(window.end) }));
}

function windowForRun(completedAt, knownWindows) {
  const time = timestamp(completedAt);
  const exact = knownWindows.find((window) => time >= window.start && time < window.end);
  if (exact) return exact;

  // Raider.IO exposes the exact previous/current/next windows. Extend that
  // fixed seven-day regional reset cadence to older runs in the same season.
  const now = Date.now();
  const anchor = knownWindows.find((window) => window.start <= now && window.end > now)
    || knownWindows.find((window) => window.start < now)
    || knownWindows[0];
  if (!anchor || !time) return null;
  const offset = Math.floor((time - anchor.start) / WEEK_MS);
  const start = anchor.start + offset * WEEK_MS;
  return { period: anchor.period + offset, start, end: start + WEEK_MS };
}

function dungeonIdFor(name) {
  return createHash('sha1').update(name.toLowerCase()).digest().readUInt32BE(0) || 1;
}

export async function syncChinaWeekly(pool, { seasonId: requestedSeasonId, periodId: requestedPeriodId, sampleLimit = 2000 } = {}) {
  const startedAt = Date.now();
  const seasonId = Number(requestedSeasonId || args.get('season') || process.env.BLIZZARD_SEASON_ID || 18);
  const defaultSlug = ({ 18: 'season-mn-2', 17: 'season-mn-1' })[seasonId] || 'current';
  const seasonSlug = args.get('season-slug') || process.env.RIO_SEASON || defaultSlug;
  const pageCount = Math.max(1, Math.min(101, Number(args.get('cn-pages') || process.env.RIO_CN_PAGES || 101)));
  const requestDelay = Math.max(0, Number(process.env.RIO_CN_REQUEST_DELAY_MS || 1200));
  const knownWindows = periodWindows(await getRegionPeriods());
  const runsById = new Map();
  const [dungeonRows] = await pool.execute(
    'SELECT DISTINCT dungeon FROM weekly_leaderboard_runs WHERE season_id = ? ORDER BY dungeon', [seasonId]
  );
  const dungeons = dungeonRows.map((row) => row.dungeon).filter(Boolean);
  if (!dungeons.length) throw new Error(`No season ${seasonId} dungeons are available locally to query Raider.IO CN.`);
  console.log(`CN Raider.IO: starting season ${seasonId} (${seasonSlug}); ${dungeons.length} dungeon(s), up to ${pageCount} page(s) each, ${requestDelay}ms request delay.`);

  for (const dungeon of dungeons) {
    const dungeonStartedAt = Date.now();
    let pagesLoaded = 0;
    for (let page = 0; page < pageCount; page += 1) {
      console.log(`CN Raider.IO ${dungeon}: requesting page ${page + 1}/${pageCount}.`);
      const entries = await getTopRuns({ region: 'cn', season: seasonSlug, dungeon, page });
      if (!entries.length) {
        console.log(`CN Raider.IO ${dungeon}: page ${page + 1} had no results; stopping this dungeon.`);
        break;
      }
      pagesLoaded += 1;
      for (const entry of entries) {
        const run = normalizeRun(entry, 'cn', seasonSlug);
        if (!run || !run.completedAt || run.roster.length !== 5) continue;
        const window = windowForRun(run.completedAt, knownWindows);
        if (!window) continue;
        runsById.set(run.sourceRunId, { ...run, window, score: Number(run.score || run.level || 0) });
      }
      console.log(`CN Raider.IO ${dungeon}: loaded page ${page + 1}/${pageCount} (${entries.length} runs received; ${runsById.size} unique usable runs total).`);
      if (page + 1 < pageCount && requestDelay) await new Promise((resolve) => setTimeout(resolve, requestDelay));
    }
    console.log(`CN Raider.IO ${dungeon}: finished ${pagesLoaded} page(s) in ${Math.round((Date.now() - dungeonStartedAt) / 1000)}s.`);
    if (requestDelay) await new Promise((resolve) => setTimeout(resolve, requestDelay));
  }

  const [seasonPeriodRows] = await pool.execute(
    'SELECT DISTINCT period_id FROM weekly_periods WHERE season_id = ? AND region <> \'cn\' ORDER BY period_id', [seasonId]
  );
  const seasonPeriodIds = new Set(seasonPeriodRows.map((row) => Number(row.period_id)));
  if (requestedPeriodId) {
    seasonPeriodIds.clear();
    seasonPeriodIds.add(Number(requestedPeriodId));
  }
  if (!seasonPeriodIds.size) throw new Error('No season periods are available to align CN reset windows.');

  const grouped = new Map();
  for (const run of runsById.values()) {
    const key = run.window.period;
    if (!seasonPeriodIds.has(key)) continue;
    const period = grouped.get(key) || { window: run.window, runs: [] };
    period.runs.push(run);
    grouped.set(key, period);
  }

  const referenceWindow = knownWindows.find((window) => window.start <= Date.now() && window.end > Date.now()) || knownWindows[0];
  console.log(`CN Raider.IO: saving ${seasonPeriodIds.size} period(s), with ${runsById.size} unique runs available.`);
  for (const periodId of [...seasonPeriodIds].sort((a, b) => a - b)) {
    const period = grouped.get(periodId) || { runs: [] };
    const sampledRuns = [...period.runs]
      .sort((a, b) => b.score - a.score || b.level - a.level || timestamp(b.completedAt) - timestamp(a.completedAt))
      .slice(0, sampleLimit);
    const exactWindow = knownWindows.find((window) => window.period === periodId);
    const offset = periodId - referenceWindow.period;
    const periodWindow = exactWindow || { period: periodId, start: referenceWindow.start + offset * WEEK_MS, end: referenceWindow.start + (offset + 1) * WEEK_MS };
    await pool.execute(
      `INSERT INTO weekly_periods (period_id, region, season_id, season_name, start_timestamp, end_timestamp)
       VALUES (?, 'cn', ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE season_id=VALUES(season_id), season_name=VALUES(season_name),
         start_timestamp=VALUES(start_timestamp), end_timestamp=VALUES(end_timestamp)`,
      [periodId, seasonId, ({ 18: 'Midnight Season 2', 17: 'Midnight Season 1' })[seasonId] || `Season ${seasonId}`, periodWindow.start, periodWindow.end]
    );

    const perDungeon = new Map();
    for (const run of sampledRuns) {
      const id = dungeonIdFor(run.dungeon);
      const bucket = perDungeon.get(id) || [];
      bucket.push(run);
      perDungeon.set(id, bucket);
    }
    const inserts = [];
    for (const [dungeonId, dungeonRuns] of perDungeon) {
      dungeonRuns.sort((a, b) => b.score - a.score || b.level - a.level || timestamp(b.completedAt) - timestamp(a.completedAt));
      for (const [index, run] of dungeonRuns.entries()) {
        inserts.push([periodId, 'cn', 0, seasonId, dungeonId, run.dungeon, index + 1, run.level || 0,
          run.score, new Date(timestamp(run.completedAt)), JSON.stringify(run.roster),
          JSON.stringify({ ...run.payload, source: 'raiderio', source_run_id: run.sourceRunId })]);
      }
    }

    await pool.execute('DELETE FROM weekly_leaderboard_runs WHERE period_id = ? AND region = \'cn\'', [periodId]);
    if (inserts.length) {
      await pool.query(
        `INSERT INTO weekly_leaderboard_runs
          (period_id, region, connected_realm_id, season_id, dungeon_id, dungeon, ranking, level, score, completed_at, roster, payload)
         VALUES ? ON DUPLICATE KEY UPDATE level=VALUES(level), score=VALUES(score), completed_at=VALUES(completed_at),
           roster=VALUES(roster), payload=VALUES(payload), dungeon=VALUES(dungeon)`,
        [inserts]
      );
    }
    console.log(`CN period ${periodId}: saved ${inserts.length} Raider.IO runs (${new Date(periodWindow.start).toISOString()} – ${new Date(periodWindow.end).toISOString()}).`);
  }
  console.log(`CN: imported ${runsById.size} unique Raider.IO runs across ${seasonPeriodIds.size} season periods (max ${sampleLimit} runs per period) in ${Math.round((Date.now() - startedAt) / 1000)}s.`);
}
