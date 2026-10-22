import type { RunReport } from '@autonomous-engineer/contracts';

// Markdown for the pull request comment that reports a verification. Finding
// titles, paths and the report summary can carry text from the change under
// review, so everything is escaped: no tables broken by "|", no raw HTML, no
// @mentions that would notify people, bounded length.

export const COMMENT_MARKER = '<!-- asea-verification -->';
const MAX_FINDINGS = 5;
const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const VERDICT_LABEL: Record<string, string> = {
  ALLOW: '✅ ALLOW',
  REVIEW: '🟡 REVIEW',
  HIGH_RISK: '🟠 HIGH RISK',
  BLOCK: '🔴 BLOCK',
};

export interface CommentRun {
  id: string;
  status: string;
  score: number | null;
  verdict: string | null;
  baseSha: string;
  headSha: string;
  auditHeadHash: string | null;
  policyName: string | null;
  findings: Array<{ severity: string; title: string; file: string; line: number; source: string }>;
  report: RunReport | null;
  error?: string | null;
}

/** Plain text that renders literally: no HTML, no mentions, no line breaks. */
export function escapeInline(text: string, max = 200): string {
  const cleaned = text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
    .replace(/@(?=[A-Za-z0-9-])/g, '@\u200b')
    .replace(/([\\`*_[\]|])/g, '\\$1');
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Text for inside a `code span` in a table cell: no backticks or line breaks, pipes escaped. */
export function escapeCode(text: string, max = 120): string {
  const cleaned = text.replace(/[`\r\n]/g, '').replace(/\|/g, '\\|');
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function formatPullRequestComment(run: CommentRun, webUrl: string): string {
  const link = `${webUrl.replace(/\/$/, '')}/runs/${run.id}`;
  const range = `\`${run.baseSha.slice(0, 7)}..${run.headSha.slice(0, 7)}\``;
  if (run.status !== 'COMPLETED' || run.score === null || !run.verdict) {
    return [
      COMMENT_MARKER,
      `## ⚠️ ASEA verification ${run.status === 'CANCELLED' ? 'was cancelled' : 'failed'}`,
      '',
      `The change ${range} could not be verified${run.error ? `: ${escapeInline(run.error, 300)}` : '.'}`,
      '',
      `[Open the run](${link})`,
    ].join('\n');
  }

  const counts = SEVERITY_ORDER.map((s) => [s, run.findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);
  const top = [...run.findings]
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.file.localeCompare(b.file) || a.line - b.line)
    .slice(0, MAX_FINDINGS);
  const lines = [
    COMMENT_MARKER,
    `## ASEA verification: ${VERDICT_LABEL[run.verdict] ?? run.verdict} · score ${run.score}/100`,
    '',
    `**${run.findings.length} finding${run.findings.length === 1 ? '' : 's'}**` +
      (counts.length ? ` (${counts.map(([s, n]) => `${n} ${s.toLowerCase()}`).join(', ')})` : '') +
      ` · change ${range}` +
      (run.policyName ? ` · policy \`${escapeCode(run.policyName, 64)}\`` : ''),
  ];
  if (top.length) {
    lines.push('', '| Severity | Finding | Location |', '|---|---|---|');
    for (const f of top) {
      const origin = f.source === 'LLM' ? ' _(agent)_' : '';
      lines.push(`| ${f.severity} | ${escapeInline(f.title, 160)}${origin} | \`${escapeCode(`${f.file}:${f.line}`)}\` |`);
    }
    if (run.findings.length > top.length) lines.push('', `…and ${run.findings.length - top.length} more.`);
  }
  if (run.report?.summary) {
    lines.push('', `> ${escapeInline(run.report.summary, 600)}`);
  }
  lines.push(
    '',
    `[View the full report](${link})` + (run.auditHeadHash ? ` · audit chain head \`${run.auditHeadHash.slice(0, 12)}\`` : '')
  );
  return lines.join('\n');
}
