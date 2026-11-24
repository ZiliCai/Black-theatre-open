import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { mediaUrl, type QueueJob, type Segment, type Take, type Tier } from '../../api';
import { Button, Icon, Segmented } from '../../components';
import { formatRemaining } from '../../shell/QueueIndicator';
import { shotNo } from './time';
import type { Playback } from './usePlayback';
import { takeState, upscaleBadge } from './TakeStrip';

const STALE: Record<string, string> = { 'prev-changed': '上一镜换了选中，这条可能接不上', 'upstream-changed': '上游镜头换了选中，这条可能接不上' };

// One segment of the episode while it plays through. Two players take turns: while one plays, the other has the
// next shot loaded and stopped on its first frame, so the cut swaps to a picture that is already there instead of
// a fresh player that is black until it loads (the flicker between shots).
type Slots = { srcs: [string, string]; front: 0 | 1 };

// ---------- sound across the cuts ----------
// Each shot's sound is generated on its own: one comes out 15 dB louder than the next, and many start and end
// abruptly. While playing through, every shot is brought to the same loudness and faded in and out briefly.
const AUDIO_FADE = 0.12; // seconds of fade at each end of a shot
const TARGET_DB = -30; // loudness every shot is brought to (RMS of the whole clip)
const MAX_GAIN_DB = 12;
let audioCtx: AudioContext | null = null;
const ctx = () => (audioCtx ||= new AudioContext());
const loudness = new Map<string, Promise<number | null>>();
function loudnessOf(src: string) {
  let p = loudness.get(src);
  if (!p) {
    p = (async () => {
      try {
        const audio = await ctx().decodeAudioData(await (await fetch(src)).arrayBuffer());
        let sum = 0;
        let n = 0;
        for (let c = 0; c < audio.numberOfChannels; c++) {
          const data = audio.getChannelData(c);
          for (let i = 0; i < data.length; i += 4) { sum += data[i] * data[i]; n++; }
        }
        return n && sum > 0 ? 10 * Math.log10(sum / n) : null;
      } catch {
        return null; // no sound track, or not readable: played as it is
      }
    })();
    loudness.set(src, p);
  }
  return p;
}
const gainFor = (db: number | null) => (db === null ? 1 : 10 ** (Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, TARGET_DB - db)) / 20));

