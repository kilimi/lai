export interface Dataset {
  id: number;
  name: string;
  description: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  image_count: number;
  annotation_count: number;
  annotation_file_count: number;
  annotation_files?: Array<{
    id: string;
    file_name: string;
    name: string;
    annotation_count: number;
    created_at: string;
    type?: string | null;
  }>;
  project_id: number;
  thumbnailUrl?: string;
  logo_url?: string;
  url?: string;
}

export interface DatasetGroup {
  id: number;
  name: string;
  description: string;
  project_id: number;
  dataset_ids: number[];
  dataset_count: number;
  datasets: Dataset[];
  created_at: string;
  updated_at: string;
  url?: string;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  is_project: boolean;
  datasets: Dataset[];
  dataset_groups?: DatasetGroup[];
  thumbnailUrl?: string; // Adding this property as optional
  logo_url?: string;
  tags?: string[];
}

export interface Image {
  id: string;
  datasetId: string;
  fileName: string;
  fileSize: number;
  width: number;
  height: number;
  url: string;
  thumbnailUrl: string;
  uploadedAt: string;
  annotationsCount: number;
  groupId?: string; // Groups corresponding images across collections (same base filename = same groupId)
  annotations?: Annotation[]; // Optional: array of polygon or bbox annotations for this image
}

export interface ImageCollection {
  id: string;
  name: string;
  /** Total images in this layer (from API); can exceed loaded `images.length` when paginated. */
  totalImageCount?: number;
  /** When true, backend default collection (e.g. RGB Images). */
  is_default?: boolean;
  /** Left-to-right layer order persisted in backend. */
  position?: number;
  images: Image[];
  currentPage: number;
  totalPages: number;
  paginatedImages: Image[];
  imageIds?: string[]; // For persistence: track which images belong to this collection
}

export interface Annotation {
  id: string;
  imageId: string;
  datasetId: string;
  category: string;
  bbox?: [number, number, number, number]; // [x, y, width, height]
  segmentation?: number[][]; // COCO format segmentation
  area?: number;
  uploadedAt: string;
}

export interface Category {
  id: string;
  name: string;
  color: string;
}

export interface DatasetFormValues {
  name: string;
  description: string;
  type?: "classification" | "segmentation" | "panomatic";
  tags?: string[];
}
