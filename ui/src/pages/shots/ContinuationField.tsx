import { mediaUrl, type ContinuationChoice, type ShotDetail } from '../../api';
import { Select } from '../../components';
import { shotNo } from './time';

const same = (a: ContinuationChoice, b: ContinuationChoice) => JSON.stringify(a) === JSON.stringify(b);

// 不接 / 接上一镜 / 接其他镜头: the user picks a shot, never a clip file.
export function ContinuationField({ detail, onChange }: { detail: ShotDetail; onChange: (c: ContinuationChoice) => void }) {
  const { supported, choice, resolved, options } = detail.continuation;
  const at = Math.max(0, options.findIndex((o) => same(o.choice, choice)));
  const from = resolved.ok && resolved.enabled ? resolved.from : null;
  const sourceShot = from && from.shotId ? String(from.shotId) : '';
  return (
    <div className={supported ? '' : 'disabled'}>
      <Select id="continuation" disabled={!supported} value={String(at)} onChange={(e) => onChange(options[Number(e.target.value)].choice)}>
        {options.map((o, i) => <option key={o.label} value={i}>{o.label}</option>)}
      </Select>
      {!supported ? <p className="note" style={{ marginTop: 8 }}>当前模板不支持接续，可换成「文武双全 · 接续版」</p> : null}
      {supported && !resolved.ok ? <p className="note warn" id="continuation-problem" style={{ marginTop: 8 }}>{resolved.message}</p> : null}
      {supported && resolved.ok && resolved.enabled ? (
        <div className="cont-src" id="continuation-source" style={{ marginTop: 8 }}>
          <img src={mediaUrl('project', resolved.clip.replace(/ \[output]$/, ''))} alt="" />
          <span>{from && from.legacy ? `旧版保留 · 分镜 ${from.legacy}` : `接 镜头 ${shotNo(sourceShot)} 的选中`}</span>
        </div>
      ) : null}
    </div>
  );
}