function PlayScreen({ segment, next, playback, upscaled }: { segment: Segment; next?: Segment; playback: Playback; upscaled: boolean }) {
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const players = [a, b];
  const srcOf = (s?: Segment) => {
    const file = s && s.kind !== 'gap' ? (upscaled && s.upscaled) || s.video : null;
    return file ? mediaUrl('project', file) : '';
  };
  const want = srcOf(segment);
  const upcoming = srcOf(next);
  const [slots, setSlots] = useState<Slots>({ srcs: [want, upcoming], front: 0 });

  // before the browser paints: the player that already holds this shot comes to the front, the other loads the next
  useLayoutEffect(() => {
    setSlots((old) => {
      let front = old.front;
      const srcs: [string, string] = [...old.srcs];
      if (want && srcs[front] !== want) {
        if (srcs[1 - front] === want) front = (1 - front) as 0 | 1;
        else srcs[front] = want; // a jump to somewhere not prepared: this one loads it
      }
      if (upcoming && srcs[1 - front] !== upcoming) srcs[1 - front] = upcoming;
      return front === old.front && srcs[0] === old.srcs[0] && srcs[1] === old.srcs[1] ? old : { srcs, front };
    });
  }, [want, upcoming]);

  const frontRef = players[slots.front];
  const backRef = players[1 - slots.front];
  const ready = !!want && slots.srcs[slots.front] === want;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const v = frontRef.current;
    const context = canvas?.getContext('2d', { alpha: false });
    if (!ready || !canvas || !context || !v) return;
    const draw = () => {
      if (v.seeking || v.readyState < 2 || !v.videoWidth || !v.videoHeight || v.currentSrc !== v.src) return;
      const width = Math.round(canvas.clientWidth * devicePixelRatio);
      const height = Math.round(canvas.clientHeight * devicePixelRatio);
      if (!width || !height) return;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const scale = Math.min(width / v.videoWidth, height / v.videoHeight);
      const w = v.videoWidth * scale;
      const h = v.videoHeight * scale;
      context.fillStyle = 'black';
      context.fillRect(0, 0, width, height);
      context.drawImage(v, (width - w) / 2, (height - h) / 2, w, h);
    };
    const frameCallbacks = typeof v.requestVideoFrameCallback === 'function';
    let handle = 0;
    const tick = () => {
      if (!v.paused) draw();
      handle = frameCallbacks ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    const events = ['loadeddata', 'seeked', 'pause'];
    events.forEach(event => v.addEventListener(event, draw));
    const observer = new ResizeObserver(draw);
    observer.observe(canvas, { box: 'device-pixel-content-box' });
    draw();
    tick();
    return () => {
      if (frameCallbacks) v.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
      observer.disconnect();
      events.forEach(event => v.removeEventListener(event, draw));
    };
  }, [frontRef, ready, want]);

  // the front player goes to where the episode is (a jump, or 0 for the next shot) and plays
  useEffect(() => {
    const v = frontRef.current;
    if (!v || !ready) return;
    const apply = () => {
      if (Math.abs(v.currentTime - playback.seekOffset.offset) > 0.05) v.currentTime = playback.seekOffset.offset;
      if (playback.playing) v.play().catch(() => {});
    };
    if (v.readyState >= 1) apply(); else v.addEventListener('loadedmetadata', apply, { once: true });
  }, [slots.front, ready, playback.seekOffset.token]); // eslint-disable-line react-hooks/exhaustive-deps

  // the back player waits on the first frame of the next shot
  useEffect(() => {
    const v = backRef.current;
    if (!v) return;
    v.pause();
    if (v.currentTime > 0.05 && v.readyState >= 1) v.currentTime = 0;
  }, [slots]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = frontRef.current;
    if (!v || !ready) return;
    if (playback.playing) v.play().catch(() => {}); else v.pause();
  }, [playback.playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // both players play through a gain each: the shot's level, times a short fade at its ends
  // (requestAnimationFrame, since timeupdate is too coarse for a fade)
  const gains = useRef<(GainNode | null)[]>([null, null]);
  useEffect(() => {
    players.forEach((ref, i) => {
      if (!ref.current || gains.current[i]) return;
      try {
        const g = ctx().createGain();
        ctx().createMediaElementSource(ref.current).connect(g).connect(ctx().destination);
        gains.current[i] = g;
      } catch { /* no Web Audio: the player keeps its own output */ }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const v = frontRef.current;
    const g = gains.current[slots.front];
    if (!v || !ready || !g) return undefined;
    let level = 1;
    let live = true;
    loudnessOf(slots.srcs[slots.front]).then((db) => { if (live) level = gainFor(db); });
    if (ctx().state === 'suspended') ctx().resume().catch(() => {});
    let raf = 0;
    const tick = () => {
      const d = v.duration;
      const edge = Number.isFinite(d) && d > 0 ? Math.max(0, Math.min(1, Math.min(v.currentTime, d - v.currentTime) / AUDIO_FADE)) : 1;
      g.gain.value = level * edge;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { live = false; cancelAnimationFrame(raf); };
  }, [slots.front, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <canvas ref={canvasRef} hidden={!want} />
      {players.map((ref, i) => {
        const isFront = i === slots.front;
        return (
          <video key={i} ref={ref} src={slots.srcs[i] || undefined} preload="auto" playsInline muted={!isFront} crossOrigin="anonymous"
            className={`pv ${isFront && ready ? 'front' : ''}`}
            onTimeUpdate={isFront ? (e) => playback.onVideoTime(e.currentTarget.currentTime) : undefined}
            onEnded={isFront ? playback.onVideoEnded : undefined} />
        );
      })}
      {!want ? <div className="gap">镜头 {shotNo(segment.shotId)} · {segment.hasCand ? '只有候选，还没选中' : '还没生成'}<br /><span className="num">{segment.duration.toFixed(1)} 秒黑屏</span></div> : null}
      <span className="tag">镜头 {shotNo(segment.shotId)}{segment.kind === 'cand' ? ' · 候选' : ''}{upscaled && segment.upscaled ? ' · 超分' : ''}</span>
    </>
  );
}

const STAGE: Record<string, string> = { prep: '准备中（加载模型、读提示词）…', tail: '解码、保存中…' };

function formatSpent(ms: number) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
}

// How far along the whole run of the shown take is, in the middle of the screen (along the bottom when there is
// a preview to see). `ahead` is how many jobs wait before it in the queue.
function GenProgress({ job, ahead, onPicture }: { job: QueueJob; ahead: number; onPicture: boolean }) {
  const queued = job.status === 'queued';
  const pct = queued ? null : Math.min(100, Math.round(job.progress * 100));
  const title = queued ? (ahead ? `排队中 · 前面还有 ${ahead} 条` : '排队中')
    : job.status === 'cancelling' ? '正在取消…'
      : job.stage === 'steps' && job.max ? `采样 ${job.value}/${job.max} 步` : STAGE[job.stage] || '生成中…';
  const foot = queued ? (job.remainingMs ? `每条大约 ${formatSpent(job.remainingMs)}` : '')
    : [job.elapsedMs ? `已用 ${formatSpent(job.elapsedMs)}` : '', job.remainingMs ? `剩余 ${formatRemaining(job.remainingMs)}` : ''].filter(Boolean).join(' · ');
  return (
    <div className={`gen ${onPicture ? 'on-pic' : ''}`} data-status={job.status}
      role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
      <div className="gen-head"><span>{title}</span>{pct !== null ? <b className="num">{pct}%</b> : null}</div>
      <div className="gen-bar">{pct !== null ? <i style={{ left: `${pct}%` }} /> : null}</div>
      {foot ? <div className="gen-foot num">{foot}</div> : null}
    </div>
  );
}

export function Viewer({ take, job, upJob, ahead = 0, onTier, onUpscale, quality, upscaled, onUpscaled, playing, segments, playback }: {
  take: Take | null; job?: QueueJob; upJob?: QueueJob; ahead?: number; onTier: (tier: Tier) => void;
  // upscaling: what size the button asks for, and whether the upscaled version is shown where there is one
  onUpscale: () => void; quality: string; upscaled: boolean; onUpscaled: (on: boolean) => void;
  playing: boolean; segments: Segment[]; playback: Playback;
}) {
  if (playing && segments[playback.index]) {
    const seg = segments[playback.index];
    return (
      <div className="viewer" id="viewer">
        <div className="screen"><PlayScreen segment={seg} next={segments[playback.index + 1]} playback={playback} upscaled={upscaled} /></div>
        <div className="bar"><span className="info">连起来看 · 镜头 {shotNo(seg.shotId)}</span></div>
      </div>
    );
  }
  const state = take ? takeState(take, job) : '';
  const done = take?.status === 'succeeded';
  const up = take?.upscale;
  const hasUp = !!(up && up.status === 'succeeded' && up.video);
  const showUp = hasUp && upscaled;
  const file = take ? (showUp ? up!.video : take.video) : null;
  const upBusy = !!upJob || up?.status === 'queued' || up?.status === 'running';
  const upNote = take ? upscaleBadge(take, upJob) : '';
  // the button offers what a click would do: start, run again at the chosen size, or nothing while one runs
  const upTitle = take?.tier !== 'pick' ? '先把这一条标成选中，才能超分'
    : upBusy ? '正在超分' : hasUp && up!.quality === quality ? `已经超分成 ${quality} 了，换个清晰度可以再跑` : `用 SeedVR2 放大到 ${quality}`;
  return (
    <div className="viewer" id="viewer">
      <div className="screen">
        {take && done && file ? <video key={file} src={mediaUrl('project', file)} controls id="viewer-video" />
          : job?.preview ? <img src={`data:${job.preview.mime};base64,${job.preview.data}`} alt="生成中的预览" />
            : job ? null
              : <div className="gap">{take ? state || '没有视频文件' : '这一镜还没有版本'}</div>}
        {job && !done ? <GenProgress job={job} ahead={ahead} onPicture={!!job.preview} /> : null}
      </div>
      <div className="bar">
        <span className="info ellipsis num">
          {take ? <>第 {take.n} 版 · {take.durationSec ? `${take.durationSec.toFixed(1)} 秒` : `${take.values?.duration ?? ''} 秒`}{take.seed !== null && take.seed !== undefined ? ` · 种子 ${take.seed}` : ''}{showUp && up!.width ? ` · ${up!.width}×${up!.height}` : ''}</> : null}
          {take?.stale ? <span className="warn"> · <Icon name="warn" size={13} /> {STALE[take.stale]}</span> : null}
          {take?.error ? <span style={{ color: 'var(--bad)' }}> · {take.error}</span> : null}
        </span>
        {hasUp ? (
          <Segmented id="viewer-version" value={showUp ? 'up' : 'orig'} onChange={(v) => onUpscaled(v === 'up')}
            options={[{ value: 'orig', label: '原片' }, { value: 'up', label: `超分 ${up!.quality}` }]} />
        ) : null}
        {upNote && !hasUp ? <span className={`up-note num ${/失败/.test(upNote) ? 'bad' : ''}`} title={up?.error || undefined}>{upNote}</span> : null}
        <Button variant={take?.tier === 'pick' ? 'default' : 'primary'} id="btn-tier-pick" disabled={!done} on={take?.tier === 'pick' ? 'good' : false} onClick={() => onTier('pick')}><Icon name="check" />{take?.tier === 'pick' ? '已选中' : '选中'}</Button>
        <Button id="btn-tier-cand" disabled={!done} on={take?.tier === 'cand' ? 'acc' : false} onClick={() => onTier('cand')}><Icon name="star" />候选</Button>
        <Button id="btn-upscale" disabled={!done || take?.tier !== 'pick' || upBusy || (hasUp && up!.quality === quality)} title={upTitle}
          onClick={onUpscale}><Icon name="expand" />超分</Button>
        <Button id="btn-tier-trash" variant="danger" disabled={!take || take.status === 'queued' || take.status === 'running'} onClick={() => onTier('trash')}><Icon name="trash" />删除</Button>
      </div>
    </div>
  );
}
