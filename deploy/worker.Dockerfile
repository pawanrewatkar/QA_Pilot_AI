# Playwright worker image (template; nothing is deployed automatically).
# The worker runs crawls, browser tests, Lighthouse and report rendering. It needs the browser
# binaries in this base image and must be a long-running process, not a serverless function.
#
#   docker build -f deploy/worker.Dockerfile -t qa-pilot-worker .
#   docker run --env-file .env.worker -v qa-pilot-data:/app/data qa-pilot-worker
#
# With the local providers the web app and the worker must share the same database and storage
# volume. For a Vercel web app, configure hosted DatabaseProvider and StorageProvider implementations.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=optional
COPY . .

ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/qa-pilot.db \
    STORAGE_PATH=/app/data/storage
VOLUME ["/app/data"]

CMD ["npm", "run", "worker"]
