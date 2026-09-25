/* Maps for the office dashboard.
 *
 * Google Maps when a browser key is configured (Settings → Google Maps key),
 * and the free OpenFreeMap tiles through MapLibre until then, so no screen goes
 * blank while the key is being set up. Everything else in the dashboard talks
 * to this module only, in latitude/longitude objects — never to either map
 * library directly, and never in [lng, lat] arrays, which is how the two
 * libraries disagree and how coordinates end up in the sea.
 *
 * A map is a "handle": create() returns it at once, and ready(fn) runs fn when
 * the map can be drawn on. Driver markers are keyed by driver id and moved,
 * never re-created, so a driver can never appear twice on the map.
 */
window.DRIVERS_MAP = (function () {
  'use strict';
  var CFG = window.DRIVERS_CONFIG || {};
  var CENTER = { lat: 18.5204, lng: 73.8567 };   // Pune, before anything is plotted

  // What each kind of distance looks like, everywhere a route is drawn:
  // business green, personal purple, undecided amber, no GPS dashed grey.
  var BUCKET_COLOUR = { business: '#0f7a4a', personal: '#7b4fa8', unknown: '#c98a12', gap: '#8b93a7' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  var ok = function (p) { return !!p && typeof p.lat === 'number' && isFinite(p.lat) && typeof p.lng === 'number' && isFinite(p.lng); };

  // ── choosing and loading the provider ──────────────────────────────────
  var provider = null;          // 'google' | 'free'
  var providerReady = null;     // Promise<'google'|'free'>
  var authFailed = false;
  // Why the maps are what they are, in words the office can act on. Shown in
  // Settings and under every map that fell back to the free maps.
  var status = { state: 'loading', code: null, detail: '' };

  // Google's own error codes (printed to the console when it refuses a key),
  // and what to do about each in the Google Cloud console.
  var GOOGLE_ERRORS = {
    RefererNotAllowedMapError: 'This website is not allowed on the key. In the key\'s Website restrictions add https://veerbhagtani.github.io/* (and https://localhost/* for the driver app), then Save and wait 5 minutes.',
    ApiNotActivatedMapError: 'Maps JavaScript API is not turned on for this project. Enable it in APIs & Services → Library.',
    ApiTargetBlockedMapError: 'The key\'s API restrictions leave out Maps JavaScript API. Tick it (and Places API (New)) under API restrictions and Save.',
    BillingNotEnabledMapError: 'Billing is not turned on for the project. Link a billing account (the free monthly amount still applies).',
    InvalidKeyMapError: 'Google does not recognise this key. Copy it again from Credentials and save it here.',
    MissingKeyMapError: 'No key reached Google. Save the key here again.',
    ExpiredKeyMapError: 'This key has expired or was deleted. Create a new key and save it here.',
    DeletedApiProjectMapError: 'The key belongs to a deleted project. Create a key in modern-drivers-pune.',
    OverQuotaMapError: 'The key has hit its daily limit. Raise the quota or wait until tomorrow.',
  };
  function explain(code) { return GOOGLE_ERRORS[code] || 'Google refused the key. Check its restrictions in Credentials.'; }

  // Google reports the reason only on the console. Listen for it while Google
  // Maps is in use, so the reason can be shown on the page.
  var errorHooked = false;
  function hookGoogleErrors() {
    if (errorHooked || !window.console) return;
    errorHooked = true;
    var orig = console.error;
    console.error = function () {
      try {
        var text = Array.prototype.join.call(arguments, ' ');
        var m = /Google Maps JavaScript API (?:error|warning): (\w+)/.exec(text);
        if (m && /Error$/.test(m[1])) {
          status = { state: 'refused', code: m[1], detail: explain(m[1]) };
          window.dispatchEvent(new Event('md-maps-status'));
        }
      } catch (e) { /* never break logging */ }
      return orig.apply(console, arguments);
    };
  }

  /* Decided once per page: ask the server for the browser key and, if there is
   * one, load Google Maps. Any failure falls back to the free maps rather than
   * leaving the office with no map at all. */
  function init() {
    if (providerReady) return providerReady;
    var api = window.DRIVERS_API;
    providerReady = (api && api.mapsConfig ? api.mapsConfig() : Promise.reject(new Error('not signed in')))
      .then(function (cfg) {
        if (!(cfg && cfg.provider === 'google' && cfg.key)) {
          status = { state: 'no_key', code: null, detail: 'No Google Maps key is saved yet. Paste one in Settings → Google Maps.' };
          return 'free';
        }
        // A key Google refused a moment ago is not tried again on every screen,
        // but only for a couple of minutes: fixing the key in the Google console
        // must not need a new browser tab to take effect.
        var r = refused();
        if (r && r.key === cfg.key && Date.now() - r.at < 2 * 60 * 1000) {
          authFailed = true;
          status = { state: 'refused', code: r.code, detail: explain(r.code) };
          return 'free';
        }
        hookGoogleErrors();
        return loadGoogle(cfg.key).then(function () {
          status = { state: 'google', code: null, detail: 'Google Maps is in use.' };
          return 'google';
        }, function (e) {
          status = { state: 'load_failed', code: null, detail: (e && e.message) || 'Google Maps did not load.' };
          return 'free';
        });
      }, function (e) {
        status = { state: 'server_error', code: null, detail: 'Could not ask the server for the Google Maps key: ' + ((e && e.message) || e) };
        return 'free';
      })
      .then(function (p) { provider = p; window.dispatchEvent(new Event('md-maps-status')); return p; });
    return providerReady;
  }

  var REFUSED = 'md_maps_refused';
  function refused() { try { return JSON.parse(sessionStorage.getItem(REFUSED) || 'null'); } catch (e) { return null; } }
  /* Forget a refusal and load the page again: after fixing the key. */
  function retry() {
    try { sessionStorage.removeItem(REFUSED); sessionStorage.removeItem('md_maps_refused_key'); } catch (e) { /* private window */ }
    location.reload();
  }

  function loadGoogle(key) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      // Called by Google when it refuses the key (wrong website restriction,
      // API not enabled). The console error just before it names the reason.
      window.gm_authFailure = function () {
        authFailed = true;
        if (status.state !== 'refused') status = { state: 'refused', code: null, detail: explain(null) };
        console.warn('Google Maps refused the browser key: ' + status.detail);
        // Google leaves a grey "can't load Google Maps" box where the map was.
        // Switch to the free maps and ask the screen to draw itself again.
        try { sessionStorage.setItem(REFUSED, JSON.stringify({ key: key, code: status.code, at: Date.now() })); } catch (e) { /* private window */ }
        provider = 'free';
        providerReady = Promise.resolve('free');
        window.dispatchEvent(new Event('md-maps-status'));
        window.dispatchEvent(new Event('md-maps-fallback'));
      };
      window.__mdGoogleMapsLoaded = function () {
        Promise.all([
          google.maps.importLibrary('maps'),
          google.maps.importLibrary('marker'),
          google.maps.importLibrary('places').catch(function () { return null; }),
        ]).then(function () { settled = true; resolve(); }, function (e) { settled = true; reject(e); });
      };
      var s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key)
        + '&v=weekly&loading=async&region=IN&language=en&callback=__mdGoogleMapsLoaded';
      s.async = true;
      s.onerror = function () { settled = true; reject(new Error('Could not reach Google Maps from this computer (blocked by a network filter or ad blocker?).')); };
      document.head.appendChild(s);
      // Never wait for ever on a script that will not arrive.
      setTimeout(function () { if (!settled) reject(new Error('Google Maps took too long to load.')); }, 15000);
    });
  }

  // ── handles ────────────────────────────────────────────────────────────
  function create(containerId, opts) {
    opts = opts || {};
    var el = document.getElementById(containerId);
    if (!el) return null;
    var handle = {
      provider: null, raw: null, layers: {}, _queue: [], _ready: false,
      ready: function (fn) { if (this._ready) fn(this); else this._queue.push(fn); return this; },
      flyTo: function (p, zoom) {
        if (!this._ready || !ok(p)) return;
        if (this.provider === 'google') { this.raw.panTo(p); this.raw.setZoom(zoom || 16); } else this.raw.flyTo({ center: [p.lng, p.lat], zoom: zoom || 16 });
      },
      fit: function (pts) { fit(this, pts); },
      onClick: function (fn) {
        var h = this;
        h.ready(function () {
          if (h.provider === 'google') h.raw.addListener('click', function (e) { fn({ lat: e.latLng.lat(), lng: e.latLng.lng() }); });
          else h.raw.on('click', function (e) { fn({ lat: e.lngLat.lat, lng: e.lngLat.lng }); });
        });
      },
      resize: function () { if (this._ready && this.provider === 'free') this.raw.resize(); },
    };
    var center = ok(opts.center) ? opts.center : CENTER;
    init().then(function (p) {
      if (!document.body.contains(el)) return;   // the screen changed while loading
      handle.provider = p;
      if (p === 'google') {
        handle.raw = new google.maps.Map(el, {
          center: center, zoom: opts.zoom || 11,
          mapTypeControl: false, streetViewControl: false, fullscreenControl: true,
          clickableIcons: false, gestureHandling: 'greedy',
        });
        google.maps.event.addListenerOnce(handle.raw, 'idle', function () { markReady(handle); });
      } else {
        if (!window.maplibregl) return;
        try { if (maplibregl.setWorkerUrl) maplibregl.setWorkerUrl(CFG.MAP_WORKER); } catch (e) { /* already set */ }
        handle.raw = new maplibregl.Map({
          container: el, style: CFG.MAP_STYLE, center: [center.lng, center.lat], zoom: opts.zoom || 11, attributionControl: true,
        });
        handle.raw.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        handle.raw.once('load', function () { markReady(handle); });
      }
    });
    return handle;
  }
  function markReady(h) {
    h._ready = true;
    var q = h._queue; h._queue = [];
    q.forEach(function (fn) { try { fn(h); } catch (e) { console.error(e); } });
  }

  function fit(h, pts) {
    var list = (pts || []).filter(ok);
    if (!h || !h._ready || !list.length) return;
    if (h.provider === 'google') {
      if (list.length === 1) { h.raw.setCenter(list[0]); h.raw.setZoom(15); return; }
      var b = new google.maps.LatLngBounds();
      list.forEach(function (p) { b.extend(p); });
      h.raw.fitBounds(b, 50);
      // fitBounds on a short trip zooms to street level; cap it as the free map does.
      google.maps.event.addListenerOnce(h.raw, 'idle', function () { if (h.raw.getZoom() > 16) h.raw.setZoom(16); });
    } else {
      var bb = list.reduce(function (a, p) {
        return [Math.min(a[0], p.lng), Math.min(a[1], p.lat), Math.max(a[2], p.lng), Math.max(a[3], p.lat)];
      }, [180, 90, -180, -90]);
      try { h.raw.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 50, maxZoom: 16, duration: 400 }); } catch (e) { /* degenerate bounds */ }
    }
  }

  // ── layers: everything drawn under an id can be removed together ───────
  function clearLayer(h, id) {
    if (!h || !h.layers[id]) return;
    var items = h.layers[id];
    delete h.layers[id];
    items.forEach(function (it) {
      if (it.maplibre) {
        (it.layers || []).forEach(function (l) { if (h.raw.getLayer(l)) h.raw.removeLayer(l); });
        if (h.raw.getSource(it.source)) h.raw.removeSource(it.source);
      } else if (it.setMap) {
        it.setMap(null);
      } else if (it.remove) {
        it.remove();
      }
    });
  }
  function keep(h, id, item) { (h.layers[id] = h.layers[id] || []).push(item); return item; }

  // ── driver markers (live fleet) ────────────────────────────────────────
  var STATE_COLOUR = { live: '#0f7a4a', stale: '#d99a2b', unavailable: '#9aa3bd' };

  // Hover text. Never says "live" unless the position genuinely is: the age
  // and the state come straight from the server's own stale threshold.
  function driverTitle(d) {
    var age = d.lastUpdateAgeSec;
    var ageText = age == null ? 'no position yet'
      : age < 60 ? age + ' seconds ago' : age < 3600 ? Math.round(age / 60) + ' minutes ago' : Math.round(age / 3600) + ' hours ago';
    var label = d.locationState === 'live' ? 'live position' : d.locationState === 'stale' ? 'LAST KNOWN position, not live' : 'no position';
    return d.name + ' (' + d.driverCode + ') — ' + label + ', updated ' + ageText;
  }

  function syncMarkers(store, drivers, onClick) {
    var h = store.map;
    if (!h || !h._ready) return;
    var seen = {};
    drivers.forEach(function (d) {
      if (!d.lastLocation || !ok(d.lastLocation)) return;
      seen[d.driverId] = true;
      var pos = { lat: d.lastLocation.lat, lng: d.lastLocation.lng };
      var existing = store.markers[d.driverId];
      if (h.provider === 'google') {
        var icon = { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: STATE_COLOUR[d.locationState] || STATE_COLOUR.unavailable,
          fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 };
        if (existing) { existing.setPosition(pos); existing.setIcon(icon); existing.setTitle(driverTitle(d)); existing.__d = d; return; }
        var m = new google.maps.Marker({ map: h.raw, position: pos, icon: icon, title: driverTitle(d), zIndex: 1000 });
        m.__d = d;
        m.addListener('click', function () { if (onClick) onClick(m.__d); });
        store.markers[d.driverId] = m;
      } else {
        if (existing) {
          existing.marker.setLngLat([pos.lng, pos.lat]);
          existing.el.className = 'marker ' + d.locationState;
          existing.el.title = driverTitle(d);
          existing.d = d;
          return;
        }
        var el = document.createElement('div');
        el.className = 'marker ' + d.locationState;
        el.title = driverTitle(d);
        var rec = { el: el, d: d };
        rec.marker = new maplibregl.Marker({ element: el }).setLngLat([pos.lng, pos.lat]).addTo(h.raw);
        el.addEventListener('click', function () { if (onClick) onClick(rec.d); });
        store.markers[d.driverId] = rec;
      }
    });
    // Drivers who no longer report a position at all leave the map.
    Object.keys(store.markers).forEach(function (id) {
      if (seen[id]) return;
      var mk = store.markers[id];
      if (h.provider === 'google') mk.setMap(null); else mk.marker.remove();
      delete store.markers[id];
    });
  }

  // ── restaurants and depots ─────────────────────────────────────────────
  /* opts.highlight: { id: true } for places drawn larger — e.g. the ones
   * visited on a ride being replayed.
   *
   * Only the id and name travel with each point; the caller holds the full row. */
  function drawPlaces(h, id, places, color, onClick, opts) {
    if (!h || !h._ready) return;
    clearLayer(h, id);
    var list = (places || []).filter(ok);
    if (!list.length) return;
    var hl = (opts && opts.highlight) || {};
    color = color || '#D7262F';
    if (h.provider === 'google') {
      // A Data layer rather than thousands of Marker objects: three thousand
      // restaurants draw without the page grinding.
      var layer = new google.maps.Data({ map: h.raw });
      list.forEach(function (p) {
        layer.add({ geometry: new google.maps.Data.Point({ lat: p.lat, lng: p.lng }),
          properties: { id: p.id, name: p.name || '', hold: p.supplyHold === true, big: !!hl[p.id] } });
      });
      layer.setStyle(function (f) {
        var hold = f.getProperty('hold');
        var big = f.getProperty('big');
        return {
          title: f.getProperty('name') + (hold ? ' (supply on hold)' : ''),
          // A held restaurant must not look like one a driver should visit:
          // hollow, in the warning colour.
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: big ? 8 : 5,
            fillColor: hold ? '#fdf3df' : color, fillOpacity: 1, strokeColor: hold ? '#8a5f14' : '#fff', strokeWeight: 2 },
          zIndex: big ? 500 : 100,
          cursor: typeof onClick === 'function' ? 'pointer' : 'default',
        };
      });
      if (typeof onClick === 'function') layer.addListener('click', function (e) { onClick(e.feature.getProperty('id')); });
      keep(h, id, layer);
      return;
    }
    var fc = { type: 'FeatureCollection', features: list.map(function (p) {
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: { id: p.id, name: p.name || '', onHold: p.supplyHold === true ? 1 : 0, big: hl[p.id] ? 1 : 0 } };
    }) };
    var src = id + '-src';
    h.raw.addSource(src, { type: 'geojson', data: fc });
    h.raw.addLayer({ id: id + '-sym', type: 'circle', source: src, paint: {
      'circle-radius': ['case', ['==', ['get', 'big'], 1], 8, 5],
      'circle-color': ['case', ['==', ['get', 'onHold'], 1], '#fdf3df', color],
      'circle-stroke-width': 2,
      'circle-stroke-color': ['case', ['==', ['get', 'onHold'], 1], '#8a5f14', '#fff'],
    } });
    keep(h, id, { maplibre: true, source: src, layers: [id + '-sym'] });
    if (typeof onClick === 'function') {
      h.raw.on('click', id + '-sym', function (e) { var f = e.features && e.features[0]; if (f) onClick(f.properties.id); });
      h.raw.on('mouseenter', id + '-sym', function () { h.raw.getCanvas().style.cursor = 'pointer'; });
      h.raw.on('mouseleave', id + '-sym', function () { h.raw.getCanvas().style.cursor = ''; });
    }
  }

  // ── lines ──────────────────────────────────────────────────────────────
  /* One polyline under a layer id. style: { color, width, opacity, dashed, z } */
  function line(h, id, pts, style) {
    pts = (pts || []).filter(ok);
    if (pts.length < 2) return;
    style = style || {};
    var color = style.color || '#1B2A6B';
    if (h.provider === 'google') {
      var o = { map: h.raw, path: pts.map(function (p) { return { lat: p.lat, lng: p.lng }; }),
        strokeColor: color, strokeOpacity: style.opacity == null ? 0.9 : style.opacity, strokeWeight: style.width || 4, zIndex: style.z || 10 };
      if (style.dashed) {
        o.strokeOpacity = 0;
        o.icons = [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.9, strokeColor: color, scale: 3 }, offset: '0', repeat: '14px' }];
      }
      keep(h, id, new google.maps.Polyline(o));
      return;
    }
    h.__seq = (h.__seq || 0) + 1;
    var src = id + '-l' + h.__seq;
    h.raw.addSource(src, { type: 'geojson', data: { type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: pts.map(function (p) { return [p.lng, p.lat]; }) } } });
    var paint = { 'line-color': color, 'line-width': style.width || 4, 'line-opacity': style.opacity == null ? 0.9 : style.opacity };
    if (style.dashed) paint['line-dasharray'] = [1.5, 1.5];
    h.raw.addLayer({ id: src + '-line', type: 'line', source: src, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: paint });
    keep(h, id, { maplibre: true, source: src, layers: [src + '-line'] });
  }

  /* Many rides at once, for the reports screen. Each ride is one or more lines
   * — split at GPS gaps, so a silence is not drawn as a straight road.
   * @param tracks [{ color, lines: [[{lat,lng}, ...], ...] }] */
  function drawTracks(h, id, tracks) {
    if (!h || !h._ready) return;
    clearLayer(h, id);
    (tracks || []).forEach(function (t) {
      (t.lines || []).forEach(function (pts) {
        // Several drivers often share a road. Semi-transparent lines show the
        // overlap as a darker stripe rather than hiding all but the last.
        line(h, id, pts, { color: t.color, width: 3, opacity: 0.6 });
      });
    });
  }

  // ── pins ───────────────────────────────────────────────────────────────
  /* A marker under a layer id.
   * opts: { label (1–2 chars), color, title, draggable, onMove(p), dot (radius
   *        for a plain dot instead of a labelled pin), z } */
  function pin(h, id, p, opts) {
    if (!h || !h._ready || !ok(p)) return null;
    opts = opts || {};
    var color = opts.color || '#1B2A6B';
    if (h.provider === 'google') {
      var m = new google.maps.Marker({
        map: h.raw, position: { lat: p.lat, lng: p.lng }, draggable: !!opts.draggable, title: opts.title || '', zIndex: opts.z || 800,
        label: opts.label ? { text: opts.label, color: '#fff', fontWeight: '700', fontSize: '11px' } : undefined,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: opts.dot || 11, fillColor: color, fillOpacity: 1,
          strokeColor: '#fff', strokeWeight: opts.dot ? 3 : 2 },
      });
      if (opts.onMove) m.addListener('dragend', function (e) { opts.onMove({ lat: e.latLng.lat(), lng: e.latLng.lng() }); });
      keep(h, id, m);
      return { setPosition: function (q) { if (ok(q)) m.setPosition({ lat: q.lat, lng: q.lng }); }, remove: function () { m.setMap(null); } };
    }
    var size = opts.dot ? opts.dot * 2 : 22;
    var el = document.createElement('div');
    el.style.cssText = 'width:' + size + 'px;height:' + size + 'px;border-radius:50%;box-sizing:border-box;'
      + 'background:' + color + ';border:' + (opts.dot ? 3 : 2) + 'px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.4);'
      + 'color:#fff;font:700 11px sans-serif;display:flex;align-items:center;justify-content:center;'
      + 'cursor:' + (opts.draggable ? 'grab' : 'default');
    el.textContent = opts.label || '';
    el.title = opts.title || '';
    var mk = new maplibregl.Marker({ element: el, draggable: !!opts.draggable }).setLngLat([p.lng, p.lat]).addTo(h.raw);
    if (opts.onMove) mk.on('dragend', function () { var ll = mk.getLngLat(); opts.onMove({ lat: ll.lat, lng: ll.lng }); });
    keep(h, id, mk);
    return { setPosition: function (q) { if (ok(q)) mk.setLngLat([q.lng, q.lat]); }, remove: function () { mk.remove(); } };
  }

  // ── the ride replay ────────────────────────────────────────────────────
  /* Draw one ride the way it was calculated:
   *   - the route in runs coloured by what each stretch counted as — business,
   *     personal, undecided — from the server's own per-point verdicts;
   *   - stretches with no GPS as dashed straight lines, never as a road;
   *   - fixes the calculation excluded as small grey dots, kept visible;
   *   - start, end and each restaurant visited, marked;
   *   - a playback marker the caller moves with seek().
   *
   * @param replay { points: [{lat,lng,ts,used,quality,b}], gaps: [{fromTs,toTs}] }
   * @param extras { visits: [{lat,lng,label,title}] }
   * @returns { count, points, seek(i) } over the counted points, or null
   */
  function drawReplay(h, replay, extras) {
    if (!h || !h._ready || !replay || !replay.points) return null;
    clearLayer(h, 'replay');
    var used = replay.points.filter(function (p) { return p.used && ok(p); });
    var gapAfter = {};
    (replay.gaps || []).forEach(function (g) { gapAfter[g.fromTs] = true; });

    // Runs of one kind, split where the GPS went silent.
    var run = [];
    var runB = null;
    var flush = function () {
      if (run.length > 1) line(h, 'replay', run, { color: BUCKET_COLOUR[runB] || '#1B2A6B', width: 5, z: 20 });
      run = [];
    };
    for (var i = 0; i < used.length; i += 1) {
      var p = used[i];
      if (runB !== null && p.b !== runB) {
        // The new colour starts exactly where the old one ended: no break.
        var joint = run[run.length - 1];
        flush();
        if (joint) run.push(joint);
      }
      runB = p.b;
      run.push(p);
      if (gapAfter[p.ts] && used[i + 1]) {
        flush();
        line(h, 'replay', [p, used[i + 1]], { color: BUCKET_COLOUR.gap, dashed: true, width: 3, z: 15 });
        runB = null;
      }
    }
    flush();

    // Excluded fixes, small and grey. Leaving them out of the picture would
    // hide exactly the evidence a reviewer needs.
    var bad = replay.points.filter(function (q) { return !q.used && ok(q); });
    if (bad.length) {
      if (h.provider === 'google') {
        var layer = new google.maps.Data({ map: h.raw });
        bad.forEach(function (q) { layer.add({ geometry: new google.maps.Data.Point({ lat: q.lat, lng: q.lng }), properties: { why: q.quality } }); });
        layer.setStyle(function (f) {
          return { title: 'Not counted: ' + String(f.getProperty('why') || '').replace(/_/g, ' '),
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 3, fillColor: '#98a2b3', fillOpacity: 0.9, strokeWeight: 0 }, zIndex: 5 };
        });
        keep(h, 'replay', layer);
      } else {
        var src = 'replay-bad';
        h.raw.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: bad.map(function (q) {
          return { type: 'Feature', geometry: { type: 'Point', coordinates: [q.lng, q.lat] }, properties: {} };
        }) } });
        h.raw.addLayer({ id: src + '-dots', type: 'circle', source: src, paint: { 'circle-radius': 3, 'circle-color': '#98a2b3', 'circle-opacity': 0.9 } });
        keep(h, 'replay', { maplibre: true, source: src, layers: [src + '-dots'] });
      }
    }

    ((extras && extras.visits) || []).forEach(function (v) { pin(h, 'replay', v, { label: v.label, color: v.color || '#D7262F', title: v.title, z: 700 }); });
    if (used.length) {
      pin(h, 'replay', used[0], { label: 'S', color: '#0f7a4a', title: 'Start', z: 900 });
      pin(h, 'replay', used[used.length - 1], { label: 'E', color: '#b3261e', title: 'End', z: 900 });
    }
    var head = used.length ? pin(h, 'replay', used[0], { dot: 8, color: '#1B2A6B', title: 'Replay position', z: 1000 }) : null;
    fit(h, used.length ? used : replay.points);
    return {
      count: used.length,
      points: used,
      seek: function (k) {
        if (!head || !used.length) return null;
        var q = used[Math.max(0, Math.min(used.length - 1, k))];
        head.setPosition(q);
        return q;
      },
    };
  }

  // ── search ─────────────────────────────────────────────────────────────
  /* Jump the map to a place by name: Google Places when Google Maps is in use,
   * OpenStreetMap's own search otherwise. Only ever moves the view, so a wrong
   * answer costs a scroll, not a geofence. */
  function search(query) {
    var q = String(query || '').trim();
    if (!q) return Promise.resolve(null);
    return init().then(function (p) {
      var P = p === 'google' && google.maps.places && google.maps.places.Place;
      if (P && P.searchByText) {
        return P.searchByText({
          textQuery: q + ', Pune', fields: ['displayName', 'location', 'formattedAddress'],
          locationBias: CENTER, maxResultCount: 1, region: 'in', language: 'en',
        }).then(function (r) {
          var place = r && r.places && r.places[0];
          if (!place || !place.location) return null;
          return { lat: place.location.lat(), lng: place.location.lng(), label: place.displayName || place.formattedAddress || q };
        }).catch(function (e) {
          console.warn('Google search failed; trying OpenStreetMap.', e);
          return nominatim(q);
        });
      }
      return nominatim(q);
    });
  }
  function nominatim(q) {
    var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in'
      + '&viewbox=73.55,18.75,74.10,18.30&bounded=0&q=' + encodeURIComponent(q + ', Pune, Maharashtra');
    return fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        if (!rows || !rows.length) return null;
        var lat = Number(rows[0].lat); var lng = Number(rows[0].lon);
        return isFinite(lat) && isFinite(lng) ? { lat: lat, lng: lng, label: rows[0].display_name || q } : null;
      });
  }

  return {
    init: init,
    provider: function () { return provider; },
    keyRefused: function () { return authFailed; },
    status: function () { return status; },
    retry: retry,
    create: create,
    syncMarkers: syncMarkers,
    drawPlaces: drawPlaces,
    drawTracks: drawTracks,
    drawReplay: drawReplay,
    clearLayer: clearLayer,
    pin: pin,
    line: function (h, id, pts, style) { if (h && h._ready) line(h, id, pts, style); },
    fit: fit,
    search: search,
    esc: esc,
    BUCKET_COLOUR: BUCKET_COLOUR,
  };
})();
