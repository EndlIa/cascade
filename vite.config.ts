import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022' },
  server: {
    port: 5173,
    configureServer (server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== undefined && req.url.startsWith('/data/')) {
          res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
        }
        next();
      });
    },
  },
});
