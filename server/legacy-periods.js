// Blizzard's Mythic Keystone season API starts after Legion. Raider.IO still
// exposes Legion seasons and run timestamps, so give those records stable IDs
// and reconstruct their weekly windows from each region's reset schedule.
const LEGACY_SEASON_ID_BASE = 2_000_000_000;
const LEGACY_PERIOD_ID_BASE = 2_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const RESET_SCHEDULES = {
  us: { timeZone: 'America/Los_Angeles', day: 2, hour: 8 },
  eu: { timeZone: 'Europe/Paris', day: 3, hour: 6 },
  kr: { timeZone: 'Asia/Seoul', day: 3, hour: 8 },
  tw: { timeZone: 'Asia/Taipei', day: 3, hour: 8 },
  cn: { timeZone: 'Asia/Shanghai', day: 3, hour: 8 }
};

export function legacySeasonId(expansionId, seasonNumber) {
  return LEGACY_SEASON_ID_BASE + expansionId * 100 + seasonNumber;
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday)
  };
}

function zonedLocalToUtc({ year, month, day, hour, minute }, timeZone) {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let result = localAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = localParts(new Date(result), timeZone);
    const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute);
    result = localAsUtc - (observedAsUtc - result);
  }
  return result;
}

export function legacyPeriodForRun(region, completedAt, seasonId, seasonName) {
  const schedule = RESET_SCHEDULES[region];
  const completed = typeof completedAt === 'number' ? completedAt : Date.parse(completedAt);
  if (!schedule || !Number.isFinite(completed)) return null;

  const local = localParts(new Date(completed), schedule.timeZone);
  let daysSinceReset = (local.weekday - schedule.day + 7) % 7;
  if (daysSinceReset === 0 && local.hour < schedule.hour) {
    daysSinceReset = 7;
  }
  const resetDate = new Date(Date.UTC(local.year, local.month - 1, local.day - daysSinceReset));
  const start = zonedLocalToUtc({
    year: resetDate.getUTCFullYear(), month: resetDate.getUTCMonth() + 1, day: resetDate.getUTCDate(),
    hour: schedule.hour, minute: 0
  }, schedule.timeZone);

  const nextDate = new Date(Date.UTC(resetDate.getUTCFullYear(), resetDate.getUTCMonth(), resetDate.getUTCDate() + 7));
  const end = zonedLocalToUtc({
    year: nextDate.getUTCFullYear(), month: nextDate.getUTCMonth() + 1, day: nextDate.getUTCDate(),
    hour: schedule.hour, minute: 0
  }, schedule.timeZone);

  // NA resets on Tuesday; the other regions reset on Wednesday. Use Wednesday
  // UTC as a common week key so equivalent regional windows share one period ID.
  const canonicalDate = new Date(Date.UTC(
    resetDate.getUTCFullYear(), resetDate.getUTCMonth(), resetDate.getUTCDate() + (region === 'us' ? 1 : 0)
  ));
  const weekOrdinal = Math.floor(canonicalDate.getTime() / WEEK_MS);
  return {
    id: LEGACY_PERIOD_ID_BASE + weekOrdinal,
    seasonId,
    seasonName,
    start,
    end
  };
}
