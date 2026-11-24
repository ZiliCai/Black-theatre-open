import { useCallback, useEffect, useRef, useState } from 'react';
import type { Segment } from '../../api';
import { locate } from './time';

export type Playback = {
  playing: boolean;
  pos: number; // seconds into the episode
  index: number; // segment being shown
  seekOffset: { offset: number; token: number }; // where the video of the current segment must jump to
  toggle: () => void;
  stop: () => void;
  seek: (t: number) => void;
  // reported by the <video> of a segment that has one
  onVideoTime: (currentTime: number) => void;
  onVideoEnded: () => void;
};

// Plays the episode: each segment's pick in turn, a gap as black for its length. The position comes from the
// video while one plays and from the clock during gaps.
export function usePlayback(segments: Segment[]): Playback {
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [seekOffset, setSeekOffset] = useState({ offset: 0, token: 0 });
  const total = segments.length ? segments[segments.length - 1].start + segments[segments.length - 1].duration : 0;
  const at = locate(segments, pos);
  const index = at ? at.index : 0;
  const posRef = useRef(pos);
  posRef.current = pos;

  const jumpTo = useCallback((t: number) => {
    const clamped = Math.min(Math.max(t, 0), total);
    setPos(clamped);
    const found = locate(segments, clamped);
    setSeekOffset((s) => ({ offset: found ? found.offset : 0, token: s.token + 1 }));
  }, [segments, total]);

  const next = useCallback(() => {
    const seg = segments[index];
    if (!seg || index >= segments.length - 1) {
      setPlaying(false);
      setPos(total);
      return;
    }
    jumpTo(seg.start + seg.duration);
  }, [segments, index, total, jumpTo]);

  // gaps (and segments whose video cannot play) advance on the clock
  const seg = segments[index];
  const clockDriven = playing && seg && (seg.kind === 'gap' || !seg.video);
  useEffect(() => {
    if (!clockDriven) return undefined;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const t = posRef.current + (now - last) / 1000;
      last = now;
      if (t >= seg.start + seg.duration) {
        next();
        return;
      }
      setPos(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clockDriven, seg, next]);

  // a timeline that changes underneath (new pick, other gap mode) keeps the position inside it
  useEffect(() => { if (posRef.current > total) setPos(total); }, [total]);

  return {
    playing,
    pos,
    index,
    seekOffset,
    toggle: () => {
      if (!segments.length) return;
      if (!playing && posRef.current >= total - 0.05) jumpTo(0);
      setPlaying((p) => !p);
    },
    stop: () => setPlaying(false),
    seek: jumpTo,
    onVideoTime: (currentTime) => {
      if (!playing || !seg) return;
      setPos(seg.start + Math.min(currentTime, seg.duration));
    },
    onVideoEnded: () => { if (playing) next(); },
  };
}
