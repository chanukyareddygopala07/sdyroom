import { vi } from "vitest";

export type FakeResult = {
  data?: unknown;
  error?: { code?: string | null; message?: string | null } | null;
  /** Present only when the fake was given one, so `toEqual` stays strict. */
  count?: number;
};

export type FakeBuilder = ReturnType<typeof createFakeBuilder>;

type FakeResultOrNext = FakeResult | (() => FakeResult);

/**
 * Minimal stand-in for a PostgREST builder: every chainable call is recorded
 * and `await builder` resolves to `{ data, error }`.
 *
 * The result may be a function, which is called at each await — that is how a
 * client with several sequential queries (RPC first, then two tables) is
 * faked with a queue of results.
 */
export function createFakeBuilder(result: FakeResultOrNext) {
  const resolve: () => FakeResult =
    typeof result === "function" ? result : () => result;
  const state = {
    select: [] as string[],
    /** The second argument of each `select`, in call order. */
    selectOptions: [] as unknown[],
    is: [] as [string, unknown][],
    ilike: [] as [string, unknown][],
    range: [] as [number, number][],
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
    select: vi.fn((columns: string, options?: unknown) => {
      state.select.push(columns);
      state.selectOptions.push(options);
      return builder;
    }),
    is: vi.fn((column: string, value: unknown) => {
      state.is.push([column, value]);
      return builder;
    }),
    ilike: vi.fn((column: string, value: unknown) => {
      state.ilike.push([column, value]);
      return builder;
    }),
    range: vi.fn((from: number, to: number) => {
      state.range.push([from, to]);
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
    maybeSingle: vi.fn(async () => resolve()),
    single: vi.fn(async () => resolve()),
    then: (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
  };

  return { builder, state };
}

/**
 * A client whose `rpc` and table queries answer from `queue` in call order
 * (falling back to `result` once the queue is empty), so one test can drive a
 * read RPC, then a room row, then a history list.
 */
export function createFakeClient(result: FakeResult, queue: FakeResult[] = []) {
  const next = (): FakeResult => queue.shift() ?? result;
  const { builder, state } = createFakeBuilder(next);
  const rpcCalls: { fn: string; args?: unknown }[] = [];
  const client = {
    from: vi.fn(() => builder),
    rpc: vi.fn(async (fn: string, args?: unknown) => {
      rpcCalls.push({ fn, args });
      return next();
    }),
    rpcCalls,
    auth: {
      getClaims: vi.fn(async () => ({ data: { claims: { sub: "user-1" } } })),
    },
  };

  return { client, builder, state, rpcCalls };
}
