import { useEffect } from "react";
import { LAI_TUTORIALS_URL } from "@/constants/externalLinks";

/** Legacy /help routes → external tutorials (no in-app docs). */
export function RedirectToTutorials() {
  useEffect(() => {
    window.location.replace(LAI_TUTORIALS_URL);
  }, []);

  return (
    <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
      Opening tutorials…
    </div>
  );
}
