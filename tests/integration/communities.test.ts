import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createProfile } from "@/lib/profiles/queries";
import { GET as communitiesGet, POST as communitiesPost } from "@/app/api/communities/route";
import {
  DELETE as communityDelete,
  GET as communityGet,
} from "@/app/api/communities/[id]/route";
import { GET as channelsGet, POST as channelsPost } from "@/app/api/communities/[id]/channels/route";
import {
  GET as messagesGet,
  POST as messagesPost,
} from "@/app/api/communities/[id]/channels/[channelId]/messages/route";
import { POST as channelWelcomesPost } from "@/app/api/communities/[id]/channels/[channelId]/welcomes/route";
import { GET as welcomesGet } from "@/app/api/communities/[id]/welcomes/route";
import { POST as joinPost } from "@/app/api/communities/[id]/join/route";
import { POST as leavePost } from "@/app/api/communities/[id]/leave/route";
import { GET as membersGet } from "@/app/api/communities/[id]/members/route";
import { DELETE as memberDelete, PATCH as memberPatch } from "@/app/api/communities/[id]/members/[userId]/route";
import { GET as syncGet } from "@/app/api/communities/[id]/sync/route";
import { POST as devicePost } from "@/app/api/communities/devices/route";
import { POST as keysFetchPost } from "@/app/api/communities/devices/fetch/route";
import { POST as reportPost } from "@/app/api/communities/[id]/reports/route";
import { POST as attachmentsPost } from "@/app/api/communities/[id]/attachments/route";
import { GET as attachmentDownload } from "@/app/api/communities/[id]/attachments/[attachmentId]/route";
import { psql } from "./helpers/admin";
import {
  callApi,
  callApiWithParams,
  errorOf,
  readJson,
  withoutRequestId,
} from "./helpers/api";
import { clearCookies, seedSession } from "./helpers/cookie-jar";
import { integrationEnv } from "./helpers/env";
import { createUser, deleteUsers, uniqueAlias, type TestUser } from "./helpers/users";

function anonClient(): SupabaseClient {
  const { apiUrl, publishableKey } = integrationEnv();
  return createClient(apiUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

type Community = {
  id: string;
  slug: string;
  name: string;
  member_count: number;
  visibility: string;
};

type Channel = { id: string; slug: string; position: number };

const CIPHERTEXT = "QUFBQUFBQUFBQUFBQUFBQQ==";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    kind: "application",
    ciphertext: CIPHERTEXT,
    clientMsgId: randomUUID(),
    senderDeviceId: "device-sender-001",
    ...overrides,
  };
}

