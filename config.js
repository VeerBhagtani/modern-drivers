/* Modern Drivers dashboard — environment config.
 *
 * API_BASE is the only value that differs between environments, and the deploy
 * writes it in. There is no Firebase config here and no Google sign-in: this
 * product has its own accounts, held by its own backend, so setting it up means
 * creating one admin user and nothing else.
 *
 * MAP_STYLE is the single map-provider reference in the whole dashboard.
 */
window.DRIVERS_CONFIG = {
  API_BASE: 'https://modern-drivers-795895369854.asia-south1.run.app',   // e.g. 'https://modern-drivers-api-xxxxx.a.run.app' — set at deploy time

  MAP_STYLE: 'https://tiles.openfreemap.org/styles/liberty',
  MAP_WORKER: 'vendor/maplibre/maplibre-gl-csp-worker.js',
  // Pune. Only the opening view, before any driver is plotted.
  MAP_CENTER: [73.8567, 18.5204],

  // Fallback only. The real value arrives from the server on every dashboard
  // load, so the two can never disagree about what "stale" means.
  STALE_AFTER_SEC: 180,
  REFRESH_SEC: 20,
};
