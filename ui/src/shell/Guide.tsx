import { Fragment, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { api } from '../api';
import { Button, Icon, Segmented } from '../components';
import { useApp, type PageId } from './context';
import { GUIDE, type GuideItem, type Route } from './guideSteps';
import './guide.css';

const KEY = 'blackbox.guide';
// width: pixels the user dragged or toggled to; absent means the default, which follows the window.
export type GuideSaved = { open: boolean; done: string[]; route: Route; width?: number };

export const GUIDE_MIN = 300;
const WIDE = 600;
// Keep at least this much room for the page next to the guide.
const PAGE_ROOM = 480;
export const guideMax = () => Math.max(GUIDE_MIN, Math.min(1100, window.innerWidth - 56 - PAGE_ROOM));
const clampWidth = (w: number) => Math.round(Math.min(guideMax(), Math.max(GUIDE_MIN, w)));

export function readGuide(): GuideSaved | null {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && typeof saved.open === 'boolean' && Array.isArray(saved.done)) {
      const width = typeof saved.width === 'number' && saved.width >= GUIDE_MIN ? saved.width : undefined;
      return { open: saved.open, done: saved.done, route: saved.route === 'local' ? 'local' : 'cloud', width };
    }
  } catch { /* storage unavailable or damaged: start fresh */ }
  return null;
}
export function saveGuide(saved: GuideSaved) {
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* not remembered, that is all */ }
}

const ROUTES: { value: Route; label: string }[] = [{ value: 'cloud', label: '租云 GPU（AutoDL）' }, { value: 'local', label: '用自己的显卡' }];

// Screenshots of AutoDL with red numbered marks, by file name.
const SHOTS = Object.fromEntries(Object.entries(import.meta.glob('../assets/guide/*.webp', { eager: true, query: '?url', import: 'default' }))
  .map(([file, url]) => [file.split('/').pop()!.replace(/\.webp$/, ''), url as string]));

// 「按钮名」 stand out so the user can match them with what is on screen; [1] is a red number
// matching the mark in the screenshot below it.
function Text({ text }: { text: string }) {
  return <>{text.split(/(「[^」]+」|\[\d+\])/).map((part, i) => part.startsWith('「')
    ? <b key={i} className="g-ui">{part.slice(1, -1)}</b>
    : /^\[\d+\]$/.test(part) ? <span key={i} className="g-num">{part.slice(1, -1)}</span>
    : <Fragment key={i}>{part}</Fragment>)}</>;
}

function Item({ item, zoom }: { item: GuideItem; zoom: (shot: { src: string; alt: string }) => void }) {
  if (typeof item === 'string') return <p className="g-item"><Text text={item} /></p>;
  const src = SHOTS[item.img];
  if (!src) return null;
  return <button type="button" className="g-shot" title="点击放大" onClick={() => zoom({ src, alt: item.alt })}>
    <img src={src} alt={item.alt} loading="lazy" /></button>;
}

// The screenshot at full size over the whole window; a click or Esc closes it.
function Zoom({ shot, close }: { shot: { src: string; alt: string }; close: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [close]);
  return <div className="g-zoom" role="dialog" aria-label={shot.alt} onClick={close}>
    <img src={shot.src} alt={shot.alt} />
    <span>点击任意处关闭</span>
  </div>;
}

