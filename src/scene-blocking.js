// Blocking: who is where during a stretch of shots, and the camera of each shot. A scene's setups are
// { name, room, shots: [shot ids], people: [...], cameras: [...] }. A person can be seated by a piece of furniture
// ({ by: '窗边桌', side: 'n', along: 0.3, pose: 'sit' }) and look at someone ({ facing: '王丽' }); a camera can
// stand by a person or a thing ({ at: { by: '程建国', side: 'behind', dist: 1.2, h: 1.3 }, look: '王丽' }), so a
// weak model only names things and the code does the geometry. From that the code works out what each camera
// sees: who is on the left or the right of the frame, a face or a back, how big, who or what is behind them.
// The prompt of a shot is then held against it. Plain Node, no Electron.
const { buildScene, hitBox } = require('./scene-model');

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const triple = (v) => Array.isArray(v) && v.length === 3 && v.every(num);
const r1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const S = Math.SQRT1_2;
// compass directions on the ground plane, [x, z]: x grows to the east, z to the south
const DIRS = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [S, -S], nw: [-S, -S], se: [S, S], sw: [-S, S] };
const DIR_NAME = { n: '北', s: '南', e: '东', w: '西', ne: '东北', nw: '西北', se: '东南', sw: '西南' };
const RELATIVE = ['front', 'behind', 'left', 'right'];
// eye height and top of the head above the floor, metres
const POSES = { stand: { eye: 1.6, top: 1.75, label: '站着' }, sit: { eye: 1.2, top: 1.32, label: '坐着' }, crouch: { eye: 0.95, top: 1.05, label: '蹲着' }, lie: { eye: 0.3, top: 0.4, label: '躺着' } };
const ASPECT = 16 / 9;
// shot sizes as how many times the frame's height a person is (a close-up only fits the face)
const FRAME_RATIO = { 特写: 2.6, 近景: 1.7, 中景: 1.15, 全身: 0.7, 远景: 0.35 };

const norm2 = ([x, z]) => { const l = Math.hypot(x, z) || 1; return [x / l, z / l]; };
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// the compass word nearest to a ground direction
const compassOf = ([x, z]) => {
  let best = 'n';
  for (const k of Object.keys(DIRS)) if (dot(DIRS[k], [x, z]) > dot(DIRS[best], [x, z])) best = k;
  return DIR_NAME[best];
};

// A setup covers a shot when its shots list has the shot's id, or its end ("E01-015", "015").
const covers = (setup, shotId) => (Array.isArray(setup.shots) ? setup.shots : []).some((s) => {
  const k = String(s || '').trim().toUpperCase();
  const id = String(shotId).toUpperCase();
  return k && (id === k || id.endsWith(`-${k}`));
});
const camCovers = (cam, shotId) => covers({ shots: cam.shots }, shotId);

// a named thing of the scene (furniture, a door or a window), exact name first, then a prefix; things that share
// a name (four tables called the same) are told apart as 名字#2, numbered west to east, then north to south
function thingOf(built, name) {
  const all = [...built.boxes.filter((b) => b.name && !b.floor), ...built.cyls.filter((c) => c.name)];
  const m = /^(.*?)#(\d+)$/.exec(String(name || '').trim());
  const n = m ? m[1] : String(name || '').trim();
  const same = all.filter((b) => b.name === n);
  const list = same.length ? same : all.filter((b) => b.name.startsWith(n));
  if (!m) return list[0] || null;
  return [...list].sort((a, b) => a.x0 - b.x0 || a.z0 - b.z0)[Number(m[2]) - 1] || null;
}
const centre = (b) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2];

