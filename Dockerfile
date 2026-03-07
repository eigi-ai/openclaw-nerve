# ---- Build stage ----
FROM --platform=linux/amd64 node:22-alpine AS builder
WORKDIR /app
# Install native build tools for node-pty
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Production stage ----
FROM --platform=linux/amd64 node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Install native build tools for node-pty and runtime deps
RUN apk add --no-cache python3 make g++

# Copy built outputs + production deps
COPY package*.json ./
RUN npm ci --omit=dev && apk del python3 make g++
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server-dist ./server-dist

EXPOSE 3080
ENV PORT=3080 HOST=0.0.0.0
CMD ["node", "server-dist/index.js"]
