/* Dashboard views.
 *
 * Plain DOM rendering, one function per tab. No framework: the whole dashboard
 * is seven screens over one REST API, and a build step would cost more than it
 * saves for the people who will maintain this.
 *
 * House rule that shows up everywhere below: a number the system is not sure
 * about is displayed next to the reason it is not sure, never on its own.
 */
window.DRIVERS_VIEWS = (function () {
  'use strict';
  var API = window.DRIVERS_API;
  var MAPS = window.DRIVERS_MAP;
  var esc = MAPS.esc;

  var state = {
    tab: 'fleet',
    dashboard: null,
    staleAfterSec: (window.DRIVERS_CONFIG || {}).STALE_AFTER_SEC || 180,
    filterText: '',
    filterStatus: 'all',
    map: null,
    markers: {},
    replay: null,
    tracksMap: null,
    restaurants: null,
    currentRide: null,
  };

  var TABS = [
    ['fleet', 'Live fleet'],
    ['drivers', 'Drivers'],
    // One row per driver per day. Rides close with their day, so a ride is a
    // day, and this is where a day's kilometres are looked up afterwards.
    ['history', 'History'],
    ['review', 'Review'],
    // Two tabs, because they are two jobs. Restaurants is the daily one —
    // find a customer, stop or start their supply. Locations is the setup
    // one — upload the spreadsheet, get everything pinned. Mixing them is
    // what made this screen unusable the first time.
    ['restaurants', 'Restaurants'],
    ['places', 'Locations'],
    ['orders', 'Deliveries'],
    ['reports', 'Reports'],
    ['alerts', 'Alerts'],
    ['maintenance', 'Maintenance'],
    ['settings', 'Settings'],
  ];

  // ── helpers ────────────────────────────────────────────────────────────
  var view = function () { return document.getElementById('view'); };
  function set(html) { view().innerHTML = html; }
  function on(sel, evt, fn, root) {
    (root || view()).querySelectorAll(sel).forEach(function (el) { el.addEventListener(evt, fn); });
  }
  function ago(sec) {
    if (sec == null) return '—';
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.round(sec / 60) + ' min';
    return Math.round(sec / 36) / 100 + ' h';
  }
  function time(ms) { return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'; }
  function dateTime(ms) { return ms ? new Date(ms).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function km(v) { return v == null ? '—' : v.toFixed(1) + ' km'; }
  function dayStartMs(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
  function todayISO() { return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

  function spinner(msg) { return '<p class="muted">' + esc(msg || 'Loading…') + '</p>'; }
  function errBox(e) { return '<div class="card"><p class="err">' + esc(e.message || String(e)) + '</p></div>'; }

  function modal(html) {
    document.getElementById('modal').innerHTML = html;
    document.getElementById('modalBg').classList.add('on');
  }
  function closeModal() { document.getElementById('modalBg').classList.remove('on'); }
  document.getElementById('modalBg').addEventListener('click', function (e) {
    if (e.target.id === 'modalBg') closeModal();
  });

  // ── tabs ───────────────────────────────────────────────────────────────
  function renderTabs() {
    document.getElementById('tabs').innerHTML = TABS.map(function (t) {
      return '<button data-tab="' + t[0] + '" class="' + (state.tab === t[0] ? 'on' : '') + '">' + esc(t[1]) + '</button>';
    }).join('');
    on('[data-tab]', 'click', function (e) { go(e.currentTarget.dataset.tab); }, document.getElementById('tabs'));
  }

  function go(tab) {
    state.tab = tab;
    // Every map object belongs to a DOM node that is about to be replaced.
    // Keeping a reference would leave the next render talking to a container
    // that is no longer on the page.
    state.map = null; state.markers = {}; state.replay = null; state.tracksMap = null; state.wrongMap = null;
    renderTabs();
    render();
  }

  function render() {
    var fn = ({
      fleet: renderFleet, drivers: renderDrivers, history: renderHistory, review: renderReview,
      restaurants: renderRestaurants, places: renderPlaces,
      orders: renderOrders, reports: renderReports, alerts: renderAlerts,
      maintenance: renderMaintenance, settings: renderSettings,
    })[state.tab];
    set(spinner());
    fn().catch(function (e) { set(errBox(e)); });
  }

  // ── Live fleet ─────────────────────────────────────────────────────────
  function renderFleet() {
    // The restaurants come along for the ride so the live map shows the
    // customers as well as the drivers. Seeing a driver adrift in an area with
    // no customers in it is the single most useful thing this map can tell the
    // office, and it cannot say it without the pins. A failure to load them
    // must not take the fleet map down with it.
    return Promise.all([
      API.dashboard(),
      API.places('restaurants').catch(function () { return []; }),
      API.places('facilities').catch(function () { return []; }),
    ]).then(function (r) {
      var d = r[0];
      var restaurants = r[1];
      var facilities = r[2];
      state.dashboard = d;
      state.staleAfterSec = d.staleAfterSec;
      var m = d.metrics;
      set(''
        + '<div class="grid metrics" style="margin-bottom:14px">'
        + metric(m.activeDrivers, 'Drivers on a ride', 'ok')
        + metric(m.completedRides, 'Rides finished today')
        + metric(km(m.totalKm), 'Total tracked today')
        + metric(km(m.businessKm), 'Business today', 'ok')
        + metric(km(m.personalKm), 'Personal today')
        + metric(km(m.unknownKm), 'Unknown — needs review', m.unknownKm > 0 ? 'warn' : '')
        + metric(m.trackingIssues, 'Tracking problems', m.trackingIssues ? 'bad' : '')
        + metric(m.openAlerts, 'Open alerts', m.openAlerts ? 'warn' : '')
        + metric(m.unprocessedRides, 'Rides not calculated', m.unprocessedRides ? 'warn' : '')
        + '</div>'
        + (m.unprocessedRides
          ? '<div class="banner">' + m.unprocessedRides + ' finished ride(s) today have not been calculated yet, so their kilometres are not in the totals above. They are processed automatically, or you can run it now from Settings.</div>'
          : '')
        + '<div class="split">'
        + '  <div class="card">'
        + '    <h2>Drivers</h2>'
        + '    <div class="bar">'
        + '      <div style="flex:1"><input id="fFilter" placeholder="Search name or driver ID" value="' + esc(state.filterText) + '"></div>'
        + '      <div><select id="fStatus">'
        + ['all', 'active', 'finished', 'not_started'].map(function (s) {
          return '<option value="' + s + '"' + (state.filterStatus === s ? ' selected' : '') + '>' + esc({ all: 'All', active: 'On a ride', finished: 'Finished today', not_started: 'Not started' }[s]) + '</option>';
        }).join('') + '</select></div>'
        + '    </div>'
        + '    <div style="overflow-x:auto">' + fleetTable(d.drivers) + '</div>'
        + '    <p class="tiny" style="margin-top:10px">A position is called <b>live</b> only if it arrived in the last ' + d.staleAfterSec + ' seconds. Anything older is labelled <b>last known</b>.</p>'
        + '  </div>'
        + '  <div class="card">'
        + '    <h2>Live map</h2>'
        // Three thousand identical red dots is not something you can find a
        // restaurant in by looking. Typing its name flies the map to it and
        // opens it.
        + '    <div style="position:relative;margin-bottom:10px">'
        + '      <input id="mapFind" placeholder="Find a restaurant on the map" autocomplete="off">'
        + '      <div id="mapFindHits" class="findhits" hidden></div>'
        + '    </div>'
        + '    <div id="map"></div>'
        + '    <div class="legend">'
        + '      <span><i style="background:#1a7a4c"></i>Live</span>'
        + '      <span><i style="background:#8a5f14"></i>Last known (stale)</span>'
        + '      <span><i style="background:#98a2b3"></i>No position</span>'
        + '      <span><i style="background:#D7262F"></i>Restaurant (' + restaurants.filter(hasPin).length + ')</span>'
        + '      <span><i style="background:#1B2A6B"></i>Depot</span>'
        + '    </div>'
        + '  </div>'
        + '</div>');

      document.getElementById('fFilter').addEventListener('input', function (e) {
        state.filterText = e.target.value;
        document.querySelector('#view .split .card div[style*="overflow-x"]').innerHTML = fleetTable(state.dashboard.drivers);
        bindFleetRows();
      });
      document.getElementById('fStatus').addEventListener('change', function (e) {
        state.filterStatus = e.target.value;
        document.querySelector('#view .split .card div[style*="overflow-x"]').innerHTML = fleetTable(state.dashboard.drivers);
        bindFleetRows();
      });
      bindFleetRows();

      state.map = MAPS.create('map');
      state.markers = {};
      if (state.map) {
        var handle = state.map;
        handle.ready(function () {
          if (state.map !== handle) return;   // the tab changed while loading
          // Customers first, drivers on top: a driver must never be hidden
          // under a restaurant pin.
          var byId = {};
          restaurants.forEach(function (p) { byId[p.id] = p; });
          MAPS.drawPlaces(handle, 'restaurants',
            restaurants.filter(function (x) { return x.active !== false && hasPin(x); }), '#D7262F',
            function (id) { if (byId[id]) restaurantModal(byId[id]); });
          MAPS.drawPlaces(handle, 'facilities', facilities.filter(hasPin), '#1B2A6B');
          MAPS.syncMarkers({ map: handle, markers: state.markers }, (state.dashboard || d).drivers, openDriver);
          MAPS.fit(handle, d.drivers.filter(function (x) { return x.lastLocation; }).map(function (x) { return x.lastLocation; }));
          mapProviderNote('map', handle);
        });
        bindMapFind(restaurants);
      }
      scheduleRefresh();
    });
  }

  /* Finding one restaurant among three thousand identical dots.
   *
   * Searches the restaurants already loaded for the map, so it is instant and
   * costs nothing. Picking one flies the map there and opens its card, which
   * is the same card the pin itself opens.
   */
  function bindMapFind(restaurants) {
    var input = document.getElementById('mapFind');
    var hits = document.getElementById('mapFindHits');
    if (!input || !hits) return;

    function close() { hits.hidden = true; hits.innerHTML = ''; }

    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      if (q.length < 2) { close(); return; }
      var found = restaurants.filter(function (p) {
        return hasPin(p) && ((p.name || '') + ' ' + (p.area || '')).toLowerCase().indexOf(q) !== -1;
      }).slice(0, 8);

      hits.hidden = false;
      hits.innerHTML = found.length
        ? found.map(function (p) {
          return '<button type="button" data-find="' + esc(p.id) + '">'
            + '<b>' + esc(p.name) + '</b>'
            + (p.area ? '<span>' + esc(p.area) + '</span>' : '')
            + (p.supplyHold === true ? '<span style="color:var(--bad)">supply on hold</span>' : '')
            + '</button>';
        }).join('')
        : '<div class="tiny" style="padding:10px 12px">Nothing on the map matches. '
          + 'A restaurant with no location yet will not be here.</div>';

      hits.querySelectorAll('[data-find]').forEach(function (b) {
        b.addEventListener('click', function () {
          var p = restaurants.find(function (x) { return x.id === b.getAttribute('data-find'); });
          if (!p) return;
          close();
          input.value = p.name;
          if (state.map) state.map.flyTo({ lat: p.lat, lng: p.lng }, 16);
          restaurantModal(p);
        });
      });
    });

    input.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    document.addEventListener('click', function (e) {
      if (e.target !== input && !hits.contains(e.target)) close();
    });
  }

  function metric(v, label, cls) {
    return '<div class="metric ' + (cls || '') + '"><div class="v">' + esc(String(v)) + '</div><div class="l">' + esc(label) + '</div></div>';
  }

  function filteredDrivers(rows) {
    var q = state.filterText.trim().toLowerCase();
    return rows.filter(function (r) {
      if (state.filterStatus !== 'all' && r.rideStatus !== state.filterStatus) return false;
      if (!q) return true;
      return (r.name || '').toLowerCase().indexOf(q) !== -1 || (r.driverCode || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  function fleetTable(rows) {
    var list = filteredDrivers(rows);
    if (!list.length) return '<p class="muted">No drivers match.</p>';
    return '<table><thead><tr>'
      + '<th>Driver</th><th>Ride</th><th>Position</th><th>Updated</th><th>Health</th><th>Today</th>'
      + '</tr></thead><tbody>'
      + list.map(function (r) {
        var today = !r.today.calculated
          ? '<span class="tiny">not calculated</span>'
          : km(r.today.totalKm) + '<br><span class="tiny">' + km(r.today.businessKm) + ' business · ' + km(r.today.personalKm) + ' personal'
            + (r.today.unknownKm ? ' · ' + km(r.today.unknownKm) + ' undecided' : '') + '</span>';
        return '<tr class="click" data-driver="' + esc(r.driverId) + '" data-ride="' + esc(r.rideId || '') + '">'
          + '<td><b>' + esc(r.name) + '</b><br><span class="tiny">' + esc(r.driverCode) + (r.status !== 'active' ? ' · inactive' : '') + '</span></td>'
          + '<td><span class="pill ' + esc(r.rideStatus === 'active' ? 'active' : 'idle') + '">' + esc(r.rideStatus.replace('_', ' ')) + '</span>'
          + (r.rideStartedAt ? '<br><span class="tiny">from ' + time(r.rideStartedAt) + '</span>' : '') + '</td>'
          + '<td><span class="pill ' + esc(r.locationState) + '">' + esc(r.locationState === 'live' ? 'live' : r.locationState === 'stale' ? 'last known' : 'none') + '</span></td>'
          + '<td>' + esc(ago(r.lastUpdateAgeSec)) + '</td>'
          + '<td><span class="pill ' + esc(r.trackingHealth) + '">' + esc(r.trackingHealth.replace('_', ' ')) + '</span></td>'
          + '<td>' + today + '</td>'
          + '</tr>';
      }).join('')
      + '</tbody></table>';
  }

  function bindFleetRows() {
    on('tr[data-driver]', 'click', function (e) {
      var row = state.dashboard.drivers.find(function (d) { return d.driverId === e.currentTarget.dataset.driver; });
      if (row) openDriver(row);
    });
  }

  var refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      if (state.tab !== 'fleet' || !state.map) return;
      API.dashboard().then(function (d) {
        state.dashboard = d;
        MAPS.syncMarkers({ map: state.map, markers: state.markers }, d.drivers, openDriver);
        var holder = document.querySelector('#view .split .card div[style*="overflow-x"]');
        if (holder) { holder.innerHTML = fleetTable(d.drivers); bindFleetRows(); }
        scheduleRefresh();
      }).catch(scheduleRefresh);
    }, ((window.DRIVERS_CONFIG || {}).REFRESH_SEC || 20) * 1000);
  }

  // ── Driver / ride detail ───────────────────────────────────────────────
  function openDriver(row) {
    modal(spinner('Loading ' + esc(row.name) + '…'));
    var params = { driverId: row.driverId, from: dayStartMs(new Date()) - 13 * 864e5 };
    API.rides(params).then(function (rides) {
      var html = '<h3 style="margin:0 0 4px">' + esc(row.name) + '</h3>'
        + '<p class="tiny" style="margin:0 0 14px">' + esc(row.driverCode) + '</p>';
      if (row.rideStatus === 'active') {
        html += '<div class="card" style="margin-bottom:12px"><h2>Active ride</h2>'
          + '<p class="muted">Started ' + dateTime(row.rideStartedAt) + ' · last position ' + esc(ago(row.lastUpdateAgeSec)) + ' ago'
          + ' (<b>' + esc(row.locationState === 'live' ? 'live' : 'last known, NOT live') + '</b>)</p>'
          + '<button class="btn-danger btn-sm" id="btnStop">Stop this ride</button> '
          + '<button class="btn-outline btn-sm" id="btnEmergency">Emergency stop</button>'
          + '<p class="tiny" style="margin-top:8px">The driver cannot stop a ride from the app. Every stop records who did it, when, and why.</p>'
          + '</div>';
      }
      html += '<div class="card"><h2>Rides — last 14 days</h2>'
        + (rides.length ? '<table><thead><tr><th>Day</th><th>Started</th><th>Ended</th><th>Status</th><th>Points</th><th></th></tr></thead><tbody>'
          + rides.map(function (r) {
            return '<tr><td>' + esc(r.dayKey) + '</td><td>' + time(r.startedAt) + '</td><td>' + time(r.stoppedAt) + '</td>'
              + '<td><span class="pill ' + (r.status === 'active' ? 'active' : 'idle') + '">' + esc(r.status) + '</span>'
              + (r.stopReason ? '<br><span class="tiny">' + esc(r.stopReason) + '</span>' : '') + '</td>'
              + '<td>' + (r.pointCount || 0) + '</td>'
              + '<td><button class="btn-outline btn-sm" data-openride="' + esc(r.id) + '">Open</button></td></tr>';
          }).join('') + '</tbody></table>'
          : '<p class="muted">No rides recorded in this period.</p>')
        + '</div>'
        + '<button class="btn-outline" id="btnCloseModal" style="margin-top:12px">Close</button>';
      modal(html);
      var root = document.getElementById('modal');
      on('#btnCloseModal', 'click', closeModal, root);
      on('[data-openride]', 'click', function (e) { openRide(e.currentTarget.dataset.openride); }, root);
      on('#btnStop', 'click', function () { promptStop(row.rideId, false); }, root);
      on('#btnEmergency', 'click', function () { promptStop(row.rideId, true); }, root);
    }).catch(function (e) { modal(errBox(e) + '<button class="btn-outline" onclick="document.getElementById(\'modalBg\').classList.remove(\'on\')">Close</button>'); });
  }

  // The reason nearly every ride is stopped for. Tab in the empty reason box
  // fills it in, and on a phone — no Tab key — the chip under it does.
  var USUAL_STOP_REASON = 'End of shift — driver returned to Modern Dairy';
  var LAST_STOPPER = 'md_last_stopper';

  function promptStop(rideId, emergency) {
    modal('<h3>' + (emergency ? 'Emergency stop' : 'Stop this ride') + '</h3>'
      + '<p class="muted">The reason and who stopped it are recorded in the audit log. Both are required.</p>'
      + '<div class="field"><label for="stopReason">Reason</label>'
      + '<input id="stopReason" placeholder="' + esc(USUAL_STOP_REASON) + '" autocomplete="off">'
      + '<p class="tiny" style="margin:6px 0 0">Press <b>Tab</b> for the usual reason, or '
      + '<button type="button" class="link-sm" id="stopUsual">' + esc(USUAL_STOP_REASON) + '</button></p></div>'
      + '<div class="field"><label for="stopBy">Stopped by</label>'
      + '<select id="stopBy"><option value="">Loading names…</option></select></div>'
      + '<p id="stopErr" class="err" hidden></p>'
      + '<button class="' + (emergency ? 'btn-danger' : 'btn-primary') + '" id="stopGo">' + (emergency ? 'Emergency stop' : 'Stop ride') + '</button> '
      + '<button class="btn-outline" id="stopCancel">Cancel</button>');
    var root = document.getElementById('modal');
    var reasonEl = document.getElementById('stopReason');
    var byEl = document.getElementById('stopBy');
    var err = document.getElementById('stopErr');
    var showErr = function (m) { err.textContent = m; err.hidden = false; };
    var ADD = '__add__';

    // Tab in an empty box takes the usual reason, and then moves on to the
    // next field as Tab normally does.
    reasonEl.addEventListener('keydown', function (e) {
      if (e.key === 'Tab' && !e.shiftKey && !reasonEl.value.trim()) reasonEl.value = USUAL_STOP_REASON;
    });
    on('#stopUsual', 'click', function () { reasonEl.value = USUAL_STOP_REASON; byEl.focus(); }, root);

    var remembered = '';
    try { remembered = localStorage.getItem(LAST_STOPPER) || ''; } catch (e) { /* private window */ }
    var fill = function (names, pick) {
      byEl.innerHTML = '<option value="">— choose a name —</option>'
        + names.map(function (n) {
          return '<option value="' + esc(n) + '"' + (n === pick ? ' selected' : '') + '>' + esc(n) + '</option>';
        }).join('')
        + '<option value="' + ADD + '">+ Add a name…</option>';
    };
    API.stopNames().then(function (d) {
      fill(d.names, d.names.indexOf(remembered) !== -1 ? remembered : '');
      if (!d.names.length) {
        showErr('No names yet. Choose "+ Add a name…" to add the people who stop rides.');
      }
    }).catch(function (e) { showErr(e.message); });

    byEl.addEventListener('change', function () {
      if (byEl.value !== ADD) return;
      var name = prompt('Name of the person stopping rides:');
      if (!name || !name.trim()) { byEl.value = ''; return; }
      API.addStopName(name.trim()).then(function (d) {
        var added = d.names.find(function (n) { return n.toLowerCase() === name.trim().toLowerCase(); }) || '';
        fill(d.names, added);
        err.hidden = true;
      }).catch(function (e) { byEl.value = ''; showErr(e.message); });
    });

    on('#stopCancel', 'click', closeModal, root);
    on('#stopGo', 'click', function () {
      var reason = reasonEl.value.trim();
      var by = byEl.value;
      err.hidden = true;
      if (reason.length < 3) { showErr('Please give a reason.'); return; }
      if (!by || by === ADD) { showErr('Choose who is stopping this ride.'); return; }
      try { localStorage.setItem(LAST_STOPPER, by); } catch (e) { /* private window */ }
      document.getElementById('stopGo').disabled = true;
      API.stopRide(rideId, reason, emergency, by).then(function () { closeModal(); render(); })
        .catch(function (e) { showErr(e.message); document.getElementById('stopGo').disabled = false; });
    }, root);
    reasonEl.focus();
  }


  // Full ride view: distances with their provenance, the segment list with
  // evidence, and the replay map drawn from the RAW points.
  function openRide(rideId) {
    modal(spinner('Loading ride…'));
    Promise.all([API.ride(rideId, true), API.places('restaurants'), API.places('facilities')]).then(function (r) {
      var data = r[0];
      var restaurants = r[1];
      var facilities = r[2];
      state.currentRide = data;
      var p = data.processing;
      var d = p && p.distance;

      var html = '<h3 style="margin:0 0 2px">' + esc(data.ride.driverName || data.ride.driverId) + ' — ' + esc(data.ride.dayKey) + '</h3>'
        + '<p class="tiny" style="margin:0 0 12px">' + dateTime(data.ride.startedAt) + ' → ' + (data.ride.stoppedAt ? dateTime(data.ride.stoppedAt) : 'still running')
        + (data.ride.stoppedByName ? ' · stopped by ' + esc(data.ride.stoppedByName) : '')
        + (data.ride.stopKind === 'day_end' ? ' · closed at the end of the day' : '')
        + ' · ' + (data.ride.pointCount || 0) + ' GPS fixes</p>';

      if (!p) {
        html += '<div class="banner">This ride has not been calculated yet, so there are no kilometres to show. '
          + '<button class="btn-sm btn-primary" id="btnProcess">Calculate now</button></div>';
      } else {
        html += '<div class="grid metrics" style="margin-bottom:12px">'
          + metric(km(d.km.verifiedBusiness), 'Verified business', 'ok')
          + metric(km(d.km.likelyBusiness), 'Likely business', 'warn')
          + metric(km(d.km.personal), 'Personal')
          + metric(km(d.km.unknown), 'Unknown', d.km.unknown > 0 ? 'warn' : '')
          + metric(km(d.km.gapEstimate), 'GPS gap (estimate)')
          + metric(km(d.km.dayTotal), 'Day total')
          + '</div>'
          + '<div class="evidence"><b>How this adds up.</b> '
          + esc(d.reconciliation.explanation)
          + ' Residual: ' + d.reconciliation.bucketResidualM + ' m ('
          + (d.reconciliation.ok ? 'reconciled' : 'NOT RECONCILED — report this') + ').<br>'
          + esc(d.methodNote) + '<br>'
          + 'GPS quality: <b>' + esc(p.track.quality.grade) + '</b>'
          + (p.track.quality.reasons.length ? ' — ' + esc(p.track.quality.reasons.join('; ')) : '')
          + '<br>Calculated with version ' + esc(p.calcVersion) + ' at ' + dateTime(p.processedAt) + '.'
          + '</div>';
      }

      html += '<div class="card"><h2>Route replay</h2><div id="replayMap"></div>'
        + '<div class="replay-bar" id="replayBar" hidden>'
        + '  <button type="button" class="btn-primary btn-sm" id="rpPlay" aria-label="Play">▶</button>'
        + '  <input type="range" id="rpSeek" min="0" max="0" value="0" aria-label="Replay position">'
        + '  <select id="rpSpeed" aria-label="Replay speed"><option value="60">1 min/s</option><option value="300" selected>5 min/s</option><option value="900">15 min/s</option></select>'
        + '</div>'
        + '<p class="tiny" id="rpNow" style="margin:6px 0 0"></p>'
        + '<div class="legend">'
        + '  <span><i style="background:' + MAPS.BUCKET_COLOUR.business + '"></i>Business</span>'
        + '  <span><i style="background:' + MAPS.BUCKET_COLOUR.personal + '"></i>Personal</span>'
        + '  <span><i style="background:' + MAPS.BUCKET_COLOUR.unknown + '"></i>Undecided</span>'
        + '  <span><i style="background:' + MAPS.BUCKET_COLOUR.gap + '"></i>No GPS (dashed, straight line)</span>'
        + '  <span><i style="background:#98a2b3;width:6px;height:6px"></i>Fix not counted</span>'
        + '  <span><i style="background:#D7262F"></i>Restaurant visited</span>'
        + '</div>'
        + '<p class="tiny" id="rpNote" style="margin-top:8px">Grey dots are fixes left out of the distance (poor accuracy, impossible jumps, duplicates). They are kept and shown, never deleted.</p></div>';

      if (p) {
        html += '<div class="card"><h2>Segments</h2><div style="overflow-x:auto"><table><thead><tr>'
          + '<th>Time</th><th>What</th><th>Confidence</th><th>Distance</th><th>Evidence</th><th></th></tr></thead><tbody>'
          + p.segments.map(function (s) {
            return '<tr>'
              + '<td>' + time(s.startTs) + '<br><span class="tiny">' + time(s.endTs) + '</span></td>'
              + '<td><b>' + esc(s.type.replace(/_/g, ' ').toLowerCase()) + '</b>'
              + (s.place ? '<br><span class="tiny">' + esc(s.place.name) + '</span>' : '')
              + (s.originalType ? '<br><span class="tiny">was ' + esc(s.originalType.replace(/_/g, ' ').toLowerCase()) + ', changed by ' + esc(s.reviewedBy || 'an admin') + '</span>' : '')
              + '</td>'
              + '<td><span class="pill ' + esc(s.confidence) + '">' + esc(s.confidence) + '</span>'
              + (s.needsReview ? '<br><span class="tiny">needs review</span>' : '') + '</td>'
              + '<td>' + (s.distanceM / 1000).toFixed(2) + ' km'
              + (s.gapEstimateM ? '<br><span class="tiny">+' + (s.gapEstimateM / 1000).toFixed(2) + ' km estimated</span>' : '') + '</td>'
              + '<td class="tiny">' + esc((s.evidence || []).map(function (x) { return x.detail; }).join(' · ')) + '</td>'
              + '<td><button class="btn-outline btn-sm" data-review="' + esc(s.id) + '">Reclassify</button></td>'
              + '</tr>';
          }).join('')
          + '</tbody></table></div></div>';

        if (p.matching) {
          html += '<div class="card"><h2>Delivery matching</h2>'
            + '<p class="muted">' + p.matching.summary.matched + ' matched · ' + p.matching.summary.possible + ' possible · '
            + p.matching.summary.unmatchedVisits + ' visits with no order · ' + p.matching.summary.unmatchedOrders + ' orders with no visit</p>'
            + '<p class="tiny">' + esc(p.matching.summary.distanceNote) + '</p>'
            + (p.matching.unmatchedVisits.length
              ? '<table><thead><tr><th>Visit</th><th>Location</th><th>Why unmatched</th></tr></thead><tbody>'
              + p.matching.unmatchedVisits.map(function (v) {
                return '<tr><td>' + time(v.visitAt) + '</td><td>' + esc(v.placeName || '—') + '</td><td class="tiny">' + esc(v.reason) + '</td></tr>';
              }).join('') + '</tbody></table>' : '')
            + '</div>';
        }
      }

      if (data.reviews && data.reviews.length) {
        html += '<div class="card"><h2>Classification history</h2><table><thead><tr><th>When</th><th>Who</th><th>Segment</th><th>Change</th><th>Note</th><th></th></tr></thead><tbody>'
          + data.reviews.map(function (rv) {
            return '<tr><td>' + dateTime(rv.at) + '</td><td>' + esc(rv.reviewerId) + '</td><td>' + esc(rv.segmentId) + '</td>'
              + '<td class="tiny">' + esc(rv.fromType) + ' → ' + esc(rv.toType) + (rv.reverted ? ' <b>(reverted)</b>' : rv.superseded ? ' (superseded)' : '') + '</td>'
              + '<td class="tiny">' + esc(rv.note || '') + '</td>'
              + '<td>' + (rv.reverted || rv.superseded ? '' : '<button class="btn-outline btn-sm" data-revert="' + esc(rv.id) + '">Revert</button>') + '</td></tr>';
          }).join('') + '</tbody></table>'
          + '<p class="tiny" style="margin-top:8px">Reviews are appended, never overwritten, and they never change the raw GPS.</p></div>';
      }

      html += '<button class="btn-outline" id="btnCloseModal">Close</button>';
      modal(html);
      var root = document.getElementById('modal');
      on('#btnCloseModal', 'click', closeModal, root);
      on('#btnProcess', 'click', function () {
        this.disabled = true;
        API.processRide(rideId).then(function () { openRide(rideId); }).catch(function (e) { alert(e.message); });
      }, root);
      on('[data-review]', 'click', function (e) { promptReview(rideId, e.currentTarget.dataset.review); }, root);
      on('[data-revert]', 'click', function (e) {
        if (!confirm('Revert this reclassification? The original machine verdict comes back and the revert is recorded.')) return;
        API.revertReview(e.currentTarget.dataset.revert).then(function () { openRide(rideId); }).catch(function (err) { alert(err.message); });
      }, root);

      drawRideReplay(data, restaurants, facilities);
    }).catch(function (e) { modal(errBox(e) + '<button class="btn-outline" id="btnCloseModal">Close</button>'); on('#btnCloseModal', 'click', closeModal, document.getElementById('modal')); });
  }

  /* The replay: the route coloured by what each stretch counted as, silences
   * drawn as dashed straight lines, excluded fixes as grey dots, the restaurants
   * visited numbered in order, and a playback head with the time and what the
   * driver was doing at that moment. */
  var KIND_LABEL = { business: 'business', personal: 'personal', unknown: 'undecided', gap: 'no GPS' };
  function drawRideReplay(data, restaurants, facilities) {
    var rp = data.replay;
    var note = document.getElementById('rpNote');
    if (!rp || !rp.points || !rp.points.length) {
      if (note) note.textContent = 'No GPS was recorded on this ride, so there is no route to show.';
      return;
    }
    var h = MAPS.create('replayMap', { zoom: 12 });
    if (!h) return;
    var p = data.processing;
    var byId = {};
    restaurants.forEach(function (x) { byId[x.id] = x; });
    facilities.forEach(function (x) { byId[x.id] = x; });

    // Restaurants visited, numbered in the order the driver reached them.
    var visits = [];
    ((p && p.segments) || []).forEach(function (s) {
      if (s.kind !== 'stop' || !s.place) return;
      var at = byId[s.place.id] && hasPin(byId[s.place.id]) ? byId[s.place.id] : s.center;
      if (!at || !isFinite(at.lat)) return;
      var facility = s.type === 'MODERN_DAIRY_FACILITY_STOP';
      visits.push({ lat: at.lat, lng: at.lng, label: facility ? 'MD' : String(visits.filter(function (v) { return !v.facility; }).length + 1),
        facility: facility, color: facility ? '#1B2A6B' : '#D7262F', title: s.place.name + ' · ' + time(s.startTs) + '–' + time(s.endTs) });
    });

    // Only the restaurants near the route: three thousand pins would bury it.
    var used = rp.points.filter(function (q) { return q.used; });
    var step = Math.max(1, Math.floor(used.length / 300));
    var sample = used.filter(function (q, i) { return i % step === 0; });
    var near = restaurants.filter(function (x) {
      if (x.active === false || !hasPin(x)) return false;
      for (var i = 0; i < sample.length; i += 1) {
        var dLat = (x.lat - sample[i].lat) * 111320;
        var dLng = (x.lng - sample[i].lng) * 111320 * Math.cos(x.lat * Math.PI / 180);
        if (dLat * dLat + dLng * dLng < 800 * 800) return true;
      }
      return false;
    });

    h.ready(function () {
      mapProviderNote('replayMap', h);
      MAPS.drawPlaces(h, 'near', near, '#e8a3a6', function (id) { if (byId[id]) restaurantModal(byId[id]); });
      var play = MAPS.drawReplay(h, rp, { visits: visits });
      if (!play || !play.count) {
        if (note) note.textContent = 'Every fix on this ride was left out of the distance, so only grey dots are shown.';
        return;
      }
      if (!rp.calculated && note) note.textContent = 'This ride has not been calculated yet: the route is shown as recorded, undecided, with nothing left out.';
      bindReplayControls(play, rp);
    });
  }

  function bindReplayControls(play, rp) {
    var bar = document.getElementById('replayBar');
    var seek = document.getElementById('rpSeek');
    var btn = document.getElementById('rpPlay');
    var speed = document.getElementById('rpSpeed');
    var now = document.getElementById('rpNow');
    if (!bar || !seek) return;
    var pts = play.points;
    bar.hidden = false;
    seek.max = String(pts.length - 1);
    var gapFrom = {};
    (rp.gaps || []).forEach(function (g) { gapFrom[g.fromTs] = g; });
    var show = function (i) {
      var q = play.seek(i);
      if (!q) return;
      var g = gapFrom[q.ts];
      now.innerHTML = '<b>' + time(q.ts) + '</b> · ' + esc(KIND_LABEL[q.b] || 'undecided')
        + (g ? ' · then no GPS for ' + Math.round(g.seconds / 60) + ' min' : '')
        + ' · fix ' + (i + 1) + ' of ' + pts.length;
    };
    var timer = null;
    var stop = function () { clearInterval(timer); timer = null; btn.textContent = '▶'; btn.setAttribute('aria-label', 'Play'); };
    // Playback runs on the clock of the ride, not on fix numbers: a parked
    // hour passes as fast as a driven one would at the same speed setting.
    var TICK_MS = 100;
    var tick = function () {
      if (!document.body.contains(seek)) { stop(); return; }
      var i = Number(seek.value);
      if (i >= pts.length - 1) { stop(); return; }
      var target = pts[i].ts + Number(speed.value) * 1000 * (TICK_MS / 1000);
      while (i < pts.length - 1 && pts[i + 1].ts <= target) i += 1;
      if (i === Number(seek.value)) i += 1;   // always move, even across a silence
      seek.value = String(i);
      show(i);
    };
    btn.addEventListener('click', function () {
      if (timer) { stop(); return; }
      if (Number(seek.value) >= pts.length - 1) seek.value = '0';
      btn.textContent = '❚❚'; btn.setAttribute('aria-label', 'Pause');
      timer = setInterval(tick, TICK_MS);
    });
    seek.addEventListener('input', function () { show(Number(seek.value)); });
    show(0);
  }

  var REVIEW_TYPES = [
    ['TRAVEL_BETWEEN_BUSINESS_LOCATIONS', 'Business travel between locations'],
    ['MODERN_DAIRY_DEPARTURE', 'Leaving a Modern Dairy facility'],
    ['RETURN_TO_MODERN_DAIRY', 'Returning to a Modern Dairy facility'],
    ['LIKELY_RESTAURANT_VISIT', 'Restaurant / customer visit'],
    ['BUSINESS_TRAVEL', 'Business travel (other)'],
    ['PERSONAL_OR_NON_BUSINESS', 'Personal / Porter work'],
    ['UNKNOWN', 'Unknown — leave for later'],
  ];

  function promptReview(rideId, segmentId) {
    modal('<h3>Reclassify segment</h3>'
      + '<p class="muted">This adds a new decision with your name against it. The original classification and the raw GPS are untouched.</p>'
      + '<div class="field"><label for="rvType">Classify as</label><select id="rvType">'
      + REVIEW_TYPES.map(function (t) { return '<option value="' + t[0] + '">' + esc(t[1]) + '</option>'; }).join('')
      + '</select></div>'
      + '<div class="field"><label for="rvNote">Why (recorded in the audit log)</label><textarea id="rvNote" rows="3" placeholder="e.g. Driver confirmed this was a delivery to Hotel Shreyas; the geofence radius is too small."></textarea></div>'
      + '<p id="rvErr" class="err" hidden></p>'
      + '<button class="btn-primary" id="rvGo">Save decision</button> <button class="btn-outline" id="rvCancel">Cancel</button>');
    var root = document.getElementById('modal');
    on('#rvCancel', 'click', function () { openRide(rideId); }, root);
    on('#rvGo', 'click', function () {
      var toType = document.getElementById('rvType').value;
      var note = document.getElementById('rvNote').value.trim();
      document.getElementById('rvGo').disabled = true;
      API.review(rideId, segmentId, toType, note).then(function () { openRide(rideId); })
        .catch(function (e) {
          var err = document.getElementById('rvErr');
          err.textContent = e.message; err.hidden = false;
          document.getElementById('rvGo').disabled = false;
        });
    }, root);
  }

  // ── Drivers ────────────────────────────────────────────────────────────
  // Nothing is created here. A driver types their name and phone number into
  // the app and appears in this list; the office's job is to check the list and
  // switch off anyone who should not be on it.
  function renderDrivers() {
    return API.drivers(true).then(function (list) {
      var pending = list.filter(function (d) { return !d.vehicleId; }).length;
      set('<div class="card"><h2>Drivers (' + list.length + ')</h2>'
        + '<p class="muted">Drivers add themselves from the app with their name and mobile number — there is nothing to issue and no code to hand out. '
        + 'Anyone who should not be here can be switched off, and their phone stops recording immediately.</p>'
        + (list.length === 0
          ? '<p class="muted" style="margin-top:14px"><b>Nobody has registered yet.</b> Install the app on a driver\'s phone, let them enter their name and number, and they will appear here.</p>'
          : '<div style="overflow-x:auto;margin-top:14px"><table><thead><tr>'
            + '<th>Driver ID</th><th>Name</th><th>Mobile</th><th>Vehicle</th><th>Status</th><th>Last seen</th><th></th></tr></thead><tbody>'
            + list.map(function (d) {
              return '<tr>'
                + '<td><b>' + esc(d.driverCode) + '</b></td>'
                + '<td>' + esc(d.name)
                + (d.selfReportedName ? '<br><span class="tiny">typed "' + esc(d.selfReportedName) + '" in the app</span>' : '') + '</td>'
                + '<td>' + esc(d.phone || '—') + '</td>'
                + '<td>' + esc(d.vehicleId || '—') + '</td>'
                + '<td><span class="pill ' + (d.status === 'active' ? 'active' : 'idle') + '">' + esc(d.status) + '</span></td>'
                + '<td class="tiny">' + (d.lastSeenAt ? dateTime(d.lastSeenAt) : 'never') + '</td>'
                + '<td style="white-space:nowrap">'
                + '<button class="btn-outline btn-sm" data-hist="' + esc(d.id) + '">History</button> '
                + '<button class="btn-outline btn-sm" data-edit="' + esc(d.id) + '">Edit</button> '
                + '<button class="btn-outline btn-sm" data-toggle="' + esc(d.id) + '" data-status="' + esc(d.status) + '">'
                + (d.status === 'active' ? 'Switch off' : 'Switch on') + '</button>'
                + '</td></tr>';
            }).join('')
            + '</tbody></table></div>')
        + '</div>'
        + (pending && list.length
          ? '<div class="banner info">' + pending + ' driver(s) have no vehicle assigned. That is optional — it only affects reporting.</div>'
          : ''));

      on('[data-hist]', 'click', function (e) {
        hist.driverId = e.currentTarget.dataset.hist;
        go('history');
      });

      on('[data-toggle]', 'click', function (e) {
        var next = e.currentTarget.dataset.status === 'active' ? 'inactive' : 'active';
        var verb = next === 'inactive' ? 'Switch off' : 'Switch on';
        if (!confirm(verb + ' this driver?' + (next === 'inactive'
          ? ' Their phone stops recording immediately and they cannot start a ride.'
          : ' They will be able to start rides again.'))) return;
        API.setDriverStatus(e.currentTarget.dataset.toggle, next).then(render)
          .catch(function (err) { alert(err.message); });
      });

      on('[data-edit]', 'click', function (e) {
        var d = list.find(function (x) { return x.id === e.currentTarget.dataset.edit; });
        modal('<h3>' + esc(d.name) + '</h3>'
          + '<p class="tiny">' + esc(d.driverCode) + ' · ' + esc(d.phone || '') + '</p>'
          + '<div class="field" style="margin-top:14px"><label>Name on record</label><input id="eName" value="' + esc(d.name) + '"></div>'
          + '<div class="field"><label>Vehicle (optional)</label><input id="eVehicle" value="' + esc(d.vehicleId || '') + '" placeholder="e.g. MH12AB1234"></div>'
          + '<div class="field"><label>Notes (optional)</label><textarea id="eNotes" rows="2">' + esc(d.notes || '') + '</textarea></div>'
          + '<p class="tiny">The mobile number is the account and cannot be changed here — a driver with a new number registers again and the old account is switched off.</p>'
          + '<p id="eErr" class="err" hidden></p>'
          + '<button class="btn-primary" id="eSave" style="width:auto">Save</button> '
          + '<button class="btn-outline" id="eCancel">Cancel</button>');
        var root = document.getElementById('modal');
        on('#eCancel', 'click', closeModal, root);
        on('#eSave', 'click', function () {
          API.updateDriver(d.id, {
            name: document.getElementById('eName').value.trim(),
            vehicleId: document.getElementById('eVehicle').value.trim() || null,
            notes: document.getElementById('eNotes').value.trim() || null,
          }).then(function () { closeModal(); render(); })
            .catch(function (ex) { var el2 = document.getElementById('eErr'); el2.textContent = ex.message; el2.hidden = false; });
        }, root);
      });
    });
  }

  // ── Review queue ───────────────────────────────────────────────────────
  // ── History ────────────────────────────────────────────────────────────
  //
  // A driver's days. Business and personal are split by the restaurant rule:
  // driving to a restaurant, and between restaurants and the depot, is
  // business; driving that leads to no restaurant is personal. Each day opens
  // into the full ride view, with the route and the reason for every stretch.
  var hist = { driverId: null, days: 30 };

  function renderHistory() {
    return API.drivers(true).then(function (drivers) {
      if (!drivers.length) {
        set('<div class="card"><h2>History</h2><p class="muted">Nobody has registered yet, so there is no history to show.</p></div>');
        return null;
      }
      if (!hist.driverId || !drivers.some(function (d) { return d.id === hist.driverId; })) hist.driverId = drivers[0].id;
      set('<div class="card"><h2>History</h2>'
        + '<div class="bar">'
        + '<div style="flex:2;min-width:220px"><label for="hDriver">Driver</label><select id="hDriver">'
        + drivers.map(function (d) {
          return '<option value="' + esc(d.id) + '"' + (d.id === hist.driverId ? ' selected' : '') + '>'
            + esc(d.name) + ' · ' + esc(d.driverCode) + (d.status !== 'active' ? ' (switched off)' : '') + '</option>';
        }).join('')
        + '</select></div>'
        + '<div><label for="hDays">Period</label><select id="hDays">'
        + [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [180, 'Last 6 months']].map(function (o) {
          return '<option value="' + o[0] + '"' + (hist.days === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('')
        + '</select></div>'
        + '</div>'
        + '<p class="tiny" style="margin:0">Business is driving to a restaurant, and between restaurants and the depot. '
        + 'Personal is driving that leads to no restaurant. Tap a day to see its route and why each stretch counted as it did.</p>'
        + '</div>'
        + '<div id="hBody">' + spinner('Loading history…') + '</div>');
      on('#hDriver', 'change', function (e) { hist.driverId = e.target.value; loadHistory(); });
      on('#hDays', 'change', function (e) { hist.days = Number(e.target.value); loadHistory(); });
      return loadHistory();
    });
  }

  function loadHistory() {
    var body = document.getElementById('hBody');
    if (!body) return Promise.resolve();
    body.innerHTML = spinner('Loading history…');
    var to = Date.now();
    var asked = hist.driverId + ':' + hist.days;
    return API.history(hist.driverId, to - hist.days * 86400000, to).then(function (h) {
      // A slower answer for a driver the office has already moved away from
      // must not replace the one they are looking at.
      if (asked !== hist.driverId + ':' + hist.days || !document.getElementById('hBody')) return;
      var t = h.totals;
      var html = '<div class="grid metrics" style="margin-bottom:14px">'
        + metric(t.calculatedDays + (t.days !== t.calculatedDays ? ' of ' + t.days : ''), 'Days driven')
        + metric(km(t.business), 'Business', 'ok')
        + metric(km(t.personal), 'Personal')
        + metric(km(t.unknown), 'Undecided — needs review', t.unknown > 0 ? 'warn' : '')
        + metric(km(t.total), 'Total')
        + '</div>';
      if (h.calculation && h.calculation.deferred) {
        html += '<div class="banner info">' + h.calculation.deferred + ' more day(s) are still being calculated. Open this again in a minute.</div>';
      }
      if (!h.days.length) {
        html += '<div class="card"><p class="muted">No rides in this period.</p></div>';
      } else {
        html += '<div class="card"><div style="overflow-x:auto"><table><thead><tr>'
          + '<th>Day</th><th>Business</th><th>Personal</th><th>Undecided</th><th>GPS gap</th><th>Total</th><th>Restaurants</th>'
          + '</tr></thead><tbody>'
          + h.days.map(function (d) {
            var k = d.km;
            var shops = d.restaurants.length
              ? d.restaurants.slice(0, 6).map(function (r) { return esc(r.name); }).join(', ')
                + (d.restaurants.length > 6 ? ' and ' + (d.restaurants.length - 6) + ' more' : '')
              : '<span class="tiny">none</span>';
            return '<tr class="click" data-ride="' + esc(d.rideId) + '">'
              + '<td><b>' + esc(dayLabel(d.dayKey)) + '</b><br><span class="tiny">'
              + time(d.startedAt) + ' – ' + (d.status === 'active' ? 'still running' : time(d.stoppedAt))
              + (d.stopKind === 'day_end' ? ' · closed at day end' : '') + '</span></td>'
              + (k
                ? '<td><b>' + km(k.business) + '</b>'
                  + (k.verifiedBusiness ? '<br><span class="tiny">' + km(k.verifiedBusiness) + ' verified</span>' : '') + '</td>'
                  + '<td>' + km(k.personal) + '</td>'
                  + '<td>' + (k.unknown ? '<span class="pill warn">' + km(k.unknown) + '</span>' : km(0)) + '</td>'
                  + '<td>' + km(k.gapEstimate) + '</td>'
                  + '<td><b>' + km(k.total) + '</b></td>'
                : '<td colspan="5"><span class="tiny">' + (d.pointCount ? 'not calculated yet' : 'no GPS recorded') + '</span></td>')
              + '<td>' + shops + '</td>'
              + '</tr>';
          }).join('')
          + '</tbody></table></div></div>';
      }
      document.getElementById('hBody').innerHTML = html;
      on('tr[data-ride]', 'click', function (e) { openRide(e.currentTarget.dataset.ride); }, document.getElementById('hBody'));
    }).catch(function (e) {
      var b = document.getElementById('hBody');
      if (b) b.innerHTML = errBox(e);
    });
  }

  // "Thu 24 Sep" from "2026-09-24", read as a calendar day, not a time: parsed
  // at noon so no timezone can move it to the day before.
  function dayLabel(dayKey) {
    if (!dayKey) return '—';
    return new Date(dayKey + 'T12:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function renderReview() {
    return API.reviewQueue({}).then(function (q) {
      set('<div class="card"><h2>Segments needing review</h2>'
        + '<p class="muted">' + q.pending + ' segment(s) across the last 14 days. These kilometres are <b>not</b> in anyone\'s verified business total until someone decides.</p>'
        + (q.segments.length
          ? '<div style="overflow-x:auto"><table><thead><tr><th>Day</th><th>Driver</th><th>When</th><th>Current</th><th>Distance</th><th>Why it is uncertain</th><th></th></tr></thead><tbody>'
          + q.segments.map(function (s) {
            return '<tr>'
              + '<td>' + esc(s.dayKey) + '</td><td>' + esc(s.driverName || s.driverId) + '</td>'
              + '<td>' + time(s.startTs) + '</td>'
              + '<td><b>' + esc(s.type.replace(/_/g, ' ').toLowerCase()) + '</b><br><span class="pill ' + esc(s.confidence) + '">' + esc(s.confidence) + '</span></td>'
              + '<td>' + (s.distanceM / 1000).toFixed(2) + ' km' + (s.gapEstimateM ? '<br><span class="tiny">+' + (s.gapEstimateM / 1000).toFixed(2) + ' est.</span>' : '') + '</td>'
              + '<td class="tiny">' + esc((s.evidence || []).map(function (x) { return x.detail; }).join(' · '))
              + (s.nearbyPlaces ? '<br><b>Nearby:</b> ' + esc(s.nearbyPlaces.map(function (n) { return n.name + ' (' + n.distanceM + ' m)'; }).join(', ')) : '')
              + '</td>'
              + '<td><button class="btn-outline btn-sm" data-open="' + esc(s.rideId) + '">Open ride</button></td>'
              + '</tr>';
          }).join('') + '</tbody></table></div>'
          : '<p class="muted">Nothing is waiting. Every segment in this period has a confident classification.</p>')
        + '</div>');
      on('[data-open]', 'click', function (e) { openRide(e.currentTarget.dataset.open); });
    });
  }

  // ── Restaurants ────────────────────────────────────────────────────────
  //
  // The day-to-day customer screen: find one, see its state, stop or start its
  // supply. Separate from Locations, which is the once-in-a-while job of
  // uploading the spreadsheet and getting everything pinned.

  var restFilter = { q: '', show: 'all', shown: 200 };

  /* Every restaurant on the map, confirmed with Google Maps.
   *
   * The office wants each pin checked against Google, however it was placed.
   * The server checks a batch at a time; this keeps asking until nothing is
   * left, so the progress is visible and no single request runs for minutes.
   */
  function googleCheckPanel(all) {
    var n = googleCounts(all);
    var problems = n.moved + n.name_differs + n.not_found;
    return '<div class="banner ' + (problems || n.unchecked ? '' : 'info') + '" id="gcPanel" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">'
      + '<div style="flex:1;min-width:220px"><b>Google Maps check</b><br>'
      + n.confirmed + ' confirmed'
      + (n.moved ? ' · <b>' + n.moved + ' pinned in the wrong place</b>' : '')
      + (n.name_differs ? ' · ' + n.name_differs + ' under another name' : '')
      + (n.not_found ? ' · ' + n.not_found + ' not on Google Maps' : '')
      + (n.unchecked ? ' · ' + n.unchecked + ' not checked yet' : '')
      + '<br><span id="gcMsg" class="tiny"></span></div>'
      + (n.unchecked
        ? '<button class="btn-primary btn-sm" id="gcRun" style="width:auto">Check ' + n.unchecked + ' with Google Maps</button>'
        : '<button class="btn-outline btn-sm" id="gcRerun" style="width:auto">Check all again</button>')
      + (problems ? '<button class="btn-primary btn-sm" id="gcWrong" style="width:auto">Wrong locations on the map (' + problems + ')</button>'
        + '<button class="btn-outline btn-sm" id="gcShow" style="width:auto">Filter the list</button>' : '')
      + '</div>';
  }

  function bindGoogleCheck() {
    var msg = function (t) { var e = document.getElementById('gcMsg'); if (e) e.innerHTML = t; };
    var run = function (recheck) {
      ['gcRun', 'gcRerun'].forEach(function (id) { var b = document.getElementById(id); if (b) b.disabled = true; });
      var done = 0;
      // "Check all again": the first batch starts the re-check and the server
      // answers with its own start time, which every later batch sends back.
      var run = recheck ? true : undefined;
      var step = function () {
        return API.googleCheck(run).then(function (r) {
          if (recheck) run = r.recheckBefore;
          done += r.checked;
          msg('Checked ' + done + ' · ' + r.remaining + ' to go…');
          if (r.stoppedFor) { msg('<span class="err">' + esc(r.stoppedFor) + '</span>'); return null; }
          if (r.remaining > 0 && r.checked > 0) return step();
          return API.places('restaurants').then(function (list) {
            state.restaurants = list;
            render();
          });
        });
      };
      step().catch(function (e) {
        msg('<span class="err">' + esc(e.message) + '</span>');
        ['gcRun', 'gcRerun'].forEach(function (id) { var b = document.getElementById(id); if (b) b.disabled = false; });
      });
    };
    on('#gcRun', 'click', function () { run(false); });
    on('#gcRerun', 'click', function () {
      if (!confirm('Check every restaurant with Google Maps again?\n\nThis asks Google once per restaurant.')) return;
      run(true);
    });
    on('#gcWrong', 'click', function () { renderWrongLocations().catch(function (e) { set(errBox(e)); }); });
    on('#gcShow', 'click', function () {
      restFilter.show = 'google_problem'; restFilter.shown = 200;
      var sel = document.getElementById('rShow'); if (sel) sel.value = 'google_problem';
      fillRestaurants(); bindHoldButtons();
    });
  }

  /* Every restaurant Google Maps disagrees with, on one screen: where our pin
   * is, where Google has the business, how far apart, with links that open
   * each position in Google Maps, and the fix one tap away. */
  var WRONG_KIND = {
    moved: ['Pinned in the wrong place', 'bad'],
    name_differs: ['Another name at the pin', 'warn'],
    not_found: ['Not found on Google Maps', 'warn'],
  };
  function gmapsAt(lat, lng) { return 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng; }
  function gmapsPlace(c, p) {
    return c.googlePlaceId
      ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(c.googleName || p.name) + '&query_place_id=' + encodeURIComponent(c.googlePlaceId)
      : gmapsAt(c.googleLat, c.googleLng);
  }
  function gmapsSearch(p) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([p.name, p.area || p.address, 'Pune'].filter(Boolean).join(', '));
  }
  function wrongRows(all) {
    var order = { moved: 0, name_differs: 1, not_found: 2 };
    return all.filter(function (p) { return WRONG_KIND[googleStatus(p)]; })
      .map(function (p) { return { p: p, st: googleStatus(p), c: p.googleCheck || {} }; })
      .sort(function (a, b) { return order[a.st] - order[b.st] || (b.c.distanceM || 0) - (a.c.distanceM || 0); });
  }

  function renderWrongLocations() {
    return API.places('restaurants').then(function (all) {
      state.restaurants = all;
      var rows = wrongRows(all);
      var n = googleCounts(all);
      var movedIds = rows.filter(function (r) { return r.st === 'moved'; }).map(function (r) { return r.p.id; });
      set('<div class="card">'
        + '<p style="margin:0 0 10px"><button class="btn-outline btn-sm" id="wlBack" style="width:auto">← Restaurants</button></p>'
        + '<h2>Wrong locations — checked against Google Maps</h2>'
        + '<p class="muted" style="margin-top:0">' + n.confirmed + ' confirmed · <b>' + n.moved + ' pinned in the wrong place</b> · '
        + n.name_differs + ' under another name · ' + n.not_found + ' not on Google Maps'
        + (n.unchecked ? ' · <b>' + n.unchecked + ' not checked yet</b>' : '') + '.</p>'
        + '<p><button class="btn-' + (n.unchecked ? 'primary' : 'outline') + ' btn-sm" id="wlCheck" style="width:auto">'
        + (n.unchecked ? 'Check the ' + n.unchecked + ' not checked yet' : 'Check every restaurant again') + '</button> '
        + '<span id="wlCheckMsg" class="tiny"></span></p>'
        + '<div class="legend" style="margin:0 0 10px">'
        + '<span><i style="background:#D7262F"></i>Our pin (wrong)</span>'
        + '<span><i style="background:#0f7a4a"></i>Where Google Maps has it</span>'
        + '<span><i style="background:#c98a12"></i>Our pin — Google has another name there / cannot find it</span></div>'
        + '<div id="wrongMap" style="width:100%;height:460px;border-radius:12px;border:1px solid var(--line);background:#e3e6ef"></div>'
        + '<div class="bar" style="margin-top:12px">'
        + (movedIds.length ? '<div><button class="btn-primary" id="wlFixAll" style="width:auto">Move all ' + movedIds.length + ' to Google\'s position</button></div>' : '')
        + '<div><button class="btn-outline" id="wlCsv" style="width:auto">Download list (Excel/CSV)</button></div>'
        + '</div><p id="wlMsg" class="tiny"></p>'
        + (rows.length
          ? '<div style="overflow-x:auto"><table><thead><tr><th>Restaurant</th><th>Problem</th><th>Our pin</th><th>Google Maps</th><th>Apart</th><th></th></tr></thead><tbody>'
            + rows.map(function (r) {
              var p = r.p; var c = r.c; var k = WRONG_KIND[r.st];
              var hasG = isFinite(c.googleLat) && isFinite(c.googleLng);
              return '<tr data-wl="' + esc(p.id) + '">'
                + '<td><b>' + esc(p.name) + '</b>' + (p.area ? '<br><span class="tiny">' + esc(p.area) + '</span>' : '')
                + (p.address ? '<br><span class="tiny">' + esc(p.address) + '</span>' : '') + '</td>'
                + '<td><span class="pill ' + k[1] + '">' + esc(k[0]) + '</span></td>'
                + '<td class="tiny"><a href="' + gmapsAt(p.lat, p.lng) + '" target="_blank" rel="noopener">Open in Google Maps</a><br>'
                + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + '</td>'
                + '<td class="tiny">' + (hasG
                  ? '<a href="' + gmapsPlace(c, p) + '" target="_blank" rel="noopener">' + esc(c.googleName || 'Open in Google Maps') + '</a>'
                    + (c.googleAddress ? '<br>' + esc(c.googleAddress) : '') + '<br>' + Number(c.googleLat).toFixed(5) + ', ' + Number(c.googleLng).toFixed(5)
                  : '<a href="' + gmapsSearch(p) + '" target="_blank" rel="noopener">Search Google Maps</a>') + '</td>'
                + '<td>' + (c.distanceM != null ? (c.distanceM >= 1000 ? (c.distanceM / 1000).toFixed(1) + ' km' : c.distanceM + ' m') : '—') + '</td>'
                + '<td style="white-space:nowrap">'
                + '<button class="btn-outline btn-sm" data-wlshow="' + esc(p.id) + '">Show</button> '
                + (hasG && r.st !== 'not_found' ? '<button class="btn-primary btn-sm" data-wluse="' + esc(p.id) + '">Use Google\'s</button> ' : '')
                + '<button class="btn-outline btn-sm" data-wlopen="' + esc(p.id) + '">Open</button>'
                + '</td></tr>';
            }).join('') + '</tbody></table></div>'
          : '<p class="muted">Google Maps agrees with every restaurant it has checked.</p>')
        + '</div>');

      on('#wlBack', 'click', function () { state.wrongMap = null; render(); });
      var h = state.wrongMap = MAPS.create('wrongMap', { zoom: 11 });
      var byId = {};
      rows.forEach(function (r) { byId[r.p.id] = r; });
      if (h) {
        h.ready(function () {
          if (state.wrongMap !== h) return;
          mapProviderNote('wrongMap', h);
          var pts = [];
          rows.forEach(function (r) {
            var p = r.p; var c = r.c;
            var hasG = isFinite(c.googleLat) && isFinite(c.googleLng) && r.st !== 'not_found';
            var ours = { lat: p.lat, lng: p.lng };
            pts.push(ours);
            if (hasG) {
              var g = { lat: Number(c.googleLat), lng: Number(c.googleLng) };
              pts.push(g);
              MAPS.line(h, 'wrong', [ours, g], { color: '#8b93a7', width: 2, dashed: true, z: 5 });
              MAPS.pin(h, 'wrong', g, { dot: 7, color: '#0f7a4a', title: p.name + ' — Google Maps: ' + (c.googleName || '') + (c.googleAddress ? ', ' + c.googleAddress : ''), z: 600 });
            }
            MAPS.pin(h, 'wrong', ours, { dot: 7, color: r.st === 'moved' ? '#D7262F' : '#c98a12',
              title: p.name + ' — our pin' + (c.distanceM != null ? ' (' + c.distanceM + ' m from Google)' : ''), z: 700 });
          });
          MAPS.fit(h, pts);
        });
      }
      on('[data-wlshow]', 'click', function (e) {
        var r = byId[e.currentTarget.dataset.wlshow];
        if (!r || !h) return;
        var c = r.c;
        var pts = [{ lat: r.p.lat, lng: r.p.lng }];
        if (isFinite(c.googleLat) && r.st !== 'not_found') pts.push({ lat: Number(c.googleLat), lng: Number(c.googleLng) });
        MAPS.fit(h, pts);
        document.getElementById('wrongMap').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      on('[data-wlopen]', 'click', function (e) { var r = byId[e.currentTarget.dataset.wlopen]; if (r) restaurantModal(r.p); });
      on('[data-wluse]', 'click', function (e) {
        var b = e.currentTarget; var r = byId[b.dataset.wluse];
        if (!r || !confirm('Move ' + r.p.name + ' to where Google Maps has it' + (r.c.distanceM != null ? ' (' + r.c.distanceM + ' m away)' : '') + '?\n\nThis moves its geofence. It is recorded in the audit log.')) return;
        b.disabled = true;
        API.useGooglePin(r.p.id).then(function () { renderWrongLocations(); }).catch(function (err) { b.disabled = false; alert(err.message); });
      });
      on('#wlFixAll', 'click', function () {
        if (!confirm('Move all ' + movedIds.length + ' restaurants that Google Maps has somewhere else to Google\'s position?\n\n'
          + 'Only "pinned in the wrong place" ones are moved. "Another name" and "not found" still need a person to look. Every move is recorded in the audit log.')) return;
        var b = document.getElementById('wlFixAll'); b.disabled = true;
        var m = document.getElementById('wlMsg'); m.textContent = 'Moving…';
        API.useGooglePins(movedIds).then(function (out) {
          m.innerHTML = '<span class="ok-msg">' + out.moved + ' moved.</span>' + (out.skipped ? ' ' + out.skipped + ' skipped (their pin changed since the check).' : '');
          setTimeout(function () { renderWrongLocations(); }, 900);
        }).catch(function (err) { b.disabled = false; m.innerHTML = '<span class="err">' + esc(err.message) + '</span>'; });
      });
      on('#wlCsv', 'click', function () { downloadWrongCsv(rows); });
      on('#wlCheck', 'click', function () {
        var again = !n.unchecked;
        if (again && !confirm('Check every restaurant with Google Maps again?\n\nThis asks Google once per restaurant.')) return;
        var b = document.getElementById('wlCheck'); b.disabled = true;
        var m = document.getElementById('wlCheckMsg');
        var run = again ? true : undefined;
        var done = 0;
        var step = function () {
          return API.googleCheck(run).then(function (r) {
            if (again) run = r.recheckBefore;
            done += r.checked;
            m.textContent = 'Checked ' + done + ' · ' + r.remaining + ' to go…';
            if (r.stoppedFor) { m.innerHTML = '<span class="err">' + esc(r.stoppedFor) + '</span>'; b.disabled = false; return null; }
            if (r.remaining > 0 && r.checked > 0 && document.getElementById('wlCheck')) return step();
            return renderWrongLocations();
          });
        };
        step().catch(function (err) { b.disabled = false; m.innerHTML = '<span class="err">' + esc(err.message) + '</span>'; });
      });
    });
  }

  function downloadWrongCsv(rows) {
    var q = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var head = ['Restaurant', 'Customer ID', 'Area', 'Address', 'Problem', 'Our lat', 'Our lng', 'Our pin on Google Maps',
      'Google name', 'Google address', 'Google lat', 'Google lng', 'Google Maps link', 'Metres apart'];
    var lines = [head.join(',')].concat(rows.map(function (r) {
      var p = r.p; var c = r.c;
      var hasG = isFinite(c.googleLat) && isFinite(c.googleLng);
      return [p.name, p.customerId, p.area, p.address, WRONG_KIND[r.st][0], p.lat, p.lng, gmapsAt(p.lat, p.lng),
        c.googleName, c.googleAddress, hasG ? c.googleLat : '', hasG ? c.googleLng : '',
        hasG ? gmapsPlace(c, p) : gmapsSearch(p), c.distanceM].map(q).join(',');
    }));
    // The BOM makes Excel read the names as UTF-8.
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'wrong-restaurant-locations.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function renderRestaurants() {
    return API.places('restaurants').then(function (all) {
      state.restaurants = all;
      var held = all.filter(function (p) { return p.supplyHold === true; }).length;
      var placed = all.filter(hasPin).length;
      // Trucks are counted apart from everything else. Left in "no location
      // yet" they would be permanent outstanding work: there is no address to
      // find, so that number could never reach zero.
      var trucks = all.filter(isMobilePlace).length;
      var needPin = all.filter(function (p) { return !hasPin(p) && !isMobilePlace(p); }).length;

      set('<div class="card">'
        + '<div class="grid metrics" style="margin-bottom:16px">'
        + metric(all.length, 'Customers')
        + metric(placed, 'On the map', placed ? 'ok' : '')
        + metric(held, 'Supply on hold', held ? 'bad' : 'ok')
        + metric(needPin, 'No location yet', needPin ? 'warn' : 'ok')
        + (trucks ? metric(trucks, 'Food trucks · no fixed address') : '')
        + '</div>'
        + googleCheckPanel(all)
        + '<div class="bar">'
        + '<div style="flex:1;min-width:240px"><input id="rSearch" placeholder="Search name, area, address or customer ID" value="' + esc(restFilter.q) + '"></div>'
        + '<div><select id="rShow">'
        + [['all', 'All'], ['hold', 'Supply on hold'], ['supplying', 'Supplying'],
          ['nopin', 'No location yet'], ['check', 'Placed under a different name'],
          ['google_problem', 'Google Maps disagrees'], ['google_unchecked', 'Not checked with Google Maps'],
          ['mobile', 'Food trucks / mobile']]
          .map(function (o) {
            return '<option value="' + o[0] + '"' + (restFilter.show === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
          }).join('')
        + '</select></div>'
        + '</div>'
        + '<div style="overflow-x:auto"><table><thead><tr>'
        + '<th>Restaurant</th><th>Area</th><th>Customer ID</th><th>Supply</th><th>Location</th><th>Geofence</th><th></th>'
        + '</tr></thead><tbody id="rBody"></tbody></table></div>'
        + '<p class="tiny" id="rFoot"></p>'
        + '</div>');

      fillRestaurants();
      bindHoldButtons();
      bindGoogleCheck();
      on('#rSearch', 'input', function (e) {
        restFilter.q = e.target.value; restFilter.shown = 200; fillRestaurants();
      });
      on('#rShow', 'change', function (e) {
        restFilter.show = e.target.value; restFilter.shown = 200; fillRestaurants();
      });
    });
  }

  function restaurantMatches(p) {
    var q = restFilter.q.trim().toLowerCase();
    if (q && ((p.name || '') + ' ' + (p.area || '') + ' ' + (p.address || '') + ' ' + (p.customerId || ''))
      .toLowerCase().indexOf(q) === -1) return false;
    if (restFilter.show === 'mobile') return isMobilePlace(p);
    if (restFilter.show === 'hold') return p.supplyHold === true;
    if (restFilter.show === 'check') return p.locationSource === 'places_name_differs';
    if (restFilter.show === 'google_problem') {
      var st = googleStatus(p);
      return st === 'moved' || st === 'name_differs' || st === 'not_found';
    }
    if (restFilter.show === 'google_unchecked') return googleStatus(p) === 'unchecked';
    // A truck has no address, so it does not belong in a list of places that
    // are missing one — it would sit there forever looking like outstanding
    // work nobody can finish. It stays reachable from its own filter, and
    // from All.
    if (restFilter.show === 'nopin') return !hasPin(p) && !isMobilePlace(p);
    if (restFilter.show === 'supplying') {
      return p.supplyHold !== true && p.active !== false && !isMobilePlace(p);
    }
    return true;
  }

  // Mirrors backend/src/drivers/mobileVendor.js — either flag means the same
  // thing: a customer with no fixed address.
  function isMobilePlace(p) {
    return !!p && (p.mobile === true || p.locationStatus === 'mobile');
  }

  /* What Google Maps says about a restaurant's pin. See
   * backend/src/services/googleCheck.js for the four verdicts. */
  function googleStatus(p) {
    if (!hasPin(p) || isMobilePlace(p) || p.active === false) return null;
    var c = p.googleCheck;
    if (!c || !c.status) return 'unchecked';
    // A check made against a pin that has since been moved says nothing about
    // the pin now.
    if (c.pinLat !== p.lat || c.pinLng !== p.lng) return 'unchecked';
    return c.status;
  }
  function googlePill(p) {
    var st = googleStatus(p);
    var c = p.googleCheck || {};
    if (!st) return '';
    return '<br>' + ({
      confirmed: '<span class="pill ok">Google Maps ✓</span>',
      moved: '<span class="pill bad">Google: ' + (c.distanceM != null ? c.distanceM + ' m away' : 'elsewhere') + '</span>',
      name_differs: '<span class="pill warn">Google name differs</span>',
      not_found: '<span class="pill warn">not on Google Maps</span>',
      unchecked: '<span class="pill idle">not checked</span>',
    })[st];
  }
  function googleCounts(list) {
    var n = { confirmed: 0, moved: 0, name_differs: 0, not_found: 0, unchecked: 0 };
    list.forEach(function (p) { var st = googleStatus(p); if (st) n[st] += 1; });
    return n;
  }

  function fillRestaurants() {
    var all = (state.restaurants || []).filter(restaurantMatches);
    var rows = all.slice(0, restFilter.shown);
    var body = document.getElementById('rBody');
    if (!body) return;

    body.innerHTML = rows.length ? rows.map(function (p) {
      var held = p.supplyHold === true;
      return '<tr>'
        + '<td><b>' + esc(p.name) + '</b>'
        + (p.address ? '<br><span class="tiny">' + esc(p.address) + '</span>' : '') + '</td>'
        + '<td>' + esc(p.area || '—') + '</td>'
        + '<td>' + esc(p.customerId || '—') + '</td>'
        + '<td>' + (held
          ? '<span class="pill bad">on hold</span>'
            + (p.holdReason ? '<br><span class="tiny">' + esc(p.holdReason) + '</span>' : '')
          : (p.active === false ? '<span class="pill idle">inactive</span>' : '<span class="pill ok">supplying</span>')) + '</td>'
        + '<td class="tiny">' + (isMobilePlace(p)
          ? '<span class="pill idle">food truck</span>'
          : hasPin(p)
            ? p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + googlePill(p)
            : '<span class="pill warn">none yet</span>') + '</td>'
        + '<td class="tiny">' + (p.radiusM ? p.radiusM + ' m' : 'default') + '</td>'
        + '<td style="white-space:nowrap">'
        + '<button class="btn-outline btn-sm" data-rest="' + esc(p.id) + '">Open</button> '
        + '<button class="' + (held ? 'btn-outline' : 'btn-danger') + ' btn-sm" data-hold="' + esc(p.id) + '"'
        + ' data-on="' + (held ? '0' : '1') + '" data-name="' + esc(p.name) + '">'
        + (held ? 'Resume' : 'Stop') + '</button>'
        + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="muted">Nothing matches.</td></tr>';

    var foot = document.getElementById('rFoot');
    if (foot) {
      foot.innerHTML = all.length > rows.length
        ? 'Showing ' + rows.length + ' of ' + all.length + '. <button class="link-sm" id="rMore">Show 200 more</button>'
        : all.length + ' shown.';
      var more = document.getElementById('rMore');
      if (more) more.addEventListener('click', function () { restFilter.shown += 200; fillRestaurants(); });
    }

    document.querySelectorAll('[data-rest]').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = (state.restaurants || []).find(function (x) { return x.id === b.getAttribute('data-rest'); });
        if (p) restaurantModal(p);
      });
    });
  }

  // ── Locations ──────────────────────────────────────────────────────────
  function renderPlaces() {
    return Promise.all([
      API.places('restaurants'), API.places('facilities'), API.awaitingLocation(),
      API.integrationSecrets().catch(function () { return {}; }),
      API.locationsLock().catch(function () { return { locked: false }; }),
    ]).then(function (r) {
      var lock = r[4] || { locked: false };
      var restaurants = r[0];
      var facilities = r[1];
      var await_ = r[2] || {};
      var awaiting = await_.rows || [];
      var counts = await_.counts
        || { total: awaiting.length, pending: 0, unconfirmed: 0, business: 0, street: 0, areaOnly: 0, notFound: 0 };
      var secrets = r[3] || {};
      var onMap = restaurants.filter(hasPin).length;
      var held = restaurants.filter(function (p) { return p.supplyHold === true; });

      // This screen does two things: take the office's spreadsheet, and get
      // those restaurants onto the map. It had grown a button for every state
      // the data could be in — retry, look up, accept these, accept those —
      // which is a description of the machinery, not a description of the job.
      // One button now runs the whole sequence; everything else is folded away
      // until it is actually needed.
      set(lockCard(lock)
        + summaryCard(restaurants.length, onMap, counts, secrets, lock)
        + heldCard(held)
        + (lock.locked ? '' : needsYouCard(awaiting, counts))
        // With nothing imported yet, the upload panel IS the screen, so it
        // opens itself rather than making somebody hunt for it.
        + '<details class="card"' + (restaurants.length ? '' : ' open')
        + '><summary class="disclose">Upload or update the restaurant list</summary>'
        + '<div style="margin-top:14px">'
        + '<p class="muted">Your Excel file, straight from the office — <code>.xlsx</code> or <code>.csv</code>. '
        + 'Only a name column is required; an address column makes the lookup far more accurate. '
        + 'Re-upload the same file whenever you add a restaurant: rows already here are matched by name and area, so only new ones are added, '
        + 'and <b>a pin you have placed is never overwritten</b>.</p>'
        + '<input type="file" id="csvFile" accept=".csv,.xlsx,text/csv" style="margin-bottom:10px">'
        + '<p id="pickedMsg" class="tiny" style="margin:0 0 10px">'
        + (pickedFile ? 'Holding <b>' + esc(pickedFile.name) + '</b>.' : 'No file chosen yet.')
        + '</p>'
        + '<div><button class="btn-primary" id="btnImport" style="width:auto">Upload</button> '
        + '<button class="btn-outline btn-sm" id="btnExport">Download current list</button></div>'
        + '<p id="impMsg" class="muted" style="margin-top:10px"></p>'
        + '</div></details>'
        + '<details class="card"><summary class="disclose">All restaurants (' + restaurants.length + ')</summary>'
        + '<div style="margin-top:14px">'
        + placeTable(restaurants, 'restaurants')
        + placeForm('restaurants')
        + '</div></details>'
        + '<details class="card"><summary class="disclose">Modern Dairy depots (' + facilities.length + ')</summary>'
        + '<div style="margin-top:14px">'
        + placeTable(facilities, 'facilities')
        + placeForm('facilities')
        + '</div></details>'
        + geocodingKeyCard(secrets));

      // The tables live inside collapsed panels now, so they are filled when
      // the panel is first opened rather than on every render of the tab.
      document.querySelectorAll('details').forEach(function (d) {
        d.addEventListener('toggle', function () { if (d.open) bindPlaceTables(); }, { once: true });
      });
      bindPlaceForms();
      bindHoldButtons();
      bindOneButton(counts, secrets);
      bindLock();
      bindAwaiting(awaiting);
      bindGeocodingKey();
      on('#btnExport', 'click', function () {
        API.download('/admin/restaurants/export.csv', {}, 'restaurants.csv').catch(function (e) { alert(e.message); });
      });
      on('#csvFile', 'change', function (ev) {
        pickedFile = ev.target.files[0] || null;
        var pm = document.getElementById('pickedMsg');
        if (pm) {
          pm.innerHTML = pickedFile
            ? 'Holding <b>' + esc(pickedFile.name) + '</b> — it stays chosen while you move around.'
            : 'No file chosen yet.';
        }
      });

      on('#btnImport', 'click', function () {
        var input = document.getElementById('csvFile');
        var f = (input && input.files[0]) || pickedFile;
        var msg = document.getElementById('impMsg');
        if (!f) { msg.textContent = 'Choose a file first.'; return; }
        pickedFile = f;
        msg.textContent = 'Reading…';

        // An .xlsx is read here rather than asking for a Save As → CSV before
        // every upload. That step gets forgotten, and then the list stops being
        // kept up to date — which is worse than a hundred lines of ZIP reader.
        var read = /\.xlsx$/i.test(f.name)
          ? f.arrayBuffer()
              .then(window.DRIVERS_XLSX.readWorkbook)
              .then(window.DRIVERS_XLSX.toCsv)
          : f.text();

        read.then(function (csv) {
          msg.textContent = 'Importing…';
          return API.importRestaurants(csv);
        }).then(function (out) {
          pickedFile = null;
          msg.innerHTML = '<b>' + out.added + ' added, ' + out.updated + ' already here.</b>'
            + (out.awaitingLocation ? '<br>' + out.awaitingLocation + ' still need a location — use <b>Find locations</b> above.' : '')
            + (out.problems.length ? '<br>' + out.problems.length + ' row(s) skipped:<br><span class="tiny">'
              + esc(out.problems.slice(0, 20).map(function (p) { return 'row ' + p.row + ': ' + p.error; }).join('; ')) + '</span>' : '');
          setTimeout(render, 1200);
        }).catch(function (e) { msg.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
      });
    });
  }

  /* The whole screen in one card: where the list stands, and the one button
   * that moves it forward. Everything the office used to have to sequence by
   * hand — requeue the held rows, run the lookup, accept the matches — happens
   * behind this, because that sequence was never a decision anybody wanted to
   * make. It was just the order the machinery had to run in.
   */
  /* The latch, and the state of it, at the very top.
   *
   * Every expensive mistake on this screen is one click and three thousand
   * rows wide — a stale spreadsheet re-imported, a lookup re-run over pins
   * somebody spent an afternoon placing. Once the list is right, this keeps it
   * right, and it is enforced by the server rather than by a greyed-out
   * button, because a greyed-out button is a suggestion.
   */
  function lockCard(lock) {
    if (lock.locked) {
      return '<div class="card" style="border-color:#c9d3ef;background:var(--navy-tint)">'
        + '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">'
        + '<div style="flex:1;min-width:240px"><b>The restaurant list is locked.</b>'
        + '<div class="tiny" style="margin-top:3px">Uploading, the lookup and the bulk placing are all refused by the server. '
        + 'Putting supply on hold and moving a single pin still work — those are the daily jobs.'
        + (lock.lockedBy ? '<br>Locked by ' + esc(lock.lockedBy) : '')
        + (lock.lockedAt ? ' on ' + dateTime(lock.lockedAt) : '')
        + '</div></div>'
        + '<button class="btn-outline" id="btnUnlock" style="width:auto">Unlock</button>'
        + '</div><p id="lockMsg" class="tiny" style="margin:8px 0 0"></p></div>';
    }
    return '';
  }

  function bindLock() {
    function set_(locked, btnId, msgId) {
      var btn = document.getElementById(btnId);
      var msg = document.getElementById(msgId);
      if (!btn) return;
      btn.addEventListener('click', function () {
        if (locked && !confirm('Lock the restaurant list?\n\n'
          + 'Uploading and the location lookup will be refused until somebody unlocks it. '
          + 'Supply holds and moving single pins keep working.')) return;
        btn.disabled = true;
        if (msg) msg.textContent = 'Saving…';
        API.setLocationsLock(locked).then(render).catch(function (e) {
          btn.disabled = false;
          if (msg) msg.innerHTML = '<span class="err">' + esc(e.message) + '</span>';
        });
      });
    }
    set_(true, 'btnLock', 'goMsg');
    set_(false, 'btnUnlock', 'lockMsg');
  }

  function summaryCard(total, onMap, counts, secrets, lock) {
    var saved = secrets && secrets.geocoding === 'configured';
    var todo = (lock && lock.locked) ? 0 : (counts.total || 0);

    if (!total) {
      return '<div class="card"><h2>Restaurants</h2>'
        + '<p class="muted">No restaurants yet. Upload your Excel file below to get started.</p></div>';
    }

    return '<div class="card">'
      + '<h2>Restaurants</h2>'
      + '<div class="grid metrics" style="margin-bottom:16px">'
      + metric(onMap, 'On the map and counting', onMap ? 'ok' : '')
      + metric(todo, 'Still need a location', todo ? 'warn' : 'ok')
      + '</div>'

      + (!saved
        ? '<p class="err">A Google lookup key is needed before any of this can run — open <b>Lookup key</b> below.</p>'
        : todo
          ? '<p style="margin:0 0 6px"><button class="btn-primary" id="btnGo" style="width:auto;font-size:1.05rem;padding:14px 26px">'
            + 'Put ' + todo + ' restaurant' + (todo === 1 ? '' : 's') + ' on the map</button></p>'
            + '<p class="tiny" style="margin:0">Looks each one up with Google and places every one it can identify — '
            + 'the business at its own building, or the right road from your address. '
            + 'Anything that only matches a whole suburb is left for you, because a suburb-wide pin would make '
            + 'a driver\'s private errand look like a delivery.</p>'
          : (lock && lock.locked
            ? '<p class="muted" style="margin:0">The list is locked, so nothing here can run. Unlock it above to make changes.</p>'
            : '<p class="ok-msg" style="margin:0">Every restaurant has a location.</p>'
              + '<p style="margin:10px 0 0"><button class="btn-outline" id="btnLock" style="width:auto">Lock the list</button></p>'
              + '<p class="tiny" style="margin:6px 0 0">Stops anyone re-importing an old spreadsheet or re-running the lookup over '
              + 'pins you have placed. Supply holds and single-pin corrections keep working.</p>'))

      + '<p id="goMsg" class="tiny" style="margin:10px 0 0"></p>'
      + '</div>';
  }

  /* One button, the whole sequence. Each step reports into the same line, so
   * the office sees one running total rather than four separate outcomes they
   * have to add up themselves. */
  function bindOneButton(counts) {
    on('#btnGo', 'click', function () {
      var btn = document.getElementById('btnGo');
      var msg = document.getElementById('goMsg');
      btn.disabled = true;
      var placed = 0, precise = 0, held = 0, missing = 0, accepted = 0;

      function say(stage) {
        msg.innerHTML = '<b>' + stage + '</b><br>'
          + (placed + accepted) + ' placed so far'
          + (precise ? ' (' + precise + ' on the building itself)' : '')
          + (missing ? ' · ' + missing + ' not found' : '');
      }

      function fail(e) {
        btn.disabled = false;
        msg.innerHTML = '<span class="err">' + esc(
          e.code === 'NO_GEOCODING_KEY'
            ? 'No lookup key saved yet — open Lookup key below.'
            : e.message,
        ) + '</span>';
      }

      // 1. Anything held from an earlier, less capable run deserves another go
      //    before anybody is asked to click through it by hand.
      function requeue() {
        if (!counts.unconfirmed) return Promise.resolve();
        say('Re-checking the ones held earlier…');
        return API.retryUnconfirmed();
      }

      // 2. The lookup itself, batch after batch until nothing is pending.
      function lookup() {
        say('Looking them up…');
        return API.locateRestaurants(200).then(function (out) {
          placed += out.placed;
          precise += (out.precise || 0);
          held += out.heldForReview;
          missing += out.notFound;
          var fatal = (out.failures || []).filter(function (f) { return !f.advisory; });
          if (fatal.length) throw new Error(fatal[0].error);
          say('Looking them up…');
          if (out.stillPending > 0 && out.looked > 0) return lookup();
          return null;
        });
      }

      // 3. Accept what was found but not placed outright. Two kinds, run one
      //    after the other; the office does not need to know they are two.
      function accept(kind) {
        return API.acceptCandidates(kind, 1000).then(function (out) {
          accepted += out.accepted;
          say('Placing the rest…');
          if (out.remaining > 0 && out.accepted > 0) return accept(kind);
          return null;
        });
      }

      requeue()
        .then(lookup)
        .then(function () { return accept('business'); })
        .then(function () { return accept('street'); })
        .then(function () {
          msg.innerHTML = '<span class="ok-msg"><b>Done — ' + (placed + accepted) + ' now on the map.</b></span>';
          setTimeout(render, 1500);
        })
        .catch(fail);
    });
  }

  function geocodingKeyCard(secrets) {
    var saved = secrets && secrets.geocoding === 'configured';
    // Nothing works without a key, so when there isn't one this panel is not
    // something to go looking for.
    return '<details class="card"' + (saved ? '' : ' open')
      + '><summary class="disclose">Lookup key '
      + (saved ? '<span class="pill ok">saved</span>' : '<span class="pill bad">not set</span>')
      + '</summary><div style="margin-top:14px">'
      + '<p class="muted">Finding a restaurant uses two of Google\'s APIs, cheapest first. '
      + '<b>Geocoding</b> answers "where is this address?" — most rows in your file have one, and it lands on the building. '
      + '<b>Places</b> answers "where is this business?" and is only asked for a row the address could not pin down, '
      + 'because it costs several times as much and would not improve a row that is already on its building. '
      + 'Paste the key once. It is stored in Google Secret Manager, never in this site and never shown again.</p>'
      + '<p class="tiny">Create it at <b>APIs &amp; Services → Credentials → Create credentials → API key</b>. '
      + 'Under <b>API restrictions</b> tick <b>both</b> <b>Geocoding API</b> and <b>Places API (New)</b> — without Places, any restaurant '
      + 'whose row has no usable street address can only ever be found as a road or a suburb. '
      + 'Leave <b>Application restrictions</b> set to <b>None</b>: the lookup runs on the server, which has no fixed IP, '
      + 'and any other setting blocks it. Both APIs must also be switched on under <b>APIs &amp; Services → Enabled APIs</b>.</p>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">'
      + '<input id="geoKey" type="password" autocomplete="off" placeholder="AIzaSy…" style="max-width:420px">'
      + '<button class="btn-outline btn-sm" id="btnGeoKey">' + (saved ? 'Replace key' : 'Save key') + '</button>'
      + '</div><p id="geoKeyMsg" class="tiny" style="margin-top:8px"></p>'
      + '</div></details>';
  }

  // A re-render replaces the whole panel, and with it the <input type="file">
  // and whatever was chosen in it — so picking a file and then touching
  // anything else silently threw the file away. It is kept here instead,
  // outside the render cycle, and the panel shows what is held.
  var pickedFile = null;

  // The lookup's own vocabulary, in words the office uses. "AREA_ONLY" tells
  // nobody anything; "a whole suburb" says exactly what is wrong with it.
  function confidenceLabel(c) {
    return {
      PRECISE: 'the building',
      BUSINESS_UNSURE: 'a business, different name',
      EXACT: 'the building',
      APPROXIMATE: 'the right road',
      AREA_ONLY: 'a whole suburb',
      NONE: 'nothing found',
    }[c] || c;
  }
  function confidencePill(c) {
    if (c === 'PRECISE' || c === 'EXACT') return 'ok';
    if (c === 'NONE' || c === 'AREA_ONLY') return 'bad';
    return 'warn';
  }

  /* One restaurant, everything about it, and the two things the office does to
   * it — stop supply, start it again.
   *
   * Opened from a pin on the map and from the restaurant list, because those
   * are the two places somebody is looking at a restaurant and thinks "that
   * one". Both routes land here so there is one answer to "what can I do with
   * this customer", not two that drift apart.
   */
  function restaurantModal(place) {
    var held = place.supplyHold === true;
    var truck = isMobilePlace(place);
    var g = place.geocode || {};

    modal('<h3 style="margin:0 0 2px">' + esc(place.name) + '</h3>'
      + '<p class="tiny" style="margin:0 0 14px">' + esc(place.area || 'Area not recorded')
      + (place.customerId ? ' · customer ' + esc(place.customerId) : '') + '</p>'

      + (held
        ? '<div class="banner"><b>Supply is on hold.</b>'
          + (place.holdReason ? '<br>' + esc(place.holdReason) : '')
          + (place.holdSetAt ? '<br><span class="tiny">Since ' + dateTime(place.holdSetAt)
            + (place.holdSetBy ? ', by ' + esc(place.holdSetBy) : '') + '</span>' : '')
          + '</div>'
        : '')

      + '<div class="evidence">'
      + (place.address ? '<b>Address</b><br>' + esc(place.address) + '<br><br>' : '')
      + '<b>On the map</b><br>'
      + (truck
        ? 'A food truck — no fixed address, so it is not on the map and cannot be a planned stop. '
          + 'It is still a customer and still appears in reports.'
        : hasPin(place)
        ? place.lat.toFixed(5) + ', ' + place.lng.toFixed(5)
          + ' · geofence ' + (place.radiusM ? place.radiusM + ' m' : 'default')
          + (g.displayName ? '<br><span class="tiny">Found by Google as "' + esc(g.displayName) + '"</span>' : '')
          + (place.locationSource === 'places_name_differs'
            ? '<br><span class="tiny">Placed under a different name — worth a check.</span>' : '')
          + ' · <a href="https://www.google.com/maps/search/?api=1&query=' + place.lat + ',' + place.lng
          + '" target="_blank" rel="noopener">see the pin on Google Maps</a>'
        : 'No location yet, so it is not counted in any driver\'s kilometres.')
      + '</div>'
      + googleSection(place)

      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">'
      + (held
        ? '<button class="btn-primary" id="rmResume" style="width:auto">Resume supply</button>'
        : '<button class="btn-danger" id="rmHold" style="width:auto">Stop supply</button>')
      + '<button class="btn-outline" id="rmMobile" style="width:auto">'
      + (truck ? 'Not a food truck' : 'Mark as a food truck') + '</button>'
      + (!truck && (googleStatus(place) === 'moved' || googleStatus(place) === 'name_differs')
        ? '<button class="btn-primary" id="rmUseGoogle" style="width:auto">Use Google Maps\' position</button>' : '')
      + (truck ? ''
        : hasPin(place)
          ? '<button class="btn-outline" id="rmMove" style="width:auto">Move the pin</button>'
          : '<button class="btn-outline" id="rmPlace" style="width:auto">Place on the map</button>')
      + '<button class="btn-outline" id="rmClose" style="width:auto">Close</button>'
      + '</div>'
      + '<p id="rmMsg" class="tiny" style="margin:10px 0 0"></p>');

    var root = document.getElementById('modal');
    on('#rmClose', 'click', closeModal, root);

    on('#rmHold', 'click', function () {
      var reason = prompt('Why is supply to ' + place.name + ' on hold?\n\n'
        + 'The drivers see this, and so does whoever lifts it later.\n'
        + 'For example: payment overdue, shop closed for renovation, account under dispute.');
      if (reason === null) return;
      if (!reason.trim()) { document.getElementById('rmMsg').innerHTML = '<span class="err">A reason is needed.</span>'; return; }
      document.getElementById('rmMsg').textContent = 'Saving…';
      API.setHold(place.id, true, reason.trim())
        .then(function () { closeModal(); render(); })
        .catch(function (e) { document.getElementById('rmMsg').innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
    }, root);

    on('#rmResume', 'click', function () {
      document.getElementById('rmMsg').textContent = 'Saving…';
      API.setHold(place.id, false, null)
        .then(function () { closeModal(); render(); })
        .catch(function (e) { document.getElementById('rmMsg').innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
    }, root);

    on('#rmMobile', 'click', function () {
      if (truck && !confirm('Move ' + place.name + ' back to the restaurant list?\n\n'
        + 'It will be looked up and placed on the map like any other customer.')) return;
      if (!truck && !confirm('Mark ' + place.name + ' as a food truck?\n\n'
        + 'It will be taken off the map and out of route planning. Any pin it has is removed, '
        + 'because a pin on a truck geofences a place it may never park.')) return;
      document.getElementById('rmMsg').textContent = 'Saving…';
      API.setMobile(place.id, !truck)
        .then(function () { closeModal(); render(); })
        .catch(function (e) { document.getElementById('rmMsg').innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
    }, root);

    var reposition = function () {
      closeModal();
      pickOnMap(place.id, place.name, place.lat, place.lng);
    };
    on('#rmMove', 'click', reposition, root);
    on('#rmPlace', 'click', reposition, root);

    on('#rmUseGoogle', 'click', function () {
      var c = place.googleCheck || {};
      if (!confirm('Move ' + place.name + '\'s pin to where Google Maps has it'
        + (c.googleName ? ' ("' + c.googleName + '")' : '') + '?'
        + (c.distanceM != null ? '\n\nThat is ' + c.distanceM + ' m from where it is now.' : '')
        + '\n\nIts geofence moves with it, which changes which drives count as visits here from now on.')) return;
      document.getElementById('rmMsg').textContent = 'Saving…';
      API.useGooglePin(place.id)
        .then(function () { closeModal(); render(); })
        .catch(function (e) { document.getElementById('rmMsg').innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
    }, root);
  }

  function googleSection(place) {
    var st = googleStatus(place);
    if (!st) return '';
    var c = place.googleCheck || {};
    if (st === 'unchecked') {
      return '<div class="evidence"><b>Google Maps</b><br>Not checked yet. Use "Check with Google Maps" on the Restaurants tab.</div>';
    }
    var title = ({
      confirmed: 'Confirmed by Google Maps',
      moved: 'Google Maps has it somewhere else',
      name_differs: 'Google Maps has another name here',
      not_found: 'Not found on Google Maps',
    })[st];
    return '<div class="evidence"><b>' + esc(title) + '</b><br>' + esc(c.detail || '')
      + (c.googleAddress ? '<br><span class="tiny">' + esc(c.googleAddress) + '</span>' : '')
      + (Number.isFinite(c.googleLat) && st !== 'confirmed'
        ? '<br><a href="https://www.google.com/maps/search/?api=1&query=' + c.googleLat + ',' + c.googleLng
          + (c.googlePlaceId ? '&query_place_id=' + encodeURIComponent(c.googlePlaceId) : '')
          + '" target="_blank" rel="noopener">see Google\'s position</a>' : '')
      + '<br><span class="tiny">Checked ' + dateTime(c.at) + '</span></div>';
  }

  /* Supply currently stopped.
   *
   * On its own card, at the top, and only when there is something on it. A
   * hold is a decision somebody made on a Tuesday and meant to lift on the
   * Friday; buried in a three-thousand-row table it becomes a customer nobody
   * has supplied for four months and nobody can explain.
   */
  function heldCard(held) {
    if (!held.length) return '';
    return '<div class="card" style="border-color:#f0c9c6">'
      + '<h2>Supply on hold (' + held.length + ')</h2>'
      + '<p class="muted">Not offered to any driver and cannot go into a round. '
      + 'The geofence stays on, so if somebody goes anyway the visit is still recorded.</p>'
      + '<div style="overflow-x:auto;max-height:320px;overflow-y:auto"><table><thead><tr>'
      + '<th>Restaurant</th><th>Why</th><th>Since</th><th></th></tr></thead><tbody>'
      + held.map(function (p) {
        return '<tr><td><b>' + esc(p.name) + '</b>'
          + (p.area ? '<br><span class="tiny">' + esc(p.area) + '</span>' : '') + '</td>'
          + '<td>' + esc(p.holdReason || '—') + '</td>'
          + '<td class="tiny">' + (p.holdSetAt ? dateTime(p.holdSetAt) : '—')
          + (p.holdSetBy ? '<br>' + esc(p.holdSetBy) : '') + '</td>'
          + '<td><button class="btn-outline btn-sm" data-hold="' + esc(p.id) + '" data-on="0"'
          + ' data-name="' + esc(p.name) + '">Resume supply</button></td></tr>';
      }).join('')
      + '</tbody></table></div></div>';
  }

  /* The only restaurants that genuinely need a person.
   *
   * This card used to carry every button in the process. They have all moved
   * behind the one button above, because deciding in what order to run a
   * lookup, a retry and two kinds of bulk accept was never a judgement the
   * office wanted to make — it was just the machinery showing through.
   *
   * What is left here is the one thing a person really must do: place the
   * restaurants the lookup could not identify. It appears only once the
   * lookup has run and only for rows that need it, so on a good day this card
   * is not on the screen at all.
   */
  function needsYouCard(awaiting, counts) {
    // Nothing looked up yet: the button above is the whole story.
    if (!counts.total || !counts.unconfirmed) return '';

    return '<div class="card" style="border-color:#efdcb2">'
      + '<h2>' + counts.unconfirmed + ' need you to place them</h2>'
      + '<div class="banner">These are <b>not</b> on the map, so they are invisible to everything: no geofence, '
      + 'no visit detected, no kilometres, and drivers cannot pick them. The lookup could only find the middle of '
      + 'their area, which is not where the shop is.</div>'

      // The fast way, and the one that actually gets to zero.
      + '<p style="margin:14px 0 4px"><button class="btn-primary" id="btnPlaceAll" style="width:auto;font-size:1.05rem;padding:14px 26px">'
      + 'Place them one by one</button></p>'
      + '<p class="tiny" style="margin:0 0 14px">Opens the map on the first one and moves straight to the next when you save. '
      + 'Drag the pin onto the building, or search for a landmark to jump there. '
      + 'About ten seconds each — ' + counts.unconfirmed + ' of them is roughly '
      + Math.max(1, Math.round(counts.unconfirmed / 6)) + ' minutes.</p>'

      // The override, behind a deliberate tick. Offered because the office
      // asked for it and their reasoning is sound — a rough pin beats no pin —
      // but not something to hit by accident, so the button does not exist
      // until the box that explains it is ticked.
      + (counts.areaOnly
        ? '<div style="border-top:1px solid var(--line);padding-top:12px">'
          + '<label style="display:flex;gap:9px;align-items:flex-start;text-transform:none;letter-spacing:0;font-weight:400;color:var(--ink)">'
          + '<input type="checkbox" id="chkArea" style="width:18px;height:18px;flex:none;margin-top:2px">'
          + '<span class="tiny">I understand that putting the <b>' + counts.areaOnly + '</b> suburb-only matches on the map '
          + 'puts each pin at the middle of its area, not at the shop. A driver at the real restaurant may register no visit, '
          + 'and a driver passing the middle of that suburb may register one that never happened. '
          + 'I would rather have a rough pin than none, and will correct them later.</span></label>'
          + '<p style="margin:10px 0 0"><button class="btn-outline" id="btnAcceptArea" style="width:auto" disabled>'
          + 'Put the ' + counts.areaOnly + ' suburb matches on the map anyway</button>'
          + '<span id="areaMsg" class="tiny"></span></p>'
          + '</div>'
        : '')

      + '<p class="muted" style="margin-top:14px">A better fix, if you have the data: add street addresses for these in your '
      + 'spreadsheet and upload it again. An address usually finds the building on the first try.</p>'

      + '<div style="overflow-x:auto;max-height:420px;overflow-y:auto;margin-top:10px"><table><thead><tr>'
      + '<th>Your name for it</th><th>Area</th><th>What was found</th><th>Precision</th><th>Place it</th>'
      + '</tr></thead><tbody>'
      + awaiting.filter(function (p) { return p.locationStatus !== 'pending'; }).map(function (p) {
        var g = p.geocode || {};
        var c = p.candidate || null;
        return '<tr>'
          + '<td><b>' + esc(p.name) + '</b>' + (p.address ? '<br><span class="tiny">' + esc(p.address) + '</span>' : '') + '</td>'
          + '<td>' + esc(p.area || '—') + '</td>'
          // The business name is the whole decision for a person scanning this
          // list, so it leads, in the same weight as their own name above.
          + '<td>' + (g.displayName ? '<b>' + esc(g.displayName) + '</b><br>' : '')
          + (g.formattedAddress ? '<span class="tiny">' + esc(g.formattedAddress) + '</span>' : (g.displayName ? '' : '<span class="tiny">not looked up yet</span>'))
          + (g.alternatives ? '<br><span class="tiny">' + g.alternatives + ' other possible match(es)</span>' : '') + '</td>'
          + '<td>' + (g.confidence ? '<span class="pill ' + confidencePill(g.confidence) + '">' + esc(confidenceLabel(g.confidence)) + '</span>' : '—') + '</td>'
          + '<td style="white-space:nowrap">'
          + (c ? '<button class="btn-outline btn-sm confirm-cand" data-id="' + esc(p.id) + '">Use this</button> ' : '')
          // Clicking a map is the only sane way to place a pin by hand. Typing
          // latitude and longitude is not a fallback anybody actually uses.
          + '<button class="btn-outline btn-sm pick-map" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '"'
          + (c ? ' data-lat="' + c.lat + '" data-lng="' + c.lng + '"' : '') + '>Pick on map</button>'
          + '</td></tr>';
      }).join('')
      + '</tbody></table></div>'
      + (counts.unconfirmed > awaiting.length
        ? '<p class="tiny">Showing the first ' + awaiting.length + ' of ' + counts.unconfirmed + '.</p>'
        : '')
      + '</div>';
  }

  /* Placing one pin by hand.
   *
   * The office was being asked to type a latitude and a longitude, which is not
   * something anybody can do for a restaurant they know by name — they would
   * have to go and look it up somewhere else and copy two numbers across. So
   * this opens the map at the geocoder's best guess and asks for a click.
   */
  function pickOnMap(id, name, lat, lng) {
    placeQueue([{ id: id, name: name, candidate: { lat: lat, lng: lng } }], 0);
  }

  /* Placing the stragglers, one after another, without leaving the map.
   *
   * Ninety restaurants nobody can identify automatically is not ninety
   * decisions — it is one job, done ninety times. Closing a dialog, finding
   * the next row in a table and opening it again turns twenty minutes of work
   * into an afternoon nobody ever finishes, and a restaurant with no pin is
   * invisible to the whole system. So the map stays open and moves on: place,
   * save, next.
   *
   * @param queue [{ id, name, area, candidate: {lat,lng}, geocode }]
   * @param i     where in the queue we are
   */
  function placeQueue(queue, i) {
    var p = queue[i];
    if (!p) { closeModal(); render(); return; }

    var c = p.candidate || {};
    var g = p.geocode || {};
    var start = (typeof c.lat === 'number' && isFinite(c.lat) && typeof c.lng === 'number' && isFinite(c.lng))
      ? { lat: c.lat, lng: c.lng } : null;
    var many = queue.length > 1;

    modal((many ? '<p class="tiny" style="margin:0 0 2px">' + (i + 1) + ' of ' + queue.length + '</p>' : '')
      + '<h3 style="margin:0 0 2px">' + esc(p.name) + '</h3>'
      + '<p class="tiny" style="margin:0 0 10px">'
      + (p.area ? esc(p.area) + ' · ' : '')
      + (g.formattedAddress ? 'lookup found: ' + esc(g.formattedAddress) : 'nothing useful was found for this one')
      + '</p>'
      + '<p class="tiny" style="margin:0 0 8px">'
      + (start
        ? 'The pin starts where the lookup guessed — usually the middle of the area. <b>Drag it onto the building.</b>'
        : 'Search below, or zoom to the area and click the building.')
      + '</p>'
      + '<div style="display:flex;gap:8px;margin-bottom:8px">'
      + '<input id="pickFind" placeholder="Type an area or landmark to jump there" style="flex:1">'
      + '<button class="btn-outline btn-sm" id="pickFindGo">Find</button>'
      + '</div>'
      + '<div id="pickMap" style="width:100%;height:400px;border-radius:12px;border:1px solid var(--line);background:#e3e6ef"></div>'
      + '<p id="pickMsg" class="tiny" style="margin:8px 0 10px">No point chosen yet.</p>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap">'
      + '<button class="btn-primary" id="pickSave" style="width:auto" disabled>'
      + (many && i < queue.length - 1 ? 'Save and next' : 'Save') + '</button>'
      + (many ? '<button class="btn-outline" id="pickSkip" style="width:auto">Skip</button>' : '')
      + '<button class="btn-outline" id="pickCancel" style="width:auto">' + (many ? 'Stop' : 'Cancel') + '</button>'
      + '</div>');

    var root = document.getElementById('modal');
    var chosen = start ? { lat: c.lat, lng: c.lng } : null;
    var saveBtn = document.getElementById('pickSave');
    var msg = document.getElementById('pickMsg');
    var moved = false;

    function show() {
      msg.innerHTML = chosen
        ? (moved || !start
          ? '<span class="ok-msg">Pin set: ' + chosen.lat.toFixed(5) + ', ' + chosen.lng.toFixed(5) + '</span>'
          : 'Still on the lookup\'s guess — drag it onto the building before saving.')
        : 'No point chosen yet.';
      saveBtn.disabled = !chosen;
    }
    show();

    // The modal has only just been written into the page; the map needs the
    // container to have a size before it measures itself.
    setTimeout(function () {
      var m = MAPS.create('pickMap', { center: start || undefined, zoom: start ? 15 : 12 });
      if (!m) { msg.innerHTML = '<span class="err">The map could not be loaded.</span>'; return; }
      var marker = null;
      function place(p, byHand) {
        chosen = { lat: p.lat, lng: p.lng };
        if (byHand) moved = true;
        if (marker) marker.setPosition(chosen);
        else {
          marker = MAPS.pin(m, 'pick', chosen, {
            color: '#D7262F', draggable: true, title: 'Drag onto the building', z: 900,
            onMove: function (q) { place(q, true); },
          });
        }
        show();
      }
      m.ready(function () { mapProviderNote('pickMap', m); if (start) place(start, false); });
      m.onClick(function (p) { place(p, true); });

      // Jumping to an area by name: Google Maps search when Google Maps is in
      // use, OpenStreetMap's otherwise. Only moves the view, never the pin.
      function find() {
        var q = (document.getElementById('pickFind').value || '').trim();
        if (!q) return;
        msg.textContent = 'Looking…';
        MAPS.search(q).then(function (hit) {
          if (!hit) { msg.innerHTML = '<span class="err">Nothing found for that.</span>'; return; }
          m.flyTo(hit, 16);
          show();
        }).catch(function () { msg.innerHTML = '<span class="err">Search is unavailable just now.</span>'; });
      }
      on('#pickFindGo', 'click', find, root);
      document.getElementById('pickFind').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); find(); }
      });
    }, 60);

    function next() { placeQueue(queue, i + 1); }

    on('#pickCancel', 'click', function () { closeModal(); render(); }, root);
    if (many) on('#pickSkip', 'click', next, root);
    on('#pickSave', 'click', function () {
      if (!chosen) return;
      saveBtn.disabled = true;
      API.confirmLocation(p.id, chosen.lat, chosen.lng)
        .then(function () {
          if (i < queue.length - 1) return next();
          closeModal();
          return render();
        })
        .catch(function (e) { saveBtn.disabled = false; msg.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
    }, root);
  }

  function bindGeocodingKey() {
    on('#btnGeoKey', 'click', function () {
      var v = (document.getElementById('geoKey').value || '').trim();
      var m = document.getElementById('geoKeyMsg');
      if (!v) { m.innerHTML = '<span class="err">Paste the key first.</span>'; return; }
      m.textContent = 'Saving…';
      API.setIntegrationSecret('geocoding', v).then(function () {
        document.getElementById('geoKey').value = '';
        m.innerHTML = '<span class="ok-msg">Saved. Import your restaurants, then use Find locations.</span>';
      }).catch(function (e) { m.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
    });
  }

  /* What is left after the one button: placing the handful the lookup could
   * not identify. The lookup, the retry and the bulk accepts all used to be
   * buttons here; they are one button now, so this binds only the per-row
   * actions. */
  function bindAwaiting(awaiting) {
    // The queue: every row still waiting, in the order the server sent them,
    // which puts the ones a person can decide quickly first.
    on('#btnPlaceAll', 'click', function () {
      var queue = (awaiting || []).filter(function (p) { return p.locationStatus !== 'pending'; });
      if (!queue.length) { render(); return; }
      placeQueue(queue, 0);
    });

    // The override arms its own button. Ticking the box is the decision; the
    // button is just where it happens.
    var chk = document.getElementById('chkArea');
    if (chk) {
      chk.addEventListener('change', function () {
        document.getElementById('btnAcceptArea').disabled = !chk.checked;
      });
    }
    on('#btnAcceptArea', 'click', function () {
      var btn = document.getElementById('btnAcceptArea');
      var msg = document.getElementById('areaMsg');
      var total = 0;
      btn.disabled = true;
      function round() {
        msg.innerHTML = ' Placing… <b>' + total + '</b>';
        API.acceptCandidates('area', 1000).then(function (out) {
          total += out.accepted;
          if (out.remaining > 0 && out.accepted > 0) return round();
          msg.innerHTML = ' <span class="ok-msg"><b>' + total + '</b> placed at their area centre. '
            + 'Find them later under Restaurants → filter "placed under a different name" is not this one; '
            + 'they are marked in the audit log.</span>';
          setTimeout(render, 1600);
          return null;
        }).catch(function (e) {
          btn.disabled = false;
          msg.innerHTML = ' <span class="err">' + esc(e.message) + '</span>';
        });
      }
      round();
    });

    document.querySelectorAll('.confirm-cand').forEach(function (b) {
      b.addEventListener('click', function () {
        API.confirmLocation(b.getAttribute('data-id'), null, null)
          .then(render).catch(function (e) { alert(e.message); });
      });
    });
    document.querySelectorAll('.pick-map').forEach(function (b) {
      b.addEventListener('click', function () {
        pickOnMap(
          b.getAttribute('data-id'),
          b.getAttribute('data-name'),
          Number(b.getAttribute('data-lat')),
          Number(b.getAttribute('data-lng')),
        );
      });
    });
  }

  // A just-imported restaurant has no coordinates yet. That is the normal state
  // of every row the office uploads, not an error, so the table has to say so
  // rather than assume a pin is there.
  function hasPin(p) {
    return typeof p.lat === 'number' && isFinite(p.lat) && typeof p.lng === 'number' && isFinite(p.lng);
  }

  // The office's own export is over three thousand rows. Drawing them all at
  // once locks the browser up, so a page is drawn at a time — and the search
  // box runs over the whole list, not just over what is on screen.
  var PLACE_PAGE = 200;
  var placeCache = {};
  var placeShown = {};

  function placeTable(list, kind) {
    placeCache[kind] = list;
    placeShown[kind] = PLACE_PAGE;
    if (!list.length) return '<p class="muted">None yet.</p>';
    return (list.length > PLACE_PAGE
      ? '<input class="place-search" data-kind="' + kind + '" placeholder="Search by name, area or customer ID" style="max-width:360px;margin-bottom:10px">'
      : '')
      + '<div style="overflow-x:auto"><table><thead><tr><th>Name</th><th>Customer ID</th><th>Area</th><th>Coordinates</th><th>Geofence</th><th>Status</th><th></th></tr></thead>'
      + '<tbody data-placebody="' + kind + '"></tbody></table></div>'
      + '<p class="tiny" data-placefoot="' + kind + '"></p>';
  }

  function placeMatches(p, q) {
    if (!q) return true;
    return ((p.name || '') + ' ' + (p.area || '') + ' ' + (p.customerId || '') + ' ' + (p.address || ''))
      .toLowerCase().indexOf(q) !== -1;
  }

  function fillPlaceTable(kind, q) {
    var body = document.querySelector('[data-placebody="' + kind + '"]');
    var foot = document.querySelector('[data-placefoot="' + kind + '"]');
    if (!body) return;
    var all = (placeCache[kind] || []).filter(function (p) { return placeMatches(p, q); });
    var rows = all.slice(0, placeShown[kind]);
    body.innerHTML = rows.map(function (p) {
      return '<tr>'
        + '<td><b>' + esc(p.name) + '</b>' + (p.address ? '<br><span class="tiny">' + esc(p.address) + '</span>' : '') + '</td>'
        + '<td>' + esc(p.customerId || '—') + '</td>'
        + '<td>' + esc(p.area || '—') + '</td>'
        + '<td class="tiny">' + (hasPin(p)
          ? p.lat.toFixed(5) + ', ' + p.lng.toFixed(5)
          : '<span class="pill warn">no location yet</span>') + '</td>'
        + '<td>' + (p.radiusM ? p.radiusM + ' m' : 'default') + '</td>'
        + '<td>' + (p.supplyHold === true
          ? '<span class="pill bad">supply on hold</span>'
            + (p.holdReason ? '<br><span class="tiny">' + esc(p.holdReason) + '</span>' : '')
          : '<span class="pill ' + (p.active === false ? 'idle' : 'active') + '">'
            + (p.active === false ? 'inactive' : 'active') + '</span>') + '</td>'
        + '<td style="white-space:nowrap">'
        + (kind === 'restaurants'
          ? '<button class="btn-outline btn-sm" data-hold="' + esc(p.id) + '" data-on="'
            + (p.supplyHold === true ? '0' : '1') + '" data-name="' + esc(p.name) + '">'
            + (p.supplyHold === true ? 'Resume supply' : 'Hold supply') + '</button> '
          : '')
        + '<button class="btn-outline btn-sm" data-editplace="' + esc(p.id) + '" data-kind="' + kind + '">Edit</button></td>'
        + '</tr>';
    }).join('');
    if (foot) {
      foot.innerHTML = all.length > rows.length
        ? 'Showing ' + rows.length + ' of ' + all.length + '. '
          + '<button class="link-sm" data-placemore="' + kind + '">Show ' + Math.min(PLACE_PAGE, all.length - rows.length) + ' more</button>'
        : (all.length ? all.length + ' shown.' : 'Nothing matches that search.');
      var more = foot.querySelector('[data-placemore]');
      if (more) {
        more.addEventListener('click', function () {
          placeShown[kind] += PLACE_PAGE;
          var input = document.querySelector('.place-search[data-kind="' + kind + '"]');
          fillPlaceTable(kind, input ? input.value.trim().toLowerCase() : '');
        });
      }
    }
  }

  /* Putting a restaurant's supply on hold, and taking it off again.
   *
   * Delegated from the view, because the rows are drawn a page at a time and
   * redrawn on every search. A reason is required going on and not coming off:
   * a hold nobody explained is one nobody can lift with any confidence a week
   * later, and it is what the driver sees on their phone.
   */
  // #view survives every render — only its contents are replaced — so a
  // delegated listener attached per render would stack, and by the tenth
  // render one click would fire ten confirmations. Attached once.
  var holdBound = false;
  var editPlaceBound = false;

  function bindHoldButtons() {
    if (holdBound) return;
    holdBound = true;
    view().addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-hold]') : null;
      if (!btn) return;
      var id = btn.getAttribute('data-hold');
      var name = btn.getAttribute('data-name');
      var turningOn = btn.getAttribute('data-on') === '1';

      if (!turningOn) {
        if (!confirm('Resume supply to ' + name + '? Drivers will be able to choose it again.')) return;
        btn.disabled = true;
        API.setHold(id, false, null).then(render).catch(function (ex) {
          btn.disabled = false; alert(ex.message);
        });
        return;
      }

      var reason = prompt('Why is supply to ' + name + ' on hold?\n\n'
        + 'The drivers see this, and so does whoever lifts it later.\n'
        + 'For example: payment overdue, shop closed for renovation, account under dispute.');
      if (reason === null) return;
      if (!reason.trim()) { alert('A reason is needed.'); return; }
      btn.disabled = true;
      API.setHold(id, true, reason.trim()).then(render).catch(function (ex) {
        btn.disabled = false; alert(ex.message);
      });
    });
  }

  function bindPlaceTables() {
    Object.keys(placeCache).forEach(function (kind) { fillPlaceTable(kind, ''); });
    document.querySelectorAll('.place-search').forEach(function (input) {
      input.addEventListener('input', function () {
        var kind = input.getAttribute('data-kind');
        placeShown[kind] = PLACE_PAGE;
        fillPlaceTable(kind, input.value.trim().toLowerCase());
      });
    });
  }

  function placeForm(kind) {
    return '<details style="margin-top:12px"><summary style="cursor:pointer;font-weight:600;font-size:.9rem">Add a ' + (kind === 'facilities' ? 'facility' : 'location') + '</summary>'
      + '<div style="margin-top:12px" data-form="' + kind + '">'
      + '<div class="row2"><div class="field"><label>Name</label><input data-f="name"></div>'
      + (kind === 'restaurants' ? '<div class="field"><label>Customer ID</label><input data-f="customerId" placeholder="matches the order system"></div>' : '<div class="field"><label>Area</label><input data-f="area"></div>')
      + '</div>'
      + '<div class="field"><label>Address</label><input data-f="address"></div>'
      + '<div class="row3"><div class="field"><label>Latitude</label><input data-f="lat" inputmode="decimal"></div>'
      + '<div class="field"><label>Longitude</label><input data-f="lng" inputmode="decimal"></div>'
      + '<div class="field"><label>Geofence radius (m)</label><input data-f="radiusM" inputmode="numeric" placeholder="' + (kind === 'facilities' ? '150' : '80') + '"></div></div>'
      + '<p class="err" data-err hidden></p>'
      + '<button class="btn-primary" data-save="' + kind + '">Save</button>'
      + '</div></details>';
  }

  function bindPlaceForms() {
    on('[data-save]', 'click', function (e) {
      var kind = e.currentTarget.dataset.save;
      var form = document.querySelector('[data-form="' + kind + '"]');
      var body = {};
      form.querySelectorAll('[data-f]').forEach(function (el) {
        var v = el.value.trim();
        if (!v) return;
        body[el.dataset.f] = ['lat', 'lng', 'radiusM'].indexOf(el.dataset.f) !== -1 ? Number(v) : v;
      });
      var err = form.querySelector('[data-err]');
      err.hidden = true;
      API.createPlace(kind, body).then(render).catch(function (ex) { err.textContent = ex.message; err.hidden = false; });
    });
    // Delegated, and attached once: the rows are drawn a page at a time so the
    // buttons do not all exist when this runs, and #view outlives every render
    // so re-attaching would stack a listener per visit to the tab.
    if (editPlaceBound) return;
    editPlaceBound = true;
    view().addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-editplace]') : null;
      if (!btn) return;
      var id = btn.dataset.editplace;
      var kind = btn.dataset.kind;
      API.places(kind).then(function (list) {
        var p = list.find(function (x) { return x.id === id; });
        modal('<h3>Edit ' + esc(p.name) + '</h3>'
          + '<div class="field"><label>Name</label><input id="eName" value="' + esc(p.name) + '"></div>'
          + (kind === 'restaurants' ? '<div class="field"><label>Customer ID</label><input id="eCust" value="' + esc(p.customerId || '') + '"></div>' : '')
          + '<div class="field"><label>Address</label><input id="eAddr" value="' + esc(p.address || '') + '"></div>'
          + '<div class="row3"><div class="field"><label>Latitude</label><input id="eLat" inputmode="decimal" value="' + (hasPin(p) ? p.lat : '') + '"></div>'
          + '<div class="field"><label>Longitude</label><input id="eLng" inputmode="decimal" value="' + (hasPin(p) ? p.lng : '') + '"></div>'
          + '<div class="field"><label>Radius (m)</label><input id="eRad" value="' + (p.radiusM || '') + '"></div></div>'
          + '<div class="field"><label>Active</label><select id="eActive"><option value="1"' + (p.active !== false ? ' selected' : '') + '>Active</option><option value="0"' + (p.active === false ? ' selected' : '') + '>Inactive</option></select></div>'
          + '<p class="tiny">Changing a geofence does not change any ride already calculated. Recalculate from Settings if you want past days reworked with the new radius.</p>'
          + '<p id="eErr" class="err" hidden></p>'
          + '<button class="btn-primary" id="eSave">Save</button> <button class="btn-outline" id="eCancel">Cancel</button>');
        var root = document.getElementById('modal');
        on('#eCancel', 'click', closeModal, root);
        on('#eSave', 'click', function () {
          var body = {
            name: document.getElementById('eName').value.trim(),
            address: document.getElementById('eAddr').value.trim() || null,
            lat: Number(document.getElementById('eLat').value),
            lng: Number(document.getElementById('eLng').value),
            radiusM: document.getElementById('eRad').value ? Number(document.getElementById('eRad').value) : null,
            active: document.getElementById('eActive').value === '1',
          };
          if (kind === 'restaurants') body.customerId = document.getElementById('eCust').value.trim() || null;
          API.updatePlace(kind, id, body).then(function () { closeModal(); render(); })
            .catch(function (ex) { var el = document.getElementById('eErr'); el.textContent = ex.message; el.hidden = false; });
        }, root);
      });
    });
  }

  // ── Deliveries / integration ───────────────────────────────────────────
  function renderOrders() {
    return Promise.all([API.sources(), API.orders({})]).then(function (r) {
      var s = r[0];
      var orders = r[1];
      set('<div class="card"><h2>Order sources</h2>'
        + '<table><thead><tr><th>Source</th><th>What it is</th><th>Status</th><th></th></tr></thead><tbody>'
        + s.sources.map(function (src) {
          return '<tr><td><b>' + esc(src.name) + '</b></td><td class="tiny">' + esc(src.description) + '</td>'
            + '<td>' + (src.configured ? '<span class="pill live">ready</span>' : '<span class="pill warn">not configured</span>') + '</td>'
            + '<td>' + (src.name !== 'manual' ? '<button class="btn-outline btn-sm" data-sync="' + esc(src.name) + '"' + (src.configured ? '' : ' disabled') + '>Sync today</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table>'
        + '<p class="tiny" style="margin-top:10px">Order records are what raise a restaurant visit from <b>likely</b> to <b>verified</b>. Without them most visits stay at MEDIUM confidence — that is the honest ceiling, not a bug.</p>'
        + '</div>'

        + '<div class="card"><h2>Import orders (CSV)</h2>'
        + '<p class="muted">Columns: <code>order_id, customer_id, driver_code, ordered_at, window_start, window_end, delivered_at, status, lat, lng</code>. Times without a timezone are read as IST.</p>'
        + '<input type="file" id="ordFile" accept=".csv,text/csv" style="margin-bottom:10px">'
        + '<div><button class="btn-primary" id="btnOrdImport">Import</button></div>'
        + '<p id="ordMsg" class="muted" style="margin-top:10px"></p></div>'

        + '<div class="card"><h2>Recent orders (' + orders.length + ')</h2>'
        + (orders.length ? '<div style="overflow-x:auto"><table><thead><tr><th>Order</th><th>Customer</th><th>Driver</th><th>Ordered</th><th>Window</th><th>Status</th><th>Source</th></tr></thead><tbody>'
          + orders.slice(0, 200).map(function (o) {
            return '<tr><td>' + esc(o.externalId || o.id) + '</td><td>' + esc(o.customerId || '—') + '</td>'
              + '<td>' + esc(o.assignedDriverId ? o.assignedDriverId.slice(0, 8) : '—') + '</td>'
              + '<td>' + dateTime(o.orderedAt) + '</td>'
              + '<td class="tiny">' + (o.windowStart ? time(o.windowStart) + '–' + time(o.windowEnd) : '—') + '</td>'
              + '<td>' + esc(o.status || '—') + '</td><td>' + esc(o.source) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
          : '<p class="muted">No order records yet. Until there are, delivery matching has nothing to match against and every visit is reported as an unmatched visit.</p>')
        + '</div>'

        + '<div class="card"><h2>Integration log</h2>'
        + (s.recentLogs.length ? '<table><thead><tr><th>When</th><th>Source</th><th>Operation</th><th>Result</th></tr></thead><tbody>'
          + s.recentLogs.map(function (l) {
            return '<tr><td>' + dateTime(l.at) + '</td><td>' + esc(l.source) + '</td><td>' + esc(l.op) + '</td>'
              + '<td>' + (l.ok ? '<span class="pill live">' + (l.count || 0) + ' records</span>' : '<span class="pill bad">' + esc(l.error || 'failed') + '</span>') + '</td></tr>';
          }).join('') + '</tbody></table>' : '<p class="muted">No syncs yet.</p>')
        + '</div>');

      on('[data-sync]', 'click', function (e) {
        var src = e.currentTarget.dataset.sync;
        e.currentTarget.disabled = true;
        API.syncOrders(src, {}).then(function (out) { alert(out.imported + ' order(s) imported.'); render(); })
          .catch(function (ex) { alert(ex.message); render(); });
      });
      on('#btnOrdImport', 'click', function () {
        var f = document.getElementById('ordFile').files[0];
        var msg = document.getElementById('ordMsg');
        if (!f) { msg.textContent = 'Choose a CSV file first.'; return; }
        msg.textContent = 'Importing…';
        f.text().then(function (csv) { return API.importOrders(csv); }).then(function (out) {
          msg.innerHTML = '<b>' + out.imported + ' order(s) imported.</b>'
            + (out.rejected.length ? '<br>' + out.rejected.length + ' rejected: <span class="tiny">' + esc(out.rejected.slice(0, 10).map(function (x) { return (x.externalId || '?') + ': ' + x.problems.join(', '); }).join('; ')) + '</span>' : '')
            + (out.parseProblems && out.parseProblems.length ? '<br><span class="tiny">' + esc(out.parseProblems.slice(0, 10).join('; ')) + '</span>' : '');
          setTimeout(render, 1500);
        }).catch(function (ex) { msg.innerHTML = '<span class="err">' + esc(ex.message) + '</span>'; });
      });
    });
  }

  // ── Reports ────────────────────────────────────────────────────────────
  var REPORT_LIST = [
    ['driver_distance', 'Driver distance (daily / weekly / monthly)'],
    ['business_km', 'Modern Dairy business kilometres'],
    ['restaurant_visits', 'Restaurant visits'],
    ['delivery_matching', 'Delivery matching'],
    ['gps_reliability', 'GPS tracking reliability'],
    ['route_anomaly', 'Route anomalies'],
    ['classification_audit', 'Manual classification audit'],
  ];

  function renderReports() {
    var from = todayISO();
    return API.drivers(true).then(function (drivers) {
      set('<div class="card"><h2>Report</h2>'
        + '<div class="bar">'
        + '<div style="min-width:260px"><label for="rName">Report</label><select id="rName">'
        + REPORT_LIST.map(function (x) { return '<option value="' + x[0] + '">' + esc(x[1]) + '</option>'; }).join('') + '</select></div>'
        + '<div><label for="rFrom">From</label><input id="rFrom" type="date" value="' + from + '"></div>'
        + '<div><label for="rTo">To</label><input id="rTo" type="date" value="' + from + '"></div>'
        + '<div><label for="rDriver">Driver</label><select id="rDriver"><option value="">All drivers</option>'
        + drivers.map(function (d) { return '<option value="' + esc(d.id) + '">' + esc(d.driverCode + ' — ' + d.name) + '</option>'; }).join('') + '</select></div>'
        + '<div><label for="rConf">Confidence</label><select id="rConf"><option value="">Any</option><option>HIGH</option><option>MEDIUM</option><option>LOW</option><option>UNKNOWN</option></select></div>'
        + '<div><label for="rQual">GPS quality</label><select id="rQual"><option value="">Any</option><option>good</option><option>fair</option><option>poor</option><option>no_data</option></select></div>'
        + '<div><button class="btn-primary" id="btnRun">Run</button></div>'
        + '<div><button class="btn-outline" id="btnCsv">CSV</button></div>'
        + '<div><button class="btn-outline" id="btnXls">Excel</button></div>'
        + '<div><button class="btn-outline" id="btnPrint">Print</button></div>'
        + '</div></div>'
        + '<div id="reportOut"></div>'

        // Where they actually drove. Folded away and loaded on request: it
        // costs one request per ride, which is not something to spend every
        // time somebody changes a date filter.
        + '<details class="card"><summary class="disclose">Show where they drove on a map</summary>'
        + '<div style="margin-top:14px">'
        + '<p class="muted">Draws the routes for the rides in the period above — the same rides the table is built from. '
        + 'Restaurants are shown in red so you can see which journeys went to a customer and which did not.</p>'
        + '<p><button class="btn-primary" id="btnTracks" style="width:auto">Draw the routes</button> '
        + '<span id="tracksMsg" class="tiny"></span></p>'
        + '<div id="tracksMap" style="width:100%;height:520px;border-radius:14px;border:1px solid var(--line);background:#e3e6ef"></div>'
        + '<div id="tracksLegend" class="legend"></div>'
        + '</div></details>');

      on('#btnRun', 'click', runReport);
      on('#btnCsv', 'click', function () { exportReport('csv'); });
      on('#btnXls', 'click', function () { exportReport('xls'); });
      on('#btnPrint', 'click', function () { window.print(); });
      on('#btnTracks', 'click', drawReportTracks);
      runReport();
    });
  }

  // One colour per driver, cycled. Eight is enough to tell apart at a glance;
  // beyond that the legend is doing the work anyway.
  var TRACK_COLOURS = ['#1B2A6B', '#D7262F', '#1a7a4c', '#8a5f14', '#6b2fb3', '#0f7b8a', '#b3263f', '#3d4a5c'];

  // Each ride's GPS has to be fetched separately, so this is capped. Twenty
  // routes is already a busy picture; two hundred would be a smear and a
  // minute of waiting.
  var MAX_TRACKS = 20;

  function drawReportTracks() {
    var btn = document.getElementById('btnTracks');
    var msg = document.getElementById('tracksMsg');
    var legend = document.getElementById('tracksLegend');
    btn.disabled = true;
    msg.textContent = ' Finding the rides…';

    var params = reportParams();
    API.rides({ from: params.from, to: params.to, driverId: params.driverId }).then(function (rides) {
      var list = (rides || []).slice(0, MAX_TRACKS);
      if (!list.length) {
        msg.textContent = ' No rides in this period.';
        btn.disabled = false;
        return null;
      }

      // Sequential on purpose: twenty parallel point downloads from forty
      // drivers' worth of GPS is a good way to be rate-limited by our own API.
      var tracks = [];
      var colourOf = {};
      var next = 0;
      function step() {
        if (next >= list.length) return Promise.resolve();
        var r = list[next];
        next += 1;
        msg.textContent = ' Loading ride ' + next + ' of ' + list.length + '…';
        return API.ride(r.id, true).then(function (full) {
          // Only the fixes the calculation counted, split wherever the GPS
          // went silent: a spike or a silence is not a road anybody drove.
          var rp = full.replay || { points: [], gaps: [] };
          var gapAfter = {};
          (rp.gaps || []).forEach(function (g) { gapAfter[g.fromTs] = true; });
          var lines = [];
          var cur = [];
          rp.points.forEach(function (q) {
            if (!q.used) return;
            cur.push({ lat: q.lat, lng: q.lng });
            if (gapAfter[q.ts]) { if (cur.length > 1) lines.push(cur); cur = []; }
          });
          if (cur.length > 1) lines.push(cur);
          if (lines.length) {
            if (!colourOf[r.driverId]) {
              colourOf[r.driverId] = TRACK_COLOURS[Object.keys(colourOf).length % TRACK_COLOURS.length];
            }
            tracks.push({
              rideId: r.id,
              label: (r.driverName || r.driverId) + ' · ' + (r.dayKey || ''),
              color: colourOf[r.driverId],
              lines: lines,
              driverId: r.driverId,
              driverName: r.driverName || r.driverId,
            });
          }
          return step();
        }).catch(function () { return step(); });   // one bad ride must not stop the picture
      }

      return step().then(function () {
        if (!tracks.length) {
          msg.textContent = ' These rides have no usable GPS.';
          btn.disabled = false;
          return;
        }
        msg.innerHTML = ' <b>' + tracks.length + ' route(s) drawn.</b>'
          + (rides.length > MAX_TRACKS ? ' Showing the first ' + MAX_TRACKS + ' of ' + rides.length + '.' : '');

        var map = state.tracksMap;
        if (!map) {
          map = MAPS.create('tracksMap');
          state.tracksMap = map;
        }
        if (!map) { msg.textContent = ' The map could not be loaded.'; btn.disabled = false; return; }

        map.ready(function () {
          if (state.tracksMap !== map) return;
          mapProviderNote('tracksMap', map);
          MAPS.drawTracks(map, 'tracks', tracks);
          API.places('restaurants').then(function (rs) {
            MAPS.drawPlaces(map, 'tracks-places',
              rs.filter(function (p) { return p.active !== false && hasPin(p); }), '#D7262F');
          }).catch(function () { /* the routes are the point; pins are a bonus */ });
          var all = [];
          tracks.forEach(function (t) { t.lines.forEach(function (l) { all = all.concat(l); }); });
          MAPS.fit(map, all);
        });

        var seen = {};
        legend.innerHTML = tracks.filter(function (t) {
          if (seen[t.driverId]) return false;
          seen[t.driverId] = true;
          return true;
        }).map(function (t) {
          return '<span><i style="background:' + t.color + '"></i>' + esc(t.driverName) + '</span>';
        }).join('');
        btn.disabled = false;
      });
    }).catch(function (e) {
      msg.innerHTML = ' <span class="err">' + esc(e.message) + '</span>';
      btn.disabled = false;
    });
  }

  function reportParams() {
    var f = document.getElementById('rFrom').value;
    var t = document.getElementById('rTo').value;
    return {
      from: f ? Date.parse(f + 'T00:00:00') : undefined,
      to: t ? Date.parse(t + 'T23:59:59') : undefined,
      driverId: document.getElementById('rDriver').value || undefined,
      confidence: document.getElementById('rConf').value || undefined,
      quality: document.getElementById('rQual').value || undefined,
    };
  }

  function runReport() {
    var name = document.getElementById('rName').value;
    var out = document.getElementById('reportOut');
    out.innerHTML = spinner('Running…');
    API.report(name, reportParams()).then(function (r) {
      var sum = r.meta.summary;
      out.innerHTML = '<div class="card"><h2>' + esc(r.meta.title) + '</h2>'
        + (r.meta.note ? '<div class="banner">' + esc(r.meta.note) + '</div>' : '')
        + '<div class="grid metrics" style="margin-bottom:12px">'
        + metric(sum.rides, 'Rides')
        + metric(km(sum.km.verifiedBusiness), 'Verified business', 'ok')
        + metric(km(sum.km.likelyBusiness), 'Likely business', 'warn')
        + metric(km(sum.km.personal), 'Personal')
        + metric(km(sum.km.unknown), 'Unknown', sum.km.unknown ? 'warn' : '')
        + metric(km(sum.km.dayTotal), 'Total tracked')
        + metric(sum.visits, 'Restaurant visits')
        + metric(sum.pendingReview, 'Needs review', sum.pendingReview ? 'warn' : '')
        + '</div>'
        + '<div style="overflow-x:auto">' + tableFrom(r.columns, r.rows) + '</div>'
        + '<p class="tiny" style="margin-top:10px">' + r.rows.length + ' row(s). Verified business distance counts HIGH-confidence segments only; everything less certain is shown in its own column and never folded in.</p>'
        + '</div>';
    }).catch(function (e) { out.innerHTML = errBox(e); });
  }

  function tableFrom(columns, rows) {
    if (!rows.length) return '<p class="muted">No rows for this period.</p>';
    return '<table><thead><tr>' + columns.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>'
      + rows.slice(0, 500).map(function (r) {
        return '<tr>' + columns.map(function (c) { return '<td>' + esc(r[c.key]) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table>';
  }

  function exportReport(format) {
    var name = document.getElementById('rName').value;
    var params = reportParams();
    params.format = format;
    API.download('/admin/reports/' + name, params, name + '.' + (format === 'xls' ? 'xls' : 'csv'))
      .catch(function (e) { alert(e.message); });
  }

  // ── Alerts ─────────────────────────────────────────────────────────────
  function renderAlerts() {
    return Promise.all([API.alerts('open'), API.events()]).then(function (r) {
      var alerts = r[0];
      var events = r[1];
      set('<div class="card"><h2>Open alerts (' + alerts.length + ')</h2>'
        + (alerts.length ? '<table><thead><tr><th>Raised</th><th>Alert</th><th>Detail</th><th>Severity</th><th>Seen</th><th></th></tr></thead><tbody>'
          + alerts.map(function (a) {
            return '<tr><td>' + dateTime(a.raisedAt) + '</td><td><b>' + esc(a.kind.replace(/_/g, ' ')) + '</b></td>'
              + '<td class="tiny">' + esc(a.detail) + '</td>'
              + '<td><span class="pill ' + (a.severity === 'critical' ? 'bad' : a.severity === 'warn' ? 'warn' : 'idle') + '">' + esc(a.severity) + '</span></td>'
              + '<td>' + (a.occurrences || 1) + '×</td>'
              + '<td><button class="btn-outline btn-sm" data-resolve="' + esc(a.id) + '">Resolve</button></td></tr>';
          }).join('') + '</tbody></table>'
          : '<p class="muted">Nothing needs attention.</p>')
        + '<p class="tiny" style="margin-top:10px">Alerts never contain coordinates. They say a driver\'s tracking has a problem, not where the driver is.</p></div>'

        + '<div class="card"><h2>Recent tracking events</h2>'
        + '<table><thead><tr><th>When</th><th>Driver</th><th>Event</th><th>Detail</th></tr></thead><tbody>'
        + events.slice(0, 100).map(function (ev) {
          return '<tr><td>' + dateTime(ev.at) + '</td><td class="tiny">' + esc((ev.driverId || '—').slice(0, 8)) + '</td>'
            + '<td>' + esc(ev.kind.replace(/_/g, ' ')) + '</td>'
            + '<td class="tiny">' + esc(ev.detail ? JSON.stringify(ev.detail).slice(0, 160) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>');

      on('[data-resolve]', 'click', function (e) {
        var note = prompt('Note (optional) — what did you do about it?');
        if (note === null) return;
        API.resolveAlert(e.currentTarget.dataset.resolve, note).then(render).catch(function (ex) { alert(ex.message); });
      });
    });
  }

  // ── Maintenance ────────────────────────────────────────────────────────
  //
  // One button: audit the running system and say what is wrong with it. What
  // it audits is the DATA and the FLOW — restaurants nobody placed, drivers
  // who never drove, rides never calculated, evidence that is missing. Not the
  // source code: a web button that can change production code is one stolen
  // session away from being arbitrary code execution on the business. Code
  // maintenance runs in CI and opens a pull request a person merges.

  var SEV = { critical: 'bad', high: 'bad', medium: 'warn', low: 'idle' };

  function renderMaintenance() {
    return API.maintenance().then(function (d) {
      var audits = d.audits || [];
      var last = audits[0] || null;

      set('<div class="card">'
        + '<h2>Maintenance</h2>'
        + (d.hasKey
          ? '<p class="muted">Audits the system as it is actually running — the restaurant list, whether drivers '
            + 'are using the app, whether rides are being calculated, whether the evidence behind the kilometre '
            + 'figures is there. It reads counts and totals only: no coordinates, no driver names, no customer '
            + 'names ever leave this server.</p>'
            + '<p style="margin:14px 0 4px"><button class="btn-primary" id="btnAudit" style="width:auto;font-size:1.02rem;padding:13px 24px">'
            + 'Run an audit now</button></p>'
            + '<p class="tiny" style="margin:0">Takes a minute or so. Costs a few rupees on your own Anthropic account.</p>'
          : '<p class="err">No Anthropic API key saved yet — add one below and the audit can run.</p>')
        + '<p id="auditMsg" class="tiny" style="margin:10px 0 0"></p>'
        + '</div>'

        + (last ? auditCard(last) : '')

        + (audits.length > 1
          ? '<details class="card"><summary class="disclose">Earlier audits (' + (audits.length - 1) + ')</summary>'
            + '<div style="margin-top:14px">'
            + audits.slice(1).map(function (a) {
              var r = a.report || {};
              return '<div style="padding:11px 0;border-bottom:1px solid var(--line-soft)">'
                + '<span class="pill ' + (r.overall === 'healthy' ? 'ok' : r.overall === 'urgent' ? 'bad' : 'warn') + '">'
                + esc(String(r.overall || '—').replace(/_/g, ' ')) + '</span> '
                + '<span class="tiny">' + dateTime(a.at) + '</span>'
                + '<div class="muted" style="margin-top:4px">' + esc(r.headline || '') + '</div>'
                + '<div class="tiny">' + ((r.findings || []).length) + ' finding(s)</div>'
                + '</div>';
            }).join('')
            + '</div></details>'
          : '')

        + '<details class="card"' + (d.hasKey ? '' : ' open') + '>'
        + '<summary class="disclose">Anthropic API key '
        + (d.hasKey ? '<span class="pill ok">saved</span>' : '<span class="pill bad">not set</span>')
        + '</summary><div style="margin-top:14px">'
        + '<p class="muted">Get one at <b>console.anthropic.com → API keys</b>. It is stored in Google Secret '
        + 'Manager, never in this site and never shown again. Only the audit uses it, and only when you press the button — '
        + 'nothing runs on a schedule and nothing is charged while you are not looking.</p>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">'
        + '<input id="anthKey" type="password" autocomplete="off" placeholder="sk-ant-…" style="max-width:420px">'
        + '<button class="btn-outline btn-sm" id="btnAnthKey">' + (d.hasKey ? 'Replace key' : 'Save key') + '</button>'
        + '</div><p id="anthMsg" class="tiny" style="margin-top:8px"></p>'
        + '</div></details>'

        + '<div class="card"><h2>What this does not do</h2>'
        + '<p class="muted">This audits the <b>running system</b>. It does not read or change the source code, and '
        + 'nothing here can deploy. That is deliberate: a button on a website that can rewrite production code is one '
        + 'stolen login away from being a very bad day.</p>'
        + '<p class="muted">Code maintenance runs separately, in GitHub, where Claude reviews the codebase on a '
        + 'schedule and opens a pull request for you to read and merge. Nothing reaches the drivers until you approve it.</p>'
        + '</div>');

      on('#btnAudit', 'click', function () {
        var btn = document.getElementById('btnAudit');
        var msg = document.getElementById('auditMsg');
        btn.disabled = true;
        msg.textContent = 'Auditing… this takes a minute.';
        API.runAudit().then(function () {
          msg.innerHTML = '<span class="ok-msg">Done.</span>';
          setTimeout(render, 600);
        }).catch(function (e) {
          btn.disabled = false;
          msg.innerHTML = '<span class="err">' + esc(e.message) + '</span>';
        });
      });

      on('#btnAnthKey', 'click', function () {
        var v = (document.getElementById('anthKey').value || '').trim();
        var m = document.getElementById('anthMsg');
        if (!v) { m.innerHTML = '<span class="err">Paste the key first.</span>'; return; }
        m.textContent = 'Saving…';
        API.setIntegrationSecret('anthropic', v).then(function () {
          document.getElementById('anthKey').value = '';
          m.innerHTML = '<span class="ok-msg">Saved.</span>';
          setTimeout(render, 700);
        }).catch(function (e) { m.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
      });
    });
  }

  function auditCard(a) {
    var r = a.report || {};
    var findings = r.findings || [];
    var order = { critical: 0, high: 1, medium: 2, low: 3 };
    findings = findings.slice().sort(function (x, y) {
      return (order[x.severity] ?? 9) - (order[y.severity] ?? 9);
    });

    return '<div class="card">'
      + '<h2>Last audit · ' + dateTime(a.at) + '</h2>'
      + '<div class="banner ' + (r.overall === 'healthy' ? 'info' : '') + '" style="font-size:.95rem">'
      + esc(r.headline || '') + '</div>'
      + (findings.length
        ? findings.map(function (f) {
          return '<div style="border-left:3px solid var(--' + (SEV[f.severity] === 'bad' ? 'bad' : SEV[f.severity] === 'warn' ? 'warn' : 'line') + ');'
            + 'padding:2px 0 2px 14px;margin:16px 0">'
            + '<div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap">'
            + '<span class="pill ' + (SEV[f.severity] || 'idle') + '">' + esc(f.severity) + '</span>'
            + '<b style="font-size:.97rem">' + esc(f.title) + '</b>'
            + '<span class="pill idle">' + (f.whoCanDoIt === 'developer' ? 'needs a developer' : 'the office can fix this') + '</span>'
            + '</div>'
            + '<p class="muted" style="margin:7px 0 0">' + esc(f.whatIsWrong) + '</p>'
            + '<p class="muted" style="margin:5px 0 0"><b>Why it matters:</b> ' + esc(f.whyItMatters) + '</p>'
            + '<p class="muted" style="margin:5px 0 0"><b>What to do:</b> ' + esc(f.whatToDo) + '</p>'
            + '</div>';
        }).join('')
        : '<p class="ok-msg">Nothing needs attention.</p>')
      + ((r.workingWell || []).length
        ? '<details style="margin-top:14px"><summary class="tiny" style="cursor:pointer">What is working well</summary>'
          + '<ul class="muted" style="margin:8px 0 0;padding-left:20px">'
          + r.workingWell.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('')
          + '</ul></details>'
        : '')
      + '</div>';
  }

  // ── Settings ───────────────────────────────────────────────────────────
  /* What each threshold actually means, in the office's language.
   *
   * These numbers decide how many kilometres a driver is paid for, and the
   * screen was showing them as bare variable names — "stopMinDwellSec" tells
   * nobody anything. Each line below says what the setting does and, more
   * usefully, what goes wrong if it is moved the wrong way, because that is
   * the question somebody about to change one is really asking.
   */
  var SETTING_HELP = {
    rejectAccuracyM: ['How vague a GPS fix can be before it is thrown out',
      'Lower: you lose real travel recorded indoors and at loading bays. Higher: phone noise turns into kilometres.'],
    warnAccuracyM: ['Above this a fix is kept but flagged as poor quality',
      'Only affects the GPS reliability report. It never changes a distance.'],
    maxSpeedMps: ['Faster than this between two fixes is a GPS jump, not a vehicle',
      '33 m/s is about 120 km/h. A bike in Pune traffic will never reach it.'],
    clockSkewMin: ['How far a phone\'s clock may be wrong before its points are refused',
      'Phones drift, and some are set by hand.'],
    minMoveM: ['Movement smaller than this is treated as a parked phone twitching',
      'Lower: a phone sitting at a restaurant invents hundreds of metres. Higher: slow crawling traffic stops being counted.'],
    gapSeconds: ['A silence longer than this is a tracking gap, not travel',
      'Distance across a gap is reported separately as an estimate and never counted as measured.'],
    stopRadiusM: ['How tightly the phone must stay put for it to count as a stop', ''],
    stopMinDwellSec: ['And for how long, before it is a stop rather than a traffic light',
      'Lower and every red signal becomes a "visit". 180 s keeps deliveries and excludes junctions.'],
    geofenceDefaultRadiusM: ['How close to a restaurant counts as being at it',
      'Used when a restaurant has no radius of its own. Wider means more visits credited, including wrong ones.'],
    facilityRadiusM: ['The same, for a Modern Dairy depot',
      'Larger because a depot is a yard, a loading bay and a car park, not a doorway.'],
    visitMinDwellSec: ['How long a driver must be inside a geofence for it to be a visit',
      'Parked outside a restaurant for 40 seconds is not evidence of a delivery.'],
    matchRadiusM: ['How far a stop may be from the order\'s address and still match it', ''],
    matchTimeToleranceMin: ['How far outside the delivery window a visit can still be a possible match',
      'Inside the window it is a match; outside but within this, a possible one.'],
    autoStopAfterHours: ['A ride nobody stopped is closed automatically after this long',
      'Recorded as auto-closed with the threshold that did it — never silently.'],
    staleLocationSec: ['After this, a position on the live map is labelled "last known" instead of "live"', ''],
    gpsMissingAlertMin: ['No GPS at all for this long during a ride raises an alert', ''],
    longRideAlertHours: ['A ride still running after this long raises an alert', 'Comes before the hard auto-stop above.'],
    maxBatchPoints: ['How many GPS points the phone may upload at once', ''],
    sampleIntervalSec: ['How often the phone records a position',
      'Lower is more accurate and uses more battery and more database writes. 30 s is about 1,440 points per driver per day.'],
  };

  /* The people offered as "stopped by" when a ride is stopped. Added from the
   * stop dialog as they are needed; removed here. Drawn at the top of
   * Settings, above the thresholds nobody should need to touch. */
  /* Google Maps in the browser. The key is handed to every signed-in browser
   * and to the driver app, so it must be locked to this site and the app in
   * Google Cloud — that restriction, not secrecy, is what protects it. */
  var MAPS_SITES = ['https://veerbhagtani.github.io/*', 'https://localhost/*'];
  function mapsKeyCard() {
    var host = document.createElement('div');
    host.className = 'card';
    host.id = 'mapsKeyCard';
    view().insertBefore(host, view().firstChild);
    Promise.all([API.integrationSecrets().catch(function () { return null; }), MAPS.init()]).then(function (r) {
      var status = r[0];
      var set_ = status && status.maps_browser === 'configured';
      var running = MAPS.provider();
      var st = MAPS.status();
      var bad = set_ && running !== 'google';
      host.innerHTML = '<h2>Google Maps '
        + (running === 'google' ? '<span class="pill ok">in use</span>'
          : st.state === 'refused' ? '<span class="pill bad">key refused</span>'
            : set_ ? '<span class="pill warn">saved, not loading</span>'
              : '<span class="pill idle">free maps in use</span>') + '</h2>'
        + '<p class="muted" style="margin-top:0">Every map here and in the driver app uses Google Maps once a browser key is saved; '
        + 'until then, and if Google ever refuses the key, they fall back to the free maps so no screen goes blank.</p>'
        + (bad || (!set_ && status === null)
          ? '<div class="banner"><b>Why it is not Google Maps:</b> ' + esc(st.detail)
            + (st.code ? '<br><span class="tiny">Google\'s error code: <b>' + esc(st.code) + '</b></span>' : '')
            + '<br><button class="btn-outline btn-sm" id="btnMapsRetry" style="width:auto;margin-top:8px">I fixed it — try Google Maps again</button></div>'
          : '')
        + '<details' + (set_ ? '' : ' open') + '><summary class="disclose">How to make the key</summary><ol class="muted" style="margin:10px 0 0 18px;padding:0">'
        + '<li>Google Cloud console, project <b>modern-drivers-pune</b> → <b>APIs &amp; Services → Library</b>: enable <b>Maps JavaScript API</b> and <b>Places API (New)</b>.</li>'
        + '<li><b>Credentials → Create credentials → API key</b>.</li>'
        + '<li>Application restrictions: <b>Websites</b>, add ' + MAPS_SITES.map(function (x) { return '<code>' + esc(x) + '</code>'; }).join(' and ') + '.</li>'
        + '<li>API restrictions: <b>Restrict key</b> → Maps JavaScript API and Places API (New) only.</li>'
        + '<li>Copy the key and paste it below.</li></ol></details>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px">'
        + '<input id="mapsKey" type="password" autocomplete="off" placeholder="AIza…" style="max-width:420px">'
        + '<button class="btn-outline btn-sm" id="btnMapsKey">' + (set_ ? 'Replace key' : 'Save key') + '</button>'
        + '</div><p id="mapsKeyMsg" class="tiny" style="margin-top:8px"></p>';
      on('#btnMapsRetry', 'click', function () { MAPS.retry(); }, host);
      on('#btnMapsKey', 'click', function () {
        var v = (document.getElementById('mapsKey').value || '').trim();
        var m = document.getElementById('mapsKeyMsg');
        if (!/^AIza[0-9A-Za-z_-]{30,}$/.test(v)) { m.innerHTML = '<span class="err">That does not look like a Google API key (they start with AIza).</span>'; return; }
        m.textContent = 'Saving…';
        API.setIntegrationSecret('maps_browser', v).then(function () {
          document.getElementById('mapsKey').value = '';
          m.innerHTML = '<span class="ok-msg">Saved. Reloading so the maps switch over…</span>';
          setTimeout(function () { location.reload(); }, 1200);
        }).catch(function (e) { m.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
      }, host);
    });
  }

  /* Under a map on the free tiles: say why it is not Google Maps, in words
   * the office can act on, so a free map is never mistaken for the Google one. */
  function mapProviderNote(containerId, h) {
    var el = document.getElementById(containerId);
    if (!el || !h) return;
    var n = el.parentNode.querySelector('.map-note[data-for="' + containerId + '"]');
    var st = MAPS.status();
    if (h.provider !== 'free' || st.state === 'loading') { if (n) n.remove(); return; }
    if (!n) {
      n = document.createElement('p');
      n.className = 'tiny map-note';
      n.setAttribute('data-for', containerId);
      el.parentNode.insertBefore(n, el.nextSibling);
    }
    n.innerHTML = '<b>Free map, not Google Maps:</b> ' + esc(st.detail)
      + (st.code ? ' <span style="opacity:.7">(' + esc(st.code) + ')</span>' : '')
      + ' <a href="#" data-go-settings>Settings → Google Maps</a>';
    var a = n.querySelector('[data-go-settings]');
    if (a) a.addEventListener('click', function (e) { e.preventDefault(); go('settings'); });
  }


  function stopNamesCard() {
    var host = document.createElement('div');
    host.className = 'card';
    host.id = 'stopNamesCard';
    view().insertBefore(host, view().firstChild);
    var draw = function (names) {
      host.innerHTML = '<h2>People who stop rides</h2>'
        + '<p class="muted" style="margin-top:0">Stopping a ride asks who did it, from this list. '
        + 'Add names here or from the stop dialog.</p>'
        + (names.length
          ? '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">' + names.map(function (n) {
            return '<span class="pill idle" style="font-size:.82rem;padding:6px 10px">' + esc(n)
              + ' <button class="link-sm" data-rmname="' + esc(n) + '" title="Remove" style="margin-left:4px">✕</button></span>';
          }).join('') + '</div>'
          : '<p class="muted">No names yet.</p>')
        + '<div class="bar" style="margin-bottom:0"><div style="flex:1"><input id="snNew" placeholder="Add a name" autocomplete="off"></div>'
        + '<div style="flex:0 0 auto"><button class="btn-outline btn-sm" id="snAdd" style="width:auto">Add</button></div></div>'
        + '<p id="snMsg" class="tiny" style="margin:8px 0 0"></p>';
      var msg = function (t) { document.getElementById('snMsg').innerHTML = t; };
      host.querySelectorAll('[data-rmname]').forEach(function (b) {
        b.addEventListener('click', function () {
          var n = b.getAttribute('data-rmname');
          if (!confirm('Remove ' + n + ' from the list?\n\nRides they already stopped keep their name.')) return;
          API.removeStopName(n).then(function (d) { draw(d.names); })
            .catch(function (e) { msg('<span class="err">' + esc(e.message) + '</span>'); });
        });
      });
      var add = function () {
        var n = document.getElementById('snNew').value.trim();
        if (!n) return;
        API.addStopName(n).then(function (d) { draw(d.names); })
          .catch(function (e) { msg('<span class="err">' + esc(e.message) + '</span>'); });
      };
      document.getElementById('snAdd').addEventListener('click', add);
      document.getElementById('snNew').addEventListener('keydown', function (e) { if (e.key === 'Enter') add(); });
    };
    host.innerHTML = spinner('Loading names…');
    API.stopNames().then(function (d) { draw(d.names); })
      .catch(function (e) { host.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; });
  }

  function renderSettings() {
    return Promise.all([API.config(), API.audit()]).then(function (r) {
      var c = r[0];
      var audit = r[1];
      var keys = Object.keys(c.defaults).filter(function (k) { return k !== 'retention'; });
      set('<div class="card"><h2>Processing thresholds</h2>'
        + '<p class="muted">These decide what the system concludes from the GPS — what counts as a stop, as a visit, as business distance. '
        + 'Changing one does <b>not</b> change any ride already calculated; use <b>Recalculate</b> below for that. '
        + 'Every change is written to the audit log, and the thresholds in force are stored on each result, so an old report can always be explained.</p>'
        + '<div class="banner info">If you are not sure, leave them alone. The defaults are tuned for Pune traffic on ordinary Android phones, '
        + 'and the <b>Default</b> column always shows what to put back.</div>'
        + (c.rejected && c.rejected.length ? '<div class="banner">Ignored: ' + esc(c.rejected.map(function (x) { return x.key + ' (' + x.reason + ')'; }).join(', ')) + '</div>' : '')
        + '<div style="overflow-x:auto"><table><thead><tr><th>Setting</th><th>Value</th><th>Default</th><th>Allowed range</th></tr></thead><tbody>'
        + keys.map(function (k) {
          var range = c.ranges[k];
          var help = SETTING_HELP[k] || [];
          return '<tr><td><b>' + esc(help[0] || k) + '</b>'
            + (help[1] ? '<br><span class="tiny">' + esc(help[1]) + '</span>' : '')
            + '<br><span class="tiny" style="opacity:.7">' + esc(k) + '</span></td>'
            + '<td><input data-cfg="' + esc(k) + '" value="' + esc(String(c.config[k])) + '" style="max-width:110px"></td>'
            + '<td class="tiny">' + esc(String(c.defaults[k])) + '</td>'
            + '<td class="tiny">' + (range ? range[0] + ' – ' + range[1] : '—') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        + '<p class="tiny" style="margin-top:10px"><b>How long records are kept</b>, in days. '
        + 'Raw GPS is deleted first and only once the ride has been calculated, so the reports stay auditable after the point-by-point trail is gone.</p>'
        + '<div class="row3" style="margin-top:12px">'
        + Object.keys(c.defaults.retention).map(function (k) {
          return '<div class="field"><label>retention.' + esc(k) + ' (days)</label><input data-ret="' + esc(k) + '" value="' + esc(String(c.config.retention[k])) + '"></div>';
        }).join('') + '</div>'
        + '<p id="cfgMsg" class="muted"></p>'
        + '<button class="btn-primary" id="btnSaveCfg">Save thresholds</button>'
        + '<p class="tiny" style="margin-top:8px">Calculation version <b>' + esc(c.calcVersion) + '</b>.</p>'
        + '</div>'

        + '<div class="card"><h2>Recalculate</h2>'
        + '<p class="muted">Re-runs the whole calculation over the raw GPS for a date range. Raw points are never modified; the processed result is replaced with a new versioned one.</p>'
        + '<div class="bar"><div><label>From</label><input id="pFrom" type="date" value="' + todayISO() + '"></div>'
        + '<div><label>To</label><input id="pTo" type="date" value="' + todayISO() + '"></div>'
        + '<div><button class="btn-primary" id="btnReprocess">Recalculate</button></div>'
        + '<div><button class="btn-outline" id="btnMaint">Run maintenance pass</button></div></div>'
        + '<p id="pMsg" class="muted"></p></div>'

        + '<div class="card"><h2>Admin audit log</h2>'
        + '<div style="overflow-x:auto"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>'
        + audit.slice(0, 100).map(function (a) {
          return '<tr><td>' + dateTime(a.at) + '</td><td class="tiny">' + esc(a.adminId) + '</td><td>' + esc(a.action) + '</td>'
            + '<td class="tiny">' + esc(String(a.target || '').slice(0, 40)) + '</td>'
            + '<td class="tiny">' + esc(a.after ? JSON.stringify(a.after).slice(0, 140) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div></div>');

      stopNamesCard();
      mapsKeyCard();

      on('#btnSaveCfg', 'click', function () {
        var overrides = {};
        view().querySelectorAll('[data-cfg]').forEach(function (el) {
          var v = Number(el.value);
          if (Number.isFinite(v) && v !== c.defaults[el.dataset.cfg]) overrides[el.dataset.cfg] = v;
        });
        var ret = {};
        view().querySelectorAll('[data-ret]').forEach(function (el) {
          var v = Number(el.value);
          if (Number.isFinite(v)) ret[el.dataset.ret] = v;
        });
        overrides.retention = ret;
        var msg = document.getElementById('cfgMsg');
        msg.textContent = 'Saving…';
        API.saveConfig(overrides).then(function (out) {
          msg.innerHTML = '<span class="ok-msg">Saved. ' + esc(out.note) + '</span>'
            + (out.rejected.length ? '<br><span class="err">Ignored: ' + esc(out.rejected.map(function (x) { return x.key + ' (' + x.reason + ')'; }).join(', ')) + '</span>' : '');
        }).catch(function (e) { msg.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
      });

      on('#btnReprocess', 'click', function () {
        var msg = document.getElementById('pMsg');
        msg.textContent = 'Recalculating…';
        API.processRange({
          from: Date.parse(document.getElementById('pFrom').value + 'T00:00:00'),
          to: Date.parse(document.getElementById('pTo').value + 'T23:59:59'),
        }).then(function (out) {
          msg.innerHTML = '<span class="ok-msg">' + out.processed + ' ride(s) recalculated.</span>'
            + (out.failed.length ? '<br><span class="err">' + out.failed.length + ' failed: ' + esc(out.failed.map(function (f) { return f.error; }).join('; ')) + '</span>' : '');
        }).catch(function (e) { msg.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
      });

      on('#btnMaint', 'click', function () {
        var msg = document.getElementById('pMsg');
        msg.textContent = 'Running…';
        API.runMaintenance(true).then(function (out) {
          msg.innerHTML = '<span class="ok-msg">Done.</span> <span class="tiny">'
            + esc(JSON.stringify({ autoClosed: out.autoClosed, alerts: out.alerts, processing: out.processing, retention: out.retention, errors: out.errors })) + '</span>';
        }).catch(function (e) { msg.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
      });
    });
  }

  // Google refused the key after a map was drawn: draw the screen again on
  // the free maps. An open ride replay is closed rather than left grey.
  window.addEventListener('md-maps-status', function () {
    if (state.map) mapProviderNote('map', state.map);
  });
  window.addEventListener('md-maps-fallback', function () {
    state.map = null; state.markers = {}; state.tracksMap = null;
    if (document.getElementById('replayMap')) closeModal();
    render();
  });

  return { renderTabs: renderTabs, render: render, go: go, state: state };
})();
