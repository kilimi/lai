/**
 * Demo Backend
 * ------------
 * A client-side mock that intercepts window.fetch() and serves canned
 * responses for the FastAPI endpoints used by the frontend. This lets the
 * app run inside the Lovable preview without a real backend or database.
 *
 * Activated automatically when:
 *   - VITE_DEMO_MODE === 'true', OR
 *   - localStorage.getItem('demoMode') === 'true', OR
 *   - the configured API base URL is unreachable (auto-fallback).
 *
 * Toggle manually from the browser console:
 *   localStorage.setItem('demoMode', 'true'); location.reload();
 *   localStorage.removeItem('demoMode');     location.reload();
 */

import { getApiBaseUrl } from "@/config/api";

type JsonHandler = (
  url: URL,
  init: RequestInit,
  match: RegExpMatchArray
) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: JsonHandler;
}

// ---------- in-memory store ----------
const now = () => new Date().toISOString();

// Image generator using picsum.photos (deterministic seeds)
function makeImage(
  id: number,
  datasetId: number,
  seed: string,
  fileName: string,
  width = 1024,
  height = 768,
) {
  return {
    id,
    datasetId,
    fileName,
    fileSize: 240_000 + ((id * 7919) % 180_000),
    width,
    height,
    url: `https://picsum.photos/seed/${seed}/${width}/${height}`,
    thumbnailUrl: `https://picsum.photos/seed/${seed}/320/240`,
    uploadedAt: now(),
    annotationsCount: 0,
    groupId: `grp-${seed}`,
  };
}

let imgIdCounter = 1000;
function buildCollection(
  datasetId: number,
  collectionId: number,
  name: string,
  position: number,
  seedPrefix: string,
  count: number,
  isDefault = false,
  /** Optional shared filename prefix so companion collections match the primary by filename. */
  fileNamePrefix?: string,
) {
  const namePrefix = fileNamePrefix ?? seedPrefix;
  const images = Array.from({ length: count }, (_, i) => {
    const id = imgIdCounter++;
    return makeImage(
      id,
      datasetId,
      `${seedPrefix}-${i + 1}`,
      `${namePrefix}_${String(i + 1).padStart(3, "0")}.jpg`,
    );
  });
  return {
    id: collectionId,
    dataset_id: datasetId,
    name,
    description: `${name} collection`,
    is_default: isDefault,
    position,
    created_at: now(),
    updated_at: now(),
    image_count: images.length,
    images,
  };
}

const datasetCollections: Record<number, any[]> = {
  1: [
    buildCollection(1, 101, "RGB Images", 0, "city", 12, true),
    // Thermal companion shares filenames with RGB ("city_001.jpg" ...)
    buildCollection(1, 102, "Thermal", 1, "thermal", 12, false, "city"),
  ],
  2: [buildCollection(2, 201, "RGB Images", 0, "street", 18, true)],
  3: [
    buildCollection(3, 301, "RGB Images", 0, "bird", 20, true),
    // Infrared companion shares filenames with RGB ("bird_001.jpg" ...)
    buildCollection(3, 302, "Infrared", 1, "ir-bird", 20, false, "bird"),
  ],
  4: [buildCollection(4, 401, "RGB Images", 0, "forest", 16, true)],
  5: [buildCollection(5, 501, "RGB Images", 0, "ocean", 14, true)],
  6: [buildCollection(6, 601, "RGB Images", 0, "satellite", 24, true)],
};

interface DemoAnnotationFile {
  id: string;
  name: string;
  type: string;
  image_count: number;
  annotation_count: number;
  classes: Array<{ id: number; name: string; count: number; color: string }>;
  created_at: string;
  tags: string[];
}

const palette = ["#4F46E5", "#10B981", "#F59E0B", "#EF4444", "#06B6D4", "#8B5CF6", "#EC4899"];

function makeClasses(names: string[], baseCount: number): DemoAnnotationFile["classes"] {
  return names.map((name, i) => ({
    id: i + 1,
    name,
    count: Math.round(baseCount * (0.6 + ((i * 37) % 100) / 100)),
    color: palette[i % palette.length],
  }));
}

