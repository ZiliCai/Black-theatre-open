import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Episode, type Segment, type ShotDetail, type Take, type Tier } from '../../api';
import { Button, EmptyState, Icon, Select, TextInput, useToast } from '../../components';
import { useApp } from '../../shell/context';
import { ShotList } from './ShotList';
import { Viewer } from './Viewer';
import { TakeStrip } from './TakeStrip';
import { Inspector } from './Inspector';
import { Timeline, type GapMode } from './Timeline';
import { usePlayback } from './usePlayback';
import './shots.css';

const KEY = 'blackbox.shots';
type Remembered = { episode?: string; shot?: string; gapMode?: GapMode; quality?: string; upscaled?: boolean };
const remembered = (): Remembered => {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
};
const remember = (patch: Remembered) => {
  try { localStorage.setItem(KEY, JSON.stringify({ ...remembered(), ...patch })); } catch { /* not remembered */ }
};

// Which take the big viewer shows when the user has not clicked one: the pick, else the newest finished one.
function defaultTake(takes: Take[]) {
  const live = takes.filter((t) => t.tier !== 'trash');
  return live.find((t) => t.tier === 'pick' && t.status === 'succeeded')
    || [...live].reverse().find((t) => t.status === 'succeeded')
    || [...live].reverse()[0] || null;
}

