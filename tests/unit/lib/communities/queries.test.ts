import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  appendCommunityMessage,
  appendCommunityWelcome,
  CommunityError,
  createCommunity,
  createCommunityAttachment,
  createCommunityReport,
  fetchCommunityKeyPackages,
  getCommunity,
  getCommunityAttachment,
  getCommunityChannel,
  joinCommunity,
  leaveCommunity,
  listActiveMemberIds,
  listCommunities,
  listCommunityChannels,
  listCommunityMembers,
  listCommunityMessages,
  listPendingWelcomes,
  registerCommunityDevice,
  setCommunityMember,
  updateCommunity,
} from "@/lib/communities/queries";

type Result = { data?: unknown; error?: { message: string; code?: string } | null };
type LogEntry = {
  kind: "from" | "rpc" | "method";
  name: string;
  args: unknown[];
};

/**
 * Scripted fake Supabase: every `from()`/`rpc()` consumes the next result
 * from the queue (so multi-step functions script in call order), and every
 * builder method records itself for assertions.
 */
function fakeDb(results: Array<Result>): {
  client: SupabaseClient;
  log: LogEntry[];
} {
  const queue = [...results];
  const log: LogEntry[] = [];
  const take = (entry: LogEntry): Result => {
    log.push(entry);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`fakeDb: no scripted result for ${entry.name}`);
    }
    return next;
  };

  const client = {
    from(table: string) {
      const result = take({ kind: "from", name: table, args: [] });
      const chain: Record<string, unknown> = {};
      const method =
        (name: string) =>
        (...args: unknown[]): unknown => {
          log.push({ kind: "method", name, args });
          return chain;
        };
      for (const name of [
        "select",
        "eq",
        "neq",
        "lt",
        "gt",
        "in",
        "or",
        "order",
        "limit",
        "range",
        "insert",
        "update",
        "upsert",
        "delete",
      ]) {
        chain[name] = method(name);
      }
      const resolved = Promise.resolve(result);
      chain.maybeSingle = () => resolved;
      chain.single = () => resolved;
      chain.then = (
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => resolved.then(onFulfilled, onRejected);
      return chain;
    },
    rpc(name: string, args?: unknown) {
      const result = take({ kind: "rpc", name, args: args ? [args] : [] });
      const resolved = Promise.resolve(result);
      return {
        then: (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => resolved.then(onFulfilled, onRejected),
      };
    },
  };

  return { client: client as unknown as SupabaseClient, log };
}

const COMMUNITY = "0b2f9c1e-3d4a-4b5c-8e6f-7a8b9c0d1e2f";
const CHANNEL = "1c3d0a2f-4e5b-4c6d-9f70-8b9c0d1e2f30";
const USER = "2d4e1b30-5f6a-4d7e-af81-9c0d1e2f3041";
const MSG_ID = "3e5f2c41-6a7b-4e8f-b092-0d1e2f304152";

describe("CommunityError", () => {
  it("forces not_found onto 404 regardless of the requested status", () => {
    expect(new CommunityError("not_found", "gone", 500).status).toBe(404);
    expect(new CommunityError("slug_taken", "taken", 409).status).toBe(409);
  });
});

describe("listCommunities", () => {
  const row = { id: COMMUNITY, slug: "study-hall", visibility: "public" };

  it("requests limit+1 rows and reports has_more", async () => {
    const { client, log } = fakeDb([
      { data: [row, { ...row, id: "second" }] },
    ]);
    const page = await listCommunities(client, { limit: 1 });
    expect(page.communities).toHaveLength(1);
    expect(page.has_more).toBe(true);
    expect(log.some((e) => e.kind === "method" && e.name === "limit")).toBe(
      true,
    );
  });

  it("filters by category and search text when given", async () => {
    const { client, log } = fakeDb([{ data: [] }]);
    const page = await listCommunities(client, {
      category: "exams",
      q: "jee",
      limit: 20,
    });
    expect(page).toEqual({ communities: [], has_more: false });
    const methods = log.filter((e) => e.kind === "method").map((e) => e.name);
    expect(methods).toContain("eq");
    expect(methods).toContain("or");
  });

  it("surfaces lookup failures as plain errors", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "down" } }]);
    await expect(listCommunities(client, { limit: 5 })).rejects.toThrow(
      "community list failed: down",
    );
  });
});

