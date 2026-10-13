import {
  SCHEMA_VERSION,
  type Measurement,
  type Observation,
  type ReviewRecord,
  type RunBundle,
  runBundleSchema,
  unknown,
} from '@/automation/records/schema';

// Pure builder: raw GitHub and git data in, versioned run records out. No
// network, clock or filesystem access here, so fixtures can test every rule.

export interface RawPull {
  number: number;
  user: { login: string };
  title: string;
  // Read only to find "Closes #n" and revert references; never stored.
  body: string | null;
  created_at: string;
  closed_at: string | null;
  merged_at: string | null;
  head: { sha: string };
  base: { sha: string };
  merge_commit_sha: string | null;
}

export interface RawPullDetail {
  pull: RawPull;
  // Commit messages, read only for the Claude Co-Authored-By trailer.
  commitMessages: string[];
  workflowRuns: { head_sha: string; run_attempt: number; event: string }[];
  checkRuns: { name: string; conclusion: string | null; completed_at: string | null }[];
  reviews: {
    user: { login: string } | null;
    state: string;
    commit_id: string | null;
    submitted_at: string | null;
  }[];
  // Issue comments, read only to detect a posted review verdict.
  comments: { user: { login: string } | null; body: string | null; created_at: string }[];
}

// An issue or PR from the repository, read only for references to a PR.
export interface RawItem {
  number: number;
  isPull: boolean;
  title: string;
  body: string | null;
  created_at: string;
}

export interface RawRevertCommit {
  sha: string;
  committedAt: string;
  revertedSha: string;
}

export interface VettedContributor {
  login: string;
  since: string;
}

export interface BuildInput {
  repo: string;
  now: string;
  windowDays: number;
  maintainers: string[];
  vetted: VettedContributor[];
  pulls: RawPullDetail[];
  items: RawItem[];
  revertCommits: RawRevertCommit[];
}

const NOT_RECORDED = 'not recorded per task by the current workflow';
const DAY_MS = 24 * 60 * 60 * 1000;

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
const CLAUDE_TRAILER = /^Co-Authored-By:\s*Claude\s+([^<\n]+?)\s*</im;
const VERDICT = /review verdict/i;

function iso(value: string): string {
  return new Date(value).toISOString();
}

