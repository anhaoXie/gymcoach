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
  // SHAs of the PR's commits, to resolve a short SHA named in a verdict.
  commitShas: string[];
  workflowRuns: { head_sha: string; run_attempt: number; event: string }[];
  checkRuns: { name: string; conclusion: string | null; completed_at: string | null }[];
  reviews: {
    user: { login: string; type?: string } | null;
    state: string;
    commit_id: string | null;
    submitted_at: string | null;
  }[];
  // Issue comments, read only to detect a posted review verdict.
  comments: {
    user: { login: string; type?: string } | null;
    body: string | null;
    created_at: string;
  }[];
}

// An issue or PR from the repository, read only for references to a PR.
export interface RawItem {
  number: number;
  isPull: boolean;
  title: string;
  body: string | null;
  created_at: string;
  labels: string[];
  // For a PR: true when it was closed without merging. Always false for issues.
  closedUnmerged: boolean;
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
// A posted verdict is a maintainer comment that names a verdict AND the head
// it reviewed ("head `<sha>`"), the shape every loop verdict uses. A comment
// that only mentions the word is not a verdict.
const VERDICT = /\bverdict\b/i;
const VERDICT_HEAD = /\bhead\s+`([0-9a-f]{7,40})`/i;
// Checks whose conclusion settles nothing about the head's health.
const NOT_DECISIVE = new Set(['skipped', 'neutral']);

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A same-repository reference to the PR: a bare `#N`, or `owner/repo#N` for
// this repository. `#300` does not match `#30`, and `other/repo#30` is another
// repository's item.
export function references(text: string, prNumber: number, repo: string): boolean {
  const bare = new RegExp(`(?:^|[^\\w/.#-])#${prNumber}(?!\\d)`);
  const qualified = new RegExp(`(?:^|[^\\w/.-])${escapeRegExp(repo)}#${prNumber}(?!\\d)`, 'i');
  return bare.test(text) || qualified.test(text);
}

function reviewerClass(user: { login: string; type?: string }, maintainers: string[]) {
  if (user.type === 'Bot' || user.login.endsWith('[bot]')) return 'bot' as const;
  return maintainers.includes(user.login) ? ('maintainer' as const) : ('other-human' as const);
}

// Resolves the short SHA a verdict names against the PR's head and commits.
function resolveSha(short: string, candidates: string[]): string | null {
  const lower = short.toLowerCase();
  return candidates.find((c) => c.startsWith(lower)) ?? null;
}

// The head's CI outcome: null while a check runs or when no decisive check
// ran; skipped and neutral checks do not count either way.
function checksOutcome(conclusions: (string | null)[]): boolean | null {
  if (conclusions.some((c) => c === null)) return null;
  const decisive = conclusions.filter((c): c is string => !NOT_DECISIVE.has(c!));
  if (decisive.length === 0) return null;
  return decisive.every((c) => c === 'success');
}

// A follow-up worth counting: an issue filed as a bug or fix, or a fix PR that
// was not closed unmerged. Feature and chore issues that cite a PR are
// planned work, not a sign the PR needed fixing.
function isFixFollowUp(item: RawItem): boolean {
  const fixTitle = /^(?:fix|bug)\b/i.test(item.title);
  if (item.isPull) return fixTitle && !item.closedUnmerged;
  return fixTitle || item.labels.some((l) => l.toLowerCase() === 'bug');
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

  const shaCandidates = [pull.head.sha, ...detail.commitShas];
  const reviews: ReviewRecord[] = [
    ...detail.reviews
      .filter((r) => r.user && r.submitted_at)
      .map((r) => ({
        schemaVersion: SCHEMA_VERSION,
        runId,
        source: 'github-review' as const,
        reviewer: r.user!.login,
        reviewerClass: reviewerClass(r.user!, input.maintainers),
        commitSha: r.commit_id,
        state: r.state,
        submittedAt: iso(r.submitted_at!),
      })),
    ...detail.comments.flatMap((c) => {
      const body = c.body ?? '';
      const head = VERDICT_HEAD.exec(body);
      if (!c.user || !input.maintainers.includes(c.user.login)) return [];
      if (!VERDICT.test(body) || !head) return [];
      return [
        {
          schemaVersion: SCHEMA_VERSION,
          runId,
          source: 'verdict-comment' as const,
          reviewer: c.user.login,
          reviewerClass: reviewerClass(c.user, input.maintainers),
          commitSha: resolveSha(head[1]!, shaCandidates),
          state: 'commented',
          submittedAt: iso(c.created_at),
        },
      ];
    }),
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
          number: null,
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
      if (!references(text, pull.number, input.repo)) continue;
      const entry = {
        number: item.number,
        kind: item.isPull ? ('pr' as const) : ('issue' as const),
        sha: null,
        createdAt: iso(item.created_at),
      };
      if (item.isPull && /^revert\b/i.test(item.title)) {
        if (!item.closedUnmerged) reverts.push(entry);
      }
      // Heuristic: a bug/fix issue or a fix PR that cites the PR. Write-up,
      // docs, feature and chore items cite PRs without implying a defect.
      else if (isFixFollowUp(item)) followUps.push(entry);
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
        // Unknown unless a check actually ran on the head: a workflow run with
        // no check (e.g. a fork run awaiting approval) is not a CI attempt.
        ciRunAttemptsOnHead:
          headRuns.length === 0
            ? unknown('no CI workflow run recorded for the head SHA')
            : checks.length === 0
              ? unknown('a workflow run exists for the head SHA but no check ran on it')
              : count(Math.max(...headRuns.map((r) => r.run_attempt))),
        agentAttempts: unknown(NOT_RECORDED),
      },
      runner: {
        model: maintainer ? trailerModel(detail.commitMessages) : unknown('external author'),
        skillVersion: unknown(NOT_RECORDED),
      },
      verification: {
        headSha: pull.head.sha,
        checks,
        allChecksSucceeded: checksOutcome(checks.map((c) => c.conclusion)),
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
