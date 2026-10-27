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

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`Blizzard ${region} request failed for ${pathname} after ${attempt} attempts: ${error.message}`);
      }
      const delay = Math.min(30_000, 1000 * (2 ** (attempt - 1)));
      console.warn(`[blizzard] ${region.toUpperCase()} ${pathname}: network error (${error.message}); retrying in ${delay / 1000}s (attempt ${attempt}/${maxAttempts}).`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    if (response.status === 404) return null;
    if (!response.ok) {
      const transient = response.status === 429 || response.status >= 500;
      if (!transient || attempt === maxAttempts) {
        throw new Error(`Blizzard ${region} API returned HTTP ${response.status} for ${pathname}${transient ? ` after ${attempt} attempts` : ''}.`);
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30_000, 1000 * (2 ** (attempt - 1)));
      console.warn(`[blizzard] ${region.toUpperCase()} ${pathname}: HTTP ${response.status}; retrying in ${Math.ceil(delay / 1000)}s (attempt ${attempt}/${maxAttempts}).`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    return response.json();
  }
  throw new Error(`Blizzard ${region} request did not complete for ${pathname}.`);
}
