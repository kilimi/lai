import { Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppVersionFooter } from "@/components/AppVersionFooter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ExportProvider } from "@/contexts/ExportContext";
import { ApiProvider } from "@/contexts/ApiContext";
import { ThemeProvider } from "@/components/ThemeProvider";
import { lazyWithReloadRetry } from "@/lib/lazyWithReloadRetry";

const Index = lazyWithReloadRetry(() => import("./pages/Index"), "Index");
const CreateProject = lazyWithReloadRetry(() => import("./pages/CreateProject"), "CreateProject");
const CreateDataset = lazyWithReloadRetry(() => import("./pages/CreateDataset"), "CreateDataset");
const ProjectLayout = lazyWithReloadRetry(() =>
  import("./components/ProjectLayout").then((m) => ({ default: m.ProjectLayout })),
  "ProjectLayout",
);
const ProjectDatasets = lazyWithReloadRetry(() => import("./pages/ProjectDatasets"), "ProjectDatasets");
const ProjectModels = lazyWithReloadRetry(() => import("./pages/ProjectModels"), "ProjectModels");
const ProjectEvaluations = lazyWithReloadRetry(() => import("./pages/ProjectEvaluations"), "ProjectEvaluations");
const ProjectExports = lazyWithReloadRetry(() => import("./pages/ProjectExports"), "ProjectExports");
const EditDataset = lazyWithReloadRetry(() => import("./pages/EditDataset"), "EditDataset");
const Dataset = lazyWithReloadRetry(() => import("@/pages/Dataset"), "Dataset");
const ImageAnnotation = lazyWithReloadRetry(() => import("./pages/ImageAnnotation"), "ImageAnnotation");
const AnnotationChoice = lazyWithReloadRetry(() => import("./pages/AnnotationChoice"), "AnnotationChoice");
const Classification = lazyWithReloadRetry(() => import("./pages/Classification"), "Classification");
const ApiSettings = lazyWithReloadRetry(() =>
  import("./pages/ApiSettings").then((m) => ({ default: m.ApiSettings })),
  "ApiSettings",
);
const NotFound = lazyWithReloadRetry(() => import("./pages/NotFound"), "NotFound");
import { RedirectToTutorials } from "@/components/RedirectToTutorials";
const Performance = lazyWithReloadRetry(() => import('./pages/Performance'), "Performance");
const SystemModels = lazyWithReloadRetry(() => import('./pages/SystemModels'), "SystemModels");
function RouteFallback() {
  return (
    <div
      className="min-h-screen flex items-center justify-center bg-background"
      role="status"
      aria-label="Loading page"
    >
      <div className="h-9 w-9 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Keep data fresh for 30 s so navigating back to a page doesn't refetch
      // immediately — reduces redundant network round-trips.
      staleTime: 30_000,
      // Hold unused cache entries for 5 minutes
      gcTime: 5 * 60_000,
      retry: 1,
    },
  },
});

const App = () => (
  <ThemeProvider>
    <ApiProvider>
      <QueryClientProvider client={queryClient}>
        <ExportProvider>
          <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter
            future={{
              v7_startTransition: true,
              v7_relativeSplatPath: true,
            }}
          >
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/projects/new" element={<CreateProject />} />
                <Route path="/projects/new/dataset" element={<CreateDataset />} />

                <Route path="/projects/:id" element={<ProjectLayout />}>
                  <Route index element={<ProjectDatasets />} />
                  <Route path="datasets" element={<ProjectDatasets />} />
                  <Route path="models" element={<ProjectModels />} />
                  <Route path="pipelines" element={<Navigate to=".." replace />} />
                  <Route path="evaluations" element={<ProjectEvaluations />} />
                  <Route path="exports" element={<ProjectExports />} />
                </Route>

                <Route path="/projects/:id/edit" element={<EditDataset projectMode={true} />} />
                <Route path="/projects/:projectId/datasets/:id" element={<Dataset />} />
                <Route path="/projects/:projectId/datasets/:id/edit" element={<EditDataset />} />
                <Route path="/projects/:projectId/datasets/:id/annotate" element={<AnnotationChoice />} />
                <Route
                  path="/projects/:projectId/datasets/:id/annotate/classification"
                  element={<Classification />}
                />
                <Route
                  path="/projects/:projectId/datasets/:id/annotate/segmentation"
                  element={<ImageAnnotation />}
                />
                <Route path="/datasets/:id" element={<Dataset />} />
                <Route path="/datasets/:id/edit" element={<EditDataset />} />
                <Route path="/datasets/:id/annotate" element={<AnnotationChoice />} />
                <Route path="/datasets/:id/annotate/classification" element={<Classification />} />
                <Route path="/datasets/:id/annotate/segmentation" element={<ImageAnnotation />} />
                <Route path="/settings" element={<ApiSettings />} />
                <Route path="/help" element={<RedirectToTutorials />} />
                <Route path="/help/:slug" element={<RedirectToTutorials />} />
                <Route path="/performance" element={<Performance />} />
                <Route path="/system/models" element={<SystemModels />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
          <AppVersionFooter />
        </TooltipProvider>
      </ExportProvider>
    </QueryClientProvider>
  </ApiProvider>
</ThemeProvider>
);

export default App;
