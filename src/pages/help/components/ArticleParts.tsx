/**
 * Reusable building blocks for help articles. Keep these consistent so every
 * article in /help looks and behaves the same.
 */
import { LucideIcon, Info, AlertTriangle, Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";

export function ArticleSection({
  id,
  title,
  icon: Icon,
  children,
}: {
  id: string;
  title: string;
  icon?: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="space-y-3 scroll-mt-20">
      <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
        {Icon && <Icon className="h-5 w-5 text-primary" />}
        {title}
      </h2>
      <div className="text-sm leading-relaxed text-foreground/90 space-y-3">
        {children}
      </div>
    </section>
  );
}

export function ArticleStep({
  n,
  title,
  icon: Icon,
  children,
}: {
  n: number;
  title: string;
  icon?: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4 rounded-lg border bg-card p-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold text-sm">
        {n}
      </div>
      <div className="space-y-1.5 text-sm leading-relaxed">
        <h3 className="font-semibold flex items-center gap-2">
          {Icon && <Icon className="h-4 w-4 text-primary" />}
          {title}
        </h3>
        <div className="text-muted-foreground [&_strong]:text-foreground [&_em]:text-foreground">
          {children}
        </div>
      </div>
    </div>
  );
}

const calloutStyles = {
  info: { Icon: Info, ring: "border-primary/30 bg-primary/5", icon: "text-primary" },
  warn: { Icon: AlertTriangle, ring: "border-amber-500/40 bg-amber-500/5", icon: "text-amber-500" },
  tip: { Icon: Lightbulb, ring: "border-emerald-500/40 bg-emerald-500/5", icon: "text-emerald-500" },
} as const;

export function ArticleCallout({
  tone = "info",
  className,
  children,
}: {
  tone?: keyof typeof calloutStyles;
  className?: string;
  children: React.ReactNode;
}) {
  const { Icon, ring, icon } = calloutStyles[tone];
  return (
    <div className={cn("flex gap-3 rounded-md border px-3 py-2 text-sm", ring, className)}>
      <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", icon)} />
      <div className="leading-relaxed">{children}</div>
    </div>
  );
}
