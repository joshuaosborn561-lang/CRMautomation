FROM node:20-slim AS builder
WORKDIR /app

COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/webhook-server/package.json ./packages/webhook-server/

RUN npm install --workspace=packages/webhook-server --workspace=packages/shared

COPY packages/shared/ ./packages/shared/
COPY packages/webhook-server/ ./packages/webhook-server/

WORKDIR /app/packages/webhook-server
RUN npm run build

FROM node:20-slim
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/packages/webhook-server/dist ./packages/webhook-server/dist
COPY --from=builder /app/packages/webhook-server/package.json ./packages/webhook-server/
COPY --from=builder /app/package.json ./

EXPOSE 3000
CMD ["node", "packages/webhook-server/dist/index.js"]
