import { z } from 'zod';
import { IsoTimestampSchema, RequestIdSchema } from './request.js';

export const FileCategoryEnum = z.enum([
  'SOURCE',
  'TEST',
  'CONFIG',
  'DOCUMENTATION',
  'INFRASTRUCTURE',
  'UNKNOWN',
]);
export type FileCategory = z.infer<typeof FileCategoryEnum>;

export const FileInventoryItemSchema = z.object({
  path: z.string(),
  extension: z.string(),
  language: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  category: FileCategoryEnum,
  skippedReason: z.string().optional(),
});
export type FileInventoryItem = z.infer<typeof FileInventoryItemSchema>;

export const TechnologyCategoryEnum = z.enum([
  'LANGUAGE',
  'FRAMEWORK',
  'DATABASE',
  'BUILD_TOOL',
  'TEST_RUNNER',
  'CONTAINER',
  'INFRASTRUCTURE',
]);
export type TechnologyCategory = z.infer<typeof TechnologyCategoryEnum>;

export const TechnologyFindingSchema = z.object({
  name: z.string(),
  category: TechnologyCategoryEnum,
  version: z.string().optional(),
  confidence: z.number().min(0).max(1),
  evidenceFiles: z.array(z.string()),
  rationale: z.string(),
});
export type TechnologyFinding = z.infer<typeof TechnologyFindingSchema>;

export const KeyModuleSchema = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string(),
  fileCount: z.number().int().nonnegative(),
});
export type KeyModule = z.infer<typeof KeyModuleSchema>;

export const ApiRouteLocationSchema = z.object({
  path: z.string(),
  method: z.string().optional(),
  handlerFile: z.string(),
  framework: z.string().optional(),
});
export type ApiRouteLocation = z.infer<typeof ApiRouteLocationSchema>;

export const FileRelationshipSchema = z.object({
  sourceFile: z.string(),
  targetFile: z.string(),
  relationshipType: z.enum(['IMPORTS', 'CALLS', 'TESTS', 'CONFIGURES']),
  evidence: z.string().optional(),
});
export type FileRelationship = z.infer<typeof FileRelationshipSchema>;

export const ArchitectureSummarySchema = z.object({
  repositoryOverview: z.string(),
  entryPoints: z.array(z.string()),
  keyModules: z.array(KeyModuleSchema),
  apiRoutes: z.array(ApiRouteLocationSchema),
  serviceLocations: z.array(z.string()),
  modelLocations: z.array(z.string()),
  testFrameworks: z.array(z.string()),
  testLocations: z.array(z.string()),
  configurationLocations: z.array(z.string()),
  relationships: z.array(FileRelationshipSchema).default([]),
  limitations: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type ArchitectureSummary = z.infer<typeof ArchitectureSummarySchema>;

export const AnalysisStatisticsSchema = z.object({
  totalFiles: z.number().int().nonnegative(),
  eligibleFiles: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  binaryFilesSkipped: z.number().int().nonnegative(),
  secretFilesExcluded: z.number().int().nonnegative(),
});
export type AnalysisStatistics = z.infer<typeof AnalysisStatisticsSchema>;

export const AnalysisStatusEnum = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']);
export type AnalysisStatus = z.infer<typeof AnalysisStatusEnum>;

export const RepositoryAnalysisResponseSchema = z.object({
  id: RequestIdSchema,
  repositoryId: RequestIdSchema,
  workspaceId: RequestIdSchema,
  status: AnalysisStatusEnum,
  analyzerVersion: z.string(),
  summary: ArchitectureSummarySchema.nullable(),
  technologies: z.array(TechnologyFindingSchema),
  statistics: AnalysisStatisticsSchema.nullable(),
  errorSummary: z.string().nullable(),
  startedAt: IsoTimestampSchema.nullable(),
  completedAt: IsoTimestampSchema.nullable(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type RepositoryAnalysisResponse = z.infer<typeof RepositoryAnalysisResponseSchema>;

export const AnalysisFileListResponseSchema = z.object({
  analysisId: RequestIdSchema,
  repositoryId: RequestIdSchema,
  files: z.array(FileInventoryItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type AnalysisFileListResponse = z.infer<typeof AnalysisFileListResponseSchema>;

export const RelevantFileResultSchema = z.object({
  path: z.string(),
  score: z.number().min(0).max(100),
  category: FileCategoryEnum,
  reason: z.string(),
  evidence: z.array(z.string()),
  suggestedAction: z.string().optional(),
});
export type RelevantFileResult = z.infer<typeof RelevantFileResultSchema>;

export const TaskRelevantFilesRequestSchema = z.object({
  taskDescription: z
    .string()
    .min(3, 'Task description must be at least 3 characters')
    .max(2000, 'Task description too long'),
  limit: z.number().int().min(1).max(50).default(10),
});
export type TaskRelevantFilesRequest = z.infer<typeof TaskRelevantFilesRequestSchema>;

export const TaskRelevantFilesResponseSchema = z.object({
  repositoryId: RequestIdSchema,
  workspaceId: RequestIdSchema,
  query: z.string(),
  totalAnalyzed: z.number().int().nonnegative(),
  results: z.array(RelevantFileResultSchema),
  limitations: z.array(z.string()),
});
export type TaskRelevantFilesResponse = z.infer<typeof TaskRelevantFilesResponseSchema>;