describe("getCommunity", () => {
  it("returns the row or a not_found CommunityError", async () => {
    const { client } = fakeDb([{ data: { id: COMMUNITY, slug: "s" } }]);
    await expect(getCommunity(client, COMMUNITY)).resolves.toEqual({
      id: COMMUNITY,
      slug: "s",
    });

    const { client: missing } = fakeDb([{ data: null, error: null }]);
    await expect(getCommunity(missing, COMMUNITY)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });

    const { client: broken } = fakeDb([
      { data: null, error: { message: "down" } },
    ]);
    await expect(getCommunity(broken, COMMUNITY)).rejects.toThrow(
      "community lookup failed: down",
    );
  });
});

describe("listCommunityMembers", () => {
  it("returns roster rows from the community_roster RPC with aliases preserved", async () => {
    const { client, log } = fakeDb([
      {
        data: [
          { user_id: "u1", role: "owner", status: "active", joined_at: "t1", alias: "Ada" },
          { user_id: "u2", role: "member", status: "active", joined_at: "t2", alias: "Bo" },
          { user_id: "u3", role: "member", status: "active", joined_at: "t3", alias: null },
        ],
      },
    ]);
    const members = await listCommunityMembers(client, COMMUNITY);
    expect(members.map((m) => m.alias)).toEqual(["Ada", "Bo", null]);
    expect(log).toContainEqual({
      kind: "rpc",
      name: "community_roster",
      args: [{ p_community_id: COMMUNITY, p_include_requested: false }],
    });
  });

  it("asks the RPC for requested rows only on request", async () => {
    const { client: activeOnly, log } = fakeDb([{ data: [] }]);
    await listCommunityMembers(activeOnly, COMMUNITY);
    expect(log).toContainEqual({
      kind: "rpc",
      name: "community_roster",
      args: [{ p_community_id: COMMUNITY, p_include_requested: false }],
    });

    const { client: withRequested, log: log2 } = fakeDb([{ data: [] }]);
    await listCommunityMembers(withRequested, COMMUNITY, {
      includeRequested: true,
    });
    expect(log2).toContainEqual({
      kind: "rpc",
      name: "community_roster",
      args: [{ p_community_id: COMMUNITY, p_include_requested: true }],
    });
  });

  it("surfaces lookup failures", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "down" } }]);
    await expect(listCommunityMembers(client, COMMUNITY)).rejects.toThrow(
      "member list failed: down",
    );
  });
});

describe("channel queries", () => {
  it("lists channels and surfaces failures", async () => {
    const { client } = fakeDb([{ data: [{ id: CHANNEL }] }]);
    await expect(listCommunityChannels(client, COMMUNITY)).resolves.toEqual([
      { id: CHANNEL },
    ]);

    const { client: broken } = fakeDb([
      { data: null, error: { message: "down" } },
    ]);
    await expect(listCommunityChannels(broken, COMMUNITY)).rejects.toThrow(
      "channel list failed: down",
    );
  });

  it("returns one channel or a channel-specific not_found", async () => {
    const { client } = fakeDb([{ data: { id: CHANNEL, community_id: COMMUNITY } }]);
    await expect(
      getCommunityChannel(client, COMMUNITY, CHANNEL),
    ).resolves.toMatchObject({ id: CHANNEL });

    const { client: missing } = fakeDb([{ data: null, error: null }]);
    await expect(
      getCommunityChannel(missing, COMMUNITY, CHANNEL),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "That channel does not exist.",
    });

    const { client: broken } = fakeDb([
      { data: null, error: { message: "down" } },
    ]);
    await expect(
      getCommunityChannel(broken, COMMUNITY, CHANNEL),
    ).rejects.toThrow("channel lookup failed: down");
  });
});

