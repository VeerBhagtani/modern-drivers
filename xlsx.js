/* Reading an .xlsx in the browser, with no library.
 *
 * The office keeps its customer list in Excel and will keep updating it there.
 * Asking somebody to Save As → CSV before every upload is a step that gets
 * forgotten, and then the import silently stops being run — so the dashboard
 * reads the workbook directly.
 *
 * An .xlsx is a ZIP of XML. The browser can already do both halves:
 * DecompressionStream inflates the entries, and the two files that matter have
 * a simple enough shape to read without a parser. That is 150 lines here
 * against most of a megabyte of SheetJS on a page the office loads every day.
 *
 * Deliberately narrow. It reads text and numbers from the first worksheet and
 * nothing else: no formulas, no dates, no formatting, no second sheet. That is
 * exactly what a list of names and addresses needs, and anything it cannot
 * read it says so about rather than returning half a file.
 */
window.DRIVERS_XLSX = (function () {
  'use strict';

  // ── ZIP ────────────────────────────────────────────────────────────────
  // Read the central directory rather than walking local headers: only the
  // central directory reliably carries the compressed size, and a streamed
  // entry can otherwise run past its own end.
  function findCentralDirectory(view, bytes) {
    // The end-of-central-directory record is at the end, after a comment of
    // unknown length, so scan backwards for its signature.
    for (var i = bytes.length - 22; i >= 0 && i > bytes.length - 65558; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) {
        return { count: view.getUint16(i + 10, true), offset: view.getUint32(i + 16, true) };
      }
    }
    throw new Error('That file is not a valid .xlsx (no ZIP directory found).');
  }

  function listEntries(buf) {
    var view = new DataView(buf);
    var bytes = new Uint8Array(buf);
    var eocd = findCentralDirectory(view, bytes);
    var entries = {};
    var p = eocd.offset;
    for (var n = 0; n < eocd.count; n += 1) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      var method = view.getUint16(p + 10, true);
      var compressedSize = view.getUint32(p + 20, true);
      var nameLen = view.getUint16(p + 28, true);
      var extraLen = view.getUint16(p + 30, true);
      var commentLen = view.getUint16(p + 32, true);
      var localOffset = view.getUint32(p + 42, true);
      var name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { method: method, compressedSize: compressedSize, localOffset: localOffset };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries: entries, view: view, bytes: bytes };
  }

  function readEntry(zip, name) {
    var e = zip.entries[name];
    if (!e) return Promise.resolve(null);
    // The local header repeats the name and extra fields, and its extra length
    // can differ from the central one, so the data offset must come from here.
    var lh = e.localOffset;
    if (zip.view.getUint32(lh, true) !== 0x04034b50) {
      return Promise.reject(new Error('That .xlsx looks damaged.'));
    }
    var nameLen = zip.view.getUint16(lh + 26, true);
    var extraLen = zip.view.getUint16(lh + 28, true);
    var start = lh + 30 + nameLen + extraLen;
    var slice = zip.bytes.subarray(start, start + e.compressedSize);

    if (e.method === 0) return Promise.resolve(new TextDecoder().decode(slice));
    if (e.method !== 8) return Promise.reject(new Error('That .xlsx uses an unsupported compression method.'));
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('This browser cannot read .xlsx directly. Save the sheet as CSV and upload that.'));
    }
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([slice]).stream().pipeThrough(ds);
    return new Response(stream).text();
  }

  // ── XML ────────────────────────────────────────────────────────────────
  function unescapeXml(s) {
    return s
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); })
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&amp;/g, '&');   // last, or an escaped &amp;lt; would double-decode
  }

  // A shared string can be split into several runs by formatting, so every <t>
  // inside one <si> is part of the same value and they concatenate.
  function parseSharedStrings(xml) {
    if (!xml) return [];
    var out = [];
    var si = /<si>([\s\S]*?)<\/si>/g;
    var m;
    while ((m = si.exec(xml)) !== null) {
      var text = '';
      var t = /<t[^>]*>([\s\S]*?)<\/t>/g;
      var tm;
      while ((tm = t.exec(m[1])) !== null) text += tm[1];
      out.push(unescapeXml(text));
    }
    return out;
  }

  function colIndex(ref) {
    var letters = (ref.match(/^[A-Z]+/) || ['A'])[0];
    var n = 0;
    for (var i = 0; i < letters.length; i += 1) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }

  function parseSheet(xml, shared) {
    var rows = [];
    var rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
    var rm;
    while ((rm = rowRe.exec(xml)) !== null) {
      var cells = [];
      var cellRe = /<c([^>]*)\/>|<c([^>]*)>([\s\S]*?)<\/c>/g;
      var cm;
      while ((cm = cellRe.exec(rm[1])) !== null) {
        var attrs = cm[1] || cm[2] || '';
        var body = cm[3] || '';
        var ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
        var type = (attrs.match(/t="([^"]+)"/) || [])[1];
        var value = '';
        if (type === 'inlineStr') {
          var isM = body.match(/<t[^>]*>([\s\S]*?)<\/t>/);
          value = isM ? unescapeXml(isM[1]) : '';
        } else {
          var vM = body.match(/<v>([\s\S]*?)<\/v>/);
          var raw = vM ? vM[1] : '';
          if (type === 's') value = shared[Number(raw)] || '';
          else value = unescapeXml(raw);
        }
        var at = ref ? colIndex(ref) : cells.length;
        while (cells.length < at) cells.push('');   // blank cells are omitted in the XML
        cells[at] = value;
      }
      rows.push(cells);
    }
    return rows;
  }

  // ── the one function the page calls ────────────────────────────────────
  function readWorkbook(arrayBuffer) {
    var zip;
    try {
      zip = listEntries(arrayBuffer);
    } catch (e) {
      return Promise.reject(e);
    }
    // The first sheet, by the workbook's own ordering rather than by guessing
    // a filename — sheet1.xml is not always the first sheet.
    return readEntry(zip, 'xl/workbook.xml').then(function (wbXml) {
      var target = 'xl/worksheets/sheet1.xml';
      if (wbXml) {
        var first = wbXml.match(/<sheet[^>]*r:id="([^"]+)"/);
        if (first) {
          return readEntry(zip, 'xl/_rels/workbook.xml.rels').then(function (rels) {
            if (rels) {
              var re = new RegExp('<Relationship[^>]*Id="' + first[1] + '"[^>]*Target="([^"]+)"');
              var t = rels.match(re);
              if (t) target = 'xl/' + t[1].replace(/^\/?xl\//, '').replace(/^\//, '');
            }
            return target;
          });
        }
      }
      return target;
    }).then(function (sheetPath) {
      return Promise.all([
        readEntry(zip, 'xl/sharedStrings.xml'),
        readEntry(zip, sheetPath),
      ]);
    }).then(function (parts) {
      var shared = parseSharedStrings(parts[0]);
      if (!parts[1]) throw new Error('Could not find a worksheet inside that .xlsx.');
      var rows = parseSheet(parts[1], shared);
      if (!rows.length) throw new Error('That sheet appears to be empty.');
      return rows;
    });
  }

  function toCsv(rows) {
    return rows.map(function (r) {
      return r.map(function (cell) {
        var v = cell == null ? '' : String(cell);
        return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\n');
  }

  return { readWorkbook: readWorkbook, toCsv: toCsv, parseSharedStrings: parseSharedStrings, parseSheet: parseSheet, colIndex: colIndex };
})();
