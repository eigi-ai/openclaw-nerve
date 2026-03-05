# ---- Build stage ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Production stage ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Copy built outputs + production deps
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server-dist ./server-dist

EXPOSE 3080
ENV PORT=3080 HOST=0.0.0.0
CMD ["node", "server-dist/index.js"]
