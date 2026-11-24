// A whitebox scene (a building and its surroundings) as plain data, turned into boxes to draw and checked for
// mistakes. The data is what an LLM writes; everything spatial that is easy to get wrong (cutting doors out of
// walls, stairs, floors and ceilings, who can see whom) is worked out here, so a weak model only fills in numbers.
// Plain Node, no Electron.
//
// Units are metres. x grows to the east, z to the south, y upwards. lv is the floor (0 = ground); a floor is
// levelHeight high. A room is a rectangle (x: [west, east], z: [north, south]) whose walls run along its sides;
// two rooms side by side share a wall. Doors, windows and furniture are given relative to their room's
// north-west corner; a negative number counts back from the far side (x: [-0.6, -0.1] is against the east wall).

const SIDES = ['n', 's', 'w', 'e'];
const SIDE_NAME = { n: '北墙', s: '南墙', w: '西墙', e: '东墙' };
const KINDS = ['wood', 'metal', 'dark', 'bed', 'soft', 'gold', 'blue', 'green', 'rope', 'white', 'red', 'car', 'pink',
  'stone', 'shed', 'lamp', 'rock', 'gravel', 'road', 'mountain', 'grass', 'water', 'flags', 'glass', 'snow'];
const WALLS = ['plain', 'stone', 'glass', 'wood', 'none'];
const LEVEL_NAMES = ['一楼', '二楼', '三楼', '四楼', '五楼', '六楼', '七楼', '八楼'];
const levelName = (lv) => (lv >= 0 && lv < LEVEL_NAMES.length ? LEVEL_NAMES[lv] : `${lv + 1} 楼`);

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const pair = (v) => Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]);
const triple = (v) => Array.isArray(v) && v.length === 3 && v.every(num);
const round = (v) => Math.round(v * 100) / 100;
// a room-relative number: negative counts back from the far side
const rel = (v, size) => (v < 0 ? size + v : v);

function emptyScene(name = '新场景') {
  return { version: 1, name, code: '', levelHeight: 3, rooms: [], templates: {}, outdoor: [], slopes: [], lines: [], labels: [], people: [], cameras: [], setups: [] };
}

// Template items first, then the room's own (an own item with the same name replaces the template's).
function itemsOf(room, templates, key) {
  const own = Array.isArray(room[key]) ? room[key] : [];
  const tpl = room.tpl && templates && templates[room.tpl] && Array.isArray(templates[room.tpl][key]) ? templates[room.tpl][key] : [];
  const mine = new Set(own.map((i) => i && i.name));
  return [...tpl.filter((i) => i && !mine.has(i.name)).map((i) => ({ ...i, name: `${room.name} ${i.name}`, fromTpl: true })), ...own];
}

// A room's door or window as a piece of wall line: { lv, wall: 'z' | 'x', at, from, to, ... } in scene coordinates.
function openingAbs(room, o) {
  const [x1, x2] = room.x;
  const [z1, z2] = room.z;
  const w = x2 - x1;
  const d = z2 - z1;
  const along = o.side === 'n' || o.side === 's';
  const size = along ? w : d;
  const a = rel(o.from, size);
  const b = rel(o.to, size);
  const base = along ? x1 : z1;
  return {
    lv: room.lv, wall: along ? 'z' : 'x', at: o.side === 'n' ? z1 : o.side === 's' ? z2 : o.side === 'w' ? x1 : x2,
    from: base + Math.min(a, b), to: base + Math.max(a, b), sill: num(o.sill) ? o.sill : 0, top: num(o.top) ? o.top : 2.1,
    kind: o.kind === 'window' ? 'window' : 'door', name: o.name || (o.kind === 'window' ? '窗' : '门'), room: room.name, side: o.side,
  };
}

function furnitureAbs(room, f, levelHeight) {
  const [x1, x2] = room.x;
  const [z1, z2] = room.z;
  const base = room.lv * levelHeight;
  const xs = [x1 + rel(f.x[0], x2 - x1), x1 + rel(f.x[1], x2 - x1)].sort((a, b) => a - b);
  const zs = [z1 + rel(f.z[0], z2 - z1), z1 + rel(f.z[1], z2 - z1)].sort((a, b) => a - b);
  const [ya, yb] = pair(f.y) ? f.y : [0, num(f.h) ? f.h : 0.8];
  return { x0: xs[0], x1: xs[1], z0: zs[0], z1: zs[1], y0: base + ya, y1: base + yb };
}

const overlap1 = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);
const near = (a, b) => Math.abs(a - b) < 0.05;

