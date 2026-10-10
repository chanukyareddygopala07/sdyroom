import {
  Bell,
  FileText,
  Gavel,
  Mail,
  Sparkles,
  UserMinus,
  VolumeX,
} from "lucide-react";

import type { NotificationType } from "@/lib/notifications/types";

/**
 * One icon per notification type for the inbox rows. Pure presentation: no
 * data, no fetches, safe to render from a server component or a client one.
 * The `title` on the wrapper is decorative — the row's sentence is the
 * accessible name, and every icon-only control elsewhere in the app carries
 * its own label.
 */
export function NotificationTypeIcon({
  type,
  className,
}: {
  type: NotificationType;
  className?: string;
}) {
  const Icon = ICON_BY_TYPE[type];
  return <Icon className={className} aria-hidden="true" focusable="false" />;
}

const ICON_BY_TYPE: Record<NotificationType, typeof Bell> = {
  invite_created: Mail,
  invite_accepted: Mail,
  member_removed: UserMinus,
  muted: VolumeX,
  moderation_resolved: Gavel,
  report_resolved: Gavel,
  resource_ready: FileText,
  ai_task_complete: Sparkles,
  system: Bell,
};
