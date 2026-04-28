import Link from "next/link";

import { GoogleSignInButton } from "@/app/login/google-button";

const ERROR_MESSAGES: Record<string, string> = {
  not_allowlisted:
    "Your Google account isn't on the operator allowlist. Ask an admin to invite you.",
  disabled: "This operator account has been disabled. Contact an admin.",
  oauth_failed: "Sign-in failed. Please try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  const message = error ? ERROR_MESSAGES[error] : null;

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="mb-10 text-center">
          <Link
            href="/login"
            className="inline-block font-display text-3xl font-semibold tracking-tight text-fg"
          >
            LILA
          </Link>
          <p className="mt-2 text-sm text-fg-muted">
            Lending Intelligence and Loan Automation
          </p>
        </div>

        <div className="rounded-xl border border-border-subtle bg-bg-surface p-8 shadow-e2">
          <h1 className="font-display text-xl font-semibold text-fg">
            Operator sign-in
          </h1>
          <p className="mt-1 text-sm text-fg-muted">
            Use your Junto Google account.
          </p>

          {message ? (
            <div
              role="alert"
              className="mt-5 rounded border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger"
            >
              {message}
            </div>
          ) : null}

          <div className="mt-6">
            <GoogleSignInButton next={next} />
          </div>

          <p className="mt-6 text-xs text-fg-subtle">
            Access is restricted to invited Junto personnel. Borrower sign-in is
            available separately.
          </p>
        </div>

        <p className="mt-6 text-center text-xs text-fg-subtle">
          © {new Date().getFullYear()} Junto · Panama
        </p>
      </div>
    </main>
  );
}