// Solid pieces of a wall of length len and height h with holes { a, b, sill, top } along it.
function wallPieces(len, h, holes) {
  const out = [];
  let at = 0;
  const cut = holes.map((o) => ({ ...o, a: Math.max(0, o.a), b: Math.min(len, o.b) })).filter((o) => o.b > o.a).sort((p, q) => p.a - q.a);
  for (const o of cut) {
    if (o.a > at) out.push({ a: at, b: o.a, y0: 0, y1: h });
    if (o.sill > 0) out.push({ a: Math.max(o.a, at), b: o.b, y0: 0, y1: Math.min(o.sill, h) });
    if (o.top < h) out.push({ a: Math.max(o.a, at), b: o.b, y0: o.top, y1: h });
    at = Math.max(at, o.b);
  }
  if (at < len) out.push({ a: at, b: len, y0: 0, y1: h });
  return out.filter((p) => p.b - p.a > 0.005 && p.y1 - p.y0 > 0.005);
}

// A stair's flights in scene coordinates: [{ x0, x1, z0, z1, y0, y1, dir, steps }] and the landing between them
// (null for a straight stair). dir is the way it climbs (n / s / w / e). A turning stair (a switchback) climbs
// half the height along one half of its footprint to a landing at the far end, then the other half back, so it
// arrives above where it started and the same stair on the floor above carries on from there.
const STEP = 0.18;
function stairFlights(a, dir, turn) {
  const along = dir === 'e' || dir === 'w' ? 'x' : dir === 'n' || dir === 's' ? 'z' : a.x1 - a.x0 > a.z1 - a.z0 ? 'x' : 'z';
  const up = dir === 'n' || dir === 'w' ? -1 : 1;
  const way = (sign) => (along === 'x' ? (sign > 0 ? 'e' : 'w') : (sign > 0 ? 's' : 'n'));
  const [l0, l1] = along === 'x' ? [a.x0, a.x1] : [a.z0, a.z1];
  const [c0, c1] = along === 'x' ? [a.z0, a.z1] : [a.x0, a.x1];
  const box = (s0, s1, t0, t1) => (along === 'x' ? { x0: s0, x1: s1, z0: t0, z1: t1 } : { x0: t0, x1: t1, z0: s0, z1: s1 });
  const rise = a.y1 - a.y0;
  const flight = (s0, s1, t0, t1, y0, y1, sign) => ({ ...box(s0, s1, t0, t1), y0, y1, dir: way(sign), steps: Math.max(2, Math.round((y1 - y0) / STEP)) });
  if (!turn || c1 - c0 < 1.2) return { flights: [flight(l0, l1, c0, c1, a.y0, a.y1, up)], landing: null };
  const cm = (c0 + c1) / 2;
  const depth = Math.min(Math.max((c1 - c0) / 2, 0.9), (l1 - l0) * 0.35);
  const mid = a.y0 + rise / 2;
  // the landing is at the far end of the way up; the first flight runs to it, the second runs back
  const [r0, r1, g0, g1] = up > 0 ? [l0, l1 - depth, l1 - depth, l1] : [l0 + depth, l1, l0, l0 + depth];
  return {
    flights: [flight(r0, r1, c0, cm, a.y0, mid, up), flight(r0, r1, cm, c1, mid, a.y1, -up)],
    landing: { ...box(g0, g1, c0, c1), y0: a.y0, y1: mid },
  };
}

// A rectangle with another one cut out of it, as up to four rectangles ({ x0, x1, z0, z1 }).
function cutRect(r, h) {
  if (h.x0 >= r.x1 || h.x1 <= r.x0 || h.z0 >= r.z1 || h.z1 <= r.z0) return [r];
  const x0 = Math.max(r.x0, h.x0);
  const x1 = Math.min(r.x1, h.x1);
  return [
    { x0: r.x0, x1: r.x1, z0: r.z0, z1: Math.max(r.z0, h.z0) },
    { x0: r.x0, x1: r.x1, z0: Math.min(r.z1, h.z1), z1: r.z1 },
    { x0: r.x0, x1: x0, z0: Math.max(r.z0, h.z0), z1: Math.min(r.z1, h.z1) },
    { x0: x1, x1: r.x1, z0: Math.max(r.z0, h.z0), z1: Math.min(r.z1, h.z1) },
  ].filter((p) => p.x1 - p.x0 > 0.01 && p.z1 - p.z0 > 0.01);
}

// An outside wall is at least this thick: the extra goes on the outside of the room, so nothing inside moves.
const OUTSIDE_WALL = 0.25;

const usableRoom = (r) =>r && typeof r.name === 'string' && num(r.lv) && pair(r.x) && pair(r.z) && r.x[1] > r.x[0] && r.z[1] > r.z[0];
const usableItem = (f) => f && pair(f.x) && pair(f.z) && (pair(f.y) || num(f.h) || f.h === undefined);

