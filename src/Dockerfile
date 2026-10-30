FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

COPY src ./src

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" >/dev/null 2>&1 || exit 1

CMD ["node", "src/index.js"]
