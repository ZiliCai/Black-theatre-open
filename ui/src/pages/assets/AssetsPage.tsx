import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, mediaUrl, type CardDetail, type CardKind, type CardRow, type PictureDraft, type PictureTake, type PictureTier } from '../../api';
import { Button, EmptyState, Icon, useToast } from '../../components';
import { useDialog } from '../../components/dialog';
import { useApp } from '../../shell/context';
import { takeState } from '../shots/TakeStrip';
import { CardList } from './CardList';
import { PictureStrip } from './PictureStrip';
import { AssetInspector } from './AssetInspector';
import { KeptSet } from './KeptSet';
import '../shots/shots.css';
import './assets.css';

const KEY = 'blackbox.assets';
type Remembered = { kind?: CardKind; code?: string };
const remembered = (): Remembered => {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
};
const remember = (patch: Remembered) => {
  try { localStorage.setItem(KEY, JSON.stringify({ ...remembered(), ...patch })); } catch { /* not remembered */ }
};

// What the big viewer shows: a take (clicked in the strip) or a kept picture (clicked in the bottom row).
type Selection = { take: string } | { image: string } | null;
const labelOf = (ask: string) => ask.replace(/[，。,.!！?？；;：:\s]+/g, ' ').trim().slice(0, 12) || '参考图';

