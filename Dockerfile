# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app

# Install full deps so we can compile TypeScript
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# --- runtime stage ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production deps only — smaller image, smaller attack surface
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY --from=build /app/dist ./dist

# Drop root
RUN addgroup -S app && adduser -S app -G app
USER app

# Default to the API process; override CMD to run the sync worker:
#   docker run ... lifi-indexer node dist/jobs/syncIndexer.js
EXPOSE 3000
CMD ["node", "dist/index.js"]
