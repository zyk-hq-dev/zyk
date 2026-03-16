FROM node:20-alpine

WORKDIR /app

# Install all deps (including devDeps needed for tsc)
COPY package.json package-lock.json* ./
RUN npm install

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune dev dependencies after build
RUN npm prune --omit=dev

# Create workflows directory
RUN mkdir -p /app/workflows

# Default to insecure gRPC — correct for Railway internal networking.
# Override by setting HATCHET_CLIENT_TLS_STRATEGY in the Railway dashboard.
ENV HATCHET_CLIENT_TLS_STRATEGY=none

EXPOSE 3100

CMD ["node", "dist/index.js"]
