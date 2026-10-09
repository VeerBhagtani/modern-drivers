/* Journeys: a driver's whole day on one map, in order.
 *
 * Pick a driver and a day (or a few). Everything comes from the GPS the phone
 * recorded, through /admin/journey:
 *   - the complete route, every fix, coloured by what each stretch counted as;
 *     fixes left out of the distance are grey dots, never removed;
 *   - every stop numbered in order — Modern Dairy, restaurants, unknown stops,
 *     personal ones — each visit separately;
 *   - a replay that moves along the route with the time, the distance so far
 *     and where the driver was;
 *   - the timeline: started → travelled → stop → travelled → … → ended, and
 *     clicking any line of it moves the map and the replay there;
 *   - every stop and every leg with its figures, and a way to correct a stop.
 * A running ride refreshes by itself.
 */
window.DRIVERS_JOURNEY = (function () {
  'use strict';
  var API = window.DRIVERS_API;
  var MAPS = window.DRIVERS_MAP;
  var esc = MAPS.esc;

  var CAT = {
    MODERN_DAIRY: { label: 'Modern Dairy', color: '#1B2A6B', icon: '🏭' },
    RESTAURANT: { label: 'Restaurant', color: '#D7262F', icon: '📍' },
    BUSINESS: { label: 'Modern Dairy customer', color: '#0f7a4a', icon: '📍' },
    UNKNOWN: { label: 'Unknown stop', color: '#c98a12', icon: '❔' },
    PERSONAL: { label: 'Personal / excluded', color: '#7b4fa8', icon: '🚫' },
    MISSED: { label: 'Missed delivery (under 2 min)', color: '#b3261e', icon: '✕' },
  };
  var KIND = { business: 'Modern Dairy business', personal: 'personal', unknown: 'unknown', gap: 'no GPS (estimated)' };
  var SPEEDS = [[1, 60], [2, 120], [5, 300], [10, 600]];   // × → ride seconds per real second

  var st = {
    driverId: null, from: null, to: null, range: false,
    data: null, map: null, timer: null, refresh: null, playing: false,
    t: 0, speed: 60, pts: [], stops: [], segments: [], events: [], head: null,
  };

  // ── small helpers ──────────────────────────────────────────────────────
  function todayISO(offsetDays) {
    var d = new Date(Date.now() + 5.5 * 3600e3 + (offsetDays || 0) * 864e5);
    return d.toISOString().slice(0, 10);
  }
  function hm(ms) { return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'; }
  function hms(ms) { return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'; }
  function kmTxt(m) { return m == null ? '—' : (m / 1000).toFixed(2) + ' km'; }
  function dur(sec) {
    if (sec == null) return '—';
    var m = Math.round(sec / 60);
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }
  function dayLabel(k) { return new Date(k + 'T12:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }); }
  function metric(v, label, cls) {
    return '<div class="metric ' + (cls || '') + '"><div class="v">' + esc(String(v)) + '</div><div class="l">' + esc(label) + '</div></div>';
  }
  function view() { return document.getElementById('view'); }
  function $(id) { return document.getElementById(id); }
  function modal(html) { $('modal').innerHTML = html; $('modalBg').classList.add('on'); }
  function closeModal() { $('modalBg').classList.remove('on'); }

  // ── entry ──────────────────────────────────────────────────────────────
  function render(opts) {
    opts = opts || {};
    stopTimers();
    if (opts.driverId) st.driverId = opts.driverId;
    if (opts.day) { st.from = opts.day; st.to = opts.day; st.range = false; }
    if (!st.from) { st.from = todayISO(0); st.to = st.from; }
    return API.drivers(true).then(function (drivers) {
      if (!drivers.length) {
        view().innerHTML = '<div class="card"><h2>Journeys</h2><p class="muted">Nobody has registered yet.</p></div>';
        return;
      }
      if (!st.driverId || !drivers.some(function (d) { return d.id === st.driverId; })) {
        st.driverId = (drivers.find(function (d) { return d.status === 'active'; }) || drivers[0]).id;
      }
      view().innerHTML = '<div class="card jhead">'
        + '<div class="bar" style="align-items:flex-end;flex-wrap:wrap">'
        + '<div style="flex:2;min-width:220px"><label for="jDriver">Driver</label><select id="jDriver">'
        + drivers.map(function (d) {
          return '<option value="' + esc(d.id) + '"' + (d.id === st.driverId ? ' selected' : '') + '>' + esc(d.name) + ' · ' + esc(d.driverCode || '') + (d.status !== 'active' ? ' (switched off)' : '') + '</option>';
        }).join('') + '</select></div>'
        + '<div class="jdays">'
        + '<button class="btn-outline btn-sm" data-day="0">Today</button>'
        + '<button class="btn-outline btn-sm" data-day="-1">Yesterday</button>'
        + '</div>'
        + '<div><label for="jFrom">' + (st.range ? 'From' : 'Date') + '</label><input type="date" id="jFrom" value="' + esc(st.from) + '"></div>'
        + (st.range ? '<div><label for="jTo">To</label><input type="date" id="jTo" value="' + esc(st.to) + '"></div>' : '')
        + '<label style="display:flex;gap:6px;align-items:center;font-size:.85rem;margin-bottom:8px"><input type="checkbox" id="jRange" style="width:auto"' + (st.range ? ' checked' : '') + '> Date range</label>'
        + '<button class="btn-outline btn-sm" id="jControls" style="margin-bottom:6px">Ride controls…</button>'
        + '</div></div>'
        + '<div id="jBody"><p class="muted">Loading the journey…</p></div>';
      $('jDriver').addEventListener('change', function (e) { st.driverId = e.target.value; load(); });
      Array.prototype.forEach.call(document.querySelectorAll('[data-day]'), function (b) {
        b.addEventListener('click', function () { st.range = false; st.from = st.to = todayISO(Number(b.getAttribute('data-day'))); render(); });
      });
      $('jFrom').addEventListener('change', function (e) { st.from = e.target.value; if (!st.range || st.to < st.from) st.to = st.from; load(); });
      if ($('jTo')) $('jTo').addEventListener('change', function (e) { st.to = e.target.value < st.from ? st.from : e.target.value; load(); });
      $('jRange').addEventListener('change', function (e) { st.range = e.target.checked; if (!st.range) st.to = st.from; render(); });
      $('jControls').addEventListener('click', function () {
        if (window.DRIVERS_VIEWS && window.DRIVERS_VIEWS.openDriverControls) window.DRIVERS_VIEWS.openDriverControls(st.driverId);
      });
      return load();
    });
  }

  function stopTimers() {
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    if (st.refresh) { clearTimeout(st.refresh); st.refresh = null; }
    st.playing = false;
  }

  function load(quiet) {
    var body = $('jBody');
    if (!body) return Promise.resolve();
    if (!quiet) body.innerHTML = '<p class="muted">Loading the journey…</p>';
    var asked = st.driverId + '|' + st.from + '|' + st.to;
    return API.journey(st.driverId, st.from, st.to).then(function (data) {
      if (asked !== st.driverId + '|' + st.from + '|' + st.to || !$('jBody')) return;
      if (quiet && st.playing) { scheduleRefresh(); return; }   // never yank a replay
      st.data = data;
      draw(data);
      scheduleRefresh();
    }).catch(function (e) {
      if (!quiet && $('jBody')) $('jBody').innerHTML = '<div class="card"><p class="err">' + esc(e.message) + '</p></div>';
      else scheduleRefresh();
    });
  }

  // A running ride on screen: fetch again every 30 s, without a reload.
  function scheduleRefresh() {
    if (st.refresh) clearTimeout(st.refresh);
    var d = st.data;
    var live = d && d.rides.some(function (r) { return r.ride.status === 'active'; });
    if (!live) return;
    st.refresh = setTimeout(function () {
      if (!document.getElementById('jMap')) return;
      load(true);
    }, 30000);
  }

  // ── merge the rides of the range into one story ─────────────────────────
  function merge(data) {
    var pts = []; var stops = []; var segments = []; var events = [];
    data.rides.forEach(function (r, ri) {
      var j = r.journey;
      var base = stops.length;
      (r.replay.points || []).forEach(function (p) { pts.push(Object.assign({ ri: ri }, p)); });
      j.stops.forEach(function (s) { stops.push(Object.assign({}, s, { gn: base + s.n, ri: ri, rideId: r.ride.id })); });
      j.segments.forEach(function (g) {
        segments.push(Object.assign({}, g, { ri: ri, rideId: r.ride.id,
          fromN: g.from.n ? base + g.from.n : null, toN: g.to.n ? base + g.to.n : null }));
      });
      if (data.rides.length > 1) events.push({ kind: 'ride', ts: r.ride.startedAt, label: 'Ride ' + (ri + 1) + ' · ' + dayLabel(r.ride.dayKey) + (r.ride.roundName ? ' · ' + r.ride.roundName : ''), ri: ri });
      j.events.forEach(function (e) {
        var x = Object.assign({ ri: ri, rideId: r.ride.id }, e);
        if (x.stop) x.gn = base + x.stop;
        if (x.segment) x.seg = segments.find(function (g) { return g.ri === ri && g.n === x.segment; });
        events.push(x);
      });
    });
    return { pts: pts, stops: stops, segments: segments, events: events };
  }

  // ── the page ───────────────────────────────────────────────────────────
  function draw(data) {
    var m = merge(data);
    st.pts = m.pts; st.stops = m.stops; st.segments = m.segments; st.events = m.events;
    st.used = m.pts.filter(function (p) { return p.used; });
    var rides = data.rides;
    var body = $('jBody');
    if (!rides.length) {
      body.innerHTML = '<div class="card"><p class="muted">' + esc(data.driver.name) + ' has no ride on ' + esc(st.range ? dayLabel(st.from) + ' – ' + dayLabel(st.to) : dayLabel(st.from)) + '.</p></div>';
      return;
    }
    // Totals across the rides shown.
    var T = { measuredM: 0, gapEstimateM: 0, businessM: 0, unknownM: 0, personalM: 0, stops: 0, restaurantStops: 0, unknownStops: 0, missedDeliveries: 0, timeAtStopsSec: 0, fixes: 0, fixesExcluded: 0 };
    var visited = {};
    rides.forEach(function (r) {
      var t = r.journey.totals;
      Object.keys(T).forEach(function (k) { if (t[k] != null) T[k] += t[k]; });
    });
    st.stops.forEach(function (s) { if (s.category === 'RESTAURANT') visited[s.placeId] = 1; });
    var active = rides.some(function (r) { return r.ride.status === 'active'; });
    var first = rides[0].ride; var last = rides[rides.length - 1].ride;
    var live = data.live;

    var html = '';
    if (active && live) {
      var age = live.deviceTs ? Math.round((Date.now() - live.deviceTs) / 1000) : null;
      var fresh = age != null && age <= (data.staleAfterSec || 180);
      var cur = st.stops.length && st.stops[st.stops.length - 1].departureTs == null ? st.stops[st.stops.length - 1] : null;
      html += '<div class="card jlive">'
        + '<span class="pill ' + (fresh ? 'live' : 'warn') + '">' + (fresh ? 'LIVE' : 'LAST KNOWN') + '</span> '
        + '<b>Ride running.</b> Last GPS ' + hms(live.deviceTs) + (age != null ? ' (' + (age < 90 ? age + ' s' : Math.round(age / 60) + ' min') + ' ago)' : '')
        + (live.speedMps != null ? ' · ' + Math.round(live.speedMps * 3.6) + ' km/h' : '')
        + (live.accuracyM != null ? ' · ±' + live.accuracyM + ' m' : '')
        + (live.batteryPct != null ? ' · battery ' + live.batteryPct + '%' : '')
        + (cur ? ' · <b>stopped at ' + esc(cur.label) + '</b> since ' + hm(cur.arrivalTs) : ' · moving')
        + ' · <span class="tiny">refreshes every 30 s</span></div>';
    }
    if (live && live.queuedPoints) {
      html += '<div class="banner">' + live.queuedPoints + ' GPS position(s) are still on the phone, waiting for signal'
        + (live.healthAt ? ' (reported ' + hm(live.healthAt) + ')' : '') + '. They keep their original times; the route fills in when they arrive.</div>';
    }
    html += '<div class="grid metrics" style="margin-bottom:12px">'
      + metric(kmTxt(T.measuredM), 'Total distance (GPS)')
      + metric(kmTxt(T.businessM), 'Modern Dairy business', 'ok')
      + metric(kmTxt(T.unknownM), 'Unknown — needs review', T.unknownM > 0 ? 'warn' : '')
      + metric(kmTxt(T.personalM), 'Personal / excluded')
      + (T.gapEstimateM ? metric(kmTxt(T.gapEstimateM), 'Across GPS gaps (estimate)') : '')
      + metric(String(T.stops), 'Stops')
      + metric(String(Object.keys(visited).length), 'Restaurants visited', 'ok')
      + metric(String(T.unknownStops), 'Unknown stops', T.unknownStops ? 'warn' : '')
      + metric(String(T.missedDeliveries), 'Missed deliveries (under 2 min)', T.missedDeliveries ? 'bad' : 'ok')
      + metric(dur(T.timeAtStopsSec), 'Time at stops')
      + metric(hm(first.startedAt) + ' – ' + (active ? 'now' : hm(last.stoppedAt)), rides.length > 1 ? rides.length + ' rides' : 'Ride time')
      + '</div>'
      + '<div class="jsplit">'
      + '<div class="card jmapcard"><div id="jMap"></div>'
      + '<div class="replay-bar jbar">'
      + '<button class="btn-outline btn-sm" id="jRestart" title="Restart" aria-label="Restart">⟲</button>'
      + '<button class="btn-primary btn-sm" id="jPlay" aria-label="Play">▶ Replay journey</button>'
      + '<div class="jspeeds">' + SPEEDS.map(function (s) { return '<button class="btn-outline btn-sm' + (st.speed === s[1] ? ' on' : '') + '" data-speed="' + s[1] + '">' + s[0] + '×</button>'; }).join('') + '</div>'
      + '</div>'
      + '<input type="range" id="jSeek" min="0" max="1000" value="0" aria-label="Timeline" style="width:100%;margin-top:8px">'
      + '<div id="jNow" class="jnow"></div>'
      + '<div class="legend">'
      + '<span><i style="background:' + MAPS.BUCKET_COLOUR.business + '"></i>Business</span>'
      + '<span><i style="background:' + MAPS.BUCKET_COLOUR.unknown + '"></i>Unknown</span>'
      + '<span><i style="background:' + MAPS.BUCKET_COLOUR.personal + '"></i>Personal</span>'
      + '<span><i style="background:' + MAPS.BUCKET_COLOUR.gap + '"></i>No GPS (dashed)</span>'
      + '<span><i style="background:#98a2b3;width:6px;height:6px"></i>Fix left out (kept)</span>'
      + Object.keys(CAT).map(function (k) { return '<span><i style="background:' + CAT[k].color + '"></i>' + esc(CAT[k].label) + '</span>'; }).join('')
      + '</div>'
      + '<p class="tiny" style="margin:6px 0 0">1× replays one minute of the ride per second. Every recorded fix is on the map; ' + T.fixes + ' fixes, '
      + T.fixesExcluded + ' left out of the distance (shown grey). Click a stop or a stretch of road for its details.</p>'
      + '</div>'
      + '<div class="card jtimeline"><h2 style="margin-top:0">Journey timeline</h2><div id="jEvents">' + timelineHtml() + '</div></div>'
      + '</div>'
      + segmentsHtml()
      + stopsHtml()
      + rides.map(function (r, i) {
        return '<p class="tiny">Ride ' + (i + 1) + ': ' + esc(dayLabel(r.ride.dayKey)) + ', ' + hm(r.ride.startedAt) + ' – ' + (r.ride.status === 'active' ? 'running' : hm(r.ride.stoppedAt))
          + (r.ride.stoppedByName ? ', stopped by ' + esc(r.ride.stoppedByName) : '') + (r.ride.stopKind === 'day_end' ? ', closed at the end of the day' : '')
          + ' · ' + r.ride.pointCount + ' fixes received'
          + (r.calculated ? '' : ' · <b>not calculated yet</b> — route shown as recorded')
          + ' · <button class="link-sm" data-tech="' + esc(r.ride.id) + '">technical view</button></p>';
      }).join('');
    body.innerHTML = html;
    bind();
    drawMap();
  }

  function timelineHtml() {
    return '<ol class="jlist">' + st.events.map(function (e, i) {
      var cls = 'jev jev-' + e.kind;
      if (e.kind === 'ride') return '<li class="' + cls + '"><b>' + esc(e.label) + '</b></li>';
      if (e.kind === 'travel') {
        var g = e.seg || {};
        return '<li class="' + cls + '" data-ev="' + i + '"><span class="jt">' + hm(e.ts) + '</span>'
          + '<span class="jb"><span class="jkm">🚗 Travelled ' + kmTxt(e.distanceM) + '</span>'
          + (e.gapEstimateM ? ' <span class="tiny">+' + kmTxt(e.gapEstimateM) + ' across a GPS gap</span>' : '')
          + '<br><span class="tiny">' + dur(e.durationSec) + ' · ' + esc(KIND[e.classification] || e.classification)
          + (g.quality && g.quality.grade !== 'GOOD' ? ' · GPS ' + esc(g.quality.grade.toLowerCase()) : '') + '</span></span></li>';
      }
      if (e.kind === 'stop') {
        var s = st.stops.find(function (x) { return x.gn === e.gn; }) || {};
        var c = CAT[s.category] || CAT.UNKNOWN;
        return '<li class="' + cls + '" data-ev="' + i + '"><span class="jt">' + hm(e.ts) + '</span>'
          + '<span class="jb"><span class="jdot" style="background:' + c.color + '">' + s.gn + '</span>'
          + '<b>' + esc(s.label || c.label) + '</b>' + (s.transit ? ' <span class="tiny">(short stop on the way)</span>' : '')
          + (s.needsReview ? ' <span class="pill warn">review</span>' : '')
          + '<br><span class="tiny">' + esc(c.label) + ' · ' + hm(s.arrivalTs) + '–' + (s.departureTs ? hm(s.departureTs) : 'now') + ' · ' + dur(s.durationSec)
          + (s.address && s.category !== 'MODERN_DAIRY' ? ' · ' + esc(s.address) : '') + '</span></span></li>';
      }
      if (e.kind === 'missed') {
        return '<li class="' + cls + '" data-ev="' + i + '"><span class="jt">' + hm(e.ts) + '</span>'
          + '<span class="jb"><span class="jdot" style="background:' + CAT.MISSED.color + '">✕</span>'
          + '<b>Missed delivery: ' + esc(e.label) + '</b>'
          + '<br><span class="tiny">Stopped only ' + e.durationSec + ' s (' + hm(e.ts) + '–' + hm(e.endTs) + ') — the minimum is '
          + Math.round((e.minSec || 120) / 60) + ' min, so this is not a delivery</span></span></li>';
      }
      var label = e.kind === 'start' ? '🟢 Ride started' : e.kind === 'now' ? '📡 Latest position' : '🏁 Ride ended';
      return '<li class="' + cls + '" data-ev="' + i + '"><span class="jt">' + hm(e.ts) + '</span><span class="jb"><b>' + label + '</b>'
        + (e.label ? '<br><span class="tiny">' + esc(e.label) + '</span>' : '')
        + (e.kind !== 'start' && e.totalM != null ? '<br><span class="tiny">' + kmTxt(e.totalM) + ' travelled</span>' : '') + '</span></li>';
    }).join('') + '</ol>';
  }

  function where(x) { return x.label + (x.n ? ' (stop ' + x.n + ')' : ''); }
  function segmentsHtml() {
    if (!st.segments.length) return '';
    return '<div class="card"><h2>Route segments</h2><div style="overflow-x:auto"><table><thead><tr>'
      + '<th>#</th><th>From</th><th>To</th><th>Start</th><th>End</th><th>Distance</th><th>Duration</th><th>Counted as</th><th>GPS</th>'
      + '</tr></thead><tbody>'
      + st.segments.map(function (g, i) {
        var parts = Object.keys(g.byKind || {}).filter(function (k) { return g.byKind[k] > 0; })
          .map(function (k) { return kmTxt(g.byKind[k]) + ' ' + esc(KIND[k] || k); });
        return '<tr class="click" data-seg="' + i + '"><td>' + (i + 1) + '</td>'
          + '<td>' + esc(g.from.label) + (g.fromN ? ' <span class="tiny">#' + g.fromN + '</span>' : '') + '</td>'
          + '<td>' + esc(g.to.label) + (g.toN ? ' <span class="tiny">#' + g.toN + '</span>' : '') + '</td>'
          + '<td>' + hm(g.startTs) + '</td><td>' + hm(g.endTs) + '</td>'
          + '<td><b>' + kmTxt(g.distanceM) + '</b>' + (g.gapEstimateM ? '<br><span class="tiny">+' + kmTxt(g.gapEstimateM) + ' estimated</span>' : '') + '</td>'
          + '<td>' + dur(g.durationSec) + '</td>'
          + '<td class="tiny">' + (parts.join('<br>') || '—') + '</td>'
          + '<td class="tiny"><span class="pill ' + (g.quality.grade === 'GOOD' ? 'ok' : g.quality.grade === 'FAIR' ? 'warn' : 'bad') + '">' + esc(g.quality.grade.toLowerCase()) + '</span>'
          + (g.quality.grade !== 'GOOD' ? '<br>' + esc(g.quality.note) : '') + '</td></tr>';
      }).join('')
      + '</tbody></table></div></div>';
  }

  function stopsHtml() {
    if (!st.stops.length) return '<div class="card"><h2>Stops</h2><p class="muted">No stops detected yet.</p></div>';
    var S = st.data.stopSettings || {};
    return '<div class="card"><h2>Stops</h2>'
      + '<p class="tiny" style="margin-top:0">A stop is the phone staying within ' + (S.stopRadiusM || 60) + ' m for at least ' + Math.round((S.stopMinDwellSec || 120) / 60)
      + ' min (change these in Settings). Each visit is listed separately, even to the same place.</p>'
      + '<div style="overflow-x:auto"><table><thead><tr>'
      + '<th>#</th><th>Place</th><th>Arrived</th><th>Left</th><th>Stayed</th><th>From previous stop</th><th>Travelled before</th><th>Since leaving Modern Dairy</th><th>Location</th><th></th>'
      + '</tr></thead><tbody>'
      + st.stops.map(function (s, i) {
        var c = CAT[s.category] || CAT.UNKNOWN;
        return '<tr class="click" data-stoprow="' + i + '"><td><span class="jdot" style="background:' + c.color + '">' + s.gn + '</span></td>'
          + '<td><b>' + esc(s.label || c.label) + '</b><br><span class="tiny">' + esc(c.label)
          + (s.reviewedBy ? ' · set by ' + esc(s.reviewedBy.replace(/^admin:/, '')) : '') + (s.needsReview ? ' · needs review' : '') + '</span></td>'
          + '<td>' + hm(s.arrivalTs) + '</td><td>' + (s.departureTs ? hm(s.departureTs) : 'still there') + '</td><td>' + dur(s.durationSec) + '</td>'
          + '<td>' + kmTxt(s.distanceFromPrevM) + '</td><td>' + kmTxt(s.totalBeforeM) + '</td>'
          + '<td>' + (s.sinceDepotM == null ? '—' : kmTxt(s.sinceDepotM)) + '</td>'
          + '<td class="tiny">' + (s.address ? esc(s.address) + '<br>' : '') + (isFinite(s.lat) ? s.lat.toFixed(5) + ', ' + s.lng.toFixed(5) : '') + '</td>'
          + '<td><button class="btn-outline btn-sm" data-fix="' + i + '">Correct</button></td></tr>';
      }).join('')
      + '</tbody></table></div></div>';
  }

  // ── the map ─────────────────────────────────────────────────────────────
  function drawMap() {
    var h = MAPS.create('jMap', { zoom: 12 });
    st.map = h;
    if (!h) return;
    h.ready(function () {
      var rides = st.data.rides;
      var all = [];
      rides.forEach(function (r, ri) {
        MAPS.drawReplay(h, r.replay, { layer: 'jr' + ri, noHead: true, noFit: true,
          startLabel: rides.length > 1 ? 'S' + (ri + 1) : 'S', endLabel: r.ride.status === 'active' ? '●' : (rides.length > 1 ? 'E' + (ri + 1) : 'E'),
          startTitle: 'Ride started ' + hm(r.journey.startTs), endTitle: r.ride.status === 'active' ? 'Latest position' : 'Ride ended ' + hm(r.journey.endTs) });
        (r.replay.points || []).forEach(function (p) { all.push(p); });
      });
      // Each stretch between stops, clickable for its figures (an invisible
      // wide line over the drawn route).
      st.segments.forEach(function (g, i) {
        var pts = st.used.filter(function (p) { return p.ri === g.ri && p.ts >= g.startTs && p.ts <= g.endTs; });
        if (pts.length > 1) MAPS.line(h, 'jhit', pts, { color: '#000000', opacity: 0.01, width: 16, z: 30, onClick: function () { openSegment(i); } });
      });
      // Visits to the same spot (the depot three times a day) share one pin
      // labelled with every visit number, so none hides under another.
      var groups = [];
      st.stops.forEach(function (s, i) {
        if (!isFinite(s.lat)) return;
        var g = groups.find(function (x) { return Math.abs(x.lat - s.lat) < 0.0003 && Math.abs(x.lng - s.lng) < 0.0003; });
        if (g) g.items.push(i); else groups.push({ lat: s.lat, lng: s.lng, items: [i] });
      });
      groups.forEach(function (g) {
        var s0 = st.stops[g.items[0]];
        var c = CAT[s0.category] || CAT.UNKNOWN;
        MAPS.pin(h, 'jstops', g, { label: g.items.map(function (i) { return st.stops[i].gn; }).join('·'), color: c.color, z: 950,
          title: g.items.map(function (i) { var s = st.stops[i]; return s.gn + '. ' + (s.label || CAT[s.category].label) + ' · ' + hm(s.arrivalTs) + '–' + (s.departureTs ? hm(s.departureTs) : 'now'); }).join('\n'),
          onClick: function () { if (g.items.length === 1) openStop(g.items[0]); else chooseStop(g.items); } });
      });
      // Halts too short to be a delivery: a red ✕ on the restaurant.
      st.events.forEach(function (e) {
        if (e.kind !== 'missed' || !e.at) return;
        MAPS.pin(h, 'jmissed', e.at, { label: '✕', color: CAT.MISSED.color, z: 940,
          title: 'Missed delivery: ' + e.label + ' — stopped only ' + e.durationSec + ' s at ' + hm(e.ts) + ' (minimum 2 min)' });
      });
      st.head = st.used.length ? MAPS.pin(h, 'jhead', st.used[0], { dot: 9, color: '#111827', title: 'Replay position', z: 1100 }) : null;
      MAPS.fit(h, all.filter(function (p) { return p.used; }).length ? all.filter(function (p) { return p.used; }) : all);
      setupReplay();
    });
  }

  // ── replay ───────────────────────────────────────────────────────────────
  function bounds() {
    var u = st.used;
    return u.length ? [u[0].ts, u[u.length - 1].ts] : [0, 0];
  }
  function pointAt(t) {
    var u = st.used; var lo = 0; var hi = u.length - 1; var at = 0;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (u[mid].ts <= t) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    return u[at];
  }
  function situation(t) {
    var cur = st.stops.find(function (s) { return s.arrivalTs <= t && (s.departureTs == null || t <= s.departureTs); });
    if (cur) return { stop: cur, text: 'At <b>' + esc(cur.label || CAT[cur.category].label) + '</b> since ' + hm(cur.arrivalTs) + (cur.address && cur.category !== 'MODERN_DAIRY' ? ' · ' + esc(cur.address) : '') };
    var prev = null; var next = null;
    st.stops.forEach(function (s) { if ((s.departureTs || 0) <= t) prev = s; if (!next && s.arrivalTs > t) next = s; });
    return { text: 'Travelling' + (prev ? ' from <b>' + esc(prev.label || CAT[prev.category].label) + '</b>' : '') + (next ? ' to <b>' + esc(next.label || CAT[next.category].label) + '</b>' : '') };
  }
  function show(t, pan) {
    if (!st.used.length) return;
    var b = bounds();
    st.t = Math.max(b[0], Math.min(b[1], t));
    var p = pointAt(st.t);
    if (st.head) st.head.setPosition(p);
    if (pan && st.map) st.map.flyTo(p, 16);
    var seek = $('jSeek');
    if (seek && b[1] > b[0]) seek.value = String(Math.round((st.t - b[0]) / (b[1] - b[0]) * 1000));
    var sit = situation(st.t);
    var now = $('jNow');
    if (now) {
      now.innerHTML = '<b class="jclock">' + hms(p.ts) + '</b> · <b>' + kmTxt((p.d || 0)) + '</b> travelled'
        + (p.g ? ' <span class="tiny">(+' + kmTxt(p.g) + ' estimated across gaps)</span>' : '')
        + (p.s != null ? ' · ' + Math.round(p.s * 3.6) + ' km/h' : '')
        + (p.a != null ? ' · ±' + p.a + ' m' : '')
        + '<br>' + sit.text;
    }
    // Keep the matching line of the timeline in view.
    var idx = -1;
    st.events.forEach(function (e, i) { if (e.ts != null && e.ts <= st.t && e.kind !== 'ride') idx = i; });
    Array.prototype.forEach.call(document.querySelectorAll('.jev.on'), function (el) { el.classList.remove('on'); });
    var el = document.querySelector('[data-ev="' + idx + '"]');
    if (el) {
      el.classList.add('on');
      var box = el.closest('#jEvents');
      if (box && (el.offsetTop < box.scrollTop || el.offsetTop > box.scrollTop + box.clientHeight - 40)) box.scrollTop = el.offsetTop - 60;
    }
  }
  function setupReplay() {
    var b = bounds();
    var play = $('jPlay');
    if (!st.used.length || !play) { if (play) play.disabled = true; return; }
    var TICK = 100;
    var stop = function () { clearInterval(st.timer); st.timer = null; st.playing = false; play.textContent = '▶ Replay journey'; };
    play.addEventListener('click', function () {
      if (st.playing) { stop(); return; }
      if (st.t >= bounds()[1]) st.t = bounds()[0];
      st.playing = true; play.textContent = '❚❚ Pause';
      st.timer = setInterval(function () {
        if (!document.getElementById('jMap')) { stop(); return; }
        var nt = st.t + st.speed * TICK;
        if (nt >= bounds()[1]) { show(bounds()[1]); stop(); return; }
        show(nt);
      }, TICK);
    });
    $('jRestart').addEventListener('click', function () { show(bounds()[0], true); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-speed]'), function (btn) {
      btn.addEventListener('click', function () {
        st.speed = Number(btn.getAttribute('data-speed'));
        Array.prototype.forEach.call(document.querySelectorAll('[data-speed]'), function (x) { x.classList.toggle('on', x === btn); });
      });
    });
    $('jSeek').addEventListener('input', function (e) {
      var bb = bounds();
      show(bb[0] + (bb[1] - bb[0]) * Number(e.target.value) / 1000);
    });
    show(b[0]);
  }

  // ── clicks ───────────────────────────────────────────────────────────────
  function bind() {
    var evs = $('jEvents');
    if (evs) evs.addEventListener('click', function (e) {
      var li = e.target.closest('[data-ev]');
      if (!li) return;
      var ev = st.events[Number(li.getAttribute('data-ev'))];
      if (!ev) return;
      if (ev.kind === 'stop') {
        var s = st.stops.find(function (x) { return x.gn === ev.gn; });
        show(ev.ts);
        if (st.map && s) st.map.flyTo(s, 17);
      } else if (ev.kind === 'travel' && ev.seg) {
        var g = ev.seg;
        show(g.startTs);
        var pts = st.used.filter(function (p) { return p.ri === g.ri && p.ts >= g.startTs && p.ts <= g.endTs; });
        if (st.map) st.map.fit(pts);
      } else {
        show(ev.ts, true);
      }
    });
    view().removeEventListener('click', onViewClick);
    view().addEventListener('click', onViewClick);
  }
  function onViewClick(e) {
    if (!document.getElementById('jBody')) { view().removeEventListener('click', onViewClick); return; }
    var t = e.target;
    var fix = t.closest && t.closest('[data-fix]');
    if (fix) { e.stopPropagation(); correctStop(Number(fix.getAttribute('data-fix'))); return; }
    var row = t.closest && t.closest('[data-stoprow]');
    if (row) { var s = st.stops[Number(row.getAttribute('data-stoprow'))]; show(s.arrivalTs); if (st.map) st.map.flyTo(s, 17); window.scrollTo({ top: $('jMap').getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' }); return; }
    var seg = t.closest && t.closest('[data-seg]');
    if (seg) { openSegment(Number(seg.getAttribute('data-seg'))); return; }
    var tech = t.closest && t.closest('[data-tech]');
    if (tech && window.DRIVERS_VIEWS && window.DRIVERS_VIEWS.openRide) window.DRIVERS_VIEWS.openRide(tech.getAttribute('data-tech'));
  }

  function row(k, v) { return '<tr><th style="text-align:left;width:42%">' + esc(k) + '</th><td>' + v + '</td></tr>'; }
  function openStop(i) {
    var s = st.stops[i]; var c = CAT[s.category] || CAT.UNKNOWN;
    modal('<h3 style="margin:0 0 4px"><span class="jdot" style="background:' + c.color + '">' + s.gn + '</span> ' + esc(s.label || c.label) + '</h3>'
      + '<p class="tiny" style="margin:0 0 10px">' + esc(c.label) + (s.transit ? ' · a short stop on the way' : '') + '</p>'
      + '<table class="kv">'
      + row('Arrived', hms(s.arrivalTs)) + row('Left', s.departureTs ? hms(s.departureTs) : 'still there') + row('Stayed', dur(s.durationSec))
      + row('Location', (isFinite(s.lat) ? s.lat.toFixed(6) + ', ' + s.lng.toFixed(6) : '—') + (s.medianAccuracyM ? ' <span class="tiny">(GPS ±' + s.medianAccuracyM + ' m)</span>' : ''))
      + row('Address', s.address ? esc(s.address) + (s.addressApproximate ? ' <span class="tiny">(approximate)</span>' : '') : '<span class="tiny">not available</span>')
      + row('From the previous stop', kmTxt(s.distanceFromPrevM) + (s.gapFromPrevM ? ' <span class="tiny">+' + kmTxt(s.gapFromPrevM) + ' estimated</span>' : ''))
      + row('Travelled before this stop', kmTxt(s.totalBeforeM))
      + row('Since leaving Modern Dairy', s.sinceDepotM == null ? '—' : kmTxt(s.sinceDepotM))
      + row('Straight line from Modern Dairy', s.depotStraightM == null ? '—' : kmTxt(s.depotStraightM))
      + (s.reviewedBy ? row('Set by', esc(s.reviewedBy) + (s.originalType ? ' <span class="tiny">(was ' + esc(String(s.originalType).replace(/_/g, ' ').toLowerCase()) + ')</span>' : '')) : '')
      + (s.nearbyPlaces && s.nearbyPlaces.length ? row('Nearby (for reference only)', esc(s.nearbyPlaces.map(function (n) { return n.name + ' ' + n.distanceM + ' m'; }).join(', '))) : '')
      + '</table>'
      + (s.evidence && s.evidence.length ? '<p class="tiny">' + esc(s.evidence.join(' · ')) + '</p>' : '')
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">'
      + '<button class="btn-primary" id="jsFix">Correct this stop</button>'
      + '<a class="btn-outline" style="text-decoration:none;padding:9px 14px" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=' + s.lat + ',' + s.lng + '">Open in Google Maps</a>'
      + '<button class="btn-outline" id="jsClose">Close</button></div>');
    $('jsClose').addEventListener('click', closeModal);
    $('jsFix').addEventListener('click', function () { correctStop(i); });
  }

  function chooseStop(items) {
    modal('<h3 style="margin:0 0 10px">' + items.length + ' visits to this place</h3>'
      + '<div style="display:flex;flex-direction:column;gap:8px">' + items.map(function (i) {
        var s = st.stops[i];
        return '<button class="btn-outline" data-pickstop="' + i + '" style="text-align:left">' + s.gn + '. ' + esc(s.label || CAT[s.category].label)
          + ' — ' + hm(s.arrivalTs) + '–' + (s.departureTs ? hm(s.departureTs) : 'now') + ' (' + dur(s.durationSec) + ')</button>';
      }).join('') + '</div><button class="btn-outline" id="jpClose" style="margin-top:12px">Close</button>');
    $('jpClose').addEventListener('click', closeModal);
    Array.prototype.forEach.call(document.querySelectorAll('[data-pickstop]'), function (b) {
      b.addEventListener('click', function () { openStop(Number(b.getAttribute('data-pickstop'))); });
    });
  }

  function openSegment(i) {
    var g = st.segments[i];
    var parts = Object.keys(g.byKind || {}).filter(function (k) { return g.byKind[k] > 0; })
      .map(function (k) { return kmTxt(g.byKind[k]) + ' ' + esc(KIND[k] || k); }).join('<br>');
    modal('<h3 style="margin:0 0 10px">Segment ' + (i + 1) + ': ' + esc(where({ label: g.from.label, n: g.fromN })) + ' → ' + esc(where({ label: g.to.label, n: g.toN })) + '</h3>'
      + '<table class="kv">'
      + row('Started', hms(g.startTs)) + row('Ended', hms(g.endTs)) + row('Duration', dur(g.durationSec))
      + row('Distance (along the GPS)', '<b>' + kmTxt(g.distanceM) + '</b>' + (g.gapEstimateM ? ' <span class="tiny">+' + kmTxt(g.gapEstimateM) + ' straight-line estimate across a GPS gap</span>' : ''))
      + row('Counted as', parts || '—')
      + row('GPS quality', esc(g.quality.grade.toLowerCase()) + ' — ' + esc(g.quality.note) + (g.quality.fixes ? ' <span class="tiny">(' + g.quality.fixes + ' fixes, ' + g.quality.excluded + ' left out)</span>' : ''))
      + '</table>'
      + '<p class="tiny">A stretch is decided by where it leads: to a restaurant or the depot is business; to an unknown stop it stays unknown until someone decides that stop. Correct the stop at either end to change it, or use the technical view to reclassify the stretch itself.</p>'
      + '<button class="btn-outline" id="jgShow">Show on map</button> <button class="btn-outline" id="jgClose">Close</button>');
    $('jgClose').addEventListener('click', closeModal);
    $('jgShow').addEventListener('click', function () {
      closeModal();
      var pts = st.used.filter(function (p) { return p.ri === g.ri && p.ts >= g.startTs && p.ts <= g.endTs; });
      show(g.startTs); if (st.map) st.map.fit(pts);
    });
  }

  // ── correcting a stop ────────────────────────────────────────────────────
  var CHOICES = [
    ['RESTAURANT', 'A restaurant (choose which)', 'LIKELY_RESTAURANT_VISIT'],
    ['BUSINESS', 'A Modern Dairy customer not in the restaurant list', 'LIKELY_RESTAURANT_VISIT'],
    ['MODERN_DAIRY', 'Modern Dairy (depot)', 'MODERN_DAIRY_FACILITY_STOP'],
    ['PERSONAL', 'Personal / Porter / excluded', 'PERSONAL_OR_NON_BUSINESS'],
    ['UNKNOWN', 'Unknown — leave for later', 'UNKNOWN'],
  ];
  function correctStop(i) {
    var s = st.stops[i];
    Promise.all([API.places('restaurants'), API.places('facilities')]).then(function (r) {
      var rests = r[0].filter(function (x) { return x.active !== false && isFinite(x.lat); });
      var facs = r[1];
      // Nearest first: the right restaurant is almost always one of these.
      rests.forEach(function (x) { x._d = Math.hypot((x.lat - s.lat) * 111320, (x.lng - s.lng) * 111320 * Math.cos(s.lat * Math.PI / 180)); });
      rests.sort(function (a, b) { return a._d - b._d; });
      modal('<h3 style="margin:0 0 4px">Correct stop ' + s.gn + '</h3>'
        + '<p class="muted" style="margin:0 0 12px">Now: <b>' + esc(s.label || CAT[s.category].label) + '</b>, ' + hm(s.arrivalTs) + '–' + (s.departureTs ? hm(s.departureTs) : 'now')
        + '. Your decision is recorded with your name; the GPS and the original verdict are kept.</p>'
        + '<div class="field"><label for="jcCat">This stop was</label><select id="jcCat">'
        + CHOICES.map(function (c) { return '<option value="' + c[0] + '"' + (c[0] === s.category ? ' selected' : '') + '>' + esc(c[1]) + '</option>'; }).join('') + '</select></div>'
        + '<div class="field" id="jcRestBox"><label for="jcRest">Which restaurant</label>'
        + '<input id="jcFind" placeholder="Search by name" style="margin-bottom:6px">'
        + '<select id="jcRest" size="6">' + rests.slice(0, 400).map(function (x) {
          return '<option value="' + esc(x.id) + '"' + (x.id === s.placeId ? ' selected' : '') + '>' + esc(x.name) + (x.area ? ' — ' + esc(x.area) : '') + ' (' + (x._d < 1000 ? Math.round(x._d) + ' m' : (x._d / 1000).toFixed(1) + ' km') + ' away)</option>';
        }).join('') + '</select></div>'
        + '<div class="field" id="jcFacBox" hidden><label for="jcFac">Which site</label><select id="jcFac">'
        + facs.map(function (f) { return '<option value="' + esc(f.id) + '">' + esc(f.name) + '</option>'; }).join('') + '</select></div>'
        + '<div class="field"><label for="jcNote">Why (kept in the audit log)</label><textarea id="jcNote" rows="2" placeholder="e.g. Driver confirmed a Porter drop"></textarea></div>'
        + '<p id="jcErr" class="err" hidden></p>'
        + '<button class="btn-primary" id="jcSave">Save</button> <button class="btn-outline" id="jcCancel">Cancel</button>');
      var sync = function () {
        var v = $('jcCat').value;
        $('jcRestBox').hidden = v !== 'RESTAURANT';
        $('jcFacBox').hidden = v !== 'MODERN_DAIRY';
      };
      sync();
      $('jcCat').addEventListener('change', sync);
      $('jcFind').addEventListener('input', function (e) {
        var q = e.target.value.trim().toLowerCase();
        Array.prototype.forEach.call($('jcRest').options, function (o) { o.hidden = q && o.text.toLowerCase().indexOf(q) === -1; });
      });
      $('jcCancel').addEventListener('click', closeModal);
      $('jcSave').addEventListener('click', function () {
        var v = $('jcCat').value;
        var choice = CHOICES.find(function (c) { return c[0] === v; });
        var placeId = v === 'RESTAURANT' ? $('jcRest').value : v === 'MODERN_DAIRY' ? $('jcFac').value : null;
        var err = $('jcErr');
        if (v === 'RESTAURANT' && !placeId) { err.textContent = 'Choose the restaurant.'; err.hidden = false; return; }
        this.disabled = true;
        API.review(s.rideId, s.segmentId, choice[2], $('jcNote').value.trim() || null, placeId || undefined)
          .then(function () { closeModal(); load(); })
          .catch(function (e) { err.textContent = e.message; err.hidden = false; $('jcSave').disabled = false; });
      });
    }).catch(function (e) { alert(e.message); });
  }

  return { render: render, stop: stopTimers };
})();
