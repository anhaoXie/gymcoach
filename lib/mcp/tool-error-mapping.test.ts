import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/prisma/generated/client';

// Issue #377: a thrown tool error reaches an MCP client as its bare message, so
// a raw Prisma error would hand the caller the invocation text - its own
// arguments plus server source paths. This file drives the real server through
// the real registration path, with a helper that throws, and asserts the client
// only ever sees fixed wording. The mapper's own branches are covered by
// errors.test.ts; what is pinned here is that every handler is wrapped, which is
// the part a helper-level unit test cannot see.
const RAW_PRISMA_TEXT =
  'Invalid `prisma.gym.findMany()` invocation in /app/lib/gym-equipment.ts:68 secretArg=42';

// The error the mocked helper throws next; each test picks its Prisma class.
const thrown = vi.hoisted(() => ({ next: null as Error | null }));

vi.mock('@/lib/gym-equipment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gym-equipment')>();
  return {
    ...actual,
    listOwnedGyms: vi.fn(async () => {
      throw (
        thrown.next ??
        new Prisma.PrismaClientKnownRequestError(RAW_PRISMA_TEXT, {
          code: 'P2003',
          clientVersion: 'test',
        })
      );
    }),
  };
});

import { createGymCoachMcpServer } from './server';

const openServers: Array<ReturnType<typeof createGymCoachMcpServer>> = [];
const openClients: Client[] = [];

async function connect(canWrite: boolean) {
  const server = createGymCoachMcpServer({
    principal: { tokenId: 'token-1', userId: 'user-1', canWrite },
    baseUrl: 'https://gymcoach.example',
  });
  const client = new Client({ name: 'tool-error-mapping-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  openServers.push(server);
  openClients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

afterEach(async () => {
  thrown.next = null;
  vi.restoreAllMocks();
  await Promise.allSettled(openClients.splice(0).map((client) => client.close()));
  await Promise.allSettled(openServers.splice(0).map((server) => server.close()));
});

describe('MCP tool error mapping', () => {
  it('never hands a raw Prisma message to the client', async () => {
    const client = await connect(true);
    const res = await client.callTool({ name: 'list_gyms', arguments: {} });

    expect(res.isError).toBe(true);
    const seen = JSON.stringify(res.content);
    expect(seen).toContain('Related record not found or no longer available.');
    expect(seen).not.toContain('prisma');
    expect(seen).not.toContain('invocation');
    expect(seen).not.toContain('secretArg');
    expect(seen).not.toContain('/app/');
  });

  it('never hands a database connection error to the client (#433)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    thrown.next = new Prisma.PrismaClientInitializationError(
      `Can't reach database server at db.internal:5432 ${RAW_PRISMA_TEXT}`,
      'test',
    );
    const client = await connect(true);
    const res = await client.callTool({ name: 'list_gyms', arguments: {} });

    expect(res.isError).toBe(true);
    const seen = JSON.stringify(res.content);
    expect(seen).toContain('Server error.');
    expect(seen).not.toContain('db.internal');
    expect(seen).not.toContain('invocation');
  });

  it('lets a deliberate error keep its own message', async () => {
    const client = await connect(false);
    const res = await client.callTool({
      name: 'update_gym_free_weights',
      arguments: { confirmed: true, dumbbellWeights: [10, 12] },
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain(
      'This GymCoach MCP token is read-only. Create a write-enabled token in Settings.',
    );
  });
});
