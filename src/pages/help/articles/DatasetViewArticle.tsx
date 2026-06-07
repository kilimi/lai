/**
 * Help article: Dataset View
 *
 * Explains the dataset page: layout, image grid, collections,
 * auto-annotate and dataset actions.
 */
import { Images, LayoutGrid, Bot, Search, Settings2, Lightbulb } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ArticleSection, ArticleStep } from "../components/ArticleParts";

export function DatasetViewArticle() {
  return (
    <article className="space-y-8 max-w-3xl">
      <header className="space-y-3">
        <Badge variant="secondary" className="gap-1.5">
          <Images className="h-3.5 w-3.5" /> Datasets
        </Badge>
        <h1 className="text-3xl font-bold tracking-tight">Dataset View</h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          The dataset page is your hub for browsing images, organising them
          into collections, running auto-annotation and launching annotation
          sessions.
        </p>
      </header>

      <ArticleSection id="overview" title="What you can do here" icon={Lightbulb}>
        <ul className="list-disc pl-6 space-y-1 text-sm">
          <li>Browse and search the images in your dataset.</li>
          <li>Switch layouts (grid, split, single image) to suit your task.</li>
          <li>Group images into <strong>collections</strong> (e.g. RGB, Thermal).</li>
          <li>Run <strong>Auto-Annotate</strong> with YOLO11 Medium (ONNX) or Depth Anything V2.</li>
          <li>Calibrate two collections so annotations transfer between them.</li>
          <li>Edit, duplicate or delete the dataset from the Actions menu.</li>
        </ul>
      </ArticleSection>

      <ArticleSection id="grid" title="Image grid" icon={LayoutGrid}>
        <ArticleStep n={1} title="Adjust thumbnail size">
          Use the size slider in the bottom status bar to scale thumbnails
          between 150 and 300 pixels.
        </ArticleStep>
        <ArticleStep n={2} title="Filter by filename">
          Type in the search box to instantly filter visible images by name.
        </ArticleStep>
        <ArticleStep n={3} title="Open an image">
          Click any thumbnail to open it in the preview panel and inspect
          annotations.
        </ArticleStep>
      </ArticleSection>

      <ArticleSection id="collections" title="Collections" icon={Search}>
        <p>
          Collections let you group images by sensor or capture session. When a
          dataset has multiple collections of the same resolution, you can copy
          annotations between layers while annotating.
        </p>
      </ArticleSection>

      <ArticleSection id="auto-annotate" title="Auto-Annotate" icon={Bot}>
        <p>
          The <strong>Auto-Annotate</strong> button in the header runs a
          pre-trained model over your images. Choose <strong>YOLO11 Medium</strong>{" "}
          (detection, segmentation, or classification — ONNX) or{" "}
          <strong>Depth Anything V2</strong> for depth maps; results are written
          back as annotations or a new image collection you can review.
        </p>
      </ArticleSection>

      <ArticleSection id="actions" title="Dataset actions" icon={Settings2}>
        <p>
          The <strong>···</strong> menu in the header groups secondary
          dataset actions:
        </p>
        <ul className="list-disc pl-6 space-y-1 text-sm">
          <li><strong>Edit</strong> — change name, description or settings.</li>
          <li><strong>Duplicate</strong> — clone the dataset including images.</li>
          <li><strong>Delete</strong> — permanently remove the dataset.</li>
        </ul>
      </ArticleSection>
    </article>
  );
}
