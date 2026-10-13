import { NextResponse } from 'next/server';
import { duplicateInputSchema } from '@/lib/schemas/copy';
import { copyName } from '@/lib/programs/copy';
import { duplicateProgram } from '@/lib/programs/duplicate';
import { db } from '@/lib/db';
import { ApiError, handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';

interface Params {
  params: Promise<{ id: string }>;
}

// POST /api/programs/[id]/duplicate (issue #394): an independent deep copy of
// the program, its workouts and every programmed exercise, created inactive.
export async function POST(req: Request, props: Params) {
  const params = await props.params;
  try {
    const userId = await requireApiUserId();
    // Scoped probe so a stranger gets 404 before any 400 about the body.
    const source = await db.program.findFirst({
      where: { id: params.id, userId },
      select: { name: true },
    });
    if (!source) throw new ApiError(404, 'Program not found.');
    const data = await parseJsonBody(req, duplicateInputSchema);
    const program = await duplicateProgram(userId, params.id, data.name ?? copyName(source.name));
    return NextResponse.json(program, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