// The setup in scene coordinates: { name, room, shots, people, cameras, problems }. People are
// { name, card, lv, pose, x, y (floor), z, facing: [x, z], looksAt }; cameras { name, shots, pos, target, fov }.
function resolveSetup(scene, setup, built = buildScene(scene)) {
  const where = `站位「${setup && setup.name ? setup.name : '?'}」`;
  const problems = [];
  const err = (message) => problems.push({ level: 'error', where, message });
  const warn = (message) => problems.push({ level: 'warn', where, message });
  const H = built.levelHeight;
  const room = (scene.rooms || []).find((r) => r && r.name === setup.room);
  if (setup.room && !room) warn(`room「${setup.room}」场景里没有`);
  const baseLv = room ? room.lv : 0;
  const people = [];
  for (const p of Array.isArray(setup.people) ? setup.people : []) {
    if (!p || !p.name) { err('有个人没写 name'); continue; }
    const lv = num(p.lv) ? p.lv : baseLv;
    const pose = POSES[p.pose] ? p.pose : 'stand';
    if (p.pose !== undefined && !POSES[p.pose]) warn(`「${p.name}」的 pose 只能是 ${Object.keys(POSES).join(' / ')}`);
    let x;
    let z;
    let faceDefault;
    if (num(p.x) && num(p.z)) {
      x = p.x;
      z = p.z;
    } else if (p.by) {
      const b = thingOf(built, p.by);
      if (!b) { err(`「${p.name}」挨着的「${p.by}」场景里没有`); continue; }
      if (!['n', 's', 'e', 'w'].includes(p.side)) { err(`「${p.name}」挨着「${p.by}」要写 side：n / s / e / w（在它的哪一边）`); continue; }
      const along = num(p.along) ? clamp(p.along, 0, 1) : 0.5;
      const gap = num(p.gap) ? p.gap : 0.35;
      if (p.side === 'n' || p.side === 's') { x = b.x0 + along * (b.x1 - b.x0); z = p.side === 'n' ? b.z0 - gap : b.z1 + gap; }
      else { z = b.z0 + along * (b.z1 - b.z0); x = p.side === 'w' ? b.x0 - gap : b.x1 + gap; }
      faceDefault = { n: 's', s: 'n', w: 'e', e: 'w' }[p.side]; // towards the thing
    } else { err(`「${p.name}」要有 x、z，或者 by + side（挨着哪件家具、在它哪一边）`); continue; }
    people.push({ name: String(p.name), card: p.card ? String(p.card) : '', lv, pose, x, y: lv * H, z, spec: p.facing !== undefined ? p.facing : faceDefault });
  }
  const eyeOf = (p) => [p.x, p.y + POSES[p.pose].eye, p.z];
  // where a name points: a person's eyes or a thing's middle
  const pointOf = (name) => {
    const who = people.find((o) => o.name === name);
    if (who) return eyeOf(who);
    const b = thingOf(built, name);
    return b ? centre(b) : null;
  };
  for (const p of people) {
    const f = p.spec;
    let v = null;
    if (typeof f === 'string' && DIRS[f]) v = DIRS[f];
    else if (num(f)) v = [Math.sin((f * Math.PI) / 180), -Math.cos((f * Math.PI) / 180)]; // degrees from north, clockwise
    else if (typeof f === 'string' && f.trim()) {
      const at = pointOf(f);
      if (at && Math.hypot(at[0] - p.x, at[2] - p.z) > 0.05) { v = norm2([at[0] - p.x, at[2] - p.z]); p.looksAt = f; }
      else warn(`「${p.name}」看着的「${f}」场景里没有`);
    } else warn(`「${p.name}」没写朝向 facing（n / s / e / w 或者看着谁）`);
    p.facing = v || [0, 1];
    delete p.spec;
  }
  const cameras = [];
  for (const c of Array.isArray(setup.cameras) ? setup.cameras : []) {
    if (!c || !c.name) { err('有个机位没写 name'); continue; }
    const cw = `机位「${c.name}」`;
    let fov = num(c.fov) ? c.fov : c.frame ? 40 : 50;
    if (c.frame !== undefined && !FRAME_RATIO[c.frame]) warn(`${cw}的 frame 只能是 ${Object.keys(FRAME_RATIO).join(' / ')}`);
    // what it looks at first: the distance of a camera given by its shot size depends on it
    const looks = (Array.isArray(c.look) ? c.look : c.look ? [c.look] : []).map(String);
    let target = triple(c.target) ? c.target : null;
    if (!target && looks.length) {
      const pts = looks.map((n) => pointOf(n));
      const missing = looks.filter((_, i) => !pts[i]);
      if (missing.length) warn(`${cw}要看的${missing.map((m) => `「${m}」`).join('')}场景里没有`);
      const ok = pts.filter(Boolean);
      if (ok.length) target = [0, 1, 2].map((i) => ok.reduce((s, p) => s + p[i], 0) / ok.length);
    }
    if (!target) { err(`${cw}要有 look: "看谁/看什么"（或者 target: [x, y, z]）`); continue; }
    let pos = triple(c.pos) ? c.pos : null;
    if (!pos && c.at && c.at.by) {
      const who = people.find((o) => o.name === c.at.by);
      const b = who ? null : thingOf(built, c.at.by);
      if (!who && !b) { err(`${cw}站在「${c.at.by}」旁边，可场景里没有它`); continue; }
      let d = DIRS[c.at.side];
      if (!d && RELATIVE.includes(c.at.side)) {
        if (!who) { err(`${cw}：front / behind / left / right 只能对人用，家具要写 n / s / e / w`); continue; }
        const f = who.facing;
        d = { front: f, behind: [-f[0], -f[1]], right: [-f[1], f[0]], left: [f[1], -f[0]] }[c.at.side];
      }
      if (!d) { err(`${cw}的 at.side 要是 n / s / e / w / ne / nw / se / sw，或者（对人）front / behind / left / right`); continue; }
      const base = who ? [who.x, who.y, who.z] : [(b.x0 + b.x1) / 2, Math.floor(b.y0 / H) * H, (b.z0 + b.z1) / 2];
      // a thing's own half-width is added, so 1 m from a table is 1 m from its edge
      const half = b ? Math.abs(d[0]) * (b.x1 - b.x0) / 2 + Math.abs(d[1]) * (b.z1 - b.z0) / 2 : 0;
      // over the shoulder: from behind someone, a little to one side, so the face beyond is not hidden by their head
      let off = [0, 0];
      const overShoulder = who && c.at.side === 'behind' && looks.some((n) => n !== who.name);
      // over someone's shoulder the camera is on the line from what it looks at through them, whichever way
      // they face; their own left and right are taken as they face what is looked at
      let toward = who ? who.facing : null;
      if (overShoulder && Math.hypot(who.x - target[0], who.z - target[2]) > 0.2) {
        d = norm2([who.x - target[0], who.z - target[2]]);
        toward = [-d[0], -d[1]];
      }
      const shoulder = c.at.shoulder === 'left' ? -1 : c.at.shoulder === 'right' ? 1 : overShoulder ? 1 : 0;
      const SHOULDER = 0.35;
      if (who && shoulder) off = [-toward[1] * SHOULDER * shoulder, toward[0] * SHOULDER * shoulder];
      const p0 = [base[0] + off[0] + d[0] * half, base[2] + off[1] + d[1] * half];
      let dist = num(c.at.dist) ? c.at.dist : 1.5;
      const ratio = FRAME_RATIO[c.frame];
      if (!num(c.at.dist) && ratio) {
        const subject = people.find((o) => o.name === looks[0]);
        const tall = subject ? POSES[subject.pose].top : 1.7;
        const ground = (t) => Math.hypot(p0[0] + d[0] * t - target[0], p0[1] + d[1] * t - target[2]);
        const lensFor = (t) => (2 * Math.atan(tall / (2 * ground(t) * ratio)) * 180) / Math.PI;
        // the camera stays inside the setup's room, clear of its walls
        const fits = (t) => !room || (p0[0] + d[0] * t > room.x[0] + 0.2 && p0[0] + d[0] * t < room.x[1] - 0.2 && p0[1] + d[1] * t > room.z[0] + 0.2 && p0[1] + d[1] * t < room.z[1] - 0.2);
        const furthest = (t) => { let k = t; while (k > 0.3 && !fits(k)) k -= 0.05; return k; };
        if (overShoulder && !num(c.fov)) {
          // the lens that makes the subject that big, and the distance behind that keeps the near shoulder at the edge
          let pick = null;
          for (let t = 0.3; t <= 6 && fits(t); t += 0.05) {
            const v = lensFor(t);
            if (v < 12 || v > 60) continue;
            // where the shoulder sits across the frame: its angle off the axis over half the width's angle
            const score = Math.abs(Math.atan(SHOULDER / t) / Math.atan(Math.tan((v * Math.PI) / 360) * ASPECT) - 0.7);
            if (!pick || score < pick.score) pick = { t, v, score };
          }
          if (pick) { dist = pick.t; fov = Math.round(pick.v); }
        } else {
          // as far out along d as makes the subject that big: |p0 + d·t − target| = wanted, on the ground
          const wanted = tall / (2 * Math.tan((fov * Math.PI) / 360) * ratio);
          const rel = [p0[0] - target[0], p0[1] - target[2]];
          const bq = dot(d, rel);
          const disc = bq * bq - (dot(rel, rel) - wanted * wanted);
          dist = disc >= 0 ? -bq + Math.sqrt(disc) : -bq;
          if (dist >= 0.4 && !fits(dist)) {
            // the room is too small for this lens: back to the wall and a wider one
            dist = furthest(dist);
            if (!num(c.fov)) fov = Math.min(75, Math.round(lensFor(dist)));
          } else if (dist < 0.4) {
            // too far for this lens even standing right there: stay close and take a longer lens
            dist = 0.6;
            if (!num(c.fov)) fov = Math.round(lensFor(dist));
            if (num(c.fov) || fov < 12) warn(`${cw}：站在「${c.at.by}」${c.at.side === 'behind' ? '身后' : '那边'}拍不出${c.frame}（离得太远了），换个 at 或者换个景别`);
            fov = Math.max(12, fov);
          }
        }
      }
      pos = [p0[0] + d[0] * dist, base[1] + (num(c.at.h) ? c.at.h : 1.5), p0[1] + d[1] * dist];
    }
    if (!pos) { err(`${cw}要有 at: { by, side, h }（或者 pos: [x, y, z]）`); continue; }
    const inside = people.find((p) => Math.hypot(pos[0] - p.x, pos[2] - p.z) < 0.3 && pos[1] < p.y + POSES[p.pose].top + 0.1);
    if (inside) { err(`${cw}的相机站进了「${inside.name}」身上（离他只有 ${r1(Math.hypot(pos[0] - inside.x, pos[2] - inside.z))} 米），换个 at 或者把 h 抬到他头顶以上`); continue; }
    if (Math.hypot(...sub(target, pos)) < 0.2) { err(`${cw}的相机和它看的地方重合了`); continue; }
    if (fov < 10 || fov > 120) warn(`${cw}的视角 fov ${fov} 不正常（10 到 120）`);
    cameras.push({ name: String(c.name), shots: Array.isArray(c.shots) ? c.shots.map(String) : [], pos: pos.map((v) => Math.round(v * 1000) / 1000), target, fov, frame: c.frame || '', card: c.card ? String(c.card) : '', expect: c.expect || null, setup: setup.name });
  }
  for (const c of cameras) if (!c.shots.length) warn(`机位「${c.name}」没写 shots（拍哪几镜）`);
  const shots = Array.isArray(setup.shots) ? setup.shots.map(String) : [];
  for (const s of shots) if (!cameras.some((c) => camCovers(c, s))) warn(`${s} 在这个站位里，可没有哪个机位拍它`);
  return { name: String(setup.name || ''), room: setup.room || '', shots, people, cameras, problems };
}

