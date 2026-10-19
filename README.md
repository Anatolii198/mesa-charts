# Mesa Charts

Eleven chart types in one file. No dependencies, no build step, no CDN — drop in a
`<script>` tag and a stylesheet and you are drawing.

**[Live demo — every chart type on one page](https://anatolii198.github.io/mesa-charts/)**

```
mesa-charts.js    41 KB   the engine
mesa-charts.css   11 KB   tokens + styles
```

No npm install, no bundler, no framework. It runs from a file on disk, on an air-gapped
machine, inside a CMS template — anywhere a `<script>` tag runs.

---

## Install

Copy the two files into your project:

```html
<link rel="stylesheet" href="mesa-charts.css">
<script src="mesa-charts.js"></script>
```

That is the whole setup. `Mesa` is now a global.

---

## Use

Every chart takes a CSS selector and a config object:

```js
Mesa.line('#revenue', {
  labels: ['1 Sep', '2 Sep', '3 Sep'],
  series: [{ name: 'Revenue', color: '--s1', values: [6800, 7250, 7900] }],
  currency: '€'
});
```

`color` is the **name of a CSS custom property**, not a hex value. That is what makes the
light/dark switch work: the engine re-reads the variable at draw time, so one call to
`Mesa.redrawAll()` repaints every chart in the new theme.

---

## The eleven types

| Call | What it draws |
|---|---|
| `Mesa.line` | line or area, one or more series, optional end labels and a shaded band between the first two |
| `Mesa.bars` | vertical bars — single, grouped or stacked, with optional share labels |
| `Mesa.barsH` | horizontal stacked bars: volume and composition at once |
| `Mesa.waterfall` | start → deltas → total; shows what each line costs *and* what is left |
| `Mesa.timeline` | one row per item, a bar between two dates, a marker for today |
| `Mesa.donut` | donut with a centre label; share labels skipped on slivers |
| `Mesa.spark` | sparkline — no axes, no labels, just the shape |
| `Mesa.scatter` | scatter with optional quadrants and their own labels |
| `Mesa.ranked` | ranked bar list (HTML, not SVG), each row can carry its own colour |
| `Mesa.trendRows` | small multiples: one row per series, each on its **own** scale |
| `Mesa.heatmap` | two-dimensional grid on a single-hue sequential ramp |

Plus `Mesa.legend` for the legend, `Mesa.fmt` for number formatting, and `Mesa.tip` if you
want the tooltip on something of your own.

Every chart has a hover tooltip, redraws on resize (debounced), and re-reads its colours on
`Mesa.redrawAll()`.

---

## Examples

**Stacked bars with share labels**

```js
Mesa.bars('#by-day', {
  labels: ['Mon', 'Tue', 'Wed'],
  series: [
    { name: 'Dine-in',  color: '--s1', values: [3600, 3900, 4100] },
    { name: 'Delivery', color: '--s2', values: [1900, 2100, 2200] }
  ],
  stacked: true, showPercent: true, currency: '€'
});
Mesa.legend('#by-day-legend', [
  { name: 'Dine-in', color: '--s1' }, { name: 'Delivery', color: '--s2' }
]);
```

**Waterfall**

```js
Mesa.waterfall('#pl', {
  currency: '€',
  items: [
    { name: 'Revenue',   type: 'start', value:  227300 },
    { name: 'Food cost', type: 'delta', value:  -68200 },
    { name: 'Labour',    type: 'delta', value:  -61400 },
    { name: 'Profit',    type: 'total', value:   97700 }
  ]
});
```

**Timeline**

```js
Mesa.timeline('#service', {
  today: '2026-09-30',
  items: [
    { name: 'Walk-in fridge', from: '2026-08-20', to: '2026-10-05', color: '--s8' },
    { name: 'Dishwasher',     from: '2026-06-15', to: '2026-12-15', color: '--s3' }
  ]
});
```

**Trend rows** — for two series at different levels, where a shared axis flattens both:

```js
Mesa.trendRows('#check', {
  currency: '€', decimals: 2,
  rows: [
    { name: 'Dine-in',  color: '--s1', values: dine },
    { name: 'Delivery', color: '--s2', values: delivery },
    { name: 'Gap', values: gap, derived: true }
  ]
});
```

---

## Theming

Colours live in `mesa-charts.css` as custom properties. Two groups:

**Chrome** — prefixed, so they cannot collide with your own tokens:

```css
--mc-surface  --mc-ink  --mc-ink-2  --mc-muted  --mc-grid  --mc-axis
--mc-line  --mc-line-2  --mc-wash  --mc-good  --mc-critical  --mc-sans
```

**Palette** — short names on purpose, because this is the public API, the thing you pass as
`color`:

```css
--s1 … --s8    categorical series
--q1 … --q8    sequential ramp (heatmaps)
```

Override any of them in your own stylesheet and the charts follow.

Dark mode is a separate set of values, not an inversion: the series hues are re-picked
against a dark surface so contrast survives. It follows `prefers-color-scheme` and can be
forced with `data-theme="dark"` / `"light"` on `<html>`. After changing the theme, call:

```js
Mesa.redrawAll();
```

---

## About the colours

The eight categorical steps are validated so that every **adjacent** pair stays
distinguishable under deuteranopia, protanopia and tritanopia (OKLab ΔE ≥ 8).

Three rules the engine sticks to, and that are worth keeping if you swap the palette:

- **Assign in order, never cycle.** A series keeps its colour when a filter removes its
  neighbour. A ninth series means "Other", small multiples, or a second chart — not a
  generated hue.
- **Sequential means one hue, light to dark.** Never a rainbow.
- **Status colours are reserved** and always ship with a label or an icon. If the only thing
  marking a row as critical is that it is red, a meaningful slice of your users sees an
  unmarked row.

---

## Design decisions worth knowing

**Axes start at zero by default.** `Mesa.line` takes `zeroBased: false` for averages, rates
and indices, where the trend rather than the absolute size is the point. Bars never get it —
a bar's length has to stay proportional to its value.

**Labels disappear before they collide.** A caption above a bar is dropped when its column
is narrower than 34 px; a share label on a donut is dropped on slices under 6 %. A collided
label is worse than no label.

**One tooltip for the whole page**, created lazily and moved around, rather than one node
per chart. It flips itself when it would run off the right edge.

**No animation on first paint.** Charts appear with the page. `prefers-reduced-motion` is
respected where motion exists.

There is a longer write-up of the thinking behind the axis code here:
[Nine chart types in 878 lines of SVG, and what I kept getting wrong about axes](https://dev.to/anatolii198/nine-chart-types-in-878-lines-of-svg-and-what-i-kept-getting-wrong-about-axes-1jc9)

---

## When not to use this

Mostly, use a library.

If you need zoom, brushing, animated transitions, a time axis that handles daylight saving,
or a hundred thousand points, reach for D3, ECharts or Chart.js. That work is enormous and
it is already done.

This is for the case where the deliverable must run with no network and no build step, you
need a handful of chart types rather than a general-purpose grammar, and you want to be able
to read every line that renders your numbers.

---

## Browser support

Current Chrome, Edge, Firefox and Safari, desktop and mobile. No polyfills, no transpiling.

## Where it comes from

This engine was written for **Mesa**, a restaurant analytics dashboard template.
If you want the dashboard rather than the engine:
[free two-page cut](https://github.com/Anatolii198/mesa-lite) ·
[full twelve-page version](https://mesa-dashboard-demo.netlify.app)

## License

MIT — see [LICENSE](LICENSE). Use it in personal and commercial projects.
