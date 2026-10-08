// @vitest-environment jsdom
import { RoomRoster } from "@/components/room-roster";
import type { RoomMemberView } from "@/lib/invitations/types";
import type { RoomModerationInfo } from "@/lib/moderation/queries";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push, refresh, fetchMock } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

const MEMBERS: RoomMemberView[] = [
  { alias: "Ada", role: "owner", joined_at: "2026-10-01T09:00:00.000Z" },
  { alias: "Bob", role: "student", joined_at: "2026-10-02T09:00:00.000Z" },
  { alias: "Cara", role: "student", joined_at: "2026-10-03T09:00:00.000Z" },
  { alias: "Dee", role: "student", joined_at: "2026-10-04T09:00:00.000Z" },
];

function moderation(overrides: Partial<RoomModerationInfo> = {}): RoomModerationInfo {
  return {
    can_moderate: false,
    moderator_aliases: [],
    muted_aliases: [],
    viewer_is_muted: false,
    muted_until: null,
    ...overrides,
  };
}

function openMenu(alias: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: `Actions for ${alias}` }));
}

function itemNames(): string[] {
  return screen
    .getAllByRole("menuitem")
    .map((item) => item.textContent?.trim() ?? "");
}

describe("RoomRoster moderation menu", () => {
  beforeEach(() => {
    push.mockReset();
    refresh.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a plain member only report and block — no moderator powers", () => {
    render(
      <RoomRoster
        roomId={ROOM_ID}
        members={MEMBERS}
        moderation={moderation()}
        viewerAlias="Dana"
        canAppoint={false}
        blockedAliases={[]}
      />,
    );

    openMenu("Bob");
    const items = itemNames();
    expect(items).toContain("Report member…");
    expect(items).toContain("Block");
    expect(items.some((name) => name.startsWith("Mute"))).toBe(false);
    expect(items).not.toContain("Make moderator");
    expect(items).not.toContain("Remove from room…");
  });

  it("gives a moderator mute and remove, but never the appoint power", () => {
    render(
      <RoomRoster
        roomId={ROOM_ID}
        members={MEMBERS}
        moderation={moderation({ can_moderate: true })}
        viewerAlias="Bob"
        canAppoint={false}
        blockedAliases={[]}
      />,
    );

    openMenu("Cara");
    const items = itemNames();
    expect(items).toContain("Mute for 1 hour");
    expect(items).toContain("Mute for 24 hours");
    expect(items).toContain("Mute for 7 days");
    expect(items).toContain("Remove from room…");
    expect(items).not.toContain("Make moderator");
    expect(items).not.toContain("Remove moderator");
  });

  it("gives the owner the appointment power on top of the moderator set", () => {
    render(
      <RoomRoster
        roomId={ROOM_ID}
        members={MEMBERS}
        moderation={moderation({
          can_moderate: true,
          moderator_aliases: ["Bob"],
          muted_aliases: ["Cara"],
        })}
        viewerAlias="Ada"
        canAppoint
        blockedAliases={[]}
      />,
    );

    openMenu("Bob");
    const items = itemNames();
    expect(items).toContain("Remove moderator");
    // A moderator can never be muted — the menu does not offer it.
    expect(items.some((name) => name.startsWith("Mute"))).toBe(false);
    expect(items).toContain("Remove from room…");
    expect(items).not.toContain("Make moderator");
  });

  it("offers Unmute for a muted member instead of the mute durations", () => {
    render(
      <RoomRoster
        roomId={ROOM_ID}
        members={MEMBERS}
        moderation={moderation({
          can_moderate: true,
          muted_aliases: ["Cara"],
        })}
        viewerAlias="Ada"
        canAppoint={false}
        blockedAliases={[]}
      />,
    );

    openMenu("Cara");
    const items = itemNames();
    expect(items).toContain("Unmute");
    expect(items.some((name) => name.startsWith("Mute for"))).toBe(false);
  });

  it("never opens a menu on the viewer's own row or the owner's row for removal", () => {
    render(
      <RoomRoster
        roomId={ROOM_ID}
        members={MEMBERS}
        moderation={moderation({ can_moderate: true })}
        viewerAlias="bob"
        canAppoint={false}
        blockedAliases={[]}
      />,
    );

    // Own row (case-insensitive): no actions at all.
    expect(screen.queryByRole("button", { name: "Actions for Bob" })).toBeNull();

    openMenu("Ada");
    const items = itemNames();
    expect(items).toContain("Report member…");
    expect(items).not.toContain("Remove from room…");
    expect(items.some((name) => name.startsWith("Mute"))).toBe(false);
  });

  it("offers Unblock for an already blocked member", () => {
    render(
      <RoomRoster
        roomId={ROOM_ID}
        members={MEMBERS}
        moderation={moderation()}
        viewerAlias="Dana"
        canAppoint={false}
        blockedAliases={["Bob"]}
      />,
    );

    openMenu("Bob");
    expect(itemNames()).toContain("Unblock");
    expect(itemNames()).not.toContain("Block");
  });

  it("blocks a member through the API and refreshes the roster", async () => {
    render(
      <RoomRoster
        roomId={ROOM_ID}
        members={MEMBERS}
        moderation={moderation()}
        viewerAlias="Dana"
        canAppoint={false}
        blockedAliases={[]}
      />,
    );

    openMenu("Bob");
    fireEvent.click(screen.getByRole("menuitem", { name: "Block" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/blocks");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ alias: "Bob" });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("mutes for the chosen duration with the documented body", async () => {
    render(
      <RoomRoster
        roomId={ROOM_ID}
        members={MEMBERS}
        moderation={moderation({ can_moderate: true })}
        viewerAlias="Ada"
        canAppoint
        blockedAliases={[]}
      />,
    );

    openMenu("Bob");
    fireEvent.click(screen.getByRole("menuitem", { name: "Mute for 24 hours" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(
      `/api/rooms/${ROOM_ID}/members/Bob/mute`,
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ duration: "24h" });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("confirms a removal before the DELETE leaves the client", async () => {
    render(
      <RoomRoster
        roomId={ROOM_ID}
        members={MEMBERS}
        moderation={moderation({ can_moderate: true })}
        viewerAlias="Ada"
        canAppoint
        blockedAliases={[]}
      />,
    );

    openMenu("Bob");
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from room…" }));

    // The confirmation must appear before any network call.
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/Remove Bob from this room\?/);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove member" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/rooms/${ROOM_ID}/members/Bob`);
    expect(init.method).toBe("DELETE");
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // The mock confirmed the removal, so the dialog closes on server truth.
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).toBeNull(),
    );
  });

  it("surfaces a refused action as an alert instead of pretending it worked", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: { code: "cannot_remove_owner", message: "The room owner cannot be removed from their own room." },
      }),
    );
    render(
      <RoomRoster
        roomId={ROOM_ID}
        members={MEMBERS}
        moderation={moderation({ can_moderate: true })}
        viewerAlias="Ada"
        canAppoint
        blockedAliases={[]}
      />,
    );

    openMenu("Bob");
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from room…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove member" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The room owner cannot be removed from their own room.",
      ),
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("opens the report dialog from the member's menu", async () => {
    render(
      <RoomRoster
        roomId={ROOM_ID}
        members={MEMBERS}
        moderation={moderation()}
        viewerAlias="Dana"
        canAppoint={false}
        blockedAliases={[]}
      />,
    );

    openMenu("Cara");
    fireEvent.click(screen.getByRole("menuitem", { name: "Report member…" }));

    expect(
      await screen.findByRole("dialog", { name: "Report this member" }),
    ).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
