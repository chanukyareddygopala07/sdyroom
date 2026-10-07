// @vitest-environment jsdom
import { ReportDialog } from "@/components/report-dialog";
import { REPORT_DETAIL_MAX } from "@/lib/validation/moderation";
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

function sentBody() {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

function chooseReason(label: RegExp) {
  fireEvent.click(screen.getByRole("radio", { name: label }));
}

describe("ReportDialog", () => {
  beforeEach(() => {
    push.mockReset();
    refresh.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers only the closed reason list and no preselected answer", () => {
    render(
      <ReportDialog
        open
        onOpenChange={() => undefined}
        roomId="11111111-1111-4111-8111-111111111111"
        subject={{ type: "message", id: "22222222-2222-4222-8222-222222222222" }}
      />,
    );

    const radios = screen.getAllByRole("radio") as HTMLElement[];
    expect(radios).toHaveLength(7);
    expect(screen.getByRole("radio", { name: /Harassment/ })).toBeDefined();
    expect(screen.getByRole("radio", { name: /Spam/ })).toBeDefined();
    expect(
      screen.getByRole("radio", { name: /Something else/ }),
    ).toBeDefined();
    for (const radio of radios) {
      expect(radio.getAttribute("aria-checked")).toBe("false");
    }
    expect(
      screen.getByRole("button", { name: /Send report/i }),
    ).toHaveProperty("disabled", true);
  });

  it("bounds the detail field to the contract length", () => {
    render(
      <ReportDialog
        open
        onOpenChange={() => undefined}
        roomId="11111111-1111-4111-8111-111111111111"
        subject={{ type: "user", alias: "Ada" }}
      />,
    );

    expect(screen.getByLabelText("Detail (optional)")).toHaveAttribute(
      "maxlength",
      String(REPORT_DETAIL_MAX),
    );
  });

  it("files the report with the strict body and confirms without a reporter field", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { report: { id: "33333333-3333-4333-8333-333333333333", status: "pending" } }),
    );
    const onOpenChange = vi.fn();
    render(
      <ReportDialog
        open
        onOpenChange={onOpenChange}
        roomId="11111111-1111-4111-8111-111111111111"
        subject={{ type: "message", id: "22222222-2222-4222-8222-222222222222" }}
      />,
    );

    chooseReason(/Harassment/);
    fireEvent.change(screen.getByLabelText("Detail (optional)"), {
      target: { value: "Repeated targeted comments." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send report/i }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /your report was sent/i,
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/rooms/11111111-1111-4111-8111-111111111111/reports",
      expect.objectContaining({ method: "POST" }),
    );
    expect(sentBody()).toEqual({
      subject_type: "message",
      subject_id: "22222222-2222-4222-8222-222222222222",
      reason: "harassment",
      detail: "Repeated targeted comments.",
    });
    expect(refresh).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("omits an empty detail rather than sending a blank string", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { report: { id: "r", status: "pending" } }));
    render(
      <ReportDialog
        open
        onOpenChange={() => undefined}
        roomId="11111111-1111-4111-8111-111111111111"
        subject={{ type: "resource", id: "22222222-2222-4222-8222-222222222222" }}
      />,
    );

    chooseReason(/Spam/);
    fireEvent.click(screen.getByRole("button", { name: /Send report/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody()).toEqual({
      subject_type: "resource",
      subject_id: "22222222-2222-4222-8222-222222222222",
      reason: "spam",
    });
  });

  it("shows the server's message when the report is refused and stays open", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: { code: "self_report", message: "You cannot report your own content." },
      }),
    );
    render(
      <ReportDialog
        open
        onOpenChange={() => undefined}
        roomId="11111111-1111-4111-8111-111111111111"
        subject={{ type: "user", alias: "Ada" }}
      />,
    );

    chooseReason(/Something else/);
    fireEvent.click(screen.getByRole("button", { name: /Send report/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "You cannot report your own content.",
      ),
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Send report/i }),
    ).toHaveProperty("disabled", false);
  });

  it("sends a signed-out reporter to the login page", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: "unauthenticated" } }));
    render(
      <ReportDialog
        open
        onOpenChange={() => undefined}
        roomId="11111111-1111-4111-8111-111111111111"
        subject={{ type: "user", alias: "Ada" }}
      />,
    );

    chooseReason(/Spam/);
    fireEvent.click(screen.getByRole("button", { name: /Send report/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/auth/login"));
  });

  it("closes on cancel without filing anything", () => {
    const onOpenChange = vi.fn();
    render(
      <ReportDialog
        open
        onOpenChange={onOpenChange}
        roomId="11111111-1111-4111-8111-111111111111"
        subject={{ type: "user", alias: "Ada" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
