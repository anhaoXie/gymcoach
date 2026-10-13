import { z } from 'zod';
import { workoutInputSchema } from '@/lib/schemas/workout';

// Duplicate a program or a workout (issue #394). The name is optional: the UI
// sends a localized "(copy)" name, the server falls back to an English one.
export const duplicateInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});

// Save a finished session as a workout of one of the trainee's programs.
export const saveSessionAsWorkoutSchema = workoutInputSchema.extend({
  programId: z.string().min(1, 'Program required'),
});

export type SaveSessionAsWorkoutInput = z.infer<typeof saveSessionAsWorkoutSchema>;
