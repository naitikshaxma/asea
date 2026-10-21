import path from 'node:path';
import type {
  ArchitectureSummary,
  FileInventoryItem,
  RelevantFileResult,
} from '@autonomous-engineer/contracts';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'he',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'that',
  'the',
  'to',
  'was',
  'were',
  'will',
  'with',
  'the',
  'this',
  'should',
  'could',
  'would',
  'need',
  'needs',
  'make',
  'file',
  'files',
  'code',
  'fix',
  'add',
  'update',
  'change',
  'bug',
  'issue',
  'please',
  'want',
]);

/**
 * Tokenizes a task description into normalized keyword tokens and identifiers.
 */
export function extractTaskTokens(text: string): string[] {
  const tokens = new Set<string>();

  // Split on whitespace, punctuation, and camelCase
  const rawWords = text.split(/[\s,.;:!?/\\_()[\]{}'"<>+=`~@#$%^&*|]+/).filter(Boolean);

  for (const word of rawWords) {
    const lower = word.toLowerCase();
    if (lower.length >= 2 && !STOP_WORDS.has(lower)) {
      tokens.add(lower);

      // Split camelCase e.g. authMiddleware -> auth, middleware
      const camelParts = word.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ');
      if (camelParts.length > 1) {
        for (const cp of camelParts) {
          if (cp.length >= 2 && !STOP_WORDS.has(cp)) {
            tokens.add(cp);
          }
        }
      }
    }
  }

  return Array.from(tokens);
}

/**
 * Ranks repository files by relevance to a given task description.
 */
export function rankRelevantFiles(
  taskDescription: string,
  inventory: FileInventoryItem[],
  architecture: ArchitectureSummary,
  limit: number = 10
): RelevantFileResult[] {
  const tokens = extractTaskTokens(taskDescription);
  const eligibleFiles = inventory.filter((f) => !f.skippedReason);

  const scoredFiles: {
    item: FileInventoryItem;
    score: number;
    reasons: string[];
    evidence: string[];
    action?: string;
  }[] = [];

  for (const item of eligibleFiles) {
    let score = 0;
    const reasons: string[] = [];
    const evidence: string[] = [];
    const normalizedPath = item.path.replace(/\\/g, '/').toLowerCase();
    const basename = path.basename(normalizedPath);
    const ext = path.extname(normalizedPath);

    // 1. Direct Basename Matches (High Weight)
    for (const token of tokens) {
      if (basename.includes(token)) {
        score += 25;
        reasons.push(`Filename matches task keyword '${token}'`);
        evidence.push(`Basename '${basename}' matches '${token}'`);
      } else if (normalizedPath.includes(token)) {
        score += 12;
        reasons.push(`Path directory matches task keyword '${token}'`);
        evidence.push(`Path segment matches '${token}'`);
      }
    }

    // 2. Functional Role Relevance (applied if file has keyword match or is explicitly connected)
    if (reasons.length > 0) {
      if (architecture.serviceLocations.some((s) => s.toLowerCase() === normalizedPath)) {
        score += 8;
        evidence.push('Registered application service');
      }
      if (architecture.apiRoutes.some((r) => r.path.toLowerCase() === normalizedPath)) {
        score += 10;
        evidence.push('Registered API route handler');
      }
      if (architecture.modelLocations.some((m) => m.toLowerCase() === normalizedPath)) {
        score += 7;
        evidence.push('Domain model / database schema definition');
      }
      if (architecture.entryPoints.some((e) => e.toLowerCase() === normalizedPath)) {
        score += 5;
        evidence.push('Application entry point');
      }
    }

    // 3. Test Correlation Bonus
    for (const rel of architecture.relationships) {
      if (rel.relationshipType === 'TESTS') {
        if (rel.targetFile.toLowerCase() === normalizedPath && reasons.length > 0) {
          score += 8;
          evidence.push(`Covered by automated test '${rel.sourceFile}'`);
        } else if (rel.sourceFile.toLowerCase() === normalizedPath) {
          // If the test's target has keyword matches
          const targetHasMatch = tokens.some((t) => rel.targetFile.toLowerCase().includes(t));
          if (targetHasMatch || reasons.length > 0) {
            score += 6;
            evidence.push(`Tests module '${rel.targetFile}'`);
            if (reasons.length === 0) {
              reasons.push(`Test suite for matching module '${path.basename(rel.targetFile)}'`);
            }
          }
        }
      }
    }

    // 4. Category Weights (Only applied if file has keyword or relational relevance)
    if (reasons.length > 0) {
      if (item.category === 'SOURCE') {
        score += 12;
      } else if (item.category === 'TEST') {
        score += 4;
      } else if (item.category === 'CONFIG') {
        score += 3;
      }

      // Normalize score to maximum of 100
      const boundedScore = Math.min(Math.round(score), 100);

      let action = 'Inspect for relevant business logic or definitions';
      if (item.category === 'TEST') {
        action = 'Review regression test coverage for task scope';
      } else if (item.category === 'CONFIG') {
        action = 'Inspect environment or dependency settings';
      } else if (evidence.some((e) => e.includes('API route'))) {
        action = 'Review route signature and request validation';
      }

      scoredFiles.push({
        item,
        score: boundedScore,
        reasons: Array.from(new Set(reasons)),
        evidence: Array.from(new Set(evidence)),
        action,
      });
    }
  }

  // Sort by score descending
  scoredFiles.sort((a, b) => b.score - a.score);

  const finalLimit = Math.min(Math.max(limit, 1), 50);
  const results = scoredFiles.slice(0, finalLimit).map((s) => ({
    path: s.item.path.replace(/\\/g, '/'),
    score: s.score,
    category: s.item.category,
    reason: s.reasons.length > 0 ? s.reasons.join('; ') : 'Matched architectural relevance signals',
    evidence: s.evidence,
    suggestedAction: s.action,
  }));

  return results;
}
