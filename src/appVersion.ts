/** Baked at build time from package.json (see vite.config.ts). */
export const APP_VERSION: string =
  (import.meta.env.VITE_APP_VERSION as string | undefined)?.trim() || "dev";
