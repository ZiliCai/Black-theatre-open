import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Icon } from '../components';
import { useApp, type PageId } from './context';
import { GUIDE } from './guideSteps';
import './guide.css';

const KEY = 'blackbox.guide';
type Saved = { open: boolean; done: string[] };

export function readGuide(): Saved | null {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && typeof saved.open === 'boolean' && Array.isArray(saved.done)) return saved;
  } catch { /* storage unavailable or damaged: start fresh */ }
  return null;
}
export function saveGuide(saved: Saved) {
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* not remembered, that is all */ }
}

// 「按钮名」 stand out so the user can match them with what is on screen.
function Text({ text }: { text: string }) {
  return <>{text.split(/(「[^」]+」)/).map((part, i) => part.startsWith('「')
    ? <b key={i} className="g-ui">{part.slice(1, -1)}</b> : <Fragment key={i}>{part}</Fragment>)}</>;
}

/** The guide docked beside every page, so the user can follow it while working. */
export function Guide({ page, done, setDone, onClose }: {
  page: PageId; done: string[]; setDone: (done: string[]) => void; onClose: () => void;
}) {
  const { go, project, settingsTab } = useApp();
  const [keySet, setKeySet] = useState(false);
  // Re-read on every page change: the key is usually filled in on the settings page.
  useEffect(() => {
    let live = true;
    api.getConfig().then((r) => { if (live) setKeySet(!!r.config?.llm?.apiKeySet); }).catch(() => {});
    return () => { live = false; };
  }, [page, settingsTab]);

  // Steps the app can see for itself count as done without a click.
  const auto = new Set([...(project ? ['project'] : []), ...(keySet ? ['ai'] : [])]);
  const isDone = (id: string) => done.includes(id) || auto.has(id);
  const firstOpen = GUIDE.find((s) => !isDone(s.id))?.id ?? null;
  const [expanded, setExpanded] = useState<string | null>(firstOpen);
  const count = GUIDE.filter((s) => isDone(s.id)).length;
  // The key or project shows up after the first render: move past a step that just completed itself.
  useEffect(() => {
    if (expanded && auto.has(expanded)) setExpanded(firstOpen);
  }, [keySet, project]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleDone(id: string) {
    if (done.includes(id)) { setDone(done.filter((d) => d !== id)); return; }
    const next = [...done, id];
    setDone(next);
    const after = GUIDE.slice(GUIDE.findIndex((s) => s.id === id) + 1).find((s) => !next.includes(s.id) && !auto.has(s.id));
    setExpanded(after?.id ?? null);
  }

  return <aside className="guide" id="guide" aria-label="使用指南">
    <header className="g-head">
      <div><strong>使用指南</strong><span className="muted">{count === GUIDE.length ? '全部完成' : `已完成 ${count} / ${GUIDE.length}`}</span></div>
      <Button variant="ghost" size="sm" aria-label="收起指南" title="收起指南，左侧「指南」可再打开" onClick={onClose}><Icon name="x" /></Button>
    </header>
    <progress className="g-progress" max={GUIDE.length} value={count} aria-label="指南完成进度" />
    <ol className="g-steps">
      {GUIDE.map((step, i) => {
        const finished = isDone(step.id);
        const open = expanded === step.id;
        const here = step.go && step.go.page === page && (!step.go.tab || step.go.tab === settingsTab);
        return <li key={step.id} id={`guide-${step.id}`} className={(finished ? 'done ' : '') + (open ? 'open' : '')}>
          <button type="button" className="g-title" aria-expanded={open} onClick={() => setExpanded(open ? null : step.id)}>
            <span className="n">{finished ? <Icon name="check" size={12} /> : i + 1}</span>
            <span className="t">{step.title}</span>
            {step.optional && <span className="tag">可选</span>}
            <Icon name="chevron" size={14} />
          </button>
          {open && <div className="g-body">
            <p className="g-goal">{step.goal}</p>
            <ol className="g-items">{step.items.map((item) => <li key={item}><Text text={item} /></li>)}</ol>
            {step.tip && <p className="g-tip"><Text text={step.tip} /></p>}
            <div className="g-actions">
              {step.go && !here && <Button size="sm" variant="primary" onClick={() => go(step.go!.page, step.go!.tab)}>{step.go.label}</Button>}
              {step.open && <Button size="sm" onClick={() => api.cloudOpen(step.open!.site)}><Icon name="link" />{step.open.label}</Button>}
              {!auto.has(step.id) && <Button size="sm" variant="ghost" className="g-mark" onClick={() => toggleDone(step.id)}>
                {finished ? '标为未完成' : '这步做完了'}</Button>}
            </div>
          </div>}
        </li>;
      })}
    </ol>
  </aside>;
}
