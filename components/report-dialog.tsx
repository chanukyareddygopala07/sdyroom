"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { REPORT_DETAIL_MAX, REPORT_REASONS } from "@/lib/validation/moderation";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** Human labels for the closed reason enum — the wire value stays snake_case. */
const REASON_LABELS: Record<(typeof REPORT_REASONS)[number], string> = {
  spam: "Spam",
  harassment: "Harassment",
  abusive_content: "Abusive content",
  inappropriate_content: "Inappropriate content",
  impersonation: "Impersonation",
  unsafe_resource: "Unsafe or harmful file",
  other: "Something else",
};

export type ReportSubject =
  | { type: "message"; id: string }
  | { type: "user"; alias: string }
  | { type: "resource"; id: string };

const SUBJECT_COPY: Record<ReportSubject["type"], string> = {
  message: "this message",
  user: "this member",
  resource: "this file",
};

/**
 * The report dialog: one shared surface for message, member and file
 * reports, opened from whichever affordance produced the subject.
 *
 * The body it sends is the strict union from `lib/validation/moderation` —
 * subject, reason, optional detail — and nothing about the reporter travels
 * with it: identity is taken from the session inside the RPC, so there is no
 * field to forge even if the network were hostile. Success is stated plainly
 * without promising an outcome; errors render the server's message verbatim.
 */
export function ReportDialog({
  open,
  onOpenChange,
  roomId,
  subject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
  subject: ReportSubject;
}) {
  const router = useRouter();
  const [reason, setReason] = useState<string>("");
  const [detail, setDetail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setReason("");
    setDetail("");
    setStatus("idle");
    setError(null);
  };

  const handleChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status !== "idle" || reason === "") return;

    setStatus("sending");
    setError(null);

    try {
      const response = await fetch(`/api/rooms/${roomId}/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          subject.type === "user"
            ? {
                subject_type: "user",
                subject_alias: subject.alias,
                reason,
                detail: detail.trim() ? detail.trim() : undefined,
              }
            : subject.type === "message"
              ? {
                  subject_type: "message",
                  subject_id: subject.id,
                  reason,
                  detail: detail.trim() ? detail.trim() : undefined,
                }
              : {
                  subject_type: "resource",
                  subject_id: subject.id,
                  reason,
                  detail: detail.trim() ? detail.trim() : undefined,
                },
        ),
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
          payload?.error?.message ?? "The report could not be filed.",
        );
      }

      setStatus("sent");
      router.refresh();
    } catch (caught) {
      setStatus("idle");
      setError(
        caught instanceof Error
          ? caught.message
          : "The report could not be filed.",
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report {SUBJECT_COPY[subject.type]}</DialogTitle>
          <DialogDescription>
            Room moderators review reports privately. The person you report
            never sees who filed it.
          </DialogDescription>
        </DialogHeader>

        {status === "sent" ? (
          <div className="flex flex-col gap-3" role="status">
            <p className="text-sm">
              Thanks — your report was sent to this room&apos;s moderators.
            </p>
            <DialogFooter>
              <Button type="button" onClick={() => handleChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">Reason</legend>
              <RadioGroup
                value={reason}
                onValueChange={setReason}
                name="report-reason"
                aria-label="Reason"
                required
              >
                {REPORT_REASONS.map((value) => (
                  <Label
                    key={value}
                    htmlFor={`report-reason-${value}`}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-normal"
                  >
                    <RadioGroupItem
                      id={`report-reason-${value}`}
                      value={value}
                    />
                    {REASON_LABELS[value]}
                  </Label>
                ))}
              </RadioGroup>
            </fieldset>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="report-detail">Detail (optional)</Label>
              <Textarea
                id="report-detail"
                value={detail}
                onChange={(event) => setDetail(event.target.value)}
                placeholder="Anything a moderator should know"
                maxLength={REPORT_DETAIL_MAX}
                className="min-h-16"
              />
              <span className="text-xs text-muted-foreground">
                {detail.length} / {REPORT_DETAIL_MAX}
              </span>
            </div>

            {error && (
              <p role="alert" className="text-sm text-red-500">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => handleChange(false)}
                disabled={status === "sending"}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={reason === "" || status === "sending"}
                aria-busy={status === "sending"}
              >
                {status === "sending" ? "Sending…" : "Send report"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
