import { useEffect, useMemo, useRef, useState } from "react";
import type { GameView } from "../../shared/types";
import { content, CATEGORY_GLYPH, isClosed, hasTag, currentPlayerId } from "../ctx";

// ---- projection: equirectangular, scaled by cos(lat) so distances are true-ish in km ----
const U = 60; // svg units per km
const lat0 = content.pois.reduce((s, p) => s + p.lat, 0) / content.pois.length;
const kx = Math.cos((lat0 * Math.PI) / 180) * 111.32 * U;
const ky = 110.57 * U;
const minLng = Math.min(...content.pois.map((p) => p.lng));
const maxLat = Math.max(...content.pois.map((p) => p.lat));
export const project = (lat: number, lng: number) => ({ x: (lng - minLng) * kx, y: (maxLat - lat) * ky });
const PTS = Object.fromEntries(content.pois.map((p) => [p.id, project(p.lat, p.lng)]));
const PAD = 1.2 * U;
const XS = Object.values(PTS).map((p) => p.x);
const YS = Object.values(PTS).map((p) => p.y);
const BOUNDS = { x0: Math.min(...XS) - PAD, y0: Math.min(...YS) - PAD, x1: Math.max(...XS) + PAD, y1: Math.max(...YS) + PAD };

const DISTRICT_CENTERS = content.districts.map((d) => {
  const ps = content.pois.filter((p) => p.district === d.id).map((p) => PTS[p.id]);
  return { d, x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length };
});

interface Props {
  view?: GameView | null;
  selected?: string | null;
  onSelect?: (id: string) => void;
  decorative?: boolean;
  highlight?: string[]; // extra POIs to ring (e.g. path)
  moveCosts?: Record<string, number>; // neighbour -> AP (my turn)
  focus?: string | null; // initial camera centre (zoomed in)
}