export function AssetsPage() {
  const { projectVersion, queue, go } = useApp();
  const toast = useToast();
  const { ask } = useDialog();
  const [cards, setCards] = useState<CardRow[] | null>(null);
  const [empty, setEmpty] = useState<'' | 'noProject' | 'noList'>('');
  const [kind, setKind] = useState<CardKind>(remembered().kind || 'char');
  const [code, setCode] = useState(remembered().code || '');
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [draft, setDraft] = useState<PictureDraft | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [busy, setBusy] = useState(false);
  const flush = useRef<() => Promise<void>>(async () => {});
  const listSource = useRef('');

  const loadCards = useCallback(async () => {
    const r = await api.assetCards();
    if (!r.ok) {
      setEmpty('noProject');
      setCards([]);
      return;
    }
    setCards(r.cards);
    listSource.current = r.sources[0] || '';
    setEmpty(r.cards.length ? '' : 'noList');
    r.warnings.forEach((w) => toast(w, { tone: 'bad' }));
    const here = r.cards.find((c) => c.code === code);
    if (here) {
      if (here.kind !== kind) setKind(here.kind);
    } else {
      const first = r.cards.find((c) => c.kind === kind) || r.cards[0];
      setCode(first ? first.code : '');
      if (first && first.kind !== kind) setKind(first.kind);
    }
  }, [code, kind, toast]);

  const loadDetail = useCallback(async () => {
    if (!code) { setDetail(null); return; }
    const r = await api.assetDetail({ code });
    if (r.ok) {
      setDetail(r);
      if (r.warning) toast(r.warning, { tone: 'bad' });
    } else {
      setDetail(null);
    }
  }, [code, toast]);

  const refresh = useCallback(() => { loadCards(); loadDetail(); }, [loadCards, loadDetail]);

  useEffect(() => { setDetail(null); setSelection(null); refresh(); }, [projectVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSelection(null); setDraft(null); loadDetail(); remember({ code }); }, [code]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { remember({ kind }); }, [kind]);
  // the draft follows the card that was loaded, but never overwrites what is being typed for the same card
  const draftFor = useRef('');
  useEffect(() => {
    if (detail && draftFor.current !== detail.card.code) {
      draftFor.current = detail.card.code;
      setDraft(detail.draft);
    }
  }, [detail]);

  // a picture take changed state in the queue: reload what shows it
  const queueKey = queue.jobs.filter((j) => j.kind === 'image').map((j) => `${j.takeId}:${j.status}`).join('|') + (queue.paused ? '!' : '');
  const lastKey = useRef(queueKey);
  useEffect(() => {
    if (lastKey.current === queueKey) return;
    lastKey.current = queueKey;
    refresh();
  }, [queueKey, refresh]);

  const takes = detail?.takes || [];
  const live = useMemo(() => takes.filter((t) => t.tier !== 'trash'), [takes]);
  // On screen: a clicked kept picture or take; with nothing clicked the main picture, else the newest take.
  const keptImage = selection && 'image' in selection ? selection.image : !selection && detail?.main ? detail.main : '';
  const take: PictureTake | null = keptImage ? null
    : selection && 'take' in selection ? live.find((t) => t.id === selection.take) || null
      : [...live].reverse().find((t) => t.status === 'succeeded') || [...live].reverse()[0] || null;
  const kept = detail?.set.find((s) => s.image === (keptImage || take?.image));
  // the take the tier buttons act on: the one shown, or the one a kept picture came from
  const current = take || (kept && kept.takeId ? takes.find((t) => t.id === kept.takeId) || null : null);
  const shownImage = keptImage || (take && take.status === 'succeeded' ? take.image || '' : '');
  const job = take ? queue.jobs.find((j) => j.takeId === take.id) : undefined;

  const enqueue = async () => {
    if (!code || !draft) return;
    setBusy(true);
    await flush.current();
    const r = await api.enqueuePictures({ code, count: draft.count });
    setBusy(false);
    if (!r.ok) (r.errors || [r.message || '没能开始生成']).forEach((e) => toast(e, { tone: 'bad' }));
    else {
      setSelection(null);
      setDraft({ ...draft, count: 1 }); // the next round starts at one picture again
    }
    refresh();
  };

  const setTier = async (tier: PictureTier) => {
    const take = current;
    if (!take) return;
    let label = '';
    if (tier === 'keep') {
      const given = await ask({ title: '加入参考图', label: '给这张图起个标签', value: labelOf(take.ask), okLabel: '加入参考图', validate: (t) => (t.trim() ? '' : '标签不能为空') });
      if (given === null) return;
      label = given;
    }
    const r = await api.setPictureTier({ code, takeId: take.id, tier, label });
    if (!r.ok && !r.cancelled) toast(r.message || '操作失败', { tone: 'bad' });
    else if (r.message && tier === 'trash') toast(r.message);
    if (tier === 'trash' && r.ok) setSelection(null);
    refresh();
  };
  const toggle = (tier: PictureTier) => setTier(current && current.tier === tier ? '' : tier);

  const keptAction = async (run: () => Promise<{ ok: boolean; message?: string }>) => {
    const r = await run();
    if (!r.ok) toast(r.message || '操作失败', { tone: 'bad' });
    refresh();
  };
  const relabel = async (image: string, current: string) => {
    const label = await ask({ title: '改标签', label: '标签', value: current, okLabel: '保存', validate: (t) => (t.trim() ? '' : '标签不能为空') });
    if (label !== null) keptAction(() => api.relabelPicture({ code, image, label }));
  };
  const keepOrUnkeep = () => {
    if (kept) keptAction(() => api.unkeepPicture({ code, image: kept.image }));
    else toggle('keep');
  };

  const openList = () => {
    const doc = detail?.card.source || listSource.current;
    try { if (doc) sessionStorage.setItem('blackbox.script.open', doc); } catch { /* opens the page without the file */ }
    go('script');
  };
  const openShot = (shotId: string) => {
    const m = /^MOTION-([A-Z0-9]+)-/i.exec(shotId);
    try {
      const saved = JSON.parse(localStorage.getItem('blackbox.shots') || '{}') || {};
      localStorage.setItem('blackbox.shots', JSON.stringify({ ...saved, shot: shotId, episode: m ? m[1].toUpperCase() : saved.episode }));
    } catch { /* lands on the shot page as it was */ }
    go('shots');
  };

  if (cards && empty === 'noProject') {
    return <EmptyState title="先选一个剧本项目" body="素材卡来自项目里的人物与场景清单。新建或导入一个项目，或者在右上角切换到已有项目。"
      action={<Button variant="primary" onClick={() => go('settings', 'projects')}>去设置 · 项目</Button>} />;
  }
  if (cards && empty === 'noList') {
    return <EmptyState title="项目里还没有人物与场景清单"
      body="在剧本文件夹里放一个 .md 文件：「## 人物」和「## 场景」下面各一张表，第一列是代号（只用字母、数字和短横线），第二列名字，第三列外形描述；「## 画风」下面写一段画风，会拼进每条提示词。"
      action={<Button onClick={() => go('script')}>去剧本页</Button>} />;
  }

  const working = !!current && (current.status === 'queued' || current.status === 'running');
  const done = current?.status === 'succeeded' && !!current.image;
  const state = take ? takeState(take, job) : '';
  const baseLabel = current?.base ? (detail?.set.find((s) => s.image === current.base) || { label: '另一张图' }).label : '';
  return (
    <div className="assets">


      <CardList cards={cards || []} kind={kind} code={code} onKind={(k) => { setKind(k); const first = (cards || []).find((c) => c.kind === k); if (first) setCode(first.code); }}
        onCard={setCode} onOpenList={openList} onRefresh={refresh} />

      <div className="shot-centre">
        <div className="viewer" id="pic-viewer">
          <div className={`screen ${detail?.card.kind || ''}`}>
            {shownImage ? <img key={shownImage} src={mediaUrl('project', shownImage)} alt="" id="pic-viewer-img" />
              : job?.preview ? <img src={`data:${job.preview.mime};base64,${job.preview.data}`} alt="生成中的预览" />
                : <div className="gap">{take ? state || '没有图片文件' : '这张卡还没有图'}</div>}
            {job && job.status !== 'queued' ? <div className="progress"><i style={{ width: `${job.progress * 100}%` }} /></div> : null}
          </div>
          <div className="bar">
            <span className="info ellipsis num">
              {kept ? <b className="kept-label">{kept.label}{kept.takeId ? '' : ' · 已有图片'}{current ? ' · ' : ''}</b> : null}
              {current ? <>第 {current.n} 张 · {current.mode === 'i2i' ? `图生图 · 基于「${baseLabel}」` : '文生图'}{current.width ? ` · ${current.width}×${current.height}` : ''}{current.seed !== null ? ` · 种子 ${current.seed}` : ''}</> : null}
              {kept && kept.usedBy.length ? ` · 用在镜头 ${kept.usedBy.join('、')}` : ''}
              {current?.error ? <span style={{ color: 'var(--bad)' }}> · {current.error}</span> : null}
            </span>
            <Button id="btn-pic-keep" variant={kept ? 'default' : 'primary'} disabled={!kept && !done} on={kept ? 'good' : false} onClick={keepOrUnkeep}
              title={kept ? '再点一下从参考图里移出（不删除文件）' : undefined}><Icon name="check" />{kept ? '已在参考图' : '加入参考图'}</Button>
            <Button id="btn-pic-main" disabled={!kept || kept.image === detail?.main} on={!!kept && kept.image === detail?.main ? 'good' : false}
              onClick={() => kept && keptAction(() => api.setMainPicture({ code, image: kept.image }))}>{!!kept && kept.image === detail?.main ? '已是主图' : '设为主图'}</Button>
            <Button id="btn-pic-cand" disabled={!done} on={current?.tier === 'cand' ? 'acc' : false} onClick={() => toggle('cand')}><Icon name="star" />候选</Button>
            <Button id="btn-pic-trash" variant="danger" disabled={!current || working} onClick={() => setTier('trash')}><Icon name="trash" />删除</Button>
          </div>
        </div>
        <div className="strip-wrap">
          <PictureStrip takes={takes} set={detail?.set || []} jobs={queue.jobs} selected={take?.id || ''} onSelect={(id) => setSelection({ take: id })} />
        </div>
      </div>

      {detail && draft ? (
        <AssetInspector action={<Button variant="primary" id="btn-enqueue-pics" disabled={!detail || !draft || busy} onClick={enqueue}>
          <Icon name="sparkle" />生成 {draft?.count ?? 1} 张
        </Button>} key={detail.card.code} detail={detail} draft={draft} onDraft={setDraft} flushRef={flush} onOpenList={openList} onShot={openShot} />
      ) : <aside className="inspector" />}

      {detail ? (
        <KeptSet detail={detail} selected={keptImage}
          onSelect={(image) => setSelection({ image })}
          onMain={(image) => keptAction(() => api.setMainPicture({ code, image }))}
          onRelabel={relabel}
          onUnkeep={(image) => keptAction(() => api.unkeepPicture({ code, image }))}
          onAdopt={(relPath) => keptAction(() => api.adoptPicture({ code, relPath }))} />
      ) : <div className="kept" />}
    </div>
  );
}
