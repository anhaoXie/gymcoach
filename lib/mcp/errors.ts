import { Prisma } from '@/prisma/generated/client';

// A thrown MCP tool error reaches the client as its bare message, so a raw
// Prisma error would hand the caller the invocation text: its own arguments
// plus server source paths. Map the codes the REST layer already gives fixed
// wording (lib/api.ts handleApiError) and everything else Prisma to one generic
// message with a server-side log. Non-Prisma errors pass through untouched, so
// the deliberate messages this server raises on purpose ('Program not found.',
// the read-only token notice, the image-action choice) still reach the caller.
const PRISMA_TOOL_ERROR_MESSAGES: Record<string, string> = {
  P2002: 'Conflict: an entry with this value already exists.',
  P2003: 'Related record not found or no longer available.',
  P2025: 'Not found or already changed.',
};

export function mapToolError(err: unknown): Error {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const message = PRISMA_TOOL_ERROR_MESSAGES[err.code];
    if (message) return new Error(message);
    console.error('[mcp] unhandled Prisma error:', err.code, err.message);
    return new Error('Server error.');
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    console.error('[mcp] invalid Prisma query:', err.message);
    return new Error('Server error.');
  }

  // The remaining Prisma classes carry query or connection details too: an
  // initialization error can name the database host (issue #433).
  if (
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientRustPanicError
  ) {
    console.error('[mcp] Prisma error:', err.name, err.message);
    return new Error('Server error.');
  }

  return err instanceof Error ? err : new Error(String(err));
}

// Every tool handler is registered through this, so no handler can leak a raw
// Prisma message by forgetting a catch of its own.
export function guardToolHandler<Args extends unknown[], Result>(
  handler: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      throw mapToolError(err);
    }
  };
}
