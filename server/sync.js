import 'dotenv/config';
import { pool } from './db.js';
import { getTopRuns, normalizeRun } from './rio.js';

const regions = (process.env.RIO_REGIONS || 'us,eu,cn,tw,kr').split(',').map((x) => x.trim()).filter(Boolean);
const pages = Math.max(1, Math.min(101, Number(process.env.RIO_PAGES_PER_REGION || 20)));
const season = process.env.RIO_SEASON || 'current';
let syncId;

try {
  const [result] = await pool.execute(
    'INSERT INTO sync_runs (started_at, status, regions) VALUES (NOW(), ?, ?)',
    ['running', JSON.stringify(regions)]
  );
  syncId = result.insertId;
  let imported = 0;

  for (const region of regions) {
    for (let page = 0; page < pages; page += 1) {
      const runs = await getTopRuns({ region, season, page });
      if (!runs.length) break;

      for (const run of runs) {
        const item = normalizeRun(run, region, season);
        if (!item) continue;
        const [saved] = await pool.execute(
          `INSERT INTO mythic_plus_runs
            (source_run_id, region, season, dungeon, level, completed_at, score, roster, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE dungeon=VALUES(dungeon), level=VALUES(level),
             completed_at=VALUES(completed_at), score=VALUES(score), roster=VALUES(roster), payload=VALUES(payload)`,
          [item.sourceRunId, item.region, item.season, item.dungeon, item.level,
            item.completedAt ? new Date(item.completedAt.replace('Z', '+00:00')) : null,
            item.score, JSON.stringify(item.roster), JSON.stringify(item.payload)]
        );
        imported += saved.affectedRows > 0 ? 1 : 0;
      }
      // Keep requests sequential and leave room under anonymous rate limits.
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }

  await pool.execute('UPDATE sync_runs SET finished_at=NOW(), status=?, imported_count=? WHERE id=?', ['success', imported, syncId]);
  console.log(`Sync finished: ${imported} rows processed across ${regions.join(', ')}.`);
} catch (error) {
  if (syncId) {
    await pool.execute('UPDATE sync_runs SET finished_at=NOW(), status=?, error_message=? WHERE id=?', ['failed', String(error.message).slice(0, 4000), syncId]).catch(() => {});
  }
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
