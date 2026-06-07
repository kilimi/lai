import { useEffect, useState } from "react";
import { APP_VERSION } from "@/appVersion";
import { useApi } from "@/hooks/use-api";

export function AppVersionFooter() {
  const { api } = useApi();
  const [version, setVersion] = useState(APP_VERSION);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .getAppVersion()
      .then((res) => {
        const v = res.data?.version?.trim();
        if (!cancelled && v) setVersion(v);
      })
      .catch(() => {
        /* keep build-time fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <footer
      className="pointer-events-none fixed bottom-0 left-0 right-0 z-30 flex justify-center pb-1.5"
      aria-label="Application version"
    >
      <span className="rounded-full bg-background/70 px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground/70 backdrop-blur-sm">
        LAI v{version}
      </span>
    </footer>
  );
}
