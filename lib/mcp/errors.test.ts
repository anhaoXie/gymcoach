import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/prisma/generated/client';
import { guardToolHandler, mapToolError } from './errors';

function knownError(code: string, message: string) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: 'test',
  });
}

// The leak this module exists to stop: the raw Prisma message carries the
// caller's own arguments and the server source paths.
const RAW_PRISMA_TEXT =
  'Invalid `prisma.set.create()` invocation in /app/lib/gym-equipment.ts:412 secretArg=42';

afterEach(() => {
  // Restored here rather than after the assertions, so a failing assertion
  // cannot leave console.error silenced for the next test.
  vi.restoreAllMocks();
});

describe('mapToolError', () => {
  it('maps a unique-constraint violation to the REST conflict wording', () => {
    const mapped = mapToolError(knownError('P2002', RAW_PRISMA_TEXT));
    expect(mapped.message).toBe('Conflict: an entry with this value already exists.');
  });

  it('maps a foreign-key violation to a clean message', () => {
    const mapped = mapToolError(knownError('P2003', RAW_PRISMA_TEXT));
    expect(mapped.message).toBe('Related record not found or no longer available.');
  });

  it('maps a record-not-found violation to a clean message', () => {
    const mapped = mapToolError(knownError('P2025', RAW_PRISMA_TEXT));
    expect(mapped.message).toBe('Not found or already changed.');
  });

  it('maps every known code without leaking the Prisma text', () => {
    for (const code of ['P2002', 'P2003', 'P2025']) {
      const mapped = mapToolError(knownError(code, RAW_PRISMA_TEXT));
      expect(mapped.message).not.toContain('prisma');
      expect(mapped.message).not.toContain('invocation');
      expect(mapped.message).not.toContain('/app/');
      expect(mapped.message).not.toContain('secretArg');
    }
  });

  it('maps an unmapped Prisma code to a generic message and logs it server-side', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mapped = mapToolError(knownError('P2000', RAW_PRISMA_TEXT));
    expect(mapped.message).toBe('Server error.');
    expect(mapped.message).not.toContain('invocation');
    expect(spy).toHaveBeenCalled();
  });

  it('maps a Prisma validation error to a generic message and logs it server-side', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mapped = mapToolError(
      new Prisma.PrismaClientValidationError(RAW_PRISMA_TEXT, {
        clientVersion: 'test',
      }),
    );
    expect(mapped.message).toBe('Server error.');
    expect(mapped.message).not.toContain('invocation');
    expect(spy).toHaveBeenCalled();
  });

  it.each([
    [
      'an unknown request error',
      new Prisma.PrismaClientUnknownRequestError(RAW_PRISMA_TEXT, { clientVersion: 'test' }),
    ],
    [
      'an initialization error',
      new Prisma.PrismaClientInitializationError(
        `Can't reach database server at db.internal:5432 ${RAW_PRISMA_TEXT}`,
        'test',
      ),
    ],
    ['a Rust panic', new Prisma.PrismaClientRustPanicError(RAW_PRISMA_TEXT, 'test')],
  ])('maps %s to a generic message and logs it server-side', (_label, err) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mapped = mapToolError(err);
    expect(mapped.message).toBe('Server error.');
    expect(mapped.message).not.toContain('invocation');
    expect(mapped.message).not.toContain('db.internal');
    expect(spy).toHaveBeenCalled();
  });

  it('passes a deliberate error through unchanged', () => {
    const err = new Error('Program not found.');
    expect(mapToolError(err)).toBe(err);
  });

  it('wraps a thrown non-Error value', () => {
    expect(mapToolError('boom').message).toBe('boom');
  });
});

describe('guardToolHandler', () => {
  it('returns the handler result untouched', async () => {
    const guarded = guardToolHandler(async (value: number) => ({ ok: value }));
    await expect(guarded(7)).resolves.toEqual({ ok: 7 });
  });

  it('converts a thrown Prisma error into the clean message', async () => {
    const guarded = guardToolHandler(async () => {
      throw knownError('P2025', RAW_PRISMA_TEXT);
    });
    await expect(guarded()).rejects.toThrow('Not found or already changed.');
  });

  it('lets a deliberate error keep its own message', async () => {
    const guarded = guardToolHandler(async () => {
      throw new Error('This GymCoach MCP token is read-only.');
    });
    await expect(guarded()).rejects.toThrow('This GymCoach MCP token is read-only.');
  });
});
