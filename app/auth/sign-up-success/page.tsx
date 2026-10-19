import { AuthShell } from "@/components/auth/auth-shell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function Page() {
  return (
    <AuthShell>
      <div className="flex w-full flex-col gap-6">
        <Card className="border bg-card shadow-sm">
          <CardHeader className="text-center">
            <CardTitle as="h1" className="text-2xl">
              Check your email
            </CardTitle>
            <CardDescription>Confirm your account to continue</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <p className="text-sm text-muted-foreground">
              You&apos;re almost in. Open the confirmation link we just sent
              to finish creating your account, then sign in.
            </p>
          </CardContent>
        </Card>
      </div>
    </AuthShell>
  );
}
