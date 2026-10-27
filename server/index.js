import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');
app.use(express.json());

// Midnight Season 2 in-game M+ limits. Store by canonicalized dungeon name because
// Blizzard can expose different dungeon IDs for the same map across regions.
const dungeonTimersMs = new Map([
  ['altar of fangs', 30 * 60_000], ['den of nalorakk', 32 * 60_000],
  ["kings rest", 33 * 60_000], ['murder row', 34 * 60_000],
  ['ruby life pools', 28 * 60_000], ['temple of sethraliss', 32 * 60_000],
  ['the blinding vale', 30 * 60_000], ['blinding vale', 30 * 60_000],
  ['voidscar arena', 30 * 60_000]
]);
const normalizeDungeonName = (value) => String(value || 'Unknown dungeon').toLocaleLowerCase('en').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const seasonFirstMplusPeriod = new Map([[18, 1077]]);
const keyDifficultyMultiplier = 1.15;
function calculateMetaRanking(compositions) {
  if (!compositions.length) return [];
  const totalRuns = compositions.reduce((total, comp) => total + comp.count, 0);
  const overallAverageKey = totalRuns
    ? compositions.reduce((total, comp) => total + comp.averageLevel * comp.count, 0) / totalRuns
    : 0;
  const maxRuns = Math.max(...compositions.map((comp) => comp.count));
  const maxLogPopularity = Math.log1p(maxRuns) || 1;
  const scored = compositions.map((comp) => {
    const confidence = comp.count / (comp.count + 50);
    const adjustedAverageKey = overallAverageKey + (comp.averageLevel - overallAverageKey) * confidence;
    const adjustedHighestKey = overallAverageKey + (comp.maxLevel - overallAverageKey) * confidence;
    return { comp, adjustedAverageKey, adjustedHighestKey, popularityScore: Math.log1p(comp.count) / maxLogPopularity * 100 };
  });
  const highestAverageKey = Math.max(...scored.map((item) => item.adjustedAverageKey));
  const highestPeakKey = Math.max(...scored.map((item) => item.adjustedHighestKey));
  return scored.map((item) => {
    const averageKeyScore = Math.pow(keyDifficultyMultiplier, item.adjustedAverageKey - highestAverageKey) * 100;
    const highestKeyScore = Math.pow(keyDifficultyMultiplier, item.adjustedHighestKey - highestPeakKey) * 100;
    return { ...item, metaScore: item.popularityScore * 0.4 + averageKeyScore * 0.4 + highestKeyScore * 0.2 };
  }).sort((a, b) => b.metaScore - a.metaScore || b.comp.count - a.comp.count
    || b.comp.averageLevel - a.comp.averageLevel || b.comp.maxLevel - a.comp.maxLevel)
    .map(({ comp, metaScore }, index) => ({ ...comp, metaScore, metaRank: index + 1 }));
}

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false, error: 'Database unavailable. Check .env and database/schema.sql.' }); }
});