describe("createCommunity", () => {
  const input = {
    slug: "study-hall",
    name: "Study Hall",
    description: "",
    category: "study",
    visibility: "public",
    joinPolicy: "open",
    rules: "",
  };

  it("runs the RPC then returns the fresh row", async () => {
    const { client, log } = fakeDb([
      { data: COMMUNITY },
      { data: { id: COMMUNITY, slug: "study-hall" } },
    ]);
    const created = await createCommunity(client, input);
    expect(created).toEqual({ id: COMMUNITY, slug: "study-hall" });
    const rpc = log.find((e) => e.kind === "rpc");
    expect(rpc?.name).toBe("create_community");
    expect((rpc?.args[0] as Record<string, string>).p_slug).toBe("study-hall");
  });

  it("maps duplicate slugs to slug_taken/409 and other failures to 500s", async () => {
    const { client: taken } = fakeDb([
      { data: null, error: { message: "duplicate key value violates constraint" } },
    ]);
    await expect(createCommunity(taken, input)).rejects.toMatchObject({
      code: "slug_taken",
      status: 409,
    });

    const { client: broken } = fakeDb([
      { data: null, error: { message: "down" } },
    ]);
    await expect(createCommunity(broken, input)).rejects.toThrow(
      "community create failed: down",
    );
  });
});

describe("updateCommunity", () => {
  it("applies the patch and returns the row", async () => {
    const { client, log } = fakeDb([
      { data: { id: COMMUNITY, name: "Renamed" } },
    ]);
    const updated = await updateCommunity(client, COMMUNITY, { name: "Renamed" });
    expect(updated).toMatchObject({ name: "Renamed" });
    const patch = log.find((e) => e.kind === "method" && e.name === "update");
    expect(patch).toBeDefined();
    expect((patch!.args[0] as Record<string, unknown>).name).toBe("Renamed");
  });

  it("maps duplicate, missing and failed updates", async () => {
    const { client: taken } = fakeDb([
      { data: null, error: { message: "duplicate key value" } },
    ]);
    await expect(
      updateCommunity(taken, COMMUNITY, { slug: "x" }),
    ).rejects.toMatchObject({ code: "slug_taken", status: 409 });

    const { client: missing } = fakeDb([{ data: null, error: null }]);
    await expect(
      updateCommunity(missing, COMMUNITY, { name: "x" }),
    ).rejects.toMatchObject({ code: "not_found" });

    const { client: broken } = fakeDb([
      { data: null, error: { message: "down" } },
    ]);
    await expect(
      updateCommunity(broken, COMMUNITY, { name: "x" }),
    ).rejects.toThrow("community update failed: down");
  });
});

