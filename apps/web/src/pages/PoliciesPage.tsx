import { useState, type FormEvent } from 'react';
import { Plus, Scale, Star, Trash2 } from 'lucide-react';
import { DEFAULT_POLICY_CONFIG, PolicyConfigSchema, type PolicyConfig, type PolicyProfileResponse } from '@autonomous-engineer/contracts';
import { api, errorMessage } from '../api/client';
import { useSession, useWorkspaceId } from '../app/session';
import { useQuery } from '../hooks/useQuery';
import { relativeTime } from '../format';
import { Dialog } from '../ui/Dialog';
import { Badge, Button, Card, Field, Input, Mono, Select, Textarea } from '../ui/primitives';
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from '../ui/states';

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const CATEGORIES = [
  ['static', 'Static analysis'],
  ['negative_space', 'Missing from the change'],
  ['architecture', 'Architecture'],
  ['test_gap', 'Test gaps'],
] as const;

export function PoliciesPage() {
  const workspaceId = useWorkspaceId();
  const { workspace } = useSession();
  const isAdmin = workspace?.role === 'OWNER' || workspace?.role === 'ADMIN';
  const policies = useQuery(`policies:${workspaceId}`, () => api.policies(workspaceId));
  const [editing, setEditing] = useState<PolicyProfileResponse | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await policies.refetch();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Policies"
        description="How findings turn into a score and a verdict. Each run keeps the exact policy it was scored with, so editing a policy only affects new runs."
        actions={
          isAdmin && (
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>
              New policy
            </Button>
          )
        }
      />
      {error && (
        <p role="alert" className="mb-4 rounded-md border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {policies.error && !policies.data ? (
        <Card>
          <ErrorState error={policies.error} onRetry={() => void policies.refetch()} title="Could not load policies" />
        </Card>
      ) : !policies.data ? (
        <Card>
          <SkeletonRows rows={2} />
        </Card>
      ) : policies.data.policies.length === 0 ? (
        <Card>
          <EmptyState icon={<Scale className="h-5 w-5" />} title="No policies" />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {policies.data.policies.map((p) => (
            <Card key={p.id} className="flex flex-col">
              <div className="flex-1 space-y-3 p-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-semibold">{p.name}</h2>
                  {p.isDefault && (
                    <Badge tone="accent">
                      <Star className="h-3 w-3" /> Default
                    </Badge>
                  )}
                </div>
                {p.description && <p className="text-xs text-muted">{p.description}</p>}
                <PolicySummary config={p.config} />
                <div className="text-2xs text-subtle">
                  Hash <Mono className="text-2xs">{p.configHash.slice(0, 12)}</Mono> · updated {relativeTime(p.updatedAt)}
                </div>
              </div>
              {isAdmin && (
                <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
                  <Button size="sm" onClick={() => setEditing(p)}>
                    Edit
                  </Button>
                  {!p.isDefault && (
                    <>
                      <Button size="sm" onClick={() => void act(() => api.updatePolicy(workspaceId, p.id, { isDefault: true }))}>
                        Make default
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete ${p.name}`}
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        onClick={() => window.confirm(`Delete the policy "${p.name}"?`) && void act(() => api.deletePolicy(workspaceId, p.id))}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      {editing && (
        <PolicyEditor
          policy={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => (setEditing(null), void policies.refetch())}
        />
      )}
    </>
  );
}

function PolicySummary({ config }: { config: PolicyConfig }) {
  const b = config.verdict_bands;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
      <dt className="text-muted" title="critical / high / medium / low">Weights (crit/high/med/low)</dt>
      <dd className="tabular-nums">
        {SEVERITIES.map((s) => config.severity_weights[s]).join(' / ')}
      </dd>
      <dt className="text-muted">Agent findings</dt>
      <dd className="tabular-nums">×{config.source_multipliers.llm}</dd>
      <dt className="text-muted">Bands</dt>
      <dd className="tabular-nums">
        allow ≥{b.allow} · review ≥{b.review} · high ≥{b.high_risk}
      </dd>
      <dt className="text-muted">Caps</dt>
      <dd>{config.caps.length ? config.caps.map((c) => `${c.min_count}+ ${c.severity} → ≤${c.max_score}`).join(', ') : 'none'}</dd>
    </dl>
  );
}

function NumberField({ id, label, value, onChange, step = 1, min = 0, max }: { id: string; label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) {
  return (
    <Field label={label} htmlFor={id}>
      <Input id={id} type="number" inputMode="decimal" step={step} min={min} max={max} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} className="tabular-nums" />
    </Field>
  );
}

function PolicyEditor({ policy, onClose, onSaved }: { policy: PolicyProfileResponse | null; onClose: () => void; onSaved: () => void }) {
  const workspaceId = useWorkspaceId();
  const [name, setName] = useState(policy?.name ?? '');
  const [description, setDescription] = useState(policy?.description ?? '');
  const [config, setConfig] = useState<PolicyConfig>(structuredClone(policy?.config ?? DEFAULT_POLICY_CONFIG));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof PolicyConfig>(section: K, value: PolicyConfig[K]) => setConfig((c) => ({ ...c, [section]: value }));
  const validation = PolicyConfigSchema.safeParse(config);
  const problems = validation.success ? [] : validation.error.issues.map((i) => `${i.path.join('.') || 'policy'}: ${i.message}`);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!validation.success) return;
    setSaving(true);
    setError(null);
    try {
      if (policy) await api.updatePolicy(workspaceId, policy.id, { name, description, config: validation.data });
      else await api.createPolicy(workspaceId, { name, description: description || undefined, config: validation.data });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open size="lg" onClose={onClose} title={policy ? `Edit ${policy.name}` : 'New policy'} description="Every finding deducts weight × category multiplier × source multiplier from 100.">
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="policy-name" hint="Lowercase letters, digits, - and _">
            <Input id="policy-name" required value={name} onChange={(e) => setName(e.target.value)} pattern="[a-z0-9][a-z0-9_-]*" />
          </Field>
          <Field label="Description" htmlFor="policy-description">
            <Textarea id="policy-description" rows={1} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-subtle">Severity weights</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {SEVERITIES.map((s) => (
              <NumberField key={s} id={`weight-${s}`} label={s} value={config.severity_weights[s]} max={100} step={0.5} onChange={(v) => set('severity_weights', { ...config.severity_weights, [s]: v })} />
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-subtle">Multipliers</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {CATEGORIES.map(([key, label]) => (
              <NumberField key={key} id={`category-${key}`} label={label} value={config.category_multipliers[key]} max={10} step={0.1} onChange={(v) => set('category_multipliers', { ...config.category_multipliers, [key]: v })} />
            ))}
            <NumberField id="source-deterministic" label="Deterministic checks" value={config.source_multipliers.deterministic} max={10} step={0.1} onChange={(v) => set('source_multipliers', { ...config.source_multipliers, deterministic: v })} />
            <NumberField id="source-llm" label="AI agent findings" value={config.source_multipliers.llm} max={10} step={0.1} onChange={(v) => set('source_multipliers', { ...config.source_multipliers, llm: v })} />
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-subtle">Verdict bands (minimum score)</legend>
          <div className="grid grid-cols-3 gap-3">
            {(['allow', 'review', 'high_risk'] as const).map((band) => (
              <NumberField key={band} id={`band-${band}`} label={band.replace('_', ' ')} value={config.verdict_bands[band]} max={100} onChange={(v) => set('verdict_bands', { ...config.verdict_bands, [band]: v })} />
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted">Below the high-risk minimum the verdict is block.</p>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-subtle">Caps</legend>
          <div className="space-y-2">
            {config.caps.map((cap, i) => (
              <div key={i} className="grid grid-cols-[1fr_6rem_5rem_5rem_auto] items-end gap-2">
                <Field label="Id" htmlFor={`cap-id-${i}`}>
                  <Input id={`cap-id-${i}`} value={cap.id} onChange={(e) => set('caps', config.caps.map((c, j) => (j === i ? { ...c, id: e.target.value } : c)))} />
                </Field>
                <Field label="Severity" htmlFor={`cap-sev-${i}`}>
                  <Select id={`cap-sev-${i}`} value={cap.severity} onChange={(e) => set('caps', config.caps.map((c, j) => (j === i ? { ...c, severity: e.target.value as typeof c.severity } : c)))}>
                    {SEVERITIES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </Select>
                </Field>
                <NumberField id={`cap-min-${i}`} label="At least" value={cap.min_count} min={1} onChange={(v) => set('caps', config.caps.map((c, j) => (j === i ? { ...c, min_count: v } : c)))} />
                <NumberField id={`cap-max-${i}`} label="Score ≤" value={cap.max_score} max={100} onChange={(v) => set('caps', config.caps.map((c, j) => (j === i ? { ...c, max_score: v } : c)))} />
                <Button variant="ghost" size="sm" aria-label={`Remove cap ${cap.id}`} icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => set('caps', config.caps.filter((_, j) => j !== i))} />
              </div>
            ))}
            <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => set('caps', [...config.caps, { id: `cap_${config.caps.length + 1}`, severity: 'high', min_count: 1, max_score: 59 }])}>
              Add cap
            </Button>
          </div>
        </fieldset>
        {problems.length > 0 && (
          <ul role="alert" className="space-y-1 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-fg">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!validation.success || !name}>
            {policy ? 'Save changes' : 'Create policy'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
