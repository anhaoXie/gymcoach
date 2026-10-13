# Maintainer automation

Tooling for the autonomous maintainer, kept apart from the GymCoach application:
the app never imports this directory and the Docker image does not ship it
(`.dockerignore`). See the
[implementation roadmap](../docs/loops/11-autonomous-development-roadmap.md).

## Run records (milestone 1)

- `records/schema.ts` - versioned Zod schemas (schema version 1) for task, run,
  review and outcome records. A measurement is either known, with a unit, or
  unknown, with a reason. A value the workflow does not record is unknown, never 0.
- `baseline/build.ts` - pure builder: raw GitHub and git data in, records out.
- `baseline/report.ts` - the Markdown report; every rate states its denominator.
- `baseline/collect.ts` - read-only collector (`gh api` GET calls and `git log`):

  ```bash
  npx tsx automation/baseline/collect.ts --since 2026-08-14 --window-days 14 \
    --out docs/loops/baseline/2026-10-13
  ```

- `baseline/render.ts` - re-renders `report.md` from a collected `runs.jsonl`.

Outputs are public metadata only: PR numbers, logins, SHAs, timestamps, check
names and conclusions. PR and issue bodies, comment text and commit messages are
read in memory to find references and trailers, and are never written.

Author classes: `loop` is the maintainer account with a Claude Co-Authored-By
trailer on the PR commits; `maintainer-unattributed` is the maintainer account
without one; `external-vetted` uses the grant date in
`docs/loops/10-external-contributions.md`; everyone else is `external`. The
trailer shows Claude wrote the commits, not that the run was unattended.
