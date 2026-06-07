import React, { useState, useEffect } from 'react';
import { useParams, Link, useOutletContext } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useApi } from '@/hooks/use-api';
import { useToast } from '@/hooks/use-toast';
import { useTasks } from '@/hooks/use-tasks';
import { getApiBaseUrl } from '@/config/api';
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { DatasetCard, DatasetCardSkeleton } from '@/components/DatasetCard';
import { DatasetGroupCard } from '@/components/DatasetGroupCard';
import { AddGroupModal } from '@/components/AddGroupModal';
import { EditGroupModal } from '@/components/EditGroupModal';
import { CreateAugmentedDatasetModal } from '@/components/CreateAugmentedDatasetModal';
import { MergeDatasetsModal } from '@/components/MergeDatasetsModal';
import { FolderPlus, Search, SlidersHorizontal, Database, Tag, ChevronDown, Users, GitMerge, Image as ImageIcon, Brain, Pencil, Rocket, BookOpen, ArrowRight, CheckCircle2, Activity } from "lucide-react";
import { LAI_TUTORIALS_URL } from "@/constants/externalLinks";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Dataset, Project, DatasetGroup } from '@/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface OutletContext {
  project: Project | null;
  loading: boolean;
  refreshProject?: () => void;
}

export default function ProjectDatasets() {
  const { id } = useParams<{ id: string }>();
  const { project, refreshProject } = useOutletContext<OutletContext>();
  const { api } = useApi();
  const { toast } = useToast();
  const { tasks } = useTasks(id ? parseInt(id) : undefined);
  
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest" | "name" | "images" | "annotations">("newest");
  const [showAugmentedModal, setShowAugmentedModal] = useState(false);
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [datasetGroups, setDatasetGroups] = useState<DatasetGroup[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const [showAddGroupModal, setShowAddGroupModal] = useState(false);
  const [showEditGroupModal, setShowEditGroupModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<DatasetGroup | null>(null);
  
  // Delete confirmation state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [datasetToDelete, setDatasetToDelete] = useState<Dataset | null>(null);
  const [augmentedDatasets, setAugmentedDatasets] = useState<{ id: number; name: string }[]>([]);
  const [deleteAugmented, setDeleteAugmented] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [showDeleteGroupConfirm, setShowDeleteGroupConfirm] = useState(false);
  const [groupToDelete, setGroupToDelete] = useState<DatasetGroup | null>(null);
  const [isDeletingGroup, setIsDeletingGroup] = useState(false);

  // Fetch datasets for the project
  const fetchProjectDatasets = async () => {
    if (!id) return;
    
    setIsLoading(true);
    try {
      const response = await fetch(
        // Omit data: URLs from list JSON — server returns ?thumb=300 file previews instead (faster, smaller).
        `${getApiBaseUrl()}/projects/${id}/datasets/list?include_thumbnails=false`,
        { credentials: 'omit' },
      );
      if (response.ok) {
        const result = await response.json();
        if (result.success && result.data) {
          setDatasets(result.data);
        }
      }
    } catch (error) {
      console.error('Error fetching project datasets:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch dataset groups for the project
  const fetchDatasetGroups = async () => {
    if (!id) return;
    
    try {
      const response = await fetch(`${getApiBaseUrl()}/projects/${id}/dataset-groups/`, { credentials: 'omit' });
      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          setDatasetGroups(result.data);
        }
      }
    } catch (error) {
      console.error('Error fetching dataset groups:', error);
    }
  };

  useEffect(() => {
    fetchProjectDatasets();
    fetchDatasetGroups();
  }, [id]);

  // Refresh datasets when augmentation tasks complete
  useEffect(() => {
    const completedAugmentations = tasks.filter(
      task => task.task_type === 'augmentation' && task.status === 'completed'
    );
    
    if (completedAugmentations.length > 0) {
      // Refresh datasets to show updated logos/thumbnails
      fetchProjectDatasets();
    }
  }, [tasks.map(t => `${t.id}-${t.status}`).join(',')]);

  // Get all unique tags from datasets
  const allTags = React.useMemo(() => {
    const tagSet = new Set<string>();
    datasets.forEach(dataset => {
      if (dataset.tags) {
        dataset.tags.forEach(tag => tagSet.add(tag));
      }
    });
    return Array.from(tagSet).sort();
  }, [datasets]);

  // Get datasets that are not in any group
  const getUngroupedDatasets = () => {
    const groupedDatasetIds = new Set<number>();
    datasetGroups.forEach(group => {
      group.datasets.forEach(dataset => {
        groupedDatasetIds.add(dataset.id);
      });
    });
    return datasets.filter(dataset => !groupedDatasetIds.has(dataset.id));
  };

  const filteredAndSortedDatasets = () => {
    let result = getUngroupedDatasets();
    
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        dataset => 
          dataset.name.toLowerCase().includes(query) || 
          dataset.description?.toLowerCase().includes(query) ||
          (dataset.tags && dataset.tags.some(tag => tag.toLowerCase().includes(query)))
      );
    }
    
    if (selectedTag) {
      result = result.filter(
        dataset => dataset.tags && dataset.tags.includes(selectedTag)
      );
    }
    
    switch (sortOrder) {
      case "newest":
        return result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      case "oldest":
        return result.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      case "name":
        return result.sort((a, b) => a.name.localeCompare(b.name));
      case "images":
        return result.sort((a, b) => (b.image_count || 0) - (a.image_count || 0));
      case "annotations":
        return result.sort((a, b) => (b.annotation_count || 0) - (a.annotation_count || 0));
      default:
        return result;
    }
  };

  // Filter and sort dataset groups
  const filteredAndSortedGroups = () => {
    let result = [...datasetGroups];
    
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(group => {
        if (group.name.toLowerCase().includes(query) || 
            (group.description && group.description.toLowerCase().includes(query))) {
          return true;
        }
        return group.datasets.some(dataset =>
          dataset.name.toLowerCase().includes(query) || 
          (dataset.description && dataset.description.toLowerCase().includes(query)) ||
          (dataset.tags && dataset.tags.some(tag => tag.toLowerCase().includes(query)))
        );
      });
    }
    
    if (selectedTag) {
      result = result.filter(group =>
        group.datasets.some(dataset => 
          dataset.tags && dataset.tags.includes(selectedTag)
        )
      );
    }
    
    return result;
  };

  const handleToggleGroupExpanded = (groupId: number) => {
    const newSet = new Set(expandedGroups);
    if (newSet.has(groupId)) {
      newSet.delete(groupId);
    } else {
      newSet.add(groupId);
    }
    setExpandedGroups(newSet);
  };

  const handleDeleteDataset = async (dataset: Dataset) => {
    // First check if there are augmented datasets
    try {
      const response = await fetch(`${getApiBaseUrl()}/datasets/${dataset.id}/augmented-datasets`, { credentials: 'omit' });
      if (response.ok) {
        const result = await response.json();
        setAugmentedDatasets(result.augmented_datasets || []);
      } else {
        setAugmentedDatasets([]);
      }
    } catch (error) {
      setAugmentedDatasets([]);
    }
    
    setDatasetToDelete(dataset);
    setDeleteAugmented(false);
    setShowDeleteConfirm(true);
  };
  
  const confirmDeleteDataset = async () => {
    if (!datasetToDelete) return;
    
    setIsDeleting(true);
    try {
      const url = new URL(`${getApiBaseUrl()}/datasets/${datasetToDelete.id}`);
      if (deleteAugmented) {
        url.searchParams.set('delete_augmented', 'true');
      }
      
      const response = await fetch(url.toString(), {
        method: 'DELETE'
      });
      
      if (response.ok) {
        const result = await response.json();
        toast({
          title: "Dataset Deleted",
          description: result.deleted_count > 1 
            ? `Successfully deleted ${result.deleted_count} datasets.`
            : "The dataset has been deleted successfully."
        });
        void fetchProjectDatasets();
        void fetchDatasetGroups();
        refreshProject?.();
      } else {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to delete dataset');
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete dataset",
        variant: "destructive"
      });
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
      setDatasetToDelete(null);
      setAugmentedDatasets([]);
    }
  };

  const handleDatasetUpdated = (updatedDataset?: Dataset) => {
    // If we have the updated dataset, update it in the local state immediately
    // This provides instant feedback while the full refresh happens
    if (updatedDataset) {
      setDatasets(prevDatasets => 
        prevDatasets.map(d => d.id === updatedDataset.id ? updatedDataset : d)
      );
    }
    // Also refresh the full list to ensure consistency
    fetchProjectDatasets();
  };

  const handleDatasetMoved = (datasetId: number, _targetProjectId: number) => {
    // Remove from current project list immediately, then refresh groups/lists.
    setDatasets((prev) => prev.filter((d) => d.id !== datasetId));
    fetchProjectDatasets();
    fetchDatasetGroups();
  };

  const handleGroupCreated = () => {
    fetchDatasetGroups();
    setShowAddGroupModal(false);
  };

  const handleGroupUpdated = () => {
    fetchDatasetGroups();
    setShowEditGroupModal(false);
    setEditingGroup(null);
  };

  const handleEditGroup = (group: DatasetGroup) => {
    setEditingGroup(group);
    setShowEditGroupModal(true);
  };

  const handleDeleteGroup = (group: DatasetGroup) => {
    setGroupToDelete(group);
    setShowDeleteGroupConfirm(true);
  };

  const confirmDeleteDatasetGroup = async () => {
    if (!groupToDelete || !id) return;
    setIsDeletingGroup(true);
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/projects/${id}/dataset-groups/${groupToDelete.id}`,
        { credentials: 'omit', method: 'DELETE' },
      );
      if (response.ok) {
        toast({
          title: "Group deleted",
          description: `"${groupToDelete.name}" has been removed. Member datasets were not deleted.`,
        });
        setShowDeleteGroupConfirm(false);
        setGroupToDelete(null);
        fetchDatasetGroups();
      } else {
        let detail = 'Failed to delete group';
        try {
          const body = await response.json();
          if (body.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
        } catch {
          //
        }
        toast({ title: 'Error', description: detail, variant: 'destructive' });
      }
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to delete group',
        variant: 'destructive',
      });
    } finally {
      setIsDeletingGroup(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Database className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">Datasets</h1>
          <Badge variant="secondary" className="ml-2">
            {datasets.length + datasetGroups.length} items
          </Badge>
          {datasetGroups.length > 0 && (
            <Badge variant="outline" className="ml-1">
              <Users className="h-3 w-3 mr-1" />
              {datasetGroups.length} groups
            </Badge>
          )}
        </div>

        {/* Project health stats strip (1:N aware) */}
        {datasets.length > 0 && (() => {
          const totalImages = datasets.reduce((s, d) => s + (d.image_count || 0), 0);
          const totalSets = datasets.reduce((s, d) => s + (d.annotation_file_count || 0), 0);
          const datasetsWithSets = datasets.filter(d => (d.annotation_file_count || 0) > 0).length;
          return (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <ImageIcon className="h-4 w-4" />
                {totalImages.toLocaleString()} images
              </span>
              <span aria-hidden="true">·</span>
              <span className="flex items-center gap-1.5">
                <Pencil className="h-4 w-4" />
                {totalSets} annotation set{totalSets === 1 ? "" : "s"} across {datasetsWithSets} dataset{datasetsWithSets === 1 ? "" : "s"}
              </span>
              <span aria-hidden="true">·</span>
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" />
                {datasets.length} total dataset{datasets.length === 1 ? "" : "s"}
              </span>
            </div>
          );
        })()}
      </div>
      
      {/* Search and Filter Controls */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
          <Input
            placeholder="Search datasets by name, description or tags..."
            className="pl-9"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="text-muted-foreground h-4 w-4" />
          <Select value={sortOrder} onValueChange={(value) => setSortOrder(value as any)}>
            <SelectTrigger className="min-w-[180px]">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
              <SelectItem value="name">Name (A-Z)</SelectItem>
              <SelectItem value="images">Most images</SelectItem>
              <SelectItem value="annotations">Most annotations</SelectItem>
            </SelectContent>
          </Select>
          
          <Button 
            variant="outline" 
            size="sm" 
            className="whitespace-nowrap ml-2"
            onClick={() => setShowMergeModal(true)}
            disabled={datasets.length < 2}
            title={datasets.length < 2 ? "Need at least 2 datasets to merge" : "Merge datasets"}
          >
            <GitMerge className="w-4 h-4 mr-2" />
            Merge
          </Button>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button 
                variant="default" 
                size="sm" 
                className="whitespace-nowrap ml-2"
              >
                <FolderPlus className="w-4 h-4 mr-2" />
                Create
                <ChevronDown className="w-4 h-4 ml-2" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem 
                onClick={() => setShowAddGroupModal(true)}
                className="flex items-center cursor-pointer"
              >
                <Users className="w-4 h-4 mr-2 text-blue-600" />
                <span className="text-blue-600">Dataset Group</span>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link 
                  to="/projects/new/dataset" 
                  state={{ projectId: id ? parseInt(id, 10) : undefined }}
                  className="flex items-center cursor-pointer"
                >
                  <FolderPlus className="w-4 h-4 mr-2" />
                  Dataset
                </Link>
              </DropdownMenuItem>
              {datasets.length > 0 && (
                <DropdownMenuItem asChild>
                  <div
                    onClick={() => setShowAugmentedModal(true)}
                    className="flex items-center cursor-pointer"
                  >
                    <FolderPlus className="w-4 h-4 mr-2 text-yellow-600" />
                    <span className="text-yellow-600">Augmented Dataset</span>
                  </div>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      
      {/* Tag Filter */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant={selectedTag === null ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedTag(null)}
            className="gap-1"
          >
            All Tags
          </Button>
          {allTags.map(tag => (
            <Button
              key={tag}
              variant={selectedTag === tag ? "default" : "outline"}
              size="sm"
              onClick={() => setSelectedTag(tag)}
              className="gap-1"
            >
              <Tag className="w-3 h-3" />
              {tag}
            </Button>
          ))}
        </div>
      )}
      
      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {Array(3).fill(0).map((_, i) => (
            <DatasetCardSkeleton key={i} />
          ))}
        </div>
      ) : filteredAndSortedGroups().length > 0 || filteredAndSortedDatasets().length > 0 ? (
        <div className="space-y-6">
          {/* Dataset Groups */}
          {filteredAndSortedGroups().length > 0 && (
            <div>
              <h4 className="text-lg font-medium mb-4 flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                Dataset Groups
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredAndSortedGroups().map(group => (
                  <DatasetGroupCard 
                    key={group.id} 
                    group={group}
                    expanded={expandedGroups.has(group.id)}
                    onToggleExpanded={() => handleToggleGroupExpanded(group.id)}
                    onEdit={handleEditGroup}
                    onDelete={handleDeleteGroup}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Individual Datasets */}
          {filteredAndSortedDatasets().length > 0 && (
            <div>
              {datasetGroups.length > 0 && (
                <h4 className="text-lg font-medium mb-4 flex items-center gap-2">
                  <Database className="h-5 w-5 text-primary" />
                  Individual Datasets
                </h4>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredAndSortedDatasets().map(dataset => (
                  <DatasetCard
                    key={dataset.id}
                    dataset={dataset}
                    onDelete={handleDeleteDataset}
                    onDatasetUpdated={handleDatasetUpdated}
                    onDatasetMoved={handleDatasetMoved}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (searchQuery || selectedTag) ? (
        <div className="text-center py-16">
          <Search className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <h3 className="text-lg font-medium mb-2">No datasets match your search</h3>
          <p className="text-muted-foreground mb-6">
            Try adjusting your search or clearing the tag filter.
          </p>
          <Button variant="outline" onClick={() => { setSearchQuery(""); setSelectedTag(null); }}>
            Clear filters
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Welcome Hero */}
          <Card className="p-10 text-center relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 pointer-events-none" />
            <div className="relative">
              <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-primary/10 flex items-center justify-center">
                <Rocket className="w-8 h-8 text-primary" />
              </div>
              <h3 className="text-2xl font-semibold mb-2">Let's build your first dataset</h3>
              <p className="text-muted-foreground max-w-lg mx-auto mb-6">
                A dataset is a collection of images and labels. Add your data, annotate it, then train a model — all in one place.
              </p>
              <div className="flex gap-3 justify-center flex-wrap">
                <Button asChild size="lg">
                  <Link
                    to="/projects/new/dataset"
                    state={{ projectId: id ? parseInt(id, 10) : undefined }}
                    className="gap-2"
                  >
                    <FolderPlus className="w-4 h-4" />
                    Create dataset
                  </Link>
                </Button>
                <Button asChild variant="outline" size="lg">
                  <a
                    href={LAI_TUTORIALS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="gap-2 inline-flex items-center"
                  >
                    <BookOpen className="w-4 h-4" />
                    Watch tutorials
                  </a>
                </Button>
              </div>
            </div>
          </Card>

          {/* 3-step path */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              {
                icon: ImageIcon,
                step: "Step 1",
                title: "Add images",
                desc: "Upload images, a video, or import an existing dataset (COCO, YOLO).",
                cta: "Create dataset",
                to: `/projects/new/dataset`,
                primary: true,
              },
              {
                icon: Pencil,
                step: "Step 2",
                title: "Annotate or auto-annotate",
                desc: "Draw bounding boxes / polygons, or run a foundation model to pre-label.",
                cta: "Watch tutorials",
                href: LAI_TUTORIALS_URL,
                external: true,
              },
              {
                icon: Brain,
                step: "Step 3",
                title: "Train & evaluate",
                desc: "Train YOLO, Mask-RCNN, or RT-DETR and compare evaluation metrics.",
                cta: "Watch tutorials",
                href: LAI_TUTORIALS_URL,
                external: true,
              },
            ].map(({ icon: Icon, step, title, desc, cta, to, href, external, primary }) => {
              const cardBody = (
                <>
                  <div className="flex items-start gap-3 mb-3">
                    <div
                      className={cn(
                        "h-10 w-10 rounded-lg flex items-center justify-center flex-shrink-0",
                        primary ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                      )}
                    >
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-muted-foreground mb-0.5">{step}</div>
                      <h4 className="font-semibold text-foreground leading-tight">{title}</h4>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground mb-4">{desc}</p>
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-primary group-hover:gap-2 transition-all">
                    {cta}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                </>
              );
              const cardClass =
                "group glass-card rounded-xl p-5 border border-border/50 hover:border-primary/40 transition-all hover:-translate-y-0.5";
              if (external) {
                return (
                  <a
                    key={title}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${cardClass} block`}
                  >
                    {cardBody}
                  </a>
                );
              }
              return (
                <Link
                  key={title}
                  to={to!}
                  state={primary ? { projectId: id ? parseInt(id, 10) : undefined } : undefined}
                  className={cardClass}
                >
                  {cardBody}
                </Link>
              );
            })}
          </div>
        </div>
      )}
      
      {/* Modals */}
      <CreateAugmentedDatasetModal
        open={showAugmentedModal}
        onOpenChange={setShowAugmentedModal}
        projectId={id || ''}
        datasets={datasets}
        datasetGroups={datasetGroups}
      />
      
      <MergeDatasetsModal
        open={showMergeModal}
        onOpenChange={setShowMergeModal}
        projectId={id || ''}
        datasets={datasets}
        onMergeComplete={() => {
          fetchProjectDatasets();
        }}
      />
      
      <AddGroupModal
        open={showAddGroupModal}
        onOpenChange={setShowAddGroupModal}
        projectId={id || ''}
        datasets={datasets}
        datasetGroups={datasetGroups}
        onGroupCreated={handleGroupCreated}
      />
      
      <EditGroupModal
        open={showEditGroupModal}
        onOpenChange={setShowEditGroupModal}
        group={editingGroup}
        availableDatasets={datasets}
        datasetGroups={datasetGroups}
        onGroupUpdated={handleGroupUpdated}
      />
      
      {/* Delete dataset group confirm */}
      <ConfirmDeleteDialog
        open={showDeleteGroupConfirm}
        onOpenChange={(open) => {
          setShowDeleteGroupConfirm(open);
          if (!open) setGroupToDelete(null);
        }}
        title="Delete dataset group?"
        entity="dataset group"
        itemName={groupToDelete?.name ?? null}
        consequences={[
          "The group record (and optional group folders on disk) is removed.",
          "Datasets listed in this group remain in the project.",
        ]}
        confirmLabel={isDeletingGroup ? 'Deleting…' : 'Delete group'}
        isLoading={isDeletingGroup}
        onConfirm={confirmDeleteDatasetGroup}
      />

      {/* Delete dataset confirm */}
      <ConfirmDeleteDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        entity="dataset"
        itemName={datasetToDelete?.name ?? null}
        consequences={["All images and annotations in this dataset will be permanently removed."]}
        confirmLabel={isDeleting ? 'Deleting...' : 'Delete dataset'}
        isLoading={isDeleting}
        onConfirm={confirmDeleteDataset}
        extraContent={
          augmentedDatasets.length > 0 ? (
            <div className="my-2 p-4 bg-muted rounded-lg">
              <p className="text-sm font-medium mb-2">
                This dataset has {augmentedDatasets.length} augmented dataset{augmentedDatasets.length > 1 ? 's' : ''}:
              </p>
              <ul className="text-sm text-muted-foreground mb-3 list-disc list-inside">
                {augmentedDatasets.slice(0, 5).map(ds => (
                  <li key={ds.id}>{ds.name}</li>
                ))}
                {augmentedDatasets.length > 5 && (
                  <li>...and {augmentedDatasets.length - 5} more</li>
                )}
              </ul>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="deleteAugmented"
                  checked={deleteAugmented}
                  onCheckedChange={(checked) => setDeleteAugmented(checked === true)}
                />
                <label
                  htmlFor="deleteAugmented"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Also delete augmented datasets
                </label>
              </div>
            </div>
          ) : null
        }
      />

    </div>
  );
}
