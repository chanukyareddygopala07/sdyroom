"use client";

import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { MeetingStage } from "./meeting/meeting-stage";

/**
 * The dual-mode shell of a room: the study workspace (timer, goals, chat,
 * roster) and the live-meeting view of the same room. The chat stays mounted
 * and visible in both modes — it is the meeting's text channel — and so do
 * the roster and timer in study mode; the meeting view simply takes over the
 * main column and hides the study-only panels via `display` so their state
 * (timer, chat socket, drafts) survives the switch.
 *
 * Mode is UI state only: joining re-proves room membership server-side on
 * every token request, and switching back to Study unmounts the meeting,
 * which disconnects LiveKit and stops every local track. Nothing here
 * authorizes anything — the token route and the existing panel APIs each
 * re-prove their own access.
 */
export function RoomWorkspace({
  roomId,
  meetingConfigured,
  rail,
  studyMain,
  chat,
  resources,
  artifacts,
}: {
  roomId: string;
  meetingConfigured: boolean;
  /** Members rail: roster, moderation inbox, invite panel. */
  rail: ReactNode;
  /** Study-mode main column above chat: focus timer and goals. */
  studyMain: ReactNode;
  /** Room chat — visible in both study and meeting mode. */
  chat: ReactNode;
  /** Resource library and generated artifacts, study mode only. */
  resources: ReactNode;
  artifacts: ReactNode;
}) {
  const [mode, setMode] = useState<"study" | "meeting">("study");
  const inMeeting = mode === "meeting";

  return (
    <div className="flex flex-col gap-6">
      <div
        role="group"
        aria-label="Workspace view"
        className="flex items-center gap-2"
      >
        <Button
          type="button"
          size="sm"
          variant={inMeeting ? "outline" : "default"}
          aria-pressed={!inMeeting}
          onClick={() => setMode("study")}
        >
          Study
        </Button>
        <Button
          type="button"
          size="sm"
          variant={inMeeting ? "default" : "outline"}
          aria-pressed={inMeeting}
          disabled={!meetingConfigured}
          title={
            meetingConfigured
              ? undefined
              : "Live meetings are not configured on this server yet."
          }
          onClick={() => setMode("meeting")}
        >
          Meeting
        </Button>
      </div>

      {/* Desktop: a members rail beside the working column. DOM order is
          unchanged (roster first, like the stacked phone layout), so screen
          readers and tests see the same sequence at every width — only the
          grid placement differs. In meeting mode the same wrapper becomes a
          plain column and the study-only rail is hidden, so the element
          identity of the chat and the main column survives the switch. */}
      <div
        className={
          inMeeting
            ? "flex flex-col gap-6"
            : "grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]"
        }
      >
        <div className={inMeeting ? "hidden" : "flex flex-col gap-6"}>
          {rail}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          {inMeeting ? (
            <MeetingStage
              roomId={roomId}
              meetingConfigured={meetingConfigured}
              onLeave={() => setMode("study")}
            />
          ) : null}
          <div className={inMeeting ? "hidden" : "flex flex-col gap-6"}>
            {studyMain}
          </div>
          {chat}
        </div>
      </div>

      <div className={inMeeting ? "hidden" : undefined}>{resources}</div>
      <div className={inMeeting ? "hidden" : undefined}>{artifacts}</div>
    </div>
  );
}
