import { useEffect, useState, type InputHTMLAttributes } from 'react';
import type { ShotValues, TemplateForm } from '../../api';
import { Button, Field, Icon, Segmented, Select, TextInput } from '../../components';
import { WorkflowMath } from '../../legacy';

type Lora = { value: string; label: string };

// Keeps what is typed ("5." on the way to "5.9") and reports a number only once the text is one.
function NumberInput({ value, onValue, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: number | null | undefined; onValue: (n: number) => void; small?: boolean;
}) {
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : '');
  useEffect(() => {
    if (Number(text) !== value) setText(Number.isFinite(value) ? String(value) : '');
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <TextInput {...rest} type="text" inputMode="decimal" value={text} onChange={(e) => {
      setText(e.target.value);
      const n = Number(e.target.value);
      if (e.target.value.trim() !== '' && Number.isFinite(n)) onValue(n);
    }} />
  );
}

// Only the controls the template really has. Every change goes straight to onChange; the page saves it.
export function ParamsFields({ form, values, loras, onChange }: {
  form: TemplateForm; values: ShotValues; loras: Lora[]; onChange: (patch: Partial<ShotValues>) => void;
}) {
  const aspect = form.aspects.find((a) => a.id === values.aspect) || form.aspects[0];
  const dims = aspect ? WorkflowMath.dimensions(aspect, Number(values.megapixels) || 1) : null;
  const maxLoras = Number(form.limits.maxLoras || 0);
  return (
    <>
      <div className="grid2">
        <Field label="时长（秒）" hint={`${form.limits.durationMin}–${form.limits.durationMax}`}>
          <NumberInput id="p-duration" value={values.duration} onValue={(duration) => onChange({ duration })} />
        </Field>
        <Field label="画幅"><Select id="p-aspect" value={values.aspect} onChange={(e) => onChange({ aspect: e.target.value })}>
          {form.aspects.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </Select></Field>
        <Field label="清晰度" hint={dims ? <span className="num">{dims.width}×{dims.height} · {WorkflowMath.resolutionTier(dims.width, dims.height)}</span> : null}>
          <NumberInput id="p-megapixels" value={values.megapixels} onValue={(megapixels) => onChange({ megapixels })} title="百万像素" />
        </Field>
        <Field label="步数"><NumberInput id="p-steps" value={values.steps} onValue={(steps) => onChange({ steps })} /></Field>
      </div>
      <Field label="种子">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Segmented options={[{ value: 'random', label: '每次随机' }, { value: 'fixed', label: '固定' }]} value={values.seedMode}
            onChange={(seedMode) => onChange({ seedMode, seed: seedMode === 'fixed' ? values.seed ?? 1 : values.seed })} />
          {values.seedMode === 'fixed' ? <NumberInput small value={values.seed} style={{ flex: 1 }} onValue={(seed) => onChange({ seed })} /> : null}
        </div>
      </Field>
      {form.capabilities.turbo ? (
        <Field label="Turbo 加速">
          <div style={{ display: 'flex', gap: 8 }}>
            <Segmented options={[{ value: 'on', label: '开' }, { value: 'off', label: '关' }]} value={values.turboEnabled ? 'on' : 'off'}
              onChange={(v) => onChange({ turboEnabled: v === 'on' })} />
            <Select small disabled={!values.turboEnabled} value={values.turboModel || ''} onChange={(e) => {
              const m = form.turboModels.find((t) => t.value === e.target.value);
              onChange({ turboModel: e.target.value, ...(m ? { steps: m.steps } : {}) });
            }}>{form.turboModels.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select>
          </div>
        </Field>
      ) : null}
      {form.capabilities.loraChain ? (
        <Field label="LoRA" hint={`最多 ${maxLoras} 个`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(values.loras || []).map((l, i) => (
              <div className="lora-row" key={i}>
                <Select small value={l.name} onChange={(e) => onChange({ loras: values.loras.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}>
                  {[...(loras.some((o) => o.value === l.name) ? [] : [{ value: l.name, label: `${l.name}（未找到）` }]), ...loras].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
                <NumberInput small value={l.strength} title="强度 0–2"
                  onValue={(strength) => onChange({ loras: values.loras.map((x, j) => (j === i ? { ...x, strength } : x)) })} />
                <Button size="sm" variant="ghost" title="移除" onClick={() => onChange({ loras: values.loras.filter((_, j) => j !== i) })}><Icon name="x" size={14} /></Button>
              </div>
            ))}
            {(values.loras || []).length < maxLoras && loras.length ? (
              <Button size="sm" variant="ghost" onClick={() => onChange({ loras: [...(values.loras || []), { name: loras[0].value, strength: 1 }] })}><Icon name="plus" size={14} />添加 LoRA</Button>
            ) : null}
          </div>
        </Field>
      ) : null}
    </>
  );
}
