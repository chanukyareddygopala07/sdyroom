// @vitest-environment jsdom
import { ChatPanel } from "@/components/chat-panel";
import {
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatConnectionState,
  type ChatMessageView,
} from "@/lib/chat/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOM_FIRST_MESSAGE = "44444444-4444-4444-8444-444444444444";

function message(overrides: Partial<ChatMessageView> = {}): ChatMessageView {
  return {
    id: ROOM_FIRST_MESSAGE,
    alias: "Ada",
    body: "Starting chapter 4 now.",
    created_at: "2026-10-06T07:05:00.000Z",
    status: "sent",
    is_own: false,
    ...overrides,
  };
}

/**
 * jsdom has no layout: give the scroll container explicit values so the
 * stick-to-bottom logic has something real to read and write.
 */
function asScroller(
  element: HTMLElement,
  values: { scrollHeight: number; clientHeight: number; scrollTop?: number },
): HTMLElement {
  Object.defineProperty(element, "scrollHeight", {
    value: values.scrollHeight,
    configurable: true,
  });
  Object.defineProperty(element, "clientHeight", {
    value: values.clientHeight,
    configurable: true,
  });
  Object.defineProperty(element, "scrollTop", {
    value: values.scrollTop ?? 0,
    writable: true,
    configurable: true,
  });
  return element;
}

function scrollContainer(): HTMLElement {
  const list = screen.getByRole("list", { name: "Chat messages" });
  return list.parentElement as HTMLElement;
}