const datasetAnnotationFiles: Record<number, DemoAnnotationFile[]> = {
  1: [
    {
      id: "af-1-detect",
      name: "city_detections_v2.json",
      type: "Segmentation (bbox)",
      image_count: 12,
      annotation_count: 184,
      classes: makeClasses(["car", "person", "bicycle", "traffic_light"], 46),
      created_at: now(),
      tags: ["detection", "v2"],
    },
    {
      id: "af-1-seg",
      name: "city_instances.json",
      type: "Segmentation (mask+bbox)",
      image_count: 9,
      annotation_count: 132,
      classes: makeClasses(["car", "person", "road", "sidewalk", "building"], 28),
      created_at: now(),
      tags: ["instance-seg"],
    },
  ],
  2: [
    {
      id: "af-2-pedestrian",
      name: "pedestrian_bboxes.json",
      type: "Segmentation (bbox)",
      image_count: 18,
      annotation_count: 211,
      classes: makeClasses(["pedestrian", "child", "wheelchair"], 70),
      created_at: now(),
      tags: ["pedestrian"],
    },
  ],
  3: [
    {
      id: "af-3-birds",
      name: "birds_rgb_v1.json",
      type: "Segmentation (mask+bbox)",
      image_count: 20,
      annotation_count: 96,
      classes: makeClasses(["sparrow", "robin", "eagle", "owl"], 24),
      created_at: now(),
      tags: ["birds"],
    },
    {
      id: "af-3-birds-ir",
      name: "birds_ir_v1.json",
      type: "Segmentation (bbox)",
      image_count: 20,
      annotation_count: 88,
      classes: makeClasses(["bird"], 88),
      created_at: now(),
      tags: ["infrared"],
    },
  ],
  4: [
    {
      id: "af-4-trap",
      name: "camera_trap_classification.json",
      type: "Classification",
      image_count: 16,
      annotation_count: 16,
      classes: makeClasses(["deer", "fox", "boar", "empty"], 4),
      created_at: now(),
      tags: ["classification"],
    },
  ],
  6: [
    {
      id: "af-6-landuse",
      name: "landuse_segmentation.json",
      type: "Segmentation (mask)",
      image_count: 24,
      annotation_count: 312,
      classes: makeClasses(["forest", "urban", "water", "farmland", "barren"], 62),
      created_at: now(),
      tags: ["land-use"],
    },
  ],
};

function annotationFilesFor(datasetId: number): DemoAnnotationFile[] {
  return datasetAnnotationFiles[datasetId] || [];
}

function imagesFor(datasetId: number) {
  const cols = datasetCollections[datasetId] || [];
  return cols.flatMap((c) => c.images);
}

function datasetWithPreview(dataset: any) {
  const firstImage = imagesFor(dataset.id)[0];
  const files = annotationFilesFor(dataset.id);
  return {
    ...dataset,
    thumbnailUrl: firstImage?.thumbnailUrl,
    logo_url: firstImage?.thumbnailUrl,
    annotation_file_count: files.length,
    annotation_count: files.reduce((s, f) => s + f.annotation_count, 0),
  };
}

function projectById(projectId: number) {
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) return null;
  const datasets = store.datasets
    .filter((d) => d.project_id === projectId)
    .map(datasetWithPreview);
  return {
    ...project,
    datasets,
    dataset_count: datasets.length,
    dataset_groups: project.dataset_groups || [],
  };
}

const store = {
  nextProjectId: 4,
  nextDatasetId: 7,
  projects: [
    {
      id: 1,
      name: "Urban Scene Analysis",
      description: "City and street imagery for object detection demos.",
      created_at: now(),
      updated_at: now(),
      is_project: true,
      tags: ["demo", "urban"],
      datasets: [] as any[],
      dataset_groups: [] as any[],
    },
    {
      id: 2,
      name: "Wildlife Detection",
      description: "Bird and forest imagery for wildlife classification.",
      created_at: now(),
      updated_at: now(),
      is_project: true,
      tags: ["wildlife", "nature"],
      datasets: [] as any[],
      dataset_groups: [] as any[],
    },
    {
      id: 3,
      name: "Aerial Imagery",
      description: "Satellite and aerial photographs.",
      created_at: now(),
      updated_at: now(),
      is_project: true,
      tags: ["aerial", "satellite"],
      datasets: [] as any[],
      dataset_groups: [] as any[],
    },
  ] as any[],
  datasets: [
    {
      id: 1,
      name: "City Streets",
      description: "RGB + thermal pairs of city streets.",
      tags: ["rgb", "thermal"],
      created_at: now(),
      updated_at: now(),
      image_count: imagesFor(1).length,
      annotation_count: 0,
      annotation_file_count: 0,
      annotation_files: [],
      project_id: 1,
    },
    {
      id: 2,
      name: "Pedestrian Crossings",
      description: "Pedestrian detection training set.",
      tags: ["pedestrian"],
      created_at: now(),
      updated_at: now(),
      image_count: imagesFor(2).length,
      annotation_count: 0,
      annotation_file_count: 0,
      annotation_files: [],
      project_id: 1,
    },
    {
      id: 3,
      name: "Birds (RGB + IR)",
      description: "Birds captured with paired RGB and infrared cameras.",
      tags: ["birds", "multispectral"],
      created_at: now(),
      updated_at: now(),
      image_count: imagesFor(3).length,
      annotation_count: 0,
      annotation_file_count: 0,
      annotation_files: [],
      project_id: 2,
    },
    {
      id: 4,
      name: "Forest Wildlife",
      description: "Camera trap photos from forest reserves.",
      tags: ["forest", "camera-trap"],
      created_at: now(),
      updated_at: now(),
      image_count: imagesFor(4).length,
      annotation_count: 0,
      annotation_file_count: 0,
      annotation_files: [],
      project_id: 2,
    },
    {
      id: 5,
      name: "Marine Life",
      description: "Underwater and ocean imagery.",
      tags: ["ocean"],
      created_at: now(),
      updated_at: now(),
      image_count: imagesFor(5).length,
      annotation_count: 0,
      annotation_file_count: 0,
      annotation_files: [],
      project_id: 2,
    },
    {
      id: 6,
      name: "Satellite Tiles",
      description: "Satellite tiles for land-use classification.",
      tags: ["satellite"],
      created_at: now(),
      updated_at: now(),
      image_count: imagesFor(6).length,
      annotation_count: 0,
      annotation_file_count: 0,
      annotation_files: [],
      project_id: 3,
    },
  ] as any[],
};

