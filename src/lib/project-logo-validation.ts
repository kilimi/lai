export const PROJECT_LOGO_MAX_BYTES = 25 * 1024 * 1024;

export type LogoValidationResult =
  | { ok: true }
  | { ok: false; title: string; description: string };

/** Validate project logo file type and size (shared by create + edit flows). */
export function validateProjectLogoFile(file: File): LogoValidationResult {
  const fileName = file.name.toLowerCase();
  const isImageType = file.type.startsWith("image/");
  const isTiffFile = fileName.endsWith(".tif") || fileName.endsWith(".tiff");

  if (!isImageType && !isTiffFile) {
    return {
      ok: false,
      title: "Error",
      description: "Please upload an image file",
    };
  }

  if (file.size > PROJECT_LOGO_MAX_BYTES) {
    return {
      ok: false,
      title: "Error",
      description: "Logo must be less than 25MB",
    };
  }

  return { ok: true };
}