function checkSetups(scene, built = buildScene(scene)) {
  const out = [];
  const names = new Set();
  for (const [i, s] of (Array.isArray(scene.setups) ? scene.setups : []).entries()) {
    if (!s || !s.name) { out.push({ level: 'error', where: `第 ${i + 1} 个站位`, message: '没写 name' }); continue; }
    if (names.has(s.name)) out.push({ level: 'error', where: `站位「${s.name}」`, message: '和另一个站位重名了' });
    names.add(s.name);
    const r = resolveSetup(scene, s, built);
    out.push(...r.problems);
    for (const p of r.people) {
      const body = [p.x, p.y + 0.9 * POSES[p.pose].top, p.z];
      const inThing = built.boxes.find((b) => b.solid && !b.floor && body[0] > b.x0 + 0.05 && body[0] < b.x1 - 0.05 && body[1] > b.y0 && body[1] < b.y1 && body[2] > b.z0 + 0.05 && body[2] < b.z1 - 0.05);
      if (inThing) out.push({ level: 'warn', where: `站位「${s.name}」`, message: `「${p.name}」站在「${inThing.name || '一面墙'}」里面` });
    }
    for (const c of r.cameras.filter((x) => x.expect)) {
      for (const message of expectProblems(cameraFacts(scene, r, c, built), c.expect).filter((m) => !m.startsWith('（'))) {
        out.push({ level: 'warn', where: `站位「${s.name}」`, message });
      }
    }
  }
  return out;
}

