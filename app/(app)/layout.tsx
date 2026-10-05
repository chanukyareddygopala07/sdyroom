import { SiteShell } from "@/components/site-shell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <SiteShell>{children}</SiteShell>;
}
