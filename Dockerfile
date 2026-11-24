# Belanja backend image
# Build context is app/ (so migrations live at backend/migrations).
FROM node:20-alpine

WORKDIR /app/backend

# Install production dependencies first for better layer caching.
COPY backend/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy application source (node_modules excluded via .dockerignore).
COPY backend/ ./

ENV NODE_ENV=production \
    PORT=4000

EXPOSE 4000

# Run as non-root. Migrations are run by server.js at startup (in-DB only).
USER node
CMD ["node", "server.js"]