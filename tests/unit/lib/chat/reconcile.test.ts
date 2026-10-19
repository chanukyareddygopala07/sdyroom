import {
  asChatMessageView,
  mergeChatHistory,
  parseHistoryPage,
} from "@/lib/chat/reconcile";
import type { ChatMessageView } from "@/lib/chat/types";
import { describe, expect, it } from "vitest";

function row(
  id: string,
  created_at: string,
  overrides: Partial<ChatMessageView> = {},
): ChatMessageView {
  return {
    id,
    alias: "Partner",
    body: `body-${id}`,
    created_at,
    status: "sent",
    is_own: false,
    ...overrides,
  };
}

describe("parseHistoryPage", () => {
  it("accepts the endpoint's envelope and marks non-sent rows as sent", () => {
    const page = parseHistoryPage({
      messages: [
        {
          id: "m1",
          alias: "Partner",
          body: "hello",
          created_at: "2026-10-19T10:00:00.000Z",
          is_own: false,
          // The server never sends a status field; catch-up rows are
          // confirmed history by construction.
          status: "pending",
        },
      ],
      has_more: false,
    });
    expect(page).not.toBeNull();
    expect(page?.messages[0]?.status).toBe("sent");
    expect(page?.has_more).toBe(false);
  });

  it("drops the whole page when any row breaks the contract", () => {
    expect(
      parseHistoryPage({
        messages: [
          {
            id: "m1",
            alias: "Partner",
            body: "fine",
            created_at: "2026-10-19T10:00:00.000Z",
            is_own: false,
          },
          { id: "m2", alias: "Partner" },
        ],
        has_more: true,
      }),
    ).toBeNull();
  });

  it("rejects bodies that are not the documented envelope", () => {
    expect(parseHistoryPage(null)).toBeNull();
    expect(parseHistoryPage("error")).toBeNull();
    expect(parseHistoryPage({ error: { code: "not_found" } })).toBeNull();
    expect(parseHistoryPage({ messages: "nope" })).toBeNull();
  });
});

describe("asChatMessageView", () => {
  it("requires every field the panel renders or labels with", () => {
    expect(
      asChatMessageView({
        id: "m1",
        alias: "Partner",
        body: "hello",
        created_at: "2026-10-19T10:00:00.000Z",
        is_own: true,
      }),
    ).toMatchObject({ id: "m1", is_own: true, status: "sent" });
    expect(asChatMessageView({ id: "m1" })).toBeNull();
    expect(asChatMessageView(undefined)).toBeNull();
  });
});

describe("mergeChatHistory", () => {
  const seeded = row("seed", "2026-10-19T10:00:00.000Z");

  it("returns the same reference when nothing new arrived", () => {
    const current = [seeded];
    expect(mergeChatHistory(current, [seeded])).toBe(current);
    expect(mergeChatHistory(current, [])).toBe(current);
  });

  it("weaves rows missed during a gap into chronological position", () => {
    const live = row("live", "2026-10-19T10:05:00.000Z");
    const gapA = row("gap-a", "2026-10-19T10:02:00.000Z");
    const gapB = row("gap-b", "2026-10-19T10:03:00.000Z");

    const merged = mergeChatHistory([seeded, live], [gapA, gapB]);

    expect(merged.map((item) => item.id)).toEqual([
      "seed",
      "gap-a",
      "gap-b",
      "live",
    ]);
  });

  it("keeps exactly one copy when the same message arrives twice", () => {
    const fetched = [seeded, row("gap", "2026-10-19T10:02:00.000Z")];
    const merged = mergeChatHistory([seeded], fetched);
    expect(merged.map((item) => item.id)).toEqual(["seed", "gap"]);
    expect(mergeChatHistory(merged, fetched).map((item) => item.id)).toEqual([
      "seed",
      "gap",
    ]);
  });

  it("keeps the held copy when the same id is fetched again", () => {
    // `room_messages` is append-only, so both copies are the same immutable
    // row; the held one wins so a key the list already rendered never churns.
    const held: ChatMessageView = {
      ...seeded,
      body: "in flight",
      status: "pending",
    };
    const merged = mergeChatHistory([held], [
      { ...seeded, body: "in flight" },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(held);
  });

  it("keeps optimistic rows the server has not confirmed yet", () => {
    const pending = row("local-1", "2026-10-19T10:06:00.000Z", {
      status: "pending",
      is_own: true,
    });
    const merged = mergeChatHistory(
      [seeded, pending],
      [row("gap", "2026-10-19T10:02:00.000Z")],
    );
    expect(merged.map((item) => item.id)).toEqual(["seed", "gap", "local-1"]);
    expect(merged[2]?.status).toBe("pending");
  });

  it("orders equal timestamps deterministically: fetched rows first", () => {
    const tie = "2026-10-19T10:02:00.000Z";
    const held = row("held", tie);
    const fetched = row("fetched", tie);
    expect(
      mergeChatHistory([held], [fetched]).map((item) => item.id),
    ).toEqual(["fetched", "held"]);
    // …and the held order among its own rows never moves.
    const a = row("a", tie);
    const b = row("b", tie);
    expect(mergeChatHistory([a, b], [row("other", tie)]).map((i) => i.id)).toEqual(
      ["other", "a", "b"],
    );
  });

  it("appends fetched rows older than everything held at the front", () => {
    const older = row("older", "2026-10-19T09:00:00.000Z");
    expect(mergeChatHistory([seeded], [older]).map((item) => item.id)).toEqual(
      ["older", "seed"],
    );
  });
});
