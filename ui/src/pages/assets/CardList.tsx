import { useState } from 'react';
import { mediaUrl, type CardKind, type CardRow } from '../../api';
import { Button, Icon, Modal, Segmented } from '../../components';

const STATUS: Record<CardRow['status'], string> = { empty: '待生成', ready: '已定妆', busy: '生成中' };

// The cards of one kind: main picture, code and name, and where the card stands.
export function CardList({ cards, kind, code, onKind, onCard, onOpenList, onRefresh }: {
  cards: CardRow[]; kind: CardKind; code: string;
  onKind: (k: CardKind) => void; onCard: (code: string) => void; onOpenList: () => void; onRefresh: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const count = (k: CardKind) => cards.filter((c) => c.kind === k).length;
  const shown = cards.filter((c) => c.kind === kind).sort((a, b) => Number(a.orphan) - Number(b.orphan));
  const what = kind === 'scene' ? '场景' : '角色';
  return (
    <aside className="card-list">
      <div className="head">
        <Segmented id="card-kind" wide value={kind} onChange={onKind}
          options={[{ value: 'char', label: `角色 ${count('char')}` }, { value: 'scene', label: `场景 ${count('scene')}` }]} />
      </div>
      <div className="rows" id="card-rows">
        {shown.map((c) => (
          <button key={c.code} data-card={c.code} className={`card-row ${kind} ${c.code === code ? 'on' : ''} ${c.orphan ? 'orphan' : ''}`} onClick={() => onCard(c.code)}>
            {c.main ? <img className="thumb" src={mediaUrl('project', c.main)} alt="" loading="lazy" /> : <span className="thumb empty" />}
            <span className="txt">
              <b className="ellipsis" title={`${c.code} · ${c.name}`}>{c.code} · {c.name}</b>
              <small className={c.status}>{c.status === 'ready' ? `已定妆 · ${c.kept} 张参考` : STATUS[c.status]}</small>
            </span>
          </button>
        ))}
        {!shown.length ? <div className="none">清单里还没有{what}。</div> : null}
      </div>
      <div className="foot">
        <Button id="btn-new-card" variant="ghost" onClick={() => setAdding(true)}><Icon name="plus" />新建{what}</Button>
      </div>
      {adding ? (
        <Modal title={`新建${what}`} onClose={() => setAdding(false)} actions={<>
          <Button onClick={() => { setAdding(false); onRefresh(); }}><Icon name="refresh" />刷新</Button>
          <Button variant="primary" onClick={() => { setAdding(false); onOpenList(); }}>打开清单</Button>
        </>}>
          <p style={{ color: 'var(--sub)', lineHeight: 1.7 }}>
            卡片来自剧本里的人物与场景清单。在「## {kind === 'scene' ? '场景' : '人物'}」下面的表格里加一行（代号 | 名字 | 外形描述），保存后点刷新就有了。
          </p>
        </Modal>
      ) : null}
    </aside>
  );
}