// Everything to draw: { boxes, cyls, people, lines, slopes, labels, cameras, levels }. A box is
// { x0, x1, y0, y1, z0, z1, kind, name, group, solid, edges }; group is the floor it belongs to ('outdoor' outside):
// showing floor L shows the groups up to L. With { setup: name }, that blocking's people (with pose and facing)
// and cameras are drawn too.
function buildScene(scene, { setup } = {}) {
  const H = num(scene.levelHeight) && scene.levelHeight > 1 ? scene.levelHeight : 3;
  const rooms = (scene.rooms || []).filter(usableRoom);
  const boxes = [];
  const cyls = [];
  const labels = [];
  const add = (b) => { boxes.push({ edges: true, solid: true, ...b }); };

  const openings = [];
  for (const r of rooms) {
    for (const o of itemsOf(r, scene.templates, 'openings')) {
      if (o && SIDES.includes(o.side) && num(o.from) && num(o.to)) openings.push(openingAbs(r, o));
    }
  }

  // every stair first: a stair stacked on the same stair of the next floor turns at a landing (unless it says
  // turn: false), and the floor above it is opened over it
  const stairs = [];
  for (const r of rooms) {
    for (const f of itemsOf(r, scene.templates, 'furniture')) {
      if (usableItem(f) && f.shape === 'stairs') stairs.push({ r, f, a: furnitureAbs(r, f, H) });
    }
  }
  const sameSpot = (p, q) => near(p.a.x0, q.a.x0) && near(p.a.x1, q.a.x1) && near(p.a.z0, q.a.z0) && near(p.a.z1, q.a.z1);
  for (const s of stairs) {
    const stacked = stairs.some((o) => o !== s && Math.abs(o.r.lv - s.r.lv) === 1 && sameSpot(o, s) && (o.f.dir || '') === (s.f.dir || ''));
    Object.assign(s, stairFlights(s.a, s.f.dir, s.f.turn === true || (s.f.turn !== false && stacked)));
  }
  const planStairs = [];
  const planRooms = [];
  const planOpenings = openings.map((o) => ({ ...o }));

  let top = 0;
  for (const r of rooms) {
    const [x1, x2] = r.x;
    const [z1, z2] = r.z;
    const y = r.lv * H;
    const h = num(r.h) && r.h > 0 ? r.h : H;
    const wall = WALLS.includes(r.wall) ? r.wall : 'plain';
    const t = num(r.t) ? r.t : wall === 'stone' ? 0.35 : wall === 'glass' ? 0.04 : 0.1;
    const open = new Set(Array.isArray(r.open) ? r.open : []);
    top = Math.max(top, r.lv);
    planRooms.push({ name: r.name, lv: r.lv, x: [x1, x2], z: [z1, z2], outdoor: !!r.outdoor, wall, open: [...open] });
    if (!r.outdoor && r.floor !== 'none') {
      const glass = r.floor === 'glass';
      // the floor of a room over a stair has the stairwell left open
      let parts = [{ x0: x1, x1: x2, z0: z1, z1: z2 }];
      for (const s of stairs.filter((x) => x.r.lv === r.lv - 1)) parts = parts.flatMap((p) => cutRect(p, s.a));
      for (const p of parts) {
        add({ ...p, y0: y - (r.lv > 0 ? (glass ? 0.08 : 0.3) : 0.04), y1: y + 0.01,
          kind: glass ? 'glass' : r.tpl ? 'guestFloor' : /走廊|楼梯|过道/.test(r.name) ? 'corridor' : 'floor',
          name: r.name, group: r.lv, floor: true, edges: false, solid: !glass });
      }
    }
    // a ceiling where nothing stands on top of the room
    const covered = rooms.some((o) => o.lv === r.lv + 1 && o.x[0] <= (x1 + x2) / 2 && o.x[1] >= (x1 + x2) / 2 && o.z[0] <= (z1 + z2) / 2 && o.z[1] >= (z1 + z2) / 2);
    if (!covered && !r.outdoor && wall !== 'none' && wall !== 'glass' && h >= 2 && r.ceiling !== false) {
      add({ x0: x1, x1: x2, y0: y + h - 0.01, y1: y + h + 0.2, z0: z1, z1: z2, kind: 'roof', name: `${r.name}的顶`, group: r.lv + 1 });
    }
    if (wall !== 'none') {
      const sides = [
        { k: 'n', wall: 'z', line: z1, from: x1, len: x2 - x1, place: (p) => [x1 + p.a, x1 + p.b, z1, z1 + t] },
        { k: 's', wall: 'z', line: z2, from: x1, len: x2 - x1, place: (p) => [x1 + p.a, x1 + p.b, z2 - t, z2] },
        { k: 'w', wall: 'x', line: x1, from: z1 + t, len: z2 - z1 - 2 * t, place: (p) => [x1, x1 + t, z1 + t + p.a, z1 + t + p.b] },
        { k: 'e', wall: 'x', line: x2, from: z1 + t, len: z2 - z1 - 2 * t, place: (p) => [x2 - t, x2, z1 + t + p.a, z1 + t + p.b] },
      ];
      // a side with no room of this floor behind it is an outside wall: it is thickened outwards
      const behind = (k, mid) => rooms.some((o) => o !== r && o.lv === r.lv && !o.outdoor && (
        k === 'n' ? near(o.z[1], z1) && o.x[0] < mid && o.x[1] > mid
          : k === 's' ? near(o.z[0], z2) && o.x[0] < mid && o.x[1] > mid
            : k === 'w' ? near(o.x[1], x1) && o.z[0] < mid && o.z[1] > mid
              : near(o.x[0], x2) && o.z[0] < mid && o.z[1] > mid));
      const extra = r.outdoor || wall === 'glass' ? 0 : Math.max(0, OUTSIDE_WALL - t);
      for (const s of sides) {
        if (open.has(s.k)) continue;
        const holes = openings.filter((o) => o.lv === r.lv && o.wall === s.wall && near(o.at, s.line))
          .map((o) => ({ a: o.from - s.from, b: o.to - s.from, sill: o.sill, top: o.top }));
        for (const p of wallPieces(s.len, h, holes)) {
          let [ax, bx, az, bz] = s.place(p);
          if (extra && !behind(s.k, s.from + (p.a + p.b) / 2)) {
            if (s.k === 'n') az -= extra;
            else if (s.k === 's') bz += extra;
            else if (s.k === 'w') ax -= extra;
            else bx += extra;
            // the corners: a north or south wall reaches over the thickened west and east walls
            if (s.wall === 'z' && p.a < 0.01) ax -= extra;
            if (s.wall === 'z' && p.b > s.len - 0.01) bx += extra;
          }
          add({ x0: ax, x1: bx, y0: y + p.y0, y1: y + p.y1, z0: az, z1: bz, kind: wall === 'plain' ? 'wall' : wall, name: '', room: r.name, group: r.outdoor ? 'outdoor' : r.lv, wall: true, solid: wall !== 'glass', edges: wall !== 'glass' });
        }
      }
    }
    if (r.label !== false) labels.push({ text: r.name, at: [round((x1 + x2) / 2), round(y + Math.min(1.3, h * 0.6)), round((z1 + z2) / 2)], lv: r.outdoor ? -1 : r.lv });

    for (const f of itemsOf(r, scene.templates, 'furniture')) {
      if (!usableItem(f)) continue;
      const a = furnitureAbs(r, f, H);
      const group = r.outdoor ? 'outdoor' : r.lv;
      const kind = KINDS.includes(f.kind) ? f.kind : 'wood';
      if (f.shape === 'cyl') cyls.push({ ...a, kind, name: f.name || '', group, room: r.name });
      else if (f.shape === 'stairs') {
        const s = stairs.find((x) => x.f === f && x.r === r);
        const name = f.name || '楼梯';
        planStairs.push({ name, lv: r.lv, room: r.name, ...a, flights: s.flights, landing: s.landing });
        // each step a solid block from the floor up, numbered from the bottom of its flight
        for (const fl of s.flights) {
          const along = fl.dir === 'e' || fl.dir === 'w' ? 'x' : 'z';
          const back = fl.dir === 'n' || fl.dir === 'w';
          const run = (along === 'x' ? fl.x1 - fl.x0 : fl.z1 - fl.z0) / fl.steps;
          for (let i = 0; i < fl.steps; i++) {
            const k = back ? fl.steps - 1 - i : i;
            const s0 = (along === 'x' ? fl.x0 : fl.z0) + k * run;
            add({
              x0: along === 'x' ? s0 : fl.x0, x1: along === 'x' ? s0 + run : fl.x1, z0: along === 'z' ? s0 : fl.z0, z1: along === 'z' ? s0 + run : fl.z1,
              y0: a.y0, y1: fl.y0 + ((i + 1) * (fl.y1 - fl.y0)) / fl.steps, kind: 'corridor', name, group, edges: i % 3 === 0,
            });
          }
        }
        if (s.landing) add({ ...s.landing, kind: 'corridor', name, group });
      // hollow: a shed or a cupboard that other things stand in; it does not block the view either
      } else add({ ...a, kind, name: f.name || '', group, furniture: true, room: r.name, solid: !f.hollow });
    }
  }

  // glass in the windows; doors are invisible boxes that only carry a name
  for (const o of openings) {
    const y = o.lv * H;
    const [x0, x1, z0, z1] = o.wall === 'z' ? [o.from, o.to, o.at - 0.02, o.at + 0.02] : [o.at - 0.02, o.at + 0.02, o.from, o.to];
    add({ x0, x1, y0: y + o.sill, y1: y + o.top, z0, z1, kind: o.kind === 'window' ? 'glass' : 'door', name: o.name, group: o.lv, edges: false, solid: false, opening: true, room: o.room });
  }

  for (const b of scene.outdoor || []) {
    if (!b || !pair(b.x) || !pair(b.y) || !pair(b.z)) continue;
    const item = { x0: Math.min(...b.x), x1: Math.max(...b.x), y0: Math.min(...b.y), y1: Math.max(...b.y), z0: Math.min(...b.z), z1: Math.max(...b.z),
      kind: KINDS.includes(b.kind) ? b.kind : 'rock', name: b.name || '', group: 'outdoor' };
    if (b.shape === 'cyl') cyls.push(item);
    else add({ ...item, edges: (item.x1 - item.x0) < 40 && (item.z1 - item.z0) < 40 });
  }
  for (const l of scene.labels || []) if (l && l.text && triple(l.at)) labels.push({ text: String(l.text), at: l.at, lv: -1 });

  const people = (scene.people || []).filter((p) => p && p.name && num(p.lv) && num(p.x) && num(p.z))
    .map((p) => ({ name: p.name, lv: p.lv, x: p.x, z: p.z, y: p.lv * H + (num(p.y) ? p.y : 0) }));
  const lines = (scene.lines || []).filter((l) => l && triple(l.from) && triple(l.to))
    .map((l) => ({ name: l.name || '', from: l.from, to: l.to, radius: num(l.radius) ? l.radius : 0.04, kind: KINDS.includes(l.kind) ? l.kind : 'dark' }));
  const slopes = (scene.slopes || []).filter((s) => s && pair(s.from) && pair(s.to) && pair(s.z))
    .map((s) => ({ name: s.name || '', from: s.from, to: s.to, z: s.z, kind: KINDS.includes(s.kind) ? s.kind : 'road' }));
  const cameras = (scene.cameras || []).filter((c) => c && c.name && triple(c.pos) && triple(c.target))
    .map((c) => ({ name: c.name, pos: c.pos, target: c.target, fov: num(c.fov) ? c.fov : 50, see: Array.isArray(c.see) ? c.see : [] }));
  // what a floor plan draws besides the boxes: the rooms, the doors and windows, and the stairs with their flights
  const plan = { rooms: planRooms, openings: planOpenings, stairs: planStairs };
  const built = { boxes, cyls, people, lines, slopes, labels, cameras, levels: top + 1, levelHeight: H, plan };
  const chosen = setup && (scene.setups || []).find((x) => x && x.name === setup);
  if (chosen) {
    const r = require('./scene-blocking').resolveSetup(scene, chosen, built); // eslint-disable-line global-require
    for (const p of r.people) people.push({ name: p.name, lv: p.lv, x: p.x, z: p.z, y: p.y, pose: p.pose, facing: p.facing, setup: r.name });
    for (const c of r.cameras) cameras.push({ name: c.name, pos: c.pos, target: c.target, fov: c.fov, see: [], card: c.card, shots: c.shots, setup: r.name });
  }
  return built;
}

