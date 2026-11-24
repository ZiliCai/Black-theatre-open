import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Loose, QueueSnapshot, Status } from '../api';

export type PageId = 'shots' | 'script' | 'scene' | 'gallery' | 'assets' | 'settings';
export type SettingsTab = 'run' | 'remote' | 'projects' | 'dirs' | 'models' | 'general';

export type AppState = {
  status: Status | null;
  queue: QueueSnapshot;
  project: { dir: string; name: string } | null;
  projects: Loose[];
  // bumped whenever the active project changes, so pages reload what they show
  projectVersion: number;
  refreshProjects: () => Promise<void>;
  go: (page: PageId, tab?: SettingsTab) => void;
  settingsTab: SettingsTab;
  topSlot: HTMLElement | null;
  crumbSlot: HTMLElement | null;
  // a page with unsaved work answers "may the user leave?" (true = yes) before navigation happens
  setLeaveGuard: (guard: (() => Promise<boolean>) | null) => void;
};

export const AppContext = createContext<AppState>(null as unknown as AppState);
export const useApp = () => useContext(AppContext);

// A page puts its main buttons into the top bar, and the rest of its breadcrumb, through these.
export function TopActions({ children }: { children: ReactNode }) {
  const { topSlot } = useApp();
  return topSlot ? createPortal(children, topSlot) : null;
}
export function Crumbs({ children }: { children: ReactNode }) {
  const { crumbSlot } = useApp();
  return crumbSlot ? createPortal(children, crumbSlot) : null;
}