/** The guide docked beside every page, so the user can follow it while working. */
export function Guide({ page, saved, update }: {
  page: PageId; saved: GuideSaved; update: (change: Partial<GuideSaved>) => void;
}) {
  const { go, project, settingsTab } = useApp();
  const { done, route } = saved;
  const [keySet, setKeySet] = useState(false);
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);

  // Drag the left edge: the column follows the pointer live, the width is saved on release.
  function startResize(e: ReactPointerEvent<HTMLDivElement>) {
    const app = panel.current?.closest('.app') as HTMLElement | null;
    if (!app || !panel.current) return;
    e.preventDefault();
    const handle = e.currentTarget;
    try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic pointers have no capture; moves still reach the handle */ }
    const startX = e.clientX, startWidth = panel.current.getBoundingClientRect().width;
    let width = startWidth;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      width = clampWidth(startWidth + startX - ev.clientX);
      app.style.setProperty('--guide-w', width + 'px');
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      setDragging(false);
      update({ width });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
  const wide = (saved.width ?? panel.current?.getBoundingClientRect().width ?? 0) >= WIDE - 20;
  // Re-read on every page change: the key is usually filled in on the settings page.
  useEffect(() => {
    let live = true;
    api.getConfig().then((r) => { if (live) setKeySet(!!r.config?.llm?.apiKeySet); }).catch(() => {});
    return () => { live = false; };
  }, [page, settingsTab]);

  const steps = GUIDE.filter((s) => !s.route || s.route === route);
  // Steps the app can see for itself count as done without a click.
  const auto = new Set([...(project ? ['project'] : []), ...(keySet ? ['ai'] : [])]);
  const isDone = (id: string) => done.includes(id) || auto.has(id);
  const firstOpen = steps.find((s) => !isDone(s.id))?.id ?? null;
  const [expanded, setExpanded] = useState<string | null>(firstOpen);
  const count = steps.filter((s) => isDone(s.id)).length;
  // The key or project shows up after the first render: move past a step that just completed itself.
  useEffect(() => {
    if (expanded && auto.has(expanded)) setExpanded(firstOpen);
  }, [keySet, project]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleDone(id: string) {
    if (done.includes(id)) { update({ done: done.filter((d) => d !== id) }); return; }
    const next = [...done, id];
    update({ done: next });
    const after = steps.slice(steps.findIndex((s) => s.id === id) + 1).find((s) => !next.includes(s.id) && !auto.has(s.id));
    setExpanded(after?.id ?? null);
    // Bring the next step into view; a long step can push it below the fold.
    if (after) requestAnimationFrame(() => document.getElementById(`guide-${after.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  function switchRoute(next: Route) {
    update({ route: next });
    setExpanded(GUIDE.find((s) => (!s.route || s.route === next) && !isDone(s.id))?.id ?? null);
  }

  return <aside className={dragging ? 'guide resizing' : 'guide'} id="guide" aria-label="使用指南" ref={panel}>
    <div className="g-resize" role="separator" aria-orientation="vertical" aria-label="调整指南宽度"
      title="拖动调整宽度，双击恢复默认" onPointerDown={startResize} onDoubleClick={() => update({ width: undefined })} />
    <header className="g-head">
      <div><strong>使用指南</strong><span className="muted">{count === steps.length ? '全部完成' : `已完成 ${count} / ${steps.length}`}</span></div>
      <div className="g-head-actions">
        <Button variant="ghost" size="sm" id="guide-wide" aria-pressed={wide} title={wide ? '恢复默认宽度' : '放宽指南，截图看得更清楚'}
          onClick={() => update({ width: wide ? undefined : clampWidth(WIDE) })}><Icon name="expand" />{wide ? '收窄' : '放宽'}</Button>
        <Button variant="ghost" size="sm" aria-label="收起指南" title="收起指南，左侧「指南」可再打开" onClick={() => update({ open: false })}><Icon name="x" /></Button>
      </div>
    </header>
    <progress className="g-progress" max={steps.length} value={count} aria-label="指南完成进度" />
    <div className="g-route">
      <span>在哪里出片</span>
      <Segmented id="guide-route" wide options={ROUTES} value={route} onChange={switchRoute} />
    </div>
    <ol className="g-steps">
      {steps.map((step, i) => {
        const finished = isDone(step.id);
        const open = expanded === step.id;
        const here = step.go && step.go.page === page && (!step.go.tab || step.go.tab === settingsTab);
        const heading = i === 0 || steps[i - 1].part !== step.part;
        return <Fragment key={step.id}>
          {heading && <li className="g-part" aria-hidden>{step.part}</li>}
          <li id={`guide-${step.id}`} className={'g-step ' + (finished ? 'done ' : '') + (open ? 'open' : '')}>
            <button type="button" className="g-title" aria-expanded={open} onClick={() => setExpanded(open ? null : step.id)}>
              <span className="n">{finished ? <Icon name="check" size={12} /> : i + 1}</span>
              <span className="t">{step.title}</span>
              {step.optional && <span className="tag">可选</span>}
              <Icon name="chevron" size={14} />
            </button>
            {open && <div className="g-body">
              <p className="g-goal">{step.goal}</p>
              <div className="g-items">{step.items.map((item, n) => <Item key={n} item={item} zoom={setZoomed} />)}</div>
              {step.warn && <p className="g-warn"><Icon name="warn" size={14} /><span><Text text={step.warn} /></span></p>}
              {step.tip && <p className="g-tip"><Text text={step.tip} /></p>}
              <div className="g-actions">
                {step.go && !here && <Button size="sm" variant="primary" onClick={() => go(step.go!.page, step.go!.tab)}>{step.go.label}</Button>}
                {step.links?.map((link) => <Button key={link.site} size="sm" onClick={() => api.cloudOpen(link.site)}><Icon name="link" />{link.label}</Button>)}
                {!auto.has(step.id) && <Button size="sm" variant="ghost" className="g-mark" onClick={() => toggleDone(step.id)}>
                  {finished ? '标为未完成' : '这步做完了'}</Button>}
              </div>
            </div>}
          </li>
        </Fragment>;
      })}
    </ol>
    {zoomed && <Zoom shot={zoomed} close={() => setZoomed(null)} />}
  </aside>;
}
