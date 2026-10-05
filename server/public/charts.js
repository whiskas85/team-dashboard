// Minimal SVG line chart with crosshair tooltip. No dependencies.
/* exported lineChart, fmt */
'use strict';

const SVGNS = 'http://www.w3.org/2000/svg';

const fmt = {
  pct: (v) => (v == null ? '–' : `${v.toFixed(v < 10 ? 1 : 0)}%`),
  mb: (v) => (v == null ? '–' : v >= 1024 ? `${(v / 1024).toFixed(v >= 10240 ? 0 : 1)} GB` : `${Math.round(v)} MB`),
  gb: (v) => (v == null ? '–' : `${v.toFixed(v < 10 ? 1 : 0)} GB`),
  cores: (v) => (v == null ? '–' : `${v.toFixed(2)} core`),
  bps: (v) => {
    if (v == null) return '–';
    const bits = v * 8;
    if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gb/s`;
    if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
    if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kb/s`;
    return `${Math.round(bits)} b/s`;
  },
  num: (v) => (v == null ? '–' : v.toFixed(2)),
  time(ts, span) {
    const d = new Date(ts * 1000);
    if (span > 2 * 86400) return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
    return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  },
  dateTime: (ts) => new Date(ts * 1000).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
};

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * exp;
}

/**
 * opts: { ts:number[], series:[{name, values, color}], yMax?, format, limit?:{value,label}, height?, from?, to? }
 */
function lineChart(container, opts) {
  container.classList.add('chart');
  const draw = () => render(container, opts);
  draw();
  if (!container._ro) {
    let w = container.clientWidth;
    container._ro = new ResizeObserver(() => {
      if (Math.abs(container.clientWidth - w) > 4) {
        w = container.clientWidth;
        draw();
      }
    });
    container._ro.observe(container);
  }
}

function render(container, opts) {
  const { ts, series, format = fmt.num } = opts;
  const H = opts.height || 190;
  const W = Math.max(280, container.clientWidth || 600);
  const m = { t: 10, r: 12, b: 24, l: 56 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  container.innerHTML = '';

  if (series.length > 1) {
    const lg = document.createElement('div');
    lg.className = 'legend';
    lg.innerHTML = series.map((s) => `<span><i class="swatch" style="background:${s.color}"></i>${s.name}</span>`).join('');
    lg.style.marginBottom = '6px';
    container.appendChild(lg);
  }

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': series.map((s) => s.name).join(', ') });
  container.appendChild(svg);

  const from = opts.from ?? ts[0];
  const to = opts.to ?? ts[ts.length - 1];
  const hasData = series.some((s) => s.values.some((v) => v != null));
  if (!ts.length || !hasData) {
    el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty' }, svg).textContent = 'Nessun dato nel periodo';
    return;
  }

  let dataMax = 0;
  for (const s of series) for (const v of s.values) if (v != null && v > dataMax) dataMax = v;
  if (opts.limit && opts.limit.value > dataMax) dataMax = opts.limit.value;
  const yMax = opts.yMax ?? niceMax(dataMax * 1.1);
  const span = Math.max(1, to - from);
  const x = (t) => m.l + ((t - from) / span) * iw;
  const y = (v) => m.t + ih - (Math.min(v, yMax) / yMax) * ih;

  // grid + y ticks
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    const yy = y(v);
    el('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: i === 0 ? 'base-line' : 'grid-line' }, svg);
    el('text', { x: m.l - 8, y: yy + 4, 'text-anchor': 'end', class: 'tick' }, svg).textContent = format(v);
  }
  // x ticks
  const nx = Math.max(2, Math.min(6, Math.floor(iw / 110)));
  for (let i = 0; i <= nx; i++) {
    const t = from + (span / nx) * i;
    el('text', { x: x(t), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === nx ? 'end' : 'middle', class: 'tick' }, svg).textContent = fmt.time(t, span);
  }
  if (opts.limit) {
    const ly = y(opts.limit.value);
    el('line', { x1: m.l, x2: W - m.r, y1: ly, y2: ly, class: 'limit' }, svg);
    el('text', { x: W - m.r, y: ly - 4, 'text-anchor': 'end', class: 'limit-label' }, svg).textContent = opts.limit.label;
  }

  // series (gaps break the line: missing buckets longer than 2 steps)
  const step = ts.length > 1 ? ts[1] - ts[0] : 60;
  series.forEach((s, si) => {
    let d = '';
    let area = '';
    let prevT = null;
    let seg = [];
    const flush = () => {
      if (!seg.length) return;
      d += seg.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
      if (series.length === 1) area += `M${seg[0][0].toFixed(1)},${y(0)}` + seg.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('') + `L${seg[seg.length - 1][0].toFixed(1)},${y(0)}Z`;
      seg = [];
    };
    ts.forEach((t, i) => {
      const v = s.values[i];
      if (v == null) return;
      if (prevT != null && t - prevT > step * 2.5) flush();
      seg.push([x(t), y(v)]);
      prevT = t;
    });
    flush();
    if (area) el('path', { d: area, class: 'area', fill: s.color }, svg);
    el('path', { d, class: 'series', stroke: s.color, 'data-i': si }, svg);
  });

  // hover layer
  const cross = el('line', { y1: m.t, y2: m.t + ih, class: 'cross', visibility: 'hidden' }, svg);
  const dots = series.map((s) => el('circle', { r: 4, fill: s.color, class: 'hover-dot', visibility: 'hidden' }, svg));
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  container.appendChild(tip);
  const hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, svg);

  const move = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const t = from + ((px - m.l) / iw) * span;
    let best = 0;
    for (let i = 1; i < ts.length; i++) if (Math.abs(ts[i] - t) < Math.abs(ts[best] - t)) best = i;
    const cx = x(ts[best]);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    series.forEach((s, si) => {
      const v = s.values[best];
      if (v == null) return dots[si].setAttribute('visibility', 'hidden');
      dots[si].setAttribute('cx', cx);
      dots[si].setAttribute('cy', y(v));
      dots[si].setAttribute('visibility', 'visible');
    });
    tip.innerHTML =
      `<div class="t">${fmt.dateTime(ts[best])}</div>` +
      series.map((s) => `<div class="r"><span><i class="swatch" style="background:${s.color}"></i>${s.name}</span><b>${format(s.values[best])}</b></div>`).join('');
    tip.style.display = 'block';
    const left = (cx / W) * rect.width;
    const tw = tip.offsetWidth;
    tip.style.left = `${left + 14 + tw > rect.width ? left - tw - 14 : left + 14}px`;
    tip.style.top = `${svg.offsetTop + 8}px`;
  };
  const leave = () => {
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    tip.style.display = 'none';
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', leave);
}
