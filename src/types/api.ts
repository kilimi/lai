
export interface ApiConfig {
  baseUrl: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface Api {
  getImages: (datasetId: string) => Promise<ApiResponse<any[]>>;
  getDataset: (id: string) => Promise<ApiResponse<any>>;
  getProject: (id: string) => Promise<ApiResponse<any>>;
  uploadImages: (id: string, formData: FormData) => Promise<ApiResponse<any>>;
  deleteImage: (datasetId: string, imageId: string) => Promise<ApiResponse<any>>;
}
