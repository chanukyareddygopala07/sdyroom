// @vitest-environment jsdom
import { ModerationInbox } from "@/components/moderation-inbox";
import type { ReportSummary } from "@/lib/moderation/queries";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function report(overrides: Partial<ReportSummary> = {}): ReportSummary {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    subject_type: "message",
    subject_id: "33333333-3333-4333-8333-333333333333",
    subject_alias: null,
    reason: "harassment",
    detail: "Repeated targeted comments.",
    status: "pending",
    created_at: "2026-10-07T09:30:00.000Z",
    resolved_at: null,
    resolved_by: null,
    ...overrides,
  };
}

describe("ModerationInbox", () => {
  beforeEach(() => {
    push.mockReset();
    refresh.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders a pending report with its reason, subject and actions", () => {
    render(<ModerationInbox roomId={ROOM_ID} initialReports={[report()]} />);

    expect(screen.getByText("Harassment")).toBeDefined();
    expect(screen.getByText(/about message 33333333/)).toBeDefined();
    expect(screen.getByText("Pending")).toBeDefined();
    expect(screen.getByText("Repeated targeted comments.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Start review" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();
    expect(screen.getByText("1 report")).toBeDefined();
  });

  it("never renders a reporter reference — the projection has none to give", () => {
    render(<ModerationInbox roomId={ROOM_ID} initialReports={[report()]} />);
    expect(screen.queryByText(/reporter/i)).toBeNull();
    expect(screen.queryByText(/filed by/i)).toBeNull();
  });

  it("labels a member subject by alias and shows the resolver on terminal reports", () => {
    render(
      <ModerationInbox
        roomId={ROOM_ID}
        initialReports={[
          report({
            subject_type: "user",
            subject_id: null,
            subject_alias: "Ada",
            status: "resolved",
            resolved_at: "2026-10-07T10:00:00.000Z",
            resolved_by: "Mod",
          }),
          report({ id: "44444444-4444-4444-8444-444444444444", status: "dismissed" }),
        ]}
      />,
    );

    expect(screen.getByText(/about Ada/)).toBeDefined();
    expect(screen.getByText("Resolved")).toBeDefined();
    expect(screen.getByText(/by Mod/)).toBeDefined();
    expect(screen.getByText("Dismissed")).toBeDefined();
    // Terminal reports offer no further transitions.
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.getByText("2 reports")).toBeDefined();
  });

  it("advances a report through the API and refreshes server truth", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { report: { id: report().id, status: "reviewing" } }),
    );
    render(<ModerationInbox roomId={ROOM_ID} initialReports={[report()]} />);

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/reports/${report().id}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ status: "reviewing" });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // Reviewing offers only the terminal transitions now.
    expect(screen.queryByRole("button", { name: "Start review" })).toBeNull();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeDefined();
  });

  it("shows a refused transition as an alert and keeps the report actionable", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: { code: "invalid_transition", message: "That report status change is not allowed." },
      }),
    );
    render(<ModerationInbox roomId={ROOM_ID} initialReports={[report()]} />);

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "That report status change is not allowed.",
      ),
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeDefined();
  });

  it("explains an empty inbox without pretending there are reports", () => {
    render(<ModerationInbox roomId={ROOM_ID} initialReports={[]} />);
    expect(screen.getByText(/No reports yet/)).toBeDefined();
    expect(screen.getByText("0 reports")).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("sends a signed-out moderator to the login page", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: "unauthenticated" } }));
    render(<ModerationInbox roomId={ROOM_ID} initialReports={[report()]} />);

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/auth/login"));
  });
});
