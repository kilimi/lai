import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Grid3X3, Layers } from "lucide-react";

interface AnnotationChoiceModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  datasetId: string;
  projectId?: string;
  collectionId?: string; // Optional collection ID to restrict navigation
}

export function AnnotationChoiceModal({ isOpen, onOpenChange, datasetId, projectId, collectionId }: AnnotationChoiceModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Choose Annotation Type</DialogTitle>
          <p className="text-muted-foreground">Select how you would like to annotate your dataset</p>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 py-6">
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
              <Button 
                asChild 
                className="w-full"
                onClick={() => onOpenChange(false)}
              >
                <Link to={
                  projectId 
                    ? `/projects/${projectId}/datasets/${datasetId}/annotate/classification${collectionId ? `?collectionId=${collectionId}` : ''}` 
                    : `/datasets/${datasetId}/annotate/classification${collectionId ? `?collectionId=${collectionId}` : ''}`
                }>
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
              <Button 
                asChild 
                variant="secondary" 
                className="w-full"
                onClick={() => onOpenChange(false)}
              >
                <Link to={
                  projectId 
                    ? `/projects/${projectId}/datasets/${datasetId}/annotate/segmentation${collectionId ? `?collectionId=${collectionId}` : ''}` 
                    : `/datasets/${datasetId}/annotate/segmentation${collectionId ? `?collectionId=${collectionId}` : ''}`
                }>
                  Start Segmentation
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </DialogContent>
    </Dialog>
  );
}