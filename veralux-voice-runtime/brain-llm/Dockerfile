FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
RUN addgroup -g 1001 -S veralux && adduser -S veralux -u 1001 -G veralux
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist dist/
USER veralux
EXPOSE 3001
CMD ["node", "dist/index.js"]
