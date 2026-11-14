'use client';
import { useMemo, useRef, useState } from 'react';
import { osmTile, project, unproject } from '@gutad/shared';

export interface MapPolygon { id?: string; coords: [number, number][]; color?: string; dashed?: boolean; label?: string; fillOpacity?: number }
export interface MapMarker { id?: string; lat: number; lng: number; color?: string; label?: string; title?: string; size?: number }
export interface MapCircle { lat: number; lng: number; radiusKm: number; color?: string }

/**
 * Minimal slippy map on OpenStreetMap raster tiles (no map library): pan by dragging, zoom with the buttons,
 * polygons/markers/circles as an SVG overlay, and an optional click handler (used to draw zones).
 */
export function TileMap({ center, zoom: z0 = 13, height = 380, polygons = [], markers = [], circles = [], onClick, draft }: { center: { lat: number; lng: number }; zoom?: number; height?: number; polygons?: MapPolygon[]; markers?: MapMarker[]; circles?: MapCircle[]; onClick?: (p: { lat: number; lng: number }) => void; draft?: [number, number][] }) {
  const [zoom, setZoom] = useState(z0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [width, setWidth] = useState(800);
  const c = useMemo(() => { const p = project(center.lat, center.lng, zoom); return { x: p.x - offset.x, y: p.y - offset.y }; }, [center.lat, center.lng, zoom, offset]);
  const left = c.x - width / 2, top = c.y - height / 2;
  const tiles: { x: number; y: number; key: string }[] = [];
  const n = 2 ** zoom;
  for (let tx = Math.floor(left / 256); tx <= Math.floor((left + width) / 256); tx++) for (let ty = Math.floor(top / 256); ty <= Math.floor((top + height) / 256); ty++) if (ty >= 0 && ty < n) tiles.push({ x: tx, y: ty, key: `${zoom}/${tx}/${ty}` });
  const pt = (lat: number, lng: number) => { const p = project(lat, lng, zoom); return { x: p.x - left, y: p.y - top }; };
  const kmPx = (lat: number) => (256 * n) / (40075 * Math.cos((lat * Math.PI) / 180));
  const zoomBy = (d: number) => { setOffset({ x: offset.x * 2 ** d, y: offset.y * 2 ** d }); setZoom(Math.max(3, Math.min(18, zoom + d))); };
  const path = (coords: [number, number][]) => coords.map(([lng, lat], i) => { const p = pt(lat, lng); return `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(' ');
  return (
    <div ref={(el) => { (box as React.MutableRefObject<HTMLDivElement | null>).current = el; if (el && el.clientWidth && el.clientWidth !== width) setWidth(el.clientWidth); }} className="relative select-none overflow-hidden rounded-xl border border-ink-100 bg-ink-50" style={{ height, cursor: onClick ? 'crosshair' : 'grab' }}
      onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; }}
      onMouseMove={(e) => { if (!drag.current) return; const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y; if (Math.abs(dx) + Math.abs(dy) > 3) { drag.current = { x: e.clientX, y: e.clientY, moved: true }; setOffset((o) => ({ x: o.x + dx, y: o.y + dy })); } }}
      onMouseUp={(e) => { const d = drag.current; drag.current = null; if (d && !d.moved && onClick && box.current) { const r = box.current.getBoundingClientRect(); onClick(unproject(left + e.clientX - r.left, top + e.clientY - r.top, zoom)); } }}
      onMouseLeave={() => { drag.current = null; }}>
      {tiles.map((t) => <img key={t.key} alt="" draggable={false} src={osmTile(((t.x % n) + n) % n, t.y, zoom)} className="absolute max-w-none" style={{ left: t.x * 256 - left, top: t.y * 256 - top, width: 256, height: 256 }} />)}
      <svg className="pointer-events-none absolute inset-0" width={width} height={height}>
        {circles.map((ci, i) => { const p = pt(ci.lat, ci.lng); return <circle key={i} cx={p.x} cy={p.y} r={ci.radiusKm * kmPx(ci.lat)} fill={ci.color || '#0284c7'} fillOpacity={0.08} stroke={ci.color || '#0284c7'} strokeDasharray="4 4" />; })}
        {polygons.map((pg, i) => <g key={pg.id || i}><path d={`${path(pg.coords)} Z`} fill={pg.color || '#f45d0a'} fillOpacity={pg.fillOpacity ?? 0.15} stroke={pg.color || '#f45d0a'} strokeWidth={2} strokeDasharray={pg.dashed ? '6 4' : undefined} />{pg.label && pg.coords[0] && (() => { const p = pt(pg.coords[0][1], pg.coords[0][0]); return <text x={p.x + 4} y={p.y - 4} fontSize={11} fill="#141210" stroke="#fff" strokeWidth={3} paintOrder="stroke">{pg.label}</text>; })()}</g>)}
        {draft && draft.length > 0 && <path d={path(draft)} fill="none" stroke="#141210" strokeWidth={2} strokeDasharray="3 3" />}
        {draft?.map(([lng, lat], i) => { const p = pt(lat, lng); return <circle key={i} cx={p.x} cy={p.y} r={4} fill="#141210" />; })}
        {markers.map((m, i) => { const p = pt(m.lat, m.lng); return <g key={m.id || i}><circle cx={p.x} cy={p.y} r={m.size || 6} fill={m.color || '#141210'} stroke="#fff" strokeWidth={2}><title>{m.title || m.label}</title></circle>{m.label && <text x={p.x + 8} y={p.y + 4} fontSize={11} fill="#141210" stroke="#fff" strokeWidth={3} paintOrder="stroke">{m.label}</text>}</g>; })}
      </svg>
      <div className="absolute right-2 top-2 flex flex-col gap-1">
        <button type="button" className="h-7 w-7 rounded bg-white text-lg shadow" onMouseDown={(e) => e.stopPropagation()} onClick={() => zoomBy(1)}>+</button>
        <button type="button" className="h-7 w-7 rounded bg-white text-lg shadow" onMouseDown={(e) => e.stopPropagation()} onClick={() => zoomBy(-1)}>−</button>
        <button type="button" className="h-7 w-7 rounded bg-white text-xs shadow" title="Re-center" onMouseDown={(e) => e.stopPropagation()} onClick={() => setOffset({ x: 0, y: 0 })}>⌖</button>
      </div>
      <div className="absolute bottom-0 right-0 bg-white/80 px-1 text-[10px]">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">OpenStreetMap</a> contributors</div>
    </div>
  );
}