export function linkedIssues(body: string | null): number[] {
  const out: number[] = [];
  for (const match of (body ?? '').matchAll(CLOSING)) {
    const n = Number(match[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function references(text: string, prNumber: number): boolean {
  return new RegExp(`#${prNumber}(?!\\d)`).test(text);
}

function trailerModel(messages: string[]): Observation {
  for (const message of [...messages].reverse()) {
    const match = CLAUDE_TRAILER.exec(message);
    if (match) {
      return {
        status: 'known',
        value: `Claude ${match[1]!.trim()}`,
        source: 'Co-Authored-By trailer of the last attributed commit',
      };
    }
  }
  return unknown('no model attribution on the PR commits');
}

export function classifyAuthor(detail: RawPullDetail, input: BuildInput) {
  const login = detail.pull.user.login;
  if (input.maintainers.includes(login)) {
    return detail.commitMessages.some((m) => CLAUDE_TRAILER.test(m))
      ? ('loop' as const)
      : ('maintainer-unattributed' as const);
  }
  const vetted = input.vetted.find((v) => v.login === login);
  if (vetted && new Date(detail.pull.created_at) >= new Date(vetted.since)) {
    return 'external-vetted' as const;
  }
  return 'external' as const;
}

function count(value: number): Measurement {
  return { status: 'known', value, unit: 'count' };
}

function buildOne(detail: RawPullDetail, input: BuildInput): RunBundle {
  const { pull } = detail;
  const authorClass = classifyAuthor(detail, input);
  const maintainer = authorClass === 'loop' || authorClass === 'maintainer-unattributed';
  const stage = pull.merged_at ? 'merged' : pull.closed_at ? 'closed-unmerged' : 'open';
  const runId = `${input.repo}#${pull.number}@${pull.head.sha.slice(0, 12)}`;
  const taskId = `${input.repo}#${pull.number}`;
  const issues = linkedIssues(pull.body);

  const headRuns = detail.workflowRuns.filter(
    (r) => r.head_sha === pull.head.sha && r.event === 'pull_request',
  );
  const checks = detail.checkRuns.map((c) => ({
    name: c.name,
    conclusion: c.conclusion,
    completedAt: c.completed_at ? iso(c.completed_at) : null,
  }));

  const closedAt = pull.merged_at ?? pull.closed_at;
  const prOpenDuration: Measurement = closedAt
    ? {
        status: 'known',
        value: Math.round((Date.parse(closedAt) - Date.parse(pull.created_at)) / 1000),
        unit: 'seconds',
      }
    : unknown('PR still open');

  const reviews: ReviewRecord[] = [
    ...detail.reviews
      .filter((r) => r.user && r.submitted_at)
      .map((r) => ({
        schemaVersion: SCHEMA_VERSION,
        runId,
        source: 'github-review' as const,
        reviewer: r.user!.login,
        commitSha: r.commit_id,
        state: r.state,
        submittedAt: iso(r.submitted_at!),
      })),
    ...detail.comments
      .filter(
        (c) => c.user && input.maintainers.includes(c.user.login) && VERDICT.test(c.body ?? ''),
      )
      .map((c) => ({
        schemaVersion: SCHEMA_VERSION,
        runId,
        source: 'verdict-comment' as const,
        reviewer: c.user!.login,
        commitSha: null,
        state: 'commented',
        submittedAt: iso(c.created_at),
      })),
  ];

  let windowEndsAt: string | null = null;
  let observationStatus: 'observing' | 'complete' | 'not-applicable' = 'not-applicable';
  const reverts: RunBundle['outcome']['reverts'] = [];
  const followUps: RunBundle['outcome']['followUps'] = [];
  if (pull.merged_at) {
    const mergedMs = Date.parse(pull.merged_at);
    const endMs = mergedMs + input.windowDays * DAY_MS;
    windowEndsAt = new Date(endMs).toISOString();
    observationStatus = Date.parse(input.now) < endMs ? 'observing' : 'complete';
    const inWindow = (at: string) => Date.parse(at) > mergedMs && Date.parse(at) <= endMs;

    for (const commit of input.revertCommits) {
      const target = commit.revertedSha;
      if (
        (target === pull.merge_commit_sha || target === pull.head.sha) &&
        inWindow(commit.committedAt)
      ) {
        reverts.push({
          number: pull.number,
          kind: 'commit',
          sha: commit.sha,
          createdAt: iso(commit.committedAt),
        });
      }
    }
    for (const item of input.items) {
      if (item.number === pull.number || issues.includes(item.number)) continue;
      if (!inWindow(item.created_at)) continue;
      const text = `${item.title}\n${item.body ?? ''}`;
      if (!references(text, pull.number)) continue;
      const entry = {
        number: item.number,
        kind: item.isPull ? ('pr' as const) : ('issue' as const),
        sha: null,
        createdAt: iso(item.created_at),
      };
      if (item.isPull && /^revert\b/i.test(item.title)) reverts.push(entry);
      // Heuristic: an issue referencing the PR, or a fix PR referencing it.
      // Write-up and docs PRs cite many PRs and are not follow-ups.
      else if (!item.isPull || /^fix\b/i.test(item.title)) followUps.push(entry);
    }
  }

  const bundle: RunBundle = {
    schemaVersion: SCHEMA_VERSION,
    task: {
      schemaVersion: SCHEMA_VERSION,
      taskId,
      source: {
        kind: issues.length > 0 ? 'issue' : maintainer ? 'maintainer-pr' : 'external-pr',
        linkedIssues: issues,
      },
      createdAt: iso(pull.created_at),
    },
    run: {
      schemaVersion: SCHEMA_VERSION,
      runId,
      taskId,
      prNumber: pull.number,
      author: { login: pull.user.login, class: authorClass },
      baseSha: pull.base.sha,
      headSha: pull.head.sha,
      mergeCommitSha: pull.merged_at ? pull.merge_commit_sha : null,
      stage,
      timestamps: {
        createdAt: iso(pull.created_at),
        closedAt: pull.closed_at ? iso(pull.closed_at) : null,
        mergedAt: pull.merged_at ? iso(pull.merged_at) : null,
      },
      attempts: {
        headCommits: count(detail.commitMessages.length),
        ciRunAttemptsOnHead:
          headRuns.length > 0
            ? count(Math.max(...headRuns.map((r) => r.run_attempt)))
            : unknown('no CI workflow run recorded for the head SHA'),
        agentAttempts: unknown(NOT_RECORDED),
      },
      runner: {
        model: maintainer ? trailerModel(detail.commitMessages) : unknown('external author'),
        skillVersion: unknown(NOT_RECORDED),
      },
      verification: {
        headSha: pull.head.sha,
        checks,
        allChecksSucceeded:
          checks.length === 0 ? null : checks.every((c) => c.conclusion === 'success'),
      },
      usage: {
        inputTokens: unknown(NOT_RECORDED),
        outputTokens: unknown(NOT_RECORDED),
        cacheReadTokens: unknown(NOT_RECORDED),
        costUsd: unknown(NOT_RECORDED),
        agentDuration: unknown(NOT_RECORDED),
      },
      prOpenDuration,
      humanInterventions: unknown(NOT_RECORDED),
    },
    reviews,
    outcome: {
      schemaVersion: SCHEMA_VERSION,
      runId,
      outcome: stage,
      observation: { windowDays: input.windowDays, windowEndsAt, status: observationStatus },
      reverts,
      followUps,
      localReviews: maintainer
        ? unknown('independent reviews ran as local subagents without a per-SHA record')
        : unknown('verdicts for external PRs are counted under reviews when posted'),
    },
  };
  return runBundleSchema.parse(bundle);
}

export function buildRunBundles(input: BuildInput): RunBundle[] {
  return input.pulls
    .map((detail) => buildOne(detail, input))
    .sort((a, b) => a.run.prNumber - b.run.prNumber);
}
