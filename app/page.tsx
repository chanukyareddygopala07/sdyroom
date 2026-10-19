import { BrandMark } from "@/components/brand-mark";
import { SiteShell } from "@/components/site-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BarChart3,
  FileText,
  MessageCircle,
  Sparkles,
  Timer,
  Users,
} from "lucide-react";
import Link from "next/link";

const features = [
  {
    icon: Users,
    title: "Small, capacity-limited rooms",
    body: "Every room states its exam track, subject, shared goal and seat count, so a group stays small enough to work together.",
  },
  {
    icon: Timer,
    title: "Focus sessions together",
    body: "A shared countdown, per-person studying time and recent sessions keep the room on the same clock.",
  },
  {
    icon: MessageCircle,
    title: "Room chat that stays in the room",
    body: "Messages are scoped to members, with moderation tools for owners and moderators when a room needs them.",
  },
  {
    icon: FileText,
    title: "Notes and resources in one place",
    body: "Share files with your room or keep a personal library — search by subject and chapter, and index documents for AI.",
  },
  {
    icon: Sparkles,
    title: "AI help grounded in your notes",
    body: "Ask questions about your indexed documents, or generate quizzes and flashcard decks from them. Where available.",
  },
  {
    icon: BarChart3,
    title: "Planner and analytics",
    body: "Build a study plan per room and track your own focus history, so progress is visible instead of imagined.",
  },
] as const;

const steps = [
  {
    step: "1",
    title: "Pick a study alias",
    body: "One-time onboarding gives you a public alias. It is the only identity that appears anywhere in the app.",
  },
  {
    step: "2",
    title: "Find or create a room",
    body: "Search public rooms by exam track and subject, or create your own — public and discoverable, or private and unlisted.",
  },
  {
    step: "3",
    title: "Study towards one goal",
    body: "Run focus sessions, share resources, plan the week, and keep each other honest until the exam.",
  },
] as const;

/**
 * Product preview shown under the hero: a static, decorative mock of the
 * workspace (roster, timer, chat, goals). Marked `aria-hidden` so assistive
 * tech only ever sees the real copy around it, and it presents no live data.
 */
function ProductPreview() {
  return (
    <div
      aria-hidden="true"
      className="relative mx-auto w-full max-w-3xl select-none overflow-hidden rounded-xl border bg-card shadow-2xl shadow-brand-violet/10"
    >
      <div className="flex items-center gap-2 border-b bg-surface-2 px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-brand-blue/70" />
        <span className="size-2.5 rounded-full bg-brand-violet/70" />
        <span className="size-2.5 rounded-full bg-muted-foreground/30" />
        <span className="ml-2 truncate text-xs text-muted-foreground">
          NEET Biology · Cell structure
        </span>
        <Badge className="ml-auto hidden sm:inline-flex" variant="secondary">
          Open
        </Badge>
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border bg-surface-2 p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Focus session
            </p>
            <p className="font-mono text-3xl font-semibold tabular-nums">
              24:59
            </p>
            <p className="text-xs text-muted-foreground">
              3 studying · 1 on a break
            </p>
          </div>
          <div className="rounded-lg border bg-surface-2 p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Roster
            </p>
            <ul className="mt-1 flex flex-col gap-1 text-sm">
              <li className="flex items-center justify-between">
                <span>amara_k</span>
                <span className="text-xs text-success">studying</span>
              </li>
              <li className="flex items-center justify-between">
                <span>dev_prep</span>
                <span className="text-xs text-muted-foreground">break</span>
              </li>
              <li className="flex items-center justify-between">
                <span>you</span>
                <span className="text-xs text-success">studying</span>
              </li>
            </ul>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex min-h-32 flex-1 flex-col rounded-lg border bg-surface-2 p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Room chat
            </p>
            <ul className="mt-2 flex flex-1 flex-col justify-end gap-2 text-sm">
              <li className="max-w-[85%] rounded-lg rounded-bl-sm bg-muted px-3 py-1.5">
                Starting a 25-minute sprint on mitosis now.
              </li>
              <li className="ml-auto max-w-[85%] rounded-lg rounded-br-sm bg-primary px-3 py-1.5 text-primary-foreground">
                In — I&apos;ll do the flashcards after.
              </li>
            </ul>
          </div>
          <div className="rounded-lg border bg-surface-2 p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Shared goal
            </p>
            <p className="mt-1 text-sm">
              Finish Unit 4 notes and 2 mixed quizzes before Sunday.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <SiteShell>
      <section className="relative flex flex-col items-center gap-6 overflow-hidden rounded-b-3xl bg-glow-brand pt-10 text-center sm:pt-14">
        <BrandMark size={72} alt="SdyRoom logo" className="drop-shadow-lg" />
        <Badge variant="secondary" className="uppercase tracking-widest">
          Study rooms for exam prep
        </Badge>
        <h1 className="max-w-2xl text-4xl font-semibold leading-tight sm:text-5xl">
          Study better, <span className="text-gradient-brand">together</span>.
        </h1>
        <p className="max-w-xl text-muted-foreground">
          SdyRoom keeps study groups small and focused: pick an exam track,
          join a capacity-limited room, and work towards one shared goal —
          with a timer, chat, resources and a plan everyone can see.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Button asChild size="lg" className="bg-gradient-brand">
            <Link href="/auth/sign-up">Create an account</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/rooms">Browse public rooms</Link>
          </Button>
        </div>
        <div className="w-full pt-6">
          <ProductPreview />
        </div>
      </section>

      <section aria-labelledby="features-heading" className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 id="features-heading" className="text-2xl font-semibold">
            Everything a study group needs
          </h2>
          <p className="max-w-xl text-muted-foreground">
            No social feed, no infinite scroll — just the tools that keep a
            small room working towards one exam.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <article
              key={feature.title}
              className="flex flex-col gap-3 rounded-xl border bg-card p-5 text-left"
            >
              <span className="flex size-9 items-center justify-center rounded-lg bg-gradient-brand-soft text-brand-blue">
                <feature.icon className="size-5" aria-hidden="true" />
              </span>
              <h3 className="font-semibold">{feature.title}</h3>
              <p className="text-sm text-muted-foreground">{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="steps-heading" className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 id="steps-heading" className="text-2xl font-semibold">
            How it works
          </h2>
        </div>
        <ol className="grid gap-4 sm:grid-cols-3">
          {steps.map((item) => (
            <li
              key={item.step}
              className="flex flex-col gap-2 rounded-xl border bg-card p-5 text-left"
            >
              <span className="flex size-8 items-center justify-center rounded-full bg-gradient-brand text-sm font-semibold text-white">
                {item.step}
              </span>
              <h3 className="font-semibold">{item.title}</h3>
              <p className="text-sm text-muted-foreground">{item.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col items-center gap-4 rounded-xl border bg-gradient-brand-soft p-8 text-center">
        <h2 className="text-2xl font-semibold">Ready to join a room?</h2>
        <p className="max-w-md text-muted-foreground">
          Create an alias, find a public room on your exam track, or open
          your own and invite the people you study with.
        </p>
        <Button asChild size="lg" className="bg-gradient-brand">
          <Link href="/auth/sign-up">Get started</Link>
        </Button>
      </section>
    </SiteShell>
  );
}
