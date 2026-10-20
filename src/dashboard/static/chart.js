// The price chart: TradingView Lightweight Charts (vendored, Apache 2.0, attribution logo on) with candles, a volume
// strip and a crosshair. Colours come from the stylesheet's root variables so both themes stay in one place.
import { createChart, CandlestickSeries, HistogramSeries, ColorType, CrosshairMode, LineStyle } from './vendor/lightweight-charts.mjs';
import { tail, intervalSeconds } from './candles.js';

const RIGHT_OFFSET = 3, BAR_SPACING = 8, OLDER_AT = 50;
const faded = (hex, alpha) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})` : hex;
};

// Local time for intraday candles; candles of a day or longer start at 00:00 UTC, so their dates are read in UTC.
function timeText(interval) {
  const utc = intervalSeconds(interval) >= 86400 ? { timeZone: 'UTC' } : {};
  return {
    tick: (t, type) => {
      const d = new Date(t * 1000);
      if (type === 0) return d.toLocaleDateString([], { year: 'numeric', ...utc });
      if (type === 1) return d.toLocaleDateString([], { month: 'short', ...utc });
      if (type === 2) return d.toLocaleDateString([], { day: 'numeric', month: 'short', ...utc });
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    },
    full: t => new Date(t * 1000).toLocaleString([], utc.timeZone ? { day: 'numeric', month: 'short', year: 'numeric', ...utc }
      : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  };
}

export function priceChart(host, { onOlder, onHover }) {
  const read = () => {
    const s = getComputedStyle(document.documentElement), v = n => s.getPropertyValue(n).trim();
    return { up: v('--up'), down: v('--down'), line: v('--line'), grid: v('--grid'), muted: v('--muted'), text: v('--text'), surface: v('--panel'), font: getComputedStyle(document.body).fontFamily };
  };
  let c = read(), applied = [], precision = 2;
  const look = () => ({
    layout: { background: { type: ColorType.Solid, color: c.surface }, textColor: c.muted },
    grid: { horzLines: { color: c.grid }, vertLines: { color: c.grid } },
    crosshair: { horzLine: { color: c.muted, labelBackgroundColor: c.muted }, vertLine: { color: c.muted, labelBackgroundColor: c.muted } },
    rightPriceScale: { borderColor: c.line }, timeScale: { borderColor: c.line },
  });
  const chart = createChart(host, {
    autoSize: true,
    layout: { attributionLogo: true, fontFamily: c.font, fontSize: 11, background: { type: ColorType.Solid, color: c.surface }, textColor: c.muted },
    grid: { horzLines: { color: c.grid, style: LineStyle.Solid }, vertLines: { color: c.grid, style: LineStyle.Solid } },
    crosshair: { mode: CrosshairMode.Normal, horzLine: { style: LineStyle.Dashed, width: 1 }, vertLine: { style: LineStyle.Dashed, width: 1 } },
    rightPriceScale: { borderColor: c.line, entireTextOnly: true, scaleMargins: { top: 0.08, bottom: 0.26 } },
    leftPriceScale: { visible: false },
    timeScale: { borderColor: c.line, rightOffset: RIGHT_OFFSET, barSpacing: BAR_SPACING, minBarSpacing: 0.5, fixLeftEdge: true, timeVisible: true, secondsVisible: false },
    handleScroll: { vertTouchDrag: false },
    kineticScroll: { mouse: false, touch: false },
  });
  chart.applyOptions(look());
  const candleColours = () => ({ upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
  const candles = chart.addSeries(CandlestickSeries, { ...candleColours(), priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
  const volume = chart.addSeries(HistogramSeries, { priceScaleId: '', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

  const bar = p => ({ time: p.time, open: p.open, high: p.high, low: p.low, close: p.close });
  const col = p => ({ time: p.time, value: p.volume, color: faded(p.close >= p.open ? c.up : c.down, 0.45) });
  const scale = chart.timeScale();
  scale.subscribeVisibleLogicalRangeChange(range => { if (range && applied.length && range.from < OLDER_AT) onOlder(); });
  chart.subscribeCrosshairMove(e => onHover(e.point && e.time != null ? Number(e.time) : null));

  function write(points, keep) {
    const before = keep ? scale.getVisibleLogicalRange() : null;
    const shift = before && applied.length ? Math.max(0, points.findIndex(p => p.time === applied[0].time)) : 0;
    candles.setData(points.map(bar)); volume.setData(points.map(col));
    applied = points;
    if (before) scale.setVisibleLogicalRange({ from: before.from + shift, to: before.to + shift });
    else fit();
  }
  // The newest bars at the usual spacing; until the chart has a width this waits for the first resize.
  let fitPending = false;
  function fit() {
    fitPending = scale.width() === 0;
    if (fitPending || !applied.length) return;
    const to = applied.length - 1 + RIGHT_OFFSET;
    scale.setVisibleLogicalRange({ from: Math.max(-0.5, to - Math.max(2, scale.width() / BAR_SPACING)), to });
  }
  new ResizeObserver(() => { if (fitPending) requestAnimationFrame(fit); }).observe(host);

  return {
    // mode: 'fit' (another pair or timeframe), 'keep' (older bars added on the left), 'live' (newest bars refreshed).
    set(points, mode) {
      if (!points.length) { candles.setData([]); volume.setData([]); applied = []; return; }
      if (mode === 'live') {
        const change = tail(applied, points);
        if (change.kind === 'same') return;
        if (change.kind === 'update') {
          for (const p of change.bars) { const old = p.time < change.newest; candles.update(bar(p), old); volume.update(col(p), old); }
          applied = points;
          return;
        }
      }
      write(points, mode !== 'fit');
    },
    interval(interval) {
      const t = timeText(interval);
      chart.applyOptions({ localization: { timeFormatter: t.full }, timeScale: { tickMarkFormatter: t.tick, timeVisible: intervalSeconds(interval) < 86400 } });
    },
    precision(places) {
      if (places === precision) return;
      precision = places;
      candles.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
    },
    theme() {
      c = read();
      chart.applyOptions(look());
      candles.applyOptions(candleColours());
      if (applied.length) write(applied, true);
    },
  };
}
