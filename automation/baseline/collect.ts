import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BuildInput,
  type RawItem,
  type RawPull,
  type RawPullDetail,
  type RawRevertCommit,
  type VettedContributor,
  buildRunBundles,
} from '@/automation/baseline/build';
import { renderReport } from '@/automation/baseline/report';

// Thin CLI around the pure builder. Read-only: it calls `gh api` GET
// endpoints and `git log`, never posts, and needs no model or paid service.
//
//   npx tsx automation/baseline/collect.ts --since 2026-08-14 --window-days 14 \
//     --out docs/loops/baseline/2026-10-13
//
// Uses the caller's gh authentication. Writes runs.jsonl, report.md and
// meta.json. Nothing private is written: no PR/issue bodies, comment text,
// commit messages or emails; those are read in memory for references only.

const REPO = 'gymcoach-app/gymcoach';
// Maintainer accounts, as listed in CLAUDE.md ("Security: untrusted input").
const MAINTAINERS = ['JulienAu', 'Julien-Au'];
const POLICY = 'docs/loops/10-external-contributions.md';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function gh<T>(path: string): T {
  const out = execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github+json', path], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as T;
}

function pages<T>(path: string, stop?: (item: T) => boolean): T[] {
  const out: T[] = [];
  for (let page = 1; ; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const batch = gh<T[]>(`${path}${sep}per_page=100&page=${page}`);
    for (const item of batch) {
      if (stop?.(item)) return out;
      out.push(item);
    }
    if (batch.length < 100) return out;
  }
}

export function parseVetted(policy: string): VettedContributor[] {
  const out: VettedContributor[] = [];
  for (const match of policy.matchAll(
    /^- `([^`]+)` - vetted by the operator (\d{4}-\d{2}-\d{2})/gm,
  )) {
    out.push({ login: match[1]!, since: `${match[2]}T00:00:00Z` });
  }
  return out;
}

export function parseRevertLog(log: string): RawRevertCommit[] {
  const out: RawRevertCommit[] = [];
  for (const record of log.split('\x1e')) {
    const [sha, committedAt, message] = record.trim().split('\x1f');
    if (!sha || !committedAt || !message) continue;
    for (const match of message.matchAll(/This reverts commit ([0-9a-f]{40})/g)) {
      out.push({ sha, committedAt, revertedSha: match[1]! });
    }
  }
  return out;
}

function main() {
  const since = new Date(arg('since')).toISOString();
  const windowDays = Number(arg('window-days', '14'));
  const outDir = arg('out');
  const now = new Date().toISOString();

  const pulls = pages<RawPull & { updated_at: string }>(
    `repos/${REPO}/pulls?state=all&sort=updated&direction=desc`,
    (p) => p.updated_at < since,
  ).filter((p) => p.created_at >= since || (p.closed_at ?? '') >= since || !p.closed_at);

  const details: RawPullDetail[] = pulls.map((pull) => {
    const sha = pull.head.sha;
    return {
      pull,
      commitMessages: pages<{ commit: { message: string } }>(
        `repos/${REPO}/pulls/${pull.number}/commits`,
      ).map((c) => c.commit.message),
      workflowRuns: gh<{ workflow_runs: RawPullDetail['workflowRuns'] }>(
        `repos/${REPO}/actions/runs?head_sha=${sha}&per_page=100`,
      ).workflow_runs,
      checkRuns: gh<{ check_runs: RawPullDetail['checkRuns'] }>(
        `repos/${REPO}/commits/${sha}/check-runs?per_page=100`,
      ).check_runs,
      reviews: pages<RawPullDetail['reviews'][number]>(
        `repos/${REPO}/pulls/${pull.number}/reviews`,
      ),
      comments: pages<RawPullDetail['comments'][number]>(
        `repos/${REPO}/issues/${pull.number}/comments`,
      ),
    };
  });

  const items: RawItem[] = pages<{
    number: number;
    title: string;
    body: string | null;
    created_at: string;
    pull_request?: unknown;
  }>(`repos/${REPO}/issues?state=all&since=${since}`).map((i) => ({
    number: i.number,
    isPull: i.pull_request !== undefined,
    title: i.title,
    body: i.body,
    created_at: i.created_at,
  }));

  const revertCommits = parseRevertLog(
    execFileSync(
      'git',
      [
        'log',
        'origin/main',
        `--since=${since}`,
        '--grep=This reverts commit',
        '--format=%H%x1f%cI%x1f%B%x1e',
      ],
      { encoding: 'utf8' },
    ),
  );

  const input: BuildInput = {
    repo: REPO,
    now,
    windowDays,
    maintainers: MAINTAINERS,
    vetted: parseVetted(readFileSync(POLICY, 'utf8')),
    pulls: details,
    items,
    revertCommits,
  };
  const bundles = buildRunBundles(input);
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const meta = { repo: REPO, collectedAt: now, sourceCommit, since, windowDays, schemaVersion: 1 };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'runs.jsonl'),
    bundles.map((b) => JSON.stringify(b)).join('\n') + '\n',
  );
  writeFileSync(join(outDir, 'report.md'), renderReport(bundles, meta));
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log(`Wrote ${bundles.length} runs to ${outDir}`);
}

if (process.argv[1]?.endsWith('collect.ts')) main();
