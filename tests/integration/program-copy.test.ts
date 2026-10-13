import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth';
import { programExerciseCopyData } from '@/lib/programs/copy';

// Issue #394: duplicate a program or a workout, and save a finished session
// as a workout. Pinned here: deep, independent copies field by field, a
// deliberate repeat of an exercise copied as it is (5/3/1 Boring But Big,
// #429), ownership on every route, and nothing written on a refusal.

vi.mock('@/lib/auth', () => ({ getCurrentUserId: vi.fn() }));
const mockUserId = vi.mocked(getCurrentUserId);

import { POST as duplicateProgramRoute } from '@/app/api/programs/[id]/duplicate/route';
import { POST as duplicateWorkoutRoute } from '@/app/api/workouts/[id]/duplicate/route';
import { POST as saveAsWorkoutRoute } from '@/app/api/sessions/[id]/save-as-workout/route';

function post(body: unknown): Request {
  return new Request('http://test.local/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function seed(email: string) {
  const user = await db.user.create({ data: { email, passwordHash: 'x' } });
  const press = await db.exercise.create({
    data: {
      userId: user.id,
      name: 'Overhead Press',
      muscleGroup: 'SHOULDERS_FRONT',
      category: 'COMPOUND',
      defaultRestSec: 180,
    },
  });
  const chin = await db.exercise.create({
    data: { userId: user.id, name: 'Chin-up', muscleGroup: 'BACK_WIDTH', category: 'COMPOUND' },
  });
  const program = await db.program.create({
    data: {
      userId: user.id,
      name: '5/3/1 BBB',
      phase: 'Strength',
      description: 'Four days',
      isActive: true,
    },
  });
  const day1 = await db.workout.create({
    data: { programId: program.id, name: 'Day 1', dayOfWeek: 1, order: 1 },
  });
  // The main lift twice on purpose (the 5/3/1 sets, then the 5x10), and a
  // superset pairing with every optional column filled.
  await db.programExercise.create({
    data: {
      workoutId: day1.id,
      exerciseId: press.id,
      order: 1,
      targetSets: 3,
      targetRepsMin: 3,
      targetRepsMax: 5,
      targetRIR: 1,
      restSec: 180,
      tempo: '2-0-1',
      notes: 'Main lift',
      autoregulationMode: 'PRESERVE_REPS',
      fatigueRate: 0.05,
      loadAdjustmentPct: 2.5,
    },
  });
  await db.programExercise.create({
    data: {
      workoutId: day1.id,
      exerciseId: press.id,
      order: 2,
      targetSets: 5,
      targetRepsMin: 10,
      targetRepsMax: 10,
      targetRIR: 3,
      restSec: 90,
      supersetGroup: 1,
    },
  });
  await db.programExercise.create({
    data: {
      workoutId: day1.id,
      exerciseId: chin.id,
      order: 3,
      targetSets: 5,
      targetRepsMin: 5,
      targetRepsMax: 10,
      targetRIR: 2,
      restSec: 90,
      supersetGroup: 1,
    },
  });
  const day2 = await db.workout.create({
    data: { programId: program.id, name: 'Day 2', dayOfWeek: 3, order: 2 },
  });
  return { user, press, chin, program, day1, day2 };
}

async function rowsOf(workoutId: string) {
  const rows = await db.programExercise.findMany({
    where: { workoutId },
    orderBy: { order: 'asc' },
  });
  return rows.map(programExerciseCopyData);
}

beforeEach(() => {
  mockUserId.mockReset();
});

describe('POST /api/programs/[id]/duplicate (issue #394)', () => {
  it('creates an independent, inactive deep copy, repeats included', async () => {
    const { user, program, day1 } = await seed('dup-program@test.dev');
    mockUserId.mockResolvedValue(user.id);

    const res = await duplicateProgramRoute(post({ name: '5/3/1 BBB (copy)' }), params(program.id));
    expect(res.status).toBe(201);
    const copy = (await res.json()) as { id: string };
    expect(copy.id).not.toBe(program.id);

    const persisted = await db.program.findUniqueOrThrow({
      where: { id: copy.id },
      include: { workouts: { orderBy: { order: 'asc' } } },
    });
    expect(persisted).toMatchObject({
      userId: user.id,
      name: '5/3/1 BBB (copy)',
      phase: 'Strength',
      description: 'Four days',
      isActive: false,
    });
    expect(persisted.workouts.map((w) => [w.name, w.dayOfWeek, w.order])).toEqual([
      ['Day 1', 1, 1],
      ['Day 2', 3, 2],
    ]);
    // Every programmed exercise matches its source column by column.
    expect(await rowsOf(persisted.workouts[0]!.id)).toEqual(await rowsOf(day1.id));
    // The source is untouched and still the active program.
    expect(await db.program.findUniqueOrThrow({ where: { id: program.id } })).toMatchObject({
      isActive: true,
    });
    expect(await db.programExercise.count({ where: { workoutId: day1.id } })).toBe(3);

    // Independent: editing the copy leaves the source alone.
    await db.programExercise.updateMany({
      where: { workoutId: persisted.workouts[0]!.id },
      data: { targetSets: 1 },
    });
    expect(
      (await db.programExercise.findMany({ where: { workoutId: day1.id } })).map(
        (pe) => pe.targetSets,
      ),
    ).toEqual(expect.arrayContaining([3, 5, 5]));
  });

  it('falls back to a default copy name', async () => {
    const { user, program } = await seed('dup-program-name@test.dev');
    mockUserId.mockResolvedValue(user.id);
    const res = await duplicateProgramRoute(post({}), params(program.id));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { name: string }).name).toBe('5/3/1 BBB (copy)');
  });

  it("returns 404 on someone else's program and writes nothing", async () => {
    const { program } = await seed('dup-program-owner@test.dev');
    const stranger = await db.user.create({
      data: { email: 'dup-stranger@test.dev', passwordHash: 'x' },
    });
    mockUserId.mockResolvedValue(stranger.id);
    const res = await duplicateProgramRoute(post({ name: 'Mine now' }), params(program.id));
    expect(res.status).toBe(404);
    expect(await db.program.count()).toBe(1);
  });
});

