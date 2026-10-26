import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * The few charts the reports need, drawn as plain SVG.
 *
 * One highlight colour - the brand orange - for the period being looked at,
 * and gray for the period it is compared with: the point is this period, the
 * other is context. Thin lines, hairline grid, a legend whenever there are two
 * series, and a readout on hover. Every chart sits above a table of the same
 * numbers, so nothing is only readable by hovering.
 *
 * Time runs left to right, as the Latin digits it is labelled in do.
 */

const ACCENT = 'var(--color-duch-accent)';
const CONTEXT = '#a8a29e';
const GRID = 'var(--color-duch-line)';

/** 0, 500, 2.5K, 12K: an axis tick or a figure where space is short. */
export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(value / 1_000)}K`;
  return String(Math.round(value));
}

function trim(value: number): string {
  return value.toFixed(Math.abs(value) >= 10 ? 0 : 1).replace(/\.0$/, '');
}

/** Three or four round steps from zero (or below it) to just past the top. */
function niceTicks(min: number, max: number): number[] {
  const low = Math.min(0, min);
  const span = Math.max(max - low, 1);
  const rough = span / 3;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((s) => s >= rough) ?? rough;
  const ticks: number[] = [];
  for (let tick = Math.floor(low / step) * step; tick < max + step; tick += step) {
    ticks.push(Math.round(tick * 100) / 100);
    if (tick >= max) break;
  }
  return ticks;
}

/** The width the chart actually has, so text is drawn at its real size rather than stretched. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export interface TrendPoint {
  /** Under the axis and at the head of the readout. */
  label: string;
  value: number;
  /** The same position in the period compared with; omitted for no comparison. */
  previous?: number;
  previousLabel?: string;
}

/**
 * A value over time against the period before it.
 */
export function TrendChart({
  points,
  format,
  currentLabel,
  previousLabel,
  height = 220,
}: {
  points: TrendPoint[];
  format: (value: number) => string;
  currentLabel: string;
  previousLabel?: string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const compare = points.some((point) => point.previous !== undefined);

  const pad = { top: 12, right: 12, bottom: 24, left: 44 };
  const innerWidth = Math.max(width - pad.left - pad.right, 10);
  const innerHeight = height - pad.top - pad.bottom;

  const { ticks, y } = useMemo(() => {
    const values = points.flatMap((point) => [point.value, point.previous ?? point.value]);
    const scaleTicks = niceTicks(Math.min(...values, 0), Math.max(...values, 0));
    const bottom = scaleTicks[0] ?? 0;
    const top = scaleTicks[scaleTicks.length - 1] ?? 1;
    return {
      ticks: scaleTicks,
      y: (value: number) => pad.top + innerHeight - ((value - bottom) / (top - bottom || 1)) * innerHeight,
    };
  }, [points, innerHeight, pad.top]);

  const x = (index: number) => pad.left + (points.length > 1 ? (index / (points.length - 1)) * innerWidth : innerWidth / 2);
  const path = (pick: (point: TrendPoint) => number | undefined) =>
    points
      .map((point, index) => {
        const value = pick(point);
        return value === undefined ? null : `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(' ');

  // A few dates under the axis, never crowding: first, last, and even steps between.
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(innerWidth / 70))));

  function onPointer(event: React.PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    setHover(Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1)))));
  }

  const active = hover !== null ? points[hover] : null;

  return (
    <div className="space-y-2">
      <Legend
        items={[
          { label: currentLabel, color: ACCENT },
          ...(compare && previousLabel ? [{ label: previousLabel, color: CONTEXT }] : []),
        ]}
      />
      <div ref={ref} className="relative" dir="ltr">
        {width > 0 ? (
          <svg width={width} height={height} role="img" aria-label={currentLabel}>
            {ticks.map((tick) => (
              <g key={tick}>
                <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke={GRID} strokeWidth={1} />
                <text x={pad.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-stone-500 text-[11px] tabular-nums">
                  {compactNumber(tick)}
                </text>
              </g>
            ))}

            {points.map((point, index) =>
              index % labelEvery === 0 || index === points.length - 1 ? (
                <text
                  key={point.label}
                  x={x(index)}
                  y={height - 6}
                  textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
                  className="fill-stone-500 text-[11px] tabular-nums"
                >
                  {point.label}
                </text>
              ) : null,
            )}

            {compare ? (
              <path d={path((point) => point.previous)} fill="none" stroke={CONTEXT} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ) : null}
            <path d={path((point) => point.value)} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

            {active && hover !== null ? (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerHeight} stroke="#78716c" strokeWidth={1} />
                {active.previous !== undefined ? (
                  <circle cx={x(hover)} cy={y(active.previous)} r={4} fill={CONTEXT} stroke="white" strokeWidth={2} />
                ) : null}
                <circle cx={x(hover)} cy={y(active.value)} r={4} fill={ACCENT} stroke="white" strokeWidth={2} />
              </g>
            ) : null}

            {/* The whole plot is the hover target: the reader aims at a day, not a line. */}
            <rect
              x={pad.left}
              y={pad.top}
              width={innerWidth}
              height={innerHeight}
              fill="transparent"
              onPointerMove={onPointer}
              onPointerDown={onPointer}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
        ) : (
          <div style={{ height }} />
        )}

        {active && hover !== null ? (
          <div
            className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-lg border border-duch-line bg-white px-3 py-2 text-xs shadow-md"
            style={
              x(hover) > width / 2
                ? { right: width - x(hover) + 10 }
                : { left: x(hover) + 10 }
            }
            dir="auto"
          >
            <ReadoutRow color={ACCENT} value={format(active.value)} label={active.label} />
            {active.previous !== undefined ? (
              <ReadoutRow color={CONTEXT} value={format(active.previous)} label={active.previousLabel ?? ''} />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReadoutRow({ color, value, label }: { color: string; value: string; label: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: color }} />
      <span className="tabular font-bold text-duch-ink">{value}</span>
      <span className="text-stone-500">{label}</span>
    </div>
  );
}

export function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  if (items.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

/** A small line of the period's shape for a stat card. No axis: the card's number is the value. */
export function Sparkline({ values, height = 32 }: { values: number[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  if (values.length < 2) return <div style={{ height }} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const d = values
    .map((value, index) => {
      const px = (index / (values.length - 1)) * Math.max(width - 4, 1) + 2;
      const py = height - 3 - ((value - min) / span) * (height - 6);
      return `${index === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(' ');
  return (
    <div ref={ref} dir="ltr" aria-hidden>
      {width > 0 ? (
        <svg width={width} height={height}>
          <path d={d} fill="none" stroke={ACCENT} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      ) : (
        <div style={{ height }} />
      )}
    </div>
  );
}

/**
 * Ranked bars, one colour, the value at the end of each - for "which sold
 * most" and "where from", where the order is the point.
 */
export function BarList({
  rows,
  format,
  empty,
}: {
  rows: Array<{ key: string; label: ReactNode; value: number; note?: ReactNode }>;
  format: (value: number) => string;
  empty?: ReactNode;
}) {
  if (rows.length === 0) return <p className="text-sm text-stone-500">{empty ?? '—'}</p>;
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <ul className="space-y-2.5">
      {rows.map((row) => (
        <li key={row.key} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{row.label}</span>
            <span className="flex shrink-0 items-baseline gap-2">
              {row.note ? <span className="text-xs text-stone-500">{row.note}</span> : null}
              <span className="tabular font-semibold">{format(row.value)}</span>
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-stone-100">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(0, (row.value / max) * 100)}%`, background: ACCENT }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