export default function CityMap({ view, selected, onSelect, decorative, highlight = [], moveCosts = {}, focus }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const sizeRef = useRef<{ w: number; h: number } | null>(null);
  const [cam, setCam] = useState<{ k: number; tx: number; ty: number } | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width || 800, h = e.contentRect.height || 600;
      // keep whatever the player is looking at centred when the panel resizes (e.g. phone rotation)
      const prev = sizeRef.current;
      sizeRef.current = { w, h };
      if (prev) setCam((cm) => (cm ? { ...cm, tx: cm.tx + (w - prev.w) / 2, ty: cm.ty + (h - prev.h) / 2 } : cm));
      setSize({ w, h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useMemo(() => {
    const k = Math.min(size.w / (BOUNDS.x1 - BOUNDS.x0), size.h / (BOUNDS.y1 - BOUNDS.y0));
    return { k, tx: (size.w - (BOUNDS.x1 - BOUNDS.x0) * k) / 2 - BOUNDS.x0 * k, ty: (size.h - (BOUNDS.y1 - BOUNDS.y0) * k) / 2 - BOUNDS.y0 * k };
  }, [size]);
  // first real size measurement → zoom in around the focus point (downtown is dense)
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !focus || size.w === 800) return;
    focused.current = true;
    const k = fit.k * 3.2, pt = PTS[focus];
    if (pt) setCam({ k, tx: size.w / 2 - pt.x * k, ty: size.h / 2 - pt.y * k });
  }, [focus, size, fit]);
  const c = cam ?? fit;
  const inv = 1 / c.k; // keep strokes/text at constant screen size

  const zoomAt = (factor: number, sx = size.w / 2, sy = size.h / 2) => {
    const k = Math.max(fit.k * 0.8, Math.min(fit.k * 12, c.k * factor));
    const f = k / c.k;
    setCam({ k, tx: sx - (sx - c.tx) * f, ty: sy - (sy - c.ty) * f });
  };

  useEffect(() => {
    const el = wrap.current?.querySelector("svg");
    if (!el || decorative) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const me = view?.me ? view.players[view.me] : null;
  const cur = view ? currentPlayerId(view as never) : null;
  const crisisDef = view?.crisis && !view.crisis.resolved ? content.crises.find((x) => x.id === view.crisis!.crisisId) : null;
  const contractPois = new Set((view?.contracts ?? []).filter((x) => x.status === "open" || (x.status === "accepted" && x.acceptedBy === view?.me)).map((x) => x.poiId));
  // greedy label placement in screen space: high-priority labels first, skip any that would overlap
  const labelSet = useMemo(() => {
    const z = c.k / fit.k;
    const cand = content.pois.map((p) => {
      let pr = p.tier === 1 ? 30 : p.tier === 2 ? (z > 1.8 ? 20 : -1) : z > 3 ? 10 : -1;
      if (decorative) pr = p.tier === 1 ? 30 : -1;
      if (p.id in moveCosts) pr = 60;
      if (highlight.includes(p.id)) pr = Math.max(pr, 50);
      if (p.id === selected) pr = 100;
      if (view?.me && view.players[view.me]?.position === p.id) pr = Math.max(pr, 90);
      return { p, pr };
    }).filter((x) => x.pr >= 0).sort((a, b) => b.pr - a.pr);
    const boxes: [number, number, number, number][] = [];
    const out = new Set<string>();
    for (const { p } of cand) {
      const { x, y } = PTS[p.id];
      const sx = x * c.k + c.tx, sy = y * c.k + c.ty + 18;
      const w = p.name.length * 12.5 + 6, h = 16;
      const b: [number, number, number, number] = [sx - w / 2, sy - h / 2, sx + w / 2, sy + h / 2];
      if (boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1])) continue;
      boxes.push(b);
      out.add(p.id);
    }
    return out;
  }, [c, fit, moveCosts, highlight, selected, view, decorative]);

  // players grouped by position so pens don't overlap
  const pensAt: Record<string, string[]> = {};
  if (view) for (const id of view.playerOrder) {
    const p = view.players[id];
    if (p?.position) (pensAt[p.position] ??= []).push(id);
  }

  return (
    <div className={decorative ? "" : "map-inner"} ref={wrap} style={{ position: "absolute", inset: 0 }}>
      <svg
        className={dragging ? "dragging" : ""}
        role={decorative ? "img" : "application"}
        aria-label="台中遊戲地圖"
        onPointerDown={(e) => {
          if (decorative) return;
          drag.current = { x: e.clientX, y: e.clientY, tx: c.tx, ty: c.ty, moved: 0 };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x, dy = e.clientY - d.y;
          d.moved = Math.max(d.moved, Math.abs(dx) + Math.abs(dy));
          if (d.moved > 4) {
            if (!dragging) { setDragging(true); (e.currentTarget as Element).setPointerCapture?.(e.pointerId); }
            setCam({ k: c.k, tx: d.tx + dx, ty: d.ty + dy });
          }
        }}
        onPointerUp={() => { setTimeout(() => { drag.current = null; }, 0); setDragging(false); }}
        onPointerLeave={() => { drag.current = null; setDragging(false); }}
      >
        <defs>
          <pattern id="grid" width={U} height={U} patternUnits="userSpaceOnUse">
            <path d={`M ${U} 0 L 0 0 0 ${U}`} fill="none" stroke="#b3bdbb" strokeWidth={0.6 * inv} opacity="0.6" />
          </pattern>
        </defs>
        <g transform={`translate(${c.tx},${c.ty}) scale(${c.k})`}>
          <rect x={BOUNDS.x0 - 20 * U} y={BOUNDS.y0 - 20 * U} width={(BOUNDS.x1 - BOUNDS.x0) + 40 * U} height={(BOUNDS.y1 - BOUNDS.y0) + 40 * U} fill="url(#grid)" />

          {/* zoning blobs: one uniform tint per gameplay district */}
          {content.districts.map((d) => (
            <g key={d.id} opacity={0.32} fill={d.color}>
              {content.pois.filter((p) => p.district === d.id).map((p) => (
                <circle key={p.id} cx={PTS[p.id].x} cy={PTS[p.id].y} r={0.75 * U} />
              ))}
            </g>
          ))}
          {DISTRICT_CENTERS.map(({ d, x, y }) => (
            <text key={d.id} x={x} y={y - 0.95 * U} textAnchor="middle" className="district-label" style={{ fontSize: 15 * inv }}>{d.name}</text>
          ))}

          {/* gameplay graph */}
          {content.edges.map((e, i) => {
            const a = PTS[e.from], b = PTS[e.to];
            const mine = me?.position && (e.from === me.position || e.to === me.position);
            return (
              <g key={i}>
                {e.type === "rail" && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#1f2d3a" strokeWidth={4 * inv} opacity={0.25} />}
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#1f2d3a"
                  strokeWidth={(mine ? 2.2 : e.type === "road" ? 1.3 : 1) * inv}
                  strokeDasharray={e.type === "rail" ? `${6 * inv} ${4 * inv}` : e.type === "walk" ? `${2 * inv} ${3 * inv}` : undefined}
                  opacity={mine ? 0.9 : 0.45} />
              </g>
            );
          })}

          {/* move-cost tags on edges out of my position */}
          {me?.position && Object.entries(moveCosts).map(([to, cost]) => {
            const a = PTS[me.position!], b = PTS[to];
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            return (
              <g key={to}>
                <circle cx={mx} cy={my} r={7.5 * inv} fill={cost === 0 ? "#3c7d4f" : "#1f2d3a"} />
                <text x={mx} y={my + 3.5 * inv} textAnchor="middle" className="cost-tag" style={{ fontSize: 10 * inv }}>{cost}</text>
              </g>
            );
          })}

          {/* POIs */}
          {content.pois.map((p) => {
            const { x, y } = PTS[p.id];
            const st = view?.pois[p.id];
            const owner = st?.owner ? view!.players[st.owner] : null;
            const closed = view ? isClosed(view as never, p.id) : false;
            const visited = me?.visited.includes(p.id);
            const sz = (p.tier === 1 ? 9 : p.tier === 2 ? 6.5 : 5) * inv;
            const isSel = selected === p.id;
            const ring = isSel || highlight.includes(p.id) || p.id in moveCosts;
            const fill = owner ? owner.color : "#f1f3ef";
            const shape = p.tier === 1
              ? <rect x={x - sz} y={y - sz} width={sz * 2} height={sz * 2} fill={fill} />
              : p.tier === 2
                ? <circle cx={x} cy={y} r={sz} fill={fill} />
                : <path d={`M ${x} ${y - sz * 1.3} L ${x + sz * 1.3} ${y} L ${x} ${y + sz * 1.3} L ${x - sz * 1.3} ${y} Z`} fill={fill} />;
            const showLabel = labelSet.has(p.id);
            return (
              <g key={p.id} className="poi-node" tabIndex={decorative ? -1 : 0}
                role={decorative ? undefined : "button"} aria-label={p.name}
                onClick={() => { if (!drag.current || drag.current.moved <= 4) onSelect?.(p.id); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(p.id); } }}>
                <circle cx={x} cy={y} r={sz * 2.6} fill="transparent" />
                {crisisDef && hasTag(p, crisisDef.respondTags) && (
                  <circle cx={x} cy={y} r={sz * 2.1} fill="none" stroke="#c8372d" strokeWidth={1.4 * inv} strokeDasharray={`${3 * inv} ${2 * inv}`} className="pulse" />
                )}
                {ring && <circle className="ring" cx={x} cy={y} r={sz * 1.9} fill="none" stroke="#1f2d3a" strokeWidth={(isSel ? 2.4 : 1.4) * inv} />}
                <g stroke="#1f2d3a" strokeWidth={(visited ? 2 : 1.3) * inv} strokeDasharray={view && !visited ? `${2.5 * inv} ${1.5 * inv}` : undefined}>{shape}</g>
                {p.tier === 1 && (
                  <text x={x} y={y + 4 * inv} textAnchor="middle" className="poi-glyph" style={{ fontSize: 11 * inv, fill: owner ? "#fff" : undefined }}>
                    {CATEGORY_GLYPH[p.category] ?? "・"}
                  </text>
                )}
                {!!st?.level && (
                  <text x={x + sz + 2 * inv} y={y - sz} className="poi-glyph" style={{ fontSize: 10 * inv }}>{"▲".repeat(st.level)}</text>
                )}
                {closed && (
                  <path d={`M ${x - sz * 1.4} ${y - sz * 1.4} L ${x + sz * 1.4} ${y + sz * 1.4} M ${x + sz * 1.4} ${y - sz * 1.4} L ${x - sz * 1.4} ${y + sz * 1.4}`} stroke="#c8372d" strokeWidth={2.2 * inv} />
                )}
                {contractPois.has(p.id) && (
                  <g>
                    <rect x={x - sz - 15 * inv} y={y - sz - 12 * inv} width={14 * inv} height={13 * inv} fill="#fff" stroke="#1f2d3a" strokeWidth={1 * inv} />
                    <text x={x - sz - 8 * inv} y={y - sz - 2 * inv} textAnchor="middle" className="poi-glyph" style={{ fontSize: 9.5 * inv }}>委</text>
                  </g>
                )}
                {showLabel && (
                  <text x={x} y={y + 22 * inv} textAnchor="middle" className="poi-label" style={{ fontSize: 12 * inv, strokeWidth: 3.5 * inv, fontWeight: isSel ? 700 : 400 }}>{p.name}</text>
                )}
              </g>
            );
          })}

          {/* player pens */}
          {view && Object.entries(pensAt).map(([poi, ids]) => ids.map((id, i) => {
            const pl = view.players[id];
            const { x, y } = PTS[poi];
            const ang = -Math.PI / 2 + (i - (ids.length - 1) / 2) * 0.75;
            const r = 22 * inv;
            const px = x + Math.cos(ang) * r, py = y + Math.sin(ang) * r;
            const isCur = id === cur;
            return (
              <g key={id} pointerEvents="none">
                {isCur && <circle cx={px} cy={py} r={11 * inv} fill="none" stroke={pl.color} strokeWidth={2 * inv} className="pulse" />}
                <circle cx={px} cy={py} r={8 * inv} fill={pl.color} stroke="#1f2d3a" strokeWidth={(id === view.me ? 2.4 : 1.4) * inv} />
                <text x={px} y={py + 3.5 * inv} textAnchor="middle" className="cost-tag" style={{ fontSize: 9.5 * inv }}>{pl.name.slice(0, 1)}</text>
              </g>
            );
          }))}
        </g>
      </svg>
      {!decorative && (
        <>
          <div className="map-tools">
            <button className="btn small" onClick={() => zoomAt(1.3)} aria-label="放大">＋</button>
            <button className="btn small" onClick={() => zoomAt(1 / 1.3)} aria-label="縮小">－</button>
            <button className="btn small" onClick={() => setCam(null)} aria-label="重設視角">⤢</button>
          </div>
          <div className="map-legend">
            <span>■ 主要</span><span>● 次要</span><span>◆ 探索</span>
            <span>┅ 捷運／鐵路</span><span>┈ 步行</span><span>虛線框＝尚未探索</span>
            {crisisDef && <span style={{ color: "#c8372d" }}>紅圈＝可回應危機</span>}
          </div>
          <div className="map-note">位置依真實經緯度投影；連線為遊戲移動圖，非實際道路</div>
        </>
      )}
    </div>
  );
}
