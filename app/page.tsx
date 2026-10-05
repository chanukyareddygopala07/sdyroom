import { SiteShell } from "@/components/site-shell";
import { Button } from "@/components/ui/button";
import Link from "next/link";

const features = [
  {
    title: "Choose a study alias",
    body: "One-time onboarding gives you a public alias. It is the only identity that appears anywhere in the app.",
  },
  {
    title: "Public or private rooms",
    body: "Public rooms are searchable by anyone signed in. Private rooms are created unlisted and never show up in discovery.",
  },
  {
    title: "A goal and a seat count",
    body: "Every room states its exam track, subject, shared goal and capacity, so a group stays small enough to work together.",
  },
];

export default function Home() {
  return (
    <SiteShell>
      <section className="flex flex-col items-center gap-6 pt-8 text-center">
        <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
          SdyRoom
        </p>
        <h1 className="max-w-2xl text-4xl font-semibold leading-tight">
          Find a study room, share a goal, and prepare together.
        </h1>
        <p className="max-w-xl text-muted-foreground">
          SdyRoom keeps study groups small and focused: pick an exam track,
          join a capacity-limited room, and work towards one shared goal.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Button asChild>
            <Link href="/auth/sign-up">Create an account</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/rooms">Browse public rooms</Link>
          </Button>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {features.map((feature) => (
          <article
            key={feature.title}
            className="flex flex-col gap-2 rounded-lg border p-4 text-left"
          >
            <h2 className="font-semibold">{feature.title}</h2>
            <p className="text-sm text-muted-foreground">{feature.body}</p>
          </article>
        ))}
      </section>
    </SiteShell>
  );
}
