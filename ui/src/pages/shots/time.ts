import type { Segment } from '../../api';

// Same rule as locate() in src/take-rules.js (tested there): which segment time t falls in, and how far into it.
export function locate(segments: Pick<Segment, 'start' | 'duration'>[], t: number): { index: number; offset: number } | null {
  if (!segments.length) return null;
  const last = segments.length - 1;
  if (t <= 0) return { index: 0, offset: 0 };
  for (let i = 0; i <= last; i++) {
    const s = segments[i];
    if (t < s.start + s.duration || i === last) {
      return { index: i, offset: Math.round(Math.min(Math.max(t - s.start, 0), s.duration) * 1000) / 1000 };
    }
  }
  return null;
}

export function formatTime(seconds: number) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

export const shotNo = (id: string) => (/^HAND-/i.test(id) ? `手动${id.split('-').pop()}` : id.split('-').pop() || id);
