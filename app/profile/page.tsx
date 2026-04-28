import { OperatorShell } from "@/components/patterns/OperatorShell";
import {
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";
import { ProfileForm } from "@/app/profile/profile-form";
import { requireOperator } from "@/lib/auth/guard";

export default async function ProfilePage() {
  const session = await requireOperator();

  return (
    <OperatorShell session={session}>
      <header className="mb-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Your profile
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-fg-muted">
          Personal details, contact info, and notification preferences for the
          operator console. Role changes are handled by an admin.
        </p>
      </header>

      <div className="max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle>Operator details</CardTitle>
            <CardDescription>
              Used across LILA — assignment routing, notifications, and audit
              trails.
            </CardDescription>
          </CardHeader>
          <CardBody>
            <ProfileForm profile={session.profile} />
          </CardBody>
        </Card>
      </div>
    </OperatorShell>
  );
}
