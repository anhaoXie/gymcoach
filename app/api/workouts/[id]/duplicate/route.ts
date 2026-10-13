import { NextResponse } from 'next/server';
import { duplicateInputSchema } from '@/lib/schemas/copy';
import { copyName } from '@/lib/programs/copy';
import { duplicateWorkout } from '@/lib/programs/duplicate';
import { db } from '@/lib/db';
import { ApiError, handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';

interface Params {
  params: Promise<{ id: string }>;
}

// POST /api/workouts/[id]/duplicate (issue #394): copies a workout and every
// programmed exercise into the same program, appended last.
export async function POST(req: Request, props: Params) {
  const params = await props.params;
  try {
    const userId = await requireApiUserId();
    // Scoped probe so a stranger gets 404 before any 400 about the body.
    const source = await db.workout.findFirst({
      where: { id: params.id, program: { userId } },
      select: { name: true },
    });
    if (!source) throw new ApiError(404, 'Session not found.');
    const data = await parseJsonBody(req, duplicateInputSchema);
    const workout = await duplicateWorkout(userId, params.id, data.name ?? copyName(source.name));
    return NextResponse.json(workout, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
