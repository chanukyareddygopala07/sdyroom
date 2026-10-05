"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ROOM_QUERY_MAX } from "@/lib/validation/rooms";
import { cn } from "@/lib/utils";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

/**
 * Search box for public room discovery. Submits to the same route with a `q`
 * query parameter, which the server page validates before querying. The page
 * keys this component on the active query, so a new query remounts it with a
 * fresh value instead of syncing state in an effect.
 */
export function RoomSearchForm({ className }: { className?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeQuery = searchParams.get("q") ?? "";
  const [value, setValue] = useState(activeQuery);

  const applySearch = (query: string) => {
    const trimmed = query.trim();
    router.push(trimmed ? `/rooms?q=${encodeURIComponent(trimmed)}` : "/rooms");
  };

  return (
    <form
      role="search"
      className={cn("flex w-full items-end gap-2", className)}
      onSubmit={(e) => {
        e.preventDefault();
        applySearch(value);
      }}
    >
      <div className="grid flex-1 gap-2">
        <Label htmlFor="room-search">Search public rooms</Label>
        <Input
          id="room-search"
          name="q"
          type="search"
          placeholder="Name, subject or exam track"
          maxLength={ROOM_QUERY_MAX}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <Button type="submit">Search</Button>
      {activeQuery && (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setValue("");
            applySearch("");
          }}
        >
          Clear
        </Button>
      )}
    </form>
  );
}
