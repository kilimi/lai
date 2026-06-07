import { describe, it, expect } from "vitest";
import { PROJECT_LOGO_MAX_BYTES, validateProjectLogoFile } from "./project-logo-validation";

describe("validateProjectLogoFile", () => {
  it("accepts image types", () => {
    const file = new File(["x"], "logo.png", { type: "image/png" });
    expect(validateProjectLogoFile(file)).toEqual({ ok: true });
  });

  it("accepts tiff by extension", () => {
    const file = new File(["x"], "scan.tiff", { type: "application/octet-stream" });
    expect(validateProjectLogoFile(file)).toEqual({ ok: true });
  });

  it("rejects non-image files", () => {
    const file = new File(["x"], "doc.pdf", { type: "application/pdf" });
    const result = validateProjectLogoFile(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.description).toMatch(/image/i);
    }
  });

  it("rejects oversized files", () => {
    const big = new Uint8Array(PROJECT_LOGO_MAX_BYTES + 1);
    const file = new File([big], "huge.png", { type: "image/png" });
    const result = validateProjectLogoFile(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.description).toMatch(/25MB/i);
    }
  });
});
