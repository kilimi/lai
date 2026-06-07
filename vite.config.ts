import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from 'fs';
import { isSpaProjectRoute } from "./deploy/spa-project-routes.mjs";

/** First path segment(s) proxied to the FastAPI backend in dev (see deploy/api-proxy-prefixes.json). */
const API_PROXY_PREFIXES: string[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, "deploy/api-proxy-prefixes.json"), "utf8"),
);
const BACKEND_PROXY_TARGET =
  process.env.VITE_BACKEND_PROXY_TARGET || "http://127.0.0.1:9999";
const devApiProxy = Object.fromEntries(
  API_PROXY_PREFIXES.map((segment) => [
    `/${segment}`,
    {
      target: BACKEND_PROXY_TARGET,
      changeOrigin: true,
      bypass: (req: { url?: string }) => {
        if (segment === "projects" && isSpaProjectRoute(req.url || "")) {
          return req.url;
        }
      },
    },
  ]),
);

// Serve onnxruntime-web WASM and .mjs/.js from node_modules so workers can load them
const ONNX_DIST = path.join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist');
const wasmPlugin = () => ({
  name: 'wasm-mime-type',
  configureServer(server: any) {
    server.middlewares.use((req: any, res: any, next: any) => {
      const urlPath = req.url?.split('?')[0] || '';
      if (!urlPath.startsWith('/wasm/')) {
        next();
        return;
      }
      const name = path.basename(urlPath);
      const filePath = path.join(ONNX_DIST, name);
      if (!fs.existsSync(filePath)) {
        next();
        return;
      }
      try {
        const ext = path.extname(name).toLowerCase();
        const mime = ext === '.wasm' ? 'application/wasm' : 'application/javascript';
        const body = fs.readFileSync(filePath);
        res.statusCode = 200;
        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Length', String(body.length));
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.end(body);
        return;
      } catch (e) {
        next();
      }
    });
  },
  buildStart() {},
});

// https://vitejs.dev/config/
export default defineConfig(async ({ mode }) => {
  const { componentTagger } = await import("lovable-tagger");
  
  return {
    server: {
      host: "::",
      port: 8080,
      proxy: devApiProxy,
      fs: {
        // Allow serving files from one level up to the project root
        allow: ['..'],
      },
      // Configure MIME types for WASM files
      mimeTypes: {
        'application/wasm': ['wasm'],
      },
    },
    // Configure public directory for static assets
    publicDir: 'public',
    plugins: [
      react(),
      wasmPlugin(),
      mode === 'development' &&
      componentTagger(),
    ].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
      // Avoid duplicate React; splitting @radix-ui into its own chunk caused runtime
      // "Cannot read properties of undefined (reading 'forwardRef')" in production builds.
      dedupe: ["react", "react-dom"],
    },
    build: {
      chunkSizeWarningLimit: 1700,
      rollupOptions: {
        output: {
          manualChunks: (id: string) => {
            if (id.includes("node_modules/onnxruntime-web")) return "onnx";
            // recharts + d3 are intentionally NOT assigned to a named chunk here.
            // Forcing them into one chunk causes a Rollup TDZ (temporal dead zone)
            // error ("Cannot access 'X' before initialization") because recharts/d3
            // has circular imports that Rollup serialises in the wrong order when
            // collected under a manual chunk name. Vite's automatic code-splitting
            // handles them correctly; TrainingMetricsCharts is already lazy-loaded
            // so recharts is still deferred from the initial bundle.
            if (id.includes("node_modules/recharts") || id.includes("node_modules/d3-")) return undefined;
            // One vendor chunk for all other node_modules (incl. react + @radix-ui).
            // Splitting react vs radix caused production "Cannot read properties of undefined
            // (reading 'forwardRef')" when chunk evaluation order left Radix without React.
            // jszip is only dynamically imported (await import('jszip')); do NOT assign it to
            // a named chunk here — doing so causes Vite to emit a <link rel="modulepreload">
            // for it in index.html, eagerly downloading it on every page load.
            if (id.includes("node_modules/")) return "vendor";
          },
          // Ensure WASM files are treated as assets
          assetFileNames: (assetInfo: any) => {
            if (assetInfo.name?.endsWith('.wasm')) {
              return 'wasm/[name][extname]';
            }
            return 'assets/[name]-[hash][extname]';
          },
        },
      },
      // Strip console.log / debugger calls from production bundles
      minify: 'esbuild' as const,
      esbuildOptions: {
        drop: mode === 'production' ? (['console', 'debugger'] as ('console' | 'debugger')[]) : [],
      },
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: "./src/test/setup.ts",
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      exclude: ["tests/**", "node_modules/**", "dist/**"],
      silent: true,
    },
  };
});
