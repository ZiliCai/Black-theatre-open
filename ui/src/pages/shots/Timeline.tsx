import { useEffect, useLayoutEffect, useRef, type MouseEvent, type ReactNode, type WheelEvent } from 'react';
import { mediaUrl, type Segment } from '../../api';
import { Button, Icon, Segmented } from '../../components';
import { formatTime, shotNo } from './time';
import type { Playback } from './usePlayback';

export type GapMode = 'black' | 'cand' | 'skip';
const GAP_OPTIONS: { value: GapMode; label: string }[] = [
  { value: 'black', label: '黑屏占位' }, { value: 'cand', label: '用候选顶上' }, { value: 'skip', label: '跳过' },
];
// a second of film is at least this wide, and a clip never narrower than its thumbnail and number; when the
// episode is shorter than the window the clips grow to fill it
const PX_PER_SECOND = 16;
const MIN_CLIP = 84;
const STATUS = (seg: Segment) => (seg.kind === 'pick' ? '已选中' : seg.kind === 'cand' ? '候选' : seg.hasCand ? '只有候选' : '未生成');

// The episode as a strip: one box per shot, as wide as it is long, showing its pick. ▶ plays them in order.
// Many shots do not squeeze together: the strip scrolls sideways and keeps the current shot in view.
export function Timeline({ segments, total, shotId, playback, gapMode, onGapMode, onShot, episodeActions }: {
  segments: Segment[]; total: number; shotId: string; playback: Playback;
  gapMode: GapMode; onGapMode: (m: GapMode) => void; onShot: (id: string) => void;
  // whole-episode actions (upscale the episode) sit with the strip that is the episode
  episodeActions?: ReactNode;
}) {
  const track = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const clickClip = (e: MouseEvent<HTMLDivElement>, seg: Segment) => {
    if (!playback.playing) {
      onShot(seg.shotId);
      playback.seek(seg.start);
      return;
    }
    const box = e.currentTarget.getBoundingClientRect();
    playback.seek(seg.start + ((e.clientX - box.left) / box.width) * seg.duration);
  };
  // clips are not all the same seconds-per-pixel (short ones keep a minimum width), so the playhead is placed
  // inside the clip it is in
  const playing = segments.find((s) => playback.pos >= s.start && playback.pos < s.start + s.duration) || segments[segments.length - 1];
  useLayoutEffect(() => {
    const el = head.current;
    const box = playing && track.current?.querySelector<HTMLElement>(`[data-shot="${playing.shotId}"]`);
    if (!el || !box || !playing) return;
    const frac = playing.duration ? Math.min(1, Math.max(0, (playback.pos - playing.start) / playing.duration)) : 0;
    el.style.left = `${box.offsetLeft + frac * box.offsetWidth - 1}px`;
  });
  // the shot being looked at, or played, stays in view
  const follow = playback.playing ? playing?.shotId : shotId;
  useEffect(() => {
    const box = follow && track.current?.querySelector<HTMLElement>(`[data-shot="${follow}"]`);
    const t = track.current;
    if (!box || !t) return;
    if (box.offsetLeft < t.scrollLeft || box.offsetLeft + box.offsetWidth > t.scrollLeft + t.clientWidth) {
      t.scrollTo({ left: box.offsetLeft - t.clientWidth / 3, behavior: 'smooth' });
    }
  }, [follow, segments.length]);
  // a plain mouse wheel scrolls the strip sideways
  const wheel = (e: WheelEvent<HTMLDivElement>) => {
    const t = track.current;
    if (!t || t.scrollWidth <= t.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    t.scrollLeft += e.deltaY;
  };
  return (
    <section className="timeline" id="timeline">
      <div className="tl-bar">
        <Button id="btn-play" variant={playback.playing ? 'primary' : 'default'} disabled={!segments.length} onClick={playback.toggle}>
          <Icon name={playback.playing ? 'pause' : 'play'} size={14} />{playback.playing ? '暂停' : '连起来看'}
        </Button>
        <span className="time num" id="tl-time"><b>{formatTime(playback.pos)}</b> / {formatTime(total)}</span>
        {episodeActions ? <span className="tl-episode">{episodeActions}</span> : null}
        <span style={{ flex: 1 }} />
        <span className="lab">没选中的镜头：</span>
        <Segmented id="gap-mode" options={GAP_OPTIONS} value={gapMode} onChange={onGapMode} />
      </div>
      <div className="track" id="track" ref={track} onWheel={wheel}>
        <div className="track-in" style={{ width: segments.reduce((w, s) => w + Math.max(MIN_CLIP, s.duration * PX_PER_SECOND) + 3, 0) }}>
          {segments.map((seg) => (
            <div key={seg.shotId} data-shot={seg.shotId} data-kind={seg.kind} title={`镜头 ${shotNo(seg.shotId)} · ${STATUS(seg)} · ${seg.duration.toFixed(1)} 秒`}
              className={`clip ${seg.shotId === shotId ? 'on' : ''} ${seg.stale ? 'has-stale' : ''}`}
              style={{ flex: `${seg.duration} 0 ${Math.max(MIN_CLIP, seg.duration * PX_PER_SECOND)}px` }} onClick={(e) => clickClip(e, seg)}>
              {seg.linked ? <span className="link" title="接上一镜生成"><Icon name="link" size={11} /></span> : null}
              <div className="im">
                {seg.video && seg.kind !== 'gap'
                  ? <><video src={`${mediaUrl('project', seg.video)}#t=0.1`} preload="metadata" muted /><div className="fill" /></>
                  : <div className="gap">{seg.hasCand ? '只有候选' : '未生成'}</div>}
              </div>
              {seg.stale ? <span className="stale" title={seg.stale === 'prev-changed' ? '上一镜换了选中，这一镜可能接不上' : '上游镜头换了选中，这一镜可能接不上'}><Icon name="warn" size={13} /></span> : null}
              <div className="cap num">
                <b>{shotNo(seg.shotId)}</b>
                <i className={`dot ${seg.kind === 'pick' ? 'ok' : seg.kind === 'cand' ? 'c' : ''}`} aria-label={STATUS(seg)} />
                <span>{seg.duration.toFixed(1)}s</span>
              </div>
            </div>
          ))}
          {segments.length ? <div className="playhead" id="playhead" ref={head} /> : null}
        </div>
      </div>
    </section>
  );
}