// link datasets into projects
for (const p of store.projects) {
  p.datasets = store.datasets.filter((d) => d.project_id === p.id);
}

// ---------- routes ----------
const routes: Route[] = [
  // Health
  {
    method: "GET",
    pattern: /^\/health-check\/?$/,
    handler: () => ({ status: "ok", demo: true }),
  },

  // Tasks (popover polls these)
  {
    method: "GET",
    pattern: /^\/tasks\/active/,
    handler: () => [],
  },
  {
    method: "GET",
    pattern: /^\/tasks\/?($|\?)/,
    handler: () => [],
  },

  // System / GPU
  {
    method: "GET",
    pattern: /^\/system\/gpu/,
    handler: () => ({ available: false, devices: [], demo: true }),
  },

  // Projects list
  {
    method: "GET",
    pattern: /^\/projects\/?($|\?)/,
    handler: () => store.projects.map((project) => projectById(project.id)),
  },
  // Project datasets page endpoints
  {
    method: "GET",
    pattern: /^\/projects\/(\d+)\/datasets\/list/,
    handler: (_u, _i, m) => ({
      success: true,
      data: store.datasets
        .filter((d) => d.project_id === Number(m[1]))
        .map(datasetWithPreview),
    }),
  },
  {
    method: "GET",
    pattern: /^\/projects\/(\d+)\/dataset-groups\/?($|\?)/,
    handler: (_u, _i, m) => ({
      success: true,
      data: (projectById(Number(m[1]))?.dataset_groups || []),
    }),
  },
  {
    method: "GET",
    pattern: /^\/projects\/(\d+)\/summary\/?($|\?)/,
    handler: (_u, _i, m) => projectById(Number(m[1])),
  },
  {
    method: "GET",
    pattern: /^\/projects\/(\d+)\/sidebar-counts\/?($|\?)/,
    handler: () => ({ models: 2, evaluations: 1, exports: 0, pipelines: 0 }),
  },
  // Project by id
  {
    method: "GET",
    pattern: /^\/projects\/(\d+)\/?($|\?)/,
    handler: (_u, _i, m) => projectById(Number(m[1])),
  },
  // Create project
  {
    method: "POST",
    pattern: /^\/projects\/?$/,
    handler: async (_u, init) => {
      const body = await readBody(init);
      const project = {
        id: store.nextProjectId++,
        name: body.name || "New Project",
        description: body.description || "",
        created_at: now(),
        updated_at: now(),
        is_project: true,
        tags: parseTags(body.tags),
        datasets: [],
        dataset_groups: [],
      };
      store.projects.push(project);
      return project;
    },
  },

  // Datasets list
  {
    method: "GET",
    pattern: /^\/datasets\/?($|\?)/,
    handler: () => store.datasets.map(datasetWithPreview),
  },
  // Dataset by id
  {
    method: "GET",
    pattern: /^\/datasets\/(\d+)\/?($|\?)/,
    handler: (_u, _i, m) => {
      const id = Number(m[1]);
      const dataset = store.datasets.find((d) => d.id === id);
      return dataset ? datasetWithPreview(dataset) : null;
    },
  },
  // Dataset images / collections / annotations
  {
    method: "GET",
    pattern: /^\/datasets\/(\d+)\/images/,
    handler: (_u, _i, m) => imagesFor(Number(m[1])),
  },
  {
    method: "GET",
    pattern: /^\/datasets\/(\d+)\/image-collections\/?($|\?)/,
    handler: (_u, _i, m) => datasetCollections[Number(m[1])] || [],
  },
  {
    method: "GET",
    pattern: /^\/datasets\/(\d+)\/annotations\/([^/]+)\/classes/,
    handler: (_u, _i, m) => {
      const file = annotationFilesFor(Number(m[1])).find((f) => f.id === m[2]);
      const classes = (file?.classes || []).map((c) => ({
        className: c.name,
        count: c.count,
        color: c.color,
        opacity: 0.35,
        categoryId: c.id,
      }));
      return {
        success: true,
        data: {
          classes,
          totalClasses: classes.length,
          totalAnnotations: classes.reduce((s, c) => s + c.count, 0),
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/datasets\/(\d+)\/annotations\/([^/]+)\/data/,
    handler: () => ({
      success: true,
      data: { annotations: [], pagination: { page: 1, limit: 0, total: 0, pages: 0 } },
    }),
  },
  {
    method: "GET",
    pattern: /^\/datasets\/(\d+)\/annotations\/summary/,
    handler: (_u, _i, m) => {
      const files = annotationFilesFor(Number(m[1]));
      return {
        success: true,
        data: {
          dataset_id: Number(m[1]),
          file_count: files.length,
          total_annotations: files.reduce((s, f) => s + f.annotation_count, 0),
          files: files.map((f) => ({
            id: f.id,
            name: f.name,
            stored_count: f.annotation_count,
            actual_count: f.annotation_count,
            image_count: f.image_count,
            processing_status: "completed",
          })),
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/datasets\/(\d+)\/annotations\/?($|\?)/,
    handler: (_u, _i, m) => ({
      success: true,
      data: annotationFilesFor(Number(m[1])).map((f) => ({
        id: f.id,
        name: f.name,
        format: "COCO",
        type: f.type,
        image_count: f.image_count,
        annotation_count: f.annotation_count,
        category_count: f.classes.length,
        processing_status: "completed",
        created_at: f.created_at,
        updated_at: f.created_at,
        tags: f.tags,
      })),
    }),
  },
  {
    method: "GET",
    pattern: /^\/datasets\/\d+\/annotations/,
    handler: () => [],
  },
  // Create dataset
  {
    method: "POST",
    pattern: /^\/datasets\/?$/,
    handler: async (_u, init) => {
      const body = await readBody(init);
      const ds = {
        id: store.nextDatasetId++,
        name: body.name || "New Dataset",
        description: body.description || "",
        tags: parseTags(body.tags),
        created_at: now(),
        updated_at: now(),
        image_count: 0,
        annotation_count: 0,
        annotation_file_count: 0,
        annotation_files: [],
        project_id: Number(body.project_id) || 1,
      };
      store.datasets.push(ds);
      const proj = store.projects.find((p) => p.id === ds.project_id);
      if (proj) proj.datasets.push(ds);
      return ds;
    },
  },
];

// ---------- helpers ----------
function parseTags(raw: any): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return typeof raw === "string" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  }
}

async function readBody(init: RequestInit): Promise<Record<string, any>> {
  const body = init.body;
  if (!body) return {};
  if (body instanceof FormData) {
    const obj: Record<string, any> = {};
    body.forEach((v, k) => (obj[k] = v));
    return obj;
  }
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return {};
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------- installer ----------
let installed = false;

export function installDemoBackend(): void {
  if (installed) return;
  installed = true;

  const baseUrl = getApiBaseUrl().replace(/\/$/, "");
  const originalFetch = window.fetch.bind(window);

  // eslint-disable-next-line no-console
  console.info(
    `%c[demo backend] active — intercepting requests to ${baseUrl}`,
    "color:#7c3aed;font-weight:bold;"
  );

  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

    if (!rawUrl.startsWith(baseUrl)) {
      return originalFetch(input as any, init);
    }

    const url = new URL(rawUrl);
    const path = url.pathname + url.search;
    const method = (init.method || "GET").toUpperCase();

    for (const route of routes) {
      if (route.method !== method) continue;
      const m = path.match(route.pattern);
      if (m) {
        try {
          const data = await route.handler(url, init, m);
          return jsonResponse(data);
        } catch (err) {
          return jsonResponse(
            { error: err instanceof Error ? err.message : String(err) },
            500
          );
        }
      }
    }

    // Unmatched: return empty success so the UI doesn't error out
    console.warn(`[demo backend] unhandled ${method} ${path} — returning empty response`);
    return jsonResponse(method === "GET" ? [] : { ok: true, demo: true });
  };
}

export function shouldEnableDemoMode(): boolean {
  try {
    if (import.meta.env.VITE_DEMO_MODE === "true") return true;
    if (typeof localStorage !== "undefined" && localStorage.getItem("demoMode") === "true") {
      return true;
    }
  } catch {
    /* ignore */
  }
  // Default ON when running anywhere except localhost (covers Lovable preview/sandbox/published).
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    if (!isLocal) return true;
  }
  return false;
}
