import { describe, expect, it } from 'vitest';
import {
  type BuildInput,
  type RawItem,
  type RawPullDetail,
  buildRunBundles,
  linkedIssues,
  references,
} from './build';
import { renderReport, summarizeMeasurements } from './report';
import { parseRevertLog, parseVetted } from './collect';

const sha = (c: string) => c.repeat(40);

function detail(
  over: Partial<RawPullDetail['pull']> & { number: number },
  extra: Partial<RawPullDetail> = {},
): RawPullDetail {
  return {
    pull: {
      user: { login: 'JulienAu' },
      title: 'feat: something',
      body: null,
      created_at: '2026-09-01T10:00:00Z',
      closed_at: '2026-09-01T12:00:00Z',
      merged_at: '2026-09-01T12:00:00Z',
      head: { sha: sha('a') },
      base: { sha: sha('b') },
      merge_commit_sha: sha('c'),
      ...over,
    },
    commitMessages: ['feat: something\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'],
    commitShas: [over.head?.sha ?? sha('a')],
    workflowRuns: [{ head_sha: over.head?.sha ?? sha('a'), run_attempt: 1, event: 'pull_request' }],
    checkRuns: [
      {
        name: 'Lint, typecheck, unit tests',
        conclusion: 'success',
        completed_at: '2026-09-01T11:00:00Z',
      },
      {
        name: 'End to end (Playwright)',
        conclusion: 'success',
        completed_at: '2026-09-01T11:05:00Z',
      },
    ],
    reviews: [],
    comments: [],
    ...extra,
  };
}

function item(over: Partial<RawItem> & { number: number; title: string }): RawItem {
  return {
    isPull: false,
    body: null,
    created_at: '2026-09-04T00:00:00Z',
    labels: [],
    closedUnmerged: false,
    ...over,
  };
}

function input(over: Partial<BuildInput> = {}): BuildInput {
  return {
    repo: 'gymcoach-app/gymcoach',
    now: '2026-10-13T00:00:00Z',
    windowDays: 14,
    maintainers: ['JulienAu', 'Julien-Au'],
    vetted: [{ login: 'Retsumdk', since: '2026-10-07T00:00:00Z' }],
    pulls: [],
    items: [],
    revertCommits: [],
    ...over,
  };
}

const meta = {
  repo: 'gymcoach-app/gymcoach',
  collectedAt: '2026-10-13T00:00:00Z',
  sourceCommit: sha('d'),
  since: '2026-08-14T00:00:00Z',
  windowDays: 14,
};

