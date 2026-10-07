import {
  publishStudying,
  studyingSnapshot,
  subscribeStudying,
} from "@/lib/focus/studying-store";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("studying store", () => {
  afterEach(() => {
    publishStudying(false);
  });

  it("starts false and notifies only on a real change", () => {
    expect(studyingSnapshot()).toBe(false);

    const listener = vi.fn();
    const unsubscribe = subscribeStudying(listener);

    publishStudying(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(studyingSnapshot()).toBe(true);

    // An identical publish is a no-op: nothing re-renders for no reason.
    publishStudying(true);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    publishStudying(false);
    expect(studyingSnapshot()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeStudying(listener);
    unsubscribe();

    publishStudying(true);
    expect(listener).not.toHaveBeenCalled();
  });
});
