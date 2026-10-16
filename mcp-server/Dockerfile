FROM node:20-alpine

WORKDIR /app

# Install all deps (including devDeps needed for tsc)
COPY package.json package-lock.json* ./
RUN npm install

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
COPY migrations/ ./migrations/
COPY playbooks/ ./playbooks/

# Prune dev dependencies after build
RUN npm prune --omit=dev

# Default to insecure gRPC — correct for Railway internal networking.
# Override by setting HATCHET_CLIENT_TLS_STRATEGY in the Railway dashboard.
ENV HATCHET_CLIENT_TLS_STRATEGY=none

EXPOSE 3100

CMD ["node", "dist/index.js"]
