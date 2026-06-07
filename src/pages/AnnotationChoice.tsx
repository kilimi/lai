import { useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Navbar } from "@/components/Navbar";
import { ArrowLeft, Grid3X3, Layers } from "lucide-react";
import { useDatasetSettings } from "@/hooks/useDatasetSettings";
import { useApi } from "@/hooks/use-api";

export default function AnnotationChoice() {
  const { id, projectId } = useParams<{ id: string; projectId?: string }>();
  const navigate = useNavigate();
  const { api } = useApi();

  // Dataset settings
  const datasetId = id || '';
  const { settings, updateLayout } = useDatasetSettings(datasetId);

  // Redirect legacy /datasets/:id/annotate to /projects/:projectId/datasets/:id/annotate
  useEffect(() => {
    if (!id || projectId || !api) return;
    let cancelled = false;
    api.getDataset(id).then((res) => {
      if (cancelled || !res.success || !res.data?.project_id) return;
      navigate(`/projects/${res.data.project_id}/datasets/${id}/annotate`, { replace: true });
    });
    return () => { cancelled = true; };
  }, [id, projectId, api, navigate]);

  // Handle back to dataset navigation
  const handleBackToDataset = () => {
    // Ensure the dataset view shows both Images and Annotations
    // If current layout is 'images-only' or 'annotations-only', change to horizontal
    if (settings.layout === 'images-only' || settings.layout === 'annotations-only') {
      updateLayout('horizontal');
    }
    // Navigate to dataset page with proper URL format
    const datasetUrl = projectId ? `/projects/${projectId}/datasets/${id}` : `/datasets/${id}`;
    navigate(datasetUrl);
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 flex flex-col pt-16">
        <div className="px-6 py-4 border-b bg-background">
          <div className="flex items-center gap-4">
            <Button variant="ghost" onClick={handleBackToDataset}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Dataset
            </Button>
            <div>
              <h1 className="text-2xl font-semibold">Choose Annotation Type</h1>
              <p className="text-muted-foreground">Select how you would like to annotate your dataset</p>
            </div>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center p-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl w-full">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer">
              <CardHeader className="text-center">
                <div className="mx-auto w-16 h-16 bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center mb-4">
                  <Grid3X3 className="h-8 w-8 text-blue-600 dark:text-blue-400" />
                </div>
                <CardTitle>Classification</CardTitle>
                <CardDescription>
                  Assign single or multiple class labels to entire images
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="text-sm text-muted-foreground space-y-2 mb-6">
                  <li>• Assign classes to images</li>
                  <li>• Bulk operations on image pages</li>
                  <li>• Individual image classification</li>
                  <li>• Class management tools</li>
                </ul>
                <Button asChild className="w-full">
                  <Link to={projectId ? `/projects/${projectId}/datasets/${id}/annotate/classification` : `/datasets/${id}/annotate/classification`}>
                    Start Classification
                  </Link>
                </Button>
              </CardContent>
            </Card>

            <Card className="hover:shadow-lg transition-shadow cursor-pointer">
              <CardHeader className="text-center">
                <div className="mx-auto w-16 h-16 bg-green-100 dark:bg-green-900 rounded-full flex items-center justify-center mb-4">
                  <Layers className="h-8 w-8 text-green-600 dark:text-green-400" />
                </div>
                <CardTitle>Segmentation</CardTitle>
                <CardDescription>
                  Create detailed pixel-level annotations and object boundaries
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="text-sm text-muted-foreground space-y-2 mb-6">
                  <li>• Pixel-level annotations</li>
                  <li>• Object boundary detection</li>
                  <li>• Polygon drawing tools</li>
                  <li>• Advanced annotation features</li>
                </ul>
                <Button asChild variant="secondary" className="w-full">
                  <Link
                    to={
                      projectId
                        ? `/projects/${projectId}/datasets/${id}/annotate/segmentation`
                        : `/datasets/${id}/annotate/segmentation`
                    }
                  >
                    Start Segmentation
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}