# Multi-stage build for DataFoundry
FROM node:24-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++ git unixodbc-dev

WORKDIR /app

# Downgrade npm to match local environment
RUN npm install -g npm@11.13.0 --registry=https://registry.npmmirror.com

# Copy all source code (needed for npm workspaces to resolve local packages)
COPY . .

# Install dependencies
# Build ODBC locally; its GitHub release downloads can time out in China.
RUN npm_config_build_from_source=odbc npm_config_nodedir=/usr/local npm install --legacy-peer-deps

# Build the project
RUN npm run build -- --force && npm run build:web

# Production stage
FROM node:24-alpine

# Install runtime dependencies
RUN apk add --no-cache python3 py3-pip curl unixodbc

# Install npm 11.13.0 to match build stage
RUN npm install -g npm@11.13.0 --registry=https://registry.npmmirror.com

WORKDIR /app

# Copy built artifacts and dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/tsconfig*.json ./
COPY --from=builder /app/.env.example ./.env.example

# Create storage directory
RUN mkdir -p /app/storage/metadata /app/storage/bigscreen

# Expose ports
EXPOSE 8787 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:8787/healthz || exit 1

# Start command
CMD ["npm", "run", "start"]