// The setup and the camera of a shot: { scene, setup (resolved), camera } or null.
function setupForShot(scene, shotId) {
  for (const s of Array.isArray(scene.setups) ? scene.setups : []) {
    if (!s || !s.name) continue;
    const r = resolveSetup(scene, s);
    const camera = r.cameras.find((c) => camCovers(c, shotId));
    if (camera || covers(s, shotId)) return { setup: r, camera: camera || null };
  }
  return null;
}

// ---------- what a camera sees ----------
function viewOf(cam) {
  const f = norm(sub(cam.target, cam.pos));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const tv = Math.tan((cam.fov * Math.PI) / 360);
  const th = tv * ASPECT;
  // x, y on screen (-1 … 1, right and up), and the depth along the view
  const project = (p) => {
    const d = sub(p, cam.pos);
    const depth = dot(d, f);
    return { sx: depth > 0 ? dot(d, r) / (depth * th) : NaN, sy: depth > 0 ? dot(d, u) / (depth * tv) : NaN, depth };
  };
  return { f, r, u, tv, project };
}
const onScreen = (q, margin = 1) => q.depth > 0.15 && Math.abs(q.sx) <= margin && Math.abs(q.sy) <= margin;
const sideOf = (sx) => (sx < -0.75 ? '左边缘' : sx < -0.3 ? '左侧' : sx < -0.1 ? '中间偏左' : sx <= 0.1 ? '中间' : sx <= 0.3 ? '中间偏右' : sx <= 0.75 ? '右侧' : '右边缘');