describe('POST /api/workouts/[id]/duplicate (issue #394)', () => {
  it('appends a copy to the same program with every row, repeats included', async () => {
    const { user, program, day1 } = await seed('dup-workout@test.dev');
    mockUserId.mockResolvedValue(user.id);

    const res = await duplicateWorkoutRoute(post({ name: 'Day 1 (copy)' }), params(day1.id));
    expect(res.status).toBe(201);
    const copy = (await res.json()) as { id: string };
    const persisted = await db.workout.findUniqueOrThrow({ where: { id: copy.id } });
    expect(persisted).toMatchObject({
      programId: program.id,
      name: 'Day 1 (copy)',
      dayOfWeek: 1,
      order: 3,
    });
    expect(await rowsOf(copy.id)).toEqual(await rowsOf(day1.id));
  });

  it("returns 404 on someone else's workout and writes nothing", async () => {
    const { day1 } = await seed('dup-workout-owner@test.dev');
    const stranger = await db.user.create({
      data: { email: 'dup-w-stranger@test.dev', passwordHash: 'x' },
    });
    mockUserId.mockResolvedValue(stranger.id);
    const res = await duplicateWorkoutRoute(post({}), params(day1.id));
    expect(res.status).toBe(404);
    expect(await db.workout.count()).toBe(2);
  });
});

