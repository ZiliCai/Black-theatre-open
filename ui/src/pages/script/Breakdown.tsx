import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Breakdown as View, type BreakdownCard, type BreakdownPlan, type BreakdownShot } from '../../api';
import { Button, Icon, Modal, TextArea, TextInput, useToast } from '../../components';
import { useDialog } from '../../components/dialog';
import { useApp } from '../../shell/context';

const wan = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`);
const minutes = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒` : `${Math.round(sec)} 秒`);
const epName = (id: string) => `第 ${id.replace(/^E0*/i, '')} 集`;
const looksLikeScript = (name: string) => /剧本|正文|台本|全集|script/i.test(name);
const blankShot = (): BreakdownShot => ({ title: '新镜头', duration: 6, description: '', cast: [], continue: false });

// A whole script into shots: pick the script documents → the AI lists the people, places and shots → the user
// fixes the list → the prompts are written and the shot documents made. The work runs in the main process; this
// page asks how far it is every second or so, and can be closed and opened again meanwhile.
export function Breakdown({ onClose, onDocsChanged }: { onClose: () => void; onDocsChanged: () => void }) {
  const toast = useToast();
  const { confirm } = useDialog();
  const { go } = useApp();
  const [view, setView] = useState<View | null>(null);
  const [picks, setPicks] = useState<string[] | null>(null);
  const [plan, setPlan] = useState<BreakdownPlan | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const took = useCallback((r: View) => {
    if (!r.ok) { toast(r.message || '没成功', { tone: 'bad' }); return false; }
    setView(r);
    return true;
  }, [toast]);

  useEffect(() => { api.loadBreakdown().then(took); }, [took]);

  // while the main process works, follow it
  const running = view?.running || '';
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(async () => {
      const r = await api.loadBreakdown();
      if (r.ok) setView(r);
      if (r.ok && !r.running) onDocsChanged();
    }, 1200);
    return () => window.clearInterval(timer);
  }, [running, onDocsChanged]);

  const state = view?.state || null;
  const phase = state?.phase || '';

  // the editable copy of the list, taken when it is ready for review
  useEffect(() => {
    if (phase === 'review' && state && !dirty) setPlan({ style: state.style, cards: state.cards, episodes: state.episodes });
    if (phase !== 'review') { setPlan(null); setDirty(false); }
  }, [phase, state, dirty]);

  // the documents to read: the ones that look like a script, until the user picks
  const docs = view?.docs || [];
  const chosen = picks ?? docs.filter((d) => looksLikeScript(d.name) && d.category !== '分镜头').map((d) => d.relPath);
  const chosenChars = docs.filter((d) => chosen.includes(d.relPath)).reduce((n, d) => n + d.chars, 0);

  const allCards = useMemo(() => [...(state?.existing || []), ...(plan?.cards || state?.cards || [])], [state, plan]);
  const nameOf = useMemo(() => new Map(allCards.map((c) => [c.code, c.name])), [allCards]);

  const edit = (next: BreakdownPlan) => { setPlan(next); setDirty(true); };
  const editShot = (e: number, s: number, change: Partial<BreakdownShot>) => {
    if (!plan) return;
    edit({ ...plan, episodes: plan.episodes.map((ep, i) => (i !== e ? ep : { ...ep, shots: ep.shots.map((sh, j) => (j === s ? { ...sh, ...change } : sh)) })) });
  };
  const editShots = (e: number, fn: (shots: BreakdownShot[]) => BreakdownShot[]) => {
    if (!plan) return;
    edit({ ...plan, episodes: plan.episodes.map((ep, i) => (i === e ? { ...ep, shots: fn(ep.shots) } : ep)) });
  };
  const editCard = (k: number, change: Partial<BreakdownCard>) => {
    if (!plan) return;
    edit({ ...plan, cards: plan.cards.map((c, i) => (i === k ? { ...c, ...change } : c)) });
  };

  const saveEdits = async () => {
    if (!plan || !dirty) return true;
    const r = await api.updateBreakdown({ plan });
    if (!took(r)) return false;
    setDirty(false);
    return true;
  };

  const act = async (fn: () => Promise<View>) => {
    setBusy(true);
    try { return took(await fn()); } finally { setBusy(false); }
  };

  const start = () => act(() => api.startBreakdown({ relPaths: chosen }));
  const discard = async (ask: string) => {
    if (ask && !(await confirm({ title: '放弃这次拆分', message: ask, okLabel: '放弃', danger: true }))) return;
    if (await act(() => api.discardBreakdown())) { setPicks(null); setPlan(null); setDirty(false); }
  };
  const write = async () => {
    const shots = (plan || state)?.episodes.reduce((n, e) => n + e.shots.length, 0) || 0;
    if (phase === 'review' && !(await confirm({
      title: '写提示词，生成分镜文档',
      message: `接下来 AI 会给这 ${shots} 个镜头逐个写视频提示词，大约要调用 AI ${shots}–${shots * 2} 次，镜头多时要等一阵子，可以随时停下、下次接着写。`,
      detail: '写好的镜头放在「分镜」文件夹里，每集一篇；新的人物和场景放在「人物与场景（AI 拆分）」里。',
      okLabel: '开始写',
    }))) return;
    if (!(await saveEdits())) return;
    await act(() => api.writeBreakdown());
  };

  const progress = state?.progress;
  const bar = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const failed = state ? state.episodes.flatMap((e) => e.shots.map((s, i) => ({ e, s, i })).filter((x) => x.s.status === 'failed')) : [];
  const doneCount = state ? state.episodes.reduce((n, e) => n + e.shots.filter((s) => s.status === 'done').length, 0) : 0;
  const total = (plan || state)?.episodes.reduce((n, e) => n + e.shots.length, 0) || 0;
  const seconds = (plan || state)?.episodes.reduce((n, e) => n + e.shots.reduce((m, s) => m + (Number(s.duration) || 0), 0), 0) || 0;

  let body: JSX.Element;
  let actions: JSX.Element;

  if (!view) {
    body = <p className="bd-dim">读取中…</p>;
    actions = <Button onClick={onClose}>关闭</Button>;
  } else if (!state) {
    const over = chosenChars > view.limit;
    body = (
      <>
        <div className="bd-steps">
          <div><b>1</b>AI 读剧本，列出人物、场景和每集的镜头清单</div>
          <div><b>2</b>你检查清单：改标题、时长、剧情，删镜头或加镜头</div>
          <div><b>3</b>AI 逐镜写视频提示词，生成分镜文档；之后去素材页给人物和场景出图，镜头会自动挂上</div>
        </div>
        <div className="bd-section">选要拆的剧本（按勾选的顺序读）</div>
        <div className="bd-docs">
          {docs.length ? docs.map((d) => (
            <label key={d.relPath}>
              <input type="checkbox" checked={chosen.includes(d.relPath)} onChange={(e) => setPicks(e.target.checked ? [...chosen, d.relPath] : chosen.filter((p) => p !== d.relPath))} />
              <span className="ellipsis">{d.relPath}</span>
              <span className="num bd-dim">{wan(d.chars)}</span>
            </label>
          )) : <p className="bd-dim">项目里还没有文档。先在左边「新建文档」，把剧本贴进去。</p>}
        </div>
        <p className={over ? 'bd-bad' : 'bd-dim'}>已选 {wan(chosenChars)}{over ? `，超过了一次最多 ${wan(view.limit)}，请分几次拆` : ''}。剧本里写了「第一集」「第2集」「EP03」这样的标题，会按集拆开。</p>
      </>
    );
    actions = <>
      <Button onClick={onClose}>取消</Button>
      <Button variant="primary" id="btn-bd-start" disabled={busy || !chosen.length || over} onClick={start}><Icon name="sparkle" />开始拆分</Button>
    </>;
  } else if (running) {
    body = (
      <>
        <p>{running === 'plan' ? 'AI 正在读剧本、拆镜头。' : 'AI 正在逐镜写提示词，写好一镜就存一镜。'}可以先关掉这个窗口做别的，回来再看。</p>
        <div className="bd-bar"><i style={{ width: `${bar}%` }} /></div>
        <p className="bd-dim num">{progress ? `${progress.label}（${progress.done}/${progress.total}）` : '准备中…'}</p>
        {running === 'write' && failed.length ? <p className="bd-bad">有 {failed.length} 镜没写成，做完后可以重试。</p> : null}
      </>
    );
    actions = <>
      <Button onClick={onClose}>先关掉</Button>
      <Button variant="danger" disabled={view.stopping} onClick={() => act(() => api.stopBreakdown())}>{view.stopping ? '正在停下…' : '停下'}</Button>
    </>;
  } else if (phase === 'planning' || phase === 'failed') {
    body = (
      <>
        <p>{phase === 'failed' ? '拆分没有完成：' : '上次拆分到一半被中断了（软件关掉了）。'}</p>
        {state.error ? <p className="bd-bad">{state.error}</p> : null}
        <p className="bd-dim">AI 接口没配好时，先到 设置 → AI 里填好再来。</p>
      </>
    );
    actions = <>
      <Button onClick={onClose}>关闭</Button>
      <Button variant="primary" onClick={() => discard('')}>重新开始</Button>
    </>;
  } else if (phase === 'review' && plan) {
    body = (
      <>
        <p className="bd-dim">共 {plan.episodes.length} 集、{total} 个镜头，剧本时长约 {minutes(seconds)}。改完点「写提示词」；改动随时可以先保存。</p>
        <div className="bd-section">画风</div>
        <TextInput value={plan.style} placeholder="比如：写实电影质感，自然光，色彩克制" onChange={(e) => edit({ ...plan, style: e.target.value })} />
        <div className="bd-section">人物和场景 <span className="bd-dim">（代号是镜头挂参考图用的；之后在素材页给每张卡出图）</span></div>
        <div className="bd-cards">
          {(state.existing || []).map((c) => (
            <div key={c.code} className="bd-card old"><span className="code">{c.code}</span><span>{c.name}</span><span className="bd-dim">已有</span></div>
          ))}
          {plan.cards.map((c, k) => (
            <div key={c.code} className="bd-card">
              <span className="code">{c.code}</span>
              <span className="bd-dim">{c.kind === 'scene' ? '场景' : '人物'}</span>
              <TextInput small value={c.name} onChange={(e) => editCard(k, { name: e.target.value })} />
              <TextArea rows={2} value={c.look} onChange={(e) => editCard(k, { look: e.target.value })} />
              <Button size="sm" variant="ghost" title="不要这张卡" onClick={() => edit({ ...plan, cards: plan.cards.filter((_, i) => i !== k) })}><Icon name="x" /></Button>
            </div>
          ))}
        </div>
        {plan.episodes.map((ep, e) => (
          <div key={ep.id} className="bd-ep">
            <div className="bd-section">
              {epName(ep.id)}
              <TextInput small value={ep.title} placeholder="这一集的标题" onChange={(ev) => edit({ ...plan, episodes: plan.episodes.map((x, i) => (i === e ? { ...x, title: ev.target.value } : x)) })} />
              <span className="bd-dim num">{ep.shots.length} 镜 · {minutes(ep.shots.reduce((m, s) => m + (Number(s.duration) || 0), 0))}</span>
            </div>
            {ep.shots.map((s, i) => (
              <div key={i} className="bd-shot">
                <span className="n num">{String(i + 1).padStart(3, '0')}</span>
                <div className="main">
                  <div className="row">
                    <TextInput small value={s.title} onChange={(ev) => editShot(e, i, { title: ev.target.value })} />
                    <TextInput small type="number" min={2} max={15} step={0.5} value={s.duration} style={{ width: 76 }} onChange={(ev) => editShot(e, i, { duration: Number(ev.target.value) })} />
                    <span className="bd-dim">秒</span>
                    <label className="bd-cont" title="同一机位、同一时刻接着上一镜拍"><input type="checkbox" disabled={i === 0} checked={s.continue && i > 0} onChange={(ev) => editShot(e, i, { continue: ev.target.checked })} />接上一镜</label>
                  </div>
                  <TextArea rows={2} value={s.description} onChange={(ev) => editShot(e, i, { description: ev.target.value })} />
                  <div className="row">
                    <span className="bd-dim">出场</span>
                    <TextInput small value={s.cast.join(', ')} placeholder="素材卡代号，用逗号隔开"
                      onChange={(ev) => editShot(e, i, { cast: ev.target.value.split(/[,，\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean) })} />
                    <span className="bd-dim ellipsis">{s.cast.map((c) => nameOf.get(c) || `${c}?`).join('、')}</span>
                  </div>
                </div>
                <div className="tools">
                  <Button size="sm" variant="ghost" title="在后面加一镜" onClick={() => editShots(e, (shots) => [...shots.slice(0, i + 1), blankShot(), ...shots.slice(i + 1)])}><Icon name="plus" /></Button>
                  <Button size="sm" variant="ghost" title="删掉这一镜" onClick={() => editShots(e, (shots) => shots.filter((_, j) => j !== i))}><Icon name="trash" /></Button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </>
    );
    actions = <>
      <Button variant="danger" disabled={busy} onClick={() => discard('镜头清单会被丢掉，要从头再拆一遍。')}>放弃</Button>
      <span style={{ flex: 1 }} />
      <Button onClick={onClose}>先关掉</Button>
      <Button disabled={busy || !dirty} onClick={async () => { if (await saveEdits()) toast('已保存', { tone: 'ok' }); }}>保存修改</Button>
      <Button variant="primary" id="btn-bd-write" disabled={busy || !total} onClick={write}><Icon name="pen" />写提示词</Button>
    </>;
  } else {
    // writing (stopped or interrupted), or done
    const docsWritten = [state.cardsDoc, ...state.episodes.map((e) => e.doc)].filter(Boolean) as string[];
    const finished = phase === 'done' && !failed.length;
    body = (
      <>
        <p>{finished ? `全部 ${total} 个镜头都写好了。` : phase === 'done' ? `写好了 ${doneCount}/${total} 个镜头，有 ${failed.length} 个没写成。` : `已停下：写好了 ${doneCount}/${total} 个镜头。`}</p>
        {state.error ? <p className="bd-bad">{state.error}</p> : null}
        {docsWritten.length ? <>
          <div className="bd-section">生成的文档</div>
          <ul className="bd-list">{docsWritten.map((d) => <li key={d}>{d}</li>)}</ul>
        </> : null}
        {failed.length ? <>
          <div className="bd-section">没写成的镜头</div>
          <ul className="bd-list">{failed.map(({ e, s, i }) => <li key={`${e.id}-${i}`}>{epName(e.id)}第 {i + 1} 镜「{s.title}」：<span className="bd-bad">{s.error}</span></li>)}</ul>
        </> : null}
        {phase === 'done' ? <div className="bd-next">
          <b>下一步</b>
          <p>1. 去<a onClick={() => go('assets')}>素材页</a>给新的人物和场景出图、选定主图。</p>
          <p>2. 去<a onClick={() => go('shots')}>镜头页</a>：主图选好后，镜头会自动挂上对应的参考图，就可以开始抽卡了。</p>
        </div> : null}
      </>
    );
    actions = <>
      {phase === 'done' ? <Button variant="ghost" disabled={busy} onClick={() => discard('')}>清除这次的记录</Button> : <Button variant="danger" disabled={busy} onClick={() => discard('没写完的镜头不会再写了。已经生成的文档会留着。')}>放弃</Button>}
      <span style={{ flex: 1 }} />
      <Button onClick={onClose}>关闭</Button>
      {!finished ? <Button variant="primary" disabled={busy} onClick={write}>{phase === 'done' ? '重试没写成的' : '接着写'}</Button> : null}
    </>;
  }

  return (
    <Modal wide id="breakdown" title={<span><Icon name="film" /> 剧本拆分镜</span>} onClose={onClose} actions={actions}>
      {body}
    </Modal>
  );
}
