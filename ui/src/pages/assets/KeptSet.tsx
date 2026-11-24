import { useState } from 'react';
import { mediaUrl, type CardDetail } from '../../api';
import { Button, Icon, Modal } from '../../components';

// The bottom row: the pictures kept in this card, the main one marked, and pictures named after the card that
// were made before there were cards.
export function KeptSet({ detail, selected, onSelect, onMain, onRelabel, onUnkeep, onAdopt }: {
  detail: CardDetail; selected: string;
  onSelect: (image: string) => void; onMain: (image: string) => void; onRelabel: (image: string, label: string) => void;
  onUnkeep: (image: string) => void; onAdopt: (relPath: string) => void;
}) {
  const [adopting, setAdopting] = useState(false);
  const { card, set, main, existing } = detail;
  return (
    <div className="kept" id="kept-set">
      <div className="kept-head">
        <b>{card.name || card.code} 的参考图</b>
        <span>· 共 {set.length} 张 · 做视频时从这里挑，主图会自动带上</span>
      </div>
      <div className={`kept-track ${card.kind}`}>
        {set.map((s) => (
          <div key={s.image} data-image={s.image} className={`kept-pic ${s.image === main ? 'main' : ''} ${s.image === selected ? 'on' : ''}`}
            onClick={() => onSelect(s.image)} title={s.usedBy.length ? `用在镜头 ${s.usedBy.join('、')}` : s.image}>
            <img src={mediaUrl('project', s.image)} alt="" loading="lazy" />
            {s.image === main ? <span className="badge">主图</span> : null}
            <span className="cap ellipsis" onDoubleClick={(e) => { e.stopPropagation(); onRelabel(s.image, s.label); }} title="双击改标签">{s.label}</span>
            <span className="tools">
              {s.image !== main ? <button title="设为主图" onClick={(e) => { e.stopPropagation(); onMain(s.image); }}><Icon name="star" size={13} /></button> : null}
              <button title="从卡里移出（不删除文件）" onClick={(e) => { e.stopPropagation(); onUnkeep(s.image); }}><Icon name="x" size={13} /></button>
            </span>
          </div>
        ))}
        <button className="kept-add" id="btn-existing" disabled={!existing.length} onClick={() => setAdopting(true)}
          title={existing.length ? '从已有图片中选择参考图' : `项目里没有找到以 ${card.code} 开头命名的图`}>
          <Icon name="folder" /><span>已有图片 {existing.length}</span>
        </button>
      </div>
      {adopting ? (
        <Modal title={`从已有图片中选择 · ${card.code}`} wide onClose={() => setAdopting(false)}>
          <p className="note" style={{ marginBottom: 12 }}>这些图的文件名以 {card.code} 开头。选择一张加入参考图。</p>
          <div className="pick-grid">
            {existing.map((e) => (
              <button key={e.relPath + e.source} onClick={() => { onAdopt(e.relPath); setAdopting(false); }}>
                {e.source === 'output' ? <img src={mediaUrl('project', e.image)} alt="" loading="lazy" /> : <span className="no-preview">项目里的图片<br />加入参考图后才能预览</span>}
                <span className="ellipsis">{e.label}{e.source !== 'output' ? `（项目 ${e.source}/）` : ''}</span>
              </button>
            ))}
          </div>
          <div style={{ marginTop: 12 }}><Button onClick={() => setAdopting(false)}>取消</Button></div>
        </Modal>
      ) : null}
    </div>
  );
}
