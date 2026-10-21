"use client";

import {
  CATEGORY_LABELS,
  communityApiErrorMessage,
  memberCountLabel,
} from "@/components/communities/_shared";
import { CommunityWorkspace } from "@/components/communities/community-workspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CommunityApiError,
  getCommunityClient,
  joinCommunityClient,
  type CommunityDetail,
} from "@/lib/communities/api";
import { createClient } from "@/lib/supabase/client";
import { notFound, useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type View = "loading" | "ready" | "missing" | "unauthenticated" | "error";

/**
 * One community (the route's client body; the session gate and the
 * `instant = false` segment config live in the server page). Active members
 * land in the encrypted workspace; everyone else sees the public hero with
 * the join (or request) flow. A private community the viewer may not see
 * answers `not_found` from the API, which maps to the route's not-found
 * boundary — the route is never an existence oracle.
 */
export function CommunityDetailView() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [view, setView] = useState<View>("loading");
  const [detail, setDetail] = useState<CommunityDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // The first setState happens only after the fetch resolves; the mount
  // effect below starts in "loading" already, and retries paint it in their
  // own click handler (react-hooks/set-state-in-effect).
  const load = useCallback(async () => {
    try {
      const next = await getCommunityClient(id);
      setDetail(next);
      setLoadError(null);
      setView("ready");
    } catch (caught) {
      if (caught instanceof CommunityApiError) {
        if (caught.code === "not_found") {
          setView("missing");
          return;
        }
        if (caught.code === "unauthenticated") {
          setView("unauthenticated");
          return;
        }
        setLoadError(caught.message);
      } else {
        setLoadError("This community could not be loaded.");
      }
      setView("error");
    }
  }, [id]);

  useEffect(() => {
    // Deferred through a promise callback: the loader must not start
    // synchronously inside the effect body (react-hooks/set-state-in-effect).
    void Promise.resolve().then(() => load());
  }, [load]);

  // The API never echoes the caller's id, so the browser session supplies it.
  useEffect(() => {
    const supabase = createClient();
    let disposed = false;
    void supabase.auth.getUser().then(({ data }) => {
      if (disposed) return;
      if (data.user) {
        setUserId(data.user.id);
      } else {
        setView("unauthenticated");
      }
    });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (view === "unauthenticated") {
      router.replace("/auth/login");
    }
  }, [view, router]);

  const handleJoin = async () => {
    if (joining) return;
    setJoining(true);
    setJoinError(null);
    try {
      await joinCommunityClient(id);
      // Re-read the community: the membership row (active or requested)
      // decides which face of the page renders next.
      await load();
    } catch (caught) {
      setJoinError(
        communityApiErrorMessage(caught, "You could not join this community."),
      );
    } finally {
      setJoining(false);
    }
  };

  if (view === "missing") {
    notFound();
  }

  if (view === "unauthenticated" || (view === "loading" && !detail)) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading community…
      </p>
    );
  }

  if (view === "error") {
    return (
      <section className="flex flex-col items-start gap-3">
        <h1 className="text-2xl font-semibold">Community unavailable</h1>
        <p role="alert" className="text-sm text-error">
          {loadError}
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setView("loading");
            setLoadError(null);
            void load();
          }}
        >
          Try again
        </Button>
      </section>
    );
  }

  if (!detail || !userId) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading community…
      </p>
    );
  }

  const { community, membership } = detail;

  if (membership?.status === "active") {
    return (
      <CommunityWorkspace
        community={community}
        membership={{
          role: membership.role,
          status: membership.status,
          joined_at: membership.joined_at,
        }}
        userId={userId}
      />
    );
  }

  const isRequested = membership?.status === "requested";

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{community.name}</h1>
          <Badge variant="outline">
            {CATEGORY_LABELS[community.category] ?? community.category}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {memberCountLabel(community.member_count)}
        </p>
      </header>

      {community.description && (
        <p className="max-w-2xl whitespace-pre-wrap text-sm">
          {community.description}
        </p>
      )}

      {community.rules && (
        <div className="flex max-w-2xl flex-col gap-2 rounded-xl border p-4">
          <h2 className="text-sm font-semibold">Rules</h2>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {community.rules}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {isRequested ? (
          <p
            role="status"
            className="rounded-md border border-dashed px-4 py-2 text-sm text-muted-foreground"
          >
            Request pending — community staff will review it.
          </p>
        ) : (
          <Button
            type="button"
            disabled={joining}
            aria-busy={joining}
            onClick={() => void handleJoin()}
          >
            {joining
              ? "Joining…"
              : community.join_policy === "request"
                ? "Request to join"
                : "Join community"}
          </Button>
        )}
      </div>

      {joinError && (
        <p role="alert" className="text-sm text-error">
          {joinError}
        </p>
      )}
    </section>
  );
}
