import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CommunityAccessError,
  requireCommunityMembership,
  requireCommunityOwner,
  requireCommunityStaff,
  requireCommunityVisibility,
} from "@/lib/communities/access";

const COMMUNITY = "0b2f9c1e-3d4a-4b5c-8e6f-7a8b9c0d1e2f";
const USER = "1c3d0a2f-4e5b-4c6d-9f70-8b9c0d1e2f30";

type Result = { data: unknown; error?: { message: string } | null };

/** Minimal chainable fake: `from().select().eq().eq().maybeSingle()` pops the
 * queued result for that table, so each test scripts the exact answers. */
function fakeClient(tables: Record<string, Result[]>): SupabaseClient {
  const queues = new Map<string, Result[]>(
    Object.entries(tables).map(([table, results]) => [table, [...results]]),
  );
  const client = {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => queues.get(table)?.shift() ?? { data: null, error: null },
      };
      return chain;
    },
  };
  return client as unknown as SupabaseClient;
}

async function expectAccessError(
  promise: Promise<unknown>,
  code: string,
  status: number,
): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CommunityAccessError);
  expect((error as CommunityAccessError).code).toBe(code);
  expect((error as CommunityAccessError).status).toBe(status);
}

describe("requireCommunityMembership", () => {
  it("returns the role for an active member", async () => {
    const client = fakeClient({
      community_members: [{ data: { role: "moderator", status: "active" } }],
    });
    await expect(
      requireCommunityMembership(client, COMMUNITY, USER),
    ).resolves.toEqual({
      communityId: COMMUNITY,
      role: "moderator",
      status: "active",
    });
  });

  it("answers 404 not_found for missing, requested and banned rows alike", async () => {
    const cases: Result[] = [
      { data: null, error: null },
      { data: { role: "member", status: "requested" } },
      { data: { role: "member", status: "banned" } },
    ];
    for (const result of cases) {
      const client = fakeClient({ community_members: [result] });
      await expectAccessError(
        requireCommunityMembership(client, COMMUNITY, USER),
        "not_found",
        404,
      );
    }
  });

  it("surfaces lookup failures as plain errors (not access results)", async () => {
    const client = fakeClient({
      community_members: [{ data: null, error: { message: "boom" } }],
    });
    await expect(
      requireCommunityMembership(client, COMMUNITY, USER),
    ).rejects.toThrow("membership lookup failed: boom");
  });
});

describe("requireCommunityStaff / requireCommunityOwner", () => {
  it("passes owners and moderators through staff, blocks plain members", async () => {
    for (const role of ["owner", "moderator"]) {
      const client = fakeClient({
        community_members: [{ data: { role, status: "active" } }],
      });
      await expect(
        requireCommunityStaff(client, COMMUNITY, USER),
      ).resolves.toMatchObject({ role });
    }
    const member = fakeClient({
      community_members: [{ data: { role: "member", status: "active" } }],
    });
    await expectAccessError(
      requireCommunityStaff(member, COMMUNITY, USER),
      "forbidden",
      403,
    );
  });

  it("staff lets only the owner through owner checks", async () => {
    const owner = fakeClient({
      community_members: [{ data: { role: "owner", status: "active" } }],
    });
    await expect(
      requireCommunityOwner(owner, COMMUNITY, USER),
    ).resolves.toMatchObject({ role: "owner" });

    const moderator = fakeClient({
      community_members: [{ data: { role: "moderator", status: "active" } }],
    });
    await expectAccessError(
      requireCommunityOwner(moderator, COMMUNITY, USER),
      "forbidden",
      403,
    );
  });

  it("inherits the membership 404 (staff checks are not existence oracles)", async () => {
    const none = fakeClient({ community_members: [{ data: null, error: null }] });
    await expectAccessError(
      requireCommunityStaff(none, COMMUNITY, USER),
      "not_found",
      404,
    );
  });
});

describe("requireCommunityVisibility", () => {
  it("opens public communities to everyone and reports their role if any", async () => {
    const visitor = fakeClient({
      communities: [{ data: { visibility: "public" } }],
      community_members: [{ data: null, error: null }],
    });
    await expect(
      requireCommunityVisibility(visitor, COMMUNITY, USER),
    ).resolves.toEqual({ visibility: "public", role: null });

    const member = fakeClient({
      communities: [{ data: { visibility: "public" } }],
      community_members: [{ data: { role: "member" } }],
    });
    await expect(
      requireCommunityVisibility(member, COMMUNITY, USER),
    ).resolves.toEqual({ visibility: "public", role: "member" });
  });

  it("requires active membership for private communities", async () => {
    const active = fakeClient({
      communities: [{ data: { visibility: "private" } }],
      community_members: [{ data: { role: "owner", status: "active" } }],
    });
    await expect(
      requireCommunityVisibility(active, COMMUNITY, USER),
    ).resolves.toEqual({ visibility: "private", role: "owner" });

    for (const membership of [
      { data: null, error: null },
      { data: { role: "member", status: "requested" } },
      { data: { role: "member", status: "banned" } },
    ]) {
      const outsider = fakeClient({
        communities: [{ data: { visibility: "private" } }],
        community_members: [membership],
      });
      await expectAccessError(
        requireCommunityVisibility(outsider, COMMUNITY, USER),
        "not_found",
        404,
      );
    }
  });

  it("404s unknown communities and surfaces lookup failures", async () => {
    const missing = fakeClient({ communities: [{ data: null, error: null }] });
    await expectAccessError(
      requireCommunityVisibility(missing, COMMUNITY, USER),
      "not_found",
      404,
    );

    const broken = fakeClient({
      communities: [{ data: null, error: { message: "down" } }],
    });
    await expect(
      requireCommunityVisibility(broken, COMMUNITY, USER),
    ).rejects.toThrow("community lookup failed: down");
  });
});
