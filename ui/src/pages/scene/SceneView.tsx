import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { SceneBuilt } from '../../api';

export type Floor = 'all' | number;
export type Light = 'morning' | 'noon' | 'evening' | 'night';
export type SceneViewHandle = { capture: (camera: number, people?: boolean) => string; exportGlb: () => Promise<ArrayBuffer>; showCamera: (camera: number) => void };

const COLORS: Record<string, string> = {
  wall: '#dcd8d0', floor: '#b9b2a4', corridor: '#a9a59e', guestFloor: '#c8bfae', roof: '#9c968c', wood: '#b4875a', metal: '#9aa3ab',
  dark: '#3b3b3d', bed: '#8fb0d0', soft: '#a9786a', gold: '#d2a23a', blue: '#3a6fd0', green: '#5d8c58', rope: '#d8c39a', white: '#f4f3ee',
  red: '#a8452e', car: '#6d7c8c', pink: '#e48fb3', stone: '#8c867c', shed: '#9a8060', rock: '#8b8478', gravel: '#a39b8c', road: '#5a5c5f',
  mountain: '#7b756b', grass: '#7f8a6c', water: '#4f7896', snow: '#eef1f4', plain: '#dcd8d0',
};
const LIGHTS: Record<Light, { dir: number[]; sun: string; i: number; hemi: number; sky: string; fog: number[] }> = {
  morning: { dir: [80, 35, 10], sun: '#ffe2b8', i: 1.7, hemi: 1.1, sky: '#cfdbe6', fog: [150, 1000] },
  noon: { dir: [10, 100, 60], sun: '#fffaf0', i: 1.9, hemi: 1.0, sky: '#bcd4ea', fog: [180, 1200] },
  evening: { dir: [-80, 30, 5], sun: '#ffc48a', i: 1.5, hemi: 0.65, sky: '#e2c7a8', fog: [130, 900] },
  night: { dir: [-20, 60, 40], sun: '#7f93c8', i: 0.18, hemi: 0.15, sky: '#0d1220', fog: [70, 500] },
};

type Props = {
  built: SceneBuilt | null; floor: Floor; light: Light; labels: boolean;
  onPick?: (p: { name: string; room: string }) => void;
};