app.get('/api/meta/summary', async (req, res) => {
  try {
    const region = req.query.region || 'all';
    const minimumLevel = Math.max(0, Number(req.query.minLevel) || 0);
    const days = [7, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 0;
    const requestedSampleLimit = Number(req.query.sampleLimit);
    const sampleLimit = [250, 500, 1000, 2000].includes(requestedSampleLimit) ? requestedSampleLimit : 0;
    let season = req.query.season || process.env.RIO_SEASON || 'current';
    if (season === 'current') {
      const [latest] = await pool.query('SELECT season FROM mythic_plus_runs ORDER BY last_seen_at DESC LIMIT 1');
      if (latest[0]?.season) season = latest[0].season;
    }
    const params = [season];
    let where = 'season = ?';
    if (days) where += ` AND completed_at >= UTC_TIMESTAMP() - INTERVAL ${days} DAY`;
    if (minimumLevel) { where += ' AND level >= ?'; params.push(minimumLevel); }
    if (region !== 'all') { where += ' AND region = ?'; params.push(region); }

    const [queriedRuns] = await pool.execute(`SELECT region, dungeon, level, roster, payload, completed_at, score FROM mythic_plus_runs WHERE ${where} ORDER BY score DESC, completed_at DESC, region ASC, id ASC`, params);
    const runs = sampleLimit ? queriedRuns.slice(0, sampleLimit) : queriedRuns;
    const availableParams = [season];
    let availableWhere = 'season = ?';
    if (days) availableWhere += ` AND completed_at >= UTC_TIMESTAMP() - INTERVAL ${days} DAY`;
    if (region !== 'all') { availableWhere += ' AND region = ?'; availableParams.push(region); }
    const [availableLevels] = await pool.execute(`SELECT DISTINCT level FROM mythic_plus_runs WHERE ${availableWhere} AND level IS NOT NULL ORDER BY level`, availableParams);
    const [syncRows] = await pool.execute('SELECT finished_at, status FROM sync_runs ORDER BY id DESC LIMIT 1');
    const comps = new Map();
    const specs = new Map();
    const classes = new Map();
    const dungeons = new Map();
    const keyLevels = new Map();
    const seenCharacters = new Set();
    let keyLevelTotal = 0;
    let highestKey = 0;
    const normalizeRole = (role) => {
      const value = String(role || '').toLowerCase();
      if (value.includes('tank')) return 'tank';
      if (value.includes('heal')) return 'healer';
      return 'dps';
    };
    const roleOrder = { tank: 0, healer: 1, dps: 2 };
    const normalizeSpecKey = (value) => String(value).toLowerCase().replace(/[^a-z]/g, '');

    for (const run of runs) {
      const roster = typeof run.roster === 'string' ? JSON.parse(run.roster) : run.roster;
      const payload = typeof run.payload === 'string' ? JSON.parse(run.payload) : run.payload;
      const level = Number(run.level || 0);
      const composition = (roster || []).map((p) => ({
        spec: p.spec || 'Unknown', class: p.class || 'Unknown', role: normalizeRole(p.role),
        name: p.name, realm: p.realm
      })).sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || a.class.localeCompare(b.class) || a.spec.localeCompare(b.spec));
      const key = composition.map((p) => `${p.spec} ${p.class}`).join('|') || 'Composition unavailable';
      const existing = comps.get(key) || { composition: composition.map(({ name, realm, ...p }) => p), count: 0, regions: new Set(), dungeons: new Map(), maxLevel: 0, levelTotal: 0 };
      existing.count += 1;
      existing.regions.add(run.region);
      const dungeonKey = normalizeDungeonName(run.dungeon);
      existing.dungeons.set(dungeonKey, (existing.dungeons.get(dungeonKey) || 0) + 1);
      existing.maxLevel = Math.max(existing.maxLevel, level);
      existing.levelTotal += level;
      comps.set(key, existing);

      const levelRow = keyLevels.get(level) || { level, runs: 0, specs: new Map() };
      levelRow.runs += 1;
      keyLevels.set(level, levelRow);
      keyLevelTotal += level;
      highestKey = Math.max(highestKey, level);

      const dungeonRow = dungeons.get(dungeonKey) || { dungeon: run.dungeon, runs: 0, levelTotal: 0, maxLevel: 0, clearTimeTotal: 0, timedRuns: 0, remainingTimeTotalMs: 0, maxTimeRemainingMs: null, fastestRunLevel: null };
      dungeonRow.runs += 1;
      dungeonRow.levelTotal += level;
      dungeonRow.maxLevel = Math.max(dungeonRow.maxLevel, level);
      const clearTime = Number(payload?.duration || payload?.clear_time_ms || payload?.clearTimeMs || 0);
      const timeLimitMs = dungeonTimersMs.get(dungeonKey) || null;
      if (clearTime > 0) {
        dungeonRow.clearTimeTotal += clearTime; dungeonRow.timedRuns += 1;
        if (timeLimitMs) {
          const remainingMs = timeLimitMs - clearTime;
          dungeonRow.remainingTimeTotalMs += remainingMs;
          if (dungeonRow.maxTimeRemainingMs === null || remainingMs > dungeonRow.maxTimeRemainingMs) {
            dungeonRow.maxTimeRemainingMs = remainingMs;
            dungeonRow.fastestRunLevel = level;
          }
        }
      }
      dungeonRow.timeLimitMs = timeLimitMs;
      dungeons.set(dungeonKey, dungeonRow);

      for (const player of roster || []) {
        const specKey = `${player.spec} ${player.class}`;
        const role = normalizeRole(player.role);
        const row = specs.get(specKey) || { spec: player.spec, class: player.class, appearances: 0, role };
        row.appearances += 1;
        specs.set(specKey, row);
        const classRow = classes.get(player.class) || { class: player.class, appearances: 0, specs: new Map() };
        classRow.appearances += 1;
        classRow.specs.set(player.spec, (classRow.specs.get(player.spec) || 0) + 1);
        classes.set(player.class, classRow);
        const perLevelSpec = levelRow.specs;
        const normalizedKey = normalizeSpecKey(specKey);
        perLevelSpec.set(normalizedKey, (perLevelSpec.get(normalizedKey) || 0) + 1);
        if (player.name) seenCharacters.add(`${run.region}:${player.realm}:${player.name}`.toLowerCase());
      }
    }

    const sampleSize = runs.length;
    const totalCharacters = [...runs].reduce((sum, run) => {
      const roster = typeof run.roster === 'string' ? JSON.parse(run.roster) : run.roster;
      return sum + (roster?.length || 0);
    }, 0);
    const minRunsForEstablished = Math.max(50, Math.ceil(sampleSize * 0.025));
    const topComps = calculateMetaRanking([...comps.values()].map((x) => ({
      composition: x.composition, count: x.count, maxLevel: x.maxLevel,
      averageLevel: x.count ? x.levelTotal / x.count : 0,
      share: sampleSize ? x.count / sampleSize * 100 : 0,
      established: x.count >= minRunsForEstablished,
      regions: [...x.regions], dungeons: [...x.dungeons].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
    })));
    const specList = [...specs.values()].map((x) => ({ ...x, pickRate: totalCharacters ? x.appearances / totalCharacters * 100 : 0 }))
      .sort((a, b) => b.appearances - a.appearances);
    const classList = [...classes.values()].map((x) => ({
      class: x.class, appearances: x.appearances,
      pickRate: totalCharacters ? x.appearances / totalCharacters * 100 : 0,
      specs: [...x.specs].map(([spec, appearances]) => ({ spec, appearances, withinClass: x.appearances ? appearances / x.appearances * 100 : 0 })).sort((a, b) => b.appearances - a.appearances)
    })).sort((a, b) => b.appearances - a.appearances);
    const dungeonList = [...dungeons.values()].map((x) => ({
      ...x, averageLevel: x.runs ? x.levelTotal / x.runs : 0,
      averageClearTimeMs: x.timedRuns ? x.clearTimeTotal / x.timedRuns : null,
      averageTimeRemainingMs: x.timedRuns && x.timeLimitMs ? x.remainingTimeTotalMs / x.timedRuns : null
    })).sort((a, b) => b.runs - a.runs);

    const gini = (values) => {
      const sorted = [...values].map(Number).sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      if (!sum || sorted.length < 2) return 0;
      const weighted = sorted.reduce((total, value, index) => total + (2 * (index + 1) - sorted.length - 1) * value, 0);
      return Math.max(0, Math.min(1, weighted / (sorted.length * sum)));
    };
    const allSpecs = [
      ['Blood', 'Death Knight'], ['Frost', 'Death Knight'], ['Unholy', 'Death Knight'],
      ['Havoc', 'Demon Hunter'], ['Vengeance', 'Demon Hunter'], ['Devourer', 'Demon Hunter'],
      ['Balance', 'Druid'], ['Feral', 'Druid'], ['Guardian', 'Druid'], ['Restoration', 'Druid'],
      ['Augmentation', 'Evoker'], ['Devastation', 'Evoker'], ['Preservation', 'Evoker'],
      ['Beast Mastery', 'Hunter'], ['Marksmanship', 'Hunter'], ['Survival', 'Hunter'],
      ['Arcane', 'Mage'], ['Fire', 'Mage'], ['Frost', 'Mage'],
      ['Brewmaster', 'Monk'], ['Mistweaver', 'Monk'], ['Windwalker', 'Monk'],
      ['Holy', 'Paladin'], ['Protection', 'Paladin'], ['Retribution', 'Paladin'],
      ['Discipline', 'Priest'], ['Holy', 'Priest'], ['Shadow', 'Priest'],
      ['Assassination', 'Rogue'], ['Outlaw', 'Rogue'], ['Subtlety', 'Rogue'],
      ['Elemental', 'Shaman'], ['Enhancement', 'Shaman'], ['Restoration', 'Shaman'],
      ['Affliction', 'Warlock'], ['Demonology', 'Warlock'], ['Destruction', 'Warlock'],
      ['Arms', 'Warrior'], ['Fury', 'Warrior'], ['Protection', 'Warrior']
    ].map(([spec, className]) => normalizeSpecKey(`${spec} ${className}`));
    const diversity = [...keyLevels.values()].map((x) => ({
      level: x.level, runs: x.runs,
      gini: gini(allSpecs.map((key) => x.specs.get(key) || 0)),
      topSpecs: [...x.specs].map(([key, appearances]) => ({ key, appearances })).sort((a, b) => b.appearances - a.appearances).slice(0, 4)
    })).filter((x) => x.level > 0).sort((a, b) => a.level - b.level);

    res.json({
      season, region, sampleSize, totalCharacters, uniqueCharacters: seenCharacters.size,
      minimumLevel, days, sampleLimit, minRunsForEstablished, availableKeyLevels: availableLevels.map((x) => x.level),
      averageLevel: sampleSize ? keyLevelTotal / sampleSize : 0, highestKey,
      topComps, specs: specList, classes: classList, dungeons: dungeonList,
      diversity, lastSync: syncRows[0] || null
    });
  } catch (error) {
    res.status(503).json({ error: 'Could not load meta data. Import the schema and run npm run sync.', detail: error.message });
  }
});

