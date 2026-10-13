import { NextResponse } from 'next/server';
import { saveSessionAsWorkoutSchema } from '@/lib/schemas/copy';
import { saveSessionAsWorkout } from '@/lib/programs/duplicate';
import { db } from '@/lib/db';
import { ApiError, handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';

interface Params {
  params: Promise<{ id: string }>;
}

// POST /api/sessions/[id]/save-as-workout (issue #394): turns what a finished
// session actually did into a new workout of one of the trainee's programs.
export async function POST(req: Request, props: Params) {
  const params = await props.params;
  try {
    const userId = await requireApiUserId();
    // Scoped probe so a stranger gets 404 before any 400 about the body.
    const owned = await db.session.findFirst({
      where: { id: params.id, userId },
      select: { id: true },
    });
    if (!owned) throw new ApiError(404, 'Session not found.');
    const data = await parseJsonBody(req, saveSessionAsWorkoutSchema);
    const workout = await saveSessionAsWorkout(userId, params.id, {
      programId: data.programId,
      name: data.name,
      dayOfWeek: data.dayOfWeek ?? null,
    });
    return NextResponse.json(workout, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
