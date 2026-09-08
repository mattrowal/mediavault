# Production Dockerfile for MediaVault
FROM node:24-alpine AS runner

WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/media_vault.db

# Copy package descriptors
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy application source code
COPY server.js db.js ./
COPY public ./public

# Ensure the persistent database directory exists
RUN mkdir -p /app/data && chown -R node:node /app

# Run as non-root user for security
USER node

# Persistent volume mount point for SQLite database
VOLUME ["/app/data"]

EXPOSE 3000

# Docker Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