const meleeSpecs = new Set(['Arms Warrior', 'Fury Warrior', 'Feral Druid', 'Enhancement Shaman', 'Windwalker Monk', 'Brewmaster Monk', 'Mistweaver Monk', 'Havoc Demon Hunter', 'Vengeance Demon Hunter', 'Devourer Demon Hunter', 'Subtlety Rogue', 'Outlaw Rogue', 'Assassination Rogue', 'Retribution Paladin', 'Blood Death Knight', 'Frost Death Knight', 'Unholy Death Knight', 'Survival Hunter']);
const knownWeeklySpecs = [
  'Blood Death Knight', 'Frost Death Knight', 'Unholy Death Knight', 'Havoc Demon Hunter', 'Vengeance Demon Hunter', 'Devourer Demon Hunter',
  'Balance Druid', 'Feral Druid', 'Guardian Druid', 'Restoration Druid', 'Augmentation Evoker', 'Devastation Evoker', 'Preservation Evoker',
  'Beast Mastery Hunter', 'Marksmanship Hunter', 'Survival Hunter', 'Arcane Mage', 'Fire Mage', 'Frost Mage', 'Brewmaster Monk',
  'Mistweaver Monk', 'Windwalker Monk', 'Holy Paladin', 'Protection Paladin', 'Retribution Paladin', 'Discipline Priest', 'Holy Priest',
  'Shadow Priest', 'Assassination Rogue', 'Outlaw Rogue', 'Subtlety Rogue', 'Elemental Shaman', 'Enhancement Shaman', 'Restoration Shaman',
  'Affliction Warlock', 'Demonology Warlock', 'Destruction Warlock', 'Arms Warrior', 'Fury Warrior', 'Protection Warrior'
];
const normalizeWeeklyRole = (value) => ['tank', 'healer'].includes(String(value).toLowerCase()) ? String(value).toLowerCase() : 'dps';
const weeklyRoleOrder = { tank: 0, healer: 1, dps: 2 };
const giniValue = (values) => {
  const sorted = [...values].map(Number).sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  if (!sum || sorted.length < 2) return 0;
  const weighted = sorted.reduce((total, value, index) => total + (2 * (index + 1) - sorted.length - 1) * value, 0);
  return Math.max(0, Math.min(1, weighted / (sorted.length * sum)));
};

