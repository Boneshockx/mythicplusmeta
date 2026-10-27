const API_ROOT = 'https://raider.io/api/v1';

async function fetchJson(url) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (response.status === 429) {
      const waitSeconds = Math.max(1, Number(response.headers.get('retry-after') || 60));
      if (attempt === 6) throw new Error(`Raider.IO rate limit persisted after ${attempt} attempts.`);
      console.warn(`Raider.IO rate limit reached; retrying in ${waitSeconds}s (attempt ${attempt}/6).`);
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      continue;
    }
    if (!response.ok) throw new Error(`Raider.IO returned HTTP ${response.status}.`);
    return response.json();
  }
  throw new Error('Raider.IO request did not complete.');
}

export async function getRegionPeriods() {
  return fetchJson(`${API_ROOT}/periods`);
}

export async function getMythicPlusStaticData(expansionId) {
  const url = new URL(`${API_ROOT}/mythic-plus/static-data`);
  url.searchParams.set('expansion_id', String(expansionId));
  if (process.env.RIO_API_KEY) url.searchParams.set('access_key', process.env.RIO_API_KEY);
  return fetchJson(url);
}

export async function getTopRuns({ region, season, dungeon = 'all', page = 0 }) {
  const url = new URL(`${API_ROOT}/mythic-plus/runs`);
  url.searchParams.set('region', region);
  url.searchParams.set('dungeon', dungeon);
  url.searchParams.set('page', String(page));
  if (process.env.RIO_API_KEY) url.searchParams.set('access_key', process.env.RIO_API_KEY);
  // Omitting season asks Raider.IO for its current season. The literal word
  // "current" is only our local label and isn't sent as a season slug.
  if (season && season !== 'current') url.searchParams.set('season', season);

  // Raider.IO's public endpoint works without a key. Keep the app key in env;
  // don't guess an authentication format or expose it in browser requests.
  const body = await fetchJson(url);
  if (Array.isArray(body)) return body;
  return body.rankings || body.runs || body.data || body.results || [];
}

export function normalizeRun(entry, region, season) {
  const run = entry.run || entry;
  const roster = run.roster || run.team || run.members || run.characters || [];
  const normalizedRoster = (Array.isArray(roster) ? roster : []).map((member) => {
    const character = member.character || member;
    const spec = member.spec || character.spec || member.specialization || {};
    const classInfo = member.class || character.class || member.character_class || {};
    return {
      name: character.name || member.name || 'Unknown',
      realm: character.realm?.name || character.realm || member.realm || '',
      spec: typeof spec === 'string' ? spec : spec.name || spec.slug || 'Unknown',
      class: typeof classInfo === 'string' ? classInfo : classInfo.name || classInfo.slug || 'Unknown',
      role: member.role || spec.role || null
    };
  });

  const dungeonValue = run.dungeon || run.keystone?.dungeon || run.map || {};
  const dungeon = typeof dungeonValue === 'string'
    ? dungeonValue
    : dungeonValue.name || dungeonValue.slug || 'Unknown dungeon';
  const runId = run.id ?? run.run_id ?? run.keystone_run_id ?? run.keystone?.id;
  if (runId == null || normalizedRoster.length === 0) return null;

  return {
    sourceRunId: String(runId),
    region,
    season,
    dungeon,
    level: Number(run.mythic_level ?? run.level ?? run.keystone_level ?? run.keystone?.level) || null,
    completedAt: run.completed_at || run.completedAt || run.date || null,
    score: Number(entry.score ?? run.score ?? run.mythic_plus_score) || null,
    roster: normalizedRoster,
    payload: run
  };
}