// The first box a segment meets, people included; ignore(b) leaves some out.
function firstHit(from, to, boxes, ignore) {
  let best = null;
  for (const b of boxes) {
    if (ignore(b)) continue;
    const t = hitBox(from, to, b);
    if (t > 0.001 && t < 0.999 && (!best || t < best.t)) best = { t, b };
  }
  return best && best.b;
}
const nameOfBox = (b) => (b.person ? b.name : b.floor ? '地面' : b.kind === 'roof' ? '天花板' : b.name ? `「${b.name}」${b.kind === 'glass' && b.opening ? '（窗）' : ''}` : b.wall ? '墙' : '');

// Everything the shot's camera sees, as data: { setup, camera, people: [...], things: [...] }, or null when no
// setup covers the shot.
function shotFacts(scene, shotId) {
  const found = setupForShot(scene, shotId);
  if (!found || !found.camera) return found ? { setup: found.setup, camera: null, people: [], things: [] } : null;
  return cameraFacts(scene, found.setup, found.camera);
}

// The same for one camera of a resolved setup.
function cameraFacts(scene, setup, camera, built = buildScene(scene)) {
  const view = viewOf(camera);
  // a person blocks the view as shoulders and body, with a narrower head on top
  const personBoxes = setup.people.flatMap((p) => {
    const { eye, top } = POSES[p.pose];
    const neck = p.y + eye - 0.15;
    const box = (w, y0, y1) => ({ x0: p.x - w, x1: p.x + w, z0: p.z - w, z1: p.z + w, y0, y1, name: p.name, person: true, solid: true });
    return [box(0.22, p.y, neck), box(0.1, neck, p.y + top)];
  });
  const solid = [...built.boxes.filter((b) => b.solid && !b.floor), ...personBoxes];
  const people = setup.people.map((p) => {
    const pose = POSES[p.pose];
    const eye = [p.x, p.y + pose.eye, p.z];
    const chest = [p.x, p.y + pose.eye - 0.45, p.z];
    const qe = view.project(eye);
    const qc = view.project(chest);
    const own = (b) => b.name === p.name && b.person;
    const fact = { name: p.name, card: p.card, pose: p.pose, looksAt: p.looksAt || '', depth: r1(qe.depth) };
    if (!onScreen(qe, 1.02) && !onScreen(qc, 1.02)) {
      // which way they left the picture, so a camera can be moved the right way
      const outBy = qe.depth <= 0.15 ? 'behind' : Math.abs(qe.sx) > 1.02 ? 'side' : qe.sy < 0 ? 'below' : 'above';
      return { ...fact, frame: 'out', outBy };
    }
    fact.frame = onScreen(qe, 1.02) ? 'in' : 'body';
    fact.sx = Math.round((onScreen(qe, 1.02) ? qe.sx : qc.sx) * 100) / 100;
    fact.side = sideOf(fact.sx);
    const toCam = norm2([camera.pos[0] - p.x, camera.pos[2] - p.z]);
    const angle = (Math.acos(clamp(dot(p.facing, toCam), -1, 1)) * 180) / Math.PI;
    fact.face = angle <= 40 ? '正脸' : angle <= 75 ? '大半张脸' : angle <= 110 ? '侧脸' : angle <= 145 ? '侧后方' : '背影';
    if (angle > 40 && angle <= 145) fact.turned = dot([p.facing[0], 0, p.facing[1]], view.r) > 0 ? '朝画面右' : '朝画面左';
    const ratio = pose.top / (2 * Math.max(0.2, qe.depth) * view.tv);
    fact.size = ratio >= 2.2 ? '特写' : ratio >= 1.4 ? '近景' : ratio >= 0.9 ? '中景' : ratio >= 0.5 ? '全身' : '远景';
    const block = firstHit(camera.pos, eye, solid, own);
    if (block) fact.hiddenBy = nameOfBox(block);
    // what is behind them on screen: the ray from the camera through their eyes, carried on past them
    const dir = norm(sub(eye, camera.pos));
    const behind = firstHit(eye.map((v, i) => v + dir[i] * 0.3), eye.map((v, i) => v + dir[i] * 30),
      [...built.boxes.filter((b) => !b.floor || dir[1] < -0.2), ...personBoxes], (b) => own(b) || (b.opening && b.kind === 'door'));
    fact.behind = behind ? nameOfBox(behind) : '远处';
    fact.behindWindow = !!(behind && behind.opening && behind.kind === 'glass');
    return fact;
  });
  // the named things of the setup's room in the picture, by where on screen their visible parts are; sampled
  // every 0.3 m and at three heights, so a long window still shows in a narrow lens. People do not hide them:
  // what is behind someone is still part of the picture
  const things = new Map();
  const roomOf = (b) => b.room || '';
  const walls = built.boxes.filter((b) => b.solid && !b.floor);
  for (const b of built.boxes.filter((x) => x.name && !x.floor && !x.wall && (!setup.room || roomOf(x) === setup.room))) {
    if (b.opening && b.kind === 'door' && !b.name) continue;
    const long = b.x1 - b.x0 > b.z1 - b.z0 ? 'x' : 'z';
    const n = Math.max(1, Math.min(40, Math.round((long === 'x' ? b.x1 - b.x0 : b.z1 - b.z0) / 0.3)));
    for (let i = 0; i < n * 3; i++) {
      const t = ((i % n) + 0.5) / n;
      const y = b.y0 + (b.y1 - b.y0) * [0.25, 0.5, 0.75][Math.floor(i / n)];
      const pt = [long === 'x' ? b.x0 + t * (b.x1 - b.x0) : (b.x0 + b.x1) / 2, y, long === 'z' ? b.z0 + t * (b.z1 - b.z0) : (b.z0 + b.z1) / 2];
      const q = view.project(pt);
      if (!onScreen(q)) continue;
      if (firstHit(camera.pos, pt, walls, (x) => x === b || x.name === b.name)) continue;
      const k = b.name;
      if (!things.has(k)) things.set(k, { name: k, window: !!(b.opening && b.kind === 'glass'), xs: [] });
      things.get(k).xs.push(q.sx);
    }
  }
  const thingList = [...things.values()].map((t) => {
    const lo = sideOf(Math.min(...t.xs));
    const hi = sideOf(Math.max(...t.xs));
    return { name: t.name, window: t.window, from: lo, to: hi };
  });
  const room = (scene.rooms || []).find((r) => r && r.name === setup.room);
  const floorY = (room ? room.lv : setup.people.length ? setup.people[0].lv : 0) * built.levelHeight;
  return { setup, camera, people, things: thingList, floorY };
}