// ---------- checks ----------
// Segment p→q against an axis-aligned box (slab method): the fraction along the segment where it enters, or -1.
function hitBox(p, q, b) {
  let t0 = 0;
  let t1 = 1;
  const lo = [b.x0, b.y0, b.z0];
  const hi = [b.x1, b.y1, b.z1];
  for (let i = 0; i < 3; i++) {
    const d = q[i] - p[i];
    if (Math.abs(d) < 1e-9) {
      if (p[i] <= lo[i] || p[i] >= hi[i]) return -1;
      continue;
    }
    let a = (lo[i] - p[i]) / d;
    let c = (hi[i] - p[i]) / d;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 >= t1) return -1;
  }
  return t0;
}
const inside = (pt, b, pad = 0) => pt[0] > b.x0 - pad && pt[0] < b.x1 + pad && pt[1] > b.y0 - pad && pt[1] < b.y1 + pad && pt[2] > b.z0 - pad && pt[2] < b.z1 + pad;

// A named thing a camera must see: { points, own } — points on it (seeing any one of them counts) and which boxes
// are the thing itself. A person: head and chest. A room: its middle and just outside each of its walls and its
// top, so a roof or a yard counts as seen when its edge is. A thing or a rope: its middle and its top.
function targetOf(name, built, scene) {
  // the exact name first, then one that starts with it, then one that has it somewhere
  const tests = [(n) => n === name, (n) => !!n && n.startsWith(name), (n) => !!n && n.includes(name)];
  const find = (list) => { for (const t of tests) { const hit = list.find((x) => t(x.name)); if (hit) return hit; } return undefined; };
  const p = find(built.people);
  if (p) return { points: [[p.x, p.y + 1.55, p.z], [p.x, p.y + 1.1, p.z]], own: (b) => b.name === p.name };
  const room = find((scene.rooms || []).filter(usableRoom));
  if (room) {
    const y0 = room.lv * built.levelHeight;
    const y1 = y0 + (num(room.h) ? room.h : built.levelHeight);
    const [x1, x2] = room.x;
    const [z1, z2] = room.z;
    const mx = (x1 + x2) / 2;
    const my = (y0 + y1) / 2;
    const mz = (z1 + z2) / 2;
    const out = 0.3;
    return {
      points: [[mx, my, mz], [x1 - out, my, mz], [x2 + out, my, mz], [mx, my, z1 - out], [mx, my, z2 + out], [mx, y1 + out, mz],
        [x1 + 0.3, y1 + out, z1 + 0.3], [x2 - 0.3, y1 + out, z2 - 0.3], [x1 + 0.3, y1 + out, z2 - 0.3], [x2 - 0.3, y1 + out, z1 + 0.3]],
      own: (b) => b.room === room.name || b.name === room.name,
    };
  }
  const b = find(built.boxes.filter((x) => !x.floor)) || find(built.cyls);
  if (b) {
    const mx = (b.x0 + b.x1) / 2;
    const mz = (b.z0 + b.z1) / 2;
    return { points: [[mx, (b.y0 + b.y1) / 2, mz], [mx, b.y1 + 0.05, mz]], own: (x) => x.name === b.name };
  }
  const l = find(built.lines);
  if (l) {
    const at = (t) => l.from.map((v, i) => v + (l.to[i] - v) * t);
    return { points: [0.1, 0.3, 0.5, 0.7, 0.9].map(at), own: () => false };
  }
  return null;
}

