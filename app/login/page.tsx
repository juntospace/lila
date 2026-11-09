import Link from "next/link";

import { EmailSignInForm } from "@/app/login/email-form";
import { GoogleSignInButton } from "@/app/login/google-button";

const ERROR_MESSAGES: Record<string, string> = {
  not_allowlisted:
    "Tu cuenta de Google no está en la lista de operadores autorizados. Solicita acceso a un administrador.",
  disabled: "Esta cuenta de operador ha sido desactivada. Contacta a un administrador.",
  oauth_failed: "Error al iniciar sesión. Por favor, intenta de nuevo.",
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
            Iniciar sesión de operador
          </h1>
          <p className="mt-1 text-sm text-fg-muted">
            Inicia sesión con correo electrónico o cuenta de Google.
          </p>

          {message ? (
            <div
              role="alert"
              className="mt-5 rounded border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger"
            >
              {message}
            </div>
          ) : null}

          <div className="mt-6 space-y-6">
            <EmailSignInForm next={next} />

            <div className="relative flex items-center justify-center">
              <div className="w-full border-t border-border-subtle" />
              <span className="absolute bg-bg-surface px-2 text-xs uppercase tracking-wider text-fg-subtle">
                O
              </span>
            </div>

            <GoogleSignInButton next={next} />
          </div>

          <p className="mt-6 text-xs text-fg-subtle">
            El acceso está restringido al personal autorizado de Junto.
          </p>
        </div>

        <p className="mt-6 text-center text-xs text-fg-subtle">
          © {new Date().getFullYear()} Junto · Panamá
        </p>
      </div>
    </main>
  );
}