describe("membership RPCs", () => {
  it("joinCommunity distinguishes active, requested, missing, banned, failed", async () => {
    const { client: active } = fakeDb([{ data: "active" }]);
    await expect(joinCommunity(active, COMMUNITY)).resolves.toBe("active");

    const { client: requested } = fakeDb([{ data: "requested" }]);
    await expect(joinCommunity(requested, COMMUNITY)).resolves.toBe("requested");

    const { client: missing } = fakeDb([
      { data: null, error: { message: "community_not_found" } },
    ]);
    await expect(joinCommunity(missing, COMMUNITY)).rejects.toMatchObject({
      code: "not_found",
    });

    const { client: banned } = fakeDb([
      { data: null, error: { message: "membership_banned" } },
    ]);
    await expect(joinCommunity(banned, COMMUNITY)).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });

    const { client: broken } = fakeDb([
      { data: null, error: { message: "down" } },
    ]);
    await expect(joinCommunity(broken, COMMUNITY)).rejects.toThrow(
      "community join failed: down",
    );
  });

  it("leaveCommunity distinguishes ok, missing, owner and failed", async () => {
    const { client: ok } = fakeDb([{ data: null, error: null }]);
    await expect(leaveCommunity(ok, COMMUNITY)).resolves.toBeUndefined();

    const { client: missing } = fakeDb([
      { data: null, error: { message: "community_not_found" } },
    ]);
    await expect(leaveCommunity(missing, COMMUNITY)).rejects.toMatchObject({
      code: "not_found",
    });

    const { client: owner } = fakeDb([
      { data: null, error: { message: "owner_cannot_leave" } },
    ]);
    await expect(leaveCommunity(owner, COMMUNITY)).rejects.toMatchObject({
      code: "owner_cannot_leave",
      status: 409,
    });

    const { client: broken } = fakeDb([
      { data: null, error: { message: "down" } },
    ]);
    await expect(leaveCommunity(broken, COMMUNITY)).rejects.toThrow(
      "community leave failed: down",
    );
  });

  it("setCommunityMember maps every RPC guard", async () => {
    const { client: ok, log } = fakeDb([{ data: null, error: null }]);
    await setCommunityMember(ok, COMMUNITY, USER, {
      role: "moderator",
      status: null,
    });
    const args = log.find((e) => e.kind === "rpc")?.args[0] as Record<
      string,
      unknown
    >;
    expect(args).toMatchObject({
      p_user_id: USER,
      p_role: "moderator",
      p_status: null,
    });

    const cases: Array<[string, Record<string, unknown>]> = [
      ["member_not_found", { code: "not_found" }],
      ["owner_protected", { code: "owner_protected", status: 409 }],
      ["not_owner", { code: "forbidden", status: 403 }],
      ["not_staff", { code: "forbidden", status: 403 }],
      ["not_authenticated", { code: "forbidden", status: 403 }],
    ];
    for (const [needle, expected] of cases) {
      const { client } = fakeDb([
        { data: null, error: { message: needle } },
      ]);
      await expect(
        setCommunityMember(client, COMMUNITY, USER, { role: null }),
      ).rejects.toMatchObject(expected);
    }

    const { client: broken } = fakeDb([
      { data: null, error: { message: "down" } },
    ]);
    await expect(
      setCommunityMember(broken, COMMUNITY, USER, { role: null }),
    ).rejects.toThrow("member update failed: down");
  });
});

describe("listCommunityMessages", () => {
  const row = (seq: number) => ({ id: `m${seq}`, seq });

  it("pages newest-first and reports has_more", async () => {
    const { client } = fakeDb([{ data: [row(3), row(2), row(1)] }]);
    const page = await listCommunityMessages(client, CHANNEL, { limit: 2 });
    expect(page.messages.map((m) => m.seq)).toEqual([3, 2]);
    expect(page.has_more).toBe(true);
  });

  it("adds the before cursor only when asked", async () => {
    const { client: first, log } = fakeDb([{ data: [row(1)] }]);
    await listCommunityMessages(first, CHANNEL, { limit: 50 });
    expect(log.some((e) => e.kind === "method" && e.name === "lt")).toBe(false);

    const { client: paged, log: log2 } = fakeDb([{ data: [] }]);
    const empty = await listCommunityMessages(paged, CHANNEL, {
      limit: 50,
      before: 10,
    });
    expect(empty).toEqual({ messages: [], has_more: false });
    expect(log2.some((e) => e.kind === "method" && e.name === "lt")).toBe(true);
  });

  it("surfaces lookup failures", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "down" } }]);
    await expect(
      listCommunityMessages(client, CHANNEL, { limit: 5 }),
    ).rejects.toThrow("message list failed: down");
  });
});

