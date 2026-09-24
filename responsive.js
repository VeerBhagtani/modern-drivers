/* Tables that read on a phone.
 *
 * On a desktop a table is the right shape for forty drivers. On a phone its
 * columns either shrink to one word per line or push the page sideways, and
 * both are unreadable. So below phone width (see theme.css, "phone"), each row
 * becomes a small card: the first column is its title, and every other value
 * sits next to the name of the column it came from.
 *
 * That needs each cell to know its column's name, which is what this does. It
 * watches the page rather than being called from views.js, because tables are
 * built in nineteen places there and some fill their rows in later (a search
 * box re-rendering a tbody, a list loading more). Watching catches all of
 * them, including ones added after this was written, without touching any of
 * that code.
 *
 * Tables with fewer than three columns are left alone: a two-column table is
 * already a list of label and value, and stacking it would say everything
 * twice.
 */
(function () {
  'use strict';

  var MIN_COLUMNS = 3;

  function columnNames(table) {
    var row = table.tHead && table.tHead.rows[0];
    if (!row) return null;
    var names = [];
    Array.prototype.forEach.call(row.cells, function (th) {
      for (var i = 0; i < (th.colSpan || 1); i += 1) names.push(th.textContent.trim());
    });
    return names;
  }

  function label(table) {
    var names = columnNames(table);
    if (!names || names.length < MIN_COLUMNS) return;
    table.classList.add('stack');
    Array.prototype.forEach.call(table.tBodies, function (body) {
      Array.prototype.forEach.call(body.rows, function (tr) {
        var col = 0;
        Array.prototype.forEach.call(tr.cells, function (td) {
          if (!td.hasAttribute('data-label')) {
            // A cell spanning columns is a message ("No drivers match"), not a
            // value: it gets no label and the full width.
            if (td.colSpan > 1) {
              td.setAttribute('data-label', '');
              td.classList.add('span');
            } else {
              td.setAttribute('data-label', names[col] || '');
            }
          }
          col += td.colSpan || 1;
        });
      });
    });
  }

  var queued = false;
  function sweep() {
    queued = false;
    document.querySelectorAll('#view table, #modal table').forEach(label);
  }
  // Renders arrive in bursts; one sweep per frame is plenty.
  function queue() {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(sweep);
  }

  ['view', 'modal'].forEach(function (id) {
    var root = document.getElementById(id);
    if (root) new MutationObserver(queue).observe(root, { childList: true, subtree: true });
  });
  queue();
})();
