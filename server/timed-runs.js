function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function milliseconds(value, unit = 'ms') {
  if (typeof value === 'string' && /^\d+:\d{2}(?:\.\d+)?$/.test(value.trim())) {
    const [minutes, seconds] = value.trim().split(':').map(Number);
    return Math.round((minutes * 60 + seconds) * 1000);
  }
  const number = positiveNumber(value);
  if (!number) return null;
  if (unit === 'seconds') return Math.round(number * 1000);
  // API clear durations are milliseconds; values below a day are seconds.
  return number < 86_400 ? Math.round(number * 1000) : Math.round(number);
}

export function dungeonTimeLimitMs(dungeon) {
  if (!dungeon || typeof dungeon !== 'object') return null;
  for (const key of ['time_limit_ms', 'keystone_time_ms', 'keystone_time_limit_ms']) {
    const value = milliseconds(dungeon[key]);
    if (value) return value;
  }
  for (const key of ['time_limit_seconds', 'keystone_time_limit_seconds']) {
    const value = milliseconds(dungeon[key], 'seconds');
    if (value) return value;
  }
  for (const key of ['time_limit', 'keystone_time_limit']) {
    const value = milliseconds(dungeon[key]);
    if (value) return value;
  }
  return null;
}

export function isTimedRun(run) {
  const value = run?.run || run || {};
  const explicit = explicitTimedStatus(value);
  if (explicit !== null) return explicit;
  const clearTime = value.clear_time_ms ?? value.clearTimeMs ?? value.duration_ms ?? value.duration;
  const limit = value.keystone_time_ms ?? value.keystone_time_limit_ms ?? value.time_limit_ms ?? value.par_time_ms;
  const clearMs = milliseconds(clearTime);
  const limitMs = milliseconds(limit);
  return Boolean(clearMs && limitMs && clearMs <= limitMs);
}

function explicitTimedStatus(value) {
  for (const key of ['timed', 'is_timed', 'isTimed']) {
    if (typeof value[key] === 'boolean') return value[key];
  }
  for (const key of ['num_chests', 'num_keystone_upgrades', 'keystone_upgrades']) {
    if (value[key] !== undefined && value[key] !== null) return Number(value[key]) > 0;
  }
  const remaining = value.time_remaining_ms ?? value.time_left_ms;
  if (remaining !== undefined && remaining !== null) return Number(remaining) >= 0;
  return null;
}

export function isTimedLeaderboardGroup(group, timeLimitMs) {
  const explicit = explicitTimedStatus(group || {});
  if (explicit !== null) return explicit;
  const duration = milliseconds(group?.duration ?? group?.clear_time_ms ?? group?.clearTimeMs);
  const limit = positiveNumber(timeLimitMs);
  return Boolean(duration && limit && duration <= limit);
}
