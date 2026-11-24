import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type Loose, type QueueSnapshot, type Status } from './api';
import { Button, EmptyState, useToast } from './components';
import { AppContext, type AppState, type PageId, type SettingsTab } from './shell/context';
import { TopBar } from './shell/TopBar';
import { NavRail } from './shell/NavRail';
import { AlertBanner, PendingBanner } from './shell/AlertBanner';
import { AssetsPage } from './pages/assets/AssetsPage';
import { ShotsPage } from './pages/shots/ShotsPage';
import { GalleryPage } from './pages/gallery/GalleryPage';
import { ScriptPage } from './pages/script/ScriptPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import './shell/shell.css';

const ScenePage = lazy(() => import('./pages/scene/ScenePage').then(({ ScenePage }) => ({ default: ScenePage })));
const EMPTY_QUEUE: QueueSnapshot = { busy: false, paused: false, message: '', jobs: [] };
const PAGE_KEY = 'blackbox.page';

class ScenePageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <EmptyState title={<span role="alert">场景页无法打开</span>}
        action={<Button onClick={() => window.location.reload()}>重新加载界面</Button>} />;
    }
    return this.props.children;
  }
}

const readPage = (): PageId => {
  try {
    const saved = localStorage.getItem(PAGE_KEY);
    if (saved === 'shots' || saved === 'script' || saved === 'scene' || saved === 'gallery' || saved === 'assets' || saved === 'settings') return saved;
  } catch { /* storage unavailable: start on the shot page */ }
  return 'shots';
};

export function App() {
  const [page, setPage] = useState<PageId>(readPage);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [status, setStatus] = useState<Status | null>(null);
  const [queue, setQueue] = useState<QueueSnapshot>(EMPTY_QUEUE);
  const [projects, setProjects] = useState<Loose[]>([]);
  const [projectVersion, setProjectVersion] = useState(0);
  const [topSlot, setTopSlot] = useState<HTMLElement | null>(null);
  const [crumbSlot, setCrumbSlot] = useState<HTMLElement | null>(null);
  const toast = useToast();

  const refreshProjects = useCallback(async () => {
    const r = await api.listProjects();
    setProjects(r.projects || []);
    setProjectVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    refreshProjects();
    api.queueSnapshot().then(setQueue);
    // a setting that keeps ComfyUI from starting is the first thing to see
    api.getConfig().then((r) => {
      if (r.config.cloudWelcome === 'pending' || (r.config.cloudWelcome === 'watch' && r.config.target === r.config.setupWatch?.id)) {
        setPage('settings');
        setSettingsTab(r.config.cloudWelcome === 'pending' ? 'welcome' : 'remote');
      } else if (!r.validation.ok && r.config.target === 'local') {
        setPage('settings');
        setSettingsTab('general');
      }
    });
    const offs = [
      api.onStatus(setStatus),
      api.onQueue(setQueue),
      api.onNotice((n) => toast(n.message, { tone: 'ok', ms: 6000 })),
    ];
    return () => offs.forEach((off) => off());
  }, [refreshProjects, toast]);

  const leaveGuard = useRef<(() => Promise<boolean>) | null>(null);
  const setLeaveGuard = useCallback((guard: (() => Promise<boolean>) | null) => { leaveGuard.current = guard; }, []);
  const go = useCallback(async (next: PageId, tab?: SettingsTab) => {
    if (leaveGuard.current && !(await leaveGuard.current())) return;
    setPage(next);
    if (tab) setSettingsTab(tab);
    try { localStorage.setItem(PAGE_KEY, next); } catch { /* not remembered, that is all */ }
  }, []);

  const active = projects.find((p) => p.active);
  const state: AppState = useMemo(() => ({
    status, queue, projects, projectVersion, refreshProjects, go, settingsTab, topSlot, crumbSlot, setLeaveGuard,
    project: active ? { dir: active.dir, name: active.name } : null,
  }), [status, queue, projects, projectVersion, refreshProjects, go, settingsTab, topSlot, crumbSlot, setLeaveGuard, active]);

  const setSlots = useCallback(({ top, crumb }: { top: HTMLElement | null; crumb: HTMLElement | null }) => {
    if (top) setTopSlot(top);
    if (crumb) setCrumbSlot(crumb);
  }, []);

  return (
    <AppContext.Provider value={state}>
      <div className="app">
        <TopBar setSlots={setSlots} />
        <div className="banner-wrap" style={{ gridColumn: '1 / -1' }}><AlertBanner /><PendingBanner /></div>
        <NavRail page={page} />
        <main className="page" id={`page-${page}`} key={page}>
          {page === 'shots' ? <ShotsPage />
            : page === 'gallery' ? <GalleryPage />
            : page === 'script' ? <ScriptPage />
            : page === 'scene' ? (
              <ScenePageBoundary>
                <Suspense fallback={<p className="c-empty" role="status">正在加载场景…</p>}>
                  <ScenePage />
                </Suspense>
              </ScenePageBoundary>
            )
            : page === 'settings' ? <SettingsPage />
            : <AssetsPage />}
        </main>
      </div>
    </AppContext.Provider>
  );
}
