'use client';
import { Fragment, useState } from 'react';
import { IAM_ACTION_LABELS, IAM_RESOURCES, PRIVILEGED_PERMISSIONS } from '@gutad/shared';
import { api } from '@/lib/api';
import { useAction, useSession } from '@/lib/hooks';
import { Alert, Button, Spinner } from '@/components/ui';
import { askReason } from '@/components/admin-ui';
import { Notice, SUPERADMIN, useRoles, useStepUp } from './common';

const GROUPS = ['Modules', 'Sensitive data'] as const;

export function MatrixTab({ onChange }: { onChange: () => void }) {
  const { can } = useSession();
  const manage = can('security.manage');
  const { data: roles, reload } = useRoles();
  const withStepUp = useStepUp();
  const { run, error, busy } = useAction();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  if (!roles) return <Spinner />;
  const key = (roleId: string, perm: string) => `${roleId}|${perm}`;
  const value = (roleId: string, perm: string, base: boolean) => (key(roleId, perm) in pending ? pending[key(roleId, perm)] : base);
  const toggle = (roleId: string, perm: string, base: boolean) => {
    const k = key(roleId, perm);
    const next = { ...pending };
    const v = !value(roleId, perm, base);
    if (v === base) delete next[k];
    else next[k] = v;
    setPending(next);
  };
  const count = Object.keys(pending).length;
  const save = () => {
    const reason = askReason(`changing ${count} permission(s)`);
    if (!reason) return;
    const changes = Object.entries(pending).map(([k, granted]) => { const [roleId, permission] = k.split('|'); return { roleId, permission, granted }; });
    void run(async () => {
      const res = await withStepUp((stepUp) => api.put<{ roles: { roleId: string; result: { status?: string } }[] }>('/admin/iam/matrix', { changes, reason, stepUp }));
      const waiting = res.roles.filter((r) => r.result?.status === 'PENDING_APPROVAL').map((r) => roles.find((x) => x.id === r.roleId)?.name || r.roleId);
      const applied = res.roles.length - waiting.length;
      setPending({});
      setNotice(waiting.length ? `Sent for approval: privileged changes to ${waiting.join(', ')}. A second superadmin must approve them in Admin → Approvals before they apply.${applied ? ` ${applied} other role(s) saved.` : ''}` : `Saved changes to ${applied} role(s).`);
      await reload();
      onChange();
    });
  };
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Notice text={notice} onClose={() => setNotice(null)} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-500">Tick what each role may do. Changed cells are highlighted until saved. Permissions marked <span className="font-semibold text-red-700">●</span> are privileged. Superadmin always has everything.</p>
        {manage && <div className="flex gap-2"><Button variant="ghost" disabled={!count || busy} onClick={() => setPending({})}>Discard</Button><Button disabled={!count || busy} onClick={save}>Save {count} change{count === 1 ? '' : 's'}</Button></div>}
      </div>
      <div className="max-h-[70vh] overflow-auto rounded-xl border border-ink-100">
        <table className="text-xs">
          <thead className="sticky top-0 z-20 bg-ink-50 text-ink-500">
            <tr>
              <th className="sticky left-0 z-30 min-w-[220px] bg-ink-50 px-3 py-2 text-left font-medium">Permission</th>
              {roles.map((r) => <th key={r.id} className="min-w-[84px] px-2 py-2 text-center align-bottom font-medium" title={r.description}>{r.name}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100 bg-white">
            {GROUPS.map((g) => (
              <Fragment key={g}>
                <tr><td className="sticky left-0 z-10 bg-ink-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-700">{g}</td><td colSpan={roles.length} className="bg-ink-100" /></tr>
                {IAM_RESOURCES.filter((res) => res.group === g).map((res) => (
                  <Fragment key={res.key}>
                    <tr><td className="sticky left-0 z-10 bg-ink-50 px-3 py-1 font-semibold text-ink-900" title={res.description}>{res.label}</td><td colSpan={roles.length} className="bg-ink-50" /></tr>
                    {res.actions.map((a) => {
                      const perm = `${res.key}:${a}`;
                      return (
                        <tr key={perm} className="hover:bg-ink-50/60">
                          <td className="sticky left-0 z-10 bg-white px-3 py-1 pl-6">{IAM_ACTION_LABELS[a]}{PRIVILEGED_PERMISSIONS.includes(perm) && <span className="ml-1 text-red-700" title="Privileged">●</span>}</td>
                          {roles.map((r) => {
                            const admin = r.key === SUPERADMIN;
                            const base = admin || r.permissions.includes(perm);
                            const dirty = key(r.id, perm) in pending;
                            return (
                              <td key={r.id} className={`px-2 py-1 text-center ${dirty ? 'bg-amber-100' : ''}`}>
                                <input type="checkbox" aria-label={`${r.name} ${perm}`} checked={admin || value(r.id, perm, base)} disabled={admin || !manage} onChange={() => toggle(r.id, perm, base)} />
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
