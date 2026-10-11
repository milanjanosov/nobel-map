/* Nobel Map: where laureates were born. Static app, no build step. */
(function () {
  'use strict';

  // ---------- Config (all URLs and tunables live here) ----------
  const CONFIG = {
    data: {
      countries: 'data/countries.geojson',
      laureates: 'data/laureates.json',
      countryStats: 'data/country_stats.json',
      mockCountries: 'data/mock/countries.geojson',
      mockLaureates: 'data/mock/laureates.json'
    },
    basemapStyle: 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json',
    newsletter: {
      embedUrl: 'https://milanjanosov.substack.com/embed',
      subscribeUrl: 'https://milanjanosov.substack.com/subscribe',
      showAfterMs: 20000,
      showAfterInteractions: 5,
      storageKey: 'nobelmap.newsletterSeen'
    },
    minYear: 1901,
    playStepMs: 120,
    // Normalised modes: countries below this population are never rated.
    minPopForRates: 1000000,
    // Fixed classes: [min count, colour, label]. Index 0 is "no laureates".
    classes: [
      [0, 'rgba(255,255,255,0.04)', 'None'],
      [1, '#4a3b12', '1'],
      [2, '#7a5c14', '2–5'],
      [6, '#a87c12', '6–20'],
      [21, '#d4a017', '21–50'],
      [51, '#f0c43a', '51–100'],
      [101, '#ffe58a', '100+']
    ],
    // Metrics. Rate class breaks are placeholders, to be tuned later; 6 classes
    // so the category palettes keep applying unchanged.
    metrics: {
      count: { label: 'Laureates', legendTitle: 'Laureates per country' },
      pop: {
        label: 'Per 10M people', legendTitle: 'Laureates per 10M people', unit: 'per 10M people',
        breaks: [0.5, 2, 5, 10, 20],
        labels: ['< 0.5', '0.5–2', '2–5', '5–10', '10–20', '20+']
      },
      gdp: {
        label: 'Per $1T GDP', legendTitle: 'Laureates per $1T GDP', unit: 'per $1T GDP',
        breaks: [2, 5, 10, 25, 50],
        labels: ['< 2', '2–5', '5–10', '10–25', '25–50', '50+']
      }
    },
    noRateFill: 'rgba(128, 136, 150, 0.22)',
    // Sequential palettes on the same 6 fixed classes (dark to bright). 'All' uses gold.
    palettes: {
      All:        ['#4a3b12', '#7a5c14', '#a87c12', '#d4a017', '#f0c43a', '#ffe58a'],
      Physics:    ['#0f2a4a', '#17457a', '#1f63ad', '#3b86d9', '#6aa9ff', '#b8d8ff'],
      Chemistry:  ['#3a1a05', '#6b3209', '#a14c0c', '#d9701a', '#ff9f45', '#ffd9b3'],
      Medicine:   ['#3d0f1f', '#6e1a37', '#a62650', '#d9406f', '#ff7a9f', '#ffc9d8'],
      Literature: ['#2a1650', '#48278a', '#6a3fc0', '#8f66e0', '#b794f6', '#dccbff'],
      Peace:      ['#0e3321', '#17593a', '#218558', '#38b377', '#5ed39a', '#bdf0d6'],
      Economics:  ['#0a3338', '#0f5760', '#17808c', '#2aaab6', '#4fd1d9', '#b5ecf0']
    },
    categories: [
      { name: 'Physics', color: '#6aa9ff' },
      { name: 'Chemistry', color: '#ff9f45' },
      { name: 'Medicine', color: '#ff5c8a' },
      { name: 'Literature', color: '#b794f6' },
      { name: 'Peace', color: '#5ed39a' },
      { name: 'Economics', color: '#4fd1d9' }
    ]
  };

  const params = new URLSearchParams(location.search);
  const USE_MOCK = params.get('mock') === '1';
  const CAT_NAMES = CONFIG.categories.map(c => c.name);
  const CAT_COLOR = Object.fromEntries(CONFIG.categories.map(c => [c.name, c.color]));
  const METRIC_KEYS = ['count', 'pop', 'gdp'];
  const NO_RATE_SMALL = 'Under 1M people — not rated per capita';
  const NO_RATE_NODATA = 'No population/GDP data';

  const $ = id => document.getElementById(id);
  const el = {
    big: $('big-number'), bigLabel: $('big-label'),
    from: $('from'), to: $('to'), fromOut: $('from-out'), toOut: $('to-out'), fill: $('range-fill'),
    play: $('play'), playIcon: $('play-icon'), playText: $('play-text'),
    metric: $('metric'), metricNote: $('metric-note'),
    chips: $('chips'), top10: $('top10'), legend: $('legend'), legendTitle: $('legend-title'),
    cardSheet: $('card-sheet'),
    loadMsg: $('load-msg'), panel: $('panel'), sheetToggle: $('sheet-toggle'),
    newsModal: $('news-modal'), aboutModal: $('about-modal')
  };

  // ---------- State ----------
  const state = { from: CONFIG.minYear, to: CONFIG.minYear, cat: 'All', metric: 'count', sel: null };
  let maxYear = 2025;
  let awards = [];
  let names = {};       // iso3 -> country name
  let isoList = [];     // all iso3 in the map
  let labelPoints = {}; // iso3 -> [lng, lat] (largest-ring centroid)
  let stats = null;     // country_stats.json payload, or null if unavailable
  let current = null;   // last computed stats
  let map = null;
  let mapReady = false;
  let hoverId = null;
  let popup = null;      // hover tooltip
  let cardPopup = null;  // laureate card (desktop)
  let cardAnchor = null; // [lng, lat] for the card

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => n.toLocaleString('en-US');
  const fmtRate = v => v.toFixed(1);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const isMobile = () => window.innerWidth < 760;
  const statsAvailable = () => !!(stats && stats.countries);

  // ---------- URL hash ----------
  function readHash() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    const from = parseInt(h.get('from'), 10), to = parseInt(h.get('to'), 10);
    state.from = Number.isFinite(from) ? clamp(from, CONFIG.minYear, maxYear) : CONFIG.minYear;
    state.to = Number.isFinite(to) ? clamp(to, CONFIG.minYear, maxYear) : maxYear;
    if (state.from > state.to) state.from = state.to;
    const cat = h.get('cat');
    // Single value only; anything else (including old multi-value links) means All.
    state.cat = CAT_NAMES.includes(cat) ? cat : 'All';
    const m = h.get('m');
    state.metric = METRIC_KEYS.includes(m) && m !== 'count' && statsAvailable() ? m : 'count';
    const sel = h.get('sel');
    state.sel = sel && names[sel] ? sel : null;
    if (state.sel) cardAnchor = labelPoints[state.sel] || null;
  }

  function writeHash() {
    const h = new URLSearchParams();
    h.set('from', state.from);
    h.set('to', state.to);
    if (state.cat !== 'All') h.set('cat', state.cat);
    if (state.metric !== 'count') h.set('m', state.metric);
    if (state.sel) h.set('sel', state.sel);
    const str = '#' + h.toString().replace(/%2C/g, ',');
    if (str !== location.hash) {
      try { history.replaceState(null, '', str); } catch (e) { /* file:// or sandboxed */ }
    }
  }

  // ---------- Safe storage ----------
  function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storageSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  // ---------- Counting ----------
  // Distinct laureates (lid) per country among awards passing the filters.
  function compute() {
    const perCountry = new Map();   // iso3 -> {people:Set, cats: Map(cat -> Set)}
    const all = new Set();
    const rows = [];
    for (const a of awards) {
      if (a.year < state.from || a.year > state.to || (state.cat !== 'All' && a.category !== state.cat)) continue;
      rows.push(a);
      all.add(a.lid);
      let c = perCountry.get(a.iso3);
      if (!c) { c = { people: new Set(), cats: new Map() }; perCountry.set(a.iso3, c); }
      c.people.add(a.lid);
      let s = c.cats.get(a.category);
      if (!s) { s = new Set(); c.cats.set(a.category, s); }
      s.add(a.lid);
    }
    const counts = new Map();
    for (const [iso, c] of perCountry) counts.set(iso, c.people.size);
    return { perCountry, counts, total: all.size, countries: perCountry.size, rows };
  }

  function classOf(n) {
    let idx = 0;
    for (let i = 0; i < CONFIG.classes.length; i++) if (n >= CONFIG.classes[i][0]) idx = i;
    return idx;
  }
  function classOfRate(v, breaks) {
    if (!(v > 0)) return 0;
    let idx = 1;
    for (const b of breaks) if (v >= b) idx++;
    return idx;
  }

  // Rate of the active metric for one country. count mode is always "rated".
  // {rated:true, value} or {rated:false, reason:'small'|'nodata'}
  function rateInfo(iso, count) {
    if (state.metric === 'count') return { rated: true, value: count };
    const s = statsAvailable() ? stats.countries[iso] : null;
    if (!s || !Number.isFinite(s.pop) || s.pop <= 0) return { rated: false, reason: 'nodata' };
    if (s.pop < CONFIG.minPopForRates) return { rated: false, reason: 'small' };
    if (state.metric === 'pop') return { rated: true, value: count / (s.pop / 1e7) };
    if (!Number.isFinite(s.gdp_usd) || s.gdp_usd <= 0) return { rated: false, reason: 'nodata' };
    return { rated: true, value: count / (s.gdp_usd / 1e12) };
  }

  // Map feature class for one country under the active metric.
  function clsFor(iso) {
    const count = current.counts.get(iso) || 0;
    const info = rateInfo(iso, count);
    if (!info.rated) return { cls: 0, noRate: true };
    if (state.metric === 'count') return { cls: classOf(count), noRate: false };
    return { cls: classOfRate(info.value, CONFIG.metrics[state.metric].breaks), noRate: false };
  }

  // ---------- Map ----------
  function palette() { return CONFIG.palettes[state.cat] || CONFIG.palettes.All; }

  // Class index (0–6) is computed in JS and stored as feature-state, so the
  // same expression serves every metric.
  function fillExpression() {
    const pal = palette();
    const step = ['step', ['coalesce', ['feature-state', 'cls'], 0], CONFIG.classes[0][1]];
    for (let i = 0; i < 6; i++) step.push(i + 1, pal[i]);
    return ['case', ['boolean', ['feature-state', 'noRate'], false], CONFIG.noRateFill, step];
  }

  // Subtle diagonal hatch for not-rated countries in normalised modes.
  function hatchImage() {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d');
    g.strokeStyle = 'rgba(205, 211, 222, 0.5)';
    g.lineWidth = 2;
    for (const o of [-16, 0, 16]) {
      g.beginPath(); g.moveTo(o, 16); g.lineTo(o + 16, 0); g.stroke();
    }
    return g.getImageData(0, 0, 16, 16);
  }

  // Recolour everything that carries the accent: CSS variables, legend, map fill and outlines.
  let themeKey = null;
  function applyTheme() {
    const key = state.cat + '|' + state.metric;
    if (themeKey === key) return;
    themeKey = key;
    const pal = palette();
    const root = document.documentElement.style;
    root.setProperty('--gold-deep', pal[3]);
    root.setProperty('--gold', pal[4]);
    root.setProperty('--gold-soft', pal[5]);
    renderLegend();
    el.metricNote.hidden = state.metric === 'count';
    if (mapReady) applyMapTheme();
  }
  function applyMapTheme() {
    const pal = palette();
    map.setPaintProperty('country-fill', 'fill-color', fillExpression());
    map.setPaintProperty('country-hover', 'line-color', pal[4]);
    map.setPaintProperty('country-selected', 'line-color', pal[5]);
  }

  function applyMapState() {
    if (!mapReady) return;
    for (const iso of isoList) {
      const c = clsFor(iso);
      map.setFeatureState({ source: 'countries', id: iso }, {
        count: current.counts.get(iso) || 0, cls: c.cls, noRate: c.noRate
      });
    }
    if (map.getLayer('country-selected')) {
      map.setFilter('country-selected', ['==', ['get', 'iso3'], state.sel || '']);
    }
  }

  function setHover(id) {
    if (hoverId === id) return;
    if (hoverId) map.setFeatureState({ source: 'countries', id: hoverId }, { hover: false });
    hoverId = id;
    if (id) map.setFeatureState({ source: 'countries', id }, { hover: true });
  }

  function rateLineHtml(iso, n) {
    if (state.metric === 'count') return '';
    const info = rateInfo(iso, n);
    if (info.rated) {
      return '<div class="t-rate">' + fmtRate(info.value) + ' ' + esc(CONFIG.metrics[state.metric].unit) + '</div>';
    }
    return '<div class="t-rate t-muted">' + (info.reason === 'small' ? NO_RATE_SMALL : NO_RATE_NODATA) + '</div>';
  }

  function tooltipHtml(iso) {
    const c = current.perCountry.get(iso);
    const n = c ? c.people.size : 0;
    let h = '<div class="tip"><div class="t-name">' + esc(names[iso] || iso) + '</div>' +
      '<div class="t-count">' + fmt(n) + (n === 1 ? ' laureate' : ' laureates') + '</div>' +
      rateLineHtml(iso, n);
    if (c) {
      for (const cat of (state.cat === 'All' ? CAT_NAMES : [])) {
        const s = c.cats.get(cat);
        if (s) h += '<div class="t-row" style="--c:' + CAT_COLOR[cat] + '"><i></i>' + cat + '<b>' + s.size + '</b></div>';
      }
      h += '<div class="t-hint">Click to list</div>';
    }
    return h + '</div>';
  }

  // ---------- Label points (card anchors for Top-10 clicks) ----------
  function ringCentroid(ring) {
    let a = 0, x = 0, y = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f; x += (ring[j][0] + ring[i][0]) * f; y += (ring[j][1] + ring[i][1]) * f;
    }
    if (!a) return ring[0].slice(0, 2);
    return [x / (3 * a), y / (3 * a)];
  }
  function ringArea(ring) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    return Math.abs(a / 2);
  }
  // One label point per country: centroid of the largest outer ring.
  function computeLabelPoints(geojson) {
    for (const f of geojson.features) {
      const g = f.geometry;
      if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : (g.type === 'MultiPolygon' ? g.coordinates : []);
      let best = null, bestArea = -1;
      for (const p of polys) {
        const ring = p && p[0];
        if (!ring || ring.length < 4) continue;
        const area = ringArea(ring);
        if (area > bestArea) { bestArea = area; best = ring; }
      }
      if (best) labelPoints[f.properties.iso3] = ringCentroid(best);
    }
  }

  function initMap(geojson) {
    map = new maplibregl.Map({
      container: 'map',
      style: CONFIG.basemapStyle,
      center: [12, 28],
      zoom: window.innerWidth < 760 ? 0.9 : 1.55,
      minZoom: 0.6,
      maxZoom: 7,
      attributionControl: { compact: true },
      dragRotate: false
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, className: 'tip', maxWidth: '260px' });

    map.on('load', () => {
      try { map.addImage('hatch', hatchImage(), { pixelRatio: 2 }); } catch (e) { /* non-fatal */ }
      map.addSource('countries', { type: 'geojson', data: geojson, promoteId: 'iso3' });
      map.addLayer({
        id: 'country-fill', type: 'fill', source: 'countries',
        paint: {
          'fill-color': fillExpression(),
          'fill-color-transition': { duration: 450, delay: 0 },
          'fill-opacity': 0.92
        }
      });
      if (map.hasImage('hatch')) {
        map.addLayer({
          id: 'country-norate', type: 'fill', source: 'countries',
          paint: {
            'fill-pattern': 'hatch',
            'fill-opacity': ['case', ['boolean', ['feature-state', 'noRate'], false], 0.45, 0]
          }
        });
      }
      map.addLayer({
        id: 'country-line', type: 'line', source: 'countries',
        paint: { 'line-color': 'rgba(255,255,255,0.16)', 'line-width': 0.5 }
      });
      map.addLayer({
        id: 'country-selected', type: 'line', source: 'countries', filter: ['==', ['get', 'iso3'], ''],
        paint: { 'line-color': palette()[5], 'line-width': 2.2 }
      });
      map.addLayer({
        id: 'country-hover', type: 'line', source: 'countries',
        paint: {
          'line-color': palette()[4],
          'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.4, 0],
          'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0]
        }
      });

      map.on('mousemove', 'country-fill', e => {
        const f = e.features && e.features[0];
        if (!f) return;
        const iso = f.properties.iso3;
        map.getCanvas().style.cursor = 'pointer';
        setHover(iso);
        if (state.sel) { popup.remove(); return; } // tooltip hides while the card is open
        popup.setLngLat(e.lngLat).setHTML(tooltipHtml(iso)).addTo(map);
      });
      map.on('mouseleave', 'country-fill', () => {
        map.getCanvas().style.cursor = '';
        setHover(null);
        popup.remove();
      });
      map.on('click', 'country-fill', e => {
        const f = e.features && e.features[0];
        if (f) selectCountry(f.properties.iso3, [e.lngLat.lng, e.lngLat.lat]);
      });
      map.on('click', e => {
        if (!map.queryRenderedFeatures(e.point, { layers: ['country-fill'] }).length) selectCountry(null);
      });

      mapReady = true;
      applyMapState();
      renderCard();
      // A shared #sel= link opens the card on load, centred on the country.
      if (state.sel && cardAnchor) map.easeTo({ center: cardAnchor });
      el.loadMsg.classList.add('hidden');
    });

    map.on('error', ev => {
      if (!mapReady && ev && ev.error) console.warn('Map error:', ev.error.message || ev.error);
    });
  }

  // ---------- UI rendering ----------
  function renderMetricControl() {
    el.metric.innerHTML = '';
    const ok = statsAvailable();
    for (const key of METRIC_KEYS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn';
      b.dataset.m = key;
      b.textContent = CONFIG.metrics[key].label;
      b.setAttribute('aria-pressed', 'false');
      if (key !== 'count' && !ok) {
        b.disabled = true;
        b.title = 'data not ready';
      }
      b.addEventListener('click', () => {
        if (state.metric === key || b.disabled) return;
        state.metric = key;
        countInteraction();
        update();
      });
      el.metric.appendChild(b);
    }
  }

  function renderChips() {
    el.chips.innerHTML = '';
    const items = [{ name: 'All', color: CONFIG.palettes.All[4] }].concat(CONFIG.categories);
    for (const c of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.cat = c.name;
      b.style.setProperty('--c', c.color);
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = '<span class="dot"></span>' + c.name;
      b.addEventListener('click', () => {
        if (state.cat === c.name) return;
        stopPlay();
        state.cat = c.name;
        countInteraction();
        update();
      });
      el.chips.appendChild(b);
    }
  }

  function renderLegend() {
    el.legend.innerHTML = '';
    const m = CONFIG.metrics[state.metric];
    el.legendTitle.textContent = m.legendTitle;
    const labels = state.metric === 'count'
      ? CONFIG.classes.slice(1).map(c => c[2])
      : m.labels;
    for (let i = 0; i < 6; i++) {
      const li = document.createElement('li');
      li.style.setProperty('--c', palette()[i]);
      li.innerHTML = '<i></i>' + labels[i];
      el.legend.appendChild(li);
    }
    if (state.metric !== 'count') {
      const li = document.createElement('li');
      li.className = 'norate';
      li.innerHTML = '<i></i>Not rated';
      el.legend.appendChild(li);
    }
  }

  function renderControls() {
    el.from.value = state.from;
    el.to.value = state.to;
    el.fromOut.textContent = state.from;
    el.toOut.textContent = state.to;
    const span = maxYear - CONFIG.minYear || 1;
    el.fill.style.left = ((state.from - CONFIG.minYear) / span * 100) + '%';
    el.fill.style.right = ((maxYear - state.to) / span * 100) + '%';
    const mid = (CONFIG.minYear + maxYear) / 2;
    el.from.style.zIndex = state.from > mid ? 3 : 2;
    el.to.style.zIndex = state.from > mid ? 2 : 3;
    for (const b of el.chips.children) b.setAttribute('aria-pressed', state.cat === b.dataset.cat ? 'true' : 'false');
    for (const b of el.metric.children) b.setAttribute('aria-pressed', state.metric === b.dataset.m ? 'true' : 'false');
  }

  function renderHeadline() {
    el.big.textContent = fmt(current.total);
    const p = current.total === 1 ? 'laureate' : 'laureates';
    const m = current.countries === 1 ? 'country' : 'countries';
    el.bigLabel.innerHTML = p + ' from <b>' + fmt(current.countries) + '</b> ' + m;
  }

  function renderTop10() {
    let list;
    if (state.metric === 'count') {
      list = [...current.counts.entries()]
        .map(([iso, n]) => ({ iso, n, v: n }))
        .sort((a, b) => b.v - a.v || (names[a.iso] || a.iso).localeCompare(names[b.iso] || b.iso))
        .slice(0, 10);
    } else {
      // Rank by the active rate, among rated countries only.
      list = [...current.counts.entries()]
        .map(([iso, n]) => ({ iso, n, info: rateInfo(iso, n) }))
        .filter(d => d.info.rated && d.n > 0)
        .map(d => ({ iso: d.iso, n: d.n, v: d.info.value }))
        .sort((a, b) => b.v - a.v || (names[a.iso] || a.iso).localeCompare(names[b.iso] || b.iso))
        .slice(0, 10);
    }
    if (!list.length) { el.top10.innerHTML = '<li class="empty">No laureates match these filters.</li>'; return; }
    const max = list[0].v || 1;
    el.top10.innerHTML = list.map(d => {
      const ct = state.metric === 'count'
        ? fmt(d.n)
        : fmtRate(d.v) + ' <small class="raw">· ' + fmt(d.n) + (d.n === 1 ? ' laureate' : ' laureates') + '</small>';
      return '<li class="' + (d.iso === state.sel ? 'sel' : '') + '"><button type="button" data-iso="' + esc(d.iso) + '">' +
        '<span class="nm">' + esc(names[d.iso] || d.iso) + '</span><span class="ct">' + ct + '</span>' +
        '<span class="bar" style="width:' + (d.v / max * 100).toFixed(1) + '%"></span></button></li>';
    }).join('');
  }

  // ---------- Laureate card ----------
  // One row per person: dedupe awards by lid; Curie gets "Physics 1903 · Chemistry 1911".
  function cardElement(iso) {
    const rows = current.rows.filter(a => a.iso3 === iso);
    const byPerson = new Map();
    for (const a of rows) {
      let p = byPerson.get(a.lid);
      if (!p) { p = { name: a.name, link: null, awards: [] }; byPerson.set(a.lid, p); }
      p.awards.push(a);
      // Prefer the new wiki field; fall back to the nobelprize.org url.
      if (!p.link && a.wiki) p.link = a.wiki;
      if (!p.link && a.url) p.link = a.url;
    }
    const people = [...byPerson.values()];
    for (const p of people) p.awards.sort((a, b) => a.year - b.year);
    people.sort((a, b) => a.awards[0].year - b.awards[0].year || a.name.localeCompare(b.name));

    const n = current.counts.get(iso) || 0;
    let sub = fmt(n) + (n === 1 ? ' laureate' : ' laureates');
    if (state.metric !== 'count') {
      const info = rateInfo(iso, n);
      sub += info.rated
        ? ' · ' + fmtRate(info.value) + ' ' + CONFIG.metrics[state.metric].unit
        : ' · ' + (info.reason === 'small' ? NO_RATE_SMALL : NO_RATE_NODATA);
    }

    const root = document.createElement('div');
    root.className = 'card';
    const list = people.length ? people.map(p => {
      const aw = p.awards.map(a =>
        '<span class="aw" style="--c:' + (CAT_COLOR[a.category] || '#888') + '"><i class="dot"></i>' +
        esc(a.category) + ' ' + a.year + '</span>').join('<span class="sep"> · </span>');
      const name = p.link
        ? '<a href="' + esc(p.link) + '" target="_blank" rel="noopener">' + esc(p.name) + '</a>'
        : '<span class="noname">' + esc(p.name) + '</span>';
      return '<li>' + name + '<span class="aws">' + aw + '</span></li>';
    }).join('') : '<li class="empty">No laureates match the current filters.</li>';
    root.innerHTML =
      '<div class="card-head"><div><h2>' + esc(names[iso] || iso) + '</h2>' +
      '<p>' + sub + '</p></div>' +
      '<button type="button" class="icon-btn card-close" aria-label="Close">✕</button></div>' +
      '<ul class="card-list">' + list + '</ul>';
    root.querySelector('.card-close').addEventListener('click', () => selectCountry(null));
    return root;
  }

  function closeCard() {
    if (cardPopup) cardPopup.remove();
    el.cardSheet.hidden = true;
    el.cardSheet.innerHTML = '';
  }

  function renderCard() {
    if (!state.sel) { closeCard(); return; }
    const iso = state.sel;
    const content = cardElement(iso);
    if (isMobile()) {
      // Bottom-anchored overlay on small screens.
      if (cardPopup) { cardPopup.remove(); cardPopup = null; }
      el.cardSheet.innerHTML = '';
      el.cardSheet.appendChild(content);
      el.cardSheet.hidden = false;
      return;
    }
    el.cardSheet.hidden = true;
    el.cardSheet.innerHTML = '';
    if (!mapReady) return;
    const anchor = cardAnchor || labelPoints[iso];
    if (!anchor) return;
    if (!cardPopup) {
      // One persistent popup, reused across selections. Note: addTo() on an
      // already-open popup removes and re-adds it, so guard with isOpen().
      cardPopup = new maplibregl.Popup({
        closeButton: false, closeOnClick: false, offset: 12,
        className: 'card-popup', maxWidth: '340px'
      });
    }
    cardPopup.setLngLat(anchor).setDOMContent(content);
    if (!cardPopup.isOpen()) cardPopup.addTo(map);
    popup.remove(); // hover tooltip hides while the card is open
  }

  let raf = 0;
  function update() {
    current = compute();
    applyTheme();
    renderControls();
    renderHeadline();
    renderTop10();
    renderCard();
    applyMapState();
    writeHash();
    if (popup && popup.isOpen() && hoverId && !state.sel) popup.setHTML(tooltipHtml(hoverId));
  }
  function scheduleUpdate() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; update(); });
  }

  // lngLat: map click point. Without it (Top-10, hash) the card anchors at the
  // country's label point and the map eases there.
  function selectCountry(iso, lngLat) {
    if (!iso) {
      state.sel = null;
      cardAnchor = null;
      update();
      return;
    }
    state.sel = iso;
    cardAnchor = lngLat || labelPoints[iso] || null;
    if (!lngLat && cardAnchor && mapReady) map.easeTo({ center: cardAnchor });
    update();
  }

  // ---------- Slider ----------
  function onSlider(which) {
    stopPlay();
    let f = parseInt(el.from.value, 10), t = parseInt(el.to.value, 10);
    if (which === 'from' && f > t) f = t;
    if (which === 'to' && t < f) t = f;
    state.from = f; state.to = t;
    countInteraction();
    scheduleUpdate();
  }
  el.from.addEventListener('input', () => onSlider('from'));
  el.to.addEventListener('input', () => onSlider('to'));

  // ---------- Play ----------
  let playTimer = null;
  function setPlayUi(on) {
    el.play.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.playIcon.textContent = on ? '❚❚' : '▶';
    el.playText.textContent = on ? 'Pause' : 'Play';
  }
  function stopPlay() {
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    setPlayUi(false);
  }
  function startPlay() {
    // Cumulative: from stays at 1901, the end year advances.
    state.from = CONFIG.minYear;
    if (state.to >= maxYear || state.to < CONFIG.minYear) state.to = CONFIG.minYear;
    setPlayUi(true);
    update();
    playTimer = setInterval(() => {
      if (state.to >= maxYear) { stopPlay(); return; }
      state.to += 1;
      update();
      if (state.to >= maxYear) stopPlay();
    }, CONFIG.playStepMs);
  }
  el.play.addEventListener('click', () => { if (playTimer) stopPlay(); else startPlay(); });

  // ---------- Modals & newsletter ----------
  function openDialog(d) {
    if (d.open) return;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }
  function closeDialog(d) {
    if (typeof d.close === 'function') d.close(); else d.removeAttribute('open');
  }
  for (const d of [el.newsModal, el.aboutModal]) {
    d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-close]')) closeDialog(d); });
  }

  let newsLoaded = false;
  function openNewsletter(auto) {
    if (!newsLoaded) {
      newsLoaded = true;
      $('news-frame').src = CONFIG.newsletter.embedUrl;
      $('news-link').href = CONFIG.newsletter.subscribeUrl;
    }
    if (auto) storageSet(CONFIG.newsletter.storageKey, '1');
    openDialog(el.newsModal);
  }
  // Remember dismissal whenever the modal closes after being shown.
  el.newsModal.addEventListener('close', () => storageSet(CONFIG.newsletter.storageKey, '1'));

  let interactions = 0, autoTimer = null;
  function newsletterEligible() {
    return !storageGet(CONFIG.newsletter.storageKey) && !el.newsModal.open && !el.aboutModal.open;
  }
  function maybeAutoShow() {
    if (!newsletterEligible()) return;
    clearTimeout(autoTimer);
    openNewsletter(true);
  }
  function countInteraction() {
    if (storageGet(CONFIG.newsletter.storageKey)) return;
    interactions += 1;
    if (interactions >= CONFIG.newsletter.showAfterInteractions) maybeAutoShow();
  }
  function startNewsletterTimer() {
    if (storageGet(CONFIG.newsletter.storageKey)) return;
    autoTimer = setTimeout(maybeAutoShow, CONFIG.newsletter.showAfterMs);
  }

  $('news-btn').addEventListener('click', () => openNewsletter(false));
  $('about-btn').addEventListener('click', () => openDialog(el.aboutModal));

  // ---------- Misc wiring ----------
  el.top10.addEventListener('click', e => {
    const b = e.target.closest('button[data-iso]');
    if (!b) return;
    if (state.sel === b.dataset.iso) selectCountry(null);
    else selectCountry(b.dataset.iso);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !el.newsModal.open && !el.aboutModal.open && state.sel) { selectCountry(null); }
  });
  el.sheetToggle.addEventListener('click', () => {
    const collapsed = el.panel.classList.toggle('collapsed');
    el.sheetToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
  window.addEventListener('hashchange', () => {
    if (!current) return;
    stopPlay();
    readHash();
    update();
  });

  // ---------- Boot ----------
  function fail(msg) {
    el.loadMsg.classList.add('error');
    el.loadMsg.classList.remove('hidden');
    el.loadMsg.textContent = msg;
  }

  async function boot() {
    renderMetricControl();
    renderChips();
    renderLegend();
    const paths = USE_MOCK
      ? [CONFIG.data.mockCountries, CONFIG.data.mockLaureates]
      : [CONFIG.data.countries, CONFIG.data.laureates];
    let geo, laur;
    // Country stats are optional: a 404 just disables the normalised modes.
    const statsPromise = fetch(CONFIG.data.countryStats)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
    try {
      const [g, l] = await Promise.all(paths.map(p => fetch(p).then(r => {
        if (!r.ok) throw new Error(p + ' returned ' + r.status);
        return r.json();
      })));
      geo = g; laur = l;
    } catch (err) {
      console.error(err);
      fail('Could not load the data. If you opened this file directly, serve it with: python3 -m http.server 8000');
      return;
    }
    try {
      const s = await statsPromise;
      if (s && s.countries && typeof s.countries === 'object') stats = s;
    } catch (e) { stats = null; }
    renderMetricControl(); // re-render: enable/disable normalised modes now that we know

    awards = (laur.awards || []).filter(a => CAT_NAMES.includes(a.category));
    for (const f of geo.features) names[f.properties.iso3] = f.properties.name;
    isoList = Object.keys(names);
    computeLabelPoints(geo);
    maxYear = awards.reduce((m, a) => Math.max(m, a.year), CONFIG.minYear);
    el.from.min = el.to.min = CONFIG.minYear;
    el.from.max = el.to.max = maxYear;

    const meta = [];
    if (laur.generated) meta.push('Data generated ' + laur.generated);
    if (laur.source) meta.push(laur.source);
    if (laur.unmapped) meta.push(fmt(laur.unmapped.length) + ' prizes could not be mapped (organizations or unknown birth country)');
    if (stats && stats.source) meta.push('Population & GDP: ' + stats.source);
    $('about-meta').textContent = meta.join(' · ') + (USE_MOCK ? ' · MOCK DATA' : '');

    if (location.hash.length > 1) readHash();
    else { state.from = CONFIG.minYear; state.to = maxYear; state.cat = 'All'; state.metric = 'count'; state.sel = null; }

    current = compute();
    update();
    initMap(geo);
    startNewsletterTimer();
  }

  boot();
})();