async function getSeasonWeekNumbers(seasonId) {
  const [periods] = await pool.execute(
    `SELECT period_id, MIN(start_timestamp) AS start_timestamp
     FROM weekly_periods WHERE season_id = ? GROUP BY period_id
     ORDER BY MIN(start_timestamp), period_id`, [seasonId]
  );
  const firstPeriodId = seasonFirstMplusPeriod.get(Number(seasonId));
  const activeSeasonPeriods = firstPeriodId
    ? periods.filter((period) => Number(period.period_id) >= firstPeriodId)
    : periods;
  return new Map(activeSeasonPeriods.map((period, index) => [Number(period.period_id), index + 1]));
}

app.get('/api/meta/periods', async (req, res) => {
  try {
    const region = req.query.region || 'all';
    const params = region === 'all' ? [] : [region];
    const where = region === 'all' ? '' : 'WHERE p.region = ?';
    const [periods] = await pool.execute(
      `SELECT p.period_id, p.region, p.season_id, p.season_name, p.start_timestamp, p.end_timestamp,
        COUNT(r.id) AS run_count, COUNT(DISTINCT r.dungeon_id) AS dungeon_count
       FROM weekly_periods p LEFT JOIN weekly_leaderboard_runs r
         ON r.period_id = p.period_id AND r.region = p.region
       ${where} GROUP BY p.period_id, p.region, p.season_id, p.season_name, p.start_timestamp, p.end_timestamp
       ORDER BY p.start_timestamp DESC, p.period_id DESC`, params
    );
    const grouped = new Map();
    for (const row of periods) {
      const period = grouped.get(row.period_id) || {
        periodId: row.period_id, seasonId: row.season_id, season: row.season_name,
        start: Number(row.start_timestamp), end: Number(row.end_timestamp),
        regions: [], regionWindows: [], runCount: 0, dungeonCount: 0
      };
      period.regions.push(row.region);
      period.regionWindows.push({ region: row.region, start: Number(row.start_timestamp), end: Number(row.end_timestamp), runCount: Number(row.run_count) });
      period.runCount += Number(row.run_count);
      period.dungeonCount = Math.max(period.dungeonCount, Number(row.dungeon_count));
      period.start = Math.min(period.start, Number(row.start_timestamp));
      period.end = Math.max(period.end, Number(row.end_timestamp));
      grouped.set(row.period_id, period);
    }
    const weekNumbers = new Map();
    for (const seasonId of new Set([...grouped.values()].map((period) => Number(period.seasonId)))) {
      for (const [periodId, week] of await getSeasonWeekNumbers(seasonId)) weekNumbers.set(periodId, week);
    }
    for (const period of grouped.values()) {
      period.weekNumber = weekNumbers.get(Number(period.periodId)) || null;
      const firstMplusPeriod = seasonFirstMplusPeriod.get(Number(period.seasonId));
      period.offSeason = Boolean(firstMplusPeriod && Number(period.periodId) < firstMplusPeriod);
    }
    res.json([...grouped.values()]);
  } catch (error) {
    res.status(503).json({ error: 'Could not load weekly periods.', detail: error.message });
  }
});

