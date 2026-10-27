import 'dotenv/config';
import { pool } from './db.js';
import { blizzardData } from './blizzard.js';
import { syncChinaWeekly } from './sync-weekly-cn.js';

const args = new Map(process.argv.slice(2).filter((x) => x.startsWith('--')).map((x) => {
  const [key, ...rest] = x.slice(2).split('=');
  return [key, rest.join('=') || 'true'];
}));
const regions = (args.get('regions') || process.env.BLIZZARD_REGIONS || 'us,eu,kr,tw').split(',').map((x) => x.trim()).filter(Boolean);
const requestedPeriod = args.get('period');
const allPeriods = args.get('all-periods') === 'true';
const requestedSeason = Number(args.get('season') || process.env.BLIZZARD_SEASON_ID) || null;
const delayMs = Math.max(0, Number(process.env.BLIZZARD_REQUEST_DELAY_MS || 150));
const sampleLimit = Math.max(1, Number(args.get('limit') || process.env.BLIZZARD_TOP_RUNS || 2000));
const concurrency = Math.max(1, Math.min(8, Number(args.get('concurrency') || process.env.BLIZZARD_CONCURRENCY || 5)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const idFrom = (item) => Number(item?.id || item?.key?.href?.match(/\/(\d+)(?:\?.*)?$/)?.[1] || item?.href?.match(/\/(\d+)(?:\?.*)?$/)?.[1]) || 0;
const specById = new Map([
  [62, ['Arcane', 'Mage', 'dps']], [63, ['Fire', 'Mage', 'dps']], [64, ['Frost', 'Mage', 'dps']],
  [65, ['Holy', 'Paladin', 'healer']], [66, ['Protection', 'Paladin', 'tank']], [70, ['Retribution', 'Paladin', 'dps']],
  [71, ['Arms', 'Warrior', 'dps']], [72, ['Fury', 'Warrior', 'dps']], [73, ['Protection', 'Warrior', 'tank']],
  [102, ['Balance', 'Druid', 'dps']], [103, ['Feral', 'Druid', 'dps']], [104, ['Guardian', 'Druid', 'tank']], [105, ['Restoration', 'Druid', 'healer']],
  [250, ['Blood', 'Death Knight', 'tank']], [251, ['Frost', 'Death Knight', 'dps']], [252, ['Unholy', 'Death Knight', 'dps']],
  [253, ['Beast Mastery', 'Hunter', 'dps']], [254, ['Marksmanship', 'Hunter', 'dps']], [255, ['Survival', 'Hunter', 'dps']],
  [256, ['Discipline', 'Priest', 'healer']], [257, ['Holy', 'Priest', 'healer']], [258, ['Shadow', 'Priest', 'dps']],
  [259, ['Assassination', 'Rogue', 'dps']], [260, ['Outlaw', 'Rogue', 'dps']], [261, ['Subtlety', 'Rogue', 'dps']],
  [262, ['Elemental', 'Shaman', 'dps']], [263, ['Enhancement', 'Shaman', 'dps']], [264, ['Restoration', 'Shaman', 'healer']],
  [265, ['Affliction', 'Warlock', 'dps']], [266, ['Demonology', 'Warlock', 'dps']], [267, ['Destruction', 'Warlock', 'dps']],
  [268, ['Brewmaster', 'Monk', 'tank']], [269, ['Windwalker', 'Monk', 'dps']], [270, ['Mistweaver', 'Monk', 'healer']],
  [577, ['Havoc', 'Demon Hunter', 'dps']], [581, ['Vengeance', 'Demon Hunter', 'tank']],
  [1467, ['Devastation', 'Evoker', 'dps']], [1468, ['Preservation', 'Evoker', 'healer']], [1473, ['Augmentation', 'Evoker', 'dps']],
  [1480, ['Devourer', 'Demon Hunter', 'dps']]
]);

function rosterFor(group) {
  return (group?.members || []).map((member) => {
    const specializationId = Number(member.specialization?.id || member.spec?.id || 0);
    const known = specById.get(specializationId);
    return {
      name: member.name || 'Unknown',
      realm: member.realm?.slug || member.realm?.name || '',
      spec: known?.[0] || member.specialization?.name || member.spec?.name || 'Unknown',
      class: known?.[1] || 'Unknown',
      role: known?.[2] || 'dps',
      specId: specializationId
    };
  });
}

async function syncRegion(region) {
  const [realmIndex, dungeonIndex, periodIndex, seasonIndex] = await Promise.all([
    blizzardData(region, '/data/wow/connected-realm/index'),
    blizzardData(region, '/data/wow/mythic-keystone/dungeon/index'),
    blizzardData(region, '/data/wow/mythic-keystone/period/index'),
    blizzardData(region, '/data/wow/mythic-keystone/season/index')
  ]);
  const seasonList = seasonIndex?.seasons || [];
  if (args.get('list-seasons') === 'true') {
    for (const item of [...seasonList].sort((a, b) => idFrom(b) - idFrom(a))) {
      const id = idFrom(item);
      const detail = await blizzardData(region, `/data/wow/mythic-keystone/season/${id}`);
      console.log(`${region.toUpperCase()} season ${id}: ${detail?.name || item.name || 'unnamed'} (${detail?.periods?.length || 0} periods)`);
    }
    return;
  }
  const season = requestedSeason
    ? seasonList.find((item) => idFrom(item) === requestedSeason)
    : [...seasonList].sort((a, b) => idFrom(b) - idFrom(a))[0];
  const seasonId = requestedSeason || idFrom(seasonIndex?.current_season) || idFrom(season);
  if (!seasonId) throw new Error(`No Mythic+ season was returned for ${region}.`);
  const seasonData = season ? await blizzardData(region, `/data/wow/mythic-keystone/season/${seasonId}`) : null;
  const seasonName = seasonData?.name || season?.name || ({ 18: 'Midnight Season 2', 17: 'Midnight Season 1' }[seasonId]) || `Season ${seasonId}`;
  let periodIds = requestedPeriod ? [Number(requestedPeriod)] : (periodIndex?.periods || []).map(idFrom).filter(Boolean);
  periodIds = [...new Set(periodIds)].sort((a, b) => b - a);
  if (!requestedPeriod && !allPeriods) periodIds = periodIds.slice(0, 1);
  if (!periodIds.length) throw new Error(`No Mythic+ periods were returned for ${region}.`);

  const realmIds = [...new Set((realmIndex?.connected_realms || []).map(idFrom).filter(Boolean))];
  const dungeonNames = new Map((dungeonIndex?.dungeons || []).map((dungeon) => [idFrom(dungeon), dungeon.name]));
  const leaderboardIndexes = new Map();
  let failedBoards = 0;
  let inserted = 0;
  let checked = 0;
  for (const periodId of periodIds) {
    const period = await blizzardData(region, `/data/wow/mythic-keystone/period/${periodId}`);
    if (!period?.start_timestamp || !period?.end_timestamp) continue;
    // Respect the selected season's official start/end if Blizzard returns them.
    if (seasonData?.periods?.length) {
      const seasonPeriodIds = new Set(seasonData.periods.map(idFrom));
      if (!seasonPeriodIds.has(periodId)) continue;
    }
    await pool.execute(
      `INSERT INTO weekly_periods (period_id, region, season_id, season_name, start_timestamp, end_timestamp)
       VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE season_id=VALUES(season_id), season_name=VALUES(season_name),
       start_timestamp=VALUES(start_timestamp), end_timestamp=VALUES(end_timestamp)`,
      [periodId, region, seasonId, seasonName, period.start_timestamp, period.end_timestamp]
    );
    console.log(`${region.toUpperCase()} ${seasonName} period ${periodId}: ${realmIds.length} realms`);
    let processedRealms = 0;
    const candidates = [];
    let nextRealm = 0;
    const keepTopCandidates = (entries) => {
      candidates.push(...entries);
      candidates.sort((a, b) => b.score - a.score || b.level - a.level || a.ranking - b.ranking);
      if (candidates.length > sampleLimit) candidates.length = sampleLimit;
    };
    const processRealm = async (realmId) => {
      let leaderboardIndex = leaderboardIndexes.get(realmId);
      if (!leaderboardIndex) {
        try {
          leaderboardIndex = await blizzardData(region, `/data/wow/connected-realm/${realmId}/mythic-leaderboard/index`);
          leaderboardIndexes.set(realmId, leaderboardIndex);
        } catch (error) {
          failedBoards += 1;
          console.warn(`${region.toUpperCase()} realm ${realmId}: unable to load leaderboard index (${error.message}); skipping realm.`);
          return;
        }
      }
      // The dungeon index includes historic dungeons. Use Blizzard's active board
      // list, then keep only the region-wide top sample in memory for this week.
      for (const board of leaderboardIndex?.current_leaderboards || []) {
        const dungeonId = idFrom(board);
        if (!dungeonId) continue;
        let leaderboard;
        try {
          leaderboard = await blizzardData(region, `/data/wow/connected-realm/${realmId}/mythic-leaderboard/${dungeonId}/period/${periodId}`);
        } catch (error) {
          failedBoards += 1;
          console.warn(`${region.toUpperCase()} realm ${realmId}, dungeon ${dungeonId}, period ${periodId}: ${error.message}; skipping board.`);
          continue;
        }
        checked += 1;
        const entries = [];
        for (const [index, group] of (leaderboard?.leading_groups || []).entries()) {
          const roster = rosterFor(group);
          if (roster.length !== 5) continue;
          entries.push({
            values: [periodId, region, realmId, seasonId, dungeonId, board.name || dungeonNames.get(dungeonId) || `Dungeon ${dungeonId}`, index + 1,
              Number(group.keystone_level || 0), Number(group.rating || 0), group.completed_timestamp ? new Date(group.completed_timestamp) : null,
              JSON.stringify(roster), JSON.stringify(group)],
            score: Number(group.rating || 0), level: Number(group.keystone_level || 0), ranking: index + 1
          });
        }
        keepTopCandidates(entries);
        if (delayMs) await sleep(delayMs);
      }
    };
    const worker = async () => {
      while (nextRealm < realmIds.length) {
        const realmId = realmIds[nextRealm++];
        await processRealm(realmId);
        processedRealms += 1;
        if (processedRealms % 10 === 0 || processedRealms === realmIds.length) {
          console.log(`${region.toUpperCase()} period ${periodId}: checked ${processedRealms}/${realmIds.length} realms.`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, realmIds.length) }, worker));

    await pool.execute('DELETE FROM weekly_leaderboard_runs WHERE period_id = ? AND region = ?', [periodId, region]);
    if (candidates.length) {
      await pool.query(
        `INSERT INTO weekly_leaderboard_runs
          (period_id, region, connected_realm_id, season_id, dungeon_id, dungeon, ranking, level, score, completed_at, roster, payload)
         VALUES ? ON DUPLICATE KEY UPDATE level=VALUES(level), score=VALUES(score), completed_at=VALUES(completed_at),
           roster=VALUES(roster), payload=VALUES(payload), dungeon=VALUES(dungeon)`,
        [candidates.map((entry) => entry.values)]
      );
    }
    inserted += candidates.length;
    console.log(`${region.toUpperCase()} period ${periodId}: saved ${candidates.length} top runs by Blizzard score (limit ${sampleLimit}).`);
  }
  console.log(`${region.toUpperCase()}: visited ${checked} realm/dungeon boards; skipped ${failedBoards}; saved ${inserted} leaderboard entries.`);
}

try {
  for (const region of regions.filter((item) => item !== 'cn')) await syncRegion(region);
  const importChina = regions.includes('cn') || (!args.has('regions') && process.env.BLIZZARD_INCLUDE_CN !== 'false');
  if (importChina) await syncChinaWeekly(pool, {
    seasonId: requestedSeason,
    periodId: requestedPeriod ? Number(requestedPeriod) : null,
    sampleLimit
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
