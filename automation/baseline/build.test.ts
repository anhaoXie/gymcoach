import { describe, expect, it } from 'vitest';
import { type BuildInput, type RawPullDetail, buildRunBundles, linkedIssues } from './build';
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
                  body: '**Review verdict (head `abc`): ready.**',
                  created_at: '2026-09-01T11:30:00Z',
                },
                {
                  user: { login: 'someone' },
                  body: 'review verdict please',
                  created_at: '2026-09-01T11:31:00Z',
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
    // Only the maintainer's verdict counts as a recorded review.
    expect(bundle!.reviews).toHaveLength(1);
    expect(bundle!.reviews[0]).toMatchObject({ source: 'verdict-comment', reviewer: 'JulienAu' });
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
          {
            number: 32,
            isPull: true,
            title: 'Revert "feat: something"',
            body: 'Reverts gymcoach-app/gymcoach#30',
            created_at: '2026-09-02T00:00:00Z',
          },
          {
            number: 33,
            isPull: false,
            title: 'bug after #30',
            body: null,
            created_at: '2026-09-04T00:00:00Z',
          },
          // A write-up PR cites many PRs and is not a follow-up.
          {
            number: 34,
            isPull: true,
            title: 'docs: write up #30 and #31',
            body: null,
            created_at: '2026-09-04T00:00:00Z',
          },
          // #300 must not match #30.
          {
            number: 35,
            isPull: false,
            title: 'unrelated #300',
            body: null,
            created_at: '2026-09-04T00:00:00Z',
          },
          // Outside the 14-day window.
          {
            number: 36,
            isPull: false,
            title: 'late #30',
            body: null,
            created_at: '2026-10-01T00:00:00Z',
          },
        ],
      }),
    );
    expect(origin!.outcome.reverts).toEqual([
      { number: 30, kind: 'commit', sha: sha('9'), createdAt: '2026-09-03T00:00:00.000Z' },
      { number: 32, kind: 'pr', sha: null, createdAt: '2026-09-02T00:00:00.000Z' },
    ]);
    expect(origin!.outcome.followUps.map((f) => f.number)).toEqual([33]);
    expect(other!.outcome.reverts).toEqual([]);
    expect(other!.outcome.followUps).toEqual([]);
    expect(renderReport([origin!, other!], meta)).toContain(
      'Reverted within the window: 1 of 2 (#30)',
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
