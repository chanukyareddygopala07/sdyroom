import { AuthShell } from "@/components/auth/auth-shell";
import { SignUpForm } from "@/components/sign-up-form";

export default function Page() {
  return (
    <AuthShell>
      <div className="w-full">
        <SignUpForm />
      </div>
    </AuthShell>
  );
}
