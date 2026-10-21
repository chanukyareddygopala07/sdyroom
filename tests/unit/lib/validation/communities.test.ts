import { describe, expect, it } from "vitest";
import {
  communityMessagesQuerySchema,
  communitySlugSchema,
  createChannelSchema,
  createCommunityAttachmentSchema,
  createCommunityReportSchema,
  createCommunitySchema,
  fetchCommunityKeysSchema,
  listCommunitiesQuerySchema,
  registerCommunityDeviceSchema,
  sendCommunityMessageSchema,
  sendCommunityWelcomeSchema,
  setCommunityMemberSchema,
  updateCommunitySchema,
} from "@/lib/validation/communities";
import {
  COMMUNITY_ATTACHMENT_MAX_BYTES,
  COMMUNITY_MESSAGE_PAGE_SIZE_DEFAULT,
  COMMUNITY_MESSAGE_PAGE_SIZE_MAX,
} from "@/lib/communities/types";

const validCiphertext = "A".repeat(64);
const uuid = "0b2f9c1e-3d4a-4b5c-8e6f-7a8b9c0d1e2f";

describe("communitySlugSchema", () => {
  it("accepts 4–40 char lowercase slugs and trims", () => {
    expect(communitySlugSchema.parse("  cool-group  ")).toBe("cool-group");
    expect(communitySlugSchema.safeParse("ab-cd").success).toBe(true);
  });

  it("rejects edge hyphens, uppercase, short and long values", () => {
    expect(communitySlugSchema.safeParse("-abcd").success).toBe(false);
    expect(communitySlugSchema.safeParse("abcd-").success).toBe(false);
    expect(communitySlugSchema.safeParse("Abcd").success).toBe(false);
    expect(communitySlugSchema.safeParse("abc").success).toBe(false);
    expect(communitySlugSchema.safeParse("a".repeat(41)).success).toBe(false);
  });
});

