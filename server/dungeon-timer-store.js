import { dungeonTimeLimitMs } from './timed-runs.js';

export async function ensureDungeonTimerTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS mythic_plus_dungeon_timers (
    season_id INT UNSIGNED NOT NULL,
    expansion_id SMALLINT UNSIGNED NOT NULL,
    season_slug VARCHAR(100) NOT NULL,
    dungeon_id INT UNSIGNED NULL,
    dungeon_slug VARCHAR(160) NOT NULL,
    dungeon_name VARCHAR(160) NOT NULL,
    time_limit_ms INT UNSIGNED NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (season_id, dungeon_slug),
    KEY idx_dungeon_timer_slug (season_slug, dungeon_slug),
    KEY idx_dungeon_timer_name (season_id, dungeon_name)
  ) ENGINE=InnoDB`);
}

export async function saveSeasonDungeonTimers(pool, { seasonId, expansionId, seasonSlug, dungeons }) {
  const values = (dungeons || []).map((dungeon) => {
    const timeLimitMs = dungeonTimeLimitMs(dungeon);
    const slug = String(dungeon.slug || dungeon.name || '').trim();
    const name = String(dungeon.name || dungeon.slug || '').trim();
    const dungeonId = Number(dungeon.challenge_mode_id || dungeon.challengeModeID || dungeon.challengeModeId
      || dungeon.map_challenge_mode_id || dungeon.id) || null;
    if (!timeLimitMs || !slug || !name) return null;
    return [seasonId, expansionId, seasonSlug, dungeonId, slug, name, timeLimitMs];
  }).filter(Boolean);

  if (!values.length) return 0;
  await pool.query(
    `INSERT INTO mythic_plus_dungeon_timers
      (season_id, expansion_id, season_slug, dungeon_id, dungeon_slug, dungeon_name, time_limit_ms)
     VALUES ? ON DUPLICATE KEY UPDATE expansion_id=VALUES(expansion_id), season_slug=VALUES(season_slug),
       dungeon_id=VALUES(dungeon_id), dungeon_name=VALUES(dungeon_name), time_limit_ms=VALUES(time_limit_ms),
       updated_at=CURRENT_TIMESTAMP`,
    [values]
  );
  return values.length;
}

export async function loadSeasonDungeonTimers(pool, { seasonId = null, seasonSlug = null } = {}) {
  if (seasonId == null && !seasonSlug) return [];
  const where = seasonId != null ? 'season_id = ?' : 'season_slug = ?';
  const value = seasonId != null ? seasonId : seasonSlug;
  const [rows] = await pool.execute(
    `SELECT dungeon_slug, dungeon_name, time_limit_ms
     FROM mythic_plus_dungeon_timers WHERE ${where}`,
    [value]
  );
  return rows;
}
