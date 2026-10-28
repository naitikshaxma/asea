import { Router } from 'express';
import type { SystemStatusResponse, WorkspaceStatsResponse } from '@autonomous-engineer/contracts';
import { prisma } from '../services/prisma.js';
import { config } from '../config.js';
import { requireAuth, requireWorkspaceMembership } from '../middlewares/authMiddleware.js';
import { RUN_INCLUDE, formatRun } from './verification.js';
import { configuredSandboxProvider } from '../services/engineering/sandboxFactory.js';
import { unavailableSandboxProvider } from '../services/engineering/sandboxProvider.js';

export const statsRouter = Router({ mergeParams: true });

const ACTIVITY_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const countsBy = <K extends string>(rows: Array<{ _count: { _all: number } } & Record<K, string | null>>, key: K) =>
  Object.fromEntries(rows.filter((r) => r[key] !== null).map((r) => [r[key] as string, r._count._all]));

/** The dashboard's numbers, computed in the database in a fixed number of queries. */
statsRouter.get('/workspaces/:workspaceId/stats', requireAuth, requireWorkspaceMembership('MEMBER'), async (req, res, next) => {
  try {
    const workspaceId = req.params['workspaceId']!;
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const since = new Date(today.getTime() - (ACTIVITY_DAYS - 1) * DAY_MS);

    const [byStatus, byVerdict, average, bySeverity, perDay, recent] = await Promise.all([
      prisma.verificationRun.groupBy({ by: ['status'], where: { workspaceId }, _count: { _all: true } }),
      prisma.verificationRun.groupBy({ by: ['verdict'], where: { workspaceId, verdict: { not: null } }, _count: { _all: true } }),
      prisma.verificationRun.aggregate({ where: { workspaceId, score: { not: null } }, _avg: { score: true } }),
      prisma.verificationFinding.groupBy({ by: ['severity'], where: { verificationRun: { workspaceId } }, _count: { _all: true } }),
      prisma.$queryRaw<Array<{ day: Date; runs: number }>>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::int AS runs
        FROM "VerificationRun"
        WHERE "workspaceId" = ${workspaceId} AND "createdAt" >= ${since}
        GROUP BY 1 ORDER BY 1`,
      prisma.verificationRun.findMany({ where: { workspaceId }, include: RUN_INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5 }),
    ]);

    const runsOn = new Map(perDay.map((row) => [new Date(row.day).toISOString().slice(0, 10), Number(row.runs)]));
    const activity = Array.from({ length: ACTIVITY_DAYS }, (_, i) => {
      const date = new Date(since.getTime() + i * DAY_MS).toISOString().slice(0, 10);
      return { date, runs: runsOn.get(date) ?? 0 };
    });
    const statusCounts = countsBy(byStatus, 'status');

    const body: WorkspaceStatsResponse = {
      totalRuns: Object.values(statusCounts).reduce((a, b) => a + b, 0),
      byStatus: statusCounts,
      byVerdict: countsBy(byVerdict, 'verdict'),
      averageScore: average._avg.score === null ? null : Math.round(average._avg.score * 10) / 10,
      findingsBySeverity: countsBy(bySeverity, 'severity'),
      activity,
      recentRuns: recent.map(formatRun),
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});

/** How the server is wired: engine readiness (LLM provider, code index) and GitHub. */
statsRouter.get('/system/status', requireAuth, async (_req, res, next) => {
  try {
    let engine: SystemStatusResponse['engine'] = { status: 'down', llm: null, codeIndex: null };
    try {
      const ready = await fetch(new URL('/ready', config.AI_SERVICE_URL), { signal: AbortSignal.timeout(3000) });
      const json = (await ready.json()) as { dependencies?: Record<string, { status?: string; message?: string }> };
      const dependency = (name: string) => {
        const d = json.dependencies?.[name];
        return d ? { status: String(d.status ?? 'unknown'), message: d.message ?? null } : null;
      };
      engine = { status: ready.ok ? 'up' : 'down', llm: dependency('llm_provider'), codeIndex: dependency('code_index') };
    } catch {
      // The engine is unreachable; reported as down
    }
    let sandbox: SystemStatusResponse['sandbox'];
    try { sandbox = await configuredSandboxProvider().diagnose(); }
    catch { sandbox = await unavailableSandboxProvider.diagnose(); }
    const publicWebUrl = config.PUBLIC_WEB_URL.replace(/\/$/, '');
    const body: SystemStatusResponse = {
      engine,
      sandbox,
      github: { commentsEnabled: Boolean(config.GITHUB_TOKEN), apiUrl: config.GITHUB_API_URL },
      publicWebUrl,
      webhookUrl: `${publicWebUrl}/api/v1/webhooks/github`,
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});
