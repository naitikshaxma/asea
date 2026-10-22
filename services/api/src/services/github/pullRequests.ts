import { z } from 'zod';
import { TaskSubmissionRequestSchema, type TaskSubmissionRequest } from '@autonomous-engineer/contracts';

// The parts of a GitHub `pull_request` webhook payload a verification needs.
// Everything in it (title, body, refs) is untrusted text from the PR author.

export const PullRequestEventSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable().optional(),
    html_url: z.string().optional(),
    user: z.object({ login: z.string(), type: z.string().optional() }).optional(),
    labels: z.array(z.object({ name: z.string() })).optional(),
    base: z.object({ sha: z.string(), ref: z.string() }),
    head: z.object({ sha: z.string(), ref: z.string() }),
  }),
  repository: z.object({ full_name: z.string() }),
});
export type PullRequestEvent = z.infer<typeof PullRequestEventSchema>;

// Actions that put new code in front of reviewers; others (closed, labeled, ...) are ignored
export const VERIFIED_ACTIONS: ReadonlySet<string> = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

// A PR labelled like this, or opened by a bot account, is verified as AI-authored
export const AI_LABELS: ReadonlySet<string> = new Set(['ai-generated', 'ai', 'copilot', 'agent']);

/** The VERIFICATION task for one pull request event in one connected repository. */
export function pullRequestToTask(event: PullRequestEvent, deliveryId: string, repositoryId: string): TaskSubmissionRequest {
  const pr = event.pull_request;
  const title = pr.title.trim() || `Pull request #${pr.number}`;
  // The PR title and description are the requirement the change is verified against
  let requirement = [title, (pr.body ?? '').trim()].filter(Boolean).join('\n\n').slice(0, 5000);
  if (requirement.length < 10) requirement = `${requirement} (pull request #${pr.number})`;
  const aiAuthored = pr.user?.type === 'Bot' || (pr.labels ?? []).some((l) => AI_LABELS.has(l.name.toLowerCase()));
  return TaskSubmissionRequestSchema.parse({
    title: `PR #${pr.number}: ${title}`.slice(0, 200),
    description: requirement,
    taskType: 'VERIFICATION',
    repositoryId,
    idempotencyKey: `github:${deliveryId}:${repositoryId}`.slice(0, 128),
    verification: { baseSha: pr.base.sha, headSha: pr.head.sha, authorType: aiAuthored ? 'AI' : 'HUMAN' },
  });
}