// What a camera was meant to show, against what it shows: expect is
// { in: [names], out: [names], left: [names], right: [names], face: [names], back: [names] } → [text].
function expectProblems(facts, expect) {
  if (!facts || !facts.camera || !expect || typeof expect !== 'object') return [];
  const cw = `机位「${facts.camera.name}」`;
  const out = [];
  const who = (n) => facts.people.find((p) => p.name === n);
  const list = (k) => (Array.isArray(expect[k]) ? expect[k] : expect[k] ? [expect[k]] : []).map(String);
  // how to get it right, in the setup's own terms
  const HINT = {
    in: '（look 里加上他，或者换大一号的景别让相机退后）',
    out: '（换个方向拍，或者换小一号的景别让相机靠近）',
    left: '（左右反了：shoulder 换到另一边，或者把相机放到对面）',
    right: '（左右反了：shoulder 换到另一边，或者把相机放到对面）',
    face: '（相机要在他面朝的那一边：side 用 front，或者站在他看着的那个人身后；被挡住就换 shoulder 或者把 h 抬高）',
    back: '（相机要在他身后：at.by 写他、side 写 behind）',
  };
  const OUT = {
    behind: '在相机后面（相机越过他了）',
    side: '在画面一侧之外',
    below: '从画面下边出画了：把 h 降低一点（比如降到他眼睛的高度），或者 look 里加上他让镜头往下压',
    above: '从画面上边出画了：把 h 抬高一点，或者 look 里加上他',
  };
  const each = (k, test, say) => {
    for (const n of list(k)) {
      const p = who(n);
      if (!p) { out.push(`${cw}的 expect.${k} 里的「${n}」不在这个站位里`); continue; }
      if (test(p)) continue;
      out.push(p.frame === 'out' && p.outBy !== 'side' && k !== 'out'
        ? `${cw}：你想${say(n)}，可从这个位置拍，${n}${OUT[p.outBy]}`
        : `${cw}：你想${say(n)}，可从这个位置拍，${p.frame === 'out' ? `${n}在画面外` : `${n}在画面${p.side}，拍到的是${p.face}${p.hiddenBy ? `，脸被${p.hiddenBy}挡住` : ''}`}${HINT[k]}`);
    }
  };
  each('in', (p) => p.frame !== 'out', (n) => `拍到${n}`);
  each('out', (p) => p.frame === 'out', (n) => `${n}不入画`);
  each('left', (p) => p.frame !== 'out' && p.sx < 0, (n) => `${n}在画面左半边`);
  each('right', (p) => p.frame !== 'out' && p.sx > 0, (n) => `${n}在画面右半边`);
  each('face', (p) => p.frame !== 'out' && (p.face === '正脸' || p.face === '大半张脸') && !p.hiddenBy, (n) => `拍到${n}的脸`);
  each('back', (p) => p.frame !== 'out' && (p.face === '背影' || p.face === '侧后方'), (n) => `拍到${n}的背影`);
  if (out.length) out.push(`（${cw}现在：${factsText(facts).split('\n').slice(1).join('；')}）`);
  return out;
}

