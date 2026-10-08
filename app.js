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
  // Ordinal ramp for "number of positive markers": one hue, light -> dark, darkest = most
  // functions. The lightest step still clears 2:1 on the white plot surface.
  const SEQ_COLORS = ['#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6',
    '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
  // groups in the bar chart are categorical identity, so a fixed-order categorical set
  const GROUP_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
  const NEG_COLOR = '#BDBDBD';

  const st = {
    wb: null, ds: null, fileBase: 'polypie',
    markers: [],          // {name, label, include, color}
    countOverride: {},    // k -> color chosen by user
    pieOff: new Set(),    // pie names hidden by user
    pieMode: 'sample', groupCol: '',
    pieSig: '', lastSvg: '', lastSize: null, lastData: null, lastBar: null, lastStats: null,
  };
  let opts = {};
  // v0.2: imports fail explicitly; composition always uses a documented nonnegative projection.
  const ANALYSIS_VERSION = '0.3.0';
  const STATS_SEED = 20261007;
  const statsCache = new Map();
  const sampleN = (p) => p.n == null ? 1 : p.n;
  const compositionReps = (p) => p.reps !== undefined ? p.reps : (p.total > 0 ? [p.frac] : []);
  const axisCaption = () => opts.excludeNeg ? '% of selected-marker responders' : '% of included combinations';
  const numberText = (v, digits = 2) => Number.isFinite(v) ? v.toFixed(digits) : 'NA';
  function requiredNumber(v, location) {
    const n = toNum(v);
    if (!Number.isFinite(n)) throw new Error(`Missing or invalid value at ${location}. Supply a measured value (0 only for a measured zero), or remove the incomplete sample.`);
    return n;
  }


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
  // A gate whose own name ends in "+" yields a run of signs, e.g. "GZMB+-" = NOT "GZMB+": the
  // last +/- is the sign and the rest belongs to the name, so GZMB+ and GZMB+- are one marker.
  function parseSegment(seg) {
    const s = seg.replace(/[−–]/g, '-').replace(/^\s*Q\d+\s*:\s*/i, '').trim();
    if (!s) return null;
    const re = /([^\s,;]+?)\s*((?:\+|-(?!\d))+|neg|pos)/gi;
    const toks = [];
    let m, last = 0;
    while ((m = re.exec(s))) {
      if (s.slice(last, m.index).replace(/[\s,;]/g, '') !== '') return null;
      const sg = m[2].toLowerCase();
      const word = sg === 'neg' || sg === 'pos';
      toks.push({
        name: m[1], key: m[1].toLowerCase(), pos: word ? sg === 'pos' : sg.endsWith('+'),
        raw: m[1] + m[2], amb: !word && m[2].length > 1,
      });
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
    const selectedStat = $('importStat').value;
    const parsed = header.map((h) => {
      if (!h) return null;
      const stat = String(h).split('|').slice(1).join('|').trim();
      return selectedStat && stat !== selectedStat ? null : parseGateName(h);
    });
    const counts = new Map();
    parsed.forEach((p) => { if (p) counts.set(keyOf(p), (counts.get(keyOf(p)) || 0) + 1); });
    let best = null, bestN = 0;
    counts.forEach((n, k) => { if (n > bestN) { best = k; bestN = n; } });
    if (!best || bestN < 2) return null;

    const cols = [];
    parsed.forEach((p, i) => { if (p && keyOf(p) === best) cols.push({ i, toks: p }); });
    const tokOf = (c, key) => c.toks.find((t) => t.key === key);
    const signOf = (c, key) => tokOf(c, key).pos;
    // markers that are + in every column are parent gates (e.g. CD4+), not functions
    const kept = cols[0].toks.filter((t) => new Set(cols.map((c) => signOf(c, t.key))).size > 1);
    const markers = kept.map((t) => t.name);
    const constantMarkers = cols[0].toks.filter((t) => !kept.includes(t)).map((t) => t.name);
    if (markers.length < 2) return null;

    // A run such as "GZMB+-" can only be read by assuming the first sign belongs to the gate name,
    // so every spelling of such a marker is reported for the user to confirm.
    const ambiguous = kept.map((t) => {
      const forms = new Map();
      let example = '';
      cols.forEach((c) => { const x = tokOf(c, t.key); forms.set(x.raw, x.pos); if (x.amb) example = x.raw; });
      return { name: t.name, example, forms: [...forms] };
    }).filter((a) => a.example);

    const combos = [], colIdx = [], seen = new Set();
    cols.forEach((c) => {
      const signs = kept.map((t) => signOf(c, t.key));
      const k = signs.map(Number).join('');
      if (seen.has(k)) throw new Error(`Duplicate FlowJo combination at column ${c.i + 1}. Select one parent population and one statistic before importing.`);
      seen.add(k); combos.push(signs); colIdx.push(c.i);
    });

    const gateSet = new Set(cols.map((c) => c.i));
    const colName = (i) => header[i] || `Column ${i + 1}`;
    const textCols = header.map((_, i) => i).filter((i) => !gateSet.has(i) && !parseGateName(header[i]));
    // The sample-name column identifies the row; any other text column (Group, Day, ...) is kept
    // for averaging. Prefer a sample-like header whose values are mostly unique, otherwise the
    // column with the most distinct values, so a leading "Group" column is not taken as the name.
    const nDistinct = header.map((_, i) => (textCols.includes(i)
      ? new Set(body.map((r) => (r[i] == null ? '' : String(r[i]).trim()))).size : 0));
    const SAMPLE_RE = /^(sample|name|id|file|specimen|subject|donor|patient|animal|mouse|well|tube)/i;
    let nameCol = gateSet.has(0) ? -1 : 0;
    if (textCols.length) {
      const named = textCols.filter((i) => SAMPLE_RE.test(header[i] || '') && nDistinct[i] * 2 >= body.length);
      nameCol = named.length ? named[0]
        : textCols.reduce((a, i) => (nDistinct[i] > nDistinct[a] ? i : a), textCols[0]);
    }

    const samples = [];
    let missingSamples = 0;
    body.forEach((r, ri) => {
      const raw = nameCol >= 0 ? r[nameCol] : null;
      const name = raw != null && raw !== '' ? String(raw).trim() : `Row ${ri + 2}`;
      if (/^(mean|sd|std|stdev|median|average|avg|cv|sem)$/i.test(name)) return;
      if ($('missingPolicy').value === 'exclude' && colIdx.some((i) => !Number.isFinite(toNum(r[i])))) { missingSamples++; return; }
      const vals = colIdx.map((i) => requiredNumber(r[i], `sample ${name}, column ${i + 1}`));
      const meta = {};
      textCols.forEach((i) => { meta[colName(i)] = r[i] == null ? '' : String(r[i]).trim(); });
      samples.push({ name, values: vals, meta });
    });
    if (!samples.length) return null;

    return {
      markers, combos, samples: uniqueNames(samples), ambiguous,
      groupCols: textCols.filter((i) => i !== nameCol).map(colName),
      info: `Detected gate-name columns (FlowJo style): ${markers.length} markers (${markers.join(", ")}), ${combos.length} combinations, ${samples.length} samples. Statistic: ${selectedStat || 'unspecified'}. Incomplete samples excluded: ${missingSamples}. Constant gates excluded: ${constantMarkers.join(", ") || "none"}. Confirm these are parent gates; export all states for functional markers.`,
    };
  }

  function buildComboTable(header, body) {
    const ncol = Math.max(header.length, ...body.map((r) => r.length));
    const named = $('markerColumns').value.split(',').map((x) => x.trim()).filter(Boolean);
    named.forEach((n) => { if (!header.includes(n)) throw new Error(`Marker column not found: ${n}`); });
    // when any column states markers as text, numeric 0/1 columns are samples, not markers
    const hasTextStates = header.some((_, i) => {
      const v = body.map((r) => r[i]).filter((x) => x != null && x !== '');
      return v.length && v.every((x) => parseSign(x) !== undefined) && v.some((x) => !Number.isFinite(toNum(x)));
    });
    const markerCols = [], valueCols = [];
    for (let i = 0; i < ncol; i++) {
      const vals = body.map((r) => r[i]).filter((v) => v != null && v !== '');
      if (!vals.length) continue;
      if (named.includes(header[i]) || (!named.length && header[i] && vals.every((v) => parseSign(v) !== undefined)
        && (!hasTextStates || vals.some((v) => !Number.isFinite(toNum(v)))))) markerCols.push(i);
      else if (vals.every((v) => isFinite(toNum(v)))) valueCols.push(i);
    }
    if (markerCols.length < 2 || !valueCols.length) throw new Error('Could not identify marker and sample columns. Name the marker columns under Import options (comma separated). Marker states may be +/-, 1/0 or Y/N.');
    const recognized = new Set([...markerCols, ...valueCols]);
    header.forEach((h, i) => {
      if (!recognized.has(i) && body.some((r) => r[i] != null && r[i] !== '')) throw new Error(`Unrecognized or invalid column: ${h || i + 1}. Use marker states or numeric sample values.`);
    });

    const combos = [], rowsByCombo = [], index = new Map();
    body.forEach((r) => {
      const signs = markerCols.map((i) => parseSign(r[i]));
      if (signs.some((s) => s == null)) throw new Error('Missing marker state in combination table. Every row must define each marker.');
      const k = signs.map(Number).join('');
      if (index.has(k)) throw new Error(`Duplicate combination ${k}. Combine intentional subdivisions before import.`);
      index.set(k, combos.length); combos.push(signs); rowsByCombo.push([]);
      rowsByCombo[index.get(k)].push(r);
    });
    if (combos.length < 2) return null;

    const usableValueCols = valueCols.filter((i) => $('missingPolicy').value !== 'exclude' || body.every((r) => Number.isFinite(toNum(r[i]))));
    if (!usableValueCols.length) throw new Error('No complete sample columns remain.');
    const samples = usableValueCols.map((i) => ({
      name: header[i] || `Column ${i + 1}`,
      values: rowsByCombo.map((rows) => rows.reduce((a, r) => a + requiredNumber(r[i], `sample ${header[i]}, combination ${r.slice(0, markerCols.length).join(' ')}`), 0)),
      meta: {},
    }));
    const markers = markerCols.map((i) => header[i]);
    return {
      markers, combos, samples: uniqueNames(samples), groupCols: [], ambiguous: [],
      info: `Detected combination table: ${markers.length} markers (${markers.join(", ")}), ${combos.length} combinations, ${samples.length} sample columns. ${named.length ? 'Explicit marker columns.' : 'Automatic mapping; use Import options if a numeric 0/1 sample was read as a marker.'} Incomplete samples excluded: ${valueCols.length - usableValueCols.length}.`,
    };
  }

  function buildDataset(rows) {
    const header = (rows[0] || []).map((h) => (h == null ? '' : String(h).trim()));
    const body = rows.slice(1).filter((r) => r && r.some((v) => v != null && v !== ''));
    if (!header.length || !body.length) throw new Error('The sheet is empty or has no header row (the first row must contain column names).');
    const ds = buildFlowJo(header, body) || buildComboTable(header, body);
    if (!ds) throw new Error('Could not recognize the data layout. See "Supported file formats" on the left or download a template.');
    const expected = 2 ** ds.markers.length;
    const missing = expected - ds.combos.length;
    const negatives = ds.samples.reduce((n, x) => n + x.values.filter((v) => v < 0).length, 0);
    ds.info += ` ${missing > 0 ? `${missing} combinations not supplied; percentages describe supplied combinations only.` : 'Complete combination set.'}`;
    if (negatives) ds.info += ` ${negatives} negative values retained in raw data; choose their handling under Markers / outer arcs.`;
    ds.info += ' Group summaries weight each usable sample equally; rows must be independent biological replicates for unpaired tests.';
    return ds;
  }

  // ---------- loading ----------
  function setStatus(msg, err) {
    const el = $('status');
    el.textContent = msg;
    el.classList.toggle('err', !!err);
  }

  // Some gates are marked "+-" (e.g. "GZMB+-"), which is read as negative. The convention is
  // stated at the top of the page so it is on the record rather than applied silently.
  function showNotice(amb) {
    const box = $('notice');
    const show = !!(amb && amb.length);
    box.hidden = !show;
    if (show) {
      const forms = (a) => a.forms
        .map(([raw, pos]) => `<code>${esc(raw)}</code> = ${esc(a.name)} ${pos ? 'positive' : 'negative'}`)
        .join(', ');
      $('noticeText').innerHTML = '<b>Note</b> &mdash; some gates in this file are marked ' +
        `<code>+-</code> (e.g. <code>${esc(amb[0].example)}</code>). In this analysis <code>+-</code> ` +
        `is treated as negative, so: ${amb.map(forms).join('; ')}.`;
    }
    sizeChrome();
  }

  // the panel is sticky under the header, so its height has to allow for a visible banner
  function sizeChrome() {
    const box = $('notice');
    const h = 56 + (box.hidden ? 0 : box.offsetHeight);
    document.documentElement.style.setProperty('--chrome', `${h}px`);
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
    if (typeof XLSX === 'undefined') { setStatus('Spreadsheet library did not load. For the offline copy, extract the whole folder, vendor included, then open index.html.', true); return; }
    const rows = XLSX.utils.sheet_to_json(st.wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
    fillStatPicker(rows);
    try {
      st.ds = buildDataset(rows);
    } catch (e) {
      st.ds = null;
      setStatus(e.message, true);
      showSections(false);
      showNotice(null);
      return;
    }
    initFromDataset();
    setStatus(st.ds.info);
    showSections(true);
    showNotice(st.ds.ambiguous);
    render();
  }

  // A FlowJo export can hold several statistics; let the user say which one is the data.
  function fillStatPicker(rows) {
    const stats = [...new Set((rows[0] || []).filter((h) => h && parseGateName(h))
      .map((h) => String(h).split('|').slice(1).join('|').trim()))];
    const sel = $('importStat'), previous = sel.value;
    sel.innerHTML = '';
    stats.forEach((x) => sel.add(new Option(x || '(unspecified)', x)));
    if (!stats.length) sel.add(new Option('Not applicable', ''));
    sel.value = stats.includes(previous) ? previous
      : (stats.find((x) => /freq.*parent/i.test(x)) || stats[0] || '');
    $('importStatRow').hidden = stats.length < 2;
  }

  function showSections(on) {
    ['secPies', 'secMarkers', 'secStyle', 'secStats', 'secExport', 'statsWrap', 'rawWrap', 'tableWrap'].forEach((id) => { $(id).hidden = !on; });
    if (!on) $('plot').innerHTML = '<p class="empty">Load a file or click an example on the left to preview the pie charts here.</p>';
  }

  function initFromDataset() {
    const ds = st.ds;
    statsCache.clear();
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
    if (opts.colorMode === 'seq') {
      if (k === 0) return NEG_COLOR;
      const span = Math.max(1, nInc - 1);
      return SEQ_COLORS[Math.round(((k - 1) / span) * (SEQ_COLORS.length - 1))];
    }
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
        name: g, n: arr.length, repValues: arr,
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
      p.raw = order.map((j) => p.values[j]); // never overwrite measured/corrected input
      const input = p.repValues || [p.values];
      const processed = input.map((rv) => order.map((j) => Math.max(0, rv[j])));
      const excludedNegative = input.map((rv) => !opts.clipNeg && order.some((j) => rv[j] < 0));
      const totals = processed.map((v, i) => (excludedNegative[i] ? 0 : v.reduce((a, x) => a + x, 0)));
      const reps = processed.filter((_, i) => totals[i] > 0)
        .map((v) => { const t = v.reduce((a, x) => a + x, 0); return v.map((x) => x / t); });
      p.total = totals.reduce((a, x) => a + x, 0) / totals.length;
      p.frac = order.map((_, j) => reps.length ? reps.reduce((a, r) => a + r[j], 0) / reps.length : 0);
      p.inputN = input.length;
      p.dropped = input.length - reps.length;
      p.n = reps.length;
      if (p.repValues) p.reps = reps;
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

  // ---------- statistics ----------
  // Group comparisons are exact permutation tests whenever every label assignment can be
  // enumerated, which it can at the replicate counts this tool sees. That keeps the many tied
  // zeros in flow data honest, where a normal approximation would not. Bigger designs sample.
  const MAX_EXACT = 200000, MC_PERMS = 20000;

  const mean = (xs) => xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : NaN;
  const sd = (xs) => {
    if (xs.length < 2) return NaN;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, v) => a + (v - m) * (v - m), 0) / (xs.length - 1));
  };
  const nChooseK = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); };

  function midRanks(v) {
    const idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
    const r = new Array(v.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++;
      const avg = (i + j) / 2 + 1; // midranks, so ties do not inflate the statistic
      for (let k = i; k <= j; k++) r[idx[k]] = avg;
      i = j + 1;
    }
    return r;
  }

  // every k-subset of 0..n-1, in lexicographic order
  function eachSubset(n, k, fn) {
    const sel = Array.from({ length: k }, (_, i) => i);
    for (;;) {
      fn(sel);
      let i = k - 1;
      while (i >= 0 && sel[i] === n - k + i) i--;
      if (i < 0) return;
      sel[i]++;
      for (let j = i + 1; j < k; j++) sel[j] = sel[j - 1] + 1;
    }
  }

  // A and B hold one composition vector per replicate. Returns a two-sided rank p-value per
  // combination plus one overall p-value for "these two distributions differ", the latter on
  // the summed absolute difference in mean composition - the pies are compositional, so the
  // per-combination values are not independent and the overall test is the sounder read.
  function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function cachedComparison(A, B) {
    const seed = Number($('statsSeed').value) >>> 0;
    const key = JSON.stringify([ANALYSIS_VERSION, seed, A, B]);
    if (!statsCache.has(key)) {
      if (statsCache.size >= 12) statsCache.delete(statsCache.keys().next().value);
      statsCache.set(key, compareGroups(A, B, seed));
    }
    return statsCache.get(key);
  }
  function compareGroups(A, B, seed = STATS_SEED) {
    const random = seededRandom(seed);
    const m = A[0].length, nA = A.length, nB = B.length, N = nA + nB;
    const pool = A.concat(B);
    const R = [], tot = [];
    for (let j = 0; j < m; j++) {
      R.push(midRanks(pool.map((v) => v[j])));
      tot.push(pool.reduce((a, v) => a + v[j], 0));
    }
    const ER = (nA * (N + 1)) / 2;
    const stat = (sel) => {
      const dev = new Array(m);
      let T = 0;
      for (let j = 0; j < m; j++) {
        let rs = 0, sa = 0;
        for (let i = 0; i < nA; i++) { rs += R[j][sel[i]]; sa += pool[sel[i]][j]; }
        dev[j] = Math.abs(rs - ER);
        T += Math.abs(sa / nA - (tot[j] - sa) / nB);
      }
      return { dev, T };
    };
    const obs = stat(Array.from({ length: nA }, (_, i) => i));
    const hitJ = new Array(m).fill(0);
    let hitT = 0, seen = 0;
    const count = (x) => {
      seen++;
      for (let j = 0; j < m; j++) if (x.dev[j] >= obs.dev[j] - 1e-9) hitJ[j]++;
      if (x.T >= obs.T - 1e-12) hitT++;
    };
    const exact = nChooseK(N, nA) <= MAX_EXACT;
    if (exact) eachSubset(N, nA, (sel) => count(stat(sel)));
    else {
      const idx = pool.map((_, i) => i);
      for (let b = 0; b < MC_PERMS; b++) {
        for (let i = N - 1; i > 0; i--) { const r = Math.floor(random() * (i + 1)); [idx[i], idx[r]] = [idx[r], idx[i]]; }
        count(stat(idx.slice(0, nA)));
      }
    }
    // a sampled p-value is never reported as 0
    const adj = exact ? (h) => h / seen : (h) => (h + 1) / (seen + 1);
    return { p: hitJ.map(adj), pOverall: adj(hitT), exact, nPerm: seen, seed };
  }

  // Benjamini-Hochberg false discovery rate
  function bhAdjust(ps) {
    const m = ps.length, ord = ps.map((_, i) => i).sort((a, b) => ps[a] - ps[b]);
    const q = new Array(m);
    let prev = 1;
    for (let r = m - 1; r >= 0; r--) { const i = ord[r]; prev = Math.min(prev, (ps[i] * m) / (r + 1)); q[i] = prev; }
    return q;
  }

  const stars = (q) => (q < 0.001 ? '***' : q < 0.01 ? '**' : q < 0.05 ? '*' : '');

  // t(0.975, df) for a 95% CI; past df 30 a Cornish-Fisher expansion of the normal quantile,
  // which is within 0.01% there and tightens as df grows
  const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
  function t95(df) {
    if (df < 1) return 0;
    if (df <= T95.length) return T95[df - 1];
    const z = 1.959964, z3 = z * z * z, z5 = z3 * z * z;
    return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df * df);
  }

  const ERR_LABEL = { sd: 'SD', sem: 'SEM', ci95: '95% CI', none: 'no error bars' };
  const errLabel = () => ERR_LABEL[opts.errMode] || 'SD';
  const sem = (xs) => (xs.length > 1 ? sd(xs) / Math.sqrt(xs.length) : NaN);
  // half-width of the error bar actually drawn; 0 when there is nothing to draw
  function errHalf(xs) {
    if (xs.length < 2 || opts.errMode === 'none') return 0;
    const s = sd(xs);
    if (!Number.isFinite(s)) return 0;
    if (opts.errMode === 'sd') return s;
    const se = s / Math.sqrt(xs.length);
    return opts.errMode === 'ci95' ? t95(xs.length - 1) * se : se;
  }
  const fmtP = (v) => (v < 0.0001 ? '<0.0001' : v.toFixed(4));

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
        if (seen.has(k)) return; // one legend row per positive-count, not per combination
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

    // Drawing primitives shared by the SVG preview/export and the editable PPTX export.
    // text y is the vertical center of the line.
    const els = [];
    if (o.background === 'white') els.push({ t: 'rect', x: 0, y: 0, w: W, h: H, fill: '#ffffff', name: 'Background' });
    if (o.title) els.push({ t: 'text', x: W / 2, y: pad + fs * 0.9, s: o.title, size: fs * 1.4, anchor: 'middle', color: '#111111', bold: true, name: 'Title' });

    const sgn = o.clockwise ? 1 : -1;
    const ang = (t) => o.startAngle + sgn * t * 360;
    const span = (t0, t1) => { const a = ang(t0), b = ang(t1); return [Math.min(a, b), Math.max(a, b)]; };
    const inner = R * Math.min(0.95, Math.max(0, o.innerRatio));
    const stroke = o.strokeWidth > 0 ? { color: o.strokeColor, width: o.strokeWidth } : null;

    d.pies.forEach((p, idx) => {
      const c = idx % cols, r = Math.floor(idx / cols);
      const x0 = gx + c * (cellW + o.spacing), y0 = gy + r * (cellH + o.spacing);
      const cx = x0 + outer, cy = y0 + titleH + outer;
      els.push({ t: 'group', name: p.name });
      if (o.showPieTitle) {
        const t = st.pieMode === 'group' ? `${p.name} (n=${p.n})` : p.name;
        els.push({ t: 'text', x: cx, y: y0 + fs * 0.75, s: t, size: fs, anchor: 'middle', color: '#111111', name: `${p.name} title` });
      }
      if (p.total <= 0) {
        els.push({ t: 'sector', cx, cy, r0: inner, r1: R, a0: 0, a1: 360, fill: '#eeeeee', name: `${p.name} empty` });
        els.push({ t: 'text', x: cx, y: cy, s: 'no data', size: fs, anchor: 'middle', color: '#888888' });
        els.push({ t: 'endgroup' });
        return;
      }
      // slices
      let cum = 0;
      const pos = p.frac.map((fr) => { const s = cum; cum += fr; return [s, cum]; });
      // adjacent slices of the same color are drawn as one, so borders only separate color groups
      const segs = [];
      p.frac.forEach((fr, j) => {
        if (fr <= 0) return;
        const k = d.combos[j].filter(Boolean).length;
        const last = segs[segs.length - 1];
        if (last && last.color === d.colors[j]) { last.t1 = pos[j][1]; last.fr += fr; }
        else segs.push({ t0: pos[j][0], t1: pos[j][1], fr, color: d.colors[j], k, j });
      });
      segs.forEach((s) => {
        const [a0, a1] = span(s.t0, s.t1);
        const label = opts.colorMode === 'combo' || opts.colorMode === 'countShade' ? comboLabel(d.combos[s.j], d.markers) : `${s.k} positive`;
        els.push({ t: 'sector', cx, cy, r0: inner, r1: R, a0, a1, fill: s.color, stroke,
          name: `${p.name} slice ${label} (${(s.fr * 100).toFixed(1)}%)`,
          tip: `${label} · ${(s.fr * 100).toFixed(1)}%` });
      });
      // pie outline (and inner edge for a donut)
      if (o.outlineWidth > 0) {
        els.push({ t: 'circle', cx, cy, r: R, color: o.outlineColor, width: o.outlineWidth, name: `${p.name} outline` });
        if (inner > 0) els.push({ t: 'circle', cx, cy, r: inner, color: o.outlineColor, width: o.outlineWidth, name: `${p.name} inner outline` });
      }
      // arcs: one ring per marker, covering slices where that marker is positive
      d.markers.forEach((m, mi) => {
        const r0 = R + o.arcOffset + mi * (o.arcWidth + o.arcGap), r1 = r0 + o.arcWidth;
        const mPos = p.frac.reduce((a, fr, j) => a + (d.combos[j][mi] ? fr : 0), 0);
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
          els.push({ t: 'sector', cx, cy, r0, r1, a0, a1, fill: m.color,
            name: `${p.name} arc ${m.label}`,
            tip: `${m.label} · ${(mPos * 100).toFixed(1)}% positive` });
        });
      });
      // percent labels
      if (o.labelMode === 'percent') {
        const lr = inner > 0 ? (inner + R) / 2 : R * 0.66;
        segs.forEach((s) => {
          if (s.fr * 100 < o.labelMin) return;
          const [x, y] = pt(cx, cy, lr, ang((s.t0 + s.t1) / 2));
          const col = luminance(s.color) > 0.6 ? '#111111' : '#ffffff';
          els.push({ t: 'text', x, y, s: `${(s.fr * 100).toFixed(1)}%`, size: fs * 0.8, anchor: 'middle', color: col });
        });
      }
      els.push({ t: 'endgroup' });
    });

    leg.forEach((e) => {
      const x = legX + e.x, y = legY + e.y;
      if (e.c) els.push({ t: 'rect', x, y: y + (lh - sw) / 2, w: sw, h: sw, fill: e.c, name: 'Legend key' });
      else els.push({ t: 'text', x, y: y + lh / 2, s: e.s, size: fs, anchor: 'start', color: '#222222', name: 'Legend text' });
    });

    return { svg: elementsToSvg(els, W, H), els, w: W, h: H };
  }

  function elementsToSvg(els, W, H) {
    const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${esc(opts.fontFamily)}" font-size="${opts.fontSize}">`];
    els.forEach((e) => {
      if (e.t === 'group') out.push('<g>');
      else if (e.t === 'endgroup') out.push('</g>');
      else if (e.t === 'rect') {
        const head = `<rect x="${f(e.x)}" y="${f(e.y)}" width="${f(e.w)}" height="${f(e.h)}" fill="${e.fill}"`;
        out.push(e.tip ? `${head}><title>${esc(e.tip)}</title></rect>` : `${head}/>`);
      }
      else if (e.t === 'sector') {
        const s = e.stroke ? ` stroke="${e.stroke.color}" stroke-width="${e.stroke.width}" stroke-linejoin="round"` : '';
        const head = `<path d="${sectorPath(e.cx, e.cy, e.r0, e.r1, e.a0, e.a1)}" fill="${e.fill}" fill-rule="evenodd"${s}`;
        out.push(e.tip ? `${head}><title>${esc(e.tip)}</title></path>` : `${head}/>`);
      } else if (e.t === 'circle') {
        out.push(`<circle cx="${f(e.cx)}" cy="${f(e.cy)}" r="${f(e.r)}" fill="none" stroke="${e.color}" stroke-width="${e.width}"/>`);
      } else if (e.t === 'text') {
        const head = `<text x="${f(e.x)}" y="${f(e.y + e.size * 0.35)}"${e.anchor === 'middle' ? ' text-anchor="middle"' : ''} font-size="${f(e.size)}"${e.bold ? ' font-weight="bold"' : ''} fill="${e.color}">`;
        out.push(`${head}${e.tip ? `<title>${esc(e.tip)}</title>` : ''}${esc(e.s)}</text>`);
      }
    });
    out.push('</svg>');
    return out.join('');
  }

  // Mean +/- SD per combination, one bar per group: the companion to the pies, because a pie
  // cannot carry an error bar. Combinations are named by a +/- matrix under the axis instead of
  // rotated labels. Bars, error bars and gridlines are all rects, so the PPTX export - which
  // speaks rect / sector / circle / text - gets every one of them as a real shape too.
  function buildBarSvg(d, res) {
    const o = opts, fs = o.fontSize, pad = Math.max(10, fs);
    const pies = d.pies, m = d.combos.length, nG = pies.length, nM = d.markers.length;
    if (!m || !nG) return null;

    const cells = pies.map((p) => d.combos.map((_, j) => {
      const xs = compositionReps(p).map((r) => r[j] * 100);
      return { m: mean(xs), s: errHalf(xs), xs };
    }));

    const barW = Math.max(6, Math.round(fs * 0.9)), barGap = 2;
    const groupGap = Math.max(fs, barW);
    const cellW = nG * barW + (nG - 1) * barGap;
    const plotW = m * cellW + (m - 1) * groupGap;
    const plotH = Math.max(140, Math.round(o.radius * 1.6));

    // y scale, rounded out to a readable step
    const hi = Math.max(0.01, ...cells.flat().filter((c) => Number.isFinite(c.m)).map((c) => Math.max(c.m + c.s, ...c.xs)));
    const p10 = Math.pow(10, Math.floor(Math.log10(hi / 4)));
    const step = [1, 2, 2.5, 5, 10].map((x) => x * p10).find((x) => x >= hi / 4) || 10 * p10;
    const yMax = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let v = 0; v <= yMax + 1e-9; v += step) ticks.push(v);
    const tickLab = (v) => v.toFixed(Math.max(0, Math.ceil(-Math.log10(step)) + (String(step).includes('2.5') ? 1 : 0)));

    const leftW = Math.max(...ticks.map((v) => textW(tickLab(v), fs)), ...d.markers.map((k) => textW(k.label, fs))) + fs * 0.7;
    const legend = pies.map((p, gi) => ({ s: `${p.name} (n=${sampleN(p)})`, c: GROUP_COLORS[gi % GROUP_COLORS.length] }));
    const legendW = legend.reduce((a, it) => a + fs * 1.2 + textW(it.s, fs) + fs, -fs);

    const titleH = o.title ? fs * 2 : 0;
    const starH = res ? fs * 1.3 : fs * 0.4;
    const capH = fs * 1.4;                                  // "% of total" caption above the axis
    const matrixH = fs * (1.6 + Math.max(0, nM - 1) * 1.25);
    const legendH = fs * 2;
    const x0 = pad + leftW;
    const W = Math.round(Math.max(x0 + plotW + pad, pad * 2 + legendW));
    const H = Math.round(pad * 2 + titleH + capH + starH + plotH + matrixH + legendH);
    const yTop = pad + titleH + capH + starH;
    const yBase = yTop + plotH;
    const Y = (v) => yBase - (v / yMax) * plotH;

    const els = [];
    if (o.background === 'white') els.push({ t: 'rect', x: 0, y: 0, w: W, h: H, fill: '#ffffff', name: 'Background' });
    if (o.title) els.push({ t: 'text', x: W / 2, y: pad + fs, s: o.title, size: fs * 1.25, anchor: 'middle', color: '#111111', bold: true, name: 'Title' });
    els.push({ t: 'text', x: pad, y: yTop - fs * 0.8,
      s: opts.errMode === 'none' ? axisCaption() : `${axisCaption()} (mean \u00b1 ${errLabel()})`,
      size: fs, anchor: 'start', color: '#444444', name: 'Y axis caption' });

    ticks.forEach((v) => {
      els.push({ t: 'rect', x: x0, y: Y(v), w: plotW, h: v === 0 ? 1.2 : 1, fill: v === 0 ? '#444444' : '#e8e8e8', name: `Gridline ${tickLab(v)}` });
      els.push({ t: 'text', x: x0 - fs * 0.45 - textW(tickLab(v), fs), y: Y(v), s: tickLab(v), size: fs, anchor: 'start', color: '#444444', name: `Y label ${tickLab(v)}` });
    });

    d.combos.forEach((cmb, j) => {
      const gx = x0 + j * (cellW + groupGap);
      const label = comboLabel(cmb, d.markers);
      pies.forEach((p, gi) => {
        const c = cells[gi][j], bx = gx + gi * (barW + barGap);
        if (!Number.isFinite(c.m)) return;
        const by = Y(Math.min(c.m, yMax));
        els.push({ t: 'rect', x: bx, y: by, w: barW, h: Math.max(0, yBase - by),
          fill: GROUP_COLORS[gi % GROUP_COLORS.length],
          name: `${p.name} ${label} mean ${c.m.toFixed(2)}%`,
          tip: `${p.name} \u00b7 ${label}\n${c.m.toFixed(2)}%${c.s > 0 ? ` \u00b1 ${c.s.toFixed(2)} ${errLabel()}` : ''} (n=${sampleN(p)})` });
        if (o.showPoints) c.xs.forEach((v, ri) => {
          const jitter = c.xs.length < 2 ? 0 : ((ri / (c.xs.length - 1)) - 0.5) * barW * 0.65;
          els.push({ t: 'circle', cx: bx + barW / 2 + jitter, cy: Y(v), r: 2,
            color: '#222222', width: 1, name: `${p.name} sample ${ri + 1}: ${v.toFixed(2)}%` });
        });
        if (c.s > 0) {
          const top = Y(Math.min(yMax, c.m + c.s)), bot = Y(Math.max(0, c.m - c.s));
          const cx = bx + barW / 2, wv = 1.4, cap = Math.max(4, barW * 0.55);
          els.push({ t: 'rect', x: cx - wv / 2, y: top, w: wv, h: Math.max(0, bot - top), fill: '#333333', name: `${p.name} ${label} ${errLabel()}` });
          els.push({ t: 'rect', x: cx - cap / 2, y: top, w: cap, h: wv, fill: '#333333', name: 'SD cap' });
          els.push({ t: 'rect', x: cx - cap / 2, y: bot - wv, w: cap, h: wv, fill: '#333333', name: 'SD cap' });
        }
      });
      if (res && res.star[j]) {
        els.push({ t: 'text', x: gx + cellW / 2, y: yTop - fs * 0.55, s: res.star[j], size: fs * 1.1,
          anchor: 'middle', color: '#111111', bold: true, name: `Significance ${label}`,
          tip: `${label} \u00b7 p = ${fmtP(res.p[j])}, q = ${fmtP(res.q[j])}` });
      }
      d.markers.forEach((mk, mi) => {
        els.push({ t: 'text', x: gx + cellW / 2, y: yBase + fs * (1 + mi * 1.25), s: cmb[mi] ? '+' : '\u2212',
          size: fs, anchor: 'middle', color: cmb[mi] ? '#111111' : '#aaaaaa', name: `${label} ${mk.label}` });
      });
    });

    d.markers.forEach((mk, mi) => {
      els.push({ t: 'text', x: x0 - fs * 0.45 - textW(mk.label, fs), y: yBase + fs * (1 + mi * 1.25),
        s: mk.label, size: fs, anchor: 'start', color: '#444444', name: `Row ${mk.label}` });
    });

    let lx = pad + Math.max(0, (W - pad * 2 - legendW) / 2);
    const ly = H - pad - fs * 0.7;
    legend.forEach((it) => {
      els.push({ t: 'rect', x: lx, y: ly - fs * 0.45, w: fs * 0.9, h: fs * 0.9, fill: it.c, name: `Legend swatch ${it.s}` });
      els.push({ t: 'text', x: lx + fs * 1.2, y: ly, s: it.s, size: fs, anchor: 'start', color: '#222222', name: `Legend ${it.s}` });
      lx += fs * 1.2 + textW(it.s, fs) + fs;
    });

    return { svg: elementsToSvg(els, W, H), els, w: W, h: H };
  }

  // ---------- table ----------
  function buildTable(d) {
    if (!d.pies.length) return '<p class="hint">No pies selected.</p>';
    let h = '<table class="data"><thead><tr><th>Combination</th><th>No. positive</th>';
    d.pies.forEach((p) => { h += `<th>${esc(p.name)}</th>`; });
    h += '</tr></thead><tbody>';
    d.combos.forEach((s, j) => {
      h += `<tr><td><span class="sw" style="background:${d.colors[j]}"></span>${esc(comboLabel(s, d.markers))}</td><td>${s.filter(Boolean).length}</td>`;
      d.pies.forEach((p) => { h += `<td>${(p.n ? (p.frac[j] * 100).toFixed(2) : 'NA')}</td>`; });
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
    const plot = $('plot');
    if (!d.pies.length) {
      plot.innerHTML = '<p class="empty">Select at least one pie under "Pies".</p>';
      st.lastSvg = '';
    } else if ($('split').value === 'each') {
      // one complete plot (with legend) per sample, each downloadable on its own
      plot.innerHTML = '';
      const cards = document.createElement('div');
      cards.className = 'cards';
      d.pies.forEach((p) => {
        const fig = buildSvg({ ...d, pies: [p] });
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = fig.svg + '<button type="button" class="ghost">Download</button>';
        card.querySelector('button').addEventListener('click', () => withBusy(async () => {
          const fmt = $('fmt').value;
          saveBlob(await figToBlob(fig, fmt), `${baseName()}_${safeName(p.name)}${EXT[fmt]}`);
        }));
        cards.appendChild(card);
      });
      plot.appendChild(cards);
      st.lastSvg = 'each';
    } else {
      const { svg, w, h } = buildSvg(d);
      st.lastSvg = svg; st.lastSize = { w, h };
      plot.innerHTML = svg;
    }
    updateDownloadLabel();
    renderStats(d);
    $('rawTable').innerHTML = buildRawTable(d);
    $('table').innerHTML = buildTable(d);
  }

  // Keeps a group select in step with the pies on screen without losing the user's pick.
  function syncGroupSelect(sel, names, dflt) {
    const sig = names.join('');
    if (sel.dataset.sig === sig) return;
    const keep = sel.value;
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    names.forEach((n) => sel.add(new Option(n, n)));
    sel.value = names.includes(keep) ? keep : (names[dflt] || names[0] || '');
  }

  function renderStats(d) {
    opts.showPoints = $('showPoints').checked;
    const on = $('statsOn').checked && st.pieMode === 'group';
    $('statsPair').hidden = !on;
    $('statsWrap').hidden = !on;
    st.lastStats = null; st.lastBar = null;
    if (!on) { $('statsMsg').textContent = ''; return; }

    syncGroupSelect($('statsA'), d.pies.map((p) => p.name), 0);
    syncGroupSelect($('statsB'), d.pies.map((p) => p.name), 1);
    const a = d.pies.find((p) => p.name === $('statsA').value);
    const b = d.pies.find((p) => p.name === $('statsB').value);

    const msg = [];
    const dropped = d.pies.reduce((x, p) => x + (p.dropped || 0), 0);
    if (dropped) msg.push(`${dropped} replicate${dropped > 1 ? 's' : ''} with no usable composition (zero total, or an excluded negative value) left out of the means and the tests.`);
    let res = null;
    if (a && b && a === b) msg.push('Pick two different groups to compare.');
    else if (!a || !b || !a.reps || !b.reps || a.reps.length < 2 || b.reps.length < 2) {
      msg.push('A test needs at least two usable replicates in each of two groups.');
    } else {
      const r = cachedComparison(a.reps, b.reps);
      const q = bhAdjust(r.p);
      res = { ...r, q, star: q.map(stars), a: a.name, b: b.name };
      msg.push(`${a.name} (n=${a.reps.length}) vs ${b.name} (n=${b.reps.length}) — mean-composition L1 p = ${fmtP(r.pOverall)}, ` +
        `from ${r.nPerm.toLocaleString()} ${r.exact ? 'exact' : 'sampled'} permutations; seed ${r.seed}. Unpaired samples; ${axisCaption()}. Negative inputs: ${opts.clipNeg ? 'clipped per sample' : 'affected samples excluded'}.`);
    }
    $('statsMsg').textContent = msg.join(' ');

    const fig = buildBarSvg(d, res);
    st.lastStats = res; st.lastBar = fig;
    $('barPlot').innerHTML = fig ? fig.svg : '';
    $('statsTable').innerHTML = buildStatsTable(d, res);
  }

  const repPct = (p, j) => compositionReps(p).map((r) => r[j] * 100);

  // The group's averaged input values, in whatever units the file used, before any
  // normalisation. Averaged over every sample in the group, including any whose combinations
  // sum to zero - those have no composition but their measured values are still measurements.
  function buildRawTable(d) {
    if (!d.pies.length) return '';
    const grouped = st.pieMode === 'group';
    let h = '<table class="data"><thead><tr><th>Combination</th><th>No. positive</th>';
    d.pies.forEach((p) => {
      const nIn = p.inputN == null ? 1 : p.inputN;
      h += `<th>${esc(p.name)}${grouped ? `<br>mean of ${nIn} sample${nIn > 1 ? 's' : ''}` : ''}</th>`;
    });
    h += '</tr></thead><tbody>';
    d.combos.forEach((cmb, j) => {
      h += `<tr><td><span class="sw" style="background:${d.colors[j]}"></span>${esc(comboLabel(cmb, d.markers))}</td>`;
      h += `<td>${cmb.filter(Boolean).length}</td>`;
      d.pies.forEach((p) => { h += `<td>${numberText(p.raw[j], 3)}</td>`; });
      h += '</tr>';
    });
    h += '<tr><th>Total</th><th></th>';
    d.pies.forEach((p) => { h += `<th>${numberText(d.combos.reduce((a, _, j) => a + p.raw[j], 0), 3)}</th>`; });
    return h + '</tr></tbody></table>';
  }

  function buildStatsTable(d, res) {
    if (!d.pies.length) return '';
    let h = '<table class="data"><thead><tr><th>Combination</th><th>No. positive</th>';
    d.pies.forEach((p) => { h += `<th>${esc(p.name)}<br>mean %${opts.errMode === 'none' ? '' : ` ± ${errLabel()}`} (n=${sampleN(p)})</th>`; });
    if (res) h += '<th>p</th><th>q (BH)</th><th></th>';
    h += '</tr></thead><tbody>';
    d.combos.forEach((cmb, j) => {
      h += `<tr><td><span class="sw" style="background:${d.colors[j]}"></span>${esc(comboLabel(cmb, d.markers))}</td>`;
      h += `<td>${cmb.filter(Boolean).length}</td>`;
      d.pies.forEach((p) => {
        const xs = repPct(p, j);
        const e = errHalf(xs);
        h += `<td>${numberText(mean(xs))}${e > 0 ? ` ± ${e.toFixed(2)}` : ''}</td>`;
      });
      if (res) h += `<td>${fmtP(res.p[j])}</td><td>${fmtP(res.q[j])}</td><td>${res.star[j]}</td>`;
      h += '</tr>';
    });
    return h + '</tbody></table>';
  }

  function downloadStatsCsv() {
    const d = st.lastData, res = st.lastStats;
    if (!d) return;
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [[q(`PolyPie ${ANALYSIS_VERSION}; ${axisCaption()}; negative policy: ${opts.clipNeg ? 'clip' : 'exclude affected samples'}; per-sample normalization; unpaired permutation; seed ${res ? res.seed : Number($('statsSeed').value) >>> 0}`)].join(',')];
    if (res) {
      lines.push([q(`Overall permutation test: ${res.a} vs ${res.b}`), q(`p = ${fmtP(res.pOverall)}`),
        q(`${res.nPerm} ${res.exact ? 'exact' : 'sampled'} permutations`)].join(','));
      lines.push('');
    }
    const head = ['Combination', 'No. positive'];
    d.pies.forEach((p) => head.push(`${p.name} mean %`, `${p.name} SD`, `${p.name} SEM`,
      `${p.name} error drawn (${errLabel()})`, `${p.name} n`));
    if (res) head.push('p', 'q (BH)');
    lines.push(head.map(q).join(','));
    d.combos.forEach((cmb, j) => {
      const row = [q(comboLabel(cmb, d.markers)), cmb.filter(Boolean).length];
      d.pies.forEach((p) => {
        const xs = repPct(p, j);
        row.push(numberText(mean(xs), 4), xs.length > 1 ? sd(xs).toFixed(4) : '',
          xs.length > 1 ? sem(xs).toFixed(4) : '', errHalf(xs).toFixed(4), xs.length);
      });
      if (res) row.push(res.p[j].toFixed(6), res.q[j].toFixed(6));
      lines.push(row.join(','));
    });
    saveBlob(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }), `${baseName()}_statistics.csv`);
  }

  function updateDownloadLabel() {
    const each = $('split').value === 'each', fmt = $('fmt').value;
    const n = st.lastData ? st.lastData.pies.length : 0;
    $('download').textContent = !each ? 'Download image'
      : fmt === 'pptx' ? `Download all (${n} slides)` : `Download all (${n} files, ZIP)`;
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

  const EXT = { svg: '.svg', pdf: '.pdf', png: '.png', jpeg: '.jpg', tiff: '.tif', pptx: '.pptx' };
  const RASTER = new Set(['png', 'jpeg', 'tiff']);

  async function rasterAtDpi(svg, w, h, opaque) {
    const dpi = +$('dpi').value;
    let scale = dpi / 96;
    const maxPx = 120e6;
    if (w * h * scale * scale > maxPx) scale = Math.sqrt(maxPx / (w * h));
    return { canvas: await rasterize(svg, w, h, scale, opaque), dpi };
  }

  // PackBits (TIFF compression 32773) for one row.
  function packBits(src) {
    const n = src.length, out = new Uint8Array(n + Math.ceil(n / 128) + 1);
    let i = 0, o = 0;
    while (i < n) {
      let run = 1;
      while (i + run < n && run < 128 && src[i + run] === src[i]) run++;
      if (run >= 2) { out[o++] = 257 - run; out[o++] = src[i]; i += run; continue; }
      const start = i;
      while (i < n && i - start < 128 && !(i + 1 < n && src[i] === src[i + 1])) i++;
      if (i === start) i++;
      out[o++] = i - start - 1;
      out.set(src.subarray(start, i), o); o += i - start;
    }
    return out.subarray(0, o);
  }

  // Baseline RGB(A) TIFF, PackBits-compressed, with the DPI stored in the header.
  function encodeTiff(canvas, dpi, alpha) {
    const w = canvas.width, h = canvas.height, spp = alpha ? 4 : 3;
    const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const rows = [], row = new Uint8Array(w * spp);
    let stripLen = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0, s = y * w * 4, t = 0; x < w; x++, s += 4) {
        row[t++] = px[s]; row[t++] = px[s + 1]; row[t++] = px[s + 2];
        if (alpha) row[t++] = px[s + 3];
      }
      const pk = packBits(row).slice();
      rows.push(pk); stripLen += pk.length;
    }
    const tags = [
      [256, 4, 1, w], [257, 4, 1, h], [258, 3, spp, null], [259, 3, 1, 32773], [262, 3, 1, 2],
      [273, 4, 1, null], [277, 3, 1, spp], [278, 4, 1, h], [279, 4, 1, stripLen],
      [282, 5, 1, null], [283, 5, 1, null], [284, 3, 1, 1], [296, 3, 1, 2],
    ];
    if (alpha) tags.push([338, 3, 1, 2]);
    const ifdLen = 2 + tags.length * 12 + 4;
    const bpsOff = 8 + ifdLen, xresOff = bpsOff + 8, yresOff = xresOff + 8, stripOff = yresOff + 8;
    const buf = new Uint8Array(stripOff + stripLen);
    const dv = new DataView(buf.buffer);
    buf.set([0x49, 0x49, 42, 0]); dv.setUint32(4, 8, true);
    dv.setUint16(8, tags.length, true);
    const ptr = { 258: bpsOff, 273: stripOff, 282: xresOff, 283: yresOff };
    tags.forEach(([tag, type, count, val], i) => {
      const e = 10 + i * 12;
      dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, count, true);
      const v = val == null ? ptr[tag] : val;
      if (type === 3 && val != null) dv.setUint16(e + 8, v, true); else dv.setUint32(e + 8, v, true);
    });
    for (let k = 0; k < spp; k++) dv.setUint16(bpsOff + k * 2, 8, true);
    dv.setUint32(xresOff, dpi, true); dv.setUint32(xresOff + 4, 1, true);
    dv.setUint32(yresOff, dpi, true); dv.setUint32(yresOff + 4, 1, true);
    let o = stripOff;
    rows.forEach((r) => { buf.set(r, o); o += r.length; });
    return new Blob([buf], { type: 'image/tiff' });
  }

  const scriptCache = {};
  function loadScript(src) {
    if (!scriptCache[src]) {
      scriptCache[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.onload = resolve;
        s.onerror = () => { delete scriptCache[src]; reject(new Error('could not load ' + src)); };
        document.head.appendChild(s);
      });
    }
    return scriptCache[src];
  }

  // Editable PowerPoint: every slice, arc, label and legend item becomes a native shape or text box.
  // One slide per figure, scaled to fill a 16:9 slide.
  async function buildPptx(figs) {
    await loadScript('https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js');
    const pres = new PptxGenJS();
    pres.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5 in
    const fontFace = opts.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
    const hex = (c) => c.replace('#', '').toUpperCase();
    // our angles: 0 = 12 o'clock, clockwise; PowerPoint: 0 = 3 o'clock, clockwise
    const pptAng = (a) => (((a - 90) % 360) + 360) % 360;
    for (const { els, w, h } of figs) {
      const k = Math.min(12.73 / (w / 96), 6.9 / (h / 96));
      const ox = (13.333 - (w / 96) * k) / 2, oy = (7.5 - (h / 96) * k) / 2;
      const L = (px) => (px / 96) * k;
      const pt = (px) => px * 0.75 * k;
      const slide = pres.addSlide();
      els.forEach((e) => {
        if (e.t === 'rect') {
          if (e.name === 'Background') return; // the slide itself is the background
          slide.addShape('rect', { x: ox + L(e.x), y: oy + L(e.y), w: L(e.w), h: L(e.h), fill: { color: hex(e.fill) }, objectName: e.name });
        } else if (e.t === 'sector') {
          const box = { x: ox + L(e.cx - e.r1), y: oy + L(e.cy - e.r1), w: L(2 * e.r1), h: L(2 * e.r1) };
          const style = { fill: { color: hex(e.fill) }, objectName: e.name };
          if (e.stroke) style.line = { color: hex(e.stroke.color), width: pt(e.stroke.width) };
          const full = e.a1 - e.a0 >= 359.999;
          const range = full ? [0, 359.99] : [pptAng(e.a0), pptAng(e.a1)];
          if (e.r0 <= 0) slide.addShape(full ? 'ellipse' : 'pie', { ...box, ...style, ...(full ? {} : { angleRange: range }) });
          else slide.addShape('blockArc', { ...box, ...style, angleRange: range, arcThicknessRatio: (e.r1 - e.r0) / e.r1 });
        } else if (e.t === 'circle') {
          slide.addShape('ellipse', {
            x: ox + L(e.cx - e.r), y: oy + L(e.cy - e.r), w: L(2 * e.r), h: L(2 * e.r),
            line: { color: hex(e.color), width: pt(e.width) }, objectName: e.name,
          });
        } else if (e.t === 'text') {
          const tw = L(textW(e.s, e.size) * 1.15 + e.size * 0.6), th = L(e.size * 1.5);
          slide.addText(e.s, {
            x: ox + L(e.x) - (e.anchor === 'middle' ? tw / 2 : 0), y: oy + L(e.y) - th / 2, w: tw, h: th,
            fontFace, fontSize: pt(e.size), color: hex(e.color), bold: !!e.bold,
            align: e.anchor === 'middle' ? 'center' : 'left', valign: 'middle', margin: 0, objectName: e.name,
          });
        }
      });
    }
    return pres.write({ outputType: 'blob' });
  }

  async function figToBlob(fig, fmt) {
    const { svg, w, h } = fig;
    if (fmt === 'svg') return new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + svg], { type: 'image/svg+xml' });
    if (fmt === 'pptx') return buildPptx([fig]);
    if (fmt === 'tiff') {
      const opaque = opts.background === 'white';
      const { canvas, dpi } = await rasterAtDpi(svg, w, h, opaque);
      return encodeTiff(canvas, dpi, !opaque);
    }
    if (fmt === 'png' || fmt === 'jpeg') {
      const { canvas, dpi } = await rasterAtDpi(svg, w, h, fmt === 'jpeg' || opts.background === 'white');
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

  const baseName = () => $('fname').value.trim() || 'polypie_plot';
  const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '_');

  async function withBusy(fn) {
    const btns = document.querySelectorAll('#download, .card button');
    btns.forEach((b) => { b.disabled = true; });
    try {
      await fn();
    } catch (e) {
      alert('Export failed: ' + e.message);
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  }

  function download() {
    if (!st.lastSvg) return;
    const fmt = $('fmt').value, name = baseName(), d = st.lastData;
    return withBusy(async () => {
      if ($('split').value !== 'each') {
        const fig = buildSvg(d);
        saveBlob(await figToBlob(fig, fmt), name + EXT[fmt]);
      } else if (fmt === 'pptx') {
        saveBlob(await buildPptx(d.pies.map((p) => buildSvg({ ...d, pies: [p] }))), name + '.pptx');
      } else {
        const zip = new JSZip();
        for (const p of d.pies) {
          const fig = buildSvg({ ...d, pies: [p] });
          zip.file(`${name}_${safeName(p.name)}${EXT[fmt]}`, await figToBlob(fig, fmt));
        }
        saveBlob(await zip.generateAsync({ type: 'blob' }), name + '.zip');
      }
    });
  }

  function downloadCsv() {
    const d = st.lastData;
    if (!d) return;
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const head = ['Combination', 'No. positive', ...d.pies.map((p) => `${p.name} (raw mean; original units)`), ...d.pies.map((p) => `${p.name} (mean sample composition %)`)];
    const lines = [head.map(q).join(',')];
    d.combos.forEach((s, j) => {
      lines.push([q(comboLabel(s, d.markers)), s.filter(Boolean).length,
        ...d.pies.map((p) => p.raw[j]), ...d.pies.map((p) => (p.n ? (p.frac[j] * 100).toFixed(4) : 'NA'))].join(','));
    });
    saveBlob(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }), ($('fname').value.trim() || 'polypie_plot') + '_data.csv');
  }

  // ---------- demo data & templates ----------
  const DEMO_MARKERS = ['IFNg', 'TNFa', 'IL2'];
  const DEMO_COMBOS = [[1, 1, 1], [1, 1, 0], [1, 0, 1], [1, 0, 0], [0, 1, 1], [0, 1, 0], [0, 0, 1], [0, 0, 0]];
  const DEMO_VALUES = {
    Healthy: [8, 15, 4, 18, 5, 14, 6, 30],
    HIV: [2, 6, 1, 25, 2, 12, 3, 49],
    Vaccinated: [20, 22, 6, 12, 10, 8, 5, 17],
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
  $('noticeOk').addEventListener('click', () => showNotice(null));
  window.addEventListener('resize', sizeChrome);
  $('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));
  $('sheet').addEventListener('change', (e) => loadSheet(e.target.value));
  $('demoA').addEventListener('click', () => loadDemo('a'));
  $('demoB').addEventListener('click', () => loadDemo('b'));
  $('tplA').addEventListener('click', () => XLSX.writeFile(aoaWorkbook(demoTableAoa(), 'Combinations'), 'PolyPie_template_A_combinations.xlsx'));
  $('tplB').addEventListener('click', () => XLSX.writeFile(aoaWorkbook(demoFlowJoAoa(), 'FlowJo'), 'PolyPie_template_B_flowjo.xlsx'));
  $('pieMode').addEventListener('change', (e) => { st.pieMode = e.target.value; render(); });
  $('groupCol').addEventListener('change', (e) => { st.groupCol = e.target.value; render(); });
  $('pieAll').addEventListener('click', () => { st.pieOff.clear(); st.pieSig = ''; render(); });
  $('pieNone').addEventListener('click', () => { (st.lastData ? st.lastData.allNames : []).forEach((n) => st.pieOff.add(n)); st.pieSig = ''; render(); });
  document.querySelectorAll('[data-key]').forEach((el) => el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', render));
  const fmtChanged = () => {
    const v = $('fmt').value;
    $('dpiLabel').hidden = !RASTER.has(v);
    updateDownloadLabel();
    $('pdfHint').hidden = v !== 'pdf';
  };
  $('fmt').addEventListener('change', fmtChanged);
  $('split').addEventListener('change', render);
  fmtChanged();
  $('download').addEventListener('click', download);
  $('downloadCsv').addEventListener('click', downloadCsv);
  const reloadImport = () => { if (st.wb) loadSheet($('sheet').value); };
  ['importStat', 'missingPolicy'].forEach((id) => $(id).addEventListener('change', reloadImport));
  $('applyImport').addEventListener('click', reloadImport);
  $('showPoints').addEventListener('change', render);
  $('statsSeed').addEventListener('change', render);
  $('statsOn').addEventListener('change', render);
  $('statsA').addEventListener('change', render);
  $('statsB').addEventListener('change', render);
  $('dlStats').addEventListener('click', downloadStatsCsv);
  $('dlBar').addEventListener('click', () => withBusy(async () => {
    if (!st.lastBar) return;
    const fmt = $('fmt').value;
    saveBlob(await figToBlob(st.lastBar, fmt), `${baseName()}_bars${EXT[fmt]}`);
  }));

  const demo = new URLSearchParams(location.search).get('demo');
  if (demo) loadDemo(demo);
})();