app.get('/api/meta/period/:periodId', async (req, res) => {
  try {
    const periodId = Number(req.params.periodId);
    const region = req.query.region || 'all';
    const periodParams = region === 'all' ? [periodId] : [periodId, region];
    const periodWhere = region === 'all' ? 'period_id = ?' : 'period_id = ? AND region = ?';
    const [periodRows] = await pool.execute(`SELECT * FROM weekly_periods WHERE ${periodWhere} ORDER BY region`, periodParams);
    if (!periodRows.length) return res.status(404).json({ error: 'This weekly period has not been imported yet.' });
    const weekNumbers = await getSeasonWeekNumbers(Number(periodRows[0].season_id));
    const weekNumber = weekNumbers.get(periodId) || null;
    const runParams = region === 'all' ? [periodId] : [periodId, region];
    const runWhere = region === 'all' ? 'period_id = ?' : 'period_id = ? AND region = ?';
    const [runs] = await pool.execute(`SELECT region, dungeon_id, dungeon, ranking, level, score, completed_at, roster, payload FROM weekly_leaderboard_runs WHERE ${runWhere} ORDER BY score DESC, level DESC`, runParams);
    const comps = new Map(); const specs = new Map(); const levels = new Map(); const dungeons = new Map();
    let keySum = 0; let maxKey = 0;
    for (const run of runs) {
      const roster = typeof run.roster === 'string' ? JSON.parse(run.roster) : run.roster;
      const compMembers = roster.map((player) => ({ spec: player.spec || 'Unknown', class: player.class || 'Unknown', role: normalizeWeeklyRole(player.role) }))
        .sort((a, b) => ['tank', 'healer', 'dps'].indexOf(a.role) - ['tank', 'healer', 'dps'].indexOf(b.role) || a.class.localeCompare(b.class) || a.spec.localeCompare(b.spec));
      const compKey = compMembers.map((p) => `${p.spec} ${p.class}`).join('|');
      const comp = comps.get(compKey) || { composition: compMembers, count: 0, levelTotal: 0, maxLevel: 0 };
      comp.count += 1; comp.levelTotal += Number(run.level); comp.maxLevel = Math.max(comp.maxLevel, Number(run.level));
      comps.set(compKey, comp);
      const dungeonKey = normalizeDungeonName(run.dungeon);
      const dungeon = dungeons.get(dungeonKey) || { dungeon: run.dungeon, runs: 0, levelTotal: 0, maxLevel: 0, timedRuns: 0, clearTimeTotal: 0, remainingTimeTotalMs: 0, maxTimeRemainingMs: null, fastestRunLevel: null };
      dungeon.runs += 1; dungeon.levelTotal += Number(run.level); dungeon.maxLevel = Math.max(dungeon.maxLevel, Number(run.level));
      const runPayload = typeof run.payload === 'string' ? JSON.parse(run.payload) : run.payload;
      const clearTimeMs = Number(runPayload?.duration || runPayload?.clear_time_ms || runPayload?.clearTimeMs || 0);
      const timeLimitMs = dungeonTimersMs.get(dungeonKey) || null;
      if (clearTimeMs > 0) {
        dungeon.timedRuns += 1; dungeon.clearTimeTotal += clearTimeMs;
        if (timeLimitMs) {
          const remainingMs = timeLimitMs - clearTimeMs;
          dungeon.remainingTimeTotalMs += remainingMs;
          if (dungeon.maxTimeRemainingMs === null || remainingMs > dungeon.maxTimeRemainingMs) {
            dungeon.maxTimeRemainingMs = remainingMs;
            dungeon.fastestRunLevel = Number(run.level);
          }
        }
      }
      dungeon.timeLimitMs = timeLimitMs;
      dungeons.set(dungeonKey, dungeon);
      keySum += Number(run.level); maxKey = Math.max(maxKey, Number(run.level));
      const level = levels.get(run.level) || { level: Number(run.level), runs: 0, specs: new Map() };
      level.runs += 1;
      for (const player of roster) {
        const fullName = `${player.spec} ${player.class}`; const spec = specs.get(fullName) || { spec: player.spec, class: player.class, role: normalizeWeeklyRole(player.role), appearances: 0 };
        spec.appearances += 1; specs.set(fullName, spec);
        level.specs.set(fullName, (level.specs.get(fullName) || 0) + 1);
      }
      levels.set(run.level, level);
    }
    const totalSlots = runs.reduce((total, run) => total + (typeof run.roster === 'string' ? JSON.parse(run.roster) : run.roster).length, 0);
    const minEstablished = Math.max(50, Math.ceil(runs.length * 0.025));
    const topComps = calculateMetaRanking([...comps.values()].map((x) => ({
      composition: x.composition, count: x.count, averageLevel: x.count ? x.levelTotal / x.count : 0,
      maxLevel: x.maxLevel, share: runs.length ? x.count / runs.length * 100 : 0,
      established: x.count >= minEstablished
    })));
    const fastestHighestRun = runs.filter((run) => Number(run.level) === maxKey).map((run) => {
      const payload = typeof run.payload === 'string' ? JSON.parse(run.payload) : run.payload;
      const durationMs = Number(payload?.duration || payload?.clear_time_ms || payload?.clearTimeMs || 0);
      const timeLimitMs = dungeonTimersMs.get(normalizeDungeonName(run.dungeon)) || 0;
      const timeRemainingMs = timeLimitMs - durationMs;
      return { run, durationMs, timeLimitMs, timeRemainingMs,
        timeRemainingPct: timeLimitMs > 0 ? timeRemainingMs / timeLimitMs * 100 : null };
    }).filter((item) => item.durationMs > 0 && item.timeLimitMs > 0 && item.timeRemainingMs >= 0)
      .sort((a, b) => b.timeRemainingPct - a.timeRemainingPct || a.durationMs - b.durationMs)[0];
    const fastestHighestRunData = fastestHighestRun ? {
      dungeon: fastestHighestRun.run.dungeon,
      level: Number(fastestHighestRun.run.level),
      durationMs: fastestHighestRun.durationMs,
      timeLimitMs: fastestHighestRun.timeLimitMs,
      timeRemainingMs: fastestHighestRun.timeRemainingMs,
      timeRemainingPct: fastestHighestRun.timeRemainingPct,
      region: fastestHighestRun.run.region,
      composition: (typeof fastestHighestRun.run.roster === 'string' ? JSON.parse(fastestHighestRun.run.roster) : fastestHighestRun.run.roster)
        .map((player) => ({ spec: player.spec || 'Unknown', class: player.class || 'Unknown', role: normalizeWeeklyRole(player.role) }))
        .sort((a, b) => weeklyRoleOrder[a.role] - weeklyRoleOrder[b.role] || a.class.localeCompare(b.class) || a.spec.localeCompare(b.spec))
    } : null;
    const specList = [...specs.values()].map((spec) => ({ ...spec, pickRate: totalSlots ? spec.appearances / totalSlots * 100 : 0 })).sort((a, b) => b.appearances - a.appearances);
    const representation = { ranged: 0, melee: 0, tank: 0, healer: 0 };
    for (const spec of specList) {
      const key = `${spec.spec} ${spec.class}`;
      const group = spec.role === 'tank' ? 'tank' : spec.role === 'healer' ? 'healer' : meleeSpecs.has(key) ? 'melee' : 'ranged';
      representation[group] += spec.appearances;
    }
    for (const key of Object.keys(representation)) representation[key] = totalSlots ? representation[key] / totalSlots * 100 : 0;
    const diversity = [...levels.values()].sort((a, b) => a.level - b.level).map((level) => {
      const totalSlotsAtLevel = level.runs * 5;
      return {
        level: level.level, runs: level.runs,
        gini: giniValue(knownWeeklySpecs.map((key) => level.specs.get(key) || 0)),
        specs: knownWeeklySpecs.map((key) => ({ key, share: totalSlotsAtLevel ? (level.specs.get(key) || 0) / totalSlotsAtLevel * 100 : 0 }))
      };
    });
    const rawDungeons = [...dungeons.values()].map((dungeon) => ({
      ...dungeon,
      averageLevel: dungeon.runs ? dungeon.levelTotal / dungeon.runs : 0,
      averageClearTimeMs: dungeon.timedRuns ? dungeon.clearTimeTotal / dungeon.timedRuns : null
    }));
    const averageLevels = rawDungeons.map((dungeon) => dungeon.averageLevel);
    const remainingAverages = rawDungeons.filter((dungeon) => dungeon.timedRuns && dungeon.timeLimitMs).map((dungeon) => dungeon.remainingTimeTotalMs / dungeon.timedRuns / dungeon.timeLimitMs * 100);
    const minAverageLevel = Math.min(...averageLevels); const maxAverageLevel = Math.max(...averageLevels);
    const minRemaining = remainingAverages.length ? Math.min(...remainingAverages) : 0; const maxRemaining = remainingAverages.length ? Math.max(...remainingAverages) : 0;
    const dungeonList = rawDungeons.map((dungeon) => {
      const keyScore = maxAverageLevel === minAverageLevel ? 50 : (dungeon.averageLevel - minAverageLevel) / (maxAverageLevel - minAverageLevel) * 100;
      const avgRemainingPct = dungeon.timedRuns && dungeon.timeLimitMs ? dungeon.remainingTimeTotalMs / dungeon.timedRuns / dungeon.timeLimitMs * 100 : null;
      const timeScore = avgRemainingPct === null || maxRemaining === minRemaining ? null : (avgRemainingPct - minRemaining) / (maxRemaining - minRemaining) * 100;
      return { ...dungeon, averageTimeRemainingMs: dungeon.timedRuns && dungeon.timeLimitMs ? dungeon.remainingTimeTotalMs / dungeon.timedRuns : null,
        averageTimeRemainingPct: avgRemainingPct, easeScore: timeScore === null ? keyScore : (keyScore + timeScore) / 2 };
    }).sort((a, b) => b.easeScore - a.easeScore || b.runs - a.runs).map((dungeon, index) => ({ ...dungeon, easeRank: index + 1 }));
    const start = Math.min(...periodRows.map((item) => Number(item.start_timestamp)));
    const end = Math.max(...periodRows.map((item) => Number(item.end_timestamp)));
    const firstMplusPeriod = seasonFirstMplusPeriod.get(Number(periodRows[0].season_id));
    const offSeason = Boolean(firstMplusPeriod && periodId < firstMplusPeriod);
    res.json({ periodId, weekNumber, offSeason, regions: periodRows.map((item) => item.region),
      regionWindows: periodRows.map((item) => ({ region: item.region, start: Number(item.start_timestamp), end: Number(item.end_timestamp) })),
      season: periodRows[0].season_name, start, end,
      sampleSize: runs.length, totalCharacters: totalSlots, averageLevel: runs.length ? keySum / runs.length : 0, highestKey: maxKey,
      topComps, fastestHighestRun: fastestHighestRunData, specs: specList, representation, diversity, dungeons: dungeonList });
  } catch (error) {
    res.status(503).json({ error: 'Could not load weekly meta details.', detail: error.message });
  }
});

