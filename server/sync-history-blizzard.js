import { createHash } from 'node:crypto';
import { blizzardData } from './blizzard.js';
import { dungeonTimeLimitMs, isTimedLeaderboardGroup } from './timed-runs.js';

const HISTORY_AGGREGATE_REALM_ID = 0xfffffffe;
const MAX_RUNS_PER_PERIOD = 2000;
const PROGRESS_BATCH_SIZE = 25;
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const idFrom = (item) => Number(item?.id || item?.key?.href?.match(/\/(\d+)(?:\?.*)?$/)?.[1] || item?.href?.match(/\/(\d+)(?:\?.*)?$/)?.[1]) || 0;
const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const jsonValue = (value, fallback) => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || ''); } catch { return fallback; }
};
const timestamp = (value) => {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number < 1e12 ? number * 1000 : number;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function mapSeasonDungeons(rioSeason, blizzardDungeons, region) {
  const byName = new Map();
  for (const dungeon of blizzardDungeons || []) {
    const id = idFrom(dungeon);
    if (!id) continue;
    for (const name of [dungeon.name, dungeon.slug, dungeon.short_name]) {
      if (name) byName.set(norm(name), { id, name: dungeon.name || name, timeLimitMs: dungeonTimeLimitMs(dungeon) });
    }
  }
  const unique = new Map();
  for (const dungeon of rioSeason?.dungeons || []) {
    const name = dungeon.name || dungeon.slug;
    const id = Number(dungeon.challenge_mode_id || dungeon.challengeModeID || dungeon.challengeModeId || dungeon.map_challenge_mode_id)
      || byName.get(norm(name))?.id || 0;
    if (!id) {
      console.warn(`[history] ${region.toUpperCase()} ${rioSeason.name}: no Blizzard dungeon ID found for ${name || 'unnamed dungeon'}; it cannot be queried.`);
      continue;
    }
    const timeLimitMs = dungeonTimeLimitMs(dungeon) || byName.get(norm(name))?.timeLimitMs || null;
    if (!timeLimitMs) console.warn(`[history] ${region.toUpperCase()} ${rioSeason.name}: no timer metadata for ${name}; Blizzard results without an explicit timed flag will be excluded.`);
    unique.set(id, {
      id,
      name: dungeon.name || byName.get(norm(name))?.name || name || `Dungeon ${id}`,
      timeLimitMs
    });
  }
  return [...unique.values()];
}

function rosterFor(group) {
  return (group?.members || []).map((member) => {
    const profile = member.profile || member.character_profile || {};
    const character = profile.character || member.character || {};
    const realm = profile.realm || member.realm || {};
    const specialization = member.specialization || member.spec || {};
    const specId = Number(specialization.id || member.specialization_id || 0);
    const known = specById.get(specId);
    return {
      name: profile.name || character.name || member.name || 'Unknown',
      realm: realm.slug || realm.name || member.realm_slug || '',
      spec: known?.[0] || specialization.name || 'Unknown',
      class: known?.[1] || member.character_class?.name || 'Unknown',
      role: known?.[2] || 'dps',
      specId
    };
  });
}

function candidateKey({ region, periodId, dungeonId, level, completedAt, roster, payload }) {
  const sourceRunId = payload?.source_run_id;
  if (sourceRunId) return createHash('sha1').update(`${region}|${sourceRunId}`).digest('hex');
  const team = [...roster].map((member) => `${member.name}@${member.realm}:${member.specId}`).sort().join('|');
  return createHash('sha1').update(`${region}|${periodId}|${dungeonId}|${level}|${completedAt || ''}|${team}`).digest('hex');
}

function candidateFromGroup(group, { region, periodId, dungeon, realmId }) {
  if (!isTimedLeaderboardGroup(group, dungeon.timeLimitMs)) return null;
  const roster = rosterFor(group);
  if (roster.length !== 5) return null;
  const level = Number(group.keystone_level || group.level || 0);
  const score = Number(group.rating || group.score || 0);
  const completedMs = timestamp(group.completed_timestamp || group.completed_at || group.completedAt);
  const completedAt = completedMs ? new Date(completedMs) : null;
  const payload = { ...group, time_limit_ms: dungeon.timeLimitMs, history_source: 'blizzard-realm-leaderboard', source_realms: [realmId] };
  const dungeonId = dungeon.id;
  return {
    key: candidateKey({ region, periodId, dungeonId, level, completedAt: completedMs, roster, payload }),
    periodId, region, seasonId: 0, dungeonId, dungeon: dungeon.name, level, score, completedAt,
    roster, payload
  };
}

function candidateFromRow(row, region, periodId, dungeonByName) {
  const roster = jsonValue(row.roster, []);
  const payload = jsonValue(row.payload, {});
  const name = row.dungeon || 'Unknown dungeon';
  const mappedDungeon = dungeonByName.get(norm(name));
  const timeLimitMs = mappedDungeon?.timeLimitMs || dungeonTimeLimitMs(payload);
  if (!isTimedLeaderboardGroup(payload, timeLimitMs)) return null;
  const dungeonId = mappedDungeon?.id || Number(row.dungeon_id) || 0;
  const completedMs = timestamp(row.completed_at);
  return {
    key: candidateKey({ region, periodId, dungeonId, level: row.level, completedAt: completedMs, roster, payload }),
    periodId, region, seasonId: Number(row.season_id), dungeonId,
    dungeon: mappedDungeon?.name || name,
    level: Number(row.level) || 0, score: Number(row.score) || 0,
    completedAt: completedMs ? new Date(completedMs) : null, roster, payload
  };
}

function compareCandidates(a, b) {
  return b.score - a.score || b.level - a.level || Number(b.completedAt || 0) - Number(a.completedAt || 0);
}

function addAndTrim(candidateMap, candidates) {
  for (const candidate of candidates) {
    const previous = candidateMap.get(candidate.key);
    if (!previous || compareCandidates(candidate, previous) < 0) {
      candidateMap.set(candidate.key, candidate);
    } else if (candidate.payload?.source_realms?.length) {
      previous.payload.source_realms = [...new Set([...(previous.payload.source_realms || []), ...candidate.payload.source_realms])];
    }
  }
  const top = [...candidateMap.values()].sort(compareCandidates).slice(0, MAX_RUNS_PER_PERIOD);
  candidateMap.clear();
  for (const candidate of top) candidateMap.set(candidate.key, candidate);
}

async function readExistingCandidates(pool, region, seasonId, periodId, dungeonByName) {
  const [rows] = await pool.execute(
    `SELECT season_id, dungeon_id, dungeon, level, score, completed_at, roster, payload
     FROM weekly_leaderboard_runs WHERE region = ? AND period_id = ?
     ORDER BY score DESC, level DESC, completed_at DESC`,
    [region, periodId]
  );
  const result = rows.map((row) => candidateFromRow(row, region, periodId, dungeonByName)).filter(Boolean);
  for (const candidate of result) candidate.seasonId = seasonId;
  return result;
}

async function readSavedCandidates(pool, region, seasonId, periodId, dungeonByName) {
  const [rows] = await pool.execute(
    `SELECT season_id, dungeon_id, dungeon, level, score, completed_at, roster, payload
     FROM history_sync_candidates WHERE region = ? AND season_id = ? AND period_id = ?
     ORDER BY score DESC, level DESC, completed_at DESC`,
    [region, seasonId, periodId]
  );
  return rows.map((row) => candidateFromRow(row, region, periodId, dungeonByName)).filter(Boolean);
}

async function saveBatch(pool, region, seasonId, periodId, candidates, outcomes) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      'DELETE FROM history_sync_candidates WHERE region = ? AND season_id = ? AND period_id = ?',
      [region, seasonId, periodId]
    );
    if (candidates.length) {
      await connection.query(
        `INSERT INTO history_sync_candidates
          (region, season_id, period_id, run_key, dungeon_id, dungeon, level, score, completed_at, roster, payload)
         VALUES ?`,
        [candidates.map((item) => [region, seasonId, periodId, item.key, item.dungeonId, item.dungeon, item.level,
          item.score, item.completedAt, JSON.stringify(item.roster), JSON.stringify(item.payload)])]
      );
    }
    if (outcomes.length) {
      await connection.query(
        `INSERT INTO history_sync_board_checkpoints
          (region, season_id, period_id, connected_realm_id, dungeon_id, status, last_error)
         VALUES ? ON DUPLICATE KEY UPDATE status=VALUES(status), last_error=VALUES(last_error), updated_at=CURRENT_TIMESTAMP`,
        [outcomes.map((item) => [region, seasonId, periodId, item.realmId, item.dungeonId,
          item.error ? 'failed' : 'complete', item.error || null])]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function finalizePeriod(pool, region, seasonId, periodId, candidates) {
  const sorted = [...candidates].sort(compareCandidates).slice(0, MAX_RUNS_PER_PERIOD);
  const perDungeonRank = new Map();
  const values = sorted.map((item) => {
    const rank = (perDungeonRank.get(item.dungeonId) || 0) + 1;
    perDungeonRank.set(item.dungeonId, rank);
    const payload = { ...item.payload, history_source: item.payload?.history_source || 'history-existing', source_realms: item.payload?.source_realms || [] };
    return [periodId, region, HISTORY_AGGREGATE_REALM_ID, seasonId, item.dungeonId, item.dungeon, rank,
      item.level, item.score, item.completedAt, JSON.stringify(item.roster), JSON.stringify(payload)];
  });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('DELETE FROM weekly_leaderboard_runs WHERE region = ? AND period_id = ?', [region, periodId]);
    if (values.length) {
      await connection.query(
        `INSERT INTO weekly_leaderboard_runs
          (period_id, region, connected_realm_id, season_id, dungeon_id, dungeon, ranking, level, score, completed_at, roster, payload)
         VALUES ?`,
        [values]
      );
    }
    await connection.execute(
      `INSERT INTO history_sync_period_checkpoints (region, season_id, period_id, status, saved_runs)
       VALUES (?, ?, ?, 'complete', ?) ON DUPLICATE KEY UPDATE status='complete', saved_runs=VALUES(saved_runs), updated_at=CURRENT_TIMESTAMP, last_error=NULL`,
      [region, seasonId, periodId, values.length]
    );
    await connection.execute('DELETE FROM history_sync_candidates WHERE region = ? AND season_id = ? AND period_id = ?', [region, seasonId, periodId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return values.length;
}

async function importPeriod({ pool, region, season, periodId, realms, dungeons, concurrency, delayMs, force }) {
  const [periodCheckpoints] = await pool.execute(
    'SELECT status, saved_runs FROM history_sync_period_checkpoints WHERE region = ? AND season_id = ? AND period_id = ?',
    [region, season.id, periodId]
  );
  if (!force && periodCheckpoints[0]?.status === 'complete') {
    console.log(`[history] ${region.toUpperCase()} ${season.name} period ${periodId}: already complete (${periodCheckpoints[0].saved_runs} saved runs); skipping.`);
    return { saved: Number(periodCheckpoints[0].saved_runs) || 0, failed: 0, skipped: 1 };
  }

  const boards = realms.flatMap((realmId) => dungeons.map((dungeon) => ({ realmId, dungeonId: dungeon.id, dungeon })));
  const [doneRows] = await pool.execute(
    `SELECT connected_realm_id, dungeon_id FROM history_sync_board_checkpoints
     WHERE region = ? AND season_id = ? AND period_id = ? AND status = 'complete'`,
    [region, season.id, periodId]
  );
  const completed = new Set(doneRows.map((row) => `${Number(row.connected_realm_id)}:${Number(row.dungeon_id)}`));
  const pending = force ? boards : boards.filter((board) => !completed.has(`${board.realmId}:${board.dungeonId}`));
  const dungeonByName = new Map(dungeons.flatMap((dungeon) => [[norm(dungeon.name), dungeon], [norm(dungeon.id), dungeon]]));
  const savedCandidates = await readSavedCandidates(pool, region, season.id, periodId, dungeonByName);
  const candidateMap = new Map();
  addAndTrim(candidateMap, savedCandidates.length
    ? savedCandidates
    : await readExistingCandidates(pool, region, season.id, periodId, dungeonByName));

  console.log(`[history] ${region.toUpperCase()} ${season.name} period ${periodId}: checking ${pending.length}/${boards.length} realm/dungeon leaderboards; ${candidateMap.size} existing candidates retained, top ${MAX_RUNS_PER_PERIOD} per region/period.`);
  await pool.execute(
    `INSERT INTO history_sync_period_checkpoints (region, season_id, period_id, status, saved_runs)
     VALUES (?, ?, ?, 'running', ?) ON DUPLICATE KEY UPDATE status='running', updated_at=CURRENT_TIMESTAMP`,
    [region, season.id, periodId, candidateMap.size]
  );

  let fetchedBoards = 0;
  let failedBoards = 0;
  let leaderboardGroups = 0;
  let timedGroups = 0;
  for (let offset = 0; offset < pending.length; offset += PROGRESS_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + PROGRESS_BATCH_SIZE);
    let next = 0;
    const outcomes = [];
    const imported = [];
    const worker = async () => {
      while (next < batch.length) {
        const board = batch[next++];
        let errorMessage = null;
        try {
          const leaderboard = await blizzardData(region,
            `/data/wow/connected-realm/${board.realmId}/mythic-leaderboard/${board.dungeonId}/period/${periodId}`);
          const groups = leaderboard?.leading_groups || [];
          leaderboardGroups += groups.length;
          for (const group of groups) {
            const candidate = candidateFromGroup(group, { region, periodId, dungeon: board.dungeon, realmId: board.realmId });
            if (candidate) {
              timedGroups += 1;
              candidate.seasonId = season.id;
              imported.push(candidate);
            }
          }
          fetchedBoards += 1;
        } catch (error) {
          errorMessage = error.message;
          failedBoards += 1;
          console.warn(`[history] ${region.toUpperCase()} ${season.name} period ${periodId}, realm ${board.realmId}, ${board.dungeon.name}: ${error.message}; will retry on the next run.`);
        }
        outcomes.push({ realmId: board.realmId, dungeonId: board.dungeonId, error: errorMessage });
        if (delayMs) await sleep(delayMs);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, worker));
    addAndTrim(candidateMap, imported);
    await saveBatch(pool, region, season.id, periodId, [...candidateMap.values()], outcomes);
    const completedCount = completed.size + offset + batch.length;
    console.log(`[history] ${region.toUpperCase()} ${season.name} period ${periodId}: checked ${Math.min(completedCount, boards.length)}/${boards.length} realm/dungeon boards; ${timedGroups}/${leaderboardGroups} leaderboard groups passed the timed-run filter; ${candidateMap.size} unique top-run candidates retained; ${failedBoards} board request(s) failed so far.`);
  }

  const [failedRows] = await pool.execute(
    `SELECT COUNT(*) AS count FROM history_sync_board_checkpoints
     WHERE region = ? AND season_id = ? AND period_id = ? AND status <> 'complete'`,
    [region, season.id, periodId]
  );
  if (Number(failedRows[0]?.count || 0) > 0) {
    await pool.execute(
      `UPDATE history_sync_period_checkpoints SET status='incomplete', saved_runs=?, last_error=?
       WHERE region = ? AND season_id = ? AND period_id = ?`,
      [candidateMap.size, `${failedRows[0].count} board(s) need retry`, region, season.id, periodId]
    );
    return { saved: candidateMap.size, failed: Number(failedRows[0].count), skipped: 0 };
  }

  const saved = await finalizePeriod(pool, region, season.id, periodId, [...candidateMap.values()]);
  console.log(`[history] ${region.toUpperCase()} ${season.name} period ${periodId}: finished all ${boards.length} boards; ${timedGroups}/${leaderboardGroups} leaderboard groups passed the timed-run filter; saved ${saved} deduplicated runs.`);
  return { saved, failed: 0, skipped: 0 };
}

export async function ensureBlizzardHistoryTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS history_sync_board_checkpoints (
    region VARCHAR(8) NOT NULL,
    season_id INT UNSIGNED NOT NULL,
    period_id INT UNSIGNED NOT NULL,
    connected_realm_id INT UNSIGNED NOT NULL,
    dungeon_id INT UNSIGNED NOT NULL,
    status VARCHAR(16) NOT NULL,
    last_error TEXT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (region, season_id, period_id, connected_realm_id, dungeon_id),
    KEY idx_history_board_status (region, season_id, period_id, status)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS history_sync_period_checkpoints (
    region VARCHAR(8) NOT NULL,
    season_id INT UNSIGNED NOT NULL,
    period_id INT UNSIGNED NOT NULL,
    status VARCHAR(16) NOT NULL,
    saved_runs INT UNSIGNED NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (region, season_id, period_id),
    KEY idx_history_period_status (region, status)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS history_sync_candidates (
    region VARCHAR(8) NOT NULL,
    season_id INT UNSIGNED NOT NULL,
    period_id INT UNSIGNED NOT NULL,
    run_key CHAR(40) NOT NULL,
    dungeon_id INT UNSIGNED NOT NULL,
    dungeon VARCHAR(160) NOT NULL,
    level SMALLINT UNSIGNED NOT NULL,
    score DECIMAL(10,2) NOT NULL DEFAULT 0,
    completed_at DATETIME NULL,
    roster JSON NOT NULL,
    payload JSON NOT NULL,
    PRIMARY KEY (region, season_id, period_id, run_key),
    KEY idx_history_candidate_rank (region, season_id, period_id, score, level)
  ) ENGINE=InnoDB`);
}

export async function capHistoryPeriod(pool, region, seasonId, periodId) {
  const [rows] = await pool.execute(
    `SELECT season_id, dungeon_id, dungeon, level, score, completed_at, roster, payload
     FROM weekly_leaderboard_runs WHERE region = ? AND period_id = ?
     ORDER BY score DESC, level DESC, completed_at DESC`,
    [region, periodId]
  );
  const candidates = new Map();
  addAndTrim(candidates, rows.map((row) => candidateFromRow(row, region, periodId, new Map())).filter(Boolean));
  return finalizePeriod(pool, region, seasonId, periodId, [...candidates.values()]);
}

export async function importBlizzardHistoryRegion({ pool, region, seasons, realms, dungeonIndex, rioSeasons, force = false }) {
  const concurrency = Math.max(1, Math.min(8, Number(process.env.BLIZZARD_HISTORY_CONCURRENCY || 3)));
  const delayMs = Math.max(0, Number(process.env.BLIZZARD_HISTORY_REQUEST_DELAY_MS || 350));
  let savedRuns = 0;
  let failedBoards = 0;
  let skippedPeriods = 0;
  console.log(`[history] ${region.toUpperCase()}: exhaustive Blizzard scan across ${realms.length} connected realms; concurrency ${concurrency}, ${delayMs}ms pause per request, cap ${MAX_RUNS_PER_PERIOD} runs per period.`);

  for (const season of seasons) {
    const rioSeason = rioSeasons.get(season.id);
    if (!rioSeason) {
      console.warn(`[history] ${region.toUpperCase()}: season ${season.id} (${season.name}) has no Raider.IO dungeon metadata; no dungeon IDs can be matched.`);
      failedBoards += 1;
      continue;
    }
    const mappedDungeons = mapSeasonDungeons(rioSeason, dungeonIndex, region);
    if (!mappedDungeons.length) {
      console.error(`[history] ${region.toUpperCase()} ${season.name}: no dungeon IDs could be resolved; this season was not marked complete.`);
      failedBoards += season.periodIds.length || 1;
      continue;
    }
    season.dungeons = mappedDungeons;
    const expectedBoards = realms.length * mappedDungeons.length * season.periodIds.length;
    console.log(`[history] ${region.toUpperCase()} ${season.name}: ${mappedDungeons.length} dungeon(s) x ${realms.length} realm(s) x ${season.periodIds.length} period(s) = ${expectedBoards.toLocaleString()} leaderboard checks.`);
    for (const periodId of season.periodIds) {
      const result = await importPeriod({ pool, region, season, periodId, realms, dungeons: mappedDungeons, concurrency, delayMs, force });
      savedRuns += result.saved;
      failedBoards += result.failed;
      skippedPeriods += result.skipped;
    }
  }
  console.log(`[history] ${region.toUpperCase()}: Blizzard history pass saved ${savedRuns} run(s), left ${failedBoards} board/season issue(s) for retry, skipped ${skippedPeriods} already completed period(s).`);
  return { savedRuns, failedBoards, skippedPeriods };
}

export { HISTORY_AGGREGATE_REALM_ID };
