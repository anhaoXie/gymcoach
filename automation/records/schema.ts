import { z } from 'zod';

// Versioned records for the maintainer's runs (roadmap milestone 1,
// docs/loops/11-autonomous-development-roadmap.md). A record describes what
// the autonomous maintainer did on one task; it is not application data and
// the app never imports this module.
//
// Rule: a value the current workflow does not record is `unknown` with a
// reason, never 0 and never omitted. Reports count unknowns explicitly.

export const SCHEMA_VERSION = 1 as const;

const reason = z.string().min(1);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const isoDate = z.string().datetime();

export const measurementUnits = ['tokens', 'usd', 'seconds', 'count'] as const;

// A numeric measurement: a known value with its unit, or unknown with why.
export const measurementSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('known'),
      value: z.number().finite().nonnegative(),
      unit: z.enum(measurementUnits),
    })
    .strict(),
  z.object({ status: z.literal('unknown'), reason }).strict(),
]);
export type Measurement = z.infer<typeof measurementSchema>;

// A non-numeric observation (model, skill version): known text plus where it
// was observed, or unknown with why.
export const observationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('known'), value: z.string().min(1), source: reason }).strict(),
  z.object({ status: z.literal('unknown'), reason }).strict(),
]);
export type Observation = z.infer<typeof observationSchema>;

export const authorClasses = [
  // Maintainer account and at least one commit carries a Claude
  // Co-Authored-By trailer: written with the coding agent.
  'loop',
  // Maintainer account without that trailer: a human or an untagged agent.
  'maintainer-unattributed',
  // External author on the human-granted vetted list at PR creation time.
  'external-vetted',
  'external',
] as const;

export const taskRecordSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    taskId: z.string().min(1),
    source: z
      .object({
        kind: z.enum(['issue', 'external-pr', 'maintainer-pr']),
        // Issues the PR declares it closes ("Closes #n"), in order.
        linkedIssues: z.array(z.number().int().positive()),
      })
      .strict(),
    createdAt: isoDate,
  })
  .strict();
export type TaskRecord = z.infer<typeof taskRecordSchema>;

export const checkResultSchema = z
  .object({
    name: z.string().min(1),
    // null while a check is still running.
    conclusion: z.string().min(1).nullable(),
    completedAt: isoDate.nullable(),
  })
  .strict();

export const runRecordSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    runId: z.string().min(1),
    taskId: z.string().min(1),
    prNumber: z.number().int().positive(),
    author: z.object({ login: z.string().min(1), class: z.enum(authorClasses) }).strict(),
    baseSha: sha,
    headSha: sha,
    mergeCommitSha: sha.nullable(),
    stage: z.enum(['open', 'merged', 'closed-unmerged']),
    timestamps: z
      .object({ createdAt: isoDate, closedAt: isoDate.nullable(), mergedAt: isoDate.nullable() })
      .strict(),
    attempts: z
      .object({
        // Commits on the PR branch (initial work plus fixups).
        headCommits: measurementSchema,
        // CI workflow run attempts on the final head SHA (1 = no rerun).
        ciRunAttemptsOnHead: measurementSchema,
        // Implementation attempts inside the agent session.
        agentAttempts: measurementSchema,
      })
      .strict(),
    runner: z.object({ model: observationSchema, skillVersion: observationSchema }).strict(),
    verification: z
      .object({
        headSha: sha,
        checks: z.array(checkResultSchema),
        // null when the outcome is not established: no decisive check ran on
        // the head, or a check is still running. Skipped and neutral checks
        // are not decisive. Absent evidence is never success.
        allChecksSucceeded: z.boolean().nullable(),
      })
      .strict(),
    usage: z
      .object({
        inputTokens: measurementSchema,
        outputTokens: measurementSchema,
        cacheReadTokens: measurementSchema,
        costUsd: measurementSchema,
        agentDuration: measurementSchema,
      })
      .strict(),
    // Wall-clock time from PR creation to merge or close.
    prOpenDuration: measurementSchema,
    humanInterventions: measurementSchema,
  })
  .strict();
export type RunRecord = z.infer<typeof runRecordSchema>;

export const reviewerClasses = [
  // A GitHub App or bot account (login ending in [bot]): automated output,
  // reported apart from human review.
  'bot',
  // A maintainer account (the loop posts its verdicts from it).
  'maintainer',
  'other-human',
] as const;

export const reviewRecordSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    runId: z.string().min(1),
    source: z.enum(['github-review', 'verdict-comment']),
    reviewer: z.string().min(1),
    reviewerClass: z.enum(reviewerClasses),
    // The commit the review was bound to: GitHub's commit_id for a review, or
    // the "head `<sha>`" a verdict comment names, resolved against the PR's
    // commits. null when neither is available.
    commitSha: sha.nullable(),
    state: z.string().min(1),
    submittedAt: isoDate,
  })
  .strict();
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;

export const linkedItemSchema = z
  .object({
    // The issue or PR number; null for a revert commit, which has no number.
    number: z.number().int().positive().nullable(),
    kind: z.enum(['issue', 'pr', 'commit']),
    // For a revert commit, the commit SHA; otherwise null.
    sha: sha.nullable(),
    createdAt: isoDate,
  })
  .strict();

export const outcomeRecordSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    runId: z.string().min(1),
    outcome: z.enum(['open', 'merged', 'closed-unmerged']),
    observation: z
      .object({
        windowDays: z.number().int().positive(),
        // null for a run that never merged: nothing shipped to observe.
        windowEndsAt: isoDate.nullable(),
        status: z.enum(['observing', 'complete', 'not-applicable']),
      })
      .strict(),
    reverts: z.array(linkedItemSchema),
    followUps: z.array(linkedItemSchema),
    // Reviews ran as local subagents in the current workflow and left no
    // per-SHA record; recorded reviews below are only those GitHub holds.
    localReviews: measurementSchema,
  })
  .strict();
export type OutcomeRecord = z.infer<typeof outcomeRecordSchema>;

// One line of runs.jsonl.
export const runBundleSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    task: taskRecordSchema,
    run: runRecordSchema,
    reviews: z.array(reviewRecordSchema),
    outcome: outcomeRecordSchema,
  })
  .strict();
export type RunBundle = z.infer<typeof runBundleSchema>;

export function unknown(why: string): Measurement & Observation {
  return { status: 'unknown', reason: why };
}
