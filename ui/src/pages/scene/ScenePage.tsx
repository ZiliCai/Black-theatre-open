import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Scene, type SceneBuilt, type SceneProblem, type SceneProposal, type SceneRow } from '../../api';
import { Button, EmptyState, Field, Icon, Modal, Segmented, Select, TextArea, TextInput, useToast } from '../../components';
import { useDialog } from '../../components/dialog';
import { useApp } from '../../shell/context';
import { SceneView, type Floor, type Light, type SceneViewHandle } from './SceneView';
import { ScenePlan } from './ScenePlan';
import './scene.css';

type Open = { id: string; scene: Scene; version: string; built: SceneBuilt; problems: SceneProblem[] };
type Doc = { relPath: string; name: string; category: string };
const FLOOR_NAMES = ['一楼', '二楼', '三楼', '四楼', '五楼', '六楼', '七楼', '八楼'];
const SUGGESTED = /空间|场景|设定|参考图|布局/;

// Whitebox scenes: a building and its surroundings as boxes, to settle where things are before a shot is written.
// The AI proposes (from the story documents, or a change asked for in words), the page shows the proposal in 3D
// with what the checks found, and nothing is saved until 应用.
export function ScenePage() {
  const { projectVersion, go } = useApp();
  const toast = useToast();
  const { confirm } = useDialog();
  const view = useRef<SceneViewHandle>(null);
  const [list, setList] = useState<SceneRow[] | null>(null);
  const [noProject, setNoProject] = useState(false);
  const [open, setOpen] = useState<Open | null>(null);
  const [proposal, setProposal] = useState<SceneProposal | null>(null);
  const [floor, setFloor] = useState<Floor>(0); // the plan opens on the ground floor, its rooms and furniture in view
  const [mode, setMode] = useState<'orbit' | 'plan'>('plan'); // a scene opens on its plan, fitted and centred
  const [light, setLight] = useState<Light>('morning');
  const [labels, setLabels] = useState(true);
  const [withPeople, setWithPeople] = useState(true);
  const [tab, setTab] = useState<'ai' | 'blocking' | 'problems' | 'data'>('ai');
  // the blocking shown in 3D (its people and cameras), and what each of its cameras sees
  const [setup, setSetup] = useState('');
  const [setupView, setSetupView] = useState<{ built: SceneBuilt; facts: Record<string, string> } | null>(null);
  const [blocking, setBlocking] = useState({ name: '', room: '', shots: '', remark: '' });
  const [remark, setRemark] = useState('');
  const [picked, setPicked] = useState<{ name: string; room: string } | null>(null);
  const [onlyRoom, setOnlyRoom] = useState(true);
  const [busy, setBusy] = useState('');
  const [json, setJson] = useState<{ text: string; error: string } | null>(null);
  const [making, setMaking] = useState<{ name: string; from: 'docs' | 'blank'; docs: Doc[]; chosen: string[]; remark: string; error: string } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; text: string } | null>(null);

  const loadList = useCallback(async () => {
    const r = await api.sceneList();
    if (r.noProject) { setNoProject(true); setList(null); return []; }
    setNoProject(false);
    setList(r.scenes || []);
    return r.scenes || [];
  }, []);

  const openScene = useCallback(async (id: string) => {
    const r = await api.sceneOpen({ id });
    if (!r.ok || !r.scene || !r.built) { toast(r.message || '打不开', { tone: 'bad' }); return; }
    setOpen({ id, scene: r.scene, version: r.version || '', built: r.built, problems: r.problems || [] });
    setProposal(null);
    setPicked(null);
    setJson(null);
    setSetup('');
    try { localStorage.setItem('blackbox.scene.open', id); } catch { /* not remembered */ }
  }, [toast]);

  useEffect(() => {
    setOpen(null);
    loadList().then((scenes) => {
      let last = '';
      try { last = localStorage.getItem('blackbox.scene.open') || ''; } catch { /* nothing remembered */ }
      const pick = scenes.find((s) => s.id === last) || scenes[0];
      if (pick) openScene(pick.id);
    });
  }, [projectVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => api.onSceneProgress((p) => setProgress(p)), []);

  // the scene on screen: the AI's proposal while there is one
  const shownScene = proposal?.scene || open?.scene || null;
  const setups = shownScene?.setups || [];
  useEffect(() => {
    if (!setup || !shownScene || proposal?.facts) { setSetupView(null); return; }
    let live = true;
    api.sceneBuild({ scene: shownScene, setup }).then((b) => { if (live) setSetupView({ built: b.built, facts: b.facts || {} }); });
    return () => { live = false; };
  }, [setup, shownScene, proposal]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownBuilt = proposal?.built || (setup && setupView ? setupView.built : null) || open?.built || null;
  const facts = proposal?.facts || setupView?.facts || {};
  const problems = proposal?.problems || open?.problems || [];
  const errors = problems.filter((p) => p.level === 'error').length;
  const levels = shownBuilt?.levels || 1;
  const cameras = shownBuilt?.cameras || [];

  const save = async (scene: Scene) => {
    if (!open) return false;
    const r = await api.sceneSave({ id: open.id, scene, version: open.version });
    if (!r.ok) { toast(r.message || '保存失败', { tone: 'bad' }); return false; }
    const b = await api.sceneBuild({ scene });
    setOpen({ ...open, scene, version: r.version || open.version, built: b.built, problems: b.problems });
    loadList();
    return true;
  };

  const askAi = async () => {
    if (!open || !remark.trim()) return;
    setBusy('AI 正在改…（要看整个场景，可能要一两分钟）');
    const focus = picked?.room && onlyRoom ? picked.room : '';
    const r = await api.sceneEdit({ scene: open.scene, remark: remark.trim(), focus });
    setBusy('');
    if (!r.ok) { toast(r.message || 'AI 没改成', { tone: 'bad' }); return; }
    setProposal(r);
  };
  const refurnish = async () => {
    if (!open || !picked?.room) return;
    setBusy(`AI 正在重摆「${picked.room}」…`);
    const r = await api.sceneFurnish({ scene: open.scene, room: picked.room, remark: remark.trim(), docs: (open.scene.sources as string[]) || [] });
    setBusy('');
    if (!r.ok) { toast(r.message || 'AI 没摆成', { tone: 'bad' }); return; }
    setProposal({ ...r, note: `重摆了「${picked.room}」`, done: [], failed: [] });
  };
  const askBlocking = async () => {
    if (!open) return;
    const { name, room, shots: spec, remark: wish } = blocking;
    if (!name.trim() || !room || !spec.trim()) { toast('站位名字、房间和镜头都要填', { tone: 'bad' }); return; }
    setBusy('AI 正在排站位…（排好以后软件会核对每个机位，不对会让它重排）');
    const r = await api.sceneBlock({ scene: open.scene, name: name.trim(), room, shots: spec.trim(), remark: wish.trim() });
    setBusy('');
    if (!r.ok) { toast(r.message || 'AI 没排成', { tone: 'bad' }); return; }
    setSetup(name.trim());
    setProposal({ ...r, done: [], failed: [], added: [] });
  };
  const applyProposal = async () => {
    if (!proposal?.scene) return;
    if (await save(proposal.scene)) { setProposal(null); setRemark(''); toast('已应用，改之前的版本留在 白模/.history 里', { tone: 'ok' }); }
  };

  const startMaking = async () => {
    const r = await api.listDocs();
    const docs = ((r.docs || []) as Doc[]);
    setMaking({ name: '', from: 'docs', docs, chosen: docs.filter((d) => SUGGESTED.test(d.name)).map((d) => d.relPath), remark: '', error: '' });
  };
  const make = async () => {
    if (!making) return;
    const name = making.name.trim();
    if (!name) { setMaking({ ...making, error: '先起个名字' }); return; }
    if (making.from === 'blank') {
      const r = await api.sceneCreate({ name });
      if (!r.ok) { setMaking({ ...making, error: r.message || '没建成' }); return; }
      setMaking(null);
      await loadList();
      openScene(r.id || name);
      return;
    }
    if (!making.chosen.length) { setMaking({ ...making, error: '至少选一篇设定文档' }); return; }
    setProgress({ done: 0, total: 1, text: '开始' });
    const r = await api.sceneGenerate({ name, docs: making.chosen, remark: making.remark });
    setProgress(null);
    if (!r.ok) { setMaking({ ...making, error: r.message || '没搭成' }); return; }
    setMaking(null);
    await loadList();
    await openScene(r.id || name);
    toast((r.skipped || []).length ? `搭好了，有 ${(r.skipped || []).length} 处 AI 没摆成，看右边的问题` : '搭好了，看看右边查出来的问题', { tone: 'ok' });
  };

  const shots = async () => {
    if (!open || !cameras.length) return;
    let saved = 0;
    for (let i = 0; i < cameras.length; i++) {
      const dataUrl = view.current?.capture(i, withPeople) || '';
      const r = await api.sceneShot({ id: open.id, index: i, camera: cameras[i].name, dataUrl });
      if (r.ok) saved++;
    }
    toast(`${saved} 个机位的截图存进了 ref/（文件名带场景代号 ${open.scene.code || open.id}）`, { tone: 'ok' });
  };
  const exportGlb = async () => {
    if (!open || !view.current) return;
    const glb = await view.current.exportGlb();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
    a.download = `${open.id}.glb`;
    a.click();
  };

  if (noProject) {
    return <EmptyState title="还没有选择剧本项目" body="场景存在项目的「白模」文件夹里。" action={<Button variant="primary" onClick={() => go('settings', 'projects')}>去设置 · 项目</Button>} />;
  }

  return (
    <div className="scene-page" id="scene-page">
      <aside className="scene-side">
        <div className="scene-list" id="scene-list">
          {(list || []).map((s) => (
            <button key={s.id} className={`doc-item ${open?.id === s.id ? 'on' : ''}`} data-scene={s.id} onClick={async () => {
              if (proposal && !(await confirm({ title: '放弃 AI 的改动', message: '还有没应用的 AI 改动，换场景会丢掉它。', okLabel: '放弃' }))) return;
              openScene(s.id);
            }}>
              <span className="t">{s.name}</span>
              <span className="s">{s.broken ? '文件坏了' : `${s.rooms} 个房间`}</span>
            </button>
          ))}
          {list && !list.length ? <div className="doc-none">还没有场景。点「新建场景」，可以让 AI 按设定文档搭一个。</div> : null}
        </div>
        <div style={{ padding: 12 }}>
        <Button id="btn-scene-new" onClick={startMaking}><Icon name="plus" />新建场景</Button>
        </div>
      </aside>

      <section className="scene-main">
        {shownBuilt ? (
          <>
            <div className="scene-tools">
              {/* a plan of the whole building shows only its roofs: it goes to a floor, the ground floor unless one is chosen */}
              <Segmented id="scene-mode" value={mode} onChange={(m) => { setMode(m); if (m === 'plan' && floor === 'all') setFloor(0); }} options={[{ value: 'orbit', label: '3D' }, { value: 'plan', label: '平面图' }]} />
              <span className="seg-floors">
                {(['all', ...Array.from({ length: levels }, (_, i) => i)] as Floor[]).map((f) => (
                  <Button key={String(f)} size="sm" on={floor === f ? 'acc' : false} onClick={() => setFloor(f)}>
                    {f === 'all' ? '整栋' : FLOOR_NAMES[f as number] || `${(f as number) + 1}楼`}
                  </Button>
                ))}
              </span>
              <Select small id="scene-cam" value="" onChange={(e) => { if (e.target.value !== '') { setMode('orbit'); setFloor('all'); view.current?.showCamera(Number(e.target.value)); } }}>
                <option value="">机位…</option>
                {cameras.map((c, i) => <option key={i} value={i}>{c.name}</option>)}
              </Select>
              <Select small id="scene-setup" value={setup} onChange={(e) => setSetup(e.target.value)} disabled={!!proposal?.facts}>
                <option value="">站位…</option>
                {setups.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </Select>
              <Select small value={light} onChange={(e) => setLight(e.target.value as Light)}>
                <option value="morning">清晨</option><option value="noon">中午</option><option value="evening">傍晚</option><option value="night">夜里</option>
              </Select>
              <label className="chk"><input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} />文字</label>
              <span style={{ flex: 1 }} />
              <label className="chk" title="不带人的截图适合做图生图的场景底图（人物由身份参考图出）"><input type="checkbox" id="chk-shot-people" checked={withPeople} onChange={(e) => setWithPeople(e.target.checked)} />截图带人</label>
              <Button size="sm" id="btn-scene-shots" disabled={!cameras.length || !!proposal} onClick={shots} title="每个机位拍一张 1280×720，存进项目的 ref/">机位截图→参考图</Button>
              <Button size="sm" onClick={exportGlb} title="Blender：文件 → 导入 → glTF 2.0">导出 GLB</Button>
            </div>
            {proposal ? <div className="scene-banner">现在看到的是 AI 改过的样子，还没保存。右边点「应用」才会存下来。</div> : null}
            {/* the 3D view stays (camera pictures and the GLB come from it); the plan is a drawing laid over it */}
            <div className="scene-stage">
              <SceneView ref={view} built={shownBuilt} floor={floor} light={light} labels={labels}
                onPick={(p) => { setPicked(p); if (p.room) setOnlyRoom(true); }} />
              {mode === 'plan' ? (
                <ScenePlan built={shownBuilt} floor={floor === 'all' ? 0 : floor} labels={labels} selected={picked?.name}
                  onPick={(p) => { setPicked(p); if (p.room) setOnlyRoom(true); }} />
              ) : null}
            </div>
            <div className="scene-hint">{mode === 'plan' ? '拖动平移 · 滚轮缩放 · 点一下房间或家具选中它' : '左键拖动旋转 · 右键拖动平移 · 滚轮缩放 · 点一下房间或家具选中它'}</div>
          </>
        ) : <EmptyState title={list && list.length ? '选一个场景' : '还没有场景'} body="白模用方块搭出建筑和周围的地形，定好房间、门窗、家具和机位，写提示词时左右、远近就不会乱。" />}
      </section>

      <aside className="scene-panel">
        <div className="scene-tabs">
          <Segmented value={tab} onChange={setTab} options={[{ value: 'ai', label: 'AI 修改' }, { value: 'blocking', label: '站位' }, { value: 'problems', label: `问题${problems.length ? ` ${problems.length}` : ''}` }, { value: 'data', label: '数据' }]} />
        </div>
        {!open ? null : tab === 'ai' ? (
          <div className="scene-ai" id="scene-ai">
            {picked ? (
              <div className="picked">
                <span>选中：<b>{picked.name}</b>{picked.room && picked.room !== picked.name ? `（在「${picked.room}」）` : ''}</span>
                {picked.room ? <>
                  <label className="chk"><input type="checkbox" checked={onlyRoom} onChange={(e) => setOnlyRoom(e.target.checked)} />只改「{picked.room}」</label>
                  <Button size="sm" disabled={!!busy || !!proposal} onClick={refurnish} title="按设定文档和下面写的要求，把这一间的门窗、家具重新摆一遍">重摆这一间</Button>
                </> : null}
                <Button size="sm" variant="ghost" onClick={() => setPicked(null)}><Icon name="x" /></Button>
              </div>
            ) : <p className="hint">在 3D 里点一下房间或家具，可以只改那一间。</p>}
            <TextArea id="scene-remark" rows={4} value={remark} onChange={(e) => setRemark(e.target.value)}
              placeholder="比如：何遇的床挪到窗户对面；宿舍走廊加一扇通停车场的门；屋顶东南角加一个机位，看得见何遇的窗"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); askAi(); } }} />
            <Button variant="primary" id="btn-scene-ask" disabled={!remark.trim() || !!busy || !!proposal} onClick={askAi}>让 AI 改（Ctrl+Enter）</Button>
            {busy ? <p className="hint">{busy}</p> : null}
            {proposal ? (
              <div className="proposal" id="scene-proposal">
                {proposal.note ? <p><b>{proposal.note}</b></p> : null}
                {(proposal.done || []).map((d, i) => <div key={i} className="op ok"><Icon name="check" />{d}</div>)}
                {(proposal.failed || []).map((f, i) => <div key={i} className="op bad">{f.text}：{f.message}</div>)}
                {(proposal.added || []).length ? <div className="added">
                  <b>改完多出来的问题</b>
                  {(proposal.added || []).map((p, i) => <div key={i} className={`prob ${p.level}`}>{p.where}：{p.message}</div>)}
                </div> : <p className="hint">没有查出新的问题{proposal.tries && proposal.tries > 1 ? `（AI 改了 ${proposal.tries} 次才通过检查）` : ''}。</p>}
                <div className="row">
                  <Button onClick={() => setProposal(null)}>放弃</Button>
                  <Button variant="primary" id="btn-scene-apply" onClick={applyProposal}>应用</Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : tab === 'blocking' ? (
          <div className="scene-ai scene-blocking" id="scene-blocking">
            <p className="hint">一段连续的戏先定好谁坐在哪、朝哪，每镜相机放在哪。软件按白模算出每镜画面里谁在左谁在右、拍到脸还是背影、身后是什么，镜头页改写提示词时照这个写，也会拿它核对提示词。</p>
            <Field label="站位名字"><TextInput id="blk-name" value={blocking.name} placeholder="例如：窗边桌·早饭" onChange={(e) => setBlocking({ ...blocking, name: e.target.value })} /></Field>
            <Field label="房间">
              <Select id="blk-room" value={blocking.room} onChange={(e) => setBlocking({ ...blocking, room: e.target.value })}>
                <option value="">选房间…</option>
                {(shownScene?.rooms || []).map((r) => <option key={String(r.name)} value={String(r.name)}>{String(r.name)}</option>)}
              </Select>
            </Field>
            <Field label="镜头"><TextInput id="blk-shots" value={blocking.shots} placeholder="E01-014~023，或 E01-015, E01-017" onChange={(e) => setBlocking({ ...blocking, shots: e.target.value })} /></Field>
            <Field label="另外的要求（可以不写）"><TextInput id="blk-remark" value={blocking.remark} onChange={(e) => setBlocking({ ...blocking, remark: e.target.value })} /></Field>
            <Button variant="primary" id="btn-scene-block" disabled={!!busy || !!proposal} onClick={askBlocking} title="AI 读这些镜头的提示词和剧本里标题带「站位」的段落，排人和机位；同名的站位已经有了，就只重排没对上的机位（写了「另外的要求」则整个重排）">{setups.some((s) => s.name === blocking.name.trim()) && !blocking.remark.trim() ? '重排没对上的机位' : 'AI 排站位'}</Button>
            {busy ? <p className="hint">{busy}</p> : null}
            {proposal?.facts ? (
              <div className="proposal">
                {proposal.note ? <p><b>{proposal.note}</b></p> : null}
                {(proposal.left || []).length ? <div className="added"><b>核对没通过的</b>{(proposal.left || []).map((t, i) => <div key={i} className="prob warn">{t}</div>)}</div>
                  : <p className="hint">每个机位都对上了想要的构图{proposal.tries && proposal.tries > 1 ? `（AI 排了 ${proposal.tries} 次）` : ''}。</p>}
                <div className="row">
                  <Button onClick={() => setProposal(null)}>放弃</Button>
                  <Button variant="primary" id="btn-blocking-apply" onClick={applyProposal}>应用</Button>
                </div>
              </div>
            ) : null}
            {Object.keys(facts).length ? (
              <div className="facts" id="scene-facts">
                {Object.entries(facts).map(([cam, text]) => {
                  const i = cameras.findIndex((c) => c.name === cam);
                  return (
                    <div key={cam} className="fact">
                      <Button size="sm" variant="ghost" disabled={i < 0} onClick={() => { setMode('orbit'); setFloor('all'); view.current?.showCamera(i); }}>看这个机位</Button>
                      <pre>{text}</pre>
                    </div>
                  );
                })}
              </div>
            ) : setups.length ? <p className="hint">在上面工具栏的「站位…」里选一个，3D 里会画出人和机位。</p> : null}
          </div>
        ) : tab === 'problems' ? (
          <div className="scene-problems" id="scene-problems">
            {!problems.length ? <p className="hint">没查出问题。</p> : null}
            {problems.map((p, i) => <div key={i} className={`prob ${p.level}`}><span className="lv">{p.level === 'error' ? '错' : '看'}</span>{p.where}：{p.message}</div>)}
            {problems.length ? <p className="hint">「错」是一定不对的（东西穿墙、叠在一起）；「看」是值得看一眼的（挡门、机位看不到要看的人）。可以把问题原话贴给 AI 让它改。</p> : null}
          </div>
        ) : (
          <div className="scene-data">
            <p className="hint">场景文件就是这份 JSON，存在项目的 白模/{open.id}.scene.json。坐标单位是米，x 往东、z 往南；家具和门窗相对房间的西北角。</p>
            <TextArea className="json" value={json ? json.text : JSON.stringify(shownScene, null, 1)}
              onChange={(e) => setJson({ text: e.target.value, error: '' })} readOnly={!!proposal} />
            {json?.error ? <p className="err">{json.error}</p> : null}
            <div className="row">
              <Button disabled={!json} onClick={() => setJson(null)}>还原</Button>
              <Button variant="primary" disabled={!json || !!proposal} onClick={async () => {
                if (!json) return;
                let scene: Scene;
                try { scene = JSON.parse(json.text); } catch (e) { setJson({ ...json, error: `不是有效的 JSON：${(e as Error).message}` }); return; }
                if (await save(scene)) { setJson(null); toast('已保存', { tone: 'ok' }); }
              }}>保存</Button>
            </div>
          </div>
        )}
        {open ? <div className="scene-foot">{errors ? <span className="bad">{errors} 处错误</span> : <span className="good">没有错误</span>} · {problems.length - errors} 处提醒</div> : null}
      </aside>

      {making ? (
        <Modal title="新建场景" onClose={() => { if (!progress) setMaking(null); }} actions={<>
          <Button disabled={!!progress} onClick={() => setMaking(null)}>取消</Button>
          <Button variant="primary" id="btn-scene-make" disabled={!!progress} onClick={make}>{making.from === 'docs' ? (progress ? '搭建中…' : '让 AI 搭') : '建一个空白场景'}</Button>
        </>}>
          <Field label="名字"><TextInput id="scene-name" autoFocus value={making.name} placeholder="例如：山顶酒店" onChange={(e) => setMaking({ ...making, name: e.target.value, error: '' })} /></Field>
          <Segmented value={making.from} onChange={(v) => setMaking({ ...making, from: v })} options={[{ value: 'docs', label: '按设定文档搭' }, { value: 'blank', label: '空白' }]} />
          {making.from === 'docs' ? <>
            <p className="hint">AI 先排房间的位置，再一层一层摆门窗和家具，每一步都过一遍检查，查出错会让它重改。大的建筑要几分钟。</p>
            <div className="scene-docs">
              {making.docs.map((d) => (
                <label key={d.relPath} className="chk">
                  <input type="checkbox" checked={making.chosen.includes(d.relPath)} onChange={(e) => setMaking({ ...making, chosen: e.target.checked ? [...making.chosen, d.relPath] : making.chosen.filter((x) => x !== d.relPath) })} />
                  <span className="ellipsis">{d.relPath}</span>
                </label>
              ))}
            </div>
            <Field label="另外的要求（可以不写）"><TextInput value={making.remark} onChange={(e) => setMaking({ ...making, remark: e.target.value })} placeholder="例如：只搭一楼和屋顶" /></Field>
          </> : null}
          {progress ? <p className="hint" id="scene-progress">第 {Math.min(progress.done + 1, progress.total)}/{progress.total} 步：{progress.text}</p> : null}
          {making.error ? <p style={{ color: 'var(--bad)' }}>{making.error}</p> : null}
        </Modal>
      ) : null}
    </div>
  );
}
