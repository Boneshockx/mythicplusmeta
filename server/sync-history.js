import 'dotenv/config';
import { createHash } from 'node:crypto';
import { pool } from './db.js';
import { blizzardData } from './blizzard.js';
import { getMythicPlusStaticData, getRegionPeriods, getTopRuns, normalizeRun } from './rio.js';

// Raider.IO currently publishes Mythic+ static data for Legion through Midnight.
const EXPANSION_IDS = [6, 7, 8, 9, 10, 11];
const EXPANSION_NAMES = {
  6: 'Legion',
  7: 'Battle for Azeroth',
  8: 'Shadowlands',
  9: 'Dragonflight',
  10: 'The War Within',
  11: 'Midnight'
};
const BLIZZARD_REGIONS = ['us', 'eu', 'tw', 'kr'];
const REGIONS = [...BLIZZARD_REGIONS, 'cn'];
const MAX_RIO_PAGE = 100;
// Keep Raider.IO-only rows separate from Blizzard's connected-realm rankings.
const RAIDER_IO_REALM_ID = 0xffffffff;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const requestDelay = Math.max(0, Number(process.env.RIO_HISTORY_REQUEST_DELAY_MS || 250));
const rioConcurrency = Math.max(1, Math.min(5, Number(process.env.RIO_HISTORY_CONCURRENCY || 3)));
const blizzardDelay = Math.max(0, Number(process.env.BLIZZARD_REQUEST_DELAY_MS || 150));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const idFrom = (item) => Number(item?.id || item?.key?.href?.match(/\/(\d+)(?:\?.*)?$/)?.[1] || item?.href?.match(/\/(\d+)(?:\?.*)?$/)?.[1]) || 0;

function dungeonIdFor(name) {
  return createHash('sha1').update(name.toLowerCase()).digest().readUInt32BE(0) || 1;
}

