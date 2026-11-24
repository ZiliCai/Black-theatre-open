// The pure helper modules in renderer/ are shared with node:test. In the page they register themselves on window.
/* eslint-disable @typescript-eslint/no-explicit-any */
import '../../renderer/format.js';
import '../../renderer/gallery-filter.js';
import '../../renderer/markdown.js';
import '../../renderer/model-filter.js';
import '../../renderer/budget-calc.js';
import '../../renderer/workflow-math.js';

const w = window as any;

export const LauncherFormat: {
  formatGB(bytes: number | null): string;
  formatMB(mb: number | null): string;
  formatBytes(bytes: number): string;
  stateInfo(state: string): { text: string; tone: 'ok' | 'warn' | 'idle' | 'bad' };
  percent(used: number, total: number): number;
  usageTone(pct: number): string;
  procMemTone(procMB: number | null, ramTotal: number | null): string;
  formatAgo(ts: number, now: number): string;
  formatPathParts(p: string): { head: string; tail: string };
  vramView(o: { used: number; total: number | null; queueRunning: number | null; queuePending: number | null }): { pct: number; tone: string; holdingModels: boolean };
} = w.LauncherFormat;

export const GalleryFilter: any = w.GalleryFilter;
export const Markdown: { parseMarkdown(text: string): any[]; parseInline(text: string): any[] } = w.Markdown;
export const ModelFilter: any = w.ModelFilter;
export const BudgetCalc: any = w.BudgetCalc;
export const WorkflowMath: {
  dimensions(aspect: { w: number; h: number }, megapixels: number): { width: number; height: number };
  resolutionTier(width: number, height: number): string;
  frameCount(duration: number): number;
} = w.WorkflowMath;