app.get('/api/meta/history', async (req, res) => {
  try {
    const region = req.query.region || 'all';
    const params = region === 'all' ? [] : [region];
    const where = region === 'all' ? '' : 'WHERE r.region = ?';
    const [rows] = await pool.execute(
      `SELECT p.period_id, p.region, p.season_name, p.start_timestamp, r.level, r.roster
       FROM weekly_periods p JOIN weekly_leaderboard_runs r ON r.period_id=p.period_id AND r.region=p.region
       ${where} ORDER BY p.start_timestamp`, params
    );
    const weeks = new Map();
    for (const row of rows) {
      const week = weeks.get(row.period_id) || { periodId: row.period_id, season: row.season_name, start: Number(row.start_timestamp), runs: 0, levelTotal: 0, highestKey: 0, specs: new Map() };
      week.runs += 1; week.levelTotal += Number(row.level); week.highestKey = Math.max(week.highestKey, Number(row.level));
      const roster = typeof row.roster === 'string' ? JSON.parse(row.roster) : row.roster;
      for (const player of roster) {
        const key = `${player.spec} ${player.class}`;
        week.specs.set(key, (week.specs.get(key) || 0) + 1);
      }
      weeks.set(row.period_id, week);
    }
    res.json([...weeks.values()].map((week) => {
      const total = week.runs * 5;
      return { periodId: week.periodId, season: week.season, start: week.start, runs: week.runs, highestKey: week.highestKey,
        averageLevel: week.runs ? week.levelTotal / week.runs : 0,
        diversity: giniValue(knownWeeklySpecs.map((key) => week.specs.get(key) || 0)),
        specs: knownWeeklySpecs.map((key) => ({ key, share: total ? (week.specs.get(key) || 0) / total * 100 : 0 })) };
    }));
  } catch (error) {
    res.status(503).json({ error: 'Could not load weekly history.', detail: error.message });
  }
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(port, '127.0.0.1', () => console.log(`MythicPlusMeta API listening at http://127.0.0.1:${port}`));
