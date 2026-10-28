import 'dotenv/config';
import { createHash } from 'node:crypto';
import { pool } from './db.js';
import { blizzardData } from './blizzard.js';
import { getMythicPlusStaticData, getRegionPeriods, getTopRuns, normalizeRun } from './rio.js';
import { refreshPageCaches } from './refresh-page-caches.js';
import { capHistoryPeriod, ensureBlizzardHistoryTables, importBlizzardHistoryRegion } from './sync-history-blizzard.js';

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
const labelsOnly = process.argv.includes('--labels-only');
// Keep Raider.IO-only rows separate from Blizzard's connected-realm rankings.
const RAIDER_IO_REALM_ID = 0xffffffff;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const configuredRequestDelay = Number(process.env.RIO_HISTORY_REQUEST_DELAY_MS);
const requestDelay = Number.isFinite(configuredRequestDelay) && configuredRequestDelay > 0 ? configuredRequestDelay : 0;
const configuredConcurrency = Number(process.env.RIO_HISTORY_CONCURRENCY);
const rioConcurrency = Math.max(1, Math.min(5, Number.isFinite(configuredConcurrency) && configuredConcurrency > 0 ? configuredConcurrency : 5));
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

async function ensureHistoryCheckpointTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS history_sync_checkpoints (
    region VARCHAR(8) NOT NULL,
    season_id INT UNSIGNED NOT NULL,
    dungeon_id INT UNSIGNED NOT NULL,
    dungeon VARCHAR(160) NOT NULL,
    status VARCHAR(16) NOT NULL,
    last_page SMALLINT UNSIGNED NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (region, season_id, dungeon_id)
  ) ENGINE=InnoDB`);
}

async function setHistoryCheckpoint(region, seasonId, dungeonId, dungeon, status, lastPage = null) {
  await pool.execute(
    `INSERT INTO history_sync_checkpoints (region, season_id, dungeon_id, dungeon, status, last_page)
     VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE dungeon=VALUES(dungeon), status=VALUES(status), last_page=VALUES(last_page)`,
    [region, seasonId, dungeonId, dungeon, status, lastPage]
  );
}

async function loadRaiderIoSeasons() {
  const seasons = new Map();
  for (const expansionId of EXPANSION_IDS) {
    console.log(`[history] Raider.IO: loading static season data for expansion ${expansionId}.`);
    try {
      const data = await getMythicPlusStaticData(expansionId);
      const allExpansionSeasons = (data?.seasons || [])
        .filter((season) => Number(season.blizzard_season_id) > 0 && season.slug);
      const expansionSeasons = allExpansionSeasons
        .filter((season) => season.is_main_season === true)
        .sort((a, b) => Number(a.blizzard_season_id) - Number(b.blizzard_season_id));
      const excludedCount = allExpansionSeasons.length - expansionSeasons.length;
      if (allExpansionSeasons.length && !expansionSeasons.length) {
        throw new Error(`Raider.IO returned seasons for expansion ${expansionId}, but none were marked as main seasons.`);
      }
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
      console.log(`[history] Raider.IO: ${EXPANSION_NAMES[expansionId] || `expansion ${expansionId}`} returned ${expansionSeasons.length} main season(s)${excludedCount ? `; ignored ${excludedCount} post-season or special leaderboard entry/entries` : ''}: ${expansionSeasons.map((season, index) => `${Number(season.blizzard_season_id)}=${EXPANSION_NAMES[expansionId] || `Expansion ${expansionId}`} S${index + 1}`).join(', ') || 'none'}.`);
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
  const [seasonIndex, realmIndex, dungeonIndex] = await Promise.all([
    blizzardData(region, '/data/wow/mythic-keystone/season/index'),
    blizzardData(region, '/data/wow/connected-realm/index'),
    blizzardData(region, '/data/wow/mythic-keystone/dungeon/index')
  ]);
  const indexedSeasons = [...(seasonIndex?.seasons || [])].sort((a, b) => idFrom(a) - idFrom(b));
  const realmIds = [...new Set((realmIndex?.connected_realms || []).map(idFrom).filter(Boolean))];
  const dungeons = dungeonIndex?.dungeons || [];
  if (!realmIds.length) throw new Error(`Blizzard returned no connected realms for ${region}.`);
  console.log(`[history] ${region.toUpperCase()}: ${realmIds.length} connected realms and ${dungeons.length} dungeon index entries.`);
  const periods = new Map();
  const seasons = [];
  const [cachedPeriodRows] = await pool.execute(
    'SELECT period_id, season_id, season_name, start_timestamp, end_timestamp FROM weekly_periods WHERE region = ?',
    [region]
  );
  const cachedPeriods = new Map(cachedPeriodRows.map((row) => [Number(row.period_id), row]));

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

    let reusedPeriods = 0;
    let fetchedPeriods = 0;
    for (const [periodIndex, periodId] of periodIds.entries()) {
      const cached = cachedPeriods.get(periodId);
      if (cached && Number(cached.start_timestamp) > 0 && Number(cached.end_timestamp) > 0) {
        const window = { id: periodId, seasonId, seasonName, start: Number(cached.start_timestamp), end: Number(cached.end_timestamp) };
        periods.set(periodId, window);
        if (Number(cached.season_id) !== seasonId || cached.season_name !== seasonName) {
          await pool.execute(
            'UPDATE weekly_periods SET season_id = ?, season_name = ? WHERE period_id = ? AND region = ?',
            [seasonId, seasonName, periodId, region]
          );
        }
        reusedPeriods += 1;
        if ((periodIndex + 1) % 25 === 0 || periodIndex + 1 === periodIds.length) {
          console.log(`[history] ${region.toUpperCase()} ${seasonName}: reused ${reusedPeriods}/${periodIndex + 1} stored period windows; fetched ${fetchedPeriods} missing window(s).`);
        }
        continue;
      }
      let period;
      try {
        period = await blizzardData(region, `/data/wow/mythic-keystone/period/${periodId}`);
        fetchedPeriods += 1;
      } catch (error) {
        console.warn(`[history] ${region.toUpperCase()} ${seasonName}: period ${periodId} failed after retries (${error.message}); skipping this period and continuing.`);
        // Still correct the label on an already imported period without replacing
        // its previously saved regional reset timestamps.
        await pool.execute(
          `UPDATE weekly_periods SET season_id = ?, season_name = ? WHERE period_id = ? AND region = ?`,
          [seasonId, seasonName, periodId, region]
        );
        if ((periodIndex + 1) % 25 === 0 || periodIndex + 1 === periodIds.length) console.log(`[history] ${region.toUpperCase()} ${seasonName}: processed ${periodIndex + 1}/${periodIds.length} period windows; reused ${reusedPeriods}, fetched ${fetchedPeriods}.`);
        if (blizzardDelay) await sleep(blizzardDelay);
        continue;
      }
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
      if ((periodIndex + 1) % 25 === 0 || periodIndex + 1 === periodIds.length) console.log(`[history] ${region.toUpperCase()} ${seasonName}: processed ${periodIndex + 1}/${periodIds.length} period windows; reused ${reusedPeriods}, fetched ${fetchedPeriods}.`);
      if (blizzardDelay) await sleep(blizzardDelay);
    }
  }

  console.log(`[history] ${region.toUpperCase()}: loaded ${seasons.length} season(s) and ${periods.size} usable period windows.`);
  return { seasons, periods, realms: realmIds, dungeons };
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
  let failedScans = 0;
  let skippedScans = 0;

  const scanDungeon = async ([dungeonIndex, dungeon]) => {
    const dungeonName = dungeon.name || dungeon.slug;
    const dungeonKey = dungeon.slug || dungeon.name;
    const dungeonId = dungeonIdFor(dungeonName);
    const [checkpointRows] = await pool.execute(
      'SELECT status FROM history_sync_checkpoints WHERE region = ? AND season_id = ? AND dungeon_id = ?',
      [region, season.id, dungeonId]
    );
    if (checkpointRows[0]?.status === 'complete') {
      skippedScans += 1;
      console.log(`[history] ${region.toUpperCase()} ${season.name} / ${dungeonName}: skipping; a completed scan is already checkpointed.`);
      return;
    }
    if (!checkpointRows.length) {
      // Earlier importer versions saved runs only after an entire dungeon scan
      // succeeded. Existing rows therefore let us preserve that completed work.
      const [existingRows] = await pool.execute(
        `SELECT COUNT(*) AS row_count FROM weekly_leaderboard_runs
         WHERE region = ? AND connected_realm_id = ? AND season_id = ? AND dungeon_id = ?`,
        [region, RAIDER_IO_REALM_ID, season.id, dungeonId]
      );
      if (Number(existingRows[0]?.row_count) > 0) {
        skippedScans += 1;
        await setHistoryCheckpoint(region, season.id, dungeonId, dungeonName, 'complete', null);
        console.log(`[history] ${region.toUpperCase()} ${season.name} / ${dungeonName}: skipping; existing imported rows came from a completed earlier scan.`);
        return;
      }
    }
    await setHistoryCheckpoint(region, season.id, dungeonId, dungeonName, 'running', null);
    const dungeonStartedAt = Date.now();
    let pagesLoaded = 0;
    let reachedPageCap = true;
    let dungeonReceived = 0;
    let dungeonAssigned = 0;
    let failedPage = null;
    console.log(`[history] ${region.toUpperCase()} ${season.name}: dungeon ${dungeonName} (${dungeonIndex + 1}/${dungeons.length}), pages 0-${MAX_RIO_PAGE}.`);

    for (let page = 0; page <= MAX_RIO_PAGE; page += 1) {
      if (page === 0 || (page + 1) % 10 === 0) {
        console.log(`[history] ${region.toUpperCase()} ${season.name} / ${dungeonName}: requesting page ${page}/${MAX_RIO_PAGE}.`);
      }
      let entries;
      try {
        entries = await getTopRuns({ region, season: rioSeason.slug, dungeon: dungeonKey, page });
      } catch (error) {
        failedPage = { page, message: error.message };
        reachedPageCap = false;
        failedScans += 1;
        console.error(`[history] ${region.toUpperCase()} ${season.name} / ${dungeonName}: page ${page} failed after retries (${error.message}); keeping earlier pages and moving to the next dungeon.`);
        break;
      }
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
      if ((page + 1) % 10 === 0 || page === MAX_RIO_PAGE) {
        await setHistoryCheckpoint(region, season.id, dungeonId, dungeonName, 'running', page);
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
    await setHistoryCheckpoint(region, season.id, dungeonId, dungeonName, failedPage ? 'incomplete' : 'complete', pagesLoaded ? pagesLoaded - 1 : null);
    persisted += dungeonSaved;
    console.log(`[history] ${region.toUpperCase()} ${season.name} / ${dungeonName}: ${failedPage ? `partial scan stopped at page ${failedPage.page}` : 'finished scan'}; loaded ${pagesLoaded} page(s), saved ${dungeonSaved} run(s) in ${Math.round((Date.now() - dungeonStartedAt) / 1000)}s.`);
  };
  let nextDungeon = 0;
  const worker = async () => {
    while (nextDungeon < dungeons.length) {
      const dungeonIndex = nextDungeon++;
      await scanDungeon([dungeonIndex, dungeons[dungeonIndex]]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(rioConcurrency, dungeons.length) }, worker));

  console.log(`[history] ${region.toUpperCase()} ${season.name}: received ${received} API rows, saved ${persisted}, skipped ${skippedScans} completed dungeon scan(s), could not map ${unmapped} to a known period, incomplete dungeon scans ${failedScans}.`);
  return { runs: persisted, unmapped, failedScans, skippedScans };
}

try {
  const startedAt = Date.now();
  console.log(`[history] Starting one-time historical import for ${REGIONS.join(', ')}.`);
  if (labelsOnly) console.log('[history] Labels-only mode: refreshing period season names and windows; run leaderboards will not be fetched.');
  else {
    await ensureHistoryCheckpointTable();
    await ensureBlizzardHistoryTables(pool);
  }
  console.log(`[history] Period labels/windows will come from Blizzard. US, EU, TW and KR runs will be collected from every connected-realm leaderboard; CN will use Raider.IO's historical run feed.`);
  console.log(`[history] Blizzard history caps saved data at 2,000 deduplicated runs per region and period. Use BLIZZARD_HISTORY_CONCURRENCY and BLIZZARD_HISTORY_REQUEST_DELAY_MS to adjust request pacing.`);
  console.log(`[history] CN Raider.IO pagination: page 0 through ${MAX_RIO_PAGE} per dungeon/region/season; global header-aware request pacing, ${requestDelay}ms extra per-worker pause, and ${rioConcurrency} concurrent dungeon scans.`);

  const rioSeasons = await loadRaiderIoSeasons();
  const regionData = new Map();
  for (const region of BLIZZARD_REGIONS) regionData.set(region, await loadBlizzardRegion(region, rioSeasons));
  const reference = regionData.get('us');
  const cnPeriods = await loadChinaPeriods(reference.seasons, reference.periods);
  regionData.set('cn', { seasons: reference.seasons, periods: cnPeriods });

  let totalRuns = 0;
  let skippedSeasons = 0;
  let failedScans = 0;
  let skippedCompletedPeriods = 0;
  if (!labelsOnly) {
    for (const region of REGIONS) {
      const data = regionData.get(region);
      if (region !== 'cn') {
        const result = await importBlizzardHistoryRegion({
          pool,
          region,
          seasons: data.seasons,
          realms: data.realms,
          dungeonIndex: data.dungeons,
          rioSeasons
        });
        totalRuns += result.savedRuns;
        failedScans += result.failedBoards;
        skippedCompletedPeriods += result.skippedPeriods;
        continue;
      }
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
        failedScans += result.failedScans;
        skippedCompletedPeriods += result.skippedScans;
        for (const periodId of season.periodIds) {
          const capped = await capHistoryPeriod(pool, region, season.id, periodId);
          console.log(`[history] CN ${season.name} period ${periodId}: retained ${capped} top run(s) after the region/period cap.`);
        }
      }
    }
  }

  if (labelsOnly) {
    console.log(`[history] Completed in ${Math.round((Date.now() - startedAt) / 1000)}s. Refreshed season names and period windows without importing runs.`);
  } else if (failedScans) {
    console.warn(`[history] Finished in ${Math.round((Date.now() - startedAt) / 1000)}s with ${failedScans} incomplete board/season issue(s). Saved or retained ${totalRuns} run rows, skipped ${skippedCompletedPeriods} completed period/scan(s), and skipped ${skippedSeasons} region/season run imports without Raider.IO metadata. Rerun the command to retry incomplete data.`);
    process.exitCode = 1;
  } else {
    console.log(`[history] Completed in ${Math.round((Date.now() - startedAt) / 1000)}s. Saved or retained ${totalRuns} run rows, skipped ${skippedCompletedPeriods} completed period/scan(s), and skipped ${skippedSeasons} region/season run imports without a Raider.IO season match.`);
  }
} catch (error) {
  console.error(`[history] Import failed: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  await refreshPageCaches();
  await pool.end();
}
