import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SceneBox, SceneBuilt, ScenePlanData, SceneRect } from '../../api';

// A floor of the scene drawn as an architect's plan: cut at 1.2 m above the floor, walls solid and dark, doors
// with their swing, windows as thin glass lines in the wall, stairs as treads with the way up, furniture as the
// usual symbols (a bed with its pillow, a chair with its back, a sofa with back and arms). North is at the top.
// Drag to pan, wheel to zoom; a click picks a room or a thing, as in the 3D view.

type Props = {
  built: SceneBuilt; floor: number; labels: boolean; selected?: string;
  onPick?: (p: { name: string; room: string }) => void;
};
type View = { s: number; tx: number; ty: number };

const CUT = 1.2; // the height the plan is cut at, above the floor
const INK = '#262626';
const LOW = '#8d8a84'; // walls lower than the cut: parapets, the wall under a window
const LINE = '#4a4a4a';
const GLASS = '#5d9cc8';
const ACC = '#e8a33d';
const FILL: Record<string, string> = {
  wood: '#efe4d4', metal: '#e1e6ea', soft: '#eedcd2', bed: '#e1e9f2', dark: '#d4d4d4', white: '#fbfbf8', gold: '#efe0b8',
  blue: '#d7e2f4', green: '#dce7d5', red: '#efd8cf', pink: '#f5dce6', stone: '#e0dcd5', shed: '#ece3d4', lamp: '#fbf1cf', rope: '#efe6d2',
};
const fillOf = (kind: string) => FILL[kind] || '#f2f0ea';

// which symbol a piece of furniture gets, from its name first (the names are what the script calls things)
type Sym = 'bed' | 'sofa' | 'chair' | 'stool' | 'table' | 'tableset' | 'cabinet' | 'shelf' | 'stove' | 'washer' | 'bath' | 'box';
function symbolOf(name: string, kind: string): Sym {
  if (/床头柜/.test(name)) return 'cabinet';
  if (kind === 'bed' || /床/.test(name)) return 'bed';
  if (/沙发/.test(name)) return 'sofa';
  if (/桌|茶几|案板/.test(name)) return /椅|凳/.test(name) ? 'tableset' : 'table';
  if (/椅/.test(name)) return 'chair';
  if (/凳/.test(name)) return 'stool';
  if (/灶|炉子$|炉$|铁皮炉/.test(name)) return 'stove';
  if (/洗衣机/.test(name)) return 'washer';
  if (/卫生间|浴室|厕所/.test(name)) return 'bath';
  if (/台/.test(name)) return 'table';
  if (/柜|箱/.test(name)) return 'cabinet';
  if (/架/.test(name)) return 'shelf';
  return 'box';
}

