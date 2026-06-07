/**
 * /help — Help & Documentation hub.
 *
 * Layout: left sidebar with grouped article links + main content area showing
 * the active article. Articles are registered in `articles/index.tsx`.
 */
import { Link, NavLink, useParams, Navigate } from "react-router-dom";
import { ArrowLeft, BookOpen, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { helpArticles } from "./articles";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function HelpPage() {
  const { slug } = useParams<{ slug?: string }>();
  const [query, setQuery] = useState("");

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? helpArticles.filter(
          (a) =>
            a.title.toLowerCase().includes(q) ||
            a.description.toLowerCase().includes(q) ||
            a.category.toLowerCase().includes(q),
        )
      : helpArticles;
    const map = new Map<string, typeof helpArticles>();
    for (const a of filtered) {
      const arr = map.get(a.category) ?? [];
      arr.push(a);
      map.set(a.category, arr);
    }
    return Array.from(map.entries());
  }, [query]);

  // /help with no slug → landing page
  // /help/:slug → article (or 404 redirect to landing)
  const active = slug ? helpArticles.find((a) => a.slug === slug) : undefined;
  if (slug && !active) return <Navigate to="/help" replace />;

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar */}
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="container mx-auto flex h-14 items-center gap-4 px-4">
          <Button asChild variant="ghost" size="sm" className="gap-1.5">
            <Link to="/">
              <ArrowLeft className="h-4 w-4" /> Back to app
            </Link>
          </Button>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <BookOpen className="h-4 w-4 text-primary" />
            Help & Guides
          </div>
        </div>
      </header>

      <div className="container mx-auto grid grid-cols-1 md:grid-cols-[260px_1fr] gap-8 px-4 py-8">
        {/* Sidebar */}
        <aside className="space-y-4 md:sticky md:top-20 md:self-start">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search help…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8 h-9"
            />
          </div>

          <nav className="space-y-5">
            {grouped.length === 0 && (
              <p className="text-xs text-muted-foreground px-2">No articles match.</p>
            )}
            {grouped.map(([category, items]) => (
              <div key={category} className="space-y-1">
                <p className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {category}
                </p>
                <ul className="space-y-0.5">
                  {items.map((a) => (
                    <li key={a.slug}>
                      <NavLink
                        to={`/help/${a.slug}`}
                        className={({ isActive }) =>
                          cn(
                            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                            isActive
                              ? "bg-accent text-accent-foreground font-medium"
                              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                          )
                        }
                      >
                        <a.icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{a.title}</span>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        {/* Main content */}
        <main className="min-w-0">
          {active ? (
            <active.Component />
          ) : (
            <HelpLanding />
          )}
        </main>
      </div>
    </div>
  );
}

function HelpLanding() {
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Help & Guides</h1>
        <p className="text-muted-foreground max-w-2xl">
          Learn how each feature works, with step-by-step walkthroughs and
          best-practice tips. Pick a topic from the sidebar or browse below.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        {helpArticles.map((a) => (
          <Link
            key={a.slug}
            to={`/help/${a.slug}`}
            className="group flex gap-3 rounded-lg border bg-card p-4 hover:border-primary/50 hover:bg-accent/30 transition-colors"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <a.icon className="h-5 w-5" />
            </div>
            <div className="space-y-0.5">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {a.category}
              </p>
              <p className="font-semibold group-hover:text-primary transition-colors">
                {a.title}
              </p>
              <p className="text-sm text-muted-foreground">{a.description}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