describe("ChatPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the history with aliases, timestamps and landmarks", () => {
    render(
      <ChatPanel
        messages={[
          message(),
          message({
            id: "55555555-5555-4555-8555-555555555555",
            alias: "Grace",
            body: "I will do past papers.",
            is_own: true,
          }),
        ]}
        connection="live"
        onSend={vi.fn()}
      />,
    );

    expect(screen.getByRole("region", { name: "Chat" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Live");
    expect(screen.getByRole("list", { name: "Chat messages" })).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Starting chapter 4 now.")).toBeInTheDocument();

    const times = document.querySelectorAll("time");
    expect(times).toHaveLength(2);
    expect(times[0]).toHaveAttribute("dateTime", "2026-10-06T07:05:00.000Z");
    expect(times[0].textContent).toMatch(/^\d{2}:\d{2}$/);

    const own = screen.getByText("I will do past papers.").closest("li");
    expect(own).toHaveAttribute("data-own", "true");
    const other = screen.getByText("Starting chapter 4 now.").closest("li");
    expect(other).not.toHaveAttribute("data-own");
  });

  it("explains an empty room without inventing messages", () => {
    render(<ChatPanel messages={[]} connection="live" onSend={vi.fn()} />);

    expect(
      screen.getByText("No messages yet. Say hello to your study partners."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Chat messages" })).toBeNull();
  });

  it("reports the history load while it is in flight", () => {
    render(
      <ChatPanel messages={[]} connection="live" loading onSend={vi.fn()} />,
    );

    expect(screen.getByText("Loading messages…")).toBeInTheDocument();
    expect(
      screen.queryByText("No messages yet. Say hello to your study partners."),
    ).toBeNull();
  });

  it("surfaces a history failure and retries it on request", () => {
    const onRetryLoad = vi.fn();
    render(
      <ChatPanel
        messages={[]}
        connection="live"
        loadError="Could not load messages."
        onRetryLoad={onRetryLoad}
        onSend={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load messages.",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Retry loading messages" }),
    );
    expect(onRetryLoad).toHaveBeenCalledTimes(1);
  });

  it.each<[ChatConnectionState, string]>([
    ["connecting", "Connecting…"],
    ["live", "Live"],
    ["reconnecting", "Reconnecting…"],
    ["unavailable", "Chat unavailable"],
  ])("shows the %s connection state as %s", (connection, text) => {
    render(<ChatPanel messages={[]} connection={connection} onSend={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent(text);
  });

  it("blocks sending while chat is unavailable", () => {
    const onSend = vi.fn();
    render(
      <ChatPanel
        messages={[]}
        connection="unavailable"
        onSend={onSend}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Are we still on?" },
    });

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.submit(document.querySelector("form")!);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends a trimmed draft and clears the composer", () => {
    const onSend = vi.fn();
    render(<ChatPanel messages={[]} connection="live" onSend={onSend} />);

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "  On my way  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).toHaveBeenCalledWith("On my way");
    expect(screen.getByLabelText("Message")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("sends on Enter but keeps Shift+Enter and IME input for newlines", () => {
    const onSend = vi.fn();
    render(<ChatPanel messages={[]} connection="live" onSend={onSend} />);
    const composer = screen.getByLabelText("Message");

    fireEvent.change(composer, { target: { value: "First line" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("First line");
    expect(screen.getByLabelText("Message")).toHaveValue("");

    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);

    fireEvent.change(composer, { target: { value: "Composing" } });
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("refuses empty and whitespace-only drafts", () => {
    const onSend = vi.fn();
    render(<ChatPanel messages={[]} connection="live" onSend={onSend} />);

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "   " },
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("enforces the character limit and shows the counter", () => {
    const onSend = vi.fn();
    render(<ChatPanel messages={[]} connection="live" onSend={onSend} />);
    const composer = screen.getByLabelText("Message");

    expect(composer).toHaveAttribute("maxlength", String(CHAT_MESSAGE_MAX_LENGTH));
    expect(
      screen.getByText(`0 / ${CHAT_MESSAGE_MAX_LENGTH}`),
    ).toBeInTheDocument();

    // maxLength clamps real typing; this guards programmatic values too.
    fireEvent.change(composer, {
      target: { value: "x".repeat(CHAT_MESSAGE_MAX_LENGTH + 10) },
    });
    expect(
      screen.getByText(`${CHAT_MESSAGE_MAX_LENGTH + 10} / ${CHAT_MESSAGE_MAX_LENGTH}`),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.submit(document.querySelector("form")!);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows an in-flight message as sending without a retry control", () => {
    render(
      <ChatPanel
        messages={[message({ status: "pending", is_own: true })]}
        connection="live"
        onSend={vi.fn()}
      />,
    );

    expect(screen.getByText("Sending…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("keeps a failed message visible and retries it with the same id", () => {
    const onRetrySend = vi.fn();
    render(
      <ChatPanel
        messages={[message({ status: "failed", is_own: true })]}
        connection="live"
        onSend={vi.fn()}
        onRetrySend={onRetrySend}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Not sent.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetrySend).toHaveBeenCalledWith(ROOM_FIRST_MESSAGE);

    cleanup();
    render(
      <ChatPanel
        messages={[message({ status: "failed", is_own: true })]}
        connection="live"
        onSend={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Not sent.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("keeps the reader at the newest messages when they were already there", () => {
    const { rerender } = render(
      <ChatPanel messages={[message()]} connection="live" onSend={vi.fn()} />,
    );
    const scroller = asScroller(scrollContainer(), {
      scrollHeight: 500,
      clientHeight: 100,
      scrollTop: 400, // 500 - 400 - 100 = 0 from the bottom: reading the end
    });

    rerender(
      <ChatPanel
        messages={[
          message(),
          message({
            id: "55555555-5555-4555-8555-555555555555",
            body: "Second message",
          }),
        ]}
        connection="live"
        onSend={vi.fn()}
      />,
    );

    expect(scroller.scrollTop).toBe(500);
    expect(screen.queryByRole("button", { name: "New messages" })).toBeNull();
  });

  it("does not move a reader of older messages and offers a jump instead", () => {
    const { rerender } = render(
      <ChatPanel messages={[message()]} connection="live" onSend={vi.fn()} />,
    );
    const scroller = asScroller(scrollContainer(), {
      scrollHeight: 800,
      clientHeight: 200,
      scrollTop: 0, // 600px from the bottom: reading history
    });
    fireEvent.scroll(scroller);

    rerender(
      <ChatPanel
        messages={[
          message(),
          message({
            id: "55555555-5555-4555-8555-555555555555",
            body: "Newest message",
          }),
        ]}
        connection="live"
        onSend={vi.fn()}
      />,
    );

    expect(scroller.scrollTop).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "New messages" }));
    expect(scroller.scrollTop).toBe(800);
    expect(screen.queryByRole("button", { name: "New messages" })).toBeNull();

    // Scrolling back to the bottom re-arms stickiness: the control stays away.
    asScroller(scroller, { scrollHeight: 800, clientHeight: 200, scrollTop: 600 });
    fireEvent.scroll(scroller);
    rerender(
      <ChatPanel
        messages={[
          message(),
          message({
            id: "55555555-5555-4555-8555-555555555555",
            body: "Newest message",
          }),
          message({ id: "66666666-6666-4666-8666-666666666666", body: "Third" }),
        ]}
        connection="live"
        onSend={vi.fn()}
      />,
    );
    expect(scroller.scrollTop).toBe(800);
    expect(screen.queryByRole("button", { name: "New messages" })).toBeNull();
  });

  it("renders participants only when the contract supplies them", () => {
    const { rerender } = render(
      <ChatPanel messages={[]} connection="live" onSend={vi.fn()} />,
    );
    expect(screen.queryByRole("list", { name: "Participants" })).toBeNull();
    expect(screen.queryByText("Participants")).toBeNull();

    rerender(
      <ChatPanel
        messages={[]}
        connection="live"
        onSend={vi.fn()}
        participants={[
          { alias: "Ada", studying: false },
          { alias: "Grace", studying: false },
        ]}
      />,
    );
    expect(screen.getByRole("list", { name: "Participants" })).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Grace")).toBeInTheDocument();
    // Rendered in the order the data layer supplies (own alias first).
    const rendered = Array.from(
      screen.getByRole("list", { name: "Participants" }).querySelectorAll("li"),
    ).map((item) => item.textContent);
    expect(rendered).toEqual(["Ada", "Grace"]);
    // Without a session running there is nothing to claim: plain badges and
    // a plain headcount.
    expect(screen.getByText("2 here")).toBeInTheDocument();
    expect(screen.queryByText(/studying/)).toBeNull();

    rerender(
      <ChatPanel
        messages={[]}
        connection="live"
        onSend={vi.fn()}
        participants={[]}
      />,
    );
    expect(screen.getByText("Nobody here but you")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Participants" })).toBeNull();
    expect(screen.queryByText(/here$/)).toBeNull();
  });

  it("marks a studying member in the badge and the header count", () => {
    render(
      <ChatPanel
        messages={[]}
        connection="live"
        onSend={vi.fn()}
        participants={[
          { alias: "Ada", studying: true },
          { alias: "Grace", studying: false },
        ]}
      />,
    );

    // Spelled out, not just coloured: the badge reads the same to a screen
    // reader and to anyone who cannot separate the variants.
    expect(screen.getByText("Ada · studying")).toBeInTheDocument();
    expect(screen.getByText("Grace")).toBeInTheDocument();
    expect(screen.getByText("1 studying · 2 here")).toBeInTheDocument();

    // The connection badge stays a distinct, first status in the header.
    const statuses = screen.getAllByRole("status");
    expect(statuses[0]).toHaveTextContent("Live");
    expect(statuses[1]).toHaveTextContent("1 studying · 2 here");
  });
});
