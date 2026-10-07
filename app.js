'use strict';
(function () {
  const $ = (id) => document.getElementById(id);

  // ---------- palettes ----------
  // kept away from the red/orange/yellow slice hues so arcs stay distinguishable
  const ARC_COLORS = ['#A63BE0', '#19C3A6', '#2C7FB8', '#E7298A', '#8C510A', '#66A61E', '#5E3C99', '#01665E', '#B2182B', '#4D4D4D'];
  // index 0 = highest number of functions
  const COUNT_COLORS = ['#C62828', '#EF6C00', '#F9A825', '#2E7D32', '#1565C0', '#6A1B9A', '#4E342E', '#455A64', '#00838F', '#AD1457'];
  const COMBO_PALETTE = ['#1F77B4', '#FF7F0E', '#2CA02C', '#D62728', '#9467BD', '#8C564B', '#E377C2', '#7F7F7F', '#BCBD22', '#17BECF',
    '#AEC7E8', '#FFBB78', '#98DF8A', '#FF9896', '#C5B0D5', '#C49C94', '#F7B6D2', '#C7C7C7', '#DBDB8D', '#9EDAE5'];
  const NEG_COLOR = '#BDBDBD';

  const st = {
    wb: null, ds: null, fileBase: 'spice',
    markers: [],          // {name, label, include, color}
    countOverride: {},    // k -> color chosen by user
    pieOff: new Set(),    // pie names hidden by user
    pieMode: 'sample', groupCol: '',
    pieSig: '', lastSvg: '', lastSize: null, lastData: null,
  };
  let opts = {};

  // ---------- helpers ----------
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const f = (n) => (Math.round(n * 100) / 100).toString();

  function toNum(v) {
    if (typeof v === 'number') return v;
    if (v == null) return NaN;
    const s = String(v).trim().replace(/%$/, '').replace(/,/g, '');
    return s === '' ? NaN : Number(s);
  }

  const SIGN_T = new Set(['+', '1', 'pos', 'positive', 'yes', 'y', 'true', 't']);
  const SIGN_F = new Set(['-', '−', '–', '0', 'neg', 'negative', 'no', 'n', 'false', 'f']);
  function parseSign(v) {
    if (v === true || v === false) return v;
    if (v == null || v === '') return null;
    const s = String(v).trim().toLowerCase();
    if (SIGN_T.has(s)) return true;
    if (SIGN_F.has(s)) return false;
    return undefined;
  }

  // "IFNg+TNFa-IL2+", "IFNg+ , TNFa-", "IL-2+", "PD1negLAG3+", "Nrp1+2B4neg" -> [{name, key, pos}]
  // A "-" followed by a digit is part of the name (IL-2); "neg"/"pos" are accepted as signs.
  function parseSegment(seg) {
    const s = seg.replace(/[−–]/g, '-').replace(/^\s*Q\d+\s*:\s*/i, '').trim();
    if (!s) return null;
    const re = /([^\s,;]+?)\s*(\+|-(?!\d)|neg|pos)/gi;
    const toks = [];
    let m, last = 0;
    while ((m = re.exec(s))) {
      if (s.slice(last, m.index).replace(/[\s,;]/g, '') !== '') return null;
      toks.push({ name: m[1], key: m[1].toLowerCase(), pos: m[2] === '+' || m[2].toLowerCase() === 'pos' });
      last = re.lastIndex;
    }
    if (!toks.length || s.slice(last).replace(/[\s,;]/g, '') !== '') return null;
    return toks;
  }

  // Parses gate column names, e.g. "CD4/IFNg+TNFa-IL2+ | Freq. of Parent" or "PD1+/LAG3-/TIGIT+".
  function parseGateName(header) {
    const segs = String(header).split('|')[0].split('/');
    let toks = [];
    for (let i = segs.length - 1; i >= 0; i--) {
      const t = parseSegment(segs[i]);
      if (!t) break;
      toks = t.concat(toks);
    }
    const seen = new Map();
    toks.forEach((t) => seen.set(t.key, t));
    return seen.size >= 2 ? [...seen.values()] : null;
  }
  const keyOf = (toks) => toks.map((t) => t.key).sort().join('\u0001');

  function uniqueNames(samples) {
    const used = new Map();
    samples.forEach((s) => {
      const n = used.get(s.name) || 0;
      used.set(s.name, n + 1);
      if (n) s.name = `${s.name} (${n + 1})`;
    });
    return samples;
  }

  // ---------- dataset builders ----------
  function buildFlowJo(header, body) {
    const parsed = header.map((h) => (h ? parseGateName(h) : null));
    const counts = new Map();
    parsed.forEach((p) => { if (p) counts.set(keyOf(p), (counts.get(keyOf(p)) || 0) + 1); });
    let best = null, bestN = 0;
    counts.forEach((n, k) => { if (n > bestN) { best = k; bestN = n; } });
    if (!best || bestN < 2) return null;

    const cols = [];
    parsed.forEach((p, i) => { if (p && keyOf(p) === best) cols.push({ i, toks: p }); });
    const signOf = (c, key) => c.toks.find((t) => t.key === key).pos;
    // markers that are + in every column are parent gates (e.g. CD4+), not functions
    const kept = cols[0].toks.filter((t) => new Set(cols.map((c) => signOf(c, t.key))).size > 1);
    const markers = kept.map((t) => t.name);
    if (markers.length < 2) return null;

    const combos = [], colIdx = [], seen = new Set();
    cols.forEach((c) => {
      const signs = kept.map((t) => signOf(c, t.key));
      const k = signs.map(Number).join('');
      if (seen.has(k)) return;
      seen.add(k); combos.push(signs); colIdx.push(c.i);
    });

    const gateSet = new Set(cols.map((c) => c.i));
    const colName = (i) => header[i] || `Column ${i + 1}`;
    const textCols = header.map((_, i) => i).filter((i) => !gateSet.has(i) &&
      body.some((r) => r[i] != null && r[i] !== '' && !isFinite(toNum(r[i]))));
    const nameCol = textCols.length ? textCols[0] : (gateSet.has(0) ? -1 : 0);

    const samples = [];
    body.forEach((r, ri) => {
      const raw = nameCol >= 0 ? r[nameCol] : null;
      const name = raw != null && raw !== '' ? String(raw).trim() : `Row ${ri + 2}`;
      if (/^(mean|sd|std|stdev|median|average|avg|cv|sem)$/i.test(name)) return;
      const vals = colIdx.map((i) => toNum(r[i]));
      if (vals.every((v) => !isFinite(v))) return;
      const meta = {};
      textCols.forEach((i) => { meta[colName(i)] = r[i] == null ? '' : String(r[i]).trim(); });
      samples.push({ name, values: vals.map((v) => (isFinite(v) ? v : 0)), meta });
    });
    if (!samples.length) return null;

    return {
      markers, combos, samples: uniqueNames(samples),
      groupCols: textCols.filter((i) => i !== nameCol).map(colName),
      info: `Detected gate-name columns (FlowJo style): ${markers.length} markers (${markers.join(", ")}), ${combos.length} combinations, ${samples.length} samples.`,
    };
  }

  function buildComboTable(header, body) {
    const ncol = Math.max(header.length, ...body.map((r) => r.length));
    const markerCols = [], valueCols = [];
    for (let i = 0; i < ncol; i++) {
      const vals = body.map((r) => r[i]).filter((v) => v != null && v !== '');
      if (!vals.length) continue;
      if (header[i] && vals.every((v) => parseSign(v) !== undefined)) markerCols.push(i);
      else if (vals.every((v) => isFinite(toNum(v)))) valueCols.push(i);
    }
    if (markerCols.length < 2 || !valueCols.length) return null;

    const combos = [], rowsByCombo = [], index = new Map();
    body.forEach((r) => {
      const signs = markerCols.map((i) => parseSign(r[i]));
      if (signs.some((s) => s == null)) return;
      const k = signs.map(Number).join('');
      if (!index.has(k)) { index.set(k, combos.length); combos.push(signs); rowsByCombo.push([]); }
      rowsByCombo[index.get(k)].push(r);
    });
    if (combos.length < 2) return null;

    const samples = valueCols.map((i) => ({
      name: header[i] || `Column ${i + 1}`,
      values: rowsByCombo.map((rows) => rows.reduce((a, r) => a + (isFinite(toNum(r[i])) ? toNum(r[i]) : 0), 0)),
      meta: {},
    }));
    const markers = markerCols.map((i) => header[i]);
    return {
      markers, combos, samples: uniqueNames(samples), groupCols: [],
      info: `Detected combination table: ${markers.length} markers (${markers.join(", ")}), ${combos.length} combinations, ${samples.length} sample columns.`,
    };
  }

  function buildDataset(rows) {
    const header = (rows[0] || []).map((h) => (h == null ? '' : String(h).trim()));
    const body = rows.slice(1).filter((r) => r && r.some((v) => v != null && v !== ''));
    if (!header.length || !body.length) throw new Error('The sheet is empty or has no header row (the first row must contain column names).');
    const ds = buildFlowJo(header, body) || buildComboTable(header, body);
    if (!ds) throw new Error('Could not recognize the data layout. See "Supported file formats" on the left or download a template.');
    return ds;
  }

  // ---------- loading ----------
  function setStatus(msg, err) {
    const el = $('status');
    el.textContent = msg;
    el.classList.toggle('err', !!err);
  }

  async function loadFile(file) {
    if (!file) return;
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      st.fileBase = file.name.replace(/\.[^.]+$/, '');
      useWorkbook(wb);
    } catch (e) {
      setStatus('Could not read the file: ' + e.message, true);
    }
  }

  function useWorkbook(wb) {
    st.wb = wb;
    const sel = $('sheet');
    sel.innerHTML = '';
    wb.SheetNames.forEach((n) => sel.add(new Option(n, n)));
    $('sheetRow').hidden = wb.SheetNames.length < 2;
    loadSheet(wb.SheetNames[0]);
  }

  function loadSheet(name) {
    const rows = XLSX.utils.sheet_to_json(st.wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
    try {
      st.ds = buildDataset(rows);
    } catch (e) {
      st.ds = null;
      setStatus(e.message, true);
      showSections(false);
      return;
    }
    initFromDataset();
    setStatus(st.ds.info);
    showSections(true);
    render();
  }

  function showSections(on) {
    ['secPies', 'secMarkers', 'secStyle', 'secExport', 'tableWrap'].forEach((id) => { $(id).hidden = !on; });
    if (!on) $('plot').innerHTML = '<p class="empty">Load a file or click an example on the left to preview the SPICE plot here.</p>';
  }

  function initFromDataset() {
    const ds = st.ds;
    st.markers = ds.markers.map((m, i) => ({ name: m, label: m, include: true, color: ARC_COLORS[i % ARC_COLORS.length] }));
    st.countOverride = {};
    st.pieOff = new Set();
    st.pieSig = '';

    const hasGroups = ds.groupCols.length > 0;
    $('pieModeRow').hidden = !hasGroups;
    const gsel = $('groupCol');
    gsel.innerHTML = '';
    ds.groupCols.forEach((g) => gsel.add(new Option(g, g)));
    st.groupCol = ds.groupCols[0] || '';
    st.pieMode = hasGroups ? $('pieMode').value : 'sample';
    $('groupColLabel').hidden = st.pieMode !== 'group';

    buildMarkerRows();
  }

  // ---------- side-panel UI ----------
  function buildMarkerRows() {
    const tb = $('markerRows');
    tb.innerHTML = '';
    st.markers.forEach((m) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><input type="checkbox" ${m.include ? 'checked' : ''}></td>
        <td><input type="text" value="${esc(m.label)}"></td>
        <td><input type="color" value="${m.color}"></td>`;
      const [inc, lab, col] = tr.querySelectorAll('input');
      inc.addEventListener('change', () => { m.include = inc.checked; render(); });
      lab.addEventListener('input', () => { m.label = lab.value; render(); });
      col.addEventListener('input', () => { m.color = col.value; render(); });
      tb.appendChild(tr);
    });
  }

  // Color for slices with k positive markers; user overrides are kept per color mode.
  function countColor(k, nInc) {
    const ov = st.countOverride[opts.colorMode + k];
    if (ov) return ov;
    if (opts.colorMode === 'gray') {
      // black for all markers positive -> light gray for none
      const v = Math.round(255 * 0.85 * (1 - k / Math.max(1, nInc))).toString(16).padStart(2, '0');
      return '#' + v + v + v;
    }
    if (k === 0) return NEG_COLOR;
    return COUNT_COLORS[(nInc - k) % COUNT_COLORS.length];
  }

  function buildCountColors(nInc) {
    const box = $('countColors');
    box.hidden = opts.colorMode === 'combo';
    const minK = opts.excludeNeg ? 1 : 0;
    const sig = [opts.colorMode, nInc, minK].join('|');
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.innerHTML = '';
    for (let k = nInc; k >= minK; k--) {
      const lab = document.createElement('label');
      lab.innerHTML = `<input type="color" value="${countColor(k, nInc)}"> ${k} positive`;
      const inp = lab.querySelector('input');
      inp.addEventListener('input', () => { st.countOverride[opts.colorMode + k] = inp.value; render(); });
      box.appendChild(lab);
    }
  }

  function buildPieList(names) {
    const sig = names.join('\u0001');
    if (sig === st.pieSig) return;
    st.pieSig = sig;
    const box = $('pieList');
    box.innerHTML = '';
    names.forEach((n) => {
      const lab = document.createElement('label');
      lab.className = 'chk';
      lab.innerHTML = `<input type="checkbox" ${st.pieOff.has(n) ? '' : 'checked'}> <span></span>`;
      lab.querySelector('span').textContent = n;
      const inp = lab.querySelector('input');
      inp.addEventListener('change', () => { inp.checked ? st.pieOff.delete(n) : st.pieOff.add(n); render(); });
      box.appendChild(lab);
    });
  }

  function readOpts() {
    const o = {};
    document.querySelectorAll('[data-key]').forEach((el) => {
      const k = el.dataset.key;
      if (el.type === 'checkbox') o[k] = el.checked;
      else if (el.type === 'number') {
        const v = parseFloat(el.value);
        o[k] = isFinite(v) ? v : parseFloat(el.defaultValue);
      } else o[k] = el.value;
    });
    opts = o;
  }

  // ---------- data processing ----------
  function computeData() {
    const ds = st.ds;
    const inc = st.markers.map((m, i) => (m.include ? i : -1)).filter((i) => i >= 0);

    // collapse combinations over the included markers
    const keyMap = new Map(), combos = [];
    const comboIdx = ds.combos.map((signs) => {
      const s = inc.map((i) => signs[i]);
      const k = s.map(Number).join('');
      if (!keyMap.has(k)) { keyMap.set(k, combos.length); combos.push(s); }
      return keyMap.get(k);
    });
    const agg = (vals) => {
      const out = new Array(combos.length).fill(0);
      vals.forEach((v, j) => { out[comboIdx[j]] += v; });
      return out;
    };

    let pies;
    if (st.pieMode === 'group' && st.groupCol) {
      const groups = new Map();
      ds.samples.forEach((s) => {
        const g = s.meta[st.groupCol] || '(blank)';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(agg(s.values));
      });
      pies = [...groups].map(([g, arr]) => ({
        name: g, n: arr.length,
        values: arr[0].map((_, j) => arr.reduce((a, v) => a + v[j], 0) / arr.length),
      }));
    } else {
      pies = ds.samples.map((s) => ({ name: s.name, n: 1, values: agg(s.values) }));
    }
    const allNames = pies.map((p) => p.name);
    pies = pies.filter((p) => !st.pieOff.has(p.name));

    // global combination order (same for every pie, so colors and arcs line up)
    const cnt = (s) => s.filter(Boolean).length;
    const bin = (s) => s.map(Number).join('');
    let order = combos.map((_, j) => j);
    if (opts.excludeNeg) order = order.filter((j) => cnt(combos[j]) > 0);
    const dir = opts.sortOrder === 'asc' ? 1 : -1;
    order.sort((a, b) => (cnt(combos[a]) - cnt(combos[b])) * dir || (bin(combos[a]) < bin(combos[b]) ? 1 : -1));

    const nInc = inc.length;
    const colors = new Array(combos.length);
    if (opts.colorMode === 'combo') {
      let ci = 0;
      order.forEach((j) => { colors[j] = cnt(combos[j]) === 0 ? NEG_COLOR : COMBO_PALETTE[ci++ % COMBO_PALETTE.length]; });
    } else {
      const byK = new Map();
      order.forEach((j) => { const k = cnt(combos[j]); if (!byK.has(k)) byK.set(k, []); byK.get(k).push(j); });
      byK.forEach((js, k) => {
        const base = countColor(k, nInc);
        js.forEach((j, idx) => {
          if (opts.colorMode !== 'countShade' || js.length === 1 || k === 0) { colors[j] = base; return; }
          colors[j] = mix(base, '#ffffff', 0.6 * (idx / (js.length - 1))); // base -> lighter
        });
      });
    }

    pies.forEach((p) => {
      const vals = order.map((j) => (opts.clipNeg ? Math.max(0, p.values[j]) : p.values[j]));
      const total = vals.reduce((a, v) => a + Math.max(0, v), 0);
      p.raw = vals;
      p.frac = vals.map((v) => (total > 0 ? Math.max(0, v) / total : 0));
      p.total = total;
    });

    const markers = inc.map((i) => st.markers[i]);
    return { markers, combos: order.map((j) => combos[j]), colors: order.map((j) => colors[j]), pies, allNames, nInc };
  }

  function mix(hex, hex2, t) {
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const a = p(hex), b = p(hex2);
    return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
  }
  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  const comboLabel = (signs, markers) => signs.map((s, i) => markers[i].label + (s ? '+' : '-')).join(' ');

  // ---------- SVG rendering ----------
  const measureCtx = document.createElement('canvas').getContext('2d');
  function textW(s, size) {
    measureCtx.font = `${size}px ${opts.fontFamily}`;
    return measureCtx.measureText(s).width;
  }
  function pt(cx, cy, r, deg) {
    const a = (deg * Math.PI) / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  }
  function sectorPath(cx, cy, r0, r1, a0, a1) {
    if (a1 - a0 >= 359.999) {
      let d = `M${f(cx - r1)},${f(cy)}A${f(r1)},${f(r1)} 0 1 1 ${f(cx + r1)},${f(cy)}A${f(r1)},${f(r1)} 0 1 1 ${f(cx - r1)},${f(cy)}Z`;
      if (r0 > 0) d += `M${f(cx - r0)},${f(cy)}A${f(r0)},${f(r0)} 0 1 0 ${f(cx + r0)},${f(cy)}A${f(r0)},${f(r0)} 0 1 0 ${f(cx - r0)},${f(cy)}Z`;
      return d;
    }
    const large = a1 - a0 > 180 ? 1 : 0;
    const [x1, y1] = pt(cx, cy, r1, a0), [x2, y2] = pt(cx, cy, r1, a1);
    if (r0 <= 0) return `M${f(cx)},${f(cy)}L${f(x1)},${f(y1)}A${f(r1)},${f(r1)} 0 ${large} 1 ${f(x2)},${f(y2)}Z`;
    const [x3, y3] = pt(cx, cy, r0, a1), [x4, y4] = pt(cx, cy, r0, a0);
    return `M${f(x1)},${f(y1)}A${f(r1)},${f(r1)} 0 ${large} 1 ${f(x2)},${f(y2)}L${f(x3)},${f(y3)}A${f(r0)},${f(r0)} 0 ${large} 0 ${f(x4)},${f(y4)}Z`;
  }

  function buildSvg(d) {
    const o = opts, fs = o.fontSize, R = o.radius;
    const nArc = d.markers.length;
    const outer = R + (nArc ? o.arcOffset + nArc * o.arcWidth + (nArc - 1) * o.arcGap : 0);
    const pad = Math.max(10, fs);
    const titleH = o.showPieTitle ? fs * 1.8 : 0;
    const cellW = 2 * outer, cellH = 2 * outer + titleH;
    const nP = d.pies.length;
    const cols = Math.max(1, Math.min(Math.round(o.cols), nP));
    const rows = Math.ceil(nP / cols);
    const gridW = cols * cellW + (cols - 1) * o.spacing;
    const gridH = rows * cellH + (rows - 1) * o.spacing;
    const mainH = o.title ? fs * 1.4 * 1.8 : 0;

    // legend: a titled group for the arcs and one for the slices
    const detail = o.legendDetail === 'auto' ? (o.colorMode === 'combo' ? 'combo' : 'count') : o.legendDetail;
    const sliceItems = [];
    if (detail === 'combo') {
      d.combos.forEach((s, i) => sliceItems.push({ color: d.colors[i], label: comboLabel(s, d.markers) }));
    } else {
      const seen = new Set();
      d.combos.forEach((s) => {
        const k = s.filter(Boolean).length;
        if (seen.has(k)) return;
        seen.add(k);
        sliceItems.push({ color: countColor(k, d.nInc), label: String(k) });
      });
    }
    const arcItems = d.markers.map((m) => ({ color: m.color, label: m.label }));
    const groups = [{ title: o.arcTitle, items: arcItems }, { title: o.sliceTitle, items: sliceItems }].filter((g) => g.items.length);
    const lh = fs * 1.6, sw = fs * 0.9;
    const showLegend = o.legendPos !== 'none' && nP > 0;

    // legend elements in legend-local coordinates; y is the top of a row
    const leg = [];
    let legW = 0, legH = 0;
    if (showLegend && o.legendPos === 'right') {
      let y = 0;
      groups.forEach((g, gi) => {
        if (gi) y += lh * 0.6;
        if (g.title) { leg.push({ x: 0, y, s: g.title }); legW = Math.max(legW, textW(g.title, fs)); y += lh; }
        g.items.forEach((it) => {
          leg.push({ x: 0, y, c: it.color }, { x: sw + 6, y, s: it.label });
          legW = Math.max(legW, sw + 6 + textW(it.label, fs));
          y += lh;
        });
      });
      legH = y;
    } else if (showLegend) {
      // compact rows: "Arcs  ■ A  ■ B" / "Title  ■ 2  ■ 1  ■ 0", wrapping when wider than the pies
      const titleW = Math.max(0, ...groups.map((g) => (g.title ? textW(g.title, fs) + fs : 0)));
      const maxW = Math.max(gridW, 320);
      let y = 0;
      groups.forEach((g) => {
        if (g.title) leg.push({ x: 0, y, s: g.title });
        legW = Math.max(legW, titleW);
        let x = titleW;
        g.items.forEach((it) => {
          const w = sw + 5 + textW(it.label, fs);
          if (x > titleW && x + w > maxW) { x = titleW; y += lh; }
          leg.push({ x, y, c: it.color }, { x: x + sw + 5, y, s: it.label });
          legW = Math.max(legW, x + w);
          x += w + fs;
        });
        y += lh;
      });
      legH = y;
    }

    let W, H, legX = 0, legY = 0;
    if (showLegend && o.legendPos === 'right') {
      W = pad * 2 + gridW + fs * 2 + legW;
      H = pad * 2 + mainH + Math.max(gridH, legH);
      legX = pad + gridW + fs * 2; legY = pad + mainH + Math.max(0, (gridH - legH) / 2);
    } else if (showLegend) {
      W = pad * 2 + Math.max(gridW, legW);
      H = pad * 2 + mainH + gridH + fs + legH;
      legX = pad + Math.max(0, (W - pad * 2 - legW) / 2); legY = pad + mainH + gridH + fs;
    } else {
      W = pad * 2 + gridW; H = pad * 2 + mainH + gridH;
    }
    W = Math.ceil(W); H = Math.ceil(H);
    const gx = pad + (showLegend && o.legendPos === 'bottom' ? Math.max(0, (W - pad * 2 - gridW) / 2) : 0);
    const gy = pad + mainH;

    const out = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${esc(o.fontFamily)}" font-size="${fs}">`);
    if (o.background === 'white') out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
    if (o.title) out.push(`<text x="${f(W / 2)}" y="${f(pad + fs * 1.4)}" text-anchor="middle" font-size="${f(fs * 1.4)}" font-weight="bold" fill="#111111">${esc(o.title)}</text>`);

    const sgn = o.clockwise ? 1 : -1;
    const ang = (t) => o.startAngle + sgn * t * 360;
    const span = (t0, t1) => { const a = ang(t0), b = ang(t1); return [Math.min(a, b), Math.max(a, b)]; };
    const inner = R * Math.min(0.95, Math.max(0, o.innerRatio));
    const stroke = o.strokeWidth > 0 ? ` stroke="${o.strokeColor}" stroke-width="${o.strokeWidth}" stroke-linejoin="round"` : '';

    d.pies.forEach((p, idx) => {
      const c = idx % cols, r = Math.floor(idx / cols);
      const x0 = gx + c * (cellW + o.spacing), y0 = gy + r * (cellH + o.spacing);
      const cx = x0 + outer, cy = y0 + titleH + outer;
      out.push(`<g>`);
      if (o.showPieTitle) {
        const t = st.pieMode === 'group' ? `${p.name} (n=${p.n})` : p.name;
        out.push(`<text x="${f(cx)}" y="${f(y0 + fs * 1.1)}" text-anchor="middle" fill="#111111">${esc(t)}</text>`);
      }
      if (p.total <= 0) {
        out.push(`<path d="${sectorPath(cx, cy, inner, R, 0, 360)}" fill="#eeeeee" fill-rule="evenodd"/>`);
        out.push(`<text x="${f(cx)}" y="${f(cy + fs * 0.35)}" text-anchor="middle" fill="#888888">no data</text>`);
        out.push(`</g>`);
        return;
      }
      // slices
      let cum = 0;
      const pos = p.frac.map((fr) => { const s = cum; cum += fr; return [s, cum]; });
      // adjacent slices of the same color are drawn as one, so borders only separate color groups
      const segs = [];
      p.frac.forEach((fr, j) => {
        if (fr <= 0) return;
        const last = segs[segs.length - 1];
        if (last && last.color === d.colors[j]) { last.t1 = pos[j][1]; last.fr += fr; }
        else segs.push({ t0: pos[j][0], t1: pos[j][1], fr, color: d.colors[j] });
      });
      segs.forEach((s) => {
        const [a0, a1] = span(s.t0, s.t1);
        out.push(`<path d="${sectorPath(cx, cy, inner, R, a0, a1)}" fill="${s.color}" fill-rule="evenodd"${stroke}/>`);
      });
      // arcs: one ring per marker, covering slices where that marker is positive
      d.markers.forEach((m, mi) => {
        const r0 = R + o.arcOffset + mi * (o.arcWidth + o.arcGap), r1 = r0 + o.arcWidth;
        const runs = [];
        p.frac.forEach((fr, j) => {
          if (fr <= 0 || !d.combos[j][mi]) return;
          const last = runs[runs.length - 1];
          if (last && Math.abs(last[1] - pos[j][0]) < 1e-9) last[1] = pos[j][1];
          else runs.push([pos[j][0], pos[j][1]]);
        });
        runs.forEach(([t0, t1]) => {
          if ((t1 - t0) * 360 < o.arcMinDeg) return;
          const [a0, a1] = span(t0, t1);
          out.push(`<path d="${sectorPath(cx, cy, r0, r1, a0, a1)}" fill="${m.color}" fill-rule="evenodd"/>`);
        });
      });
      // percent labels
      if (o.labelMode === 'percent') {
        const lr = inner > 0 ? (inner + R) / 2 : R * 0.66;
        segs.forEach((s) => {
          if (s.fr * 100 < o.labelMin) return;
          const [x, y] = pt(cx, cy, lr, ang((s.t0 + s.t1) / 2));
          const col = luminance(s.color) > 0.6 ? '#111111' : '#ffffff';
          out.push(`<text x="${f(x)}" y="${f(y + fs * 0.3)}" text-anchor="middle" font-size="${f(fs * 0.8)}" fill="${col}">${(s.fr * 100).toFixed(1)}%</text>`);
        });
      }
      out.push(`</g>`);
    });

    leg.forEach((e) => {
      const x = legX + e.x, y = legY + e.y;
      if (e.c) out.push(`<rect x="${f(x)}" y="${f(y + (lh - sw) / 2)}" width="${f(sw)}" height="${f(sw)}" fill="${e.c}"/>`);
      else out.push(`<text x="${f(x)}" y="${f(y + lh / 2 + fs * 0.35)}" fill="#222222">${esc(e.s)}</text>`);
    });
    out.push('</svg>');
    return { svg: out.join(''), w: W, h: H };
  }

  // ---------- table ----------
  function buildTable(d) {
    if (!d.pies.length) return '<p class="hint">No pies selected.</p>';
    let h = '<table class="data"><thead><tr><th>Combination</th><th>No. positive</th>';
    d.pies.forEach((p) => { h += `<th>${esc(p.name)}</th>`; });
    h += '</tr></thead><tbody>';
    d.combos.forEach((s, j) => {
      h += `<tr><td><span class="sw" style="background:${d.colors[j]}"></span>${esc(comboLabel(s, d.markers))}</td><td>${s.filter(Boolean).length}</td>`;
      d.pies.forEach((p) => { h += `<td>${(p.frac[j] * 100).toFixed(2)}</td>`; });
      h += '</tr>';
    });
    return h + '</tbody></table>';
  }

  function render() {
    if (!st.ds) return;
    readOpts();
    $('groupColLabel').hidden = st.pieMode !== 'group';
    const d = computeData();
    st.lastData = d;
    buildPieList(d.allNames);
    buildCountColors(d.nInc);
    if (!d.pies.length) {
      $('plot').innerHTML = '<p class="empty">Select at least one pie under "Pies".</p>';
      st.lastSvg = '';
    } else {
      const { svg, w, h } = buildSvg(d);
      st.lastSvg = svg; st.lastSize = { w, h };
      $('plot').innerHTML = svg;
    }
    $('table').innerHTML = buildTable(d);
  }

  // ---------- export ----------
  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function rasterize(svg, w, h, scale, opaque) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = Math.round(w * scale); c.height = Math.round(h * scale);
        const ctx = c.getContext('2d');
        if (opaque) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); }
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to render the image')); };
      img.src = url;
    });
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // Write the DPI into the file header so journals / Word read the intended print size.
  async function setDpi(blob, fmt, dpi) {
    const b = new Uint8Array(await blob.arrayBuffer());
    if (fmt === 'png') {
      const ppm = Math.round(dpi / 0.0254);
      const chunk = new Uint8Array(21);
      const dv = new DataView(chunk.buffer);
      dv.setUint32(0, 9);
      chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
      dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
      dv.setUint32(17, crc32(chunk.subarray(4, 17)));
      const at = 33; // right after the IHDR chunk
      const outB = new Uint8Array(b.length + 21);
      outB.set(b.subarray(0, at)); outB.set(chunk, at); outB.set(b.subarray(at), at + 21);
      return new Blob([outB], { type: 'image/png' });
    }
    if (b[2] === 0xff && b[3] === 0xe0 && String.fromCharCode(b[6], b[7], b[8], b[9]) === 'JFIF') {
      b[13] = 1; b[14] = dpi >> 8; b[15] = dpi & 255; b[16] = dpi >> 8; b[17] = dpi & 255;
    }
    return new Blob([b], { type: 'image/jpeg' });
  }

  const EXT = { svg: '.svg', pdf: '.pdf', png: '.png', jpeg: '.jpg' };

  async function svgToBlob(svg, w, h, fmt) {
    if (fmt === 'svg') return new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + svg], { type: 'image/svg+xml' });
    if (fmt === 'png' || fmt === 'jpeg') {
      const dpi = +$('dpi').value;
      let scale = dpi / 96;
      const maxPx = 120e6;
      if (w * h * scale * scale > maxPx) scale = Math.sqrt(maxPx / (w * h));
      const canvas = await rasterize(svg, w, h, scale, fmt === 'jpeg' || opts.background === 'white');
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/' + fmt, 0.95));
      return setDpi(blob, fmt, dpi);
    }
    const { jsPDF } = window.jspdf;
    const pw = w * 0.75, ph = h * 0.75;
    const doc = new jsPDF({ orientation: pw > ph ? 'landscape' : 'portrait', unit: 'pt', format: [pw, ph] });
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-99999px;top:0';
    holder.innerHTML = svg;
    document.body.appendChild(holder);
    try {
      await doc.svg(holder.firstChild, { x: 0, y: 0, width: pw, height: ph });
      return doc.output('blob');
    } finally { holder.remove(); }
  }

  async function download() {
    if (!st.lastSvg) return;
    const fmt = $('fmt').value;
    const name = $('fname').value.trim() || 'spice_plot';
    const btn = $('download');
    btn.disabled = true;
    try {
      if ($('split').value === 'each') {
        const zip = new JSZip();
        const d = st.lastData;
        for (const p of d.pies) {
          const { svg, w, h } = buildSvg({ ...d, pies: [p] });
          const safe = String(p.name).replace(/[\\/:*?"<>|]+/g, '_');
          zip.file(`${name}_${safe}${EXT[fmt]}`, await svgToBlob(svg, w, h, fmt));
        }
        saveBlob(await zip.generateAsync({ type: 'blob' }), name + '.zip');
      } else {
        const { w, h } = st.lastSize;
        saveBlob(await svgToBlob(st.lastSvg, w, h, fmt), name + EXT[fmt]);
      }
    } catch (e) {
      alert('Export failed: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  function downloadCsv() {
    const d = st.lastData;
    if (!d) return;
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const head = ['Combination', 'No. positive', ...d.pies.map((p) => `${p.name} (value)`), ...d.pies.map((p) => `${p.name} (%)`)];
    const lines = [head.map(q).join(',')];
    d.combos.forEach((s, j) => {
      lines.push([q(comboLabel(s, d.markers)), s.filter(Boolean).length,
        ...d.pies.map((p) => p.raw[j]), ...d.pies.map((p) => (p.frac[j] * 100).toFixed(4))].join(','));
    });
    saveBlob(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }), ($('fname').value.trim() || 'spice_plot') + '_data.csv');
  }

  // ---------- demo data & templates ----------
  const DEMO_MARKERS = ['IFNg', 'TNFa', 'IL2'];
  const DEMO_COMBOS = [[1, 1, 1], [1, 1, 0], [1, 0, 1], [1, 0, 0], [0, 1, 1], [0, 1, 0], [0, 0, 1], [0, 0, 0]];
  const DEMO_VALUES = {
    Healthy: [0.12, 0.35, 0.05, 0.40, 0.08, 0.30, 0.10, 98.60],
    HIV: [0.02, 0.10, 0.01, 0.55, 0.02, 0.20, 0.03, 99.07],
    Vaccinated: [0.45, 0.60, 0.15, 0.30, 0.25, 0.20, 0.12, 97.93],
  };

  function demoTableAoa() {
    const groups = Object.keys(DEMO_VALUES);
    const aoa = [[...DEMO_MARKERS, ...groups]];
    DEMO_COMBOS.forEach((c, j) => aoa.push([...c.map((b) => (b ? '+' : '-')), ...groups.map((g) => DEMO_VALUES[g][j])]));
    return aoa;
  }

  function demoFlowJoAoa() {
    const gate = (c) => 'Lymphocytes/CD4+/' + c.map((b, i) => DEMO_MARKERS[i] + (b ? '+' : '-')).join('') + ' | Freq. of Parent';
    const aoa = [['Sample', 'Group', ...DEMO_COMBOS.map(gate)]];
    const jitter = [0.8, 1.15, 0.95, 1.1, 0.9, 1.05];
    let n = 0;
    Object.keys(DEMO_VALUES).forEach((g) => {
      for (let rep = 1; rep <= 2; rep++) {
        const fct = jitter[n++ % jitter.length];
        const vals = DEMO_VALUES[g].map((v, j) => (j === 7 ? 0 : +(v * fct * (1 + 0.1 * Math.sin(n + j))).toFixed(3)));
        vals[7] = +(100 - vals.reduce((a, v) => a + v, 0)).toFixed(3);
        aoa.push([`${g}_${rep}`, g, ...vals]);
      }
    });
    aoa.push(['Mean', '', ...DEMO_COMBOS.map(() => '')]);
    aoa.push(['SD', '', ...DEMO_COMBOS.map(() => '')]);
    return aoa;
  }

  function aoaWorkbook(aoa, sheet) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet);
    return wb;
  }

  function loadDemo(which) {
    st.fileBase = 'demo';
    useWorkbook(which === 'b' ? aoaWorkbook(demoFlowJoAoa(), 'FlowJo') : aoaWorkbook(demoTableAoa(), 'Combinations'));
  }

  // ---------- wiring ----------
  $('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));
  $('sheet').addEventListener('change', (e) => loadSheet(e.target.value));
  $('demoA').addEventListener('click', () => loadDemo('a'));
  $('demoB').addEventListener('click', () => loadDemo('b'));
  $('tplA').addEventListener('click', () => XLSX.writeFile(aoaWorkbook(demoTableAoa(), 'Combinations'), 'SPICE_template_A_combinations.xlsx'));
  $('tplB').addEventListener('click', () => XLSX.writeFile(aoaWorkbook(demoFlowJoAoa(), 'FlowJo'), 'SPICE_template_B_flowjo.xlsx'));
  $('pieMode').addEventListener('change', (e) => { st.pieMode = e.target.value; render(); });
  $('groupCol').addEventListener('change', (e) => { st.groupCol = e.target.value; render(); });
  $('pieAll').addEventListener('click', () => { st.pieOff.clear(); st.pieSig = ''; render(); });
  $('pieNone').addEventListener('click', () => { (st.lastData ? st.lastData.allNames : []).forEach((n) => st.pieOff.add(n)); st.pieSig = ''; render(); });
  document.querySelectorAll('[data-key]').forEach((el) => el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', render));
  const fmtChanged = () => {
    const v = $('fmt').value;
    $('dpiLabel').hidden = !(v === 'png' || v === 'jpeg');
    $('pdfHint').hidden = v !== 'pdf';
  };
  $('fmt').addEventListener('change', fmtChanged);
  fmtChanged();
  $('download').addEventListener('click', download);
  $('downloadCsv').addEventListener('click', downloadCsv);

  const demo = new URLSearchParams(location.search).get('demo');
  if (demo) loadDemo(demo);
})();
