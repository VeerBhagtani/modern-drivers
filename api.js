/* Dashboard → backend transport.
 *
 * Every call carries the admin token this product's own backend issued at
 * sign-in. window.DRIVERS_AUTH.getToken is installed by app.js.
 */
window.DRIVERS_API = (function () {
  'use strict';
  var CFG = window.DRIVERS_CONFIG || {};

  // Where the backend lives can be baked in at deploy time, or typed in once on
  // the sign-in screen and remembered in this browser. The second path matters:
  // the dashboard is one static site the office bookmarks, and it should start
  // working the moment the API is switched on, without anyone rebuilding and
  // republishing it.
  var STORE = 'md_api_base';
  function remembered() {
    try { return String(localStorage.getItem(STORE) || '').replace(/\/+$/, ''); } catch (e) { return ''; }
  }
  var BASE = String(CFG.API_BASE || '').replace(/\/+$/, '') || remembered();

  function setBase(url) {
    var v = String(url || '').trim().replace(/\/+$/, '');
    // https only: driver positions must never cross the network in the clear.
    if (v && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/.*)?$/.test(v)) {
      throw new Error('That does not look like an https:// address.');
    }
    BASE = v;
    api.base = v;
    try { if (v) localStorage.setItem(STORE, v); else localStorage.removeItem(STORE); } catch (e) { /* private window */ }
    return v;
  }

  function noBase() {
    return Promise.reject(new Error(
      'This dashboard does not know the server address yet. Enter it on the sign-in screen.',
    ));
  }

  function request(path, opts) {
    opts = opts || {};
    if (!BASE) return noBase();
    var auth = window.DRIVERS_AUTH;
    if (!auth || !auth.getToken) return Promise.reject(new Error('Not signed in.'));
    return auth.getToken().then(function (token) {
      return fetch(BASE + path, {
        method: opts.method || 'GET',
        headers: Object.assign(
          { Authorization: 'Bearer ' + token },
          opts.body ? { 'Content-Type': 'application/json' } : {},
        ),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    }).then(function (res) {
      var type = res.headers.get('content-type') || '';
      if (opts.raw) {
        if (!res.ok) throw new Error('Download failed (' + res.status + ')');
        return res.blob();
      }
      if (type.indexOf('application/json') === -1) {
        return res.text().then(function (t) {
          throw new Error(res.ok ? 'Unexpected response from the server.' : (t.slice(0, 200) || ('Request failed (' + res.status + ')')));
        });
      }
      return res.json().then(function (json) {
        // An expired or revoked token should land the operator back at the
        // sign-in screen rather than showing a wall of failed panels.
        if (res.status === 401 && window.DRIVERS_SIGNOUT) window.DRIVERS_SIGNOUT();
        if (!res.ok || json.success === false) {
          var err = new Error(json.message || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          err.code = json.code;
          throw err;
        }
        return json.data;
      });
    });
  }

  function qs(params) {
    var out = Object.keys(params || {})
      .filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); });
    return out.length ? '?' + out.join('&') : '';
  }

  // A report download goes through the same authenticated fetch and is handed
  // to the browser as a blob — a plain <a href> could not carry the token.
  function download(path, params, filename) {
    return request(path + qs(params), { raw: true }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    });
  }

  var D = '/admin';
  var api = {
    base: BASE,
    setBase: setBase,
    request: request,
    qs: qs,
    download: download,

    dashboard: function () { return request(D + '/dashboard'); },
    mapsConfig: function () { return request(D + '/maps-config'); },
    drivers: function (all) { return request(D + '/list' + (all ? '?all=1' : '')); },
    updateDriver: function (id, body) { return request(D + '/' + id, { method: 'PATCH', body: body }); },
    setDriverStatus: function (id, status) { return request(D + '/' + id + '/status', { method: 'POST', body: { status: status } }); },

    rides: function (params) { return request(D + '/rides' + qs(params)); },
    history: function (driverId, from, to) { return request(D + '/history' + qs({ driverId: driverId, from: from, to: to })); },
    ride: function (id, withPoints) { return request(D + '/rides/' + id + (withPoints ? '?points=1' : '')); },
    stopRide: function (id, reason, emergency, stoppedByName) {
      return request(D + '/rides/' + id + '/stop', { method: 'POST', body: { reason: reason, emergency: !!emergency, stoppedByName: stoppedByName } });
    },
    stopNames: function () { return request(D + '/stop-names'); },
    addStopName: function (name) { return request(D + '/stop-names', { method: 'POST', body: { name: name } }); },
    removeStopName: function (name) { return request(D + '/stop-names', { method: 'DELETE', body: { name: name } }); },
    processRide: function (id) { return request(D + '/rides/' + id + '/process', { method: 'POST', body: {} }); },
    processRange: function (body) { return request(D + '/process-range', { method: 'POST', body: body }); },

    places: function (kind) { return request(D + '/' + kind); },
    createPlace: function (kind, body) { return request(D + '/' + kind, { method: 'POST', body: body }); },
    updatePlace: function (kind, id, body) { return request(D + '/' + kind + '/' + id, { method: 'PATCH', body: body }); },
    importRestaurants: function (csv) { return request(D + '/restaurants/import', { method: 'POST', body: { csv: csv } }); },
    awaitingLocation: function () { return request(D + '/restaurants/awaiting-location'); },
    retryUnconfirmed: function () { return request(D + '/restaurants/retry-unconfirmed', { method: 'POST', body: {} }); },
    maintenance: function () { return request(D + '/maintenance'); },
    runAudit: function () { return request(D + '/maintenance/audit', { method: 'POST', body: {} }); },
    locationsLock: function () { return request(D + '/locations-lock'); },
    setLocationsLock: function (locked) { return request(D + '/locations-lock', { method: 'PUT', body: { locked: locked } }); },
    // run: undefined → check what is unchecked; true → start re-checking
    // everything; a number → carry on a re-check started at that server time.
    googleCheck: function (run) {
      var body = run === true ? { recheck: true } : typeof run === 'number' ? { recheckBefore: run } : {};
      return request(D + '/restaurants/google-check', { method: 'POST', body: body });
    },
    useGooglePin: function (id) {
      return request(D + '/restaurants/' + id + '/use-google-pin', { method: 'POST', body: {} });
    },
    setMobile: function (id, on) {
      return request(D + '/restaurants/' + id + '/mobile', { method: 'POST', body: { on: on } });
    },
    setHold: function (id, on, reason) {
      return request(D + '/restaurants/' + id + '/hold', { method: 'POST', body: { on: on, reason: reason } });
    },
    acceptCandidates: function (kind, limit) {
      return request(D + '/restaurants/accept-candidates', {
        method: 'POST', body: { kind: kind, limit: limit || 1000 },
      });
    },
    integrationSecrets: function () { return request(D + '/integration/secrets'); },
    setIntegrationSecret: function (alias, value) {
      return request(D + '/integration/secret', { method: 'PUT', body: { alias: alias, value: value } });
    },
    locateRestaurants: function (limit) { return request(D + '/restaurants/locate', { method: 'POST', body: { limit: limit || 100 } }); },
    confirmLocation: function (id, lat, lng) {
      return request(D + '/restaurants/' + id + '/confirm-location', { method: 'POST', body: { lat: lat, lng: lng } });
    },

    reviewQueue: function (params) { return request(D + '/review/queue' + qs(params)); },
    review: function (rideId, segmentId, toType, note) {
      return request(D + '/rides/' + rideId + '/segments/' + segmentId + '/review', { method: 'POST', body: { toType: toType, note: note } });
    },
    revertReview: function (reviewId) { return request(D + '/reviews/' + reviewId + '/revert', { method: 'POST', body: {} }); },

    report: function (name, params) { return request(D + '/reports/' + name + qs(params)); },
    orders: function (params) { return request(D + '/orders' + qs(params)); },
    importOrders: function (csv) { return request(D + '/orders/import', { method: 'POST', body: { csv: csv } }); },
    syncOrders: function (source, body) { return request(D + '/orders/sync/' + source, { method: 'POST', body: body || {} }); },
    sources: function () { return request(D + '/integration/sources'); },

    alerts: function (status) { return request(D + '/alerts' + qs({ status: status })); },
    resolveAlert: function (id, note) { return request(D + '/alerts/' + id + '/resolve', { method: 'POST', body: { note: note } }); },
    events: function (driverId) { return request(D + '/events' + qs({ driverId: driverId })); },
    audit: function () { return request(D + '/audit'); },
    config: function () { return request(D + '/config'); },
    saveConfig: function (overrides) { return request(D + '/config', { method: 'PUT', body: { overrides: overrides } }); },
    changePassword: function (currentPassword, newPassword) {
      return request(D + '/password', { method: 'POST', body: { currentPassword: currentPassword, newPassword: newPassword } });
    },
    runMaintenance: function (dryRunRetention) { return request(D + '/maintenance/run', { method: 'POST', body: { dryRunRetention: dryRunRetention !== false } }); },
  };
  return api;
})();