// ---------- in words ----------
function cameraWords(facts) {
  const c = facts.camera;
  const look = sub(c.target, c.pos);
  const down = (Math.atan2(-look[1], Math.hypot(look[0], look[2])) * 180) / Math.PI;
  const tilt = down > 25 ? '，往下俯拍' : down > 8 ? '，略微俯拍' : down < -25 ? '，往上仰拍' : down < -8 ? '，略微仰拍' : '';
  const lens = c.fov <= 30 ? '长焦' : c.fov >= 70 ? '广角' : '标准镜头';
  const nearest = facts.setup.people.map((p) => ({ p, d: Math.hypot(p.x - c.pos[0], p.z - c.pos[2]) })).sort((a, b) => a.d - b.d)[0];
  const by = nearest ? `，离${nearest.p.name} ${r1(nearest.d)} 米` : '';
  return `相机离地 ${r1(c.pos[1] - facts.floorY)} 米${by}，朝${compassOf([look[0], look[2]])}看${tilt}，${lens}（视角 ${c.fov}°）`;
}

// For the model that writes the prompt, and for the person reading the shot page.
function factsText(facts) {
  if (!facts) return '';
  if (!facts.camera) return `这一镜在站位「${facts.setup.name}」里，但还没有机位拍它。`;
  const inFrame = facts.people.filter((p) => p.frame !== 'out').sort((a, b) => a.depth - b.depth);
  const out = facts.people.filter((p) => p.frame === 'out');
  const lines = [`站位「${facts.setup.name}」${facts.setup.room ? `（${facts.setup.room}）` : ''}，机位「${facts.camera.name}」：${cameraWords(facts)}。`];
  if (inFrame.length) {
    lines.push('画面里的人（从近到远）：');
    for (const p of inFrame) {
      const bits = [`画面${p.side}`, p.size, `${POSES[p.pose].label}`, p.turned ? `${p.face}、${p.turned}` : p.face];
      if (p.looksAt) bits.push(`看着${p.looksAt}`);
      if (p.frame === 'body') bits.push('头在画外');
      if (p.hiddenBy) bits.push(`脸被${p.hiddenBy}挡住`);
      bits.push(`身后是${p.behind}`);
      lines.push(`- ${p.name}：${bits.join('，')}`);
    }
    if (inFrame.length > 1) lines.push(`画面从左到右：${[...inFrame].sort((a, b) => a.sx - b.sx).map((p) => p.name).join('、')}`);
  } else lines.push('画面里没有人。');
  if (out.length) lines.push(`画面外：${out.map((p) => p.name).join('、')}`);
  if (facts.things.length) lines.push(`画面里看得到：${facts.things.map((t) => `「${t.name}」（${t.from === t.to ? `画面${t.from}` : `画面${t.from}到${t.to}`}）`).join('、')}`);
  return lines.join('\n');
}

// What a rewrite is told: the facts and how to use them.
function blockingBrief(facts) {
  if (!facts || !facts.camera) return '';
  return [
    '这一镜的站位（软件按白模场景算出来的，以它为准；东南西北只用来对照，提示词里写画面左右、前后）：',
    factsText(facts),
    '写提示词时：谁在画面左、谁在右，谁正脸、谁背影，谁近谁远，人身后是窗还是墙，都照上面写；画面外的人不写进画面，除非这一镜里他走进来。',
  ].join('\n');
}

// ---------- the prompt against the facts ----------
// where someone is, not which way they turn: "toward the right of the frame" is a direction and does not count
const LEFT = /(?<!toward |towards |to )\b(?:(?:on|at|in) the (?:far )?left(?: side| edge| third| half)? of (?:the )?(?:frame|screen|shot|image|picture)|frame[- ]left|screen[- ]left)\b/i;
const RIGHT = /(?<!toward |towards |to )\b(?:(?:on|at|in) the (?:far )?right(?: side| edge| third| half)? of (?:the )?(?:frame|screen|shot|image|picture)|frame[- ]right|screen[- ]right)\b/i;
const TO_CAMERA = /\b(?:fac(?:es|ing|e) (?:the |toward(?:s)? the )?(?:camera|lens|viewer)|(?:looks?|looking|turns?|turning) (?:straight )?(?:in)?to(?:ward)?s? the (?:camera|lens))\b/i;
const BACK = /\b(?:(?:his|her|their) back (?:is )?(?:turned )?to(?:ward)?s? the camera|back to (?:the )?camera|seen from behind|from behind|back of (?:his|her|their) head)\b/i;
const WINDOW_BEHIND = /\b(?:window|windows|glass)\b[^.;]*\bbehind (?:him|her|them|<Subject \d+>)|\bbehind (?:him|her|them|<Subject \d+>)[^.;]*\b(?:window|windows|glass)\b|\bbacks? (?:is |are )?to the window\b|\bin front of the window\b/i;

