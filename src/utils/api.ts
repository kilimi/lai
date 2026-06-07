import { ApiConfig, ApiResponse } from '@/types/api';
import { Dataset, Project, Image, ImageCollection } from '@/types';
import { normalizeImageMedia } from '@/config/api';

/**
 * Simple API client for interacting with FastAPI backend
 */
export class ApiClient {
  private config: ApiConfig;
  
  constructor(config: ApiConfig) {
    this.config = config;
  }

  /**
   * Helper method to make API requests
   */
  async request<T>(endpoint: string, options: RequestInit = {}, retries: number = 2): Promise<ApiResponse<T>> {
    const url = `${this.config.baseUrl}${endpoint}`;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // Handle headers based on body type
        const isFormData = options.body instanceof FormData;
        
        if (!isFormData) {
          // For non-FormData requests, set JSON headers
          if (!options.headers) {
            options.headers = {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
            };
          } else if (typeof options.headers === 'object' && !(options.headers instanceof Headers)) {
            // Ensure Content-Type is set for JSON
            (options.headers as Record<string, string>)['Content-Type'] = 'application/json';
          }
        } else {
          // For FormData, don't set Content-Type at all (browser will set it with boundary)
          // Only set Accept header if no headers are provided
          if (!options.headers) {
            options.headers = {
              'Accept': 'application/json',
            };
          }
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minute timeout
        
        let response: Response;
        try {
          response = await fetch(url, {
            ...options,
            signal: controller.signal,
            // Omit credentials so any dev Origin (e.g. http://[::1]:8080) works with CORS
            credentials: 'omit',
          });
        } catch (fetchError) {
          // Catch network errors at fetch level (including CONTENT_LENGTH_MISMATCH)
          const fetchErrorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);
          
          // Check if it's a content length error (browser throws TypeError for these)
          if (fetchError instanceof TypeError && 
              (fetchErrorMessage.includes('CONTENT_LENGTH') || 
               fetchErrorMessage.includes('CHUNKED_ENCODING') ||
               fetchErrorMessage.includes('ERR_CONTENT_LENGTH') ||
               fetchErrorMessage.includes('ERR_INCOMPLETE'))) {
            throw new Error(`Network error: Server response was incomplete (${fetchErrorMessage}). The backend may have crashed or timed out.`);
          }
          
          // Re-throw other fetch errors
          throw fetchError;
        }
        
        clearTimeout(timeoutId);
        
        // Log response details for debugging
        if (!response.ok || attempt === retries) {
          console.debug(`Response status: ${response.status} ${response.statusText}`);
          console.debug(`Content-Type: ${response.headers.get('content-type')}`);
          console.debug(`Content-Length: ${response.headers.get('content-length')}`);
        }

        // Check if response has content
        const contentType = response.headers.get('content-type') || '';
        const contentLength = response.headers.get('content-length');
        const hasJsonContent = contentType.includes('application/json');
        
        // Handle empty responses
        if (contentLength === '0' || (!hasJsonContent && response.status === 204)) {
          // No content response (204 No Content)
          if (response.ok) {
            return { 
              success: true, 
              data: null as T 
            };
          }
        }

        let data;
        try {
          // Check if there's actually content to read
          const text = await response.text();
          
          if (!text || text.trim() === '') {
            // Empty response
            if (response.ok) {
              return { 
                success: true, 
                data: null as T 
              };
            } else {
              throw new Error(`Empty response from server (${response.status} ${response.statusText})`);
            }
          }
          
          // Try to parse as JSON
          try {
            data = JSON.parse(text);
          } catch (parseError) {
            // If it's not JSON, check if it's an HTML error page
            if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
              throw new Error(`Server returned HTML instead of JSON. This usually means the endpoint doesn't exist or there's a server error. Status: ${response.status}`);
            }
            throw new Error(`Failed to parse JSON response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}. Response preview: ${text.substring(0, 100)}`);
          }
        } catch (e) {
          // Re-throw with more context
          if (e instanceof Error) {
            throw e;
          }
          throw new Error(`Failed to parse response: ${e instanceof Error ? e.message : 'Unknown error'}`);
        }

        if (!response.ok) {
          // Pydantic v2 returns detail as an array of {type,loc,msg,input,ctx} on 422
          const rawDetail = data.detail;
          const errorMessage = Array.isArray(rawDetail)
            ? rawDetail.map((e: any) => e.msg || JSON.stringify(e)).join('; ')
            : (typeof rawDetail === 'string' ? rawDetail : rawDetail ? JSON.stringify(rawDetail) : `${response.status} ${response.statusText}`);
          console.error("API error:", data);
          return {
            success: false,
            error: errorMessage
          };
        }

        // If the response has a success field, use it directly
        if (typeof data.success === 'boolean') {
          return data as ApiResponse<T>;
        }

