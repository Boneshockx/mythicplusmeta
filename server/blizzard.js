const tokenEndpoint = 'https://oauth.battle.net/token';
let tokenCache = { value: '', expiresAt: 0 };

export async function getBlizzardToken() {
  if (tokenCache.value && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.value;
  const id = process.env.BLIZZARD_CLIENT_ID;
  const secret = process.env.BLIZZARD_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Set BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET in .env first.');
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error(`Blizzard OAuth returned HTTP ${response.status}.`);
  const body = await response.json();
  tokenCache = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 0) * 1000 };
  return tokenCache.value;
}

export async function blizzardData(region, pathname, locale = 'en_US') {
  const token = await getBlizzardToken();
  const url = new URL(`https://${region}.api.blizzard.com${pathname}`);
  url.searchParams.set('namespace', `dynamic-${region}`);
  url.searchParams.set('locale', locale);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (response.status === 404) return null;
  if (response.status === 429) throw new Error(`Blizzard rate limit reached for ${region}; retry the sync later.`);
  if (!response.ok) throw new Error(`Blizzard ${region} API returned HTTP ${response.status} for ${pathname}.`);
  return response.json();
}
