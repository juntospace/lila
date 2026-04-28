import { OperatorShell } from "@/components/patterns/OperatorShell";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { requireOperator } from "@/lib/auth/guard";

const STATS = [
  { label: "Open applications", value: "—", hint: "Awaiting review" },
  { label: "Pending decisions", value: "—", hint: "Assigned to you" },
  { label: "Disbursed today", value: "—", hint: "USD" },
  { label: "Overdue ≥ 7 days", value: "—", hint: "Portfolio" },
];

export default async function HomePage() {
  const session = await requireOperator();
  const greeting = greetingFor(new Date());
  const firstName = session.profile.full_name?.split(" ")[0] ?? session.email.split("@")[0];

  return (
    <OperatorShell session={session}>
      <header className="mb-8">
        <p className="text-sm text-fg-muted">{greeting},</p>
        <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
          {firstName}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-fg-muted">
          Here&apos;s the operator console for LILA. Widgets light up as we wire the
          underlying data sources — applications, decisions, disbursements, and
          portfolio health.
        </p>
      </header>

      <section
        aria-labelledby="overview-heading"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <h2 id="overview-heading" className="sr-only">
          Overview
        </h2>
        {STATS.map((stat) => (
          <Card key={stat.label}>
            <CardBody>
              <div className="text-xs uppercase tracking-wide text-fg-subtle">
                {stat.label}
              </div>
              <div className="mt-2 font-display text-3xl font-semibold text-fg">
                {stat.value}
              </div>
              <div className="mt-1 text-xs text-fg-subtle">{stat.hint}</div>
            </CardBody>
          </Card>
        ))}
      </section>

      <section className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>
              Application updates, repayments received, and approvals from the last
              24 hours.
            </CardDescription>
          </CardHeader>
          <CardBody className="text-sm text-fg-muted">
            Activity feed will populate once the events service is wired in.
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Your queue</CardTitle>
            <CardDescription>Applications assigned to you.</CardDescription>
          </CardHeader>
          <CardBody className="text-sm text-fg-muted">
            Nothing assigned yet. Once the queue is enabled, items appear here.
          </CardBody>
        </Card>
      </section>
    </OperatorShell>
  );
}

function greetingFor(date: Date) {
  const h = date.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
