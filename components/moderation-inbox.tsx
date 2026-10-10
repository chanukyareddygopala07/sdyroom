"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ReportSummary } from "@/lib/moderation/queries";
import { useRouter } from "next/navigation";
import { useState } from "react";

const REASON_LABELS: Record<string, string> = {
  spam: "Spam",
  harassment: "Harassment",
  abusive_content: "Abusive content",
  inappropriate_content: "Inappropriate content",
  impersonation: "Impersonation",
  unsafe_resource: "Unsafe or harmful file",
  other: "Something else",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  reviewing: "Reviewing",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

function subjectLabel(report: ReportSummary): string {
  if (report.subject_type === "user") {
    return report.subject_alias ?? "member";
  }
  const shortId = report.subject_id?.slice(0, 8) ?? "?";
  return report.subject_type === "message" ? `message ${shortId}` : `file ${shortId}`;
}

/**
 * The room-scoped moderation inbox: owner and moderators only (the page
 * renders it behind `can_moderate`, and the API re-proves that per call).
 *
 * Seeded server-side with `room_report_list` — an explicit projection that
 * contains no reporter id anywhere in the payload — and advanced through the
 * same `PATCH /api/reports/[id]` any caller would use, so the UI cannot show
 * a state the API would refuse. After each action `router.refresh()` re-reads
 * the server's truth (resolution stamps included) rather than trusting the
 * client's guess.
 */
export function ModerationInbox({
  roomId,
  initialReports,
}: {
  roomId: string;
  initialReports: ReportSummary[];
}) {
  const router = useRouter();
  const [reports, setReports] = useState<ReportSummary[]>(initialReports);
  const [syncedSeed, setSyncedSeed] = useState<ReportSummary[]>(initialReports);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A room switch or an invalidated server render replaces the seed — the
  // inbox must never show the previous room's reports while it revalidates.
  // Adjusted during render (the React-recommended prop-to-state sync), not
  // in an effect, so one paint never shows the stale list.
  if (syncedSeed !== initialReports) {
    setSyncedSeed(initialReports);
    setReports(initialReports);
  }

  const transition = async (
    report: ReportSummary,
    status: "reviewing" | "resolved" | "dismissed",
  ) => {
    setBusyId(report.id);
    setError(null);
    try {
      const response = await fetch(`/api/reports/${report.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        throw new Error(
          payload?.error?.message ?? "The report could not be updated.",
        );
      }
      setReports((current) =>
        current.map((entry) =>
          entry.id === report.id
            ? { ...entry, status: status as ReportSummary["status"] }
            : entry,
        ),
      );
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The report could not be updated.",
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      aria-labelledby={`inbox-${roomId}`}
      className="flex flex-col gap-3 rounded-xl border p-5"
    >
      <div className="flex items-baseline gap-2">
        <h2 id={`inbox-${roomId}`} className="text-lg font-semibold">
          Moderation
        </h2>
        <span className="text-sm text-muted-foreground">
          {reports.length} {reports.length === 1 ? "report" : "reports"}
        </span>
      </div>

      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}

      {reports.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No reports yet. Reported messages, members and files appear here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {reports.map((report) => (
            <li
              key={report.id}
              className="flex flex-col gap-2 rounded-md border border-border px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  {REASON_LABELS[report.reason] ?? report.reason}
                </span>
                <span className="text-xs text-muted-foreground">
                  about {subjectLabel(report)}
                </span>
                <Badge
                  variant={
                    report.status === "resolved"
                      ? "default"
                      : report.status === "dismissed"
                        ? "secondary"
                        : "outline"
                  }
                >
                  {STATUS_LABELS[report.status] ?? report.status}
                </Badge>
                <time
                  className="text-xs text-muted-foreground"
                  dateTime={report.created_at}
                >
                  {/* Fixed UTC slice, never toLocaleDateString: server and
                      browser must agree or hydration mismatches. */}
                  {report.created_at.slice(0, 10)}
                </time>
                {report.resolved_by && (
                  <span className="text-xs text-muted-foreground">
                    by {report.resolved_by}
                  </span>
                )}
              </div>

              {report.detail && (
                <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {report.detail}
                </p>
              )}

              {report.status !== "resolved" && report.status !== "dismissed" && (
                <div className="flex flex-wrap gap-2">
                  {report.status === "pending" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busyId !== null}
                      aria-busy={busyId === report.id}
                      onClick={() => void transition(report, "reviewing")}
                    >
                      Start review
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    disabled={busyId !== null}
                    aria-busy={busyId === report.id}
                    onClick={() => void transition(report, "resolved")}
                  >
                    Resolve
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busyId !== null}
                    aria-busy={busyId === report.id}
                    onClick={() => void transition(report, "dismissed")}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