// Which person each <Subject k> is: through its <Picture n> to the shot's reference n, then by card code or name.
function subjectsOf(prompt, references, people) {
  const map = new Map();
  for (const m of String(prompt || '').matchAll(/^\s*<Subject (\d+)> is (.*?)<Picture (\d+)>/gm)) {
    const ref = (references || []).find((r) => r.order === Number(m[3]));
    if (!ref) continue;
    const who = people.find((p) => (p.card && ref.id === `IMG-${p.card}`.toUpperCase()) || (ref.title && (ref.title.includes(p.name) || p.name.includes(ref.title))));
    if (who) map.set(Number(m[1]), who);
  }
  return map;
}
const hasCard = (references, p) => (references || []).some((r) => (p.card && r.id === `IMG-${p.card}`.toUpperCase()) || (r.title && (r.title.includes(p.name) || p.name.includes(r.title))));

// Where the prompt says something the blocking does not: [text].
function blockingWarnings({ prompt, facts, references = [] }) {
  if (!facts || !facts.camera) return [];
  const out = [];
  const subjects = subjectsOf(prompt, references, facts.people);
  const body = String(prompt || '').replace(/subject_definitions\s*:[\s\S]*?(?=\n\s*(?:summary|retention_analysis)\s*:|$)/i, '');
  const sentences = body.split(/(?<=[.!?])\s+|\n+/);
  const said = new Set();
  const once = (k, text) => { if (!said.has(k)) { said.add(k); out.push(text); } };
  for (const s of sentences) {
    const ks = [...new Set([...s.matchAll(/<Subject (\d+)>/g)].map((m) => Number(m[1])))];
    if (ks.length !== 1 || !subjects.has(ks[0])) continue;
    const p = subjects.get(ks[0]);
    if (p.frame === 'out') continue;
    const left = LEFT.test(s);
    const right = RIGHT.test(s);
    if (left !== right && ((left && p.sx > 0.1) || (right && p.sx < -0.1))) once(`${p.name}side`, `提示词里${p.name}在画面${LEFT.test(s) ? '左' : '右'}边，按站位${p.name}在画面${p.side}`);
    if (TO_CAMERA.test(s) && (p.face === '背影' || p.face === '侧后方')) once(`${p.name}face`, `提示词里${p.name}面朝镜头，按站位拍到的是${p.name}的${p.face}`);
    if (BACK.test(s) && p.face === '正脸') once(`${p.name}face`, `提示词里${p.name}背对镜头，按站位拍到的是${p.name}的正脸`);
    if (WINDOW_BEHIND.test(s) && !p.behindWindow) once(`${p.name}behind`, `提示词里${p.name}身后是窗，按站位${p.name}身后是${p.behind}`);
  }
  // a window written into a picture whose camera sees none (a place's description often carries one along)
  if (!facts.things.some((t) => t.window) && !facts.people.some((p) => p.behindWindow)) {
    // what is heard (the soundscape, the music) is not in the picture
    const seen = String(prompt || '').replace(/<d>[\s\S]*?<\/d>/g, '').replace(/\n\s*(?:overall_soundscape|non_diegetic_music)\s*:[\s\S]*?(?=\n\s*[a-z_]+\s*:|$)/gi, '');
    const said = seen.match(/[^.\n]*\b(?:windows?|window-?panes?|beyond the glass|through the glass)\b[^.\n]*/i);
    if (said) out.push(`按站位这个机位拍不到窗，提示词里却写了窗（「${said[0].trim().slice(0, 60)}」），模型会把窗画进背景`);
  }
  for (const p of facts.people) {
    if (p.frame === 'in' && !p.hiddenBy && !hasCard(references, p)) once(`${p.name}card`, `按站位${p.name}在画面${p.side}（${p.size}），可这一镜参考图里没有${p.name}，模型会把人画丢或画成别人`);
  }
  return out;
}

// Who a shot is about: the people whose identity picture it carries. → [person]
const castOf = (references, people) => people.filter((p) => (references || []).some((r) => /身份/.test(r.use || '') && hasCard([r], p)));

module.exports = { castOf, hasCard, DIRS, POSES, resolveSetup, checkSetups, setupForShot, shotFacts, cameraFacts, factsText, blockingBrief, blockingWarnings, expectProblems, subjectsOf, viewOf, thingOf };
