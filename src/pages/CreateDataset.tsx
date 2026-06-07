import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useToast } from '@/hooks/use-toast';
import { DatasetFormValues } from '@/types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Navbar } from '@/components/Navbar';
import { useApi } from '@/hooks/use-api';
import { DatasetForm } from '@/components/DatasetForm';

interface CreateDatasetProps {
  projectMode?: boolean;
}

const CreateDataset = ({ projectMode = false }: CreateDatasetProps) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { api, isConfigured } = useApi();
  
  // Get projectId from location state
  const projectId = location.state?.projectId;
  
  // Debug logging
  console.log("Create Dataset - Location state:", location.state);
  console.log("Create Dataset - Project ID:", projectId);
  console.log("Create Dataset - Project mode:", projectMode);

  const handleSubmit = async (data: DatasetFormValues, logoFile?: File) => {
    if (!projectMode && !projectId) {
      toast({
        title: "Error",
        description: "No project selected. Please create a dataset from within a project.",
        variant: "destructive",
      });
      return;
    }

    if (!api || !isConfigured) {
      toast({
        title: "Error",
        description: "API client is not configured",
        variant: "destructive",
      });
      return;
    }

    try {
      const formData = new FormData();
      formData.append('name', data.name.trim());
      formData.append('description', data.description?.trim() || "");
      formData.append('type', data.type);
      formData.append('project_id', String(projectId));
      
      if (data.tags && data.tags.length > 0) {
        formData.append('tags', JSON.stringify(data.tags));
      }

      if (logoFile) {
        formData.append('logo', logoFile);
      }

      const response = await api.createDataset(formData);

      if (!response.success) {
        throw new Error(response.error || 'Failed to create dataset');
      }

      toast({
        title: "Success",
        description: `${data.name} has been created successfully.`,
      });

      // Navigate based on the mode
      navigate(`/projects/${projectId}/datasets`);
    } catch (err) {
      console.error('Error creating:', err);
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "Failed to create. Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="min-h-screen pb-16">
      <Navbar />
      
      <div className="container max-w-3xl pt-32 pb-12 px-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">
              {projectMode ? "Create New Project" : "Create New Dataset"}
            </CardTitle>
            <CardDescription>
              {projectMode 
                ? "Create a new project to organize related datasets" 
                : "Create a new dataset to manage your data"
              }
            </CardDescription>
          </CardHeader>
          
          <CardContent>
            <DatasetForm
              onSubmit={handleSubmit}
              mode="create"
              projectMode={projectMode}
              projectId={projectId}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default CreateDataset;