describe("communities: RLS, RPCs and the API surface", () => {
  let anon: SupabaseClient;
  let owner: TestUser;
  let outsider: TestUser;
  let joiner: TestUser;
  let kickee: TestUser;
  const tag = Date.now().toString(36);

  let community1: Community;
  let community2: Community;
  let general1: Channel;
  let general2: Channel;
  let firstMessageId: string;

  async function createCommunity(
    user: TestUser,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    await seedSession(user.email, user.password);
    const response = await callApi(communitiesPost, {
      path: "/api/communities",
      method: "POST",
      body,
    });
    return { status: response.status, body: await readJson(response) };
  }

  async function ownerCount(communityId: string): Promise<number> {
    await seedSession(owner.email, owner.password);
    const response = await callApiWithParams(communityGet, { path: `/api/communities/${communityId}` }, { id: communityId });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    return (body.community as Community).member_count;
  }

  beforeAll(async () => {
    anon = anonClient();
    [owner, outsider, joiner, kickee] = await Promise.all([
      createUser("comm-owner"),
      createUser("comm-outsider"),
      createUser("comm-joiner"),
      createUser("comm-kickee"),
    ]);
    await Promise.all(
      [owner, outsider, joiner, kickee].map((user, index) =>
        createProfile(user.client, user.id, uniqueAlias(`Cm${index}`)),
      ),
    );

    const created1 = await createCommunity(owner, {
      slug: `alpha-${tag}`,
      name: `Alpha ${tag}`,
      category: "study",
      visibility: "public",
      joinPolicy: "open",
      description: "A public community",
    });
    expect(created1.status).toBe(201);
    community1 = created1.body.community as Community;

    const created2 = await createCommunity(owner, {
      slug: `hidden-${tag}`,
      name: `Hidden ${tag}`,
      category: "exams",
      visibility: "private",
      joinPolicy: "request",
    });
    expect(created2.status).toBe(201);
    community2 = created2.body.community as Community;

    await seedSession(owner.email, owner.password);
    const channels1 = await readJson(
      await callApiWithParams(channelsGet, { path: `/api/communities/${community1.id}/channels` }, { id: community1.id }),
    );
    general1 = (channels1.channels as Channel[])[0];
    const channels2 = await readJson(
      await callApiWithParams(channelsGet, { path: `/api/communities/${community2.id}/channels` }, { id: community2.id }),
    );
    general2 = (channels2.channels as Channel[])[0];
  });

  afterAll(async () => {
    await deleteUsers([owner, outsider, joiner, kickee]);
  });

  describe("grant, policy and publication surface", () => {
    it("holds community_members at SELECT alone for authenticated", () => {
      expect(psql("select has_table_privilege('authenticated', 'public.community_members', 'select');")).toBe("t");
      expect(psql("select has_table_privilege('authenticated', 'public.community_members', 'insert');")).toBe("f");
      expect(psql("select has_table_privilege('authenticated', 'public.community_members', 'update');")).toBe("f");
      expect(psql("select has_table_privilege('authenticated', 'public.community_members', 'delete');")).toBe("f");
    });

    it("keeps the owner-only DELETE grant on communities and the definer RPC surface", () => {
      expect(psql("select has_table_privilege('authenticated', 'public.communities', 'delete');")).toBe("t");
      expect(
        psql(
          "select count(*) from pg_policies where schemaname = 'public' " +
            "and tablename = 'community_members' and policyname = 'members_select_own_or_roster';",
        ),
      ).toBe("1");
      expect(
        psql(
          "select count(*) from pg_policies where schemaname = 'public' " +
            "and tablename = 'community_members';",
        ),
      ).toBe("1");
      const rpcs: Array<[string, string]> = [
        ["create_community", "text,text,text,text,text,text,text"],
        ["join_community", "uuid"],
        ["leave_community", "uuid"],
        ["set_community_member", "uuid,uuid,text,text"],
        ["kick_community_member", "uuid,uuid"],
        ["community_roster", "uuid,boolean"],
      ];
      for (const [fn, args] of rpcs) {
        expect(
          psql(
            `select has_function_privilege('authenticated', 'public.${fn}(${args})', 'execute');`,
          ),
        ).toBe("t");
        expect(
          psql(`select has_function_privilege('anon', 'public.${fn}(${args})', 'execute');`),
        ).toBe("f");
      }
    });

    it("keeps exactly the three community storage policies", () => {
      expect(
        psql(
          "select count(*) from pg_policies where schemaname = 'storage' " +
            "and tablename = 'objects' and policyname like 'community_attachments%';",
        ),
      ).toBe("3");
      for (const name of [
        "community_attachments_select_member",
        "community_attachments_insert_member",
        "community_attachments_delete_uploader",
      ]) {
        expect(
          psql(
            `select count(*) from pg_policies where schemaname = 'storage' and policyname = '${name}';`,
          ),
        ).toBe("1");
      }
    });

    it("publishes community_messages to realtime and denies anon table access", async () => {
      expect(
        psql(
          "select count(*) from pg_publication_tables where pubname = 'supabase_realtime' " +
            "and schemaname = 'public' and tablename = 'community_messages';",
        ),
      ).toBe("1");
      const { data, error } = await anon.from("communities").select("id");
      expect(data).toBeNull();
      expect(error?.code).toBe("42501");
      const devices = await anon.from("community_devices").select("device_id");
      expect(devices.data).toBeNull();
      expect(devices.error?.code).toBe("42501");
    });
  });

  describe("creation and discovery", () => {
    it("answers 401 to signed-out create and list", async () => {
      clearCookies();
      const created = await callApi(communitiesPost, {
        path: "/api/communities",
        method: "POST",
        body: { slug: `anon-${tag}`, name: "Anon" },
      });
      expect(created.status).toBe(401);

      const listed = await callApi(communitiesGet, { path: "/api/communities" });
      expect(listed.status).toBe(401);
    });

    it("refuses malformed and hostile create bodies before any rate-limit slot", async () => {
      await seedSession(outsider.email, outsider.password);

      const badJson = await callApi(communitiesPost, {
        path: "/api/communities",
        method: "POST",
        rawBody: "{",
      });
      expect(badJson.status).toBe(400);
      expect(errorOf(await readJson(badJson)).code).toBe("invalid_json");

      const badSlug = await callApi(communitiesPost, {
        path: "/api/communities",
        method: "POST",
        body: { slug: "No Spaces Allowed", name: "Bad" },
      });
      expect(badSlug.status).toBe(400);

      const privateOpen = await callApi(communitiesPost, {
        path: "/api/communities",
        method: "POST",
        body: { slug: `bad-${tag}`, name: "Bad", visibility: "private", joinPolicy: "open" },
      });
      expect(privateOpen.status).toBe(400);

      const smuggledOwner = await callApi(communitiesPost, {
        path: "/api/communities",
        method: "POST",
        body: { slug: `smug-${tag}`, name: "Smug", owner_id: randomUUID() },
      });
      expect(smuggledOwner.status).toBe(400);
      expect(errorOf(await readJson(smuggledOwner)).issues?.[0]?.message).toContain(
        "owner_id",
      );
    });

    it("maps a duplicate slug to 409 and keeps private rows out of every list", async () => {
      const duplicate = await createCommunity(owner, {
        slug: community1.slug,
        name: `Alpha again ${tag}`,
      });
      expect(duplicate.status).toBe(409);
      expect(errorOf(duplicate.body).code).toBe("slug_taken");

      await seedSession(outsider.email, outsider.password);
      const outsiderList = await readJson(
        await callApi(communitiesGet, { path: "/api/communities" }),
      );
      const outsiderSlugs = (outsiderList.communities as Community[]).map((row) => row.slug);
      expect(outsiderSlugs).toContain(community1.slug);
      expect(outsiderSlugs).not.toContain(community2.slug);

      await seedSession(owner.email, owner.password);
      const ownerList = await readJson(
        await callApi(communitiesGet, { path: "/api/communities" }),
      );
      const ownerSlugs = (ownerList.communities as Community[]).map((row) => row.slug);
      expect(ownerSlugs).toContain(community1.slug);
      expect(ownerSlugs).not.toContain(community2.slug);

      const filtered = await readJson(
        await callApi(communitiesGet, { path: `/api/communities?q=Alpha ${tag}` }),
      );
      expect((filtered.communities as Community[]).map((row) => row.id)).toEqual([community1.id]);

      const badLimit = await callApi(communitiesGet, { path: "/api/communities?limit=0" });
      expect(badLimit.status).toBe(400);
    });
  });

  describe("single view and 404 parity", () => {
    it("gives any signed-in user the public row and their own membership", async () => {
      await seedSession(outsider.email, outsider.password);
      const response = await callApiWithParams(
        communityGet,
        { path: `/api/communities/${community1.id}` },
        { id: community1.id },
      );
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect((body.community as Community).slug).toBe(community1.slug);
      expect(body.visibility).toBe("public");
      expect(body.membership).toBeNull();
    });

    it("makes a private community indistinguishable from a missing one", async () => {
      const missingId = randomUUID();
      await seedSession(outsider.email, outsider.password);
      const hidden = await callApiWithParams(
        communityGet,
        { path: `/api/communities/${community2.id}` },
        { id: community2.id },
      );
      const missing = await callApiWithParams(
        communityGet,
        { path: `/api/communities/${missingId}` },
        { id: missingId },
      );
      expect(hidden.status).toBe(404);
      expect(missing.status).toBe(404);
      const hiddenBody = await readJson(hidden);
      expect(errorOf(hiddenBody).code).toBe("not_found");
      expect(withoutRequestId(hiddenBody)).toEqual(
        withoutRequestId(await readJson(missing)),
      );

      const malformed = await callApiWithParams(
        communityGet,
        { path: "/api/communities/nope" },
        { id: "nope" },
      );
      expect(malformed.status).toBe(400);
    });
  });

  describe("join flows", () => {
    it("hides channel listings from non-members with the same 404", async () => {
      await seedSession(outsider.email, outsider.password);
      const beforeJoin = await callApiWithParams(
        channelsGet,
        { path: `/api/communities/${community1.id}/channels` },
        { id: community1.id },
      );
      expect(beforeJoin.status).toBe(404);

      const missing = await callApiWithParams(
        channelsGet,
        { path: `/api/communities/${randomUUID()}/channels` },
        { id: randomUUID() },
      );
      expect(missing.status).toBe(404);
    });

    it("joins an open community exactly once and files a request on the private one", async () => {
      await seedSession(outsider.email, outsider.password);
      const join = await callApiWithParams(
        joinPost,
        { path: `/api/communities/${community1.id}/join`, method: "POST", body: {} },
        { id: community1.id },
      );
      expect(join.status).toBe(200);
      expect((await readJson(join)).status).toBe("active");
      expect(await ownerCount(community1.id)).toBe(2);

      await seedSession(outsider.email, outsider.password);
      const repeat = await callApiWithParams(
        joinPost,
        { path: `/api/communities/${community1.id}/join`, method: "POST", body: {} },
        { id: community1.id },
      );
      expect(repeat.status).toBe(200);
      expect((await readJson(repeat)).status).toBe("active");
      expect(await ownerCount(community1.id)).toBe(2);

      await seedSession(outsider.email, outsider.password);
      const request = await callApiWithParams(
        joinPost,
        { path: `/api/communities/${community2.id}/join`, method: "POST", body: {} },
        { id: community2.id },
      );
      expect(request.status).toBe(200);
      expect((await readJson(request)).status).toBe("requested");
      expect(await ownerCount(community2.id)).toBe(1);

      await seedSession(owner.email, owner.password);
      const roster = await readJson(
        await callApiWithParams(
          membersGet,
          { path: `/api/communities/${community2.id}/members?include_requested=1` },
          { id: community2.id },
        ),
      );
      expect(roster.members as Array<{ user_id: string; status: string }>).toContainEqual(
        expect.objectContaining({ user_id: outsider.id, status: "requested" }),
      );

      const missing = await callApiWithParams(
        joinPost,
        { path: `/api/communities/${randomUUID()}/join`, method: "POST", body: {} },
        { id: randomUUID() },
      );
      expect(missing.status).toBe(404);
    });

    it("lets two more members join and holds the roster behind include_requested", async () => {
      for (const user of [joiner, kickee]) {
        await seedSession(user.email, user.password);
        const response = await callApiWithParams(
          joinPost,
          { path: `/api/communities/${community1.id}/join`, method: "POST", body: {} },
          { id: community1.id },
        );
        expect(response.status).toBe(200);
        expect((await readJson(response)).status).toBe("active");
      }
      expect(await ownerCount(community1.id)).toBe(4);

      await seedSession(outsider.email, outsider.password);
      const roster = await readJson(
        await callApiWithParams(
          membersGet,
          { path: `/api/communities/${community1.id}/members` },
          { id: community1.id },
        ),
      );
      expect((roster.members as Array<{ user_id: string }>).map((row) => row.user_id)).toEqual(
        expect.arrayContaining([owner.id, outsider.id, joiner.id, kickee.id]),
      );

      const staffOnly = await callApiWithParams(
        membersGet,
        { path: `/api/communities/${community1.id}/members?include_requested=1` },
        { id: community1.id },
      );
      expect(staffOnly.status).toBe(403);
    });
  });

  describe("channels, messages and welcomes", () => {
    it("books the next channel position for staff only", async () => {
      await seedSession(outsider.email, outsider.password);
      const forbidden = await callApiWithParams(
        channelsPost,
        {
          path: `/api/communities/${community1.id}/channels`,
          method: "POST",
          body: { name: "Homework", slug: "homework" },
        },
        { id: community1.id },
      );
      expect(forbidden.status).toBe(403);

      await seedSession(owner.email, owner.password);
      const created = await callApiWithParams(
        channelsPost,
        {
          path: `/api/communities/${community1.id}/channels`,
          method: "POST",
          body: { name: "Homework", slug: `hw-${tag}` },
        },
        { id: community1.id },
      );
      expect(created.status).toBe(201);
      expect((await readJson(created)).channel as Channel).toEqual(
        expect.objectContaining({ position: 1 }),
      );
    });

    it("stores opaque envelopes idempotently and pages them back to members", async () => {
      await seedSession(owner.email, owner.password);
      const first = envelope();
      const sent = await callApiWithParams(
        messagesPost,
        {
          path: `/api/communities/${community1.id}/channels/${general1.id}/messages`,
          method: "POST",
          body: first,
        },
        { id: community1.id, channelId: general1.id },
      );
      expect(sent.status).toBe(201);
      const sentRow = (await readJson(sent)).message as { id: string; seq: number; ciphertext: string };
      firstMessageId = sentRow.id;
      expect(sentRow.ciphertext).toBe(CIPHERTEXT);

      const retried = await callApiWithParams(
        messagesPost,
        {
          path: `/api/communities/${community1.id}/channels/${general1.id}/messages`,
          method: "POST",
          body: first,
        },
        { id: community1.id, channelId: general1.id },
      );
      expect(retried.status).toBe(201);
      expect(((await readJson(retried)).message as { id: string }).id).toBe(firstMessageId);

      const second = await callApiWithParams(
        messagesPost,
        {
          path: `/api/communities/${community1.id}/channels/${general1.id}/messages`,
          method: "POST",
          body: envelope(),
        },
        { id: community1.id, channelId: general1.id },
      );
      expect(second.status).toBe(201);
      const secondRow = (await readJson(second)).message as { id: string; seq: number };
      expect(secondRow.id).not.toBe(firstMessageId);
      expect(secondRow.seq).toBeGreaterThan(sentRow.seq);

      await seedSession(outsider.email, outsider.password);
      const page = await readJson(
        await callApiWithParams(
          messagesGet,
          {
            path: `/api/communities/${community1.id}/channels/${general1.id}/messages`,
          },
          { id: community1.id, channelId: general1.id },
        ),
      );
      expect((page.messages as Array<{ ciphertext: string }>).map((row) => row.ciphertext)).toEqual(
        expect.arrayContaining([CIPHERTEXT]),
      );
      expect(page.has_more).toBe(false);

      const clipped = await readJson(
        await callApiWithParams(
          messagesGet,
          {
            path: `/api/communities/${community1.id}/channels/${general1.id}/messages?limit=1`,
          },
          { id: community1.id, channelId: general1.id },
        ),
      );
      expect((clipped.messages as unknown[]).length).toBe(1);
      expect(clipped.has_more).toBe(true);
    });

    it("routes welcome envelopes to their addressee only", async () => {
      await seedSession(owner.email, owner.password);
      const welcome = {
        ciphertext: CIPHERTEXT,
        ratchetTree: CIPHERTEXT,
        clientMsgId: randomUUID(),
        recipientUserId: outsider.id,
        recipientDeviceId: "device-outsider-1",
      };
      const sent = await callApiWithParams(
        channelWelcomesPost,
        {
          path: `/api/communities/${community1.id}/channels/${general1.id}/welcomes`,
          method: "POST",
          body: welcome,
        },
        { id: community1.id, channelId: general1.id },
      );
      expect(sent.status).toBe(201);

      await seedSession(outsider.email, outsider.password);
      const mine = await readJson(
        await callApiWithParams(
          welcomesGet,
          { path: `/api/communities/${community1.id}/welcomes` },
          { id: community1.id },
        ),
      );
      expect((mine.welcomes as unknown[]).length).toBe(1);

      await seedSession(joiner.email, joiner.password);
      const theirs = await readJson(
        await callApiWithParams(
          welcomesGet,
          { path: `/api/communities/${community1.id}/welcomes` },
          { id: community1.id },
        ),
      );
      expect(theirs.welcomes).toEqual([]);

      const crossCommunity = await callApiWithParams(
        channelWelcomesPost,
        {
          path: `/api/communities/${community2.id}/channels/${general2.id}/welcomes`,
          method: "POST",
          body: { ...welcome, recipientUserId: joiner.id },
        },
        { id: community2.id, channelId: general2.id },
      );
      expect(crossCommunity.status).toBe(404);
    });
  });

  describe("member management", () => {
    it("keeps role and status changes behind staff and the RPC guards", async () => {
      await seedSession(outsider.email, outsider.password);
      const forbidden = await callApiWithParams(
        memberPatch,
        {
          path: `/api/communities/${community1.id}/members/${joiner.id}`,
          method: "PATCH",
          body: { role: "moderator" },
        },
        { id: community1.id, userId: joiner.id },
      );
      expect(forbidden.status).toBe(403);

      await seedSession(owner.email, owner.password);
      const promoted = await callApiWithParams(
        memberPatch,
        {
          path: `/api/communities/${community1.id}/members/${joiner.id}`,
          method: "PATCH",
          body: { role: "moderator" },
        },
        { id: community1.id, userId: joiner.id },
      );
      expect(promoted.status).toBe(200);
      expect((await readJson(promoted)).ok).toBe(true);

      const roster = await readJson(
        await callApiWithParams(
          membersGet,
          { path: `/api/communities/${community1.id}/members` },
          { id: community1.id },
        ),
      );
      expect(roster.members as Array<{ user_id: string; role: string }>).toContainEqual(
        expect.objectContaining({ user_id: joiner.id, role: "moderator" }),
      );

      const ownerRow = await callApiWithParams(
        memberPatch,
        {
          path: `/api/communities/${community1.id}/members/${owner.id}`,
          method: "PATCH",
          body: { role: "moderator" },
        },
        { id: community1.id, userId: owner.id },
      );
      expect(ownerRow.status).toBe(409);
      expect(errorOf(await readJson(ownerRow)).code).toBe("owner_protected");

      const approved = await callApiWithParams(
        memberPatch,
        {
          path: `/api/communities/${community2.id}/members/${outsider.id}`,
          method: "PATCH",
          body: { status: "active" },
        },
        { id: community2.id, userId: outsider.id },
      );
      expect(approved.status).toBe(200);
      expect(await ownerCount(community2.id)).toBe(2);
    });

    it("denies every direct membership write over PostgREST", async () => {
      const selfPromotion = await joiner.client
        .from("community_members")
        .update({ role: "owner" })
        .eq("community_id", community1.id)
        .eq("user_id", joiner.id)
        .select();
      expect(selfPromotion.data).toBeNull();
      expect(selfPromotion.error?.code).toBe("42501");

      const joinBypass = await joiner.client
        .from("community_members")
        .insert({
          community_id: community2.id,
          user_id: joiner.id,
          role: "member",
          status: "active",
        })
        .select();
      expect(joinBypass.data).toBeNull();
      expect(joinBypass.error?.code).toBe("42501");

      const selfDelete = await joiner.client
        .from("community_members")
        .delete()
        .eq("community_id", community1.id)
        .eq("user_id", joiner.id)
        .select();
      expect(selfDelete.data).toBeNull();
      expect(selfDelete.error?.code).toBe("42501");
    });
  });

  describe("devices, sync and key packages", () => {
    it("registers a public key package and serves it through sync and fetch", async () => {
      await seedSession(owner.email, owner.password);
      const deviceId = `device-${tag}-owner`;
      const registered = await callApi(devicePost, {
        path: "/api/communities/devices",
        method: "POST",
        body: {
          deviceId,
          keyPackage: "A".repeat(96),
          signaturePublicKey: "sig-public-key-owner-0001",
        },
      });
      expect(registered.status).toBe(201);
      expect(((await readJson(registered)).device as { device_id: string }).device_id).toBe(deviceId);

      await seedSession(outsider.email, outsider.password);
      const synced = await readJson(
        await callApiWithParams(syncGet, { path: `/api/communities/${community1.id}/sync` }, { id: community1.id }),
      );
      expect([...(synced.member_ids as string[])].sort()).toEqual(
        [owner.id, outsider.id, joiner.id, kickee.id].sort(),
      );
      expect(synced.devices as Array<{ device_id: string }>).toContainEqual(
        expect.objectContaining({ device_id: deviceId }),
      );

      const fetched = await readJson(
        await callApi(keysFetchPost, {
          path: "/api/communities/devices/fetch",
          method: "POST",
          body: { communityId: community1.id, userIds: [owner.id] },
        }),
      );
      expect(fetched.devices as Array<{ key_package: string }>).toContainEqual(
        expect.objectContaining({ key_package: "A".repeat(96) }),
      );

      await seedSession(joiner.email, joiner.password);
      const crossCommunity = await callApi(keysFetchPost, {
        path: "/api/communities/devices/fetch",
        method: "POST",
        body: { communityId: community2.id, userIds: [owner.id] },
      });
      expect(crossCommunity.status).toBe(404);

      const visible = await joiner.client
        .from("community_devices")
        .select("device_id")
        .eq("user_id", owner.id);
      expect((visible.data ?? []).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("reports and attachments", () => {
    it("files reports with a voluntary excerpt and keeps them reporter/staff scoped", async () => {
      await seedSession(outsider.email, outsider.password);
      const filed = await callApiWithParams(
        reportPost,
        {
          path: `/api/communities/${community1.id}/reports`,
          method: "POST",
          body: {
            targetType: "message",
            targetId: firstMessageId,
            reason: "Harassment",
            contextExcerpt: "the words they said",
          },
        },
        { id: community1.id },
      );
      expect(filed.status).toBe(201);
      const reportId = ((await readJson(filed)).report as { id: string }).id;

      await seedSession(joiner.email, joiner.password);
      const joinerFiled = await callApiWithParams(
        reportPost,
        {
          path: `/api/communities/${community1.id}/reports`,
          method: "POST",
          body: { targetType: "member", targetId: outsider.id, reason: "Spam" },
        },
        { id: community1.id },
      );
      expect(joinerFiled.status).toBe(201);
      const joinerReportId = ((await readJson(joinerFiled)).report as { id: string }).id;

      const joinerSees = await joiner.client.from("community_reports").select("id");
      const joinerIds = (joinerSees.data ?? []).map((row: { id: string }) => row.id);
      expect(joinerIds).toContain(joinerReportId);
      // joiner was promoted to moderator above: staff reads the whole inbox.
      expect(joinerIds).toContain(reportId);

      const ownerSees = await owner.client.from("community_reports").select("id");
      const ownerIds = (ownerSees.data ?? []).map((row: { id: string }) => row.id);
      expect(ownerIds).toEqual(expect.arrayContaining([reportId, joinerReportId]));

      const outsiderSees = await outsider.client.from("community_reports").select("id");
      const outsiderIds = (outsiderSees.data ?? []).map((row: { id: string }) => row.id);
      expect(outsiderIds).toContain(reportId);
      expect(outsiderIds).not.toContain(joinerReportId);

      await seedSession(joiner.email, joiner.password);
      const crossCommunity = await callApiWithParams(
        reportPost,
        {
          path: `/api/communities/${community2.id}/reports`,
          method: "POST",
          body: { targetType: "member", targetId: owner.id, reason: "Nope" },
        },
        { id: community2.id },
      );
      expect(crossCommunity.status).toBe(404);
    });

    it("serves signed ciphertext URLs and keeps the bucket member-only", async () => {
      const attachmentId = randomUUID();
      const storagePath = `community-attachments/${community1.id}/${general1.id}/${attachmentId}`;
      const bytes = new Uint8Array([0x53, 0x44, 0x59, 0x01, 0x02, 0x03]);

      await seedSession(owner.email, owner.password);
      const uploaded = await owner.client.storage
        .from("community-attachments")
        .upload(storagePath, Buffer.from(bytes), {
          contentType: "application/octet-stream",
        });
      expect(uploaded.error).toBeNull();

      const registered = await callApiWithParams(
        attachmentsPost,
        {
          path: `/api/communities/${community1.id}/attachments`,
          method: "POST",
          body: {
            channelId: general1.id,
            storagePath,
            ciphertextSize: bytes.length,
            contentType: "application/octet-stream",
          },
        },
        { id: community1.id },
      );
      expect(registered.status).toBe(201);
      // The row's id is DB-generated and is what the E2EE payload carries to
      // receivers — the uuid inside storagePath is only a file name.
      const registeredAttachment = (await readJson(registered)).attachment as { id: string };

      const signed = await callApiWithParams(
        attachmentDownload,
        { path: `/api/communities/${community1.id}/attachments/${registeredAttachment.id}` },
        { id: community1.id, attachmentId: registeredAttachment.id },
      );
      expect(signed.status).toBe(200);
      const signedBody = await readJson(signed);
      expect(signedBody.expires_in).toBe(120);
      const fetched = await fetch(String(signedBody.url));
      expect(fetched.status).toBe(200);
      expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(bytes);

      const unsigned = await fetch(
        `${integrationEnv().apiUrl}/storage/v1/object/community-attachments/${storagePath}`,
      );
      expect(unsigned.status).not.toBe(200);

      const wrongPrefix = await callApiWithParams(
        attachmentsPost,
        {
          path: `/api/communities/${community1.id}/attachments`,
          method: "POST",
          body: {
            channelId: general1.id,
            storagePath: `community-attachments/${randomUUID()}/${general1.id}/${attachmentId}`,
            ciphertextSize: bytes.length,
          },
        },
        { id: community1.id },
      );
      expect(wrongPrefix.status).toBe(400);

      const foreignUpload = await joiner.client.storage
        .from("community-attachments")
        .upload(
          `community-attachments/${community2.id}/${general2.id}/${randomUUID()}`,
          Buffer.from(bytes),
          { contentType: "application/octet-stream" },
        );
      expect(foreignUpload.error).not.toBeNull();
    });
  });

  describe("bans, kicks, leaves and deletion", () => {
    it("bans a moderator, revokes every gate, and blocks the direct-unban escape", async () => {
      await seedSession(owner.email, owner.password);
      const banned = await callApiWithParams(
        memberPatch,
        {
          path: `/api/communities/${community1.id}/members/${joiner.id}`,
          method: "PATCH",
          body: { status: "banned" },
        },
        { id: community1.id, userId: joiner.id },
      );
      expect(banned.status).toBe(200);
      expect(await ownerCount(community1.id)).toBe(3);

      await seedSession(joiner.email, joiner.password);
      const channels = await callApiWithParams(
        channelsGet,
        { path: `/api/communities/${community1.id}/channels` },
        { id: community1.id },
      );
      expect(channels.status).toBe(404);

      const rejoined = await callApiWithParams(
        joinPost,
        { path: `/api/communities/${community1.id}/join`, method: "POST", body: {} },
        { id: community1.id },
      );
      expect(rejoined.status).toBe(403);
      expect(errorOf(await readJson(rejoined)).code).toBe("forbidden");

      const unbanAttempt = await joiner.client
        .from("community_members")
        .update({ status: "active" })
        .eq("community_id", community1.id)
        .eq("user_id", joiner.id)
        .select();
      expect(unbanAttempt.data).toBeNull();
      expect(unbanAttempt.error?.code).toBe("42501");

      const download = await callApiWithParams(
        attachmentDownload,
        { path: `/api/communities/${community1.id}/attachments/${randomUUID()}` },
        { id: community1.id, attachmentId: randomUUID() },
      );
      expect(download.status).toBe(404);
    });

    it("kicks a member through the definer RPC with an honest member_count", async () => {
      await seedSession(owner.email, owner.password);
      const kicked = await callApiWithParams(
        memberDelete,
        { path: `/api/communities/${community1.id}/members/${kickee.id}`, method: "DELETE" },
        { id: community1.id, userId: kickee.id },
      );
      expect(kicked.status).toBe(204);
      expect(await ownerCount(community1.id)).toBe(2);

      await seedSession(kickee.email, kickee.password);
      const channels = await callApiWithParams(
        channelsGet,
        { path: `/api/communities/${community1.id}/channels` },
        { id: community1.id },
      );
      expect(channels.status).toBe(404);

      const missingTarget = await callApiWithParams(
        memberDelete,
        { path: `/api/communities/${community1.id}/members/${randomUUID()}`, method: "DELETE" },
        { id: community1.id, userId: randomUUID() },
      );
      expect(missingTarget.status).toBe(404);
    });

    it("sends a non-owner through the leave RPC and pins the owner to it", async () => {
      await seedSession(outsider.email, outsider.password);
      const left = await callApiWithParams(
        leavePost,
        { path: `/api/communities/${community1.id}/leave`, method: "POST", body: {} },
        { id: community1.id },
      );
      expect(left.status).toBe(204);

      const after = await callApiWithParams(
        communityGet,
        { path: `/api/communities/${community1.id}` },
        { id: community1.id },
      );
      expect(after.status).toBe(200);
      expect((await readJson(after)).membership).toBeNull();

      const message = await callApiWithParams(
        messagesPost,
        {
          path: `/api/communities/${community1.id}/channels/${general1.id}/messages`,
          method: "POST",
          body: envelope(),
        },
        { id: community1.id, channelId: general1.id },
      );
      expect(message.status).toBe(404);

      expect(await ownerCount(community1.id)).toBe(1);

      await seedSession(owner.email, owner.password);
      const ownerLeave = await callApiWithParams(
        leavePost,
        { path: `/api/communities/${community1.id}/leave`, method: "POST", body: {} },
        { id: community1.id },
      );
      expect(ownerLeave.status).toBe(409);
      expect(errorOf(await readJson(ownerLeave)).code).toBe("owner_cannot_leave");
    });

    it("lets only the owner delete the community", async () => {
      await seedSession(outsider.email, outsider.password);
      const missing = await callApiWithParams(
        communityDelete,
        { path: `/api/communities/${randomUUID()}`, method: "DELETE" },
        { id: randomUUID() },
      );
      expect(missing.status).toBe(404);

      await seedSession(joiner.email, joiner.password);
      const banned = await callApiWithParams(
        communityDelete,
        { path: `/api/communities/${community2.id}`, method: "DELETE" },
        { id: community2.id },
      );
      expect(banned.status).toBe(404);

      await seedSession(outsider.email, outsider.password);
      const nonOwner = await callApiWithParams(
        communityDelete,
        { path: `/api/communities/${community2.id}`, method: "DELETE" },
        { id: community2.id },
      );
      expect(nonOwner.status).toBe(403);

      await seedSession(owner.email, owner.password);
      const deleted = await callApiWithParams(
        communityDelete,
        { path: `/api/communities/${community2.id}`, method: "DELETE" },
        { id: community2.id },
      );
      expect(deleted.status).toBe(204);

      const gone = await callApiWithParams(
        communityGet,
        { path: `/api/communities/${community2.id}` },
        { id: community2.id },
      );
      expect(gone.status).toBe(404);
    });

    it("returns 429 with Retry-After once the create window is exhausted", async () => {
      let sawLimit = false;
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const created = await createCommunity(owner, {
          slug: `burst-${tag}-${attempt}`,
          name: `Burst ${tag} ${attempt}`,
        });
        if (created.status === 429) {
          sawLimit = true;
          break;
        }
        expect(created.status).toBe(201);
      }
      expect(sawLimit).toBe(true);
    });
  });
});
