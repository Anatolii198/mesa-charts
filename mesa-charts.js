/* ==========================================================================
   Mesa — chart engine
   Plain SVG. No libraries, no build step. ~400 lines you can read and edit.

   Every chart: Mesa.<type>(mountSelector, config)
   Charts redraw themselves on resize and on theme change.
   ========================================================================== */

const Mesa = (() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const registry = [];

  /* ---------- helpers ---------- */

  const el = (name, attrs = {}) => {
    const n = document.createElementNS(SVG, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const fmt = (v, opts = {}) => {
    const { currency = '', decimals = 0, compact = false, suffix = '' } = opts;
    let s;
    if (compact && Math.abs(v) >= 1000) {
      s = (v / 1000).toFixed(Math.abs(v) < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k';
    } else {
      s = v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    }
    return (currency ? currency + s : s) + suffix;
  };

  /* Pick ~5 round tick values covering [0, max]. */
  const ticks = (max, count = 5) => {
    if (max <= 0) return [0, 1];
    const raw = max / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    /* Always climb past max — otherwise the tallest mark renders above the
       plot area and escapes the card. */
    const out = [];
    for (let v = 0; ; v += step) {
      out.push(+v.toFixed(10));
      if (v >= max - step * 1e-9) break;
    }
    return out;
  };

  /* Ticks for a range that does NOT start at zero. Only for lines of averages,
     rates and indices, where the trend — not the absolute size — is the point.
     Never use this for bars: a bar's length must stay proportional to its value. */
  const ticksRange = (min, max, count = 5) => {
    if (!(max > min)) return ticks(max, count);
    const raw = (max - min) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    const lo = Math.floor(min / step) * step;
    const out = [];
    for (let v = lo; ; v += step) {
      out.push(+v.toFixed(10));
      if (v >= max - step * 1e-9) break;
    }
    return out;
  };

  /* Bar with rounded top corners, square foot on the baseline. */
  const barPath = (x, y, w, h, r = 4) => {
    const rr = Math.max(0, Math.min(r, w / 2, h));
    return `M${x},${y + h}V${y + rr}a${rr},${rr} 0 0 1 ${rr},${-rr}h${w - rr * 2}a${rr},${rr} 0 0 1 ${rr},${rr}V${y + h}Z`;
  };

  /* ---------- shared tooltip ---------- */

  let tipEl = null;
  const tip = {
    node() {
      if (!tipEl) {
        tipEl = document.createElement('div');
        tipEl.className = 'tip';
        tipEl.setAttribute('role', 'status');
        document.body.appendChild(tipEl);
      }
      return tipEl;
    },
    show(html, ev) {
      const n = this.node();
      n.innerHTML = html;
      n.classList.add('on');
      this.move(ev);
    },
    move(ev) {
      const n = this.node();
      const pad = 14;
      const r = n.getBoundingClientRect();
      let x = ev.clientX + pad;
      let y = ev.clientY - r.height - pad;
      if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
      if (y < 8) y = ev.clientY + pad;
      n.style.left = x + 'px';
      n.style.top = y + 'px';
    },
    hide() { if (tipEl) tipEl.classList.remove('on'); }
  };

  const tipRows = (rows, head) => {
    let h = head ? `<div class="t-head">${head}</div>` : '';
    rows.forEach(r => {
      h += `<div class="t-row">${r.color ? `<span class="t-sw" style="background:${r.color}"></span>` : ''}` +
           `<span class="t-name">${r.name}</span><span class="t-val">${r.value}</span></div>`;
    });
    return h;
  };

  /* ---------- mount / redraw plumbing ---------- */

  function mount(selector, draw) {
    const host = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!host) return null;
    const render = () => {
      const w = host.clientWidth;
      if (!w) return;
      host.innerHTML = '';
      const svg = draw(w);
      host.appendChild(svg);
      /* Anything that needs real text metrics runs here: getComputedTextLength()
         only answers once the node is in the document. */
      if (svg && svg.fitLabels) svg.fitLabels();
    };
    registry.push(render);
    render();
    return host;
  }

  let resizeTimer;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => registry.forEach(f => f()), 140);
  });

  /* ---------- line / area ---------- */

  function line(selector, cfg) {
    const {
      labels, series, height = 260, currency = '', compact = true,
      area = true, yTickCount = 5, decimals = 0, suffix = '',
      /* zeroBased:false — scale to the data instead of to zero, so a flat-looking
         trend of averages actually shows its movement.
         band:true     — shade the gap between the first two series; the gap itself
         is the story (e.g. how much more a seated guest spends than a delivery one).
         endLabels     — print the latest value at the end of each line.
         pointLabels   — one caption per point (e.g. a margin %), thinned out
         automatically when the points sit too close to label them all. */
      zeroBased = true, band = false, endLabels = false, pointLabels = null
    } = cfg;

    return mount(selector, (W) => {
      const pad = { t: pointLabels ? 26 : 14, r: endLabels ? 58 : 12, b: 26, l: 46 };
      const H = height;
      const iw = W - pad.l - pad.r;
      const ih = H - pad.t - pad.b;

      const all = series.flatMap(s => s.values);
      const max = Math.max(...all);
      const ty = zeroBased ? ticks(max, yTickCount)
                           : ticksRange(Math.min(...all), max, yTickCount);
      const top = ty[ty.length - 1];
      const base = ty[0];
      const span = top - base || 1;
      const X = i => pad.l + (labels.length === 1 ? iw / 2 : (iw * i) / (labels.length - 1));
      const Y = v => pad.t + ih - ((v - base) / span) * ih;

      const svg = el('svg', { class: 'chart', width: W, height: H, viewBox: `0 0 ${W} ${H}` });

      // gridlines + y ticks
      ty.forEach(v => {
        svg.appendChild(el('line', { class: 'grid-line', x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v) }));
        const t = el('text', { class: 'tick tick-y', x: pad.l - 9, y: Y(v) + 4 });
        t.textContent = fmt(v, { currency, compact, suffix });
        svg.appendChild(t);
      });

      // x ticks — thinned so labels never collide
      const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(iw / 68))));
      labels.forEach((lab, i) => {
        if (i % every && i !== labels.length - 1) return;
        const t = el('text', { class: 'tick tick-x', x: X(i), y: H - 7 });
        t.textContent = lab;
        svg.appendChild(t);
      });

      // gap between the first two series, drawn under the lines
      if (band && series.length >= 2) {
        const a = series[0].values, b = series[1].values;
        const dBand =
          a.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('') +
          b.map((v, i) => `L${X(b.length - 1 - i).toFixed(1)},${Y(b[b.length - 1 - i]).toFixed(1)}`).join('') + 'Z';
        svg.appendChild(el('path', {
          d: dBand, fill: css(series[0].color) || series[0].color, 'fill-opacity': .10
        }));
      }

      // series
      series.forEach(s => {
        const color = css(s.color) || s.color;
        const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
        if (area && series.length === 1) {
          const gid = 'g' + Math.random().toString(36).slice(2, 8);
          const defs = el('defs');
          const grad = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
          grad.appendChild(el('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': .20 }));
          grad.appendChild(el('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }));
          defs.appendChild(grad);
          svg.appendChild(defs);
          svg.appendChild(el('path', { d: `${d}L${X(labels.length - 1)},${pad.t + ih}L${X(0)},${pad.t + ih}Z`, fill: `url(#${gid})` }));
        }
        svg.appendChild(el('path', { class: 'series-line', d, stroke: color }));

        /* Latest value right where the line ends — reads without the legend. */
        if (endLabels) {
          const last = s.values.length - 1;
          svg.appendChild(el('circle', { r: 3.5, cx: X(last), cy: Y(s.values[last]), fill: color }));
          const t = el('text', { class: 'end-label', x: X(last) + 8, y: Y(s.values[last]) + 4, fill: color });
          t.textContent = fmt(s.values[last], { currency, decimals, suffix });
          svg.appendChild(t);
        }
      });

      /* Captions over the points of the first series. Thinned on the same rule as
         the x ticks, because a collided label is worse than no label. */
      if (pointLabels && series.length) {
        const vals = series[0].values;
        const step = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(iw / 56))));
        const idx = [];
        for (let i = 0; i < vals.length; i += step) idx.push(i);
        const lastI = vals.length - 1;
        if (idx[idx.length - 1] !== lastI) {
          /* The latest point always gets its caption; if the previous one is too
             close to keep as well, the latest takes its place rather than crowding it. */
          if (lastI - idx[idx.length - 1] < step) idx[idx.length - 1] = lastI;
          else idx.push(lastI);
        }
        idx.forEach(i => {
          const v = vals[i];
          const cap = pointLabels[i];
          if (cap == null) return;
          const above = Y(v) - 12 >= pad.t;
          /* The end points sit on the plot edges; centring their captions would
             push them over the axis labels, so they hug the edge instead. */
          const anchor = i === 0 ? 'start' : (i === vals.length - 1 ? 'end' : 'middle');
          const t = el('text', {
            class: 'value-label', x: X(i), y: above ? Y(v) - 12 : Y(v) + 20, 'text-anchor': anchor
          });
          t.textContent = cap;
          svg.appendChild(t);
        });
      }

      svg.appendChild(el('line', { class: 'axis-line', x1: pad.l, x2: W - pad.r, y1: pad.t + ih, y2: pad.t + ih }));

      // hover layer: crosshair + dots + tooltip
      const cross = el('line', { class: 'crosshair', y1: pad.t, y2: pad.t + ih, opacity: 0 });
      svg.appendChild(cross);
      const dots = series.map(s => {
        const c = el('circle', { class: 'dot', r: 4.5, fill: css(s.color) || s.color, opacity: 0 });
        svg.appendChild(c);
        return c;
      });

      const hit = el('rect', { class: 'hit', x: pad.l, y: pad.t, width: iw, height: ih });
      svg.appendChild(hit);

      const near = (ev) => {
        const r = svg.getBoundingClientRect();
        const rel = ((ev.clientX - r.left) / r.width) * W;
        const i = Math.round(((rel - pad.l) / iw) * (labels.length - 1));
        return Math.max(0, Math.min(labels.length - 1, i));
      };

      hit.addEventListener('mousemove', ev => {
        const i = near(ev);
        cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('opacity', 1);
        dots.forEach((c, k) => {
          c.setAttribute('cx', X(i)); c.setAttribute('cy', Y(series[k].values[i])); c.setAttribute('opacity', 1);
        });
        const rows = series.map(s => ({
          color: css(s.color) || s.color, name: s.name, value: fmt(s.values[i], { currency, decimals, suffix })
        }));
        if (band && series.length >= 2) {
          rows.push({
            name: 'Difference',
            value: fmt(series[0].values[i] - series[1].values[i], { currency, decimals, suffix })
          });
        }
        tip.show(tipRows(rows, labels[i]), ev);
      });
      hit.addEventListener('mouseleave', () => {
        cross.setAttribute('opacity', 0);
        dots.forEach(c => c.setAttribute('opacity', 0));
        tip.hide();
      });

      return svg;
    });
  }

  /* ---------- vertical bars (single, grouped or stacked) ---------- */

  function bars(selector, cfg) {
    const {
      labels, series, height = 260, currency = '', compact = true,
      stacked = false, yTickCount = 5, showPercent = false, suffix = '',
      /* topLabels — one ready-made caption per bar (e.g. a margin %). Takes
         precedence over showPercent, which can only state a share of the grand total. */
      topLabels = null
    } = cfg;

    return mount(selector, (W) => {
      const pad = { t: (showPercent || topLabels) ? 26 : 14, r: 12, b: 26, l: 46 };
      const H = height, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

      const totals = labels.map((_, i) =>
        stacked ? series.reduce((a, s) => a + s.values[i], 0) : Math.max(...series.map(s => s.values[i])));
      const ty = ticks(Math.max(...totals), yTickCount);
      const top = ty[ty.length - 1];
      const Y = v => pad.t + ih - (v / top) * ih;

      const slot = iw / labels.length;
      /* 46px is the cap for one bar. A grouped chart splits that width between its
         series, so the cap grows with them — otherwise the pair ends up as hairlines. */
      const capW = (stacked || series.length === 1) ? 46 : 46 * series.length;
      const bw = Math.min(capW, slot * 0.62);
      const gw = stacked ? bw : bw / series.length;

      /* Share-of-total labels. Which ones survive is decided after mount, by
         measuring them — see fitLabels below. A collided label is worse than
         no label. */
      const grand = totals.reduce((a, b) => a + b, 0) || 1;

      const svg = el('svg', { class: 'chart', width: W, height: H, viewBox: `0 0 ${W} ${H}` });

      ty.forEach(v => {
        svg.appendChild(el('line', { class: 'grid-line', x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v) }));
        const t = el('text', { class: 'tick tick-y', x: pad.l - 9, y: Y(v) + 4 });
        t.textContent = fmt(v, { currency, compact, suffix });
        svg.appendChild(t);
      });

      const caps = [];

      labels.forEach((lab, i) => {
        const cx = pad.l + slot * i + slot / 2;

        if (stacked) {
          let acc = 0;
          series.forEach((s, k) => {
            const v = s.values[i];
            const y0 = Y(acc), y1 = Y(acc + v);
            const h = Math.max(0, y0 - y1);
            const isTop = k === series.length - 1;
            const node = isTop
              ? el('path', { class: 'bar-seg', d: barPath(cx - bw / 2, y1, bw, h, 4), fill: css(s.color) || s.color })
              : el('rect', { class: 'bar-seg', x: cx - bw / 2, y: y1, width: bw, height: h, fill: css(s.color) || s.color });
            node.style.cursor = 'pointer';
            node.addEventListener('mousemove', ev => tip.show(tipRows(
              series.map(ss => ({ color: css(ss.color) || ss.color, name: ss.name, value: fmt(ss.values[i], { currency, suffix }) })),
              lab), ev));
            node.addEventListener('mouseleave', tip.hide);
            svg.appendChild(node);
            acc += v;
          });
        } else {
          series.forEach((s, k) => {
            const v = s.values[i];
            const x = cx - bw / 2 + gw * k + (series.length > 1 ? 1 : 0);
            const w = gw - (series.length > 1 ? 2 : 0);
            const node = el('path', { class: 'bar', d: barPath(x, Y(v), w, pad.t + ih - Y(v), 4), fill: css(s.color) || s.color });
            node.style.cursor = 'pointer';
            node.addEventListener('mousemove', ev => tip.show(tipRows(
              [{ color: css(s.color) || s.color, name: s.name, value: fmt(v, { currency, suffix }) }], lab), ev));
            node.addEventListener('mouseleave', tip.hide);
            svg.appendChild(node);
          });
        }

        const cap = topLabels ? topLabels[i] : (showPercent ? Math.round((totals[i] / grand) * 100) + '%' : null);
        if (cap != null) {
          const p = el('text', { class: 'value-label', x: cx, y: Y(totals[i]) - 8, 'text-anchor': 'middle' });
          p.textContent = cap;
          svg.appendChild(p);
          caps.push(p);
        }

        const t = el('text', { class: 'tick tick-x', x: cx, y: H - 7 });
        t.textContent = lab;
        svg.appendChild(t);
      });

      svg.appendChild(el('line', { class: 'axis-line', x1: pad.l, x2: W - pad.r, y1: pad.t + ih, y2: pad.t + ih }));

      /* A slot-width threshold only knows how much room there is, not how wide
         the label came out: a topLabel like "Truffle tagliatelle" clears any
         threshold and still runs into its neighbour. Once the chart is in the
         document the browser can measure the text it actually drew, so keep
         what fits and drop the rest. */
      svg.fitLabels = () => {
        caps.forEach(p => {
          const tw = p.getComputedTextLength ? p.getComputedTextLength() : 0;
          /* tw === 0 means the browser could not measure — no layout yet, or a
             renderer without the API. Fall back to the old slot test rather
             than keep a label blindly. */
          const fits = tw ? tw <= slot - 6 : slot >= 34;
          if (!fits) p.remove();
        });
      };

      return svg;
    });
  }

  /* ---------- timeline ----------------------------------------------------
     One row per thing, a bar spanning the interval between two dates, and a
     line for today. For a service schedule this answers all four questions at
     once: when it was done, when it falls due, how long the gap is, and how
     much of that gap is already spent.                                      */

  function timeline(selector, cfg) {
    const {
      items, today, rowH = 24, gap = 16, gutter = 128, padR = 74, markerLabel = 'today'
    } = cfg;

    const day = 86400000;
    const parse = d => new Date(d + 'T00:00:00').getTime();
    const fmtDate = t => {
      const d = new Date(t);
      return d.getDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    };

    return mount(selector, (W) => {
      const H = items.length * (rowH + gap) + gap + 26;
      const trackW = W - gutter - padR;

      const from = Math.min(...items.map(i => parse(i.from)));
      const to = Math.max(...items.map(i => parse(i.to)));
      const span = (to - from) || day;
      const X = t => gutter + ((t - from) / span) * trackW;
      const nowT = parse(today);

      const svg = el('svg', { class: 'chart', width: W, height: H, viewBox: `0 0 ${W} ${H}` });

      /* month gridlines, thinned so the labels never touch */
      const marks = [];
      const cur = new Date(from); cur.setDate(1);
      while (cur.getTime() <= to) { marks.push(new Date(cur).getTime()); cur.setMonth(cur.getMonth() + 1); }
      const every = Math.max(1, Math.ceil(marks.length / Math.max(2, Math.floor(trackW / 56))));
      marks.forEach((t, i) => {
        if (t < from) return;
        svg.appendChild(el('line', { class: 'grid-line', x1: X(t), x2: X(t), y1: 6, y2: H - 24 }));
        if (i % every) return;
        const lab = el('text', { class: 'tick tick-x', x: X(t), y: H - 7 });
        lab.textContent = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][new Date(t).getMonth()];
        svg.appendChild(lab);
      });

      items.forEach((it, i) => {
        const y = gap + i * (rowH + gap);
        const a = parse(it.from), b = parse(it.to);
        const color = css(it.color) || it.color || css('--s1');

        const name = el('text', {
          x: gutter - 12, y: y + rowH / 2 + 4, 'text-anchor': 'end',
          fill: css('--mc-ink'), 'font-size': 13, 'font-weight': 550
        });
        name.textContent = it.name;
        svg.appendChild(name);

        /* the whole interval, faint */
        svg.appendChild(el('rect', {
          x: X(a), y: y + rowH / 2 - 4, width: Math.max(2, X(b) - X(a)), height: 8,
          rx: 4, fill: color, 'fill-opacity': .22
        }));
        /* the part already spent, solid — it stops at today, or at the due date
           when that has passed, so an overdue row reads as a full bar */
        const spentTo = Math.min(Math.max(nowT, a), Math.max(b, a));
        if (spentTo > a) {
          svg.appendChild(el('rect', {
            x: X(a), y: y + rowH / 2 - 4, width: Math.max(2, X(spentTo) - X(a)), height: 8,
            rx: 4, fill: color
          }));
        }
        /* endpoints: the check that was done, and the one that is due */
        svg.appendChild(el('circle', { cx: X(a), cy: y + rowH / 2, r: 4, fill: color }));
        svg.appendChild(el('circle', {
          cx: X(b), cy: y + rowH / 2, r: 4.5, fill: css('--mc-surface'), stroke: color, 'stroke-width': 2
        }));

        const due = el('text', {
          x: X(b) + 10, y: y + rowH / 2 + 4,
          fill: css('--mc-ink-2'), 'font-size': 12, 'font-weight': 650
        });
        due.textContent = fmtDate(b);
        svg.appendChild(due);

        const hit = el('rect', { class: 'hit', x: gutter, y, width: trackW, height: rowH });
        hit.addEventListener('mousemove', ev => tip.show(tipRows([
          { color, name: 'Last check', value: fmtDate(a) },
          { name: 'Next check', value: fmtDate(b) },
          { name: 'Interval', value: Math.round((b - a) / day) + ' days' },
          { name: nowT > b ? 'Overdue by' : 'Due in',
            value: Math.abs(Math.round((b - nowT) / day)) + ' days' }
        ], it.name), ev));
        hit.addEventListener('mouseleave', tip.hide);
        svg.appendChild(hit);
      });

      /* today */
      if (nowT >= from && nowT <= to) {
        svg.appendChild(el('line', { class: 'tl-now', x1: X(nowT), x2: X(nowT), y1: 2, y2: H - 26 }));
        const t = el('text', {
          x: X(nowT), y: 10, 'text-anchor': 'middle',
          fill: css('--mc-ink-2'), 'font-size': 11, 'font-weight': 650
        });
        t.textContent = markerLabel;
        svg.appendChild(t);
      }

      return svg;
    });
  }

  /* ---------- waterfall ---------------------------------------------------
     The shape of a P&L: start at revenue, subtract each cost as a floating bar,
     land on the result. Reading it you see both what each line costs and what is
     still left after it — a stacked bar shows only one of those.                */

  function waterfall(selector, cfg) {
    const {
      items, currency = '', height = 320, compact = true,
      yTickCount = 5, showValues = true
    } = cfg;

    return mount(selector, (W) => {
      const pad = { t: 26, r: 12, b: 42, l: 54 };
      const H = height, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

      /* walk the sequence once to find every bar's foot and head */
      let run = 0;
      const geom = items.map(it => {
        const total = it.type === 'start' || it.type === 'total';
        const from = total ? 0 : run;
        const to = total ? it.value : run + it.value;
        if (!total) run = to; else run = it.value;
        return { from, to, lo: Math.min(from, to), hi: Math.max(from, to) };
      });

      const ty = ticks(Math.max(...geom.map(g => g.hi)), yTickCount);
      const top = ty[ty.length - 1];
      const Y = v => pad.t + ih - (v / top) * ih;

      const slot = iw / items.length;
      const bw = Math.min(58, slot * 0.58);

      const svg = el('svg', { class: 'chart', width: W, height: H, viewBox: `0 0 ${W} ${H}` });

      ty.forEach(v => {
        svg.appendChild(el('line', { class: 'grid-line', x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v) }));
        const t = el('text', { class: 'tick tick-y', x: pad.l - 9, y: Y(v) + 4 });
        t.textContent = fmt(v, { currency, compact });
        svg.appendChild(t);
      });

      items.forEach((it, i) => {
        const g = geom[i];
        const cx = pad.l + slot * i + slot / 2;
        const x = cx - bw / 2;
        const y = Y(g.hi), h = Math.max(1, Y(g.lo) - Y(g.hi));
        const fallback = it.type === 'start' ? '--s1' : (it.type === 'total' ? '--s3' : '--s4');
        const color = css(it.color || fallback) || it.color || fallback;

        /* connector from the previous bar's head to this one's foot */
        if (i > 0) {
          const prev = geom[i - 1];
          const yc = Y(it.type === 'total' ? prev.to : g.from);
          svg.appendChild(el('line', {
            class: 'wf-link', x1: pad.l + slot * (i - 1) + slot / 2 + bw / 2,
            x2: x, y1: yc, y2: yc
          }));
        }

        const node = el('path', { class: 'bar', d: barPath(x, y, bw, h, 4), fill: color });
        node.style.cursor = 'pointer';
        node.addEventListener('mousemove', ev => tip.show(tipRows(
          [{ color, name: it.name,
             value: (it.value < 0 ? '−' : '') + fmt(Math.abs(it.value), { currency }) },
           { name: it.type === 'delta' ? 'Left after this' : 'Share of revenue',
             value: it.type === 'delta'
               ? fmt(g.to, { currency })
               : Math.round(g.to / geom[0].to * 100) + '%' }],
          it.name), ev));
        node.addEventListener('mouseleave', tip.hide);
        svg.appendChild(node);

        if (showValues && slot >= 44) {
          const t = el('text', { class: 'value-label', x: cx, y: y - 8, 'text-anchor': 'middle' });
          /* the sign belongs in front of the whole figure, not between the
             currency symbol and the digits: minus-euro-71k, never euro-minus-71k */
          t.textContent = (it.value < 0 ? '−' : '') + fmt(Math.abs(it.value), { currency, compact });
          svg.appendChild(t);
        }

        /* category labels wrap to a second line so long ones stay readable */
        const words = String(it.name).split(' ');
        const lines = words.length > 1 && slot < 96
          ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')]
          : [it.name];
        lines.forEach((ln, k) => {
          const t = el('text', { class: 'tick tick-x', x: cx, y: H - 24 + k * 13 });
          t.textContent = ln;
          svg.appendChild(t);
        });
      });

      svg.appendChild(el('line', { class: 'axis-line', x1: pad.l, x2: W - pad.r, y1: pad.t + ih, y2: pad.t + ih }));
      return svg;
    });
  }

  /* ---------- horizontal stacked bars ------------------------------------
     One row per label, split by series. Shows volume and composition at once,
     which a column chart of the same data cannot.                          */

  function barsH(selector, cfg) {
    const {
      labels, series, currency = '', rowH = 30, gap = 16,
      gutter = 92, showTotal = true,
      /* rowLabels — what to print at the end of each row instead of its total
         (e.g. a margin %); rowNote adds a second, quieter line under it. */
      rowLabels = null, rowNote = null
    } = cfg;

    /* Segment with rounded outer ends only, so the row reads as one bar. */
    const seg = (x, y, w, h, rl, rr) => {
      const l = Math.min(rl, w / 2, h / 2), r = Math.min(rr, w / 2, h / 2);
      return `M${x + l},${y}h${w - l - r}${r ? `a${r},${r} 0 0 1 ${r},${r}` : ''}` +
             `v${h - r * 2}${r ? `a${r},${r} 0 0 1 ${-r},${r}` : ''}` +
             `h${-(w - l - r)}${l ? `a${l},${l} 0 0 1 ${-l},${-l}` : ''}` +
             `v${-(h - l * 2)}${l ? `a${l},${l} 0 0 1 ${l},${-l}` : ''}Z`;
    };

    return mount(selector, (W) => {
      /* the note under the row label is the widest thing on the right,
         so it, not the figure, decides how much room the track gives up */
      const padR = showTotal ? (rowNote ? 112 : 58) : 10;
      const H = labels.length * (rowH + gap) + gap;
      const trackW = W - gutter - padR;
      const totals = labels.map((_, i) => series.reduce((a, s) => a + s.values[i], 0));
      const max = Math.max(...totals) || 1;

      const svg = el('svg', { class: 'chart', width: W, height: H, viewBox: `0 0 ${W} ${H}` });

      labels.forEach((lab, i) => {
        const y = gap + i * (rowH + gap);

        const t = el('text', {
          x: gutter - 12, y: y + rowH / 2 + 4, 'text-anchor': 'end',
          fill: css('--mc-ink'), 'font-size': 13, 'font-weight': 550
        });
        t.textContent = lab;
        svg.appendChild(t);

        const full = (totals[i] / max) * trackW;
        let x = gutter;
        series.forEach((s, k) => {
          const v = s.values[i];
          const w = (v / totals[i]) * full;
          if (w <= 0) return;
          const first = k === 0, last = k === series.length - 1;
          const node = el('path', {
            class: 'bar-seg',
            d: seg(x, y, Math.max(w, 1), rowH, first ? 5 : 0, last ? 5 : 0),
            fill: css(s.color) || s.color
          });
          node.style.cursor = 'pointer';
          node.addEventListener('mousemove', ev => tip.show(tipRows(
            series.map(ss => ({
              color: css(ss.color) || ss.color, name: ss.name,
              value: `${fmt(ss.values[i], { currency })} · ${Math.round((ss.values[i] / totals[i]) * 100)}%`
            })), `${lab} — ${fmt(totals[i], { currency })}`), ev));
          node.addEventListener('mouseleave', tip.hide);
          svg.appendChild(node);
          x += w;
        });

        if (showTotal) {
          const note = rowNote ? rowNote[i] : null;
          const n = el('text', {
            x: gutter + full + 10, y: y + rowH / 2 + (note ? -1 : 4),
            fill: css('--mc-ink-2'), 'font-size': 12.5, 'font-weight': 650
          });
          n.textContent = rowLabels ? rowLabels[i] : fmt(totals[i], { currency });
          svg.appendChild(n);
          if (note) {
            const n2 = el('text', {
              x: gutter + full + 10, y: y + rowH / 2 + 13,
              fill: css('--mc-muted'), 'font-size': 11
            });
            n2.textContent = note;
            svg.appendChild(n2);
          }
        }
      });

      return svg;
    });
  }

  /* ---------- donut ---------- */

  function donut(selector, cfg) {
    const { items, height = 220, currency = '', centerLabel = '' } = cfg;

    return mount(selector, (W) => {
      const H = height;
      const cx = W / 2, cy = H / 2;
      const R = Math.min(W, H) / 2 - 6;
      const r = R * 0.62;
      const total = items.reduce((a, d) => a + d.value, 0) || 1;

      const svg = el('svg', { class: 'chart', width: W, height: H, viewBox: `0 0 ${W} ${H}` });
      let ang = -Math.PI / 2;
      const GAP = 0.018; // ~2px surface gap between slices

      items.forEach(d => {
        const sweep = (d.value / total) * Math.PI * 2;
        const a0 = ang + GAP / 2, a1 = ang + sweep - GAP / 2;
        if (a1 > a0) {
          const big = sweep > Math.PI ? 1 : 0;
          const p = el('path', {
            d: `M${cx + R * Math.cos(a0)},${cy + R * Math.sin(a0)}` +
               `A${R},${R} 0 ${big} 1 ${cx + R * Math.cos(a1)},${cy + R * Math.sin(a1)}` +
               `L${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)}` +
               `A${r},${r} 0 ${big} 0 ${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)}Z`,
            fill: css(d.color) || d.color
          });
          p.style.cursor = 'pointer';
          p.addEventListener('mousemove', ev => tip.show(tipRows(
            [{ color: css(d.color) || d.color, name: d.name,
               value: `${fmt(d.value, { currency })} · ${Math.round((d.value / total) * 100)}%` }]), ev));
          p.addEventListener('mouseleave', tip.hide);
          svg.appendChild(p);

          /* Share label on the slice. Skipped on slivers, where it would not fit. */
          const share = Math.round((d.value / total) * 100);
          if (share >= 6) {
            const mid = (a0 + a1) / 2;
            const rr = (R + r) / 2;
            const t = el('text', {
              x: cx + rr * Math.cos(mid), y: cy + rr * Math.sin(mid) + 4,
              'text-anchor': 'middle', fill: '#ffffff',
              'font-size': 12.5, 'font-weight': 650, 'pointer-events': 'none'
            });
            t.textContent = share + '%';
            svg.appendChild(t);
          }
        }
        ang += sweep;
      });

      if (centerLabel) {
        const a = el('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', fill: css('--mc-ink'), 'font-size': 22, 'font-weight': 680 });
        a.textContent = centerLabel;
        svg.appendChild(a);
        const b = el('text', { x: cx, y: cy + 17, 'text-anchor': 'middle', fill: css('--mc-muted'), 'font-size': 11.5 });
        b.textContent = cfg.centerSub || '';
        svg.appendChild(b);
      }
      return svg;
    });
  }

  /* ---------- sparkline (no axes, no hover — it is a tile ornament) ---------- */

  function spark(selector, cfg) {
    const { values, color = '--s1', height = 38 } = cfg;
    return mount(selector, (W) => {
      const H = height, p = 3;
      const min = Math.min(...values), max = Math.max(...values);
      const span = max - min || 1;
      const X = i => (W * i) / (values.length - 1);
      const Y = v => p + (H - p * 2) - ((v - min) / span) * (H - p * 2);
      const c = css(color) || color;
      const svg = el('svg', { class: 'chart', width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
      const d = values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
      svg.appendChild(el('path', { d: `${d}L${W},${H}L0,${H}Z`, fill: c, opacity: .12 }));
      svg.appendChild(el('path', { class: 'series-line', d, stroke: c }));
      svg.appendChild(el('circle', { class: 'dot', cx: X(values.length - 1), cy: Y(values[values.length - 1]), r: 3.5, fill: c }));
      return svg;
    });
  }

  /* ---------- scatter (menu engineering: popularity × margin) ------------ */

  function scatter(selector, cfg) {
    const {
      points, height = 320, xLabel = '', yLabel = '',
      xMid = null, yMid = null, quadrants = null, currency = ''
    } = cfg;

    return mount(selector, (W) => {
      const pad = { t: 16, r: 16, b: 38, l: 52 };
      const H = height, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

      const xs = points.map(p => p.x), ys = points.map(p => p.y);
      const xMax = ticks(Math.max(...xs))[ticks(Math.max(...xs)).length - 1];
      const yMax = ticks(Math.max(...ys))[ticks(Math.max(...ys)).length - 1];
      const X = v => pad.l + (v / xMax) * iw;
      const Y = v => pad.t + ih - (v / yMax) * ih;

      const svg = el('svg', { class: 'chart', width: W, height: H, viewBox: `0 0 ${W} ${H}` });

      ticks(yMax).forEach(v => {
        svg.appendChild(el('line', { class: 'grid-line', x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v) }));
        const t = el('text', { class: 'tick tick-y', x: pad.l - 9, y: Y(v) + 4 });
        t.textContent = fmt(v, { compact: true });
        svg.appendChild(t);
      });
      ticks(xMax).forEach(v => {
        const t = el('text', { class: 'tick tick-x', x: X(v), y: H - 16 });
        t.textContent = fmt(v, { compact: true });
        svg.appendChild(t);
      });

      // quadrant dividers — the median lines that split stars from dogs
      if (xMid !== null) svg.appendChild(el('line', { class: 'crosshair', x1: X(xMid), x2: X(xMid), y1: pad.t, y2: pad.t + ih, opacity: .8 }));
      if (yMid !== null) svg.appendChild(el('line', { class: 'crosshair', x1: pad.l, x2: W - pad.r, y1: Y(yMid), y2: Y(yMid), opacity: .8 }));

      if (quadrants) {
        const place = [
          { x: W - pad.r - 8, y: pad.t + 14, a: 'end',   t: quadrants[0] },
          { x: pad.l + 8,     y: pad.t + 14, a: 'start', t: quadrants[1] },
          { x: pad.l + 8,     y: pad.t + ih - 8, a: 'start', t: quadrants[2] },
          { x: W - pad.r - 8, y: pad.t + ih - 8, a: 'end',   t: quadrants[3] }
        ];
        place.forEach(q => {
          const n = el('text', { x: q.x, y: q.y, 'text-anchor': q.a, fill: css('--mc-muted'), 'font-size': 11, 'font-weight': 650, 'letter-spacing': '.06em' });
          n.textContent = q.t.toUpperCase();
          svg.appendChild(n);
        });
      }

      points.forEach(p => {
        const c = css(p.color || '--s1') || p.color;
        const g = el('g');
        g.style.cursor = 'pointer';
        g.appendChild(el('circle', { class: 'dot', cx: X(p.x), cy: Y(p.y), r: 7, fill: c }));
        g.addEventListener('mousemove', ev => tip.show(tipRows([
          { name: xLabel, value: fmt(p.x) },
          { name: yLabel, value: fmt(p.y, { currency }) }
        ], p.name), ev));
        g.addEventListener('mouseleave', tip.hide);
        svg.appendChild(g);
      });

      svg.appendChild(el('line', { class: 'axis-line', x1: pad.l, x2: W - pad.r, y1: pad.t + ih, y2: pad.t + ih }));

      const xl = el('text', { x: pad.l + iw / 2, y: H - 2, 'text-anchor': 'middle', fill: css('--mc-muted'), 'font-size': 11 });
      xl.textContent = xLabel;
      svg.appendChild(xl);
      const yl = el('text', { x: 12, y: pad.t + ih / 2, 'text-anchor': 'middle', fill: css('--mc-muted'), 'font-size': 11, transform: `rotate(-90 12 ${pad.t + ih / 2})` });
      yl.textContent = yLabel;
      svg.appendChild(yl);

      return svg;
    });
  }

  /* ---------- horizontal ranked bars (built from HTML, not SVG) ---------- */

  function ranked(selector, cfg) {
    /* An item may carry its own colour — that is how a stock list shows which
       lines are running out without needing a second chart beside it. */
    const { items, currency = '', color = '--s1', suffix = '', decimals = 0, note = null } = cfg;
    const host = document.querySelector(selector);
    if (!host) return;
    const max = Math.max(...items.map(i => i.value)) || 1;
    host.className = 'ranked';
    host.innerHTML = items.map(i => `
      <div class="item">
        <span class="name">${i.name}${note && i.note ? `<em>${i.note}</em>` : ''}</span>
        <span class="val">${fmt(i.value, { currency, suffix, decimals })}</span>
        <span class="meter"><span style="width:${(i.value / max) * 100}%;background:var(${i.color || color})"></span></span>
      </div>`).join('');
  }

  /* ---------- redraw everything (theme switch) ---------- */

  const redrawAll = () => registry.forEach(f => f());


  /* ---------- heatmap, legend, trend rows ----------
     HTML rather than SVG: a grid of divs and a few spans beat hand-built
     <rect>s here, and they reflow on their own.                          */

  /* Hours × weekday heatmap. Sequential ramp, one hue, light → dark. */
  function heatmap(sel, { hours, days, values, unit = 'orders' }) {
    const host = document.querySelector(sel);
    if (!host) return;
    const flat = values.flat();
    const max = Math.max(...flat);
    const steps = ['--q1', '--q2', '--q3', '--q4', '--q5', '--q6', '--q7', '--q8'];
    const stepOf = v => steps[Math.min(steps.length - 1, Math.floor((v / max) * steps.length))];

    let html = '<div class="heat-grid">';
    html += '<span></span>' + hours.map(h => `<span class="heat-lab" style="text-align:center">${h}</span>`).join('');
    days.forEach((d, r) => {
      html += `<span class="heat-lab">${d}</span>`;
      hours.forEach((h, c) => {
        const v = values[r][c];
        html += `<span class="heat-cell" style="background:var(${stepOf(v)})" data-v="${v}" data-d="${d}" data-h="${h}"></span>`;
      });
    });
    html += '</div>';
    html += `<div class="heat-scale"><span>Quiet</span><span class="steps">` +
            steps.map(s => `<i style="background:var(${s})"></i>`).join('') +
            `</span><span>Busy · up to ${max} ${unit}</span></div>`;
    host.innerHTML = html;

    host.querySelectorAll('.heat-cell').forEach(cell => {
      cell.addEventListener('mousemove', ev => tip.show(
        `<div class="t-head">${cell.dataset.d}, ${cell.dataset.h}:00</div>` +
        `<div class="t-row"><span class="t-name">Orders</span><span class="t-val">${cell.dataset.v}</span></div>`, ev));
      cell.addEventListener('mouseleave', () => tip.hide());
    });
  }

  /* Legend for charts with two or more series */
  function legend(sel, series) {
    const host = document.querySelector(sel);
    if (!host) return;
    host.className = 'legend';
    host.innerHTML = series.map(s =>
      `<span class="legend-item"><span class="legend-swatch" style="background:var(${s.color})"></span>${s.name}</span>`).join('');
  }

  /* Trend rows — one line per series, each sparkline on its OWN scale.
     Two series at different levels (a €49 check and a €33 one) squash each other
     on a shared axis; split into small multiples and both trends read at a glance.
     Pass derived:true for a computed row (e.g. the gap) to set it apart. */
  function trendRows(sel, { rows, currency = '', decimals = 2 }) {
    const host = document.querySelector(sel);
    if (!host) return;
    host.className = 'trend';
    host.innerHTML = rows.map((r, i) => {
      const now = r.values[r.values.length - 1];
      const was = r.values[0];
      const pct = was ? ((now - was) / was) * 100 : 0;
      const up = pct >= 0;
      const arrow = up
        ? '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>';
      return `<div class="trend-row${r.derived ? ' is-derived' : ''}">
          <span class="t-key">${r.color ? `<i style="background:var(${r.color})"></i>` : ''}${r.name}</span>
          <span class="t-now">${currency}${now.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</span>
          <span class="t-spark" id="${sel.replace('#', '')}-s${i}"></span>
          <span class="delta ${up ? 'up' : 'down'}">${arrow}${up ? '+' : ''}${pct.toFixed(1)}%</span>
        </div>`;
    }).join('');
    rows.forEach((r, i) => {
      spark(`#${sel.replace('#', '')}-s${i}`, {
        values: r.values, color: r.color || '--mc-muted', height: 34
      });
    });
  }

  return {
    line, bars, barsH, waterfall, timeline, donut, spark, scatter, ranked,
    heatmap, legend, trendRows,
    redrawAll, fmt, tip
  };
})();

/* UMD-ish tail: works as a <script> tag, a CommonJS require or an ES import. */
if (typeof module !== 'undefined' && module.exports) module.exports = Mesa;
