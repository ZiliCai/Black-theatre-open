import { useEffect, useState } from 'react';
import { api, type LlmPrices, type LlmUsage, type LlmUsageRow } from '../../api';
import { Button, TextInput, useToast } from '../../components';

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
const money = (row: LlmUsageRow, unit: string) => `${row.cost < 0.01 && row.cost > 0 ? row.cost.toFixed(4) : row.cost.toFixed(2)} ${unit}${row.unpriced ? `（${row.unpriced} 次没有单价）` : ''}`;
// the share of the input the prompt cache covered: what to watch after a change to how the prompts are put together
const hitRate = (row: LlmUsageRow) => (row.hit + row.miss ? `${Math.round((row.hit / (row.hit + row.miss)) * 100)}%` : '—');
const PRICE_COLS: { key: 'hit' | 'miss' | 'out'; label: string }[] = [
  { key: 'hit', label: '输入·缓存命中' }, { key: 'miss', label: '输入·缓存未命中' }, { key: 'out', label: '输出' },
];

// Tokens the language model has used, per day and model and per purpose, priced from an editable table
// (yuan per million tokens, off-peak and peak).
export function UsageCard() {
  const toast = useToast();
  const [usage, setUsage] = useState<LlmUsage | null>(null);
  const [draft, setDraft] = useState<LlmPrices | null>(null);
  const load = () => api.llmUsage().then((u) => { setUsage(u); setDraft(null); });
  useEffect(() => { load(); }, []);
  if (!usage) return null;
  const unit = usage.prices.currency;
  const prices = draft || usage.prices;
  const edit = (i: number, key: 'hit' | 'miss' | 'out', slot: 0 | 1, value: string) => {
    const models = prices.models.map((r, j) => (j === i ? { ...r, [key]: (slot === 0 ? [value, r[key][1]] : [r[key][0], value]) as unknown as [number, number] } : r));
    setDraft({ ...prices, models });
  };
  const save = async (next: LlmPrices | null) => {
    const r = await api.setLlmPrices(next);
    if (!r.ok) { toast(r.message || '保存失败', { tone: 'bad' }); return; }
    toast(next ? '单价已保存，费用按新单价重算' : '已恢复默认单价', { tone: 'ok' });
    load();
  };
  const row = (r: LlmUsageRow) => (
    <>
      <td className="n">{r.calls}</td><td className="n">{tokens(r.hit)}</td><td className="n">{tokens(r.miss)}</td><td className="n">{hitRate(r)}</td>
      <td className="n">{tokens(r.out)}{r.reasoning ? <span className="dim">（思考 {tokens(r.reasoning)}）</span> : null}</td>
      <td className="n">{money(r, unit)}</td>
    </>
  );
  return (
    <div className="card usage" id="llm-usage">
      <h3>大模型用量与费用<Button size="sm" variant="ghost" id="btn-usage-refresh" onClick={load}>刷新</Button></h3>
      <div className="gauges">
        {([['今天', usage.today], ['本月', usage.month], ['累计', usage.total]] as const).map(([k, r]) => (
          <div className="gauge" key={k}>
            <div className="k"><span>{k}</span><span>{r.calls} 次</span></div>
            <div className="v">{money(r, unit)}</div>
            <div className="note">输入 {tokens(r.hit + r.miss)}（缓存命中 {hitRate(r)}）· 输出 {tokens(r.out)}</div>
          </div>
        ))}
      </div>
      {usage.days.length ? (
        <>
          <div className="usage-table">
            <table>
              <thead><tr><th>日期</th><th>模型</th><th className="n">次数</th><th className="n">输入·命中</th><th className="n">输入·未命中</th><th className="n">命中率</th><th className="n">输出</th><th className="n">费用</th></tr></thead>
              <tbody>{usage.days.map((d) => <tr key={`${d.day}-${d.model}`}><td>{d.day}</td><td>{d.model}</td>{row(d)}</tr>)}</tbody>
            </table>
          </div>
          <div className="usage-table">
            <table>
              <thead><tr><th>用途</th><th className="n">次数</th><th className="n">输入·命中</th><th className="n">输入·未命中</th><th className="n">命中率</th><th className="n">输出</th><th className="n">费用</th></tr></thead>
              <tbody>{usage.purposes.map((p) => <tr key={p.purpose}><td>{p.purpose}</td>{row(p)}</tr>)}</tbody>
            </table>
          </div>
        </>
      ) : <p className="muted">还没有调用记录。从这一版起，每次调用大模型都会记下用量。</p>}
      <h3>单价（{unit} / 百万 tokens）</h3>
      <p className="muted">
        空闲时段按北京时间 {prices.offPeak.start}–{prices.offPeak.end} 计，其余为高峰时段；每次调用按发生的时段计价。
        模型名按设置里填的名字对应（也认带版本后缀的名字，比如 deepseek-v4-pro-0813）。
      </p>
      <div className="usage-table">
        <table>
          <thead>
            <tr><th rowSpan={2}>模型</th>{PRICE_COLS.map((c) => <th key={c.key} colSpan={2}>{c.label}</th>)}</tr>
            <tr>{PRICE_COLS.map((c) => [<th key={`${c.key}0`}>空闲</th>, <th key={`${c.key}1`}>高峰</th>])}</tr>
          </thead>
          <tbody>
            {prices.models.map((r, i) => (
              <tr key={r.model}>
                <td>{r.model}</td>
                {PRICE_COLS.map((c) => ([0, 1] as const).map((slot) => (
                  <td key={`${c.key}${slot}`}>
                    <TextInput small className="price" value={String(r[c.key][slot])} onChange={(e) => edit(i, c.key, slot, e.target.value)} />
                  </td>
                )))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <Button variant="primary" id="btn-prices-save" disabled={!draft} onClick={() => save(draft)}>保存单价</Button>
        <Button variant="ghost" id="btn-prices-reset" onClick={() => save(null)}>恢复默认</Button>
      </div>
    </div>
  );
}
