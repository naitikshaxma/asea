import React from 'react';
import { ShieldCheck, Lock, Terminal, Cpu, HardDrive, WifiOff } from 'lucide-react';

export const ExecutionPanel: React.FC = () => {
  const securityControls = [
    {
      name: 'Host Shell Execution',
      status: 'Disabled by Design',
      note: 'Phase 1 boundary prevents arbitrary shell calls on host system.',
      icon: Terminal,
      color: 'text-amber-400',
    },
    {
      name: 'Sandbox Isolation',
      status: 'Disposable OCI Container',
      note: 'Zero-trust ephemeral container per task scheduled for Phase 2.',
      icon: Lock,
      color: 'text-emerald-400',
    },
    {
      name: 'Resource Ceilings',
      status: 'Bounded Quotas',
      note: 'Enforces cgroup limits: 2 vCPU, 2GB RAM, 10GB disk limit.',
      icon: Cpu,
      color: 'text-cyan-400',
    },
    {
      name: 'Network Egress',
      status: 'Restricted Namespaces',
      note: 'No access to internal VPC, metadata services, or databases.',
      icon: WifiOff,
      color: 'text-purple-400',
    },
    {
      name: 'Filesystem Access',
      status: 'Ephemeral Copy-on-Write',
      note: 'Disposable volumes discarded after task verification.',
      icon: HardDrive,
      color: 'text-blue-400',
    },
    {
      name: 'Audit Trail',
      status: 'Full Stream Capture',
      note: 'Structured syscall tracing and stdout/stderr indexing.',
      icon: ShieldCheck,
      color: 'text-emerald-400',
    },
  ];

  return (
    <div className="p-6 rounded-xl bg-surface border border-surface-border">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Execution Worker &amp; Sandbox Boundary
          </h2>
          <p className="text-xs text-slate-400">
            Strict isolation guarantees for autonomous AI code verification.
          </p>
        </div>
        <span className="px-2.5 py-1 rounded-full text-xs font-mono font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          Enforced Boundary
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {securityControls.map((ctrl, i) => {
          const Icon = ctrl.icon;
          return (
            <div
              key={i}
              className="p-3.5 rounded-lg bg-surface-elevated/60 border border-surface-border/80 flex flex-col justify-between"
            >
              <div className="flex items-center space-x-2.5 mb-2">
                <Icon className={`w-4 h-4 ${ctrl.color}`} />
                <span className="text-xs font-semibold text-slate-200">{ctrl.name}</span>
              </div>
              <div className="text-[11px] font-mono text-slate-300 font-medium mb-1">
                {ctrl.status}
              </div>
              <p className="text-[11px] text-slate-400 leading-snug">{ctrl.note}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
};