        // Otherwise wrap the data in a success response
        return { 
          success: true, 
          data: data 
        };
      } catch (error) {
        // Check if it's an AbortError (timeout)
        const isAbortError = error instanceof Error && error.name === 'AbortError';
        
        // Only log non-abort errors or if it's the final attempt
        if (!isAbortError || attempt === retries) {
          console.error(`API Request Error (attempt ${attempt}/${retries}):`, error);
        } else {
          // Silently handle abort errors during retries (expected during long operations)
          console.debug(`Request aborted (attempt ${attempt}/${retries}), retrying...`);
        }
        
        // Check if it's a network error that might benefit from retry
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isNetworkError = error instanceof TypeError || 
                              (error instanceof Error && (
                                errorMessage.includes('Failed to fetch') ||
                                errorMessage.includes('NetworkError') ||
                                errorMessage.includes('network') ||
                                errorMessage.includes('CONTENT_LENGTH_MISMATCH') ||
                                errorMessage.includes('INCOMPLETE_CHUNKED_ENCODING') ||
                                errorMessage.includes('ERR_CONTENT_LENGTH_MISMATCH') ||
                                errorMessage.includes('ERR_INCOMPLETE_CHUNKED_ENCODING')
                              ));
        
        // Check for specific browser network errors (these appear in the error message)
        const isContentLengthError = errorMessage.includes('CONTENT_LENGTH') || 
                                    errorMessage.includes('CHUNKED_ENCODING') ||
                                    errorMessage.includes('ERR_CONTENT_LENGTH') ||
                                    errorMessage.includes('ERR_INCOMPLETE');
        
        if (isContentLengthError) {
          console.warn(`Content-Length mismatch detected (attempt ${attempt}/${retries}). This usually means the server response was cut off.`);
        }
        
        // If this is the last attempt or not a network/abort error, return error
        if (attempt === retries || (!isNetworkError && !isAbortError)) {
          if (isAbortError) {
            return {
              success: false,
              error: 'Request timed out. The server may be busy. Please try again.'
            };
          }
          
          // Provide helpful error message for content length errors
          if (isContentLengthError) {
            return {
              success: false,
              error: 'Server response was incomplete. The backend may have crashed or timed out. Please check backend logs and try again.'
            };
          }
          
          return { 
            success: false, 
            error: error instanceof Error ? error.message : 'Unknown API error'
          };
        }
        
        // Wait before retrying (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
    
    // Should never reach here, but TypeScript needs it
    return {
      success: false,
      error: 'Request failed after multiple attempts'
    };
  }

  /**
   * Lightweight health check.  Called once (shared across all useApi hooks) so
   * 30+ components don't each fire 3 × 15 s retries.
   */
  async testConnection(retries: number = 1): Promise<ApiResponse<{ status: string; database?: string }>> {
    const url = `${this.config.baseUrl}/health-check`;

    if (this.config.baseUrl.includes(':8080')) {
      return {
        success: false,
        error: `API URL points to the frontend port (8080). Backend should be on port 9999.`,
      };
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5_000);

      try {
        const response = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          credentials: 'omit',
          cache: 'no-cache',
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          const apiReachable =
            data && typeof data === 'object' && (data.status === 'ok' || data.status === 'degraded');
          return {
            success: !!apiReachable,
            data: { status: data.status || 'unknown', database: data.database || 'unknown' },
            error: apiReachable ? undefined : `Unexpected health response`,
          };
        }
        throw new Error(`${response.status} ${response.statusText}`);
      } catch (error) {
        clearTimeout(timeoutId);

        if (attempt === retries) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          console.debug(`Health check failed (${url}): ${msg}`);
          return { success: false, error: msg };
        }
        // Short backoff before retry
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }

    return { success: false, error: 'Health check failed' };
  }

  // Projects endpoints
  
  async getProjects(): Promise<ApiResponse<Project[]>> {
    // Row logos are 200×200 JPEG data URLs from the API; needed for ProjectCard / dataset avatars.
    return this.request<Project[]>('/projects/?include_images=true');
  }

  async getProject(
    id: string,
    options?: { includeImages?: boolean; includeDatasetAnnotationFiles?: boolean },
  ): Promise<ApiResponse<Project>> {
    const params = new URLSearchParams();
    // Default true: single-project views need logo_url / dataset thumbnails on cards.
    if (options?.includeImages !== false) {
      params.set('include_images', 'true');
    }
    if (options?.includeDatasetAnnotationFiles) {
      params.set('include_dataset_annotation_files', 'true');
    }
    const q = params.toString();
    return this.request<Project>(`/projects/${id}${q ? `?${q}` : ''}`);
  }

  /** Lightweight project summary — name, tags, dataset_count. No annotation queries. */
  async getProjectSummary(
    id: string | number,
  ): Promise<ApiResponse<Project & { dataset_count?: number }>> {
    return this.request(`/projects/${id}/summary`);
  }

  /** Layout nav badges: COUNT-only, no task rows */
  async getProjectSidebarCounts(
    projectId: string | number,
  ): Promise<
    ApiResponse<{
      models: number;
      evaluations: number;
      exports: number;
      pipelines: number;
    }>
  > {
    return this.request(`/projects/${projectId}/sidebar-counts`);
  }

  async createProject(formData: FormData): Promise<ApiResponse<Project>> {
    return this.request<Project>('/projects/', {
      method: 'POST',
      body: formData,
    });
  }

  async updateProject(id: string | number, formData: FormData): Promise<ApiResponse<Project>> {
    return this.request<Project>(`/projects/${id}`, {
      method: 'PUT',
      body: formData,
    });
  }

  async deleteProject(id: number | string): Promise<ApiResponse<{success: boolean; message: string}>> {
    return this.request(`/projects/${id}`, {
      method: 'DELETE'
    });
  }

  async duplicateProject(id: string | number): Promise<ApiResponse<Project>> {
    return this.request<Project>(`/projects/${id}/duplicate`, {
      method: 'POST'
    });
  }

  // Datasets endpoints
  
  async getDatasets(): Promise<ApiResponse<Dataset[]>> {
    return this.request<Dataset[]>('/datasets/');
  }

  async getDataset(id: string): Promise<ApiResponse<Dataset>> {
    return this.request<Dataset>(`/datasets/${id}`);
  }

  async createDataset(formData: FormData): Promise<ApiResponse<Dataset>> {
    return this.request<Dataset>('/datasets/', {
      method: 'POST',
      body: formData,
    });
  }

  // Removed old createAugmentedDataset method - replaced with async version below

  async updateDataset(id: string | number, formData: FormData): Promise<ApiResponse<Dataset>> {
    return this.request<Dataset>(`/datasets/${id}`, {
      method: 'PUT',
      body: formData,
    });
  }

  async deleteDataset(id: number | string): Promise<ApiResponse<{success: boolean; message: string}>> {
    return this.request(`/datasets/${id}`, {
      method: 'DELETE'
    });
  }

  async duplicateDataset(datasetId: number): Promise<ApiResponse<any>> {
    try {
      const response = await fetch(`${this.config.baseUrl}/datasets/${datasetId}/duplicate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to duplicate dataset',
      };
    }
  }

  async moveDataset(
    datasetId: string | number,
    targetProjectId: number
  ): Promise<ApiResponse<Dataset>> {
    const primary = await this.request<Dataset>(`/datasets/${datasetId}/move`, {
      method: 'POST',
      body: JSON.stringify({ project_id: targetProjectId }),
    });

    // Compatibility fallback for servers that have not picked up the dedicated move endpoint yet.
    if (
      primary.success ||
      !primary.error ||
      (!primary.error.includes('404') && !primary.error.toLowerCase().includes('not found'))
    ) {
      return primary;
    }

    const existing = await this.getDataset(String(datasetId));
    if (!existing.success || !existing.data) return primary;

    const formData = new FormData();
    formData.append('name', existing.data.name || '');
    formData.append('description', existing.data.description || '');
    formData.append('tags', JSON.stringify(existing.data.tags || []));
    formData.append('project_id', String(targetProjectId));

    return this.request<Dataset>(`/datasets/${datasetId}`, {
      method: 'PUT',
      body: formData,
    });
  }

  async mergeDatasets(projectId: string | number, name: string, datasetIds: number[]): Promise<ApiResponse<{
    id: number;
    name: string;
    description: string;
    total_images: number;
    total_annotations: number;
    source_datasets: string[];
  }>> {
    try {
      const response = await fetch(`${this.config.baseUrl}/projects/${projectId}/datasets/merge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name,
          dataset_ids: datasetIds
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      return { success: true, data: result.data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to merge datasets',
      };
    }
  }

  async uploadImages(datasetId: string | number, formData: FormData): Promise<ApiResponse<any>> {
    return this.request(`/datasets/${datasetId}/images`, {
      method: 'POST',
      body: formData
    });
  }

  /**
   * Upload a video; backend extracts frames and adds them as dataset images.
   *
   * Uses XMLHttpRequest (not fetch) so we can report upload progress for
   * large video files. Browsers don't emit upload-progress events from the
   * Fetch API, so for any request where we want a progress bar we have to
   * fall back to XHR. `onProgress` is optional; when omitted this behaves
   * like a normal request.
   *
   * `jobId`, when provided, is also sent as a form field so the backend can
   * publish extraction progress keyed by this id; the caller can then poll
   * `/video-extract/progress/{jobId}` to drive a server-side progress bar.
   */
  uploadVideoExtract(
    datasetId: string | number,
    videoFile: File,
    params: {
      interval_seconds: number;
      frame_step?: number;
      max_frames: number;
      collection_id?: string | number;
      sequential_names?: boolean;
      resize_width?: number;
      resize_height?: number;
    },
    onProgress?: (progress: {
      loaded: number;
      total: number;
      percent: number;
      lengthComputable: boolean;
    }) => void,
    jobId?: string
  ): Promise<ApiResponse<{ uploaded: number; images: any[] }>> {
    const form = new FormData();
    form.append('video', videoFile);
    form.append('interval_seconds', String(params.interval_seconds));
    if (params.frame_step !== undefined && params.frame_step !== null) {
      form.append('frame_step', String(params.frame_step));
    }
    form.append('max_frames', String(params.max_frames));
    if (params.collection_id !== undefined && params.collection_id !== null && params.collection_id !== '') {
      form.append('collection_id', String(params.collection_id));
    }
    if (params.sequential_names) {
      form.append('sequential_names', 'true');
    }
    if (params.resize_width && params.resize_width > 0) {
      form.append('resize_width', String(params.resize_width));
    }
    if (params.resize_height && params.resize_height > 0) {
      form.append('resize_height', String(params.resize_height));
    }
    if (jobId) form.append('job_id', jobId);

    const url = `${this.config.baseUrl}/datasets/${datasetId}/video-extract`;

    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      // Match the fetch-based client: don't send cookies (avoids CORS issues
      // with dev origins).
      xhr.withCredentials = false;

      if (onProgress) {
        xhr.upload.onprogress = (event) => {
          const total = event.total || videoFile.size || 0;
          const loaded = event.loaded || 0;
          const percent = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
          onProgress({
            loaded,
            total,
            percent,
            lengthComputable: event.lengthComputable,
          });
        };
        xhr.upload.onloadend = () => {
          // Upload finished; server is now processing. Pin bar at 100 so UI
          // can switch to an indeterminate "extracting..." state if desired.
          onProgress({
            loaded: videoFile.size,
            total: videoFile.size,
            percent: 100,
            lengthComputable: true,
          });
        };
      }

      const finish = (resp: ApiResponse<{ uploaded: number; images: any[] }>) => {
        resolve(resp);
      };

      xhr.onload = () => {
        const status = xhr.status;
        const raw = xhr.responseText || '';
        let body: any = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = null;
        }
        if (status >= 200 && status < 300) {
          // Backend returns the payload directly; wrap in ApiResponse shape.
          finish({ success: true, data: body as { uploaded: number; images: any[] } });
        } else {
          const message =
            (body && (body.detail || body.message)) ||
            `Upload failed with status ${status}`;
          finish({ success: false, error: String(message) } as ApiResponse<any>);
        }
      };

      xhr.onerror = () => {
        finish({ success: false, error: 'Network error during upload' } as ApiResponse<any>);
      };
      xhr.onabort = () => {
        finish({ success: false, error: 'Upload aborted' } as ApiResponse<any>);
      };
      xhr.ontimeout = () => {
        finish({ success: false, error: 'Upload timed out' } as ApiResponse<any>);
      };

      xhr.send(form);
    });
  }

  /** Poll server-side progress for an in-flight video extraction job. */
  async getVideoExtractProgress(
    datasetId: string | number,
    jobId: string
  ): Promise<ApiResponse<{
    job_id: string;
    stage: 'unknown' | 'starting' | 'receiving' | 'extracting' | 'saving' | 'done' | 'error';
    extracted: number;
    total: number;
    percent: number;
    uploaded?: number;
    error?: string;
  }>> {
    return this.request(`/datasets/${datasetId}/video-extract/progress/${encodeURIComponent(jobId)}`);
  }

  async getImages(datasetId: string | number): Promise<ApiResponse<Image[]>> {
    const response = await this.request<Image[]>(`/datasets/${datasetId}/images`);
    if (response.success && response.data) {
      response.data = response.data.map((img) => normalizeImageMedia(img));
    }
    return response;
  }

  async getImageCollections(datasetId: string | number): Promise<ApiResponse<ImageCollection[]>> {
    const response = await this.request<ImageCollection[]>(
      `/datasets/${datasetId}/image-collections`,
    );
    if (response.success && response.data) {
      response.data = response.data.map((collection) => ({
        ...collection,
        images: (collection.images ?? []).map((img) => normalizeImageMedia(img)),
        paginatedImages: (collection.paginatedImages ?? []).map((img) =>
          normalizeImageMedia(img),
        ),
      }));
    }
    return response;
  }

  async deleteImage(datasetId: string | number, imageId: string): Promise<ApiResponse<any>> {
    return this.request(`/datasets/${datasetId}/images/${imageId}`, {
      method: 'DELETE'
    });
  }

  // Annotations endpoints
  async getAnnotations(datasetId: string | number): Promise<ApiResponse<any[]>> {
    return this.request<any[]>(`/datasets/${datasetId}/annotations`);
  }

  async getAnnotationsSummary(datasetId: string | number): Promise<ApiResponse<{
    dataset_id: number;
    file_count: number;
    total_annotations: number;
    files: Array<{
      id: string;
      name: string;
      stored_count: number;
      actual_count: number;
      image_count: number;
      processing_status: string;
    }>;
  }>> {
    return this.request<any>(`/datasets/${datasetId}/annotations/summary`);
  }

  async getAnnotation(datasetId: string | number, annotationId: string): Promise<ApiResponse<any>> {
    return this.request<any>(`/datasets/${datasetId}/annotations/${annotationId}`);
  }

  async getAnnotationsList(
    datasetId: string | number,
    params?: {
      page?: number;
      limit?: number;
      sort_by?: string;
      sort_order?: 'asc' | 'desc';
    }
  ): Promise<ApiResponse<{
    annotations: Array<{
      id: string;
      name: string;
      format: string;
      stored_count: number;
      actual_count: number;
      processing_status: string;
      created_at: string;
      updated_at: string;
    }>;
    pagination: {
      page: number;
      limit: number;
      total: number;
      pages: number;
    };
  }>> {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.append('page', params.page.toString());
    if (params?.limit) searchParams.append('limit', params.limit.toString());
    if (params?.sort_by) searchParams.append('sort_by', params.sort_by);
    if (params?.sort_order) searchParams.append('sort_order', params.sort_order);
    
    const queryString = searchParams.toString();
    const endpoint = `/datasets/${datasetId}/annotations/list${queryString ? `?${queryString}` : ''}`;
    
    return this.request(endpoint);
  }

  async deleteAnnotation(datasetId: string | number, annotationId: string): Promise<ApiResponse<any>> {
    return this.request(`/datasets/${datasetId}/annotations/${annotationId}`, {
      method: 'DELETE'
    });
  }

  // Coverage endpoints
  async getAnnotationFileCoverage(datasetId: string | number, annotationFileId: string): Promise<ApiResponse<{
    annotation_file_id: string;
    total_referenced_images: number;
    present_count: number;
    missing_count: number;
    present: Array<{ image_id: number; file_name: string }>;
    missing: Array<{ coco_image_id: number; file_name: string }>;
  }>> {
    return this.request(`/datasets/${datasetId}/annotations/${annotationFileId}/coverage`);
  }

  async getAnnotationCollectionCounts(
    datasetId: string | number,
    annotationFileId: string
  ): Promise<ApiResponse<Array<{
    collection_id: number;
    collection_name: string;
    annotation_count: number;
  }>>> {
    return this.request(`/datasets/${datasetId}/annotations/${annotationFileId}/collection-counts`);
  }

  async getDatasetAnnotationsCoverage(datasetId: string | number): Promise<ApiResponse<Array<{
    annotation_file_id: string;
    name: string;
    total_referenced_images: number;
    present_count: number;
    missing_count: number;
  }>>> {
    return this.request(`/datasets/${datasetId}/annotations/coverage`);
  }

  async renameAnnotation(datasetId: string | number, annotationId: string, newName: string): Promise<ApiResponse<any>> {
    const formData = new FormData();
    formData.append('new_name', newName);
    return this.request(`/datasets/${datasetId}/annotations/${annotationId}/rename`, {
      method: 'PUT',
      body: formData
    });
  }

  async updateAnnotationTags(datasetId: string | number, annotationId: string, tags: string[]): Promise<ApiResponse<any>> {
    const formData = new FormData();
    tags.forEach(tag => formData.append('tags', tag));
    return this.request(`/datasets/${datasetId}/annotations/${annotationId}/tags`, {
      method: 'PUT',
      body: formData
    });
  }

  async importAnnotations(datasetId: string | number, file: File, annotationType?: string): Promise<ApiResponse<any>> {
    const formData = new FormData();
    formData.append('file', file);
    if (annotationType && annotationType !== 'any') {
      formData.append('annotation_type', annotationType);
    }
    return this.request(`/datasets/${datasetId}/import-annotations`, {
      method: 'POST',
      body: formData
    });
  }

  /**
   * Create an annotation processing task (async processing)
   */
  async createAnnotationProcessingTask(
    datasetId: string | number, 
    file: File, 
    annotationType?: string,
    taskName?: string
  ): Promise<ApiResponse<{
    task_id: number;
    file_id: string;
    status: string;
    message: string;
  }>> {
    const formData = new FormData();
    formData.append('file', file);
    if (annotationType && annotationType !== 'any') {
      formData.append('annotation_type', annotationType);
    }
    if (taskName) {
      formData.append('task_name', taskName);
    }
    
    return this.request(`/datasets/${datasetId}/create-annotation-task`, {
      method: 'POST',
      body: formData
    });
  }

  // Database-based annotation methods
  async getAnnotationData(
    datasetId: string | number, 
    annotationFileId: string, 
    params?: {
      imageIds?: string[];
      page?: number;
      limit?: number;
      className?: string;
    }
  ): Promise<ApiResponse<{
    annotations: any[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      pages: number;
    };
  }>> {
    const searchParams = new URLSearchParams();
    if (params?.imageIds?.length) {
      searchParams.append('image_ids', params.imageIds.join(','));
    }
    if (params?.page) searchParams.append('page', params.page.toString());
    if (params?.limit) searchParams.append('limit', params.limit.toString());
    if (params?.className) searchParams.append('class_name', params.className);
    
    const queryString = searchParams.toString();
    const endpoint = `/datasets/${datasetId}/annotations/${annotationFileId}/data${queryString ? `?${queryString}` : ''}`;
    
    return this.request(endpoint);
  }

  async getImageAnnotations(
    datasetId: string | number,
    annotationFileId: string,
    imageFilename: string,
    collectionId?: string | number | null
  ): Promise<ApiResponse<{
    annotations: Array<{
      id: number;
      className: string;
      color: string;
      segmentation: number[];
      bbox: number[] | null;
      area: number | null;
      confidence: number | null;
    }>;
    imageWidth: number;
    imageHeight: number;
    imageFilename: string;
    imageId: number;
  }>> {
    const params = new URLSearchParams({ image_filename: imageFilename });
    if (collectionId !== undefined && collectionId !== null && String(collectionId) !== "") {
      const numericCollectionId = Number(collectionId);
      if (Number.isFinite(numericCollectionId)) {
        params.set("collection_id", String(numericCollectionId));
      }
    }
    const qs = params.toString();
    return this.request(`/datasets/${datasetId}/annotations/${annotationFileId}/image-annotations?${qs}`);
  }

  async getAnnotationClasses(
    datasetId: string | number, 
    annotationFileId: string
  ): Promise<ApiResponse<{
    classes: Array<{
      className: string;
      count: number;
      color: string;
      opacity: number;
      categoryId?: number;
    }>;
    totalClasses: number;
    totalAnnotations: number;
  }>> {
    return this.request(`/datasets/${datasetId}/annotations/${annotationFileId}/classes`);
  }

  async getAnnotationProcessingStatus(
    datasetId: string | number, 
    annotationFileId: string
  ): Promise<ApiResponse<{
    status: string;
    isProcessed: boolean;
    errorMessage?: string;
    annotationCount: number;
    imageCount: number;
    categoryCount: number;
  }>> {
    return this.request(`/datasets/${datasetId}/annotations/${annotationFileId}/status`);
  }

  async updateAnnotation(
    datasetId: string | number,
    annotationFileId: string,
    annotationId: number,
    updateData: {
      className?: string;
      confidence?: number;
    }
  ): Promise<ApiResponse<{ success: boolean; message: string }>> {
    return this.request(`/datasets/${datasetId}/annotations/${annotationFileId}/annotation/${annotationId}`, {
      method: 'PUT',
      body: JSON.stringify(updateData)
    });
  }

  async deleteClassAnnotations(
    datasetId: string | number,
    annotationFileId: string,
    className: string
  ): Promise<ApiResponse<{ 
    success: boolean; 
    message: string; 
    deleted_count: number;
    remaining_annotations: number;
    remaining_classes: number;
  }>> {
    return this.request(`/datasets/${datasetId}/annotations/${annotationFileId}/class/${encodeURIComponent(className)}`, {
      method: 'DELETE'
    });
  }

  async uploadCocoAnnotationFile(
    datasetId: string | number,
    file: File
  ): Promise<ApiResponse<{
    success: boolean;
    annotation_file_id: string;
    message: string;
  }>> {
    const formData = new FormData();
    formData.append('file', file);
    return this.request(`/datasets/${datasetId}/annotations/upload-coco`, {
      method: 'POST',
      body: formData
    });
  }

  /**
   * Create an augmented dataset asynchronously
   */
  async createAugmentedDataset(formData: FormData): Promise<ApiResponse<{
    success: boolean;
    message: string;
    task_id: number;
    dataset_id: number;
    status: string;
  }>> {
    return this.request('/augmentations/', {
      method: 'POST',
      body: formData
    });
  }

  /**
   * Get task status and progress
   */
  async getTask(taskId: number): Promise<ApiResponse<{
    id: number;
    name: string;
    description: string;
    task_type: string;
    status: string;
    progress: number;
    created_at: string;
    started_at?: string;
    completed_at?: string;
    error_message?: string;
    project_id: number;
    task_metadata?: any;
  }>> {
    return this.request(`/tasks/${taskId}`);
  }

  /**
   * Get tasks with optional filtering
   */
  async getTasks(params?: {
    project_id?: number;
    task_type?: string;
    status?: string;
    skip?: number;
    limit?: number;
    /** When set, include tasks that are active OR completed in the last N hours (for navbar "last hour" view) */
    recent_hours?: number;
    /**
     * list (default): omit huge evaluation blobs from task_metadata.results (navbar-safe).
     * full: include full metadata — only use when you truly need inline predictions on a list response.
     */
    metadata_mode?: 'list' | 'full';
  }): Promise<ApiResponse<Array<{
    id: number;
    name: string;
    description: string;
    task_type: string;
    status: string;
    progress: number;
    created_at: string;
    started_at?: string;
    completed_at?: string;
    error_message?: string;
    project_id: number;
    task_metadata?: any;
  }>>> {
    const searchParams = new URLSearchParams();
    if (params?.project_id) searchParams.append('project_id', params.project_id.toString());
    if (params?.task_type) searchParams.append('task_type', params.task_type);
    if (params?.status) searchParams.append('status', params.status);
    if (params?.skip) searchParams.append('skip', params.skip.toString());
    if (params?.limit) searchParams.append('limit', params.limit.toString());
    if (params?.recent_hours != null) searchParams.append('recent_hours', params.recent_hours.toString());
    searchParams.append(
      'metadata_mode',
      params?.metadata_mode === 'full' ? 'full' : 'list',
    );

    const queryString = searchParams.toString();
    const endpoint = queryString ? `/tasks/?${queryString}` : '/tasks/';
    
    return this.request(endpoint);
  }

  /**
   * Get active tasks (pending, running)
   */
  async getActiveTasks(projectId?: number): Promise<ApiResponse<Array<{
    id: number;
    name: string;
    description: string;
    task_type: string;
    status: string;
    progress: number;
    created_at: string;
    started_at?: string;
    completed_at?: string;
    error_message?: string;
    project_id: number;
    metadata?: any;
    task_metadata?: any;
  }>>> {
    const searchParams = new URLSearchParams();
    if (projectId) searchParams.append('project_id', projectId.toString());
    const qs = searchParams.toString();
    return this.request(qs ? `/tasks/active?${qs}` : '/tasks/active');
  }

  /**
   * Cancel a task
   */
  async cancelTask(taskId: number): Promise<ApiResponse<{
    success: boolean;
    message: string;
    task_id: number;
  }>> {
    return this.request(`/tasks/${taskId}/cancel`, {
      method: 'PATCH'
    });
  }

  /**
   * Delete all failed tasks for a project
   */
  async deleteFailedTasks(projectId: number): Promise<ApiResponse<{
    success: boolean;
    message: string;
    deleted_count: number;
  }>> {
    return this.request(`/projects/${projectId}/tasks/failed`, {
      method: 'DELETE'
    });
  }

  async getAnnotationContent(
    datasetId: string | number, 
    annotationId: string,
    options?: {
      /** @deprecated No longer sent — server uses fixed limits for this endpoint */
      limit?: number;
      include_images?: boolean;
      include_annotations?: boolean;
    }
  ): Promise<ApiResponse<{
    content: string | null;
    filename?: string;
    format: string;
    size: number;
    source: string;
    is_large?: boolean;
    is_processing?: boolean;
    processing_status?: string;
    total_annotations?: number;
    annotation_count?: number;
    image_count?: number;
    category_count?: number;
    message?: string;
  }>> {
    const searchParams = new URLSearchParams();
    if (options?.include_images !== undefined) searchParams.append('include_images', options.include_images.toString());
    if (options?.include_annotations !== undefined) searchParams.append('include_annotations', options.include_annotations.toString());
    
    const queryString = searchParams.toString();
    const endpoint = `/datasets/${datasetId}/annotations/${annotationId}/content${queryString ? `?${queryString}` : ''}`;
    
    return this.request<any>(endpoint);
  }

  async updateAnnotationContent(datasetId: string | number, annotationId: string, file: File): Promise<ApiResponse<any>> {
    const formData = new FormData();
    formData.append('file', file);
    return this.request(`/datasets/${datasetId}/annotations/${annotationId}/content`, {
      method: 'PUT',
      body: formData
    });
  }

  /** Rename a class in an annotation file (same backend as Dataset annotations + Edit Dataset statistics). */
  async renameAnnotationClass(
    datasetId: string | number,
    annotationId: string,
    oldClassName: string,
    newClassName: string
  ): Promise<ApiResponse<{ annotations_updated?: number; classes?: Array<{ className: string; count: number; color: string; opacity?: number; categoryId?: number }> }>> {
    return this.request(`/datasets/${datasetId}/annotations/${annotationId}/class/rename`, {
      method: 'PUT',
      body: JSON.stringify({ old_class_name: oldClassName, new_class_name: newClassName }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async deleteAnnotationClass(datasetId: string | number, annotationId: string, className: string): Promise<ApiResponse<{
    deleted_count: number;
    remaining_annotations: number;
    remaining_categories: number;
  }>> {
    return this.request(`/datasets/${datasetId}/annotations/${annotationId}/class/${encodeURIComponent(className)}`, {
      method: 'DELETE'
    });
  }

  async duplicateAnnotationFile(datasetId: string | number, annotationId: string): Promise<ApiResponse<{
    new_file_id: string;
    new_file_name: string;
    annotation_count: number;
  }>> {
    return this.request(`/datasets/${datasetId}/annotations/${annotationId}/duplicate`, {
      method: 'POST'
    });
  }

  async mergeAnnotationFiles(
    datasetId: string | number,
    annotationFileIds: string[],
    mergedFilename?: string,
    strategy?: {
      strategy: 'exact' | 'iou' | 'priority' | 'union';
      iou_threshold: number;
      tie_breaker: 'largest' | 'smallest' | 'first' | 'last';
      priority_order: string[];
      cross_class: 'keep' | 'priority';
      cross_class_iou: number;
    }
  ): Promise<ApiResponse<{
    task_id: number;
    message: string;
    merged_filename: string;
    source_files?: string[];
  }>> {
    return this.request(`/datasets/${datasetId}/annotations/merge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        annotation_file_ids: annotationFileIds,
        merged_filename: mergedFilename,
        ...(strategy ? { strategy } : {}),
      })
    });
  }

  async viewAnnotationsInFiftyOne(
    datasetId: string | number,
    annotationFileIds: string[],
    options?: { imageCollectionId?: number }
  ): Promise<ApiResponse<{ message: string; url?: string }>> {
    return this.request(`/datasets/${datasetId}/annotations/view-fiftyone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        annotation_file_ids: annotationFileIds,
        ...(options?.imageCollectionId != null && !Number.isNaN(options.imageCollectionId)
          ? { image_collection_id: options.imageCollectionId }
          : {}),
      }),
    });
  }

  // Database backup and restore methods
  async getDatabaseConnectionInfo(): Promise<ApiResponse<{
    database_name: string;
    database_type: string;
    database_host: string;
    timestamp: string;
  }>> {
    return this.request('/database/connection');
  }

  async getDatabaseInfo(): Promise<ApiResponse<{
    database_info: {
      projects: number;
      datasets: number;
      images: number;
      annotations: number;
      annotation_files: number;
      annotation_classes: number;
      image_collections: number;
      tasks: number;
      augmentations: number;
      dataset_groups: number;
      total_records: number;
    };
    timestamp: string;
  }>> {
    return this.request('/database/info');
  }

  async getProjectsNamesOnly(): Promise<ApiResponse<Array<{
    id: number;
    name: string;
    datasets: Array<{ id: number; name: string }>;
  }>>> {
    return this.request('/projects/names-only');
  }

  async exportDatabase(
    onProgress?: (progress: number) => void, 
    projectIds?: number[], 
    datasetIds?: number[],
    abortSignal?: AbortSignal
  ): Promise<void> {
    try {
      // Build URL with query parameters
      const params = new URLSearchParams();
      if (projectIds && projectIds.length > 0) {
        params.append('project_ids', projectIds.join(','));
      }
      if (datasetIds && datasetIds.length > 0) {
        params.append('dataset_ids', datasetIds.join(','));
      }
      
      const queryString = params.toString();
      const url = `${this.config.baseUrl}/database/export${queryString ? `?${queryString}` : ''}`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
        signal: abortSignal,
      });

      if (!response.ok) {
        throw new Error(`Export failed: ${response.status} ${response.statusText}`);
      }

      // Track progress while reading the response
      const reader = response.body?.getReader();
      const contentLength = response.headers.get('Content-Length');
      
      if (!reader) {
        throw new Error('Failed to read response');
      }

      let receivedLength = 0;
      const totalLength = contentLength ? parseInt(contentLength, 10) : 0;
      const chunks: Uint8Array[] = [];

      // For smooth progress updates
      let lastProgressUpdate = 0;

      // Show initial progress immediately
      if (onProgress) {
        onProgress(1);
        lastProgressUpdate = 1;
      }

      while (true) {
        // Check if cancelled
        if (abortSignal?.aborted) {
          reader.cancel();
          throw new Error('Export cancelled by user');
        }
        
        const { done, value } = await reader.read();
        
        if (done) break;
        
        chunks.push(value);
        receivedLength += value.length;
        
        if (onProgress && totalLength > 0) {
          const progress = Math.min(95, Math.round((receivedLength / totalLength) * 100));
          // Update whenever progress increases
          if (progress > lastProgressUpdate) {
            onProgress(progress);
            lastProgressUpdate = progress;
          }
        } else if (onProgress && totalLength === 0) {
          // For streaming without content-length, show steady incremental progress
          // Use logarithmic scale: grows fast initially, then slows down
          const streamingProgress = Math.min(90, 10 + Math.floor(Math.log(receivedLength + 1) * 8));
          if (streamingProgress > lastProgressUpdate) {
            onProgress(streamingProgress);
            lastProgressUpdate = streamingProgress;
          }
        }
      }

      // Check if cancelled before processing
      if (abortSignal?.aborted) {
        throw new Error('Export cancelled by user');
      }

      // Processing stage - show progress
      if (onProgress) onProgress(96);

      // Create blob directly from chunks (more efficient than combining into one array)
      const blob = new Blob(chunks as BlobPart[], { type: 'application/json' });

      // Streaming export has no Content-Length; verify JSON before saving a broken backup.
      if (receivedLength > 0 && receivedLength <= 100 * 1024 * 1024) {
        const text = await blob.text();
        if (!text.trimEnd().endsWith('}}')) {
          throw new Error(
            'Export file appears incomplete (JSON does not end with }}). ' +
            'Try "Export with files" (ZIP) or export fewer projects/datasets.'
          );
        }
        try {
          JSON.parse(text);
        } catch (parseError) {
          const msg = parseError instanceof Error ? parseError.message : String(parseError);
          throw new Error(
            `Export produced invalid JSON (${msg}). Do not import this file — re-export or use the ZIP archive.`
          );
        }
      }
      
      if (onProgress) onProgress(97);

      // Get filename from response headers or use default
      const contentDisposition = response.headers.get('Content-Disposition');
      const filename = contentDisposition?.match(/filename="?([^"]+)"?/)?.[1] || 
                     `lai_backup_${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.json`;
      
      if (onProgress) onProgress(98);

      // Create download link
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl);
      
      if (onProgress) onProgress(100);
    } catch (error) {
      // Don't throw error if it was cancelled
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Export cancelled by user');
      }
      
      // Check for content length errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('CONTENT_LENGTH') || 
          errorMessage.includes('CHUNKED_ENCODING') ||
          errorMessage.includes('ERR_CONTENT_LENGTH') ||
          errorMessage.includes('ERR_INCOMPLETE')) {
        throw new Error('Export failed: Server response was incomplete. The backend may have crashed or run out of memory. Please check backend logs and try exporting a smaller subset of data.');
      }
      
      throw new Error(`Database export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Fetch unified model training catalog (all registered backends).
   */
  async getModelsCatalog(): Promise<ApiResponse<{
    backends: Array<{
      id: string;
      display_name: string;
      runtime_profile: string;
      supports_export: boolean;
      supports_pause_resume: boolean;
      variants: Array<{
        id: string;
        display_name: string;
        task: string;
        pretrained_filename?: string | null;
        metadata?: Record<string, unknown>;
      }>;
      request_schema?: Record<string, unknown>;
    }>;
    pretrained_ultralytics: Record<string, { name: string; type: string; classes: number }>;
  }>> {
    return this.request('/models/catalog', { method: 'GET' });
  }

  /**
   * Start training via unified API (dispatches to framework-specific handler).
   */
  async startTraining(request: {
    framework_id: string;
    project_id: number;
    dataset_configs: Array<{
      dataset_id: number;
      annotation_file_id: string;
      image_collection?: string;
      split?: { train: number; val: number; test: number };
    }>;
    task_name?: string;
    params?: Record<string, unknown>;
  }): Promise<ApiResponse<{
    success: boolean;
    task_id: number;
    message: string;
    task?: { id: number; name: string; status: string; progress: number };
    weights_download_expected?: boolean;
    weights_download_notice?: string | null;
  }>> {
    return this.request('/training/start', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * Start YOLO model training
   */
  async startYoloTraining(request: {
    project_id: number;
    dataset_configs: Array<{
      dataset_id: number;
      annotation_file_id: string;
      image_collection?: string;
      split?: {
        train: number;
        val: number;
        test: number;
      };
    }>;
    model_type?: string;
    epochs?: number;
    batch_size?: number;
    image_size?: number;
    device?: string;
    task_name?: string;
    patience?: number;
    optimizer?: string;
    learning_rate?: number;
    momentum?: number;
    weight_decay?: number;
    use_wandb?: boolean;
    wandb_project?: string;
    wandb_entity?: string;
  }): Promise<ApiResponse<{
    success: boolean;
    task_id: number;
    message: string;
    weights_download_expected?: boolean;
    weights_download_notice?: string | null;
    task: {
      id: number;
      name: string;
      status: string;
      progress: number;
    };
  }>> {
    return this.request('/training/yolo/start', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  /**
   * Start RT-DETR model training
   */
  async startRTDETRTraining(request: {
    project_id: number;
    dataset_configs: Array<{
      dataset_id: number;
      annotation_file_id: string;
      image_collection?: string;
      split?: {
        train: number;
        val: number;
        test: number;
      };
    }>;
    model_type?: string;
    epochs?: number;
    batch_size?: number;
    image_size?: number;
    device?: string;
    task_name?: string;
    patience?: number;
    optimizer?: string;
    learning_rate?: number;
    weight_decay?: number;
    use_wandb?: boolean;
    wandb_project?: string;
    wandb_entity?: string;
  }): Promise<ApiResponse<{
    success: boolean;
    task_id: number;
    message: string;
    weights_download_expected?: boolean;
    weights_download_notice?: string | null;
    task: {
      id: number;
      name: string;
      status: string;
      progress: number;
    };
  }>> {
    return this.request('/training/rtdetr', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async startMMYOLOTraining(request: {
    project_id: number;
    dataset_configs: Array<{
      dataset_id: number;
      annotation_file_id: string;
      image_collection?: string;
      split?: { train: number; val: number; test: number };
    }>;
    arch?: string;
    size?: string;
    task?: string;
    epochs?: number;
    batch_size?: number;
    image_size?: number;
    device?: string;
    task_name?: string;
    optimizer?: string;
    learning_rate?: number;
    weight_decay?: number;
    save_period?: number;
    remove_images_without_annotations?: boolean;
    dji_patch_path?: string;
    dji_use_widen_factor_025?: boolean;
    use_wandb?: boolean;
    wandb_project?: string;
    wandb_entity?: string;
  }): Promise<ApiResponse<{
    success: boolean;
    task_id: number;
    message: string;
    task: { id: number; name: string; status: string; progress: number };
  }>> {
    return this.request('/training/mmyolo', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async uploadMMYOLODJIPatch(file: File): Promise<ApiResponse<{
    success: boolean;
    patch_name: string;
    patch_path: string;
    uploaded_at: string;
    message: string;
  }>> {
    const formData = new FormData();
    formData.append('file', file);
    return this.request('/training/mmyolo/dji-patch', {
      method: 'POST',
      body: formData,
    });
  }

  /**
   * Get training task status
   */
  async getTrainingStatus(taskId: number): Promise<ApiResponse<{
    success: boolean;
    task: {
      id: number;
      name: string;
      status: string;
      progress: number;
      created_at?: string;
      started_at?: string;
      completed_at?: string;
      error_message?: string;
      metadata?: any;
    };
  }>> {
    return this.request(`/training/task/${taskId}/status`);
  }

  async exportDatabaseWithFiles(
    onProgress?: (progress: number) => void, 
    projectIds?: number[], 
    datasetIds?: number[],
    abortSignal?: AbortSignal
  ): Promise<void> {
    try {
      // Build URL with query parameters
      const params = new URLSearchParams();
      if (projectIds && projectIds.length > 0) {
        params.append('project_ids', projectIds.join(','));
      }
      if (datasetIds && datasetIds.length > 0) {
        params.append('dataset_ids', datasetIds.join(','));
      }
      
      const queryString = params.toString();
      const url = `${this.config.baseUrl}/database/export-with-files${queryString ? `?${queryString}` : ''}`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/zip',
        },
        signal: abortSignal,
      });

      if (!response.ok) {
        throw new Error(`Export failed: ${response.status} ${response.statusText}`);
      }

      // Track progress while reading the response
      const reader = response.body?.getReader();
      const contentLength = response.headers.get('Content-Length');
      
      if (!reader) {
        throw new Error('Failed to read response');
      }

      let receivedLength = 0;
      const totalLength = contentLength ? parseInt(contentLength, 10) : 0;
      const chunks: Uint8Array[] = [];

      // For smooth progress updates
      let lastProgressUpdate = 0;

      // Show initial progress immediately
      if (onProgress) {
        onProgress(1);
        lastProgressUpdate = 1;
      }

      while (true) {
        // Check if cancelled
        if (abortSignal?.aborted) {
          reader.cancel();
          throw new Error('Export cancelled by user');
        }
        
        const { done, value } = await reader.read();
        
        if (done) break;
        
        chunks.push(value);
        receivedLength += value.length;
        
        if (onProgress && totalLength > 0) {
          const progress = Math.min(95, Math.round((receivedLength / totalLength) * 100));
          // Update whenever progress increases
          if (progress > lastProgressUpdate) {
            onProgress(progress);
            lastProgressUpdate = progress;
          }
        } else if (onProgress && totalLength === 0) {
          // For streaming without content-length, show steady incremental progress
          // Use logarithmic scale: grows fast initially, then slows down
          const streamingProgress = Math.min(90, 10 + Math.floor(Math.log(receivedLength + 1) * 8));
          if (streamingProgress > lastProgressUpdate) {
            onProgress(streamingProgress);
            lastProgressUpdate = streamingProgress;
          }
        }
      }

      // Check if cancelled before processing
      if (abortSignal?.aborted) {
        throw new Error('Export cancelled by user');
      }

      // Processing stage - show progress
      if (onProgress) onProgress(96);

      // Create blob directly from chunks (more efficient than combining into one array)
      const blob = new Blob(chunks as BlobPart[], { type: 'application/zip' });
      
      if (onProgress) onProgress(97);

      // Get filename from response headers or use default
      const contentDisposition = response.headers.get('Content-Disposition');
      const filename = contentDisposition?.match(/filename="?([^"]+)"?/)?.[1] || 
                     `lai_full_backup_${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.zip`;
      
      if (onProgress) onProgress(98);

      // Create download link
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl);
      
      if (onProgress) onProgress(100);
    } catch (error) {
      // Don't throw error if it was cancelled
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Export cancelled by user');
      }
      throw new Error(`Database export with files failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async importDatabase(file: File): Promise<ApiResponse<{
    message: string;
    metadata: any;
    tables_imported: string[];
  }>> {
    const formData = new FormData();
    formData.append('file', file);
    
    return this.request('/database/import', {
      method: 'POST',
      body: formData
    });
  }

  async clearDatabase(): Promise<ApiResponse<{
    message: string;
    deleted_records: Record<string, number>;
    total_records_deleted: number;
    files_removed: number;
    directories_cleared: string[];
    timestamp: string;
  }>> {
    return this.request('/database/clear', {
      method: 'DELETE'
    });
  }

  // Backup methods
  async getBackupSettings(): Promise<ApiResponse<{
    enabled: boolean;
    backup_path: string | null;
    frequency_hours: number;
    retention_days: number;
    last_backup_at: string | null;
    next_backup_at: string | null;
  }>> {
    return this.request('/backup/settings', {
      method: 'GET'
    });
  }

  async updateBackupSettings(settings: {
    enabled: boolean;
    backup_path?: string | null;
    frequency_hours: number;
    retention_days: number;
  }): Promise<ApiResponse<{
    success: boolean;
    message: string;
    settings: any;
  }>> {
    return this.request('/backup/settings', {
      method: 'POST',
      body: JSON.stringify(settings)
    });
  }

  async runBackup(): Promise<ApiResponse<{
    success: boolean;
    message: string;
  }>> {
    return this.request('/backup/run', {
      method: 'POST'
    });
  }

  async listBackups(): Promise<ApiResponse<{
    backups: any[];
    total: number;
  }>> {
    return this.request('/backup/list', {
      method: 'GET'
    });
  }

  async deleteBackup(backupId: number): Promise<ApiResponse<{
    success: boolean;
    message: string;
  }>> {
    return this.request(`/backup/${backupId}`, {
      method: 'DELETE'
    });
  }

  async getGpuStatus(): Promise<ApiResponse<{
    has_gpu: boolean;
    gpu_count: number;
    gpus: Array<{
      name: string;
      memory_used_mb: number;
      memory_total_mb: number;
      utilization_percent: number;
    }>;
    memory_used_mb: number;
    memory_total_mb: number;
  }>> {
    return this.request('/system/gpu', { method: 'GET' });
  }
}

/**
 * Create a configured API client instance
 */
export const createApiClient = (config: ApiConfig): ApiClient => {
  return new ApiClient(config);
};
