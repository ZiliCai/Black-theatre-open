import { useEffect, useRef, useState } from 'react';
import { api, mediaUrl, type Affect, type CardDetail, type CardLook, type PictureDraft } from '../../api';
import { Button, Field, Icon, Modal, Segmented, Select, TextArea, TextInput, useToast } from '../../components';
import { LinkedEdits } from '../shots/LinkedEdits';

export const MAX_COUNT = 12;

// The right-hand panel: how the next pictures are made, what the list says about the card, where it appears.
// The draft is saved as it is typed; flush() writes what is still waiting before a take starts.
export function AssetInspector({ action, detail, draft, onDraft, flushRef, onOpenList, onShot }: { action: React.ReactNode;
  detail: CardDetail; draft: PictureDraft; onDraft: (d: PictureDraft) => void;
  flushRef: { current: () => Promise<void> }; onOpenList: () => void; onShot: (shotId: string) => void;
}) {
  const toast = useToast();
  const [prompt, setPrompt] = useState(detail.prompt);
  const [look, setLook] = useState<CardLook>(detail.look);
  const [choosingBase, setChoosingBase] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [revising, setRevising] = useState(false);
  const [linked, setLinked] = useState<Affect[] | null>(null); // shots that still describe the old look
  const timer = useRef(0);
  const pending = useRef<PictureDraft | null>(null);
  const code = detail.card.code;

  useEffect(() => setPrompt(detail.prompt), [detail.prompt]);
  useEffect(() => setLook(detail.look), [detail.look]);

  const save = async () => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    const r = await api.saveAssetDraft({ code, draft: next });
    if (!r.ok) toast(r.message || '没能保存出图设置', { tone: 'bad' });
    else {
      if (typeof r.prompt === 'string') setPrompt(r.prompt);
      if (r.look) setLook(r.look);
    }
  };
  flushRef.current = save;
  useEffect(() => () => { if (pending.current) save(); }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (patch: Partial<PictureDraft>, at = 500) => {
    const next = { ...draft, ...patch };
    onDraft(next);
    pending.current = next;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, at);
  };

  // a one-line remark ("腰间不要挂钥匙") edits the wish and the card's copy of the appearance, then the result is
  // tidied, all saved like typing; 整理 alone only tidies: the picture stays, the pile of "不要……" goes
  const revise = async (tidyOnly = false) => {
    if ((!tidyOnly && !feedback.trim()) || revising) return;
    setRevising(true);
    const r = await api.reviseAssetAsk({ code, ask: draft.ask, look: look.text, mode: draft.mode, feedback: tidyOnly ? '' : feedback, tidyOnly });
    setRevising(false);
    if (!r.ok || typeof r.ask !== 'string') {
      toast(r.message || 'AI 改写失败', { tone: 'bad' });
      return;
    }
    const patch: Partial<PictureDraft> = { ask: r.ask.slice(0, 2000) };
    if (typeof r.look === 'string' && r.look !== look.text) Object.assign(patch, { look: r.look.slice(0, 2000), lookFrom: detail.card.description || '' });
    change(patch, 0);
    if (!tidyOnly) setFeedback('');
    if (r.note) toast(`AI 改了：${r.note}`, { ms: 8000 });
    (r.warnings || []).forEach((w: string) => toast(w, { tone: 'bad', ms: 10000 }));
    if (r.affects?.length) setLinked(r.affects);
  };

  const kept = detail.set;
  const size = detail.aspects.find((a) => a.id === draft.aspect);
  const base = kept.find((s) => s.image === draft.base);
  const setMode = (mode: PictureDraft['mode']) => {
    if (mode === 'i2i' && !kept.length) {
      toast('先生成一张图并加入参考图，就能用它来改图。', { tone: 'bad' });
      return;
    }
    change({ mode, base: mode === 'i2i' && !base ? detail.main || kept[0].image : draft.base }, 0);
  };

  return (
    <aside className="inspector asset-inspector" id="asset-inspector">
      <section className="sec">
        <div className="c-section-title"><span>出图方式</span></div>
        <Segmented id="pic-mode" wide value={draft.mode} onChange={setMode}
          options={[{ value: 't2i', label: '文生图' }, { value: 'i2i', label: '图生图' }]} />
        {!kept.length ? <div className="note">先生成一张图并加入参考图，再选它作为底图。</div> : null}
        {draft.mode === 'i2i' ? (
          <button className="base-pick" id="btn-base" onClick={() => setChoosingBase(true)}>
            {base ? <img src={mediaUrl('project', base.image)} alt="" /> : <span className="thumb empty" />}
            <span>基于：{base ? base.label : '还没选'}<small>点这里换成卡里的其他图</small></span>
          </button>
        ) : null}
      </section>

      <section className="sec">
        <div className="c-section-title"><span>想要什么样的图</span><span className="hint">大白话即可</span></div>
        <TextArea id="pic-ask" className="ask" value={draft.ask} maxLength={2000}
          placeholder={draft.mode === 'i2i' ? '比如：同一个人，侧面 45°，站在岔口，头灯照向左边' : '比如：正面定妆，站在路边，全身'}
          onChange={(e) => change({ ask: e.target.value })} onBlur={save} />
        <div className="revise">
          <TextInput small id="pic-feedback" value={feedback} placeholder="哪里不满意？" title="比如：让他稍微帅一点"
            onChange={(e) => setFeedback(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') revise(); }} />
          <Button id="btn-pic-revise" disabled={revising || !feedback.trim()} onClick={() => revise()}><Icon name="sparkle" />{revising ? '改写中…' : 'AI 改写'}</Button>
          <Button id="btn-pic-tidy" disabled={revising} onClick={() => revise(true)}
            title="画面不变：把「不要……」「没有……」换成正面写法，删除重复的和修改口吻的话">精简提示词</Button>
        </div>
        <div className="picture-settings">
          {draft.mode === 't2i' ? (
            <Field label="尺寸" hint={size ? `${size.w}×${size.h}` : ''}>
              <Select id="pic-aspect" value={draft.aspect} onChange={(e) => change({ aspect: e.target.value }, 0)}>
                {detail.aspects.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </Select>
            </Field>
          ) : <Field label="尺寸"><div className="fixed-val">跟随基于的图</div></Field>}
          <Field label="一次生成几张">
            <TextInput id="pic-count" type="number" min={1} max={MAX_COUNT} value={draft.count}
              onChange={(e) => change({ count: Math.min(MAX_COUNT, Math.max(1, Number(e.target.value) || 1)) })} />
          </Field>
          {action}
        </div>
      </section>

      <section className="sec">
        <div className="c-section-title"><span>外形描述</span>
          {detail.card.source ? <button className="link" id="btn-open-list" onClick={onOpenList}>打开清单</button> : null}
        </div>
        <div className="desc" id="pic-look">{look.text || <span className="dim">清单里这一行没有写外形描述。</span>}</div>
        {look.edited ? (
          <div className="note">AI 改写过，只用在这张卡出图，清单原文没动。
            <button className="link" id="btn-look-reset" onClick={() => change({ look: '', lookFrom: '' }, 0)}>恢复清单原文</button>
          </div>
        ) : look.stale ? <div className="note">清单里的外形描述改过了，之前 AI 改写的版本不再使用。</div> : null}
        <details className="final">
          <summary>最终提示词</summary>
          <pre id="pic-prompt">{prompt}</pre>
        </details>
      </section>

      <section className="sec">
        <div className="c-section-title"><span>出场镜头</span><span className="hint">剧本里写了 IMG-{code} 的镜头</span></div>
        {detail.appearances.length ? (
          <div className="chips">
            {detail.appearances.map((id) => <button key={id} className="chip num" onClick={() => onShot(id)}>{id.replace(/^MOTION-/i, '')}</button>)}
          </div>
        ) : <div className="note">还没有镜头用到这张卡。</div>}
      </section>

      {choosingBase ? (
        <Modal title="基于哪张图" onClose={() => setChoosingBase(false)}>
          <div className="pick-grid">
            {kept.map((s) => (
              <button key={s.image} className={s.image === draft.base ? 'main' : ''} onClick={() => { change({ base: s.image }, 0); setChoosingBase(false); }}>
                <img src={mediaUrl('project', s.image)} alt="" loading="lazy" />
                <span className="ellipsis">{s.image === detail.main ? '主图 · ' : ''}{s.label}</span>
              </button>
            ))}
          </div>
        </Modal>
      ) : null}
      {linked ? <LinkedEdits from={`${detail.card.name || code}的外形`} items={linked} onClose={() => setLinked(null)} /> : null}
    </aside>
  );
}
