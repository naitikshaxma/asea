import React from 'react';
import { Layers, ShieldCheck, Cpu, Code2 } from 'lucide-react';

interface MetricsOverviewProps {
  taskCount: number;
  apiConnected: boolean;
}

export const MetricsOverview: React.FC<MetricsOverviewProps> = ({ taskCount, apiConnected }) => {
  const metrics = [
    {
      title: 'Registered Tasks',
      value: apiConnected ? taskCount.toString() : '—',
      label: 'Session task intake store',
      icon: Layers,
      color: 'text-primary-400',
      bgColor: 'bg-primary-500/10',
      borderColor: 'border-primary-500/20',
    },
    {
      title: 'Worker Boundary',
      value: 'Secured',
      label: 'Host shell execution disabled',
      icon: ShieldCheck,
      color: 'text-emerald-400',
      bgColor: 'bg-emerald-500/10',
      borderColor: 'border-emerald-500/20',
    },
    {
      title: 'AI Service Skeleton',
      value: 'FastAPI',
      label: 'Local mock provider ready',
      icon: Cpu,
      color: 'text-cyan-400',
      bgColor: 'bg-cyan-500/10',
      borderColor: 'border-cyan-500/20',
    },
    {
      title: 'Shared Contracts',
      value: 'v1 Active',
      label: 'Zod & Pydantic synchrony',
      icon: Code2,
      color: 'text-purple-400',
      bgColor: 'bg-purple-500/10',
      borderColor: 'border-purple-500/20',
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {metrics.map((m, idx) => {
        const Icon = m.icon;
        return (
          <div
            key={idx}
            className={`p-5 rounded-xl bg-surface border ${m.borderColor} flex flex-col justify-between hover:bg-surface-elevated/40 transition-colors`}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                {m.title}
              </span>
              <div className={`p-2 rounded-lg ${m.bgColor}`}>
                <Icon className={`w-4 h-4 ${m.color}`} />
              </div>
            </div>
            <div>
              <div className="text-2xl font-bold font-mono text-slate-100">{m.value}</div>
              <p className="text-xs text-slate-400 mt-1">{m.label}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
};
