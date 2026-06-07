/**
 * Help article registry.
 *
 * To add a new article:
 *   1. Create a component under `src/pages/help/articles/`.
 *   2. Append an entry to `helpArticles` below.
 *   3. It will automatically appear in the sidebar and be routable at
 *      `/help/<slug>`.
 */
import { LucideIcon, BookOpen, Images, Files, HardDrive } from "lucide-react";
import { DatasetViewArticle } from "./DatasetViewArticle";
import { AnnotationFilesArticle } from "./AnnotationFilesArticle";
import { FoundationModelsArticle } from "./FoundationModelsArticle";

export interface HelpArticle {
  slug: string;
  title: string;
  description: string;
  category: string;
  icon: LucideIcon;
  Component: React.ComponentType;
}

export const helpArticles: HelpArticle[] = [
  {
    slug: "dataset-view",
    title: "Dataset View",
    description: "Browse images, manage collections, run auto-annotate and dataset actions.",
    category: "Datasets",
    icon: Images,
    Component: DatasetViewArticle,
  },
  {
    slug: "annotation-files",
    title: "Annotation Files",
    description: "Files vs. instances vs. classes, formats, and the coverage matrix for multi-collection datasets.",
    category: "Datasets",
    icon: Files,
    Component: AnnotationFilesArticle,
  },
  {
    slug: "foundation-models",
    title: "Foundation Models",
    description: "Where YOLO and Depth-Anything weights live, how to pre-download them, and how to add custom .pt files.",
    category: "System",
    icon: HardDrive,
    Component: FoundationModelsArticle,
  },
  // Add more articles here — they will show up in the sidebar automatically.
];

export const placeholderIcon = BookOpen;
