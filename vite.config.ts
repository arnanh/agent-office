import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { createBridge } from "./server/bridge.ts";
import { DEFAULT_PORT, resolveDataFile } from "./server/paths.ts";

const PORT = Number(process.env.PORT ?? DEFAULT_PORT);

function officeBridge(): Plugin {
  return {
    name: "agent-office-bridge",
    configureServer(server) {
      const dataFile = resolveDataFile(fileURLToPath(new URL("./data/office.json", import.meta.url)));
      const bridge = createBridge({ dataFile, publicUrl: () => `http://127.0.0.1:${PORT}` });
      server.middlewares.use(bridge.middleware);
      server.httpServer?.on("close", () => bridge.close());
    },
  };
}

export default defineConfig({
  plugins: [officeBridge()],
  server: { port: PORT, strictPort: true, host: "127.0.0.1", open: !process.env.NO_OPEN },
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
  // One copy of three for the app and three-mesh-bvh (the BVH's textures must be the app's three).
  resolve: { dedupe: ["three"] },
  // three-mesh-bvh stays unbundled so its BVH worker (new URL(..., import.meta.url)) resolves.
  optimizeDeps: { include: ["three"], exclude: ["three-mesh-bvh"] },
});
