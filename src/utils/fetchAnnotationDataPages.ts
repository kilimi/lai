const DEFAULT_PAGE_LIMIT = 1000;

type AnnotationDataResponse = {
  success?: boolean;
  data?: {
    annotations: unknown[];
    pagination?: { pages: number };
  };
};

type FetchAnnotationDataPage = (
  datasetId: string | number,
  annotationFileId: string,
  params?: { imageIds?: string[]; page?: number; limit?: number },
) => Promise<AnnotationDataResponse>;

/** Fetch every page of annotation data, optionally scoped to specific image IDs. */
export async function fetchAllAnnotationDataPages(
  getAnnotationData: FetchAnnotationDataPage,
  datasetId: string | number,
  annotationFileId: string,
  imageIds?: string[],
  limit = DEFAULT_PAGE_LIMIT,
): Promise<unknown[]> {
  const allAnnotations: unknown[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const response = await getAnnotationData(datasetId, annotationFileId, {
      ...(imageIds?.length ? { imageIds } : {}),
      page,
      limit,
    });
    if (!response?.success || !response.data?.annotations) {
      break;
    }
    allAnnotations.push(...response.data.annotations);
    totalPages = response.data.pagination?.pages ?? 1;
    page += 1;
  }

  return allAnnotations;
}
