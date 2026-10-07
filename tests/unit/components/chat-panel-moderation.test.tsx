// @vitest-environment jsdom
import { ChatPanel } from "@/components/chat-panel";
import {
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatMessageView,
} from "@/lib/chat/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

function message(overrides: Partial<ChatMessageView> = {}): ChatMessageView {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    alias: "Ada",
    body: "Starting chapter 4 now.",
    created_at: "2026-10-06T07:05:00.000Z",
    status: "sent",
    is_own: false,
    ...overrides,
  };
}

function renderPanel(
  overrides: Partial<Parameters<typeof ChatPanel>[0]> = {},
) {
  const onSend = vi.fn();
  render(
    <ChatPanel
      messages={[message(), message({ id: "55555555-5555-4555-8555-555555555555", alias: "Bob", is_own: true, body: "My own line." })]}
      connection="live"
      onSend={onSend}
      {...overrides}
    />,
  );
  return { onSend };
}

describe("ChatPanel moderation affordances", () => {
  afterEach(cleanup);

  it("disables the composer and explains the mute without a round trip", () => {
    const { onSend } = renderPanel({
      muted: true,
      mutedUntil: "2026-10-07T12:34:00.000Z",
    });

    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(textarea.placeholder).toContain("cannot send messages");
    // The connection chip is also a status live region — find the mute one.
    const notice = screen
      .getAllByRole("status")
      .find((el) => (el.textContent ?? "").includes("muted in this room"));
    expect(notice).toBeDefined();
    expect(notice!.textContent).toContain(
      "You are muted in this room until 2026-10-07 12:34 UTC",
    );
    expect(notice!.textContent).toContain("cannot send messages");

    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.submit(document.querySelector("form")!);
    expect(onSend).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Send" }),
    ).toHaveProperty("disabled", true);
  });

  it("keeps the composer usable when the mute ends", () => {
    renderPanel({ muted: false, mutedUntil: null });
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    expect(screen.queryByText(/You are muted/)).toBeNull();
    expect(textarea.maxLength).toBe(CHAT_MESSAGE_MAX_LENGTH);
  });

  it("offers a report action on other members' sent messages only", () => {
    const onReportMessage = vi.fn();
    renderPanel({ onReportMessage });

    expect(
      screen.getByRole("button", { name: "Report message from Ada" }),
    ).toBeDefined();
    // Never on your own line.
    expect(
      screen.queryByRole("button", { name: "Report message from Bob" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Report message from Ada" }),
    );
    expect(onReportMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "44444444-4444-4444-8444-444444444444" }),
    );
  });

  it("renders no report action when the surface has no dialog to host", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: /Report message/ })).toBeNull();
  });
});
