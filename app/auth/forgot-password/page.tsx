import { AuthShell } from "@/components/auth/auth-shell";
import { ForgotPasswordForm } from "@/components/forgot-password-form";

export default function Page() {
  return (
    <AuthShell>
      <div className="w-full">
        <ForgotPasswordForm />
      </div>
    </AuthShell>
  );
}