// What stands between a camera and a point (the first solid box on the way), or null when it can be seen.
function blocker(from, to, built, ignore) {
  const solid = built.boxes.filter((b) => b.solid && !ignore(b) && !inside(from, b, 0.01) && !inside(to, b, 0.01));
  let best = null;
  for (const b of solid) {
    const t = hitBox(from, to, b);
    if (t >= 0 && t < 0.995 && (!best || t < best.t)) best = { t, b };
  }
  return best && best.b;
}

const describe = (b) => (b.name ? `「${b.name}」` : b.wall ? '一面墙' : b.floor ? '楼板' : b.kind === 'roof' ? '屋顶' : '一个东西');

// Problems a person would want fixed: { level: 'error' | 'warn', where, message }. Errors are things that cannot be
// right (a bed through a wall, two rooms in the same place); warnings are worth a look (furniture in front of a door).
function checkScene(scene) {
  const out = [];
  const err = (where, message) => out.push({ level: 'error', where, message });
  const warn = (where, message) => out.push({ level: 'warn', where, message });
  if (!scene || typeof scene !== 'object') return [{ level: 'error', where: '场景', message: '不是一个场景' }];
  const H = scene.levelHeight;
  if (!num(H) || H < 2 || H > 8) err('场景', `层高 levelHeight 要在 2 到 8 米之间（现在是 ${H}）`);
  const levelHeight = num(H) && H >= 2 ? H : 3;
  const rooms = Array.isArray(scene.rooms) ? scene.rooms : [];
  const names = new Map();
  for (const [i, r] of rooms.entries()) {
    const where = r && r.name ? `房间「${r.name}」` : `第 ${i + 1} 个房间`;
    if (!r || typeof r.name !== 'string' || !r.name.trim()) { err(where, '没有名字'); continue; }
    if (names.has(r.name)) err(where, '和另一个房间重名了，房间名字要唯一（同名的可以加楼层，比如「二楼楼梯」）');
    names.set(r.name, r);
    if (!num(r.lv) || r.lv < 0 || r.lv > 30 || Math.round(r.lv) !== r.lv) err(where, `楼层 lv 要是 0 起的整数（现在是 ${r.lv}）`);
    if (!pair(r.x) || !pair(r.z)) { err(where, 'x、z 要各是两个数：[西, 东]、[北, 南]'); continue; }
    if (r.x[1] <= r.x[0] || r.z[1] <= r.z[0]) { err(where, `范围反了：x 要从小到大、z 要从小到大（现在 x ${r.x}，z ${r.z}）`); continue; }
    const w = r.x[1] - r.x[0];
    const d = r.z[1] - r.z[0];
    if (Math.min(w, d) < 0.8 && r.wall !== 'none') warn(where, `只有 ${round(Math.min(w, d))} 米宽，人进不去`);
    if (r.tpl && !(scene.templates && scene.templates[r.tpl])) err(where, `用了模板「${r.tpl}」，可是 templates 里没有它`);
    if (r.wall !== undefined && !WALLS.includes(r.wall)) warn(where, `wall 只能是 ${WALLS.join(' / ')}`);
    const h = num(r.h) ? r.h : levelHeight;
    // a yard, a roof behind a low parapet, a glass deck: nothing overhead, so things may stand taller than the walls
    const openAir = !!r.outdoor || r.wall === 'none' || r.wall === 'glass' || h < 2;

    for (const o of itemsOf(r, scene.templates, 'openings')) {
      const ow = `${where}的${o && o.name ? `「${o.name}」` : '门窗'}`;
      if (!o || !SIDES.includes(o.side)) { err(ow, 'side 要是 n / s / w / e（北南西东）'); continue; }
      if (!num(o.from) || !num(o.to)) { err(ow, 'from、to 要是数'); continue; }
      const size = o.side === 'n' || o.side === 's' ? w : d;
      const a = rel(o.from, size);
      const b = rel(o.to, size);
      if (b <= a) err(ow, `from 要小于 to（换算后 ${round(a)} 到 ${round(b)}）`);
      else if (a < -0.05 || b > size + 0.05) err(ow, `开到墙外面去了：${SIDE_NAME[o.side]}只有 ${round(size)} 米长，这扇开在 ${round(a)} 到 ${round(b)}`);
      const top = num(o.top) ? o.top : 2.1;
      const sill = num(o.sill) ? o.sill : 0;
      if (top > h + 0.01) err(ow, `比房间还高（顶 ${top} 米，房间高 ${round(h)} 米）`);
      if (sill >= top) err(ow, '窗台 sill 要比顶 top 低');
      if (o.kind !== 'window' && sill > 0.05) warn(ow, `门的 sill 应该是 0（现在是 ${sill}），不然就是窗了`);
      if (o.kind !== 'window' && b - a < 0.6 && b > a) warn(ow, `门只有 ${round(b - a)} 米宽，人过不去`);
      if (Array.isArray(r.open) && r.open.includes(o.side)) warn(ow, `开在${SIDE_NAME[o.side]}上，可这一面设成了没有墙（open）`);
    }

    const items = itemsOf(r, scene.templates, 'furniture');
    const placed = [];
    for (const f of items) {
      const fw = `${where}的${f && f.name ? `「${f.name}」` : '家具'}`;
      if (!f || !pair(f.x) || !pair(f.z)) { err(fw, 'x、z 要各是两个数（相对房间西北角，负数从东边、南边往回数）'); continue; }
      if (!pair(f.y) && !num(f.h)) { err(fw, '要有高度 h，或者 y: [离地, 顶]'); continue; }
      const a = furnitureAbs(r, f, levelHeight);
      if (a.x1 - a.x0 < 0.02 || a.z1 - a.z0 < 0.02 || a.y1 - a.y0 < 0.01) { err(fw, '大小是 0（两个数一样，或者正负号写反了）'); continue; }
      if (f.kind !== undefined && !KINDS.includes(f.kind)) warn(fw, `kind「${f.kind}」不认识，会按 wood 画`);
      const out1 = a.x0 < r.x[0] - 0.05 || a.x1 > r.x[1] + 0.05 || a.z0 < r.z[0] - 0.05 || a.z1 > r.z[1] + 0.05;
      if (out1 && !f.outside) err(fw, `出了房间：房间是 ${round(w)}×${round(d)} 米，它在 x ${round(a.x0 - r.x[0])}–${round(a.x1 - r.x[0])}、z ${round(a.z0 - r.z[0])}–${round(a.z1 - r.z[0])}（伸到墙外的东西，比如阳台，要写 outside: true）`);
      if (a.y1 - r.lv * levelHeight > h + 0.01 && !f.outside && !openAir) err(fw, `比房间还高（${round(a.y1 - r.lv * levelHeight)} 米，房间高 ${round(h)} 米）`);
      for (const p of placed) {
        const ox = overlap1(a.x0, a.x1, p.a.x0, p.a.x1);
        const oz = overlap1(a.z0, a.z1, p.a.z0, p.a.z1);
        const oy = overlap1(a.y0, a.y1, p.a.y0, p.a.y1);
        if (ox > 0.05 && oz > 0.05 && oy > 0.02) err(fw, `和「${p.name}」叠在一起了（重叠 ${round(ox)}×${round(oz)} 米）；放在上面的东西用 y: [离地, 顶] 写高度`);
      }
      if (f.shape !== 'stairs' && !f.hollow) placed.push({ a, name: f.name || '家具' });
    }
    // a door with something right in front of it, on this room's side
    for (const o of itemsOf(r, scene.templates, 'openings').filter((x) => x && x.kind !== 'window' && SIDES.includes(x.side) && num(x.from) && num(x.to))) {
      const ab = openingAbs(r, o);
      const depth = 0.6;
      const zone = ab.wall === 'z'
        ? { x0: ab.from, x1: ab.to, z0: o.side === 'n' ? ab.at : ab.at - depth, z1: o.side === 'n' ? ab.at + depth : ab.at }
        : { z0: ab.from, z1: ab.to, x0: o.side === 'w' ? ab.at : ab.at - depth, x1: o.side === 'w' ? ab.at + depth : ab.at };
      for (const p of placed) {
        if (p.a.y0 - r.lv * levelHeight > 1.6) continue;
        if (overlap1(zone.x0, zone.x1, p.a.x0, p.a.x1) > 0.1 && overlap1(zone.z0, zone.z1, p.a.z0, p.a.z1) > 0.1) {
          warn(`${where}的「${o.name || '门'}」`, `「${p.name}」挡在门口`);
        }
      }
    }
    const hasDoor = itemsOf(r, scene.templates, 'openings').some((o) => o && o.kind !== 'window');
    const openSide = Array.isArray(r.open) && r.open.length;
    const stairs = items.some((f) => f && f.shape === 'stairs') || /楼梯/.test(r.name);
    if (!hasDoor && !openSide && !r.outdoor && r.wall !== 'none' && h >= 2 && !stairs) {
      const doorFromNeighbour = rooms.some((o) => o !== r && usableRoom(o) && o.lv === r.lv && itemsOf(o, scene.templates, 'openings').some((x) => {
        if (!x || x.kind === 'window' || !SIDES.includes(x.side) || !num(x.from) || !num(x.to)) return false;
        const ab = openingAbs(o, x);
        const line = ab.wall === 'z' ? [r.z[0], r.z[1]] : [r.x[0], r.x[1]];
        const span = ab.wall === 'z' ? [r.x[0], r.x[1]] : [r.z[0], r.z[1]];
        return line.some((v) => near(v, ab.at)) && overlap1(ab.from, ab.to, span[0], span[1]) > 0.3;
      }));
      if (!doorFromNeighbour) warn(where, '没有门，进不去');
    }
  }

  // rooms of the same floor in the same place (a yard may hold a hut)
  const usable = rooms.filter(usableRoom);
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i];
      const b = usable[j];
      if (a.lv !== b.lv || a.outdoor || b.outdoor) continue;
      const ox = overlap1(a.x[0], a.x[1], b.x[0], b.x[1]);
      const oz = overlap1(a.z[0], a.z[1], b.z[0], b.z[1]);
      if (ox > 0.05 && oz > 0.05) err(`房间「${a.name}」和「${b.name}」`, `在${levelName(a.lv)}占了同一块地方（重叠 ${round(ox)}×${round(oz)} 米）`);
    }
  }

  const built = buildScene(scene);
  for (const p of scene.people || []) {
    if (!p || !p.name || !num(p.lv) || !num(p.x) || !num(p.z)) { err('人物', '每个人要有 name、lv、x、z'); continue; }
    const body = [p.x, p.lv * levelHeight + 1, p.z];
    const inThing = built.boxes.find((b) => b.solid && !b.floor && inside(body, b, -0.05));
    if (inThing) warn(`人物「${p.name}」`, `站在${describe(inThing)}里面`);
  }
  for (const c of scene.cameras || []) {
    const where = c && c.name ? `机位「${c.name}」` : '机位';
    if (!c || !c.name || !triple(c.pos) || !triple(c.target)) { err(where, '要有 name、pos: [x, y, z]、target: [x, y, z]'); continue; }
    if (num(c.fov) && (c.fov < 10 || c.fov > 120)) warn(where, `视角 fov ${c.fov} 不正常（10 到 120）`);
    const inThing = built.boxes.find((b) => b.solid && inside(c.pos, b, -0.02));
    if (inThing) err(where, `相机在${describe(inThing)}里面`);
    for (const name of Array.isArray(c.see) ? c.see : []) {
      const target = targetOf(String(name), built, scene);
      if (!target) { warn(where, `要看的「${name}」场景里没有`); continue; }
      const blocked = target.points.map((pt) => blocker(c.pos, pt, built, target.own));
      if (blocked.every(Boolean)) warn(where, `看不到「${name}」，被${describe(blocked[0])}挡住了`);
    }
  }
  out.push(...require('./scene-blocking').checkSetups(scene, built)); // eslint-disable-line global-require
  return out;
}

module.exports = { SIDES, KINDS, WALLS, emptyScene, buildScene, checkScene, targetOf, itemsOf, openingAbs, furnitureAbs, levelName, wallPieces, hitBox };