const rectOf = (b: SceneRect) => ({ x: b.x0, y: b.z0, width: Math.max(b.x1 - b.x0, 0.01), height: Math.max(b.z1 - b.z0, 0.01) });
const thin = { vectorEffect: 'non-scaling-stroke' as const };
const centre = (b: SceneRect) => [(b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2];

// the side of b nearest to one of the room's walls: 'n' | 's' | 'w' | 'e'
function wallSide(b: SceneRect, room?: { x: number[]; z: number[] }) {
  if (!room) return 's';
  const gaps: [string, number][] = [['n', b.z0 - room.z[0]], ['s', room.z[1] - b.z1], ['w', b.x0 - room.x[0]], ['e', room.x[1] - b.x1]];
  return gaps.sort((p, q) => p[1] - q[1])[0][0];
}
// a band of thickness d along one side of b
function band(b: SceneRect, side: string, d: number): SceneRect {
  if (side === 'n') return { ...b, z1: b.z0 + d };
  if (side === 's') return { ...b, z0: b.z1 - d };
  if (side === 'w') return { ...b, x1: b.x0 + d };
  return { ...b, x0: b.x1 - d };
}

function Furniture({ b, sym, room, toward, overhead, on }: {
  b: SceneBox; sym: Sym; room?: { x: number[]; z: number[] }; toward?: number[]; overhead: boolean; on: boolean;
}) {
  const w = b.x1 - b.x0;
  const d = b.z1 - b.z0;
  const long = Math.max(w, d);
  const short = Math.min(w, d);
  const stroke = on ? ACC : LINE;
  const sw = on ? 2.2 : 1;
  const base = { stroke, strokeWidth: sw, ...thin };
  if (overhead) return <rect {...rectOf(b)} fill="none" {...base} strokeDasharray="4 3" />;
  const fill = fillOf(b.kind);
  const parts: ReactNode[] = [<rect key="o" {...rectOf(b)} fill={fill} {...base} />];
  const along = w >= d ? 'x' : 'z';
  if (sym === 'bed') {
    // the head is the end against a wall: a pillow there, the turned-down sheet a third of the way along
    const ends = along === 'x' ? ['w', 'e'] : ['n', 's'];
    const near = wallSide(b, room);
    const head = ends.includes(near) ? near : (() => {
      if (!room) return ends[0];
      const gap = (s: string) => (s === 'n' ? b.z0 - room.z[0] : s === 's' ? room.z[1] - b.z1 : s === 'w' ? b.x0 - room.x[0] : room.x[1] - b.x1);
      return gap(ends[0]) <= gap(ends[1]) ? ends[0] : ends[1];
    })();
    const pillow = band(b, head, Math.min(0.32, long * 0.18));
    const inset = Math.min(0.08, short * 0.08);
    const p = along === 'x' ? { ...pillow, z0: pillow.z0 + inset, z1: pillow.z1 - inset, x0: pillow.x0 + inset, x1: pillow.x1 - inset } : { ...pillow, x0: pillow.x0 + inset, x1: pillow.x1 - inset, z0: pillow.z0 + inset, z1: pillow.z1 - inset };
    parts.push(<rect key="p" {...rectOf(p)} rx={0.05} fill="#fff" stroke={stroke} strokeWidth={0.8} {...thin} />);
    const fold = band(b, head, long * 0.36);
    const [fx0, fz0, fx1, fz1] = head === 'n' ? [b.x0, fold.z1, b.x1, fold.z1] : head === 's' ? [b.x0, fold.z0, b.x1, fold.z0] : head === 'w' ? [fold.x1, b.z0, fold.x1, b.z1] : [fold.x0, b.z0, fold.x0, b.z1];
    parts.push(<line key="f" x1={fx0} y1={fz0} x2={fx1} y2={fz1} stroke={stroke} strokeWidth={0.8} {...thin} />);
  } else if (sym === 'sofa') {
    // the back along the long side nearest a wall, an arm at each end
    const sides = along === 'x' ? ['n', 's'] : ['w', 'e'];
    const near = wallSide(b, room);
    const back = sides.includes(near) ? near : sides[0];
    const t = Math.min(0.25, short * 0.3);
    parts.push(<rect key="b" {...rectOf(band(b, back, t))} fill="#00000014" {...base} />);
    if (long >= 1.1) {
      const ends = along === 'x' ? ['w', 'e'] : ['n', 's'];
      for (const e of ends) parts.push(<rect key={e} {...rectOf(band(b, e, Math.min(0.2, long * 0.12)))} fill="#00000014" {...base} />);
    }
  } else if (sym === 'chair') {
    // the back on the side away from the table it is at, else against the wall
    let back = wallSide(b, room);
    if (toward) {
      const [cx, cz] = centre(b);
      const dx = toward[0] - cx;
      const dz = toward[1] - cz;
      back = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'w' : 'e') : (dz > 0 ? 'n' : 's');
    }
    parts.push(<rect key="b" {...rectOf(band(b, back, Math.min(0.12, short * 0.25)))} fill={INK} stroke="none" />);
  } else if (sym === 'stool') {
    parts.length = 0;
    parts.push(<circle key="c" cx={(b.x0 + b.x1) / 2} cy={(b.z0 + b.z1) / 2} r={short / 2} fill={fill} {...base} />);
  } else if (sym === 'table') {
    const i = Math.min(0.06, short * 0.1);
    parts.push(<rect key="i" x={b.x0 + i} y={b.z0 + i} width={Math.max(w - 2 * i, 0.01)} height={Math.max(d - 2 * i, 0.01)} fill="none" stroke={stroke} strokeWidth={0.6} {...thin} />);
  } else if (sym === 'tableset') {
    // a table in the middle with chairs along its long sides
    parts.length = 0;
    const seat = Math.min(0.42, short * 0.28);
    const t = along === 'x' ? { x0: b.x0 + 0.1, x1: b.x1 - 0.1, z0: b.z0 + seat, z1: b.z1 - seat } : { x0: b.x0 + seat, x1: b.x1 - seat, z0: b.z0 + 0.1, z1: b.z1 - 0.1 };
    parts.push(<rect key="t" {...rectOf(t)} fill={fill} {...base} />);
    const n = Math.max(1, Math.floor((long - 0.2) / 0.6));
    for (let k = 0; k < n; k++) {
      const at = (along === 'x' ? b.x0 : b.z0) + 0.1 + ((long - 0.2) * (k + 0.5)) / n;
      for (const side of [0, 1]) {
        const c = along === 'x'
          ? { x0: at - seat * 0.45, x1: at + seat * 0.45, z0: side ? b.z1 - seat * 0.9 : b.z0, z1: side ? b.z1 : b.z0 + seat * 0.9 }
          : { z0: at - seat * 0.45, z1: at + seat * 0.45, x0: side ? b.x1 - seat * 0.9 : b.x0, x1: side ? b.x1 : b.x0 + seat * 0.9 };
        parts.push(<rect key={`${k}-${side}`} {...rectOf(c)} fill="#fff" {...base} />);
      }
    }
  } else if (sym === 'cabinet') {
    parts.push(<line key="d" x1={b.x0} y1={b.z0} x2={b.x1} y2={b.z1} stroke={stroke} strokeWidth={0.7} {...thin} />);
    parts.push(<line key="e" x1={b.x0} y1={b.z1} x2={b.x1} y2={b.z0} stroke={stroke} strokeWidth={0.7} {...thin} />);
  } else if (sym === 'shelf') {
    for (const k of [1, 2]) {
      parts.push(along === 'x'
        ? <line key={k} x1={b.x0} y1={b.z0 + (d * k) / 3} x2={b.x1} y2={b.z0 + (d * k) / 3} stroke={stroke} strokeWidth={0.6} {...thin} />
        : <line key={k} x1={b.x0 + (w * k) / 3} y1={b.z0} x2={b.x0 + (w * k) / 3} y2={b.z1} stroke={stroke} strokeWidth={0.6} {...thin} />);
    }
  } else if (sym === 'stove') {
    const n = long > short * 1.6 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const cx = along === 'x' ? b.x0 + (w * (k + 0.5)) / n : (b.x0 + b.x1) / 2;
      const cy = along === 'x' ? (b.z0 + b.z1) / 2 : b.z0 + (d * (k + 0.5)) / n;
      parts.push(<circle key={k} cx={cx} cy={cy} r={Math.min(short, long / n) * 0.3} fill="none" stroke={stroke} strokeWidth={0.8} {...thin} />);
    }
  } else if (sym === 'washer') {
    parts.push(<circle key="c" cx={(b.x0 + b.x1) / 2} cy={(b.z0 + b.z1) / 2} r={short * 0.32} fill="none" stroke={stroke} strokeWidth={0.8} {...thin} />);
  } else if (sym === 'bath') {
    // a small room in the room: a toilet bowl against its far wall
    const [cx, cz] = centre(b);
    parts.push(<ellipse key="t" cx={cx} cy={cz} rx={Math.min(0.2, w * 0.2)} ry={Math.min(0.28, d * 0.25)} fill="#fff" stroke={stroke} strokeWidth={0.8} {...thin} />);
  }
  return <g>{parts}</g>;
}