describe('POST /api/sessions/[id]/save-as-workout (issue #394)', () => {
  async function seedSession(email: string, finished = true) {
    const base = await seed(email);
    const session = await db.session.create({
      data: {
        userId: base.user.id,
        programId: base.program.id,
        workoutId: base.day1.id,
        startedAt: new Date('2026-10-01T10:00:00Z'),
        finishedAt: finished ? new Date('2026-10-01T11:00:00Z') : null,
      },
    });
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute));
    await db.set.createMany({
      data: [
        // Chin-ups first this time, then the press.
        {
          sessionId: session.id,
          exerciseId: base.chin.id,
          setNumber: 1,
          weight: 0,
          reps: 8,
          rir: 2,
          completedAt: at(1),
        },
        {
          sessionId: session.id,
          exerciseId: base.chin.id,
          setNumber: 2,
          weight: 0,
          reps: 6,
          rir: 1,
          completedAt: at(4),
        },
        {
          sessionId: session.id,
          exerciseId: base.press.id,
          setNumber: 1,
          weight: 30,
          reps: 5,
          rir: 4,
          completedAt: at(10),
          isWarmup: true,
        },
        {
          sessionId: session.id,
          exerciseId: base.press.id,
          setNumber: 2,
          weight: 50,
          reps: 5,
          rir: 1,
          completedAt: at(14),
        },
        {
          sessionId: session.id,
          exerciseId: base.press.id,
          setNumber: 3,
          weight: 50,
          reps: 4,
          rir: 0,
          completedAt: at(18),
        },
        {
          sessionId: session.id,
          exerciseId: base.press.id,
          setNumber: 4,
          weight: 50,
          reps: 3,
          rir: 0,
          completedAt: at(22),
        },
      ],
    });
    return { ...base, session };
  }

  it('adds a workout built from the working sets actually done', async () => {
    const { user, program, session, press, chin } = await seedSession('save-session@test.dev');
    mockUserId.mockResolvedValue(user.id);

    const res = await saveAsWorkoutRoute(
      post({ programId: program.id, name: 'Improvised press day', dayOfWeek: null }),
      params(session.id),
    );
    expect(res.status).toBe(201);
    const workout = (await res.json()) as { id: string };
    expect(await db.workout.findUniqueOrThrow({ where: { id: workout.id } })).toMatchObject({
      programId: program.id,
      name: 'Improvised press day',
      dayOfWeek: null,
      order: 3,
    });
    const rows = await db.programExercise.findMany({
      where: { workoutId: workout.id },
      orderBy: { order: 'asc' },
    });
    expect(rows).toEqual([
      expect.objectContaining({
        exerciseId: chin.id,
        order: 1,
        targetSets: 2,
        targetRepsMin: 6,
        targetRepsMax: 8,
        // Mean of 2 and 1, rounded.
        targetRIR: 2,
        restSec: 90,
      }),
      expect.objectContaining({
        exerciseId: press.id,
        order: 2,
        // The warm-up is not a programmed set.
        targetSets: 3,
        targetRepsMin: 3,
        targetRepsMax: 5,
        targetRIR: 0,
        // Rest, tempo, notes and autoregulation of the session's own row.
        restSec: 180,
        tempo: '2-0-1',
        notes: 'Main lift',
        autoregulationMode: 'PRESERVE_REPS',
        fatigueRate: 0.05,
        loadAdjustmentPct: 2.5,
        supersetGroup: null,
      }),
    ]);
  });

  it('refuses an unfinished session and writes nothing', async () => {
    const { user, program, session } = await seedSession('save-unfinished@test.dev', false);
    mockUserId.mockResolvedValue(user.id);
    const res = await saveAsWorkoutRoute(
      post({ programId: program.id, name: 'Too early' }),
      params(session.id),
    );
    expect(res.status).toBe(400);
    expect(await db.workout.count()).toBe(2);
  });

  it('refuses a session with no working sets', async () => {
    const { user, program, session } = await seedSession('save-warmups@test.dev');
    await db.set.updateMany({ where: { sessionId: session.id }, data: { isWarmup: true } });
    mockUserId.mockResolvedValue(user.id);
    const res = await saveAsWorkoutRoute(
      post({ programId: program.id, name: 'Warm-ups only' }),
      params(session.id),
    );
    expect(res.status).toBe(400);
    expect(await db.workout.count()).toBe(2);
  });

  it("refuses someone else's program as the target and writes nothing", async () => {
    const { user, session } = await seedSession('save-target@test.dev');
    const other = await seed('save-other@test.dev');
    mockUserId.mockResolvedValue(user.id);
    const res = await saveAsWorkoutRoute(
      post({ programId: other.program.id, name: 'Into theirs' }),
      params(session.id),
    );
    expect(res.status).toBe(404);
    expect(await db.workout.count({ where: { programId: other.program.id } })).toBe(2);
  });

  it("returns 404 on someone else's session", async () => {
    const { session } = await seedSession('save-owner@test.dev');
    const stranger = await seed('save-stranger@test.dev');
    mockUserId.mockResolvedValue(stranger.user.id);
    const res = await saveAsWorkoutRoute(
      post({ programId: stranger.program.id, name: 'Stolen' }),
      params(session.id),
    );
    expect(res.status).toBe(404);
    expect(await db.workout.count({ where: { programId: stranger.program.id } })).toBe(2);
  });

  it('validates the body', async () => {
    const { user, session } = await seedSession('save-invalid@test.dev');
    mockUserId.mockResolvedValue(user.id);
    const res = await saveAsWorkoutRoute(post({ programId: '', name: '' }), params(session.id));
    expect(res.status).toBe(400);
  });
});
