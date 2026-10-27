const port = Number(process.env.PORT || 3000);
const baseUrl = (process.env.APP_INTERNAL_URL || `http://127.0.0.1:${port}`).replace(/\/$/, '');

export async function refreshPageCaches() {
  console.log('[page-cache] Asking the running app to rebuild its dashboard, periods, and history caches.');
  try {
    const response = await fetch(`${baseUrl}/api/internal/refresh-page-cache`, { method: 'POST' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    const refreshed = Object.values(result).filter(Boolean).length;
    console.log(`[page-cache] Rebuilt ${refreshed}/3 page caches.`);
  } catch (error) {
    console.warn(`[page-cache] Refresh skipped (${error.message}). The app will calculate data on its next request.`);
  }
}