describe("createCommunitySchema", () => {
  const base = { slug: "study-hall", name: "Study Hall" };

  it("applies the documented defaults", () => {
    const parsed = createCommunitySchema.parse(base);
    expect(parsed).toMatchObject({
      category: "study",
      visibility: "public",
      description: "",
    });
  });

  it("refuses a private community with open joining", () => {
    const result = createCommunitySchema.safeParse({
      ...base,
      visibility: "private",
      joinPolicy: "open",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["joinPolicy"]);
    }
  });

  it("accepts a private community with request joining", () => {
    expect(
      createCommunitySchema.safeParse({
        ...base,
        visibility: "private",
        joinPolicy: "request",
      }).success,
    ).toBe(true);
  });

  it("is strict — member bookkeeping fields are not body-writable", () => {
    expect(
      createCommunitySchema.safeParse({
        ...base,
        member_count: 9999,
        owner_id: "someone",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown categories and over-long names", () => {
    expect(
      createCommunitySchema.safeParse({ ...base, category: "music" }).success,
    ).toBe(false);
    expect(
      createCommunitySchema.safeParse({ ...base, name: "n".repeat(61) })
        .success,
    ).toBe(false);
  });
});

describe("updateCommunitySchema", () => {
  it("is strict and enforces the private/open pairing", () => {
    expect(updateCommunitySchema.safeParse({ member_count: 3 }).success).toBe(
      false,
    );
    expect(
      updateCommunitySchema.safeParse({
        visibility: "private",
        joinPolicy: "open",
      }).success,
    ).toBe(false);
    expect(
      updateCommunitySchema.safeParse({
        visibility: "private",
        joinPolicy: "request",
      }).success,
    ).toBe(true);
    expect(updateCommunitySchema.safeParse({ name: "  New name  " }).success).toBe(
      true,
    );
  });
});

describe("createChannelSchema", () => {
  it("accepts general and kebab slugs, trims the name", () => {
    const parsed = createChannelSchema.parse({
      name: "  Homework  ",
      slug: "general",
    });
    expect(parsed.name).toBe("Homework");
    expect(parsed.description).toBe("");
  });

  it("rejects uppercase/edged channel slugs and empty names", () => {
    expect(
      createChannelSchema.safeParse({ name: "Hi", slug: "General" }).success,
    ).toBe(false);
    expect(
      createChannelSchema.safeParse({ name: "Hi", slug: "-hw" }).success,
    ).toBe(false);
    expect(createChannelSchema.safeParse({ name: "", slug: "hw" }).success).toBe(
      false,
    );
  });
});

describe("sendCommunityMessageSchema", () => {
  const base = {
    kind: "application" as const,
    ciphertext: validCiphertext,
    clientMsgId: uuid,
    senderDeviceId: "device-12345678",
  };

  it("accepts application and commit kinds only", () => {
    expect(sendCommunityMessageSchema.safeParse(base).success).toBe(true);
    expect(
      sendCommunityMessageSchema.safeParse({ ...base, kind: "commit" }).success,
    ).toBe(true);
    expect(
      sendCommunityMessageSchema.safeParse({ ...base, kind: "welcome" })
        .success,
    ).toBe(false);
  });

  it("rejects non-base64, short and over-long ciphertext", () => {
    expect(
      sendCommunityMessageSchema.safeParse({ ...base, ciphertext: "!!notb64!!".repeat(8) })
        .success,
    ).toBe(false);
    expect(
      sendCommunityMessageSchema.safeParse({ ...base, ciphertext: "AAAA" })
        .success,
    ).toBe(false);
    expect(
      sendCommunityMessageSchema.safeParse({
        ...base,
        ciphertext: "A".repeat(262_145),
      }).success,
    ).toBe(false);
  });

  it("requires a UUID client message id and bounded device id", () => {
    expect(
      sendCommunityMessageSchema.safeParse({ ...base, clientMsgId: "nope" })
        .success,
    ).toBe(false);
    expect(
      sendCommunityMessageSchema.safeParse({ ...base, senderDeviceId: "short" })
        .success,
    ).toBe(false);
  });

  it("is strict", () => {
    expect(
      sendCommunityMessageSchema.safeParse({ ...base, plaintext: "hello" })
        .success,
    ).toBe(false);
  });
});

describe("sendCommunityWelcomeSchema", () => {
  const base = {
    ciphertext: validCiphertext,
    ratchetTree: "B".repeat(64),
    clientMsgId: uuid,
    recipientUserId: uuid,
    recipientDeviceId: "device-12345678",
  };

  it("accepts a well-formed addressed welcome", () => {
    expect(sendCommunityWelcomeSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a non-uuid recipient and non-base64 tree", () => {
    expect(
      sendCommunityWelcomeSchema.safeParse({ ...base, recipientUserId: "u1" })
        .success,
    ).toBe(false);
    expect(
      sendCommunityWelcomeSchema.safeParse({ ...base, ratchetTree: "not base64!!" })
        .success,
    ).toBe(false);
  });
});

describe("communityMessagesQuerySchema", () => {
  it("coerces query strings and defaults the page size", () => {
    const parsed = communityMessagesQuerySchema.parse({});
    expect(parsed.limit).toBe(COMMUNITY_MESSAGE_PAGE_SIZE_DEFAULT);
    expect(
      communityMessagesQuerySchema.parse({ before: "42", limit: "10" }),
    ).toEqual({ before: 42, limit: 10 });
  });

  it("bounds before/limit to the documented range", () => {
    expect(
      communityMessagesQuerySchema.safeParse({ before: 0 }).success,
    ).toBe(false);
    expect(
      communityMessagesQuerySchema.safeParse({
        limit: COMMUNITY_MESSAGE_PAGE_SIZE_MAX + 1,
      }).success,
    ).toBe(false);
    expect(
      communityMessagesQuerySchema.safeParse({ limit: 1.5 }).success,
    ).toBe(false);
  });
});

describe("registerCommunityDeviceSchema", () => {
  it("accepts a padded base64 key package of the expected size", () => {
    const parsed = registerCommunityDeviceSchema.parse({
      deviceId: "device-12345678",
      keyPackage: "A".repeat(64),
      signaturePublicKey: "cHVibGljS2V5MDAwMDAwMDA",
    });
    expect(parsed.deviceId).toBe("device-12345678");
  });

  it("rejects short key packages and over-long devices", () => {
    expect(
      registerCommunityDeviceSchema.safeParse({
        deviceId: "device-12345678",
        keyPackage: "A".repeat(63),
        signaturePublicKey: "cHVibGljS2V5MDAwMDAwMDA",
      }).success,
    ).toBe(false);
    expect(
      registerCommunityDeviceSchema.safeParse({
        deviceId: "short",
        keyPackage: "A".repeat(64),
        signaturePublicKey: "cHVibGljS2V5MDAwMDAwMDA",
      }).success,
    ).toBe(false);
  });
});

describe("fetchCommunityKeysSchema", () => {
  it("requires 1–50 uuids and is strict", () => {
    expect(
      fetchCommunityKeysSchema.safeParse({ communityId: uuid, userIds: [uuid] })
        .success,
    ).toBe(true);
    expect(
      fetchCommunityKeysSchema.safeParse({ communityId: uuid, userIds: [] })
        .success,
    ).toBe(false);
    expect(
      fetchCommunityKeysSchema.safeParse({
        communityId: uuid,
        userIds: Array.from({ length: 51 }, () => uuid),
      }).success,
    ).toBe(false);
    expect(
      fetchCommunityKeysSchema.safeParse({
        communityId: uuid,
        userIds: [uuid],
        limit: 5,
      }).success,
    ).toBe(false);
  });
});

describe("createCommunityReportSchema", () => {
  it("requires a reason and bounds the excerpt", () => {
    expect(
      createCommunityReportSchema.safeParse({
        targetType: "message",
        targetId: uuid,
        reason: "spam",
      }).success,
    ).toBe(true);
    expect(
      createCommunityReportSchema.safeParse({
        targetType: "message",
        targetId: uuid,
        reason: "   ",
      }).success,
    ).toBe(false);
    expect(
      createCommunityReportSchema.safeParse({
        targetType: "message",
        targetId: uuid,
        reason: "spam",
        contextExcerpt: "e".repeat(2001),
      }).success,
    ).toBe(false);
    expect(
      createCommunityReportSchema.safeParse({
        targetType: "room",
        targetId: uuid,
        reason: "spam",
      }).success,
    ).toBe(false);
  });
});

describe("createCommunityAttachmentSchema", () => {
  const base = {
    channelId: uuid,
    storagePath: `community-attachments/${uuid}/${uuid}/${uuid}`,
    ciphertextSize: 1024,
  };

  it("accepts the namespaced path and defaults the content type", () => {
    const parsed = createCommunityAttachmentSchema.parse(base);
    expect(parsed.contentType).toBe("application/octet-stream");
  });

  it("rejects non-namespaced paths and out-of-range sizes", () => {
    expect(
      createCommunityAttachmentSchema.safeParse({
        ...base,
        storagePath: "community-attachments/evil",
      }).success,
    ).toBe(false);
    expect(
      createCommunityAttachmentSchema.safeParse({
        ...base,
        ciphertextSize: 0,
      }).success,
    ).toBe(false);
    expect(
      createCommunityAttachmentSchema.safeParse({
        ...base,
        ciphertextSize: COMMUNITY_ATTACHMENT_MAX_BYTES + 1,
      }).success,
    ).toBe(false);
  });
});

describe("listCommunitiesQuerySchema", () => {
  it("defaults limit to 20 and coerces strings", () => {
    expect(listCommunitiesQuerySchema.parse({}).limit).toBe(20);
    expect(listCommunitiesQuerySchema.parse({ limit: "7" }).limit).toBe(7);
    expect(
      listCommunitiesQuerySchema.safeParse({ limit: 51 }).success,
    ).toBe(false);
    expect(
      listCommunitiesQuerySchema.safeParse({ q: "q".repeat(61) }).success,
    ).toBe(false);
  });
});

describe("setCommunityMemberSchema", () => {
  it("accepts the documented role/status values and rejects others", () => {
    expect(
      setCommunityMemberSchema.safeParse({ role: "moderator" }).success,
    ).toBe(true);
    expect(
      setCommunityMemberSchema.safeParse({ status: "banned" }).success,
    ).toBe(true);
    expect(setCommunityMemberSchema.safeParse({ role: null }).success).toBe(
      true,
    );
    expect(
      setCommunityMemberSchema.safeParse({ role: "admin" }).success,
    ).toBe(false);
    expect(
      setCommunityMemberSchema.safeParse({ status: "left" }).success,
    ).toBe(false);
    expect(
      setCommunityMemberSchema.safeParse({ role: "owner", extra: 1 }).success,
    ).toBe(false);
  });
});
