import { vi } from "vitest";

export type FakeResult = {
  data?: unknown;
  error?: { code?: string | null; message?: string | null } | null;
};

export type FakeBuilder = ReturnType<typeof createFakeBuilder>;

/**
 * Minimal stand-in for a PostgREST builder: every chainable call is recorded
 * and `await builder` resolves to `{ data, error }`.
 */
export function createFakeBuilder(result: FakeResult) {
  const state = {
    select: [] as string[],
    eq: [] as [string, unknown][],
    in: [] as [string, unknown[]][],
    order: [] as [string, Record<string, unknown>][],
    limit: [] as number[],
    or: [] as string[],
    insert: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
    deletes: 0,
  };

  const builder = {
    select: vi.fn((columns: string) => {
      state.select.push(columns);
      return builder;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      state.eq.push([column, value]);
      return builder;
    }),
    in: vi.fn((column: string, values: unknown[]) => {
      state.in.push([column, values]);
      return builder;
    }),
    order: vi.fn((column: string, options: Record<string, unknown>) => {
      state.order.push([column, options]);
      return builder;
    }),
    limit: vi.fn((value: number) => {
      state.limit.push(value);
      return builder;
    }),
    or: vi.fn((filter: string) => {
      state.or.push(filter);
      return builder;
    }),
    insert: vi.fn((row: Record<string, unknown>) => {
      state.insert.push(row);
      return builder;
    }),
    update: vi.fn((row: Record<string, unknown>) => {
      state.updates.push(row);
      return builder;
    }),
    delete: vi.fn(() => {
      state.deletes += 1;
      return builder;
    }),
    maybeSingle: vi.fn(async () => result),
    then: (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  };

  return { builder, state };
}

export function createFakeClient(result: FakeResult) {
  const { builder, state } = createFakeBuilder(result);
  const rpcCalls: { fn: string; args?: unknown }[] = [];
  const client = {
    from: vi.fn(() => builder),
    rpc: vi.fn(async (fn: string, args?: unknown) => {
      rpcCalls.push({ fn, args });
      return result;
    }),
    rpcCalls,
    auth: {
      getClaims: vi.fn(async () => ({ data: { claims: { sub: "user-1" } } })),
    },
  };

  return { client, builder, state, rpcCalls };
}