// The scene's boxes drawn with three.js (the floor plan is ScenePlan), a floor shown with everything above it taken off,
// the scene's cameras, names on hover. capture() renders a camera's view to a PNG for a reference image.
export const SceneView = forwardRef<SceneViewHandle, Props>(function SceneView({ built, floor, light, labels, onPick }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const three = useRef<{
    renderer: THREE.WebGLRenderer; labelRenderer: CSS2DRenderer; scene: THREE.Scene; world: THREE.Group; persp: THREE.PerspectiveCamera;
    controls: OrbitControls; sun: THREE.DirectionalLight; hemi: THREE.HemisphereLight; lamps: THREE.PointLight[];
    mats: Map<string, THREE.Material>; named: THREE.Object3D[]; labels: CSS2DObject[]; groups: Map<string, THREE.Group>; camera: THREE.Camera;
    bounds: THREE.Box3; framed: boolean;
  } | null>(null);
  const props = useRef({ floor, labels, onPick, built });
  props.current = { floor, labels, onPick, built };

  // ---------- one-time setup ----------
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(renderer.domElement);
    const labelRenderer = new CSS2DRenderer();
    Object.assign(labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    el.appendChild(labelRenderer.domElement);
    const scene = new THREE.Scene();
    const world = new THREE.Group();
    scene.add(world);
    const persp = new THREE.PerspectiveCamera(45, 1, 0.1, 6000);
    const controls = new OrbitControls(persp, renderer.domElement);
    controls.enableDamping = true;
    const hemi = new THREE.HemisphereLight('#dfe8f2', '#8a8070', 1);
    const sun = new THREE.DirectionalLight('#fff4e0', 1.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.0005;
    scene.add(hemi, sun, sun.target);
    const mats = new Map<string, THREE.Material>();
    for (const [k, c] of Object.entries(COLORS)) mats.set(k, new THREE.MeshLambertMaterial({ color: c }));
    mats.set('lamp', new THREE.MeshLambertMaterial({ color: '#ffe9a0', emissive: '#ffd27a', emissiveIntensity: 0.4 }));
    mats.set('glass', new THREE.MeshLambertMaterial({ color: '#9fd4ff', transparent: true, opacity: 0.22, depthWrite: false, emissive: '#ffb45a', emissiveIntensity: 0 }));
    mats.set('door', new THREE.MeshBasicMaterial({ visible: false }));
    const flags = document.createElement('canvas');
    flags.width = 256; flags.height = 64;
    const g = flags.getContext('2d')!;
    ['#2f6fd0', '#f4f3ee', '#d0453a', '#3f9a4f', '#e2c03a'].forEach((c, i) => { for (let k = i; k < 32; k += 5) { g.fillStyle = c; g.fillRect(k * 8, (k * 7) % 20, 7, 40); } });
    const tex = new THREE.CanvasTexture(flags);
    tex.colorSpace = THREE.SRGBColorSpace;
    mats.set('flags', new THREE.MeshLambertMaterial({ map: tex }));
    const t = {
      renderer, labelRenderer, scene, world, persp, controls, sun, hemi, lamps: [] as THREE.PointLight[], mats,
      named: [] as THREE.Object3D[], labels: [] as CSS2DObject[], groups: new Map<string, THREE.Group>(), camera: persp as THREE.Camera,
      bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(20, 10, 20)), framed: false,
    };
    three.current = t;

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h);
      labelRenderer.setSize(w, h);
      persp.aspect = w / h;
      persp.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const ray = new THREE.Raycaster();
    const shown = (o: THREE.Object3D | null) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
    const hitAt = (e: PointerEvent | MouseEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), t.camera);
      return ray.intersectObjects(t.named, false).find((h) => shown(h.object));
    };
    const onMove = (e: PointerEvent) => {
      const hit = hitAt(e);
      const box = tip.current!;
      if (!hit) { box.style.display = 'none'; return; }
      box.textContent = hit.object.userData.name;
      box.style.display = 'block';
      const r = el.getBoundingClientRect();
      box.style.left = `${e.clientX - r.left + 14}px`;
      box.style.top = `${e.clientY - r.top + 12}px`;
    };
    let down = { x: 0, y: 0 };
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onClick = (e: MouseEvent) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // a drag, not a click
      const hit = hitAt(e);
      if (hit) props.current.onPick?.({ name: hit.object.userData.name, room: hit.object.userData.room || '' });
    };
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('click', onClick);
    renderer.domElement.addEventListener('pointerleave', () => { tip.current!.style.display = 'none'; });

    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, t.camera);
      labelRenderer.render(scene, t.camera);
    });
    return () => {
      ro.disconnect();
      renderer.setAnimationLoop(null);
      renderer.dispose();
      el.removeChild(renderer.domElement);
      el.removeChild(labelRenderer.domElement);
      three.current = null;
    };
  }, []);

  // ---------- the scene's boxes ----------
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    t.world.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
    t.world.clear();
    for (const l of t.labels) t.scene.remove(l);
    t.labels = [];
    t.named = [];
    t.groups = new Map();
    for (const p of t.lamps) t.scene.remove(p);
    t.lamps = [];
    if (!built) return;
    const H = built.levelHeight;
    const group = (key: number | 'outdoor') => {
      const k = String(key);
      let g = t.groups.get(k);
      if (!g) { g = new THREE.Group(); g.name = key === 'outdoor' ? '室外' : `${Number(key) + 1}楼`; g.userData.group = key; t.groups.set(k, g); t.world.add(g); }
      return g;
    };
    const edgeMat = new THREE.LineBasicMaterial({ color: '#2a2a2a', transparent: true, opacity: 0.35 });
    const mat = (kind: string) => t.mats.get(kind) || t.mats.get('wood')!;
    const nameIt = (m: THREE.Object3D, b: { name: string; room?: string }) => {
      if (!b.name) return;
      m.name = b.name;
      m.userData.name = b.name;
      m.userData.room = b.room || '';
      t.named.push(m);
    };
    const bounds = new THREE.Box3();
    for (const b of built.boxes) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(b.x1 - b.x0, 0.01), Math.max(b.y1 - b.y0, 0.01), Math.max(b.z1 - b.z0, 0.01)), mat(b.kind));
      m.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
      m.castShadow = b.kind !== 'door' && b.kind !== 'glass';
      m.receiveShadow = true;
      if (b.floor) m.userData.room = b.name;
      nameIt(m, { name: b.name, room: b.room || (b.floor ? b.name : '') });
      if (b.edges) {
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), edgeMat);
        e.userData.edge = true;
        m.add(e);
      }
      group(b.group).add(m);
      if (b.group !== 'outdoor') bounds.expandByPoint(new THREE.Vector3(b.x0, b.y0, b.z0)).expandByPoint(new THREE.Vector3(b.x1, b.y1, b.z1));
    }
    for (const c of built.cyls) {
      const r = Math.min(c.x1 - c.x0, c.z1 - c.z0) / 2;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, c.y1 - c.y0, 20), mat(c.kind));
      m.position.set((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2, (c.z0 + c.z1) / 2);
      m.castShadow = m.receiveShadow = true;
      nameIt(m, c);
      group(c.group).add(m);
    }
    const personMat = new THREE.MeshLambertMaterial({ color: '#c4553f' });
    // a blocking's people: shorter when seated or crouching, with a nose pointing the way they face
    const EYE: Record<string, number> = { stand: 1.6, sit: 1.2, crouch: 0.95, lie: 0.3 };
    const noseMat = new THREE.MeshLambertMaterial({ color: '#f2d0a0' });
    for (const p of built.people) {
      const eye = EYE[p.pose || 'stand'] || 1.6;
      const tall = Math.max(0.2, eye - 0.15);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, tall, 16), personMat);
      body.position.set(p.x, p.y + tall / 2, p.z);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), personMat);
      head.position.set(p.x, p.y + eye, p.z);
      const parts: THREE.Mesh[] = [body, head];
      if (p.facing) {
        const nose = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.12), noseMat);
        nose.position.set(p.x + p.facing[0] * 0.15, p.y + eye, p.z + p.facing[1] * 0.15);
        nose.rotation.y = Math.atan2(p.facing[0], p.facing[1]);
        parts.push(nose);
        const chest = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.25, 0.06), noseMat);
        chest.position.set(p.x + p.facing[0] * 0.21, p.y + eye - 0.45, p.z + p.facing[1] * 0.21);
        chest.rotation.y = Math.atan2(p.facing[0], p.facing[1]);
        parts.push(chest);
      }
      for (const m of parts) { m.castShadow = true; nameIt(m, { name: p.name }); m.userData.person = true; group(p.lv).add(m); }
    }
    for (const l of built.lines) {
      const a = new THREE.Vector3(...(l.from as [number, number, number]));
      const b = new THREE.Vector3(...(l.to as [number, number, number]));
      const m = new THREE.Mesh(new THREE.CylinderGeometry(l.radius, l.radius, a.distanceTo(b), 6), mat(l.kind));
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      nameIt(m, l);
      group('outdoor').add(m);
    }
    for (const s of built.slopes) {
      const [xa, ya] = s.from;
      const [xb, yb] = s.to;
      const len = Math.hypot(xb - xa, yb - ya);
      const ang = Math.atan2(yb - ya, xb - xa);
      const depth = Math.abs(s.z[1] - s.z[0]);
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, 60, depth), mat(s.kind));
      m.position.set((xa + xb) / 2 + 30 * Math.sin(ang), (ya + yb) / 2 - 30 * Math.cos(ang), (s.z[0] + s.z[1]) / 2);
      m.rotation.z = ang;
      m.receiveShadow = true;
      nameIt(m, s);
      group('outdoor').add(m);
    }
    for (const l of built.labels) {
      const div = document.createElement('div');
      div.className = `scene-lbl ${l.lv === -1 ? 'out' : 'room'}`;
      div.textContent = l.text;
      const o = new CSS2DObject(div);
      o.position.set(l.at[0], l.at[1], l.at[2]);
      o.userData.lv = l.lv;
      t.scene.add(o);
      t.labels.push(o);
    }
    // night lights: one warm lamp per large ground-floor room
    for (const b of built.boxes.filter((x) => x.floor && x.group === 0 && (x.x1 - x.x0) * (x.z1 - x.z0) > 25)) {
      const p = new THREE.PointLight('#ffb45a', 0, 30, 1.6);
      p.position.set((b.x0 + b.x1) / 2, b.y1 + H * 0.75, (b.z0 + b.z1) / 2);
      t.scene.add(p);
      t.lamps.push(p);
    }
    if (bounds.isEmpty()) bounds.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(20, 10, 20));
    t.bounds = bounds;
    const c = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const reach = Math.max(size.x, size.z, 20);
    Object.assign(t.sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: reach * 6 });
    t.sun.shadow.camera.updateProjectionMatrix();
    t.sun.target.position.copy(c);
    if (!t.framed) { // the first scene: look at it from the south-east; later ones keep the view
      t.persp.position.set(c.x + reach * 1.1, c.y + reach * 0.8, c.z + reach * 1.3);
      t.controls.target.copy(c);
      t.framed = true;
    }
    applyView();
    applyLight(light);
  }, [built]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- what is shown ----------
  function applyView() {
    const t = three.current;
    if (!t) return;
    const { floor: f, labels: showLabels } = props.current;
    const top = f === 'all' ? Infinity : f;
    for (const g of t.groups.values()) g.visible = g.userData.group === 'outdoor' || g.userData.group <= top;
    for (const o of t.labels) {
      const lv = o.userData.lv;
      o.visible = showLabels && (lv === -1 ? f === 'all' || f === 0 : lv === f);
    }
  }
  function applyLight(k: Light) {
    const t = three.current;
    if (!t) return;
    const l = LIGHTS[k];
    const c = t.bounds.getCenter(new THREE.Vector3());
    t.sun.position.set(c.x + l.dir[0], l.dir[1], c.z + l.dir[2]);
    t.sun.color.set(l.sun);
    t.sun.intensity = l.i;
    t.hemi.intensity = l.hemi;
    t.scene.background = new THREE.Color(l.sky);
    t.scene.fog = new THREE.Fog(l.sky, l.fog[0], l.fog[1]);
    for (const p of t.lamps) p.intensity = k === 'night' ? 30 : 0;
    const glass = t.mats.get('glass') as THREE.MeshLambertMaterial;
    glass.emissiveIntensity = k === 'night' ? 0.6 : 0;
  }
  useEffect(applyView, [floor, labels]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => applyLight(light), [light]); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    showCamera(i) {
      const t = three.current;
      const c = props.current.built?.cameras[i];
      if (!t || !c) return;
      t.persp.fov = c.fov;
      t.persp.position.set(c.pos[0], c.pos[1], c.pos[2]);
      t.controls.target.set(c.target[0], c.target[1], c.target[2]);
      t.persp.updateProjectionMatrix();
    },
    // people = false leaves the figures out: a location plate for image-to-image shows the place only
    capture(i, people = true) {
      const t = three.current;
      const c = props.current.built?.cameras[i];
      if (!t || !c) return '';
      const cam = new THREE.PerspectiveCamera(c.fov, 16 / 9, 0.1, 6000);
      cam.position.set(c.pos[0], c.pos[1], c.pos[2]);
      cam.lookAt(c.target[0], c.target[1], c.target[2]);
      const size = t.renderer.getSize(new THREE.Vector2());
      const ratio = t.renderer.getPixelRatio();
      const shown = [...t.groups.values()].map((g) => g.visible);
      for (const g of t.groups.values()) g.visible = true; // a reference picture shows the whole building
      const figures: THREE.Object3D[] = [];
      if (!people) t.world.traverse((o) => { if (o.userData.person && o.visible) { figures.push(o); o.visible = false; } });
      t.renderer.setPixelRatio(1);
      t.renderer.setSize(1280, 720, false);
      t.renderer.render(t.scene, cam);
      const url = t.renderer.domElement.toDataURL('image/png');
      [...t.groups.values()].forEach((g, k) => { g.visible = shown[k]; });
      for (const o of figures) o.visible = true;
      t.renderer.setPixelRatio(ratio);
      t.renderer.setSize(size.x, size.y);
      return url;
    },
    exportGlb() {
      const t = three.current!;
      const shown = [...t.groups.values()].map((g) => g.visible);
      for (const g of t.groups.values()) g.visible = true;
      t.world.traverse((o) => { if (o.userData.edge) o.visible = false; });
      return new Promise<ArrayBuffer>((resolve, reject) => {
        new GLTFExporter().parse(t.world, (glb) => {
          [...t.groups.values()].forEach((g, k) => { g.visible = shown[k]; });
          t.world.traverse((o) => { if (o.userData.edge) o.visible = true; });
          resolve(glb as ArrayBuffer);
        }, (e) => reject(e), { binary: true, onlyVisible: true });
      });
    },
  }), []);

  return (
    <div className="scene-view" ref={host}>
      <div className="scene-tip" ref={tip} />
    </div>
  );
});