describe("appendCommunityMessage", () => {
  const input = {
    channelId: CHANNEL,
    communityId: COMMUNITY,
    senderId: USER,
    senderDeviceId: "device-12345678",
    kind: "application" as const,
    ciphertext: "AAAA",
    clientMsgId: MSG_ID,
  };

  it("is idempotent: an existing row short-circuits the insert", async () => {
    const { client, log } = fakeDb([
      { data: { id: "existing", client_msg_id: MSG_ID } },
    ]);
    const row = await appendCommunityMessage(client, input);
    expect(row.id).toBe("existing");
    expect(log.some((e) => e.kind === "method" && e.name === "insert")).toBe(
      false,
    );
  });

  it("inserts a fresh envelope", async () => {
    const { client, log } = fakeDb([
      { data: null, error: null },
      { data: { id: "new", client_msg_id: MSG_ID } },
    ]);
    const row = await appendCommunityMessage(client, input);
    expect(row.id).toBe("new");
    const insert = log.find((e) => e.kind === "method" && e.name === "insert");
    expect((insert!.args[0] as Record<string, unknown>)).toMatchObject({
      channel_id: CHANNEL,
      kind: "application",
      client_msg_id: MSG_ID,
    });
  });

  it("treats a unique-violation race as the idempotent success it is", async () => {
    const { client } = fakeDb([
      { data: null, error: null },
      { data: null, error: { message: "conflict", code: "23505" } },
      { data: { id: "raced", client_msg_id: MSG_ID } },
    ]);
    const row = await appendCommunityMessage(client, input);
    expect(row.id).toBe("raced");
  });

  it("fails with message_create_failed when the race resolves to nothing", async () => {
    const { client } = fakeDb([
      { data: null, error: null },
      { data: null, error: { message: "conflict", code: "23505" } },
      { data: null, error: null },
    ]);
    await expect(appendCommunityMessage(client, input)).rejects.toMatchObject({
      code: "message_create_failed",
      status: 500,
    });

    const { client: broken } = fakeDb([
      { data: null, error: null },
      { data: null, error: { message: "down" } },
    ]);
    await expect(appendCommunityMessage(broken, input)).rejects.toMatchObject({
      code: "message_create_failed",
    });
  });
});

describe("welcomes", () => {
  it("lists pending welcomes, optionally scoped to channels", async () => {
    const { client: all, log } = fakeDb([{ data: [{ id: "w1" }] }]);
    const rows = await listPendingWelcomes(all, USER);
    expect(rows).toHaveLength(1);
    expect(log.some((e) => e.kind === "method" && e.name === "in")).toBe(false);

    const { client: scoped, log: log2 } = fakeDb([{ data: [] }]);
    await listPendingWelcomes(scoped, USER, { channelIds: [CHANNEL] });
    expect(log2.some((e) => e.kind === "method" && e.name === "in")).toBe(true);

    const { client: broken } = fakeDb([
      { data: null, error: { message: "down" } },
    ]);
    await expect(listPendingWelcomes(broken, USER)).rejects.toThrow(
      "welcome list failed: down",
    );
  });

  it("appendCommunityWelcome is idempotent, inserts fresh, and maps races", async () => {
    const input = {
      channelId: CHANNEL,
      communityId: COMMUNITY,
      recipientUserId: USER,
      recipientDeviceId: "device-12345678",
      senderId: USER,
      ciphertext: "AAAA",
      ratchetTree: "BBBB",
      clientMsgId: MSG_ID,
    };

    const { client: existing } = fakeDb([
      { data: { id: "w-existing" } },
    ]);
    await expect(appendCommunityWelcome(existing, input)).resolves.toEqual({
      id: "w-existing",
    });

    const { client: fresh } = fakeDb([
      { data: null, error: null },
      { data: { id: "w-new" } },
    ]);
    await expect(appendCommunityWelcome(fresh, input)).resolves.toEqual({
      id: "w-new",
    });

    const { client: raced } = fakeDb([
      { data: null, error: null },
      { data: null, error: { message: "conflict", code: "23505" } },
      { data: { id: "w-raced" } },
    ]);
    await expect(appendCommunityWelcome(raced, input)).resolves.toEqual({
      id: "w-raced",
    });

    const { client: raceMiss } = fakeDb([
      { data: null, error: null },
      { data: null, error: { message: "conflict", code: "23505" } },
      { data: null, error: null },
    ]);
    await expect(appendCommunityWelcome(raceMiss, input)).rejects.toMatchObject(
      { code: "welcome_create_failed", status: 500 },
    );

    const { client: broken } = fakeDb([
      { data: null, error: null },
      { data: null, error: { message: "down" } },
    ]);
    await expect(appendCommunityWelcome(broken, input)).rejects.toMatchObject({
      code: "welcome_create_failed",
    });
  });
});