export function ScenePlan({ built, floor, labels, selected, onPick }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View>({ s: 20, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const plan: ScenePlanData = built.plan || { rooms: [], openings: [], stairs: [] };
  const H = built.levelHeight;
  const base = floor * H;

  // the floor shown, with its walls and what sticks out of it (a balcony): the plan is fitted to it
  const extent = useMemo(() => {
    const names = new Set(plan.rooms.filter((r) => r.lv === floor).map((r) => r.name));
    const parts: SceneRect[] = [
      ...plan.rooms.filter((r) => r.lv === floor).map((r) => ({ x0: r.x[0], x1: r.x[1], z0: r.z[0], z1: r.z[1] })),
      ...built.boxes.filter((b) => b.room && names.has(b.room) && (b.wall || b.furniture)),
    ];
    if (!parts.length) parts.push(...plan.rooms.map((r) => ({ x0: r.x[0], x1: r.x[1], z0: r.z[0], z1: r.z[1] })));
    if (!parts.length) parts.push({ x0: 0, x1: 20, z0: 0, z1: 20 });
    return { x0: Math.min(...parts.map((r) => r.x0)) - 0.3, x1: Math.max(...parts.map((r) => r.x1)) + 0.3, z0: Math.min(...parts.map((r) => r.z0)) - 0.3, z1: Math.max(...parts.map((r) => r.z1)) + 0.3 };
  }, [built, floor]); // eslint-disable-line react-hooks/exhaustive-deps
  const extentKey = [extent.x0, extent.x1, extent.z0, extent.z1].map((v) => v.toFixed(1)).join(',');

  useLayoutEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 }));
    ro.observe(el);
    setSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 });
    return () => ro.disconnect();
  }, []);
  // fitted and centred when a scene or floor opens, when its outline changes and when the view is resized
  useLayoutEffect(() => {
    const bw = extent.x1 - extent.x0;
    const bh = extent.z1 - extent.z0;
    const s = Math.min(size.w / (bw * 1.06), size.h / (bh * 1.06));
    setView({ s, tx: size.w / 2 - ((extent.x0 + extent.x1) / 2) * s, ty: size.h / 2 - ((extent.z0 + extent.z1) / 2) * s });
  }, [extentKey, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // the wheel zooms about the pointer (a listener of its own: React's wheel handler cannot stop the page scrolling)
  useEffect(() => {
    const el = host.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const v = viewRef.current;
      const s = Math.min(400, Math.max(2, v.s * Math.exp(-e.deltaY * 0.0015)));
      setView({ s, tx: mx - ((mx - v.tx) * s) / v.s, ty: my - ((my - v.ty) * s) / v.s });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
      if (d.moved) setView((v) => ({ ...v, tx: d.tx + e.clientX - d.x, ty: d.ty + e.clientY - d.y }));
    }
    const box = tip.current!;
    const hit = (e.target as Element).closest?.('[data-name]') as HTMLElement | null;
    if (!hit || (d && d.moved)) { box.style.display = 'none'; return; }
    const r = host.current!.getBoundingClientRect();
    box.textContent = hit.dataset.name || '';
    box.style.display = 'block';
    box.style.left = `${e.clientX - r.left + 14}px`;
    box.style.top = `${e.clientY - r.top + 12}px`;
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && d.moved) return;
    const hit = (e.target as Element).closest?.('[data-name]') as HTMLElement | null;
    if (hit) onPick?.({ name: hit.dataset.name || '', room: hit.dataset.room || '' });
  };

  // ---------- what is on this floor ----------
  const drawn = useMemo(() => {
    const roomsHere = plan.rooms.filter((r) => r.lv === floor);
    const roomOf = new Map(plan.rooms.map((r) => [r.name, r]));
    const onFloor = (b: SceneBox) => {
      const r = b.room ? roomOf.get(b.room) : undefined;
      return r ? r.lv === floor : b.group === floor;
    };
    const stairsHere = plan.stairs.filter((s) => s.lv === floor);
    const stairNames = new Set(plan.stairs.map((s) => s.name));
    const things = built.boxes.filter((b) => (b as SceneBox).furniture && onFloor(b) && !stairNames.has(b.name));
    // round things of a room (the terrain's rocks and trees are not part of a floor)
    const round = built.cyls.filter((c) => !!c.room && onFloor(c));
    const walls = built.boxes.filter((b) => b.wall && onFloor(b) && b.y0 <= base + CUT + 0.01);
    const tables = things.filter((b) => /桌|台|茶几/.test(b.name));
    return { roomsHere, roomOf, stairsHere, things, round, walls, tables };
  }, [built, floor]); // eslint-disable-line react-hooks/exhaustive-deps

  const { s, tx, ty } = view;
  const px = (x: number) => x * s + tx;
  const py = (z: number) => z * s + ty;
  const on = (name: string) => !!selected && name === selected;

  // ---------- the drawing ----------
  const floorsLayer = drawn.roomsHere.map((r) => {
    const b = { x0: r.x[0], x1: r.x[1], z0: r.z[0], z1: r.z[1] };
    const fill = r.outdoor ? '#e3e7da' : /走廊|楼梯|过道|大堂/.test(r.name) ? '#efece5' : '#ffffff';
    return <rect key={r.name} {...rectOf(b)} fill={fill} stroke={on(r.name) ? ACC : r.outdoor ? '#9aa08f' : '#c9c4ba'} strokeWidth={on(r.name) ? 2.2 : 1}
      strokeDasharray={r.outdoor ? '6 4' : undefined} {...thin} data-name={r.name} data-room={r.name} />;
  });

  // a 1 m grid over the building, every fifth line darker, when the zoom leaves room for it
  const grid: ReactNode[] = [];
  if (s > 8) {
    for (let x = Math.ceil(extent.x0); x <= extent.x1; x++) grid.push(<line key={`x${x}`} x1={x} y1={extent.z0} x2={x} y2={extent.z1} stroke={x % 5 ? '#e9e5dc' : '#ddd7cb'} strokeWidth={1} {...thin} />);
    for (let z = Math.ceil(extent.z0); z <= extent.z1; z++) grid.push(<line key={`z${z}`} x1={extent.x0} y1={z} x2={extent.x1} y2={z} stroke={z % 5 ? '#e9e5dc' : '#ddd7cb'} strokeWidth={1} {...thin} />);
  }

  const thingsLayer = drawn.things.map((b, i) => {
    const room = b.room ? drawn.roomOf.get(b.room) : undefined;
    const sym = symbolOf(b.name, b.kind);
    // a chair faces the nearest table of its room
    let toward: number[] | undefined;
    if (sym === 'chair') {
      const [cx, cz] = centre(b);
      const t = drawn.tables.filter((x) => x.room === b.room).map((x) => ({ c: centre(x), d: Math.hypot(centre(x)[0] - cx, centre(x)[1] - cz) })).sort((p, q) => p.d - q.d)[0];
      if (t && t.d < 2.5) toward = t.c;
    }
    const overhead = b.y0 - base > CUT;
    return (
      <g key={`${b.name}-${i}`} data-name={b.name} data-room={b.room || ''}>
        <Furniture b={b} sym={sym} room={room} toward={toward} overhead={overhead} on={on(b.name)} />
      </g>
    );
  });
  const roundLayer = drawn.round.map((c, i) => (
    <circle key={`c${i}`} cx={(c.x0 + c.x1) / 2} cy={(c.z0 + c.z1) / 2} r={Math.min(c.x1 - c.x0, c.z1 - c.z0) / 2} fill={fillOf(c.kind)}
      stroke={on(c.name) ? ACC : LINE} strokeWidth={on(c.name) ? 2.2 : 1} {...thin} data-name={c.name} data-room={c.room || ''} />
  ));

  // stairs: the outline, a line per tread, and an arrow along the way up from the first step
  const stairsLayer = drawn.stairsHere.map((st, i) => {
    const parts: ReactNode[] = [];
    const path: number[][] = [];
    for (const [k, f] of st.flights.entries()) {
      parts.push(<rect key={`f${k}`} {...rectOf(f)} fill="#faf9f5" stroke={LINE} strokeWidth={1} {...thin} />);
      const alongX = f.dir === 'e' || f.dir === 'w';
      for (let n = 1; n < f.steps; n++) {
        const t = n / f.steps;
        parts.push(alongX
          ? <line key={`t${k}-${n}`} x1={f.x0 + (f.x1 - f.x0) * t} y1={f.z0} x2={f.x0 + (f.x1 - f.x0) * t} y2={f.z1} stroke={LINE} strokeWidth={0.6} {...thin} />
          : <line key={`t${k}-${n}`} x1={f.x0} y1={f.z0 + (f.z1 - f.z0) * t} x2={f.x1} y2={f.z0 + (f.z1 - f.z0) * t} stroke={LINE} strokeWidth={0.6} {...thin} />);
      }
      const [cx, cz] = centre(f);
      const start = { n: [cx, f.z1], s: [cx, f.z0], w: [f.x1, cz], e: [f.x0, cz] }[f.dir] || [cx, f.z0];
      const end = { n: [cx, f.z0], s: [cx, f.z1], w: [f.x0, cz], e: [f.x1, cz] }[f.dir] || [cx, f.z1];
      const inset = 0.15;
      const dir = [Math.sign(end[0] - start[0]), Math.sign(end[1] - start[1])];
      path.push([start[0] + dir[0] * inset, start[1] + dir[1] * inset], [end[0] - dir[0] * (k === st.flights.length - 1 ? inset : 0), end[1] - dir[1] * (k === st.flights.length - 1 ? inset : 0)]);
    }
    if (st.landing) parts.push(<rect key="l" {...rectOf(st.landing)} fill="#faf9f5" stroke={LINE} strokeWidth={1} {...thin} />);
    // through the landing: the end of one flight to the start of the next
    const pts = path.map((p) => `${p[0]},${p[1]}`).join(' ');
    parts.push(<polyline key="a" points={pts} fill="none" stroke={INK} strokeWidth={1.2} {...thin} />);
    const [a, b] = path.slice(-2);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const head = 0.28;
    const tipPts = [b, [b[0] - head * Math.cos(ang - 0.45), b[1] - head * Math.sin(ang - 0.45)], [b[0] - head * Math.cos(ang + 0.45), b[1] - head * Math.sin(ang + 0.45)]];
    parts.push(<polygon key="h" points={tipPts.map((p) => p.join(',')).join(' ')} fill={INK} />);
    parts.push(<circle key="s" cx={path[0][0]} cy={path[0][1]} r={0.09} fill={INK} />);
    return <g key={`st${i}`} data-name={st.name} data-room={st.room}>{parts}</g>;
  });

  const wallsLayer = drawn.walls.map((b, i) => {
    const cut = b.y1 >= base + CUT;
    if (b.kind === 'glass') return <rect key={i} {...rectOf(b)} fill="#d8ecf8" stroke={GLASS} strokeWidth={1} {...thin} />;
    return <rect key={i} {...rectOf(b)} fill={cut ? (b.kind === 'stone' ? '#3b3733' : INK) : LOW} stroke="none" shapeRendering="crispEdges" />;
  });

  // windows: glass lines across the wall's thickness; doors: the leaf open at 90° and the arc it swings through
  const openingsLayer = plan.openings.filter((o) => o.lv === floor).map((o, i) => {
    // the wall's thickness here, from the wall pieces either side of the opening
    const side = drawn.walls.filter((w) => (o.wall === 'z' ? w.z0 <= o.at + 0.01 && w.z1 >= o.at - 0.01 && (Math.abs(w.x1 - o.from) < 0.05 || Math.abs(w.x0 - o.to) < 0.05)
      : w.x0 <= o.at + 0.01 && w.x1 >= o.at - 0.01 && (Math.abs(w.z1 - o.from) < 0.05 || Math.abs(w.z0 - o.to) < 0.05)));
    const lo = side.length ? Math.min(...side.map((w) => (o.wall === 'z' ? w.z0 : w.x0))) : o.at - 0.12;
    const hi = side.length ? Math.max(...side.map((w) => (o.wall === 'z' ? w.z1 : w.x1))) : o.at + 0.12;
    const r = o.wall === 'z' ? { x0: o.from, x1: o.to, z0: lo, z1: hi } : { x0: lo, x1: hi, z0: o.from, z1: o.to };
    if (o.kind === 'window') {
      const mid = (lo + hi) / 2;
      const glass = o.wall === 'z'
        ? [<line key="g" x1={o.from} y1={mid} x2={o.to} y2={mid} stroke={GLASS} strokeWidth={1.4} {...thin} />]
        : [<line key="g" x1={mid} y1={o.from} x2={mid} y2={o.to} stroke={GLASS} strokeWidth={1.4} {...thin} />];
      return (
        <g key={`o${i}`} data-name={o.name} data-room={o.room}>
          <rect {...rectOf(r)} fill="#fff" stroke={on(o.name) ? ACC : INK} strokeWidth={on(o.name) ? 2 : 0.8} {...thin} />
          {glass}
        </g>
      );
    }
    // the door swings into the room it belongs to
    const inward = { n: [0, 1], s: [0, -1], w: [1, 0], e: [-1, 0] }[o.side] || [0, 1];
    const face = inward[0] + inward[1] > 0 ? hi : lo; // the wall's face on the room's side
    const width = o.to - o.from;
    const leaves = width > 1.5 ? [[o.from, width / 2, 1], [o.to, width / 2, -1]] : [[o.from, width, 1]];
    const parts: ReactNode[] = [<rect key="gap" {...rectOf(r)} fill="#fff" stroke="none" />];
    for (const [k, [at, len, sign]] of leaves.entries()) {
      const hinge = o.wall === 'z' ? [at, face] : [face, at];
      const tipP = [hinge[0] + inward[0] * len, hinge[1] + inward[1] * len];
      const jamb = o.wall === 'z' ? [at + sign * len, face] : [face, at + sign * len];
      const v1 = [tipP[0] - hinge[0], tipP[1] - hinge[1]];
      const v2 = [jamb[0] - hinge[0], jamb[1] - hinge[1]];
      const sweep = v1[0] * v2[1] - v1[1] * v2[0] > 0 ? 1 : 0;
      parts.push(<line key={`l${k}`} x1={hinge[0]} y1={hinge[1]} x2={tipP[0]} y2={tipP[1]} stroke={on(o.name) ? ACC : INK} strokeWidth={1.6} {...thin} />);
      parts.push(<path key={`a${k}`} d={`M ${tipP[0]} ${tipP[1]} A ${len} ${len} 0 0 ${sweep} ${jamb[0]} ${jamb[1]}`} fill="none" stroke={LINE} strokeWidth={0.7} strokeDasharray="3 2" {...thin} />);
    }
    return <g key={`o${i}`} data-name={o.name} data-room={o.room}>{parts}</g>;
  });

  // a blocking's people (a dot with the way they face) and the cameras of this floor with what they take in
  const peopleLayer = built.people.filter((p) => p.lv === floor).map((p, i) => (
    <g key={`p${i}`} data-name={p.name}>
      {p.facing ? <polygon points={[[p.x + p.facing[0] * 0.48, p.z + p.facing[1] * 0.48], [p.x - p.facing[1] * 0.2, p.z + p.facing[0] * 0.2], [p.x + p.facing[1] * 0.2, p.z - p.facing[0] * 0.2]].map((q) => q.join(',')).join(' ')} fill="#c4553f" /> : null}
      <circle cx={p.x} cy={p.z} r={0.24} fill="#c4553f" stroke="#fff" strokeWidth={1.5} {...thin} />
    </g>
  ));
  // a blocking's cameras show what they take in; the scene's own cameras only where they stand and look
  const camerasLayer = built.cameras.filter((c) => c.pos[1] >= base - 0.5 && c.pos[1] < base + H).map((c, i) => {
    const dx = c.target[0] - c.pos[0];
    const dz = c.target[2] - c.pos[2];
    const ang = Math.atan2(dz, dx);
    if (!c.setup) {
      return (
        <g key={`c${i}`} data-name={`机位：${c.name}`}>
          <line x1={c.pos[0]} y1={c.pos[2]} x2={c.pos[0] + 0.6 * Math.cos(ang)} y2={c.pos[2] + 0.6 * Math.sin(ang)} stroke="#2f6fd0" strokeWidth={1.5} {...thin} />
          <circle cx={c.pos[0]} cy={c.pos[2]} r={0.12} fill="#2f6fd0" />
        </g>
      );
    }
    const len = Math.min(Math.max(Math.hypot(dx, dz) + 0.6, 1.5), 5);
    const half = Math.atan(Math.tan(((c.fov || 50) * Math.PI) / 360) * (16 / 9));
    const a = [c.pos[0] + len * Math.cos(ang - half), c.pos[2] + len * Math.sin(ang - half)];
    const b = [c.pos[0] + len * Math.cos(ang + half), c.pos[2] + len * Math.sin(ang + half)];
    return (
      <g key={`c${i}`} data-name={`机位：${c.name}`}>
        <polygon points={[[c.pos[0], c.pos[2]], a, b].map((q) => q.join(',')).join(' ')} fill="#2f6fd00d" stroke="#2f6fd055" strokeWidth={1} {...thin} />
        <circle cx={c.pos[0]} cy={c.pos[2]} r={0.12} fill="#2f6fd0" />
      </g>
    );
  });

  // names in screen space, so they stay readable at any zoom: rooms always, furniture once there is room for it
  const textLayer: ReactNode[] = [];
  if (labels) {
    for (const r of drawn.roomsHere) {
      const w = (r.x[1] - r.x[0]) * s;
      if (w < 28) continue;
      textLayer.push(<text key={`r${r.name}`} x={px((r.x[0] + r.x[1]) / 2)} y={py((r.z[0] + r.z[1]) / 2)} className="plan-room">{w < r.name.length * 13 ? r.name.slice(0, Math.max(1, Math.floor(w / 13))) : r.name}</text>);
    }
    if (s > 45) {
      for (const [i, b] of drawn.things.entries()) {
        const w = Math.max(b.x1 - b.x0, b.z1 - b.z0) * s;
        if (w < 40) continue;
        const name = b.name.replace(/^\S+\s/, '').replace(/（.*?）/g, '');
        textLayer.push(<text key={`t${i}`} x={px((b.x0 + b.x1) / 2)} y={py((b.z0 + b.z1) / 2)} className="plan-thing">{name.length * 10 > w ? `${name.slice(0, Math.max(1, Math.floor(w / 10) - 1))}…` : name}</text>);
      }
    }
    for (const [i, p] of built.people.filter((q) => q.lv === floor).entries()) {
      textLayer.push(<text key={`p${i}`} x={px(p.x)} y={py(p.z) - 0.4 * s - 4} className="plan-person">{p.name}</text>);
    }
  }

  // a scale bar of a round length about 100 px long
  const metres = [1, 2, 5, 10, 20, 50].find((m) => m * s >= 70) || 50;

  return (
    <div className="scene-plan" ref={host} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
      onPointerLeave={() => { if (tip.current) tip.current.style.display = 'none'; }}>
      <svg width={size.w} height={size.h}>
        <g transform={`translate(${tx} ${ty}) scale(${s})`}>
          {grid}
          {floorsLayer}
          {thingsLayer}
          {roundLayer}
          {stairsLayer}
          {wallsLayer}
          {openingsLayer}
          {camerasLayer}
          {peopleLayer}
        </g>
        {textLayer}
        <g transform={`translate(${size.w - 24 - metres * s} ${size.h - 30})`} className="plan-scale">
          <rect x={0} y={0} width={metres * s / 2} height={5} fill={INK} />
          <rect x={metres * s / 2} y={0} width={metres * s / 2} height={5} fill="#fff" stroke={INK} strokeWidth={1} />
          <text x={0} y={-5}>0</text>
          <text x={metres * s} y={-5}>{metres} 米</text>
        </g>
        <g transform={`translate(${size.w - 30} 34)`} className="plan-north">
          <polygon points="0,-16 7,6 0,1 -7,6" fill={INK} />
          <text x={0} y={22}>北</text>
        </g>
      </svg>
      <div className="scene-tip" ref={tip} />
    </div>
  );
}