export function ShotsPage() {
  const { projectVersion, queue, go, project } = useApp();
  const toast = useToast();
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  const [noProject, setNoProject] = useState('');
  const [episodeId, setEpisodeId] = useState(remembered().episode || '');
  const [shotId, setShotId] = useState(remembered().shot || '');
  const [detail, setDetail] = useState<ShotDetail | null>(null);
  const [selectedTake, setSelectedTake] = useState('');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [total, setTotal] = useState(0);
  // what the checks found in the script, kept on the page (a list in the shot list, a shot's own in its inspector)
  const [warnings, setWarnings] = useState<string[]>([]);
  const [gapMode, setGapMode] = useState<GapMode>(remembered().gapMode || 'black');
  const [count, setCount] = useState(1); // each round starts at one take
  const [busy, setBusy] = useState(false);
  // upscaling: the size asked for, the sizes this card can take, and whether the upscaled version is what plays
  const [quality, setQuality] = useState(remembered().quality || '1080p');
  const [qualities, setQualities] = useState<{ all: string[]; ok: string[] }>({ all: ['720p', '1080p', '1440p'], ok: ['720p', '1080p'] });
  const [upscaled, setUpscaled] = useState(remembered().upscaled ?? true);
  const playback = usePlayback(segments);

  const loadEpisodes = useCallback(async () => {
    const r = await api.shotEpisodes();
    if (!r.ok) {
      setNoProject(r.message);
      setEpisodes([]);
      return;
    }
    setNoProject('');
    setEpisodes(r.episodes);
    setWarnings(r.warnings);
    const ep = r.episodes.find((e) => e.id === episodeId) || r.episodes[0];
    if (!ep) return;
    if (ep.id !== episodeId) setEpisodeId(ep.id);
    if (!ep.shots.some((s) => s.id === shotId)) setShotId(ep.shots[0]?.id || '');
  }, [episodeId, shotId, toast]);

  const loadDetail = useCallback(async () => {
    if (!shotId) { setDetail(null); return; }
    const r = await api.shotDetail({ shotId });
    if (r.ok) {
      setDetail(r);
      if (r.warning) toast(r.warning, { tone: 'bad' });
    } else {
      setDetail(null);
    }
  }, [shotId, toast]);

  const loadTimeline = useCallback(async () => {
    if (!episodeId) return;
    const r = await api.shotTimeline({ episode: episodeId, gapMode });
    if (r.ok) {
      setSegments(r.segments);
      setTotal(r.total);
    }
  }, [episodeId, gapMode]);

  const loadQualities = useCallback(async () => {
    const r = await api.upscaleOptions();
    if (r.ok) setQualities({ all: r.all, ok: r.qualities });
  }, []);

  const refresh = useCallback(() => { loadEpisodes(); loadDetail(); loadTimeline(); }, [loadEpisodes, loadDetail, loadTimeline]);
  // the refresh button: the script was edited outside, read prompts, lengths and the shot list again
  const reloadScript = useCallback(async () => {
    await Promise.all([loadEpisodes(), loadDetail(), loadTimeline()]);
    toast('已从剧本重新读取');
  }, [loadEpisodes, loadDetail, loadTimeline, toast]);

  // another project: nothing of the old one may stay on screen (the same shot ids are common across projects)
  useEffect(() => {
    setDetail(null);
    setSegments([]);
    setSelectedTake('');
    refresh();
    loadQualities();
  }, [projectVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadDetail(); setSelectedTake(''); remember({ shot: shotId }); }, [shotId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadTimeline(); remember({ episode: episodeId, gapMode }); }, [episodeId, gapMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // a take changed state in the queue (started, finished, failed): reload what shows it
  const queueKey = queue.jobs.map((j) => `${j.takeId}:${j.status}`).join('|') + (queue.paused ? '!' : '');
  const lastKey = useRef(queueKey);
  useEffect(() => {
    if (lastKey.current === queueKey) return;
    lastKey.current = queueKey;
    refresh();
  }, [queueKey, refresh]);

  const takes = detail?.takes || [];
  const take = useMemo(() => takes.find((t) => t.id === selectedTake && t.tier !== 'trash') || defaultTake(takes), [takes, selectedTake]);
  const blocked = !!detail && detail.continuation.supported && !detail.continuation.resolved.ok;

  const enqueue = async (n: number) => {
    if (!shotId) return;
    setBusy(true);
    const r = await api.enqueueTakes({ shotId, count: n });
    setBusy(false);
    setCount(1);
    if (!r.ok) (r.errors || [r.message || '没能开始生成']).forEach((e) => toast(e, { tone: 'bad' }));
    refresh();
  };

  // one take, or every chosen take of the episode that is not upscaled to this size yet
  const upscale = async (which: 'take' | 'episode') => {
    if (which === 'take' && !take) return;
    setBusy(true);
    const r = which === 'take'
      ? await api.upscaleTake({ shotId, takeId: take!.id, quality })
      : await api.upscaleEpisode({ episode: episodeId, quality });
    setBusy(false);
    loadQualities();
    if (!r.ok) toast(r.message || '没能开始超分', { tone: 'bad' });
    else if (which === 'episode') toast(`已排上 ${r.queued} 条超分${r.skipped ? `，${r.skipped} 条跳过` : ''}`);
    refresh();
  };

  const setTier = async (tier: Tier) => {
    if (!take) return;
    const r = await api.setTakeTier({ shotId, takeId: take.id, tier });
    if (!r.ok && !r.cancelled) toast(r.message || '操作失败', { tone: 'bad' });
    else if (r.message && tier === 'trash') toast(r.message);
    if (tier === 'trash' && r.ok) setSelectedTake('');
    refresh();
  };

  if (episodes && noProject) {
    return <EmptyState title="先选一个剧本项目" body="镜头来自项目里的剧本文件。新建或导入一个项目，或者在右上角切换到已有项目。"
      action={<Button variant="primary" onClick={() => go('settings', 'projects')}>去设置 · 项目</Button>} />;
  }
  if (episodes && !episodes.length) {
    return <EmptyState title="这个项目里还没有镜头" body="在剧本文件夹里放一个 MOTION 格式的分镜文档（## MOTION-E01-01 · 标题），或者在剧本页新建。"
      action={<Button onClick={() => go('script')}>去剧本页</Button>} />;
  }

  const job = take ? queue.jobs.find((j) => j.takeId === take.id && j.kind !== 'upscale') : undefined;
  const upJob = take ? queue.jobs.find((j) => j.takeId === take.id && j.kind === 'upscale') : undefined;
  return (
    <div className={`shots ${playback.playing ? 'playing' : ''}`}>
      <ShotList episodes={episodes || []} episodeId={episodeId} shotId={shotId} warnings={warnings}
        onEpisode={(id) => { setEpisodeId(id); const ep = episodes?.find((e) => e.id === id); setShotId(ep?.shots[0]?.id || ''); }}
        onShot={(id) => { playback.stop(); setShotId(id); }}
        /* selected once the list has it: a list loaded without it would fall back to the first shot */
        onCreated={async (id) => { await loadEpisodes(); setShotId(id); }}
        onDeleted={async (next) => { playback.stop(); await loadEpisodes(); if (next) setShotId(next); loadTimeline(); }} onRefresh={reloadScript} />

      <div className="shot-centre">
        <div className="generate-bar">
          <label>数量 <TextInput small id="take-count" type="number" min={1} max={16} value={count} style={{ width: 56 }} title="这一镜一次生成几版（1–16）"
            onChange={(e) => { const n = Math.min(16, Math.max(1, Number(e.target.value) || 1)); setCount(n); }} /></label>
          <Button variant="primary" id="btn-enqueue" disabled={!detail || busy || blocked} onClick={() => enqueue(count)}
            title={blocked && detail && !detail.continuation.resolved.ok ? detail.continuation.resolved.message : undefined}>
            <Icon name="sparkle" />生成 {count} 版
          </Button>
        </div>
        <Viewer take={take} job={job} upJob={upJob} ahead={job ? queue.jobs.indexOf(job) : 0} onTier={setTier}
          onUpscale={() => upscale('take')} quality={quality} upscaled={upscaled} onUpscaled={(on) => { setUpscaled(on); remember({ upscaled: on }); }}
          playing={playback.playing} segments={segments} playback={playback} />
        <TakeStrip takes={takes} jobs={queue.jobs} selected={take?.id || ''} onSelect={setSelectedTake} onRetry={() => enqueue(1)} />
      </div>

      {detail ? <Inspector key={`${project?.dir}|${detail.shot.id}`} detail={detail} warnings={warnings.filter((w) => w.startsWith(`${detail.shot.n} `))} onSaved={() => { loadDetail(); loadTimeline(); }} onReload={refresh} />
        : <aside className="inspector" />}

      <Timeline segments={segments} total={total} shotId={shotId} playback={playback} gapMode={gapMode} onGapMode={setGapMode}
        onShot={(id) => setShotId(id)} episodeActions={<>
          <label className="tl-upscale">超分到 <Select small id="upscale-quality" value={quality} title="超分到多大（短边像素）；单个版本的「超分」也用这个设置"
            onFocus={loadQualities} onChange={(e) => { setQuality(e.target.value); remember({ quality: e.target.value }); }}>
            {qualities.all.map((q) => <option key={q} value={q} disabled={!qualities.ok.includes(q)}>{q}{qualities.ok.includes(q) ? '' : '（显存不够）'}</option>)}
          </Select></label>
          <Button id="btn-upscale-episode" disabled={!episodeId || busy} onClick={() => upscale('episode')}
            title="把这一集每个镜头选中的那一版都放大到这个清晰度，已经放大过的跳过">
            <Icon name="expand" />超分本集
          </Button>
        </>} />
    </div>
  );
}