function timestamp(value) {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadRaiderIoSeasons() {
  const seasons = new Map();
  for (const expansionId of EXPANSION_IDS) {
    console.log(`[history] Raider.IO: loading static season data for expansion ${expansionId}.`);
    try {
      const data = await getMythicPlusStaticData(expansionId);
      const expansionSeasons = (data?.seasons || [])
        .filter((season) => Number(season.blizzard_season_id) > 0 && season.slug)
        .sort((a, b) => Number(a.blizzard_season_id) - Number(b.blizzard_season_id));
      for (const [index, season] of expansionSeasons.entries()) {
        const blizzardSeasonId = Number(season.blizzard_season_id);
        seasons.set(blizzardSeasonId, {
          ...season,
          expansionId,
          expansionName: EXPANSION_NAMES[expansionId] || `Expansion ${expansionId}`,
          expansionSeasonNumber: index + 1,
          displayName: `${EXPANSION_NAMES[expansionId] || `Expansion ${expansionId}`} Season ${index + 1}`
        });
      }
      console.log(`[history] Raider.IO: ${EXPANSION_NAMES[expansionId] || `expansion ${expansionId}`} returned ${expansionSeasons.length} season(s): ${expansionSeasons.map((season, index) => `${Number(season.blizzard_season_id)}=${EXPANSION_NAMES[expansionId] || `Expansion ${expansionId}`} S${index + 1}`).join(', ') || 'none'}.`);
    } catch (error) {
      console.warn(`[history] Raider.IO: could not load expansion ${expansionId}: ${error.message}`);
    }
  }
  if (!seasons.size) throw new Error('Raider.IO returned no season metadata.');
  console.log(`[history] Raider.IO: found ${seasons.size} season(s) with Blizzard season IDs.`);
  return seasons;
}

async function loadBlizzardRegion(region, rioSeasons) {
  console.log(`[history] ${region.toUpperCase()}: loading all Blizzard Mythic+ seasons.`);
  const seasonIndex = await blizzardData(region, '/data/wow/mythic-keystone/season/index');
  const indexedSeasons = [...(seasonIndex?.seasons || [])].sort((a, b) => idFrom(a) - idFrom(b));
  const periods = new Map();
  const seasons = [];

  for (const [index, item] of indexedSeasons.entries()) {
    const seasonId = idFrom(item);
    if (!seasonId) continue;
    console.log(`[history] ${region.toUpperCase()}: loading season ${seasonId} (${index + 1}/${indexedSeasons.length}).`);
    const detail = await blizzardData(region, `/data/wow/mythic-keystone/season/${seasonId}`);
    if (!detail) {
      console.warn(`[history] ${region.toUpperCase()}: season ${seasonId} has no detail response; skipping it.`);
      continue;
    }
    const rioSeason = rioSeasons.get(seasonId);
    const seasonName = rioSeason?.displayName || detail.name || item.name || `Season ${seasonId}`;
    const periodIds = [...new Set((detail.periods || []).map(idFrom).filter(Boolean))].sort((a, b) => a - b);
    seasons.push({ id: seasonId, name: seasonName, periodIds });
    console.log(`[history] ${region.toUpperCase()}: ${seasonName} (Blizzard season ${seasonId}) has ${periodIds.length} period(s).`);

    for (const [periodIndex, periodId] of periodIds.entries()) {
      const period = await blizzardData(region, `/data/wow/mythic-keystone/period/${periodId}`);
      if (period?.start_timestamp && period?.end_timestamp) {
        const window = { id: periodId, seasonId, seasonName, start: Number(period.start_timestamp), end: Number(period.end_timestamp) };
        periods.set(periodId, window);
        await pool.execute(
          `INSERT INTO weekly_periods (period_id, region, season_id, season_name, start_timestamp, end_timestamp)
           VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE season_id=VALUES(season_id), season_name=VALUES(season_name),
             start_timestamp=VALUES(start_timestamp), end_timestamp=VALUES(end_timestamp)`,
          [periodId, region, seasonId, seasonName, window.start, window.end]
        );
      } else {
        console.warn(`[history] ${region.toUpperCase()}: period ${periodId} has no timestamps; skipping its period record.`);
      }
      if ((periodIndex + 1) % 10 === 0 || periodIndex + 1 === periodIds.length) {
        console.log(`[history] ${region.toUpperCase()} ${seasonName}: fetched ${periodIndex + 1}/${periodIds.length} period windows.`);
      }
      if (blizzardDelay) await sleep(blizzardDelay);
    }
  }

  console.log(`[history] ${region.toUpperCase()}: loaded ${seasons.length} season(s) and ${periods.size} usable period windows.`);
  return { seasons, periods };
}

async function loadChinaPeriods(referenceSeasons, referencePeriods) {
  console.log('[history] CN: loading reset anchors from Raider.IO.');
  const response = await getRegionPeriods();
  const region = (response?.periods || []).find((item) => String(item.region).toLowerCase() === 'cn');
  if (!region) throw new Error('Raider.IO did not return CN reset periods.');
  const anchors = ['previous', 'current', 'next'].map((key) => region[key]).filter((item) =>
    Number(item?.period) > 0 && timestamp(item.start) && timestamp(item.end)
  ).map((item) => ({ id: Number(item.period), start: timestamp(item.start), end: timestamp(item.end) }));
  const anchor = anchors.find((item) => item.start <= Date.now() && item.end > Date.now())
    || anchors.find((item) => item.start < Date.now())
    || anchors[0];
  if (!anchor) throw new Error('Raider.IO did not return a usable CN reset window.');

  const periods = new Map();
  let storedCount = 0;
  for (const season of referenceSeasons) {
    for (const periodId of season.periodIds) {
      const blizzardWindow = referencePeriods.get(periodId);
      const exact = anchors.find((item) => item.id === periodId);
      const offset = periodId - anchor.id;
      const start = exact?.start ?? anchor.start + offset * WEEK_MS;
      const end = exact?.end ?? start + WEEK_MS;
      const window = { id: periodId, seasonId: season.id, seasonName: season.name, start, end };
      periods.set(periodId, window);
      await pool.execute(
        `INSERT INTO weekly_periods (period_id, region, season_id, season_name, start_timestamp, end_timestamp)
         VALUES (?, 'cn', ?, ?, ?, ?) ON DUPLICATE KEY UPDATE season_id=VALUES(season_id), season_name=VALUES(season_name),
           start_timestamp=VALUES(start_timestamp), end_timestamp=VALUES(end_timestamp)`,
        [periodId, season.id, season.name, start, end]
      );
      storedCount += 1;
      if (blizzardWindow && Math.abs(start - blizzardWindow.start) > 2 * 24 * 60 * 60 * 1000) {
        console.warn(`[history] CN period ${periodId} reset differs from US by over two days; using the CN weekly reset calculation.`);
      }
      if (storedCount % 10 === 0 || storedCount === referenceSeasons.reduce((total, item) => total + item.periodIds.length, 0)) {
        console.log(`[history] CN: saved ${storedCount} period windows so far.`);
      }
    }
  }
  console.log(`[history] CN: recorded ${periods.size} period window(s) across ${referenceSeasons.length} season(s).`);
  return periods;
}

function periodForRun(completedAt, periods) {
  const completed = timestamp(completedAt);
  if (!completed) return null;
  for (const period of periods.values()) {
    if (completed >= period.start && completed < period.end) return period;
  }
  return null;
}

async function importSeasonRegion(region, season, rioSeason, periodWindows) {
  const dungeons = [...new Map((rioSeason.dungeons || [])
    .filter((dungeon) => dungeon?.slug || dungeon?.name)
    .map((dungeon) => [dungeon.slug || dungeon.name, dungeon])).values()];
  if (!dungeons.length) {
    console.warn(`[history] ${region.toUpperCase()} ${season.name}: Raider.IO has no dungeon list; skipping runs.`);
    return { runs: 0, unmapped: 0 };
  }

  console.log(`[history] ${region.toUpperCase()} ${season.name}: importing ${dungeons.length} dungeon leaderboard(s) from Raider.IO.`);
  console.log(`[history] ${region.toUpperCase()} ${season.name}: using ${rioConcurrency} concurrent dungeon scans.`);
  const byPeriod = new Map();
  let received = 0;
  let savedCandidateCount = 0;
  let unmapped = 0;
  let persisted = 0;

  const scanDungeon = async ([dungeonIndex, dungeon]) => {
    const dungeonName = dungeon.name || dungeon.slug;
    const dungeonKey = dungeon.slug || dungeon.name;
    const dungeonStartedAt = Date.now();
    let pagesLoaded = 0;
    let reachedPageCap = true;
    let dungeonReceived = 0;
    let dungeonAssigned = 0;
    console.log(`[history] ${region.toUpperCase()} ${season.name}: dungeon ${dungeonName} (${dungeonIndex + 1}/${dungeons.length}), pages 0-${MAX_RIO_PAGE}.`);

    for (let page = 0; page <= MAX_RIO_PAGE; page += 1) {
      if (page === 0 || (page + 1) % 10 === 0) {
        console.log(`[history] ${region.toUpperCase()} ${season.name} / ${dungeonName}: requesting page ${page}/${MAX_RIO_PAGE}.`);
      }
      const entries = await getTopRuns({ region, season: rioSeason.slug, dungeon: dungeonKey, page });
      if (!entries.length) {
        reachedPageCap = false;
        console.log(`[history] ${region.toUpperCase()} ${season.name} / ${dungeonName}: page ${page} is empty; pagination complete.`);
        break;
      }
      pagesLoaded += 1;
      received += entries.length;
      dungeonReceived += entries.length;
      let acceptedThisPage = 0;
      for (const entry of entries) {
        const run = normalizeRun(entry, region, rioSeason.slug);
        if (!run?.completedAt || run.roster.length !== 5) continue;
        const period = periodForRun(run.completedAt, periodWindows);
        if (!period || period.seasonId !== season.id) {
          unmapped += 1;
          continue;
        }
        const periodRuns = byPeriod.get(period.id) || new Map();
        const dungeonRuns = periodRuns.get(dungeonName) || new Map();
        dungeonRuns.set(run.sourceRunId, { ...run, score: Number(run.score || run.level || 0), period });
        periodRuns.set(dungeonName, dungeonRuns);
        byPeriod.set(period.id, periodRuns);
        acceptedThisPage += 1;
      }
      savedCandidateCount += acceptedThisPage;
      dungeonAssigned += acceptedThisPage;
      if (page === 0 || (page + 1) % 10 === 0 || page === MAX_RIO_PAGE) {
        console.log(`[history] ${region.toUpperCase()} ${season.name} / ${dungeonName}: through page ${page}/${MAX_RIO_PAGE}; ${dungeonReceived} API rows and ${dungeonAssigned} assigned to periods.`);
      }
      if (requestDelay) await sleep(requestDelay);
    }

    if (reachedPageCap) {
      console.warn(`[history] ${region.toUpperCase()} ${season.name} / ${dungeonName}: reached Raider.IO page ${MAX_RIO_PAGE}; later pages are not available through this endpoint.`);
    }
    let dungeonSaved = 0;
    for (const [periodId, periodGroups] of byPeriod) {
      const runMap = periodGroups.get(dungeonName);
      if (!runMap?.size) continue;
      const runs = [...runMap.values()].sort((a, b) => b.score - a.score || b.level - a.level || timestamp(b.completedAt) - timestamp(a.completedAt));
      const dungeonId = dungeonIdFor(dungeonName);
      const values = runs.map((run, index) => [
        periodId, region, RAIDER_IO_REALM_ID, season.id, dungeonId, dungeonName, index + 1,
        run.level || 0, run.score || 0, run.completedAt ? new Date(timestamp(run.completedAt)) : null,
        JSON.stringify(run.roster), JSON.stringify({ ...run.payload, source: 'raiderio-history', source_run_id: run.sourceRunId })
      ]);
      for (let offset = 0; offset < values.length; offset += 250) {
        await pool.query(
          `INSERT INTO weekly_leaderboard_runs
            (period_id, region, connected_realm_id, season_id, dungeon_id, dungeon, ranking, level, score, completed_at, roster, payload)
           VALUES ? ON DUPLICATE KEY UPDATE level=VALUES(level), score=VALUES(score), completed_at=VALUES(completed_at),
             roster=VALUES(roster), payload=VALUES(payload), dungeon=VALUES(dungeon)`,
          [values.slice(offset, offset + 250)]
        );
      }
      dungeonSaved += values.length;
    }
    persisted += dungeonSaved;
    console.log(`[history] ${region.toUpperCase()} ${season.name} / ${dungeonName}: finished ${pagesLoaded} page(s), saved ${dungeonSaved} run(s) in ${Math.round((Date.now() - dungeonStartedAt) / 1000)}s.`);
  };
  let nextDungeon = 0;
  const worker = async () => {
    while (nextDungeon < dungeons.length) {
      const dungeonIndex = nextDungeon++;
      await scanDungeon([dungeonIndex, dungeons[dungeonIndex]]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(rioConcurrency, dungeons.length) }, worker));

  console.log(`[history] ${region.toUpperCase()} ${season.name}: received ${received} API rows, saved ${persisted}, could not map ${unmapped} to a known period.`);
  return { runs: persisted, unmapped };
}

try {
  const startedAt = Date.now();
  console.log(`[history] Starting one-time historical import for ${REGIONS.join(', ')}.`);
  console.log(`[history] Period labels/windows will come from Blizzard season and period data; run samples will come from Raider.IO.`);
  console.log(`[history] Raider.IO pagination: page 0 through ${MAX_RIO_PAGE} per dungeon/region/season; ${requestDelay}ms pause between pages; ${rioConcurrency} concurrent dungeon scans.`);

  const rioSeasons = await loadRaiderIoSeasons();
  const regionData = new Map();
  for (const region of BLIZZARD_REGIONS) regionData.set(region, await loadBlizzardRegion(region, rioSeasons));
  const reference = regionData.get('us');
  const cnPeriods = await loadChinaPeriods(reference.seasons, reference.periods);
  regionData.set('cn', { seasons: reference.seasons, periods: cnPeriods });

  let totalRuns = 0;
  let skippedSeasons = 0;
  for (const region of REGIONS) {
    const data = regionData.get(region);
    for (const [seasonIndex, season] of data.seasons.entries()) {
      const rioSeason = rioSeasons.get(season.id);
      if (!rioSeason) {
        skippedSeasons += 1;
        console.warn(`[history] ${region.toUpperCase()}: Blizzard season ${season.id} (${season.name}) has no matching Raider.IO season metadata; periods are saved, but runs are skipped.`);
        continue;
      }
      console.log(`[history] ${region.toUpperCase()}: season ${seasonIndex + 1}/${data.seasons.length}, Blizzard ${season.id} = ${season.name}, Raider.IO ${rioSeason.slug}.`);
      const result = await importSeasonRegion(region, season, rioSeason, data.periods);
      totalRuns += result.runs;
    }
  }

  console.log(`[history] Completed in ${Math.round((Date.now() - startedAt) / 1000)}s. Saved ${totalRuns} run rows; skipped ${skippedSeasons} region/season run imports without a Raider.IO season match.`);
} catch (error) {
  console.error(`[history] Import failed: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