describe("device and key package queries", () => {
  it("registerCommunityDevice upserts and maps failures", async () => {
    const { client, log } = fakeDb([{ data: { device_id: "device-12345678" } }]);
    const row = await registerCommunityDevice(client, USER, {
      deviceId: "device-12345678",
      keyPackage: "AAAA",
      signaturePublicKey: "BBBB",
    });
    expect(row).toEqual({ device_id: "device-12345678" });
    expect(log.some((e) => e.kind === "method" && e.name === "upsert")).toBe(
      true,
    );

    const { client: broken } = fakeDb([
      { data: null, error: { message: "down" } },
    ]);
    await expect(
      registerCommunityDevice(broken, USER, {
        deviceId: "device-12345678",
        keyPackage: "AAAA",
        signaturePublicKey: "BBBB",
      }),
    ).rejects.toMatchObject({ code: "device_register_failed", status: 500 });
  });

  it("fetchCommunityKeyPackages returns rows or fails loudly", async () => {
    const { client, log } = fakeDb([{ data: [{ device_id: "d1" }] }]);
    const rows = await fetchCommunityKeyPackages(client, [USER]);
    expect(rows).toHaveLength(1);
    const limit = log.find((e) => e.kind === "method" && e.name === "limit");
    expect(limit?.args[0]).toBe(3);

    const { client: broken } = fakeDb([
      { data: null, error: { message: "down" } },
    ]);
    await expect(fetchCommunityKeyPackages(broken, [USER])).rejects.toThrow(
      "key package fetch failed: down",
    );
  });

  it("listActiveMemberIds maps rows to ids or fails", async () => {
    const { client } = fakeDb([
      { data: [{ user_id: "u1" }, { user_id: "u2" }] },
    ]);
    await expect(listActiveMemberIds(client, COMMUNITY)).resolves.toEqual([
      "u1",
      "u2",
    ]);

    const { client: broken } = fakeDb([
      { data: null, error: { message: "down" } },
    ]);
    await expect(listActiveMemberIds(broken, COMMUNITY)).rejects.toThrow(
      "member ids failed: down",
    );
  });
});

describe("attachments and reports", () => {
  const attachmentInput = {
    communityId: COMMUNITY,
    channelId: CHANNEL,
    uploaderId: USER,
    storagePath: `community-attachments/${COMMUNITY}/${CHANNEL}/${MSG_ID}`,
    ciphertextSize: 1024,
    contentType: "application/octet-stream",
  };

  it("creates attachment records or maps failures", async () => {
    const { client } = fakeDb([{ data: { id: MSG_ID } }]);
    await expect(
      createCommunityAttachment(client, attachmentInput),
    ).resolves.toEqual({ id: MSG_ID });

    const { client: broken } = fakeDb([
      { data: null, error: { message: "down" } },
    ]);
    await expect(
      createCommunityAttachment(broken, attachmentInput),
    ).rejects.toMatchObject({ code: "attachment_create_failed", status: 500 });
  });

  it("looks up attachments or returns not_found", async () => {
    const { client } = fakeDb([{ data: { id: MSG_ID, ciphertext_size: 10 } }]);
    await expect(
      getCommunityAttachment(client, COMMUNITY, MSG_ID),
    ).resolves.toMatchObject({ id: MSG_ID });

    const { client: missing } = fakeDb([{ data: null, error: null }]);
    await expect(
      getCommunityAttachment(missing, COMMUNITY, MSG_ID),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "That attachment does not exist.",
    });

    const { client: broken } = fakeDb([
      { data: null, error: { message: "down" } },
    ]);
    await expect(
      getCommunityAttachment(broken, COMMUNITY, MSG_ID),
    ).rejects.toThrow("attachment lookup failed: down");
  });

  it("files reports or maps failures", async () => {
    const input = {
      communityId: COMMUNITY,
      reporterId: USER,
      targetType: "message" as const,
      targetId: MSG_ID,
      reason: "spam",
      contextExcerpt: null,
    };
    const { client } = fakeDb([{ data: { id: "r1" } }]);
    await expect(createCommunityReport(client, input)).resolves.toEqual({
      id: "r1",
    });

    const { client: broken } = fakeDb([
      { data: null, error: { message: "down" } },
    ]);
    await expect(createCommunityReport(broken, input)).rejects.toMatchObject({
      code: "report_create_failed",
      status: 500,
    });
  });
});
