/* MapLibre wrapper.
 *
 * All map-provider knowledge in the dashboard is here plus MAP_STYLE in
 * config.js. Swapping OpenFreeMap for another vector-tile provider means
 * changing the style URL; swapping MapLibre itself means rewriting this file
 * and nothing else.
 *
 * Markers are keyed by driver id and MOVED, never re-created, so a driver can
 * never appear twice on the map — which is the one thing a live fleet map must
 * not do.
 */
window.DRIVERS_MAP = (function () {
  'use strict';
  var CFG = window.DRIVERS_CONFIG || {};

  function create(containerId, opts) {
    var el = document.getElementById(containerId);
    if (!el || !window.maplibregl) return null;
    try {
      if (maplibregl.setWorkerUrl) maplibregl.setWorkerUrl(CFG.MAP_WORKER);
    } catch (e) { /* already set */ }
    var map = new maplibregl.Map({
      container: el,
      style: CFG.MAP_STYLE,
      center: (opts && opts.center) || CFG.MAP_CENTER,
      zoom: (opts && opts.zoom) || 11,
      attributionControl: true,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    return map;
  }

  function markerEl(state) {
    var d = document.createElement('div');
    d.className = 'marker ' + state;
    return d;
  }

  /**
   * Sync the marker set to the driver list.
   * @param {object} store  { map, markers: {} }
   * @param {Array} drivers dashboard rows
   * @param {function} onClick
   */
  function syncMarkers(store, drivers, onClick) {
    if (!store.map) return;
    var seen = {};
    drivers.forEach(function (d) {
      if (!d.lastLocation) return;
      seen[d.driverId] = true;
      var lngLat = [d.lastLocation.lng, d.lastLocation.lat];
      var existing = store.markers[d.driverId];
      if (existing) {
        existing.marker.setLngLat(lngLat);
        existing.el.className = 'marker ' + d.locationState;
        existing.popup.setHTML(popupHtml(d));
        return;
      }
      var el = markerEl(d.locationState);
      var popup = new maplibregl.Popup({ offset: 14, closeButton: false }).setHTML(popupHtml(d));
      var marker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).setPopup(popup).addTo(store.map);
      el.addEventListener('click', function () { if (onClick) onClick(d); });
      store.markers[d.driverId] = { marker: marker, el: el, popup: popup };
    });
    // Remove markers for drivers that no longer report a position at all.
    Object.keys(store.markers).forEach(function (id) {
      if (seen[id]) return;
      store.markers[id].marker.remove();
      delete store.markers[id];
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // The popup never says "live" unless the position genuinely is: the age and
  // the state come straight from the server's own stale threshold.
  function popupHtml(d) {
    var age = d.lastUpdateAgeSec;
    var ageText = age == null ? 'no position yet'
      : age < 60 ? age + ' seconds ago'
        : age < 3600 ? Math.round(age / 60) + ' minutes ago'
          : Math.round(age / 3600) + ' hours ago';
    var label = d.locationState === 'live' ? 'Live position'
      : d.locationState === 'stale' ? 'LAST KNOWN position — not live'
        : 'No position';
    return '<div style="font-size:.85rem;line-height:1.5">'
      + '<b>' + esc(d.name) + '</b><br>'
      + '<span style="color:#4b5768">' + esc(d.driverCode) + ' · ' + esc(d.rideStatus) + '</span><br>'
      + '<b>' + esc(label) + '</b><br>'
      + 'Updated ' + esc(ageText)
      + (d.lastLocation && d.lastLocation.accuracyM ? '<br>Accuracy ±' + Math.round(d.lastLocation.accuracyM) + ' m' : '')
      + '</div>';
  }

  // Draw a route as a GeoJSON line plus per-point circles coloured by quality,
  // so a reviewer can see which fixes were excluded and why.
  function drawRoute(map, sourceId, points, opts) {
    if (!map || !map.isStyleLoaded()) return false;
    opts = opts || {};
    var line = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: points.filter(function (p) { return p.countDistance !== false; }).map(function (p) { return [p.lng, p.lat]; }) },
      properties: {},
    };
    var dots = {
      type: 'FeatureCollection',
      features: points.map(function (p) {
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          properties: { quality: p.quality || 'ok', used: p.countDistance === false ? 'no' : 'yes' },
        };
      }),
    };

    if (map.getSource(sourceId)) {
      map.getSource(sourceId).setData(line);
      map.getSource(sourceId + '-pts').setData(dots);
      return true;
    }
    map.addSource(sourceId, { type: 'geojson', data: line });
    map.addLayer({
      id: sourceId + '-line', type: 'line', source: sourceId,
      paint: { 'line-color': opts.color || '#1B2A6B', 'line-width': 4, 'line-opacity': 0.85 },
    });
    map.addSource(sourceId + '-pts', { type: 'geojson', data: dots });
    map.addLayer({
      id: sourceId + '-dots', type: 'circle', source: sourceId + '-pts',
      paint: {
        'circle-radius': 3.5,
        // Excluded fixes stay visible, in grey. Deleting them from the picture
        // would hide exactly the evidence a reviewer needs.
        'circle-color': ['case', ['==', ['get', 'used'], 'no'], '#98a2b3', '#2c3f8f'],
        'circle-opacity': 0.9,
      },
    });
    return true;
  }

  /* Many rides at once, for the reports screen.
   *
   * Deliberately not drawRoute() in a loop: that draws a dot per GPS fix, and
   * twenty rides is tens of thousands of dots — enough to lock the browser up
   * and to turn the picture into a smear. Here each ride is one line, in one
   * source, and the individual fixes stay where they belong, on the single-ride
   * replay where somebody is actually auditing them.
   *
   * @param tracks [{ rideId, label, color, coords: [[lng,lat], ...] }]
   */
  function drawTracks(map, sourceId, tracks) {
    if (!map || !map.isStyleLoaded()) return false;
    var fc = {
      type: 'FeatureCollection',
      features: (tracks || []).filter(function (t) { return t.coords && t.coords.length > 1; })
        .map(function (t) {
          return {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: t.coords },
            properties: { label: t.label || '', color: t.color || '#1B2A6B', rideId: t.rideId || '' },
          };
        }),
    };

    if (map.getSource(sourceId)) { map.getSource(sourceId).setData(fc); return true; }
    map.addSource(sourceId, { type: 'geojson', data: fc });
    map.addLayer({
      id: sourceId + '-line', type: 'line', source: sourceId,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      // Several drivers often share a road. Semi-transparent lines let the
      // overlap show as a darker stripe rather than hiding all but the last
      // one drawn.
      paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.6 },
    });
    return true;
  }

  function clearLayer(map, sourceId) {
    if (!map || !map.getSource(sourceId)) return;
    [sourceId + '-line', sourceId + '-sym', sourceId + '-dots'].forEach(function (id) {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    map.removeSource(sourceId);
  }

  function drawPlaces(map, sourceId, places, color) {
    if (!map || !map.isStyleLoaded() || !places.length) return;
    // A place still awaiting a location has no coordinates. One such row would
    // make the whole layer invalid, so they are dropped here as well.
    var fc = {
      type: 'FeatureCollection',
      features: places.filter(function (p) {
        return typeof p.lat === 'number' && isFinite(p.lat) && typeof p.lng === 'number' && isFinite(p.lng);
      }).map(function (p) {
        return { type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { name: p.name } };
      }),
    };
    if (map.getSource(sourceId)) { map.getSource(sourceId).setData(fc); return; }
    map.addSource(sourceId, { type: 'geojson', data: fc });
    map.addLayer({
      id: sourceId + '-sym', type: 'circle', source: sourceId,
      paint: { 'circle-radius': 6, 'circle-color': color || '#D7262F', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' },
    });
  }

  function fitTo(map, coords) {
    if (!map || !coords.length) return;
    var b = coords.reduce(function (acc, c) {
      return [Math.min(acc[0], c[0]), Math.min(acc[1], c[1]), Math.max(acc[2], c[0]), Math.max(acc[3], c[1])];
    }, [180, 90, -180, -90]);
    try { map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 50, maxZoom: 15, duration: 500 }); } catch (e) { /* degenerate bounds */ }
  }

  return {
    create: create,
    syncMarkers: syncMarkers,
    drawRoute: drawRoute,
    drawTracks: drawTracks,
    clearLayer: clearLayer,
    drawPlaces: drawPlaces,
    fitTo: fitTo,
    esc: esc,
  };
})();