describe('run bundle builder (roadmap milestone 1)', () => {
  it('traces one run from its task to the reviewed commit and its outcome', () => {
    const [bundle] = buildRunBundles(
      input({
        pulls: [
          detail(
            { number: 421, body: 'Closes #393' },
            {
              comments: [
                {
                  user: { login: 'JulienAu' },
                  body: '**Review verdict (head `aaaaaaa`): ready.**',
                  created_at: '2026-09-01T11:30:00Z',
                },
                // Not a maintainer.
                {
                  user: { login: 'someone' },
                  body: 'review verdict please, head `aaaaaaa`',
                  created_at: '2026-09-01T11:31:00Z',
                },
                // A maintainer mentioning a verdict without naming a head.
                {
                  user: { login: 'JulienAu' },
                  body: 'I will post the review verdict tomorrow.',
                  created_at: '2026-09-01T11:32:00Z',
                },
              ],
            },
          ),
        ],
      }),
    );
    expect(bundle!.task).toMatchObject({
      taskId: 'gymcoach-app/gymcoach#421',
      source: { kind: 'issue', linkedIssues: [393] },
    });
    expect(bundle!.run).toMatchObject({
      author: { class: 'loop' },
      headSha: sha('a'),
      baseSha: sha('b'),
      mergeCommitSha: sha('c'),
      stage: 'merged',
      runner: { model: { status: 'known', value: 'Claude Opus 5.5' } },
      verification: { headSha: sha('a'), allChecksSucceeded: true },
      prOpenDuration: { status: 'known', value: 7200, unit: 'seconds' },
    });
    // Only the maintainer's structural verdict counts, bound to the head it names.
    expect(bundle!.reviews).toEqual([
      expect.objectContaining({
        source: 'verdict-comment',
        reviewer: 'JulienAu',
        reviewerClass: 'maintainer',
        commitSha: sha('a'),
      }),
    ]);
    expect(renderReport([bundle!], meta)).toContain('Bound to the final head SHA: 1 of 1');
    expect(bundle!.outcome).toMatchObject({
      outcome: 'merged',
      observation: { status: 'complete' },
    });
  });

  it('keeps unknown cost unknown and reports it as unknown, not zero', () => {
    const bundles = buildRunBundles(
      input({ pulls: [detail({ number: 1 }), detail({ number: 2 })] }),
    );
    for (const b of bundles) {
      expect(b.run.usage.costUsd).toEqual({ status: 'unknown', reason: expect.any(String) });
      expect(b.run.usage.inputTokens.status).toBe('unknown');
      expect(b.run.humanInterventions.status).toBe('unknown');
    }
    expect(summarizeMeasurements(bundles.map((b) => b.run.usage.costUsd))).toMatchObject({
      known: 0,
      unknown: 2,
    });
    const report = renderReport(bundles, meta);
    expect(report).toContain('| Cost (USD) | 0 of 2 | 2 of 2');
    expect(report).toContain('No cost per successful task is reported');
  });

  it('marks a merged run still inside the observation window as observing', () => {
    const [recent, old] = buildRunBundles(
      input({
        pulls: [
          detail({
            number: 10,
            created_at: '2026-10-10T00:00:00Z',
            closed_at: '2026-10-10T01:00:00Z',
            merged_at: '2026-10-10T01:00:00Z',
          }),
          detail({ number: 11 }),
        ],
      }),
    );
    expect(recent!.outcome.observation).toEqual({
      windowDays: 14,
      windowEndsAt: '2026-10-24T01:00:00.000Z',
      status: 'observing',
    });
    expect(old!.outcome.observation.status).toBe('complete');
    expect(renderReport([recent!, old!], meta)).toContain(
      'complete for 1 of 2 merged runs; 1 still observing',
    );
  });

  it('lists a closed-unmerged run and an open one alongside merged runs', () => {
    const bundles = buildRunBundles(
      input({
        pulls: [
          detail({ number: 20 }),
          detail({
            number: 21,
            user: { login: 'stranger' },
            merged_at: null,
            merge_commit_sha: null,
          }),
          detail(
            { number: 22, closed_at: null, merged_at: null, merge_commit_sha: null },
            { workflowRuns: [], checkRuns: [] },
          ),
        ],
      }),
    );
    expect(bundles.map((b) => [b.run.prNumber, b.outcome.outcome])).toEqual([
      [20, 'merged'],
      [21, 'closed-unmerged'],
      [22, 'open'],
    ]);
    const [, closed, open] = bundles;
    expect(closed!.run.author.class).toBe('external');
    expect(closed!.run.mergeCommitSha).toBeNull();
    expect(closed!.outcome.observation.status).toBe('not-applicable');
    // No check on the head: absent evidence is not success.
    expect(open!.run.verification.allChecksSucceeded).toBeNull();
    expect(open!.run.attempts.ciRunAttemptsOnHead.status).toBe('unknown');
    expect(open!.run.prOpenDuration.status).toBe('unknown');
    const report = renderReport(bundles, meta);
    expect(report).toMatch(/\| merged \| 1 \|\n\| closed-unmerged \| 1 \|\n\| open \| 1 \|/);
    // An open run is named in the limits, since its outcome and CI can still change.
    expect(report).toContain(
      'PRs open at collection time are included at their head of that moment',
    );
    expect(report).toMatch(/open at collection time[^\n]*: 1 \(#\d+\)/);
  });

  it('links a revert commit and a revert PR back to the originating run', () => {
    const [origin, other] = buildRunBundles(
      input({
        pulls: [
          detail({ number: 30, merge_commit_sha: sha('e') }),
          detail({ number: 31, merge_commit_sha: sha('f') }),
        ],
        revertCommits: [
          { sha: sha('9'), committedAt: '2026-09-03T00:00:00Z', revertedSha: sha('e') },
        ],
        items: [
          item({
            number: 32,
            isPull: true,
            title: 'Revert "feat: something"',
            body: 'Reverts gymcoach-app/gymcoach#30',
            created_at: '2026-09-02T00:00:00Z',
          }),
          item({ number: 33, title: 'bug after #30' }),
          // A write-up PR cites many PRs and is not a follow-up.
          item({ number: 34, isPull: true, title: 'docs: write up #30 and #31' }),
          // #300 must not match #30.
          item({ number: 35, title: 'fix: unrelated #300' }),
          // Outside the 14-day window.
          item({ number: 36, title: 'fix: late #30', created_at: '2026-10-01T00:00:00Z' }),
          // Another repository's #30.
          item({ number: 37, title: 'fix: see other/repo#30' }),
        ],
      }),
    );
    expect(origin!.outcome.reverts).toEqual([
      { number: null, kind: 'commit', sha: sha('9'), createdAt: '2026-09-03T00:00:00.000Z' },
      { number: 32, kind: 'pr', sha: null, createdAt: '2026-09-02T00:00:00.000Z' },
    ]);
    expect(origin!.outcome.followUps.map((f) => f.number)).toEqual([33]);
    expect(other!.outcome.reverts).toEqual([]);
    expect(other!.outcome.followUps).toEqual([]);
    expect(renderReport([origin!, other!], meta)).toContain(
      'Reverted within the window: 1 of 2 complete runs (#30)',
    );
  });

  it('classifies authors: loop, unattributed maintainer, vetted from the grant date, external', () => {
    const bundles = buildRunBundles(
      input({
        pulls: [
          detail({ number: 40 }),
          detail({ number: 41 }, { commitMessages: ['fix: by hand'] }),
          detail({
            number: 42,
            user: { login: 'Retsumdk' },
            created_at: '2026-10-08T00:00:00Z',
            closed_at: '2026-10-09T00:00:00Z',
            merged_at: '2026-10-09T00:00:00Z',
          }),
          detail({
            number: 43,
            user: { login: 'Retsumdk' },
            created_at: '2026-10-05T00:00:00Z',
            closed_at: '2026-10-06T00:00:00Z',
            merged_at: '2026-10-06T00:00:00Z',
          }),
        ],
      }),
    );
    expect(bundles.map((b) => b.run.author.class)).toEqual([
      'loop',
      'maintainer-unattributed',
      'external-vetted',
      'external',
    ]);
    expect(bundles[1]!.run.runner.model.status).toBe('unknown');
    expect(bundles[2]!.task.source.kind).toBe('external-pr');
  });

  it('counts a CI rerun on the head and a failing check', () => {
    const [b] = buildRunBundles(
      input({
        pulls: [
          detail(
            { number: 50 },
            {
              workflowRuns: [
                { head_sha: sha('a'), run_attempt: 2, event: 'pull_request' },
                { head_sha: sha('0'), run_attempt: 5, event: 'pull_request' },
              ],
              checkRuns: [
                {
                  name: 'Integration tests (Postgres)',
                  conclusion: 'failure',
                  completed_at: '2026-09-01T11:00:00Z',
                },
              ],
            },
          ),
        ],
      }),
    );
    expect(b!.run.attempts.ciRunAttemptsOnHead).toEqual({
      status: 'known',
      value: 2,
      unit: 'count',
    });
    expect(b!.run.verification.allChecksSucceeded).toBe(false);
  });
});

describe('review, follow-up and CI rules (review of #439)', () => {
  it('reports bot reviews apart and counts only human reviews in the headline', () => {
    const bundles = buildRunBundles(
      input({
        pulls: [
          detail(
            { number: 60 },
            {
              reviews: [
                {
                  user: { login: 'coderabbitai[bot]', type: 'Bot' },
                  state: 'COMMENTED',
                  commit_id: sha('a'),
                  submitted_at: '2026-09-01T11:00:00Z',
                },
              ],
            },
          ),
          detail(
            { number: 61 },
            {
              reviews: [
                {
                  user: { login: 'JulienAu' },
                  state: 'APPROVED',
                  commit_id: sha('a'),
                  submitted_at: '2026-09-01T11:00:00Z',
                },
              ],
            },
          ),
        ],
      }),
    );
    expect(bundles[0]!.reviews[0]!.reviewerClass).toBe('bot');
    expect(bundles[1]!.reviews[0]!.reviewerClass).toBe('maintainer');
    const report = renderReport(bundles, meta);
    expect(report).toContain(
      'posted verdict naming its head): 1 of 2. Bound to the final head SHA: 1 of 2',
    );
    expect(report).toContain('not counted above: 1 of 2');
  });

  it('binds a verdict to the commit it names, which may not be the final head', () => {
    const [b] = buildRunBundles(
      input({
        pulls: [
          detail(
            { number: 62 },
            {
              commitShas: [sha('5'), sha('a')],
              comments: [
                {
                  user: { login: 'JulienAu' },
                  body: '## Review verdict - ready with fixups\n\nReviewed at head `5555555` (pinned).',
                  created_at: '2026-09-01T11:30:00Z',
                },
              ],
            },
          ),
        ],
      }),
    );
    expect(b!.reviews[0]!.commitSha).toBe(sha('5'));
    expect(renderReport([b!], meta)).toContain('Bound to the final head SHA: 0 of 1');
  });

  it('counts only fix follow-ups: bug issues and fix PRs that were not closed unmerged', () => {
    const [b] = buildRunBundles(
      input({
        pulls: [detail({ number: 70 })],
        items: [
          item({ number: 71, title: 'feat(session): show sets after #70' }),
          item({ number: 72, title: 'chore: tidy after #70' }),
          item({ number: 73, title: 'Session totals wrong since #70', labels: ['bug'] }),
          item({ number: 74, title: 'fix: follow-up of #70', isPull: true, closedUnmerged: true }),
          item({ number: 75, title: 'fix(api): follow-up of #70', isPull: true }),
          item({ number: 76, title: 'fix(api): one error mapper (#70 review)' }),
        ],
      }),
    );
    expect(b!.outcome.followUps.map((f) => f.number)).toEqual([73, 75, 76]);
  });

  it('reports regression signals over complete runs and observing runs apart', () => {
    const bundles = buildRunBundles(
      input({
        pulls: [
          detail({ number: 80 }),
          detail({ number: 81 }),
          detail({
            number: 82,
            created_at: '2026-10-10T00:00:00Z',
            closed_at: '2026-10-10T01:00:00Z',
            merged_at: '2026-10-10T01:00:00Z',
          }),
        ],
        items: [
          item({ number: 83, title: 'fix: after #80' }),
          item({ number: 84, title: 'fix: after #82', created_at: '2026-10-11T00:00:00Z' }),
        ],
      }),
    );
    const report = renderReport(bundles, meta);
    expect(report).toContain(
      '(heuristic): 1 of 2 complete runs (#80). Partial, still observing: 1 of 1 (#82).',
    );
    expect(report).toContain(
      'Reverted within the window: 0 of 2 complete runs. Partial, still observing: 0 of 1.',
    );
  });

  it('keeps CI rerun and CI outcome unknown on a head where no check ran', () => {
    const bundles = buildRunBundles(
      input({
        pulls: [
          detail({ number: 90 }),
          // A fork run awaiting approval: a workflow run, but no check.
          detail({ number: 91, user: { login: 'stranger' } }, { checkRuns: [] }),
        ],
      }),
    );
    expect(bundles[1]!.run.attempts.ciRunAttemptsOnHead.status).toBe('unknown');
    expect(bundles[1]!.run.verification.allChecksSucceeded).toBeNull();
    const report = renderReport(bundles, meta);
    // Both CI lines agree on the same unknown run.
    expect(report).toContain('1 of 1 runs with a settled CI outcome (1 unknown');
    expect(report).toContain('0 of 1 runs where a check ran on the head (1 unknown)');
  });

  it('treats a running check as unknown and ignores skipped and neutral checks', () => {
    const outcome = (conclusions: (string | null)[]) =>
      buildRunBundles(
        input({
          pulls: [
            detail(
              { number: 95 },
              {
                checkRuns: conclusions.map((conclusion, i) => ({
                  name: `check ${i}`,
                  conclusion,
                  completed_at: conclusion ? '2026-09-01T11:00:00Z' : null,
                })),
              },
            ),
          ],
        }),
      )[0]!.run.verification.allChecksSucceeded;
    expect(outcome(['success', null])).toBeNull();
    expect(outcome(['success', 'skipped'])).toBe(true);
    expect(outcome(['neutral', 'skipped'])).toBeNull();
    expect(outcome(['failure', 'skipped'])).toBe(false);
  });
});

describe('same-repository references', () => {
  const repo = 'gymcoach-app/gymcoach';
  it('matches a bare or same-repo reference, not a longer number or another repo', () => {
    expect(references('see #30.', 30, repo)).toBe(true);
    expect(references('(#30)', 30, repo)).toBe(true);
    expect(references('Reverts gymcoach-app/gymcoach#30', 30, repo)).toBe(true);
    expect(references('#300', 30, repo)).toBe(false);
    expect(references('other/repo#30', 30, repo)).toBe(false);
    expect(references('other/gymcoach-app/gymcoach#30', 30, repo)).toBe(false);
  });
});

describe('collector parsing helpers', () => {
  it('reads closing references only', () => {
    expect(linkedIssues('Closes #379. Refs #426, fixes #12 and resolves #12')).toEqual([379, 12]);
    expect(linkedIssues(null)).toEqual([]);
  });

  it('parses the vetted list with grant dates from the policy', () => {
    const policy =
      '**Vetted contributors:**\n\n- `SHAREN` - vetted by the operator 2026-07-22 after\n- `Retsumdk` - vetted by the operator 2026-10-07 after\n';
    expect(parseVetted(policy)).toEqual([
      { login: 'SHAREN', since: '2026-07-22T00:00:00Z' },
      { login: 'Retsumdk', since: '2026-10-07T00:00:00Z' },
    ]);
  });

  it('parses revert commits from git log records', () => {
    const log = `${sha('1')}\x1f2026-09-03T00:00:00+02:00\x1fRevert "x"\n\nThis reverts commit ${sha('2')}.\n\x1e\n${sha('3')}\x1f2026-09-04T00:00:00Z\x1fnot a revert\x1e`;
    expect(parseRevertLog(log)).toEqual([
      { sha: sha('1'), committedAt: '2026-09-03T00:00:00+02:00', revertedSha: sha('2') },
    ]);
  });
});
