import { useEffect, useRef, useState } from 'react';
import { api, mediaUrl, type Affect, type CardSets, type ContinuationChoice, type Draft, type ShotDetail, type ShotValues } from '../../api';
import { Button, Icon, Modal, Segmented, Select, TextArea, TextInput, useToast } from '../../components';
import { ContinuationField } from './ContinuationField';
import { LinkedEdits } from './LinkedEdits';
import { ParamsFields } from './ParamsFields';
import { WorkflowMath } from '../../legacy';

type Asset = { value: string; label: string };
const refPath = (value: string) => value.replace(/ \[output]$/, '');

// A reference whose file is not in the output folder says so instead of showing a broken picture.
function RefImage({ value, onClick }: { value: string; onClick?: () => void }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => setMissing(false), [value]);
  if (missing) return <div className="ref-missing" onClick={onClick}>找不到这张图</div>;
  return <img src={mediaUrl('workflow', refPath(value))} alt="" onClick={onClick} onError={() => setMissing(true)} />;
}

// The right-hand panel: prompt, references, continuation, parameters and template of one shot.
// warnings: what the checks found in this shot's script entry
export function Inspector({ detail, warnings = [], onSaved, onReload }: {
  detail: ShotDetail; warnings?: string[]; onSaved: () => void; onReload: () => void;
}) {
  const toast = useToast();
  const [prompt, setPrompt] = useState(detail.draft.values.prompt);
  const [values, setValues] = useState<ShotValues>(detail.draft.values);
  const [feedback, setFeedback] = useState('');
  const [revising, setRevising] = useState(false);
  const [linked, setLinked] = useState<Affect[] | null>(null); // shots to change along with this one
  const [picking, setPicking] = useState<number | null>(null);
  const [assets, setAssets] = useState<{ images: Asset[]; loras: Asset[] }>({ images: [], loras: [] });
  const [cards, setCards] = useState<CardSets['cards']>([]);
  const [pickFrom, setPickFrom] = useState<'cards' | 'folder'>('cards');
  const savedPrompt = useRef(detail.draft.values.prompt);
  const promptTimer = useRef(0);
  const draftTimer = useRef(0);
  const shotId = detail.shot.id;

  // A different shot replaces everything. Fresh data for the same shot (a take finished, the draft was saved)
  // must not overwrite what the user is typing right now.
  const lastShot = useRef(shotId);
  useEffect(() => {
    const otherShot = lastShot.current !== shotId;
    lastShot.current = shotId;
    const typing = !otherShot && promptTimer.current !== 0;
    if (!typing) {
      setPrompt(detail.draft.values.prompt);
      savedPrompt.current = detail.draft.values.prompt;
    }
    if (otherShot || draftTimer.current === 0) setValues(detail.draft.values);
  }, [detail, shotId]);

  useEffect(() => {
    api.getWorkflowForm().then((r) => setAssets({ images: r.assets?.images || [], loras: r.assets?.loras || [] }));
  }, [shotId]);

  // the cards' kept pictures, fresh each time the picker opens (a picture may have just been kept)
  useEffect(() => {
    if (picking === null) return;
    api.assetSets().then((r) => {
      const list = r.ok ? r.cards : [];
      setCards(list);
      if (!list.length) setPickFrom('folder');
    });
  }, [picking]);

  useEffect(() => () => { window.clearTimeout(promptTimer.current); window.clearTimeout(draftTimer.current); }, []);

  const writePrompt = async (text: string) => {
    window.clearTimeout(promptTimer.current);
    promptTimer.current = 0;
    if (text === savedPrompt.current) return;
    const r = await api.writeShotPrompt({ shotId, expected: savedPrompt.current, prompt: text });
    if (r.ok) {
      savedPrompt.current = text;
      onSaved();
    } else {
      toast(r.message || '保存提示词失败', { tone: 'bad', ms: 10000, action: { label: '刷新', run: onReload } });
    }
  };
  const onPrompt = (text: string) => {
    setPrompt(text);
    window.clearTimeout(promptTimer.current);
    promptTimer.current = window.setTimeout(() => writePrompt(text), 800);
  };

  const saveDraft = (draft: Draft, now = false) => {
    window.clearTimeout(draftTimer.current);
    const run = async () => {
      draftTimer.current = 0;
      const r = await api.saveShotDraft({ shotId, draft });
      if (!r.ok) toast(r.message || '保存失败', { tone: 'bad' });
      onSaved();
    };
    if (now) {
      draftTimer.current = 0;
      run();
    } else {
      draftTimer.current = window.setTimeout(run, 300);
    }
  };
  const change = (patch: Partial<ShotValues>) => {
    const next = { ...values, ...patch };
    setValues(next);
    saveDraft({ ...detail.draft, values: { ...next, prompt } });
  };
  const setContinuation = (continuation: ContinuationChoice) => saveDraft({ ...detail.draft, values: { ...values, prompt }, continuation }, true);
  const setTemplate = (templateId: string) => {
    // keep what belongs to the shot; the new template fills in its own defaults
    const keep = { prompt, duration: values.duration, aspect: values.aspect, references: values.references, seedMode: values.seedMode, seed: values.seed };
    saveDraft({ ...detail.draft, templateId, values: keep as ShotValues }, true);
  };

  // an AI rewrite carries out the remark and then tidies the result; 整理 alone only tidies: shot and beats stay,
  // the pile of "no …, does not …" goes
  const revise = async (tidyOnly = false) => {
    if (!tidyOnly && !feedback.trim()) return;
    setRevising(true);
    // the references and length tell the model who <Picture N> is and how much fits in the shot; a continued shot
    // must keep its opening, which overlaps the end of the previous one
    const aspect = detail.form.aspects.find((a) => a.id === values.aspect);
    const dims = aspect ? WorkflowMath.dimensions(aspect, Number(values.megapixels) || 1) : null;
    const { supported, resolved } = detail.continuation;
    const r = await api.reviseWorkflowPrompt({ text: prompt, feedback: tidyOnly ? '' : feedback, tidyOnly, aroundShotId: shotId, context: {
      references: values.references || [], duration: values.duration, width: dims?.width, height: dims?.height,
      continuation: supported && resolved.ok && resolved.enabled,
    } });
    setRevising(false);
    if (!r.ok || typeof r.text !== 'string') {
      toast(r.message || 'AI 改写失败', { tone: 'bad' });
      return;
    }
    setPrompt(r.text);
    if (!tidyOnly) setFeedback('');
    await writePrompt(r.text);
    if (r.note) toast(`AI 改了：${r.note}`, { ms: 8000 });
    (r.warnings || []).forEach((w: string) => toast(w, { tone: 'bad', ms: 10000 }));
    if (r.affects?.length) setLinked(r.affects);
  };

  // this shot was left behind when an earlier one changed: rewrite it with the remark written for it, or let it be
  const followNote = async () => {
    if (!detail.linkNote) return;
    setRevising(true);
    const r = await api.reviseLinkedShot({ shotId, remark: detail.linkNote.remark });
    setRevising(false);
    if (!r.ok) {
      toast(r.message || 'AI 改写失败', { tone: 'bad' });
      return;
    }
    if (r.note) toast(`AI 改了：${r.note}`, { ms: 8000 });
    (r.warnings || []).forEach((w: string) => toast(w, { tone: 'bad', ms: 10000 }));
    if (r.affects?.length) setLinked(r.affects);
    onReload();
  };
  // the prompt checked against the shot's blocking and rewritten where it disagrees
  const fitBlocking = async () => {
    setRevising(true);
    const r = await api.fitBlocking({ shotId });
    setRevising(false);
    if (!r.ok) { toast(r.message || 'AI 改写失败', { tone: 'bad' }); return; }
    if (r.note) toast(`AI 改了：${r.note}`, { ms: 8000 });
    (r.warnings || []).forEach((w: string) => toast(w, { tone: 'bad', ms: 10000 }));
    if (r.affects?.length) setLinked(r.affects);
    onReload();
  };
  const dismissNote = async () => {
    await api.clearLinkedShot({ shotId });
    onReload();
  };

  const importFromScript = async () => {
    const r = await api.importWorkflowShot({ shotId });
    if (!r.ok) {
      toast(r.message || '导入失败', { tone: 'bad' });
      return;
    }
    const refs: string[] = (r.values?.references || []).filter(Boolean);
    change({ references: refs });
    (r.warnings || []).forEach((w: string) => toast(w, { tone: 'bad' }));
    toast(`已从剧本导入 ${refs.length} 张参考图`, { tone: 'ok' });
  };

  const maxRefs = Number(detail.form.limits.maxReferences || detail.form.referenceSlots.length || 0);
  const refs = values.references || [];
  const kept = cards.flatMap((c) => c.images.map((i) => ({ ...i, label: `${c.code} · ${i.label}` })));
  const nameOf = (value: string) => (kept.find((a) => a.value === value) || assets.images.find((a) => a.value === value) || { label: refPath(value) }).label;
  const choose = (value: string) => {
    if (picking === null) return;
    const next = [...refs];
    next[picking] = value;
    change({ references: next.filter(Boolean) });
    setPicking(null);
  };

  return (
    <aside className="inspector" id="inspector">
      <section className="sec">
        <div className="c-section-title"><span>提示词</span><span className="hint">{detail.shot.source === 'script' ? '改动会写回剧本文件' : '手动镜头'}</span></div>
        {detail.linkNote ? (
          <div className="link-note" id="link-note">
            <div><Icon name="warn" size={14} /> {detail.linkNote.from}改过，这一镜可能接不上：{detail.linkNote.reason}</div>
            <div className="remark">建议：{detail.linkNote.remark}</div>
            <div className="acts">
              <Button size="sm" variant="primary" id="btn-follow-note" disabled={revising} onClick={followNote}>按建议改这一镜</Button>
              <Button size="sm" variant="ghost" onClick={dismissNote}>不用改</Button>
            </div>
          </div>
        ) : null}
        {warnings.length ? (
          <div className="shot-warnings" id="shot-own-warnings">
            {warnings.map((w, i) => <div key={i}><Icon name="warn" size={13} />{w.replace(/^\d+\s+/, '')}</div>)}
          </div>
        ) : null}
        <TextArea id="prompt" className="prompt" value={prompt} onChange={(e) => onPrompt(e.target.value)} onBlur={() => writePrompt(prompt)} />
        {detail.blocking ? (
          <details className="blocking-facts" id="blocking-facts">
            <summary>站位（白模算的，AI 改写时照它写）</summary>
            <pre>{detail.blocking}</pre>
            <Button size="sm" id="btn-fit-blocking" disabled={revising} onClick={fitBlocking} title="让 AI 把提示词里和站位对不上的地方改过来（画面左右、正脸背影、身后是什么）">按站位改</Button>
          </details>
        ) : null}
        <div className="revise">
          <TextInput small id="revise-feedback" value={feedback} placeholder="哪里不满意？" title="比如：让男主说话时看向窗外" onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') revise(); }} />
          <Button id="btn-revise" disabled={revising || !feedback.trim()} onClick={() => revise()}><Icon name="sparkle" />{revising ? '改写中…' : 'AI 改写'}</Button>
          <Button id="btn-tidy" disabled={revising || !prompt.trim()} onClick={() => revise(true)}
            title="画面和节拍都不变：把否定描述换成正面描述，删除反复强调的话">精简提示词</Button>
        </div>
      </section>

      <section className="sec">
        <div className="c-section-title"><span>参数</span></div>
        <ParamsFields form={detail.form} values={values} loras={assets.loras} onChange={change} />
      </section>

      <section className="sec">
        <div className="c-section-title"><span>参考图</span><span className="hint num">{refs.length} / {maxRefs}</span></div>
        <div className="refs" id="refs">
          {refs.map((value, i) => (
            <div className="ref" key={`${value}-${i}`} title={value}>
              <RefImage value={value} onClick={() => setPicking(i)} />
              <div className="name ellipsis">{nameOf(value)}</div>
              <button className="x" title="移除" onClick={() => change({ references: refs.filter((_, j) => j !== i) })}><Icon name="x" size={12} /></button>
            </div>
          ))}
          {refs.length < maxRefs ? <button className="ref add" id="btn-add-ref" onClick={() => setPicking(refs.length)}><span><Icon name="plus" /><br />添加</span></button> : null}
        </div>
        {detail.shot.source === 'script' ? <Button size="sm" variant="ghost" id="btn-import-refs" onClick={importFromScript}>从剧本导入参考图</Button> : null}
      </section>



      <details className="sec"><summary>接续：{detail.continuation.options.find(o => JSON.stringify(o.choice) === JSON.stringify(detail.continuation.choice))?.label || "不接"}</summary>
        <ContinuationField detail={detail} onChange={setContinuation} />
      </details>

      <section className="sec">
        <div className="c-section-title"><span>工作流模板</span></div>
        <Select id="template" value={detail.draft.templateId} onChange={(e) => setTemplate(e.target.value)}>
          {detail.templates.map((t) => <option key={t.id} value={t.id} disabled={!t.compatible}>{t.name}{t.compatible ? '' : '（旧版，暂不能用）'}</option>)}
        </Select>
      </section>

      {picking !== null ? (
        <Modal title="选择参考图" wide onClose={() => setPicking(null)}>
          <Segmented id="pick-from" value={pickFrom} onChange={setPickFrom}
            options={[{ value: 'cards', label: `素材卡 ${cards.length}` }, { value: 'folder', label: '输出目录' }]} />
          {pickFrom === 'cards' ? (
            cards.length ? (
              <div className="pick-cards" id="pick-cards">
                {cards.map((c) => (
                  <div key={c.code}>
                    <div className="pick-card-title">{c.code} · {c.name}</div>
                    <div className="pick-grid">
                      {c.images.map((a) => (
                        <button key={a.value} className={a.main ? 'main' : ''} onClick={() => choose(a.value)}>
                          <img src={mediaUrl('workflow', refPath(a.value))} alt="" loading="lazy" />
                          <span className="ellipsis">{a.main ? '主图 · ' : ''}{a.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : <p style={{ color: 'var(--sub)' }}>还没有参考图。去「素材」页生成图片，点「加入参考图」后就能在这里挑。</p>
          ) : assets.images.length ? (
            <div className="pick-grid">
              {assets.images.map((a) => (
                <button key={a.value} onClick={() => choose(a.value)}>
                  <img src={mediaUrl('workflow', refPath(a.value))} alt="" loading="lazy" />
                  <span className="ellipsis">{a.label}</span>
                </button>
              ))}
            </div>
          ) : <p style={{ color: 'var(--sub)' }}>输出目录里还没有图片。把参考图放进项目的 output 文件夹后再来选。</p>}
        </Modal>
      ) : null}
      {linked ? <LinkedEdits from={`镜头 ${detail.shot.n} `} items={linked} onClose={() => { setLinked(null); onReload(); }} /> : null}
    </aside>
  );
}
