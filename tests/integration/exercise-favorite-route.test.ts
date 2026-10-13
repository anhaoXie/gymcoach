import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth';

// Issue #404: a per-user favourite flag on an exercise, starred through
// PATCH /api/exercises/[id] and kept apart from the edit form's PUT.

vi.mock('@/lib/auth', () => ({ getCurrentUserId: vi.fn() }));
const mockUserId = vi.mocked(getCurrentUserId);

import { PATCH, PUT } from '@/app/api/exercises/[id]/route';

async function seed(email: string) {
  const user = await db.user.create({ data: { email, passwordHash: 'x' } });
  const bench = await db.exercise.create({
    data: { userId: user.id, name: 'Bench', muscleGroup: 'CHEST', category: 'COMPOUND' },
  });
  return { user, bench };
}

function request(method: string, body: unknown) {
  return new Request('http://test.local/api', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  mockUserId.mockReset();
});

describe('PATCH /api/exercises/[id] favourite (issue #404)', () => {
  it('stars and unstars an exercise, starting from not starred', async () => {
    const { user, bench } = await seed('fav-toggle@test.dev');
    mockUserId.mockResolvedValue(user.id);
    expect(bench.isFavorite).toBe(false);

    const starred = await PATCH(request('PATCH', { isFavorite: true }), params(bench.id));
    expect(starred.status).toBe(200);
    expect(await starred.json()).toEqual({ id: bench.id, isFavorite: true });
    expect((await db.exercise.findUnique({ where: { id: bench.id } }))?.isFavorite).toBe(true);

    const unstarred = await PATCH(request('PATCH', { isFavorite: false }), params(bench.id));
    expect(unstarred.status).toBe(200);
    expect((await db.exercise.findUnique({ where: { id: bench.id } }))?.isFavorite).toBe(false);
  });

  it("refuses a stranger's exercise with 404 and writes nothing", async () => {
    const { bench } = await seed('fav-owner@test.dev');
    const stranger = await db.user.create({
      data: { email: 'fav-stranger@test.dev', passwordHash: 'x' },
    });
    mockUserId.mockResolvedValue(stranger.id);

    const res = await PATCH(request('PATCH', { isFavorite: true }), params(bench.id));
    expect(res.status).toBe(404);
    expect((await db.exercise.findUnique({ where: { id: bench.id } }))?.isFavorite).toBe(false);
  });

  it('rejects a body that is not a strict boolean', async () => {
    const { user, bench } = await seed('fav-invalid@test.dev');
    mockUserId.mockResolvedValue(user.id);

    for (const body of [{ isFavorite: 'true' }, { isFavorite: 1 }, {}]) {
      const res = await PATCH(request('PATCH', body), params(bench.id));
      expect(res.status).toBe(400);
    }
    expect((await db.exercise.findUnique({ where: { id: bench.id } }))?.isFavorite).toBe(false);
  });

  it('keeps the star when the exercise is edited through the form', async () => {
    const { user, bench } = await seed('fav-edit@test.dev');
    mockUserId.mockResolvedValue(user.id);
    await PATCH(request('PATCH', { isFavorite: true }), params(bench.id));

    const res = await PUT(
      request('PUT', {
        name: 'Bench press',
        muscleGroup: 'CHEST',
        category: 'COMPOUND',
        defaultRestSec: 120,
      }),
      params(bench.id),
    );
    expect(res.status).toBe(200);
    const after = await db.exercise.findUnique({ where: { id: bench.id } });
    expect(after?.name).toBe('Bench press');
    expect(after?.isFavorite).toBe(true);
  });
});
