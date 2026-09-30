# ---- build ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:24-alpine
ENV NODE_ENV=production
# OCR: გარე ლაბორატორიის სკანირებული პასუხები (ქართული + ლათინური); ქართული ენის პაკეტის გარეშეც აეწყობა (მხოლოდ ლათინური)
RUN apk add --no-cache poppler-utils qpdf tesseract-ocr \
 && (apk add --no-cache tesseract-ocr-data-kat || echo "tesseract: ქართული ენის პაკეტი ვერ დაყენდა") \
 && (apk add --no-cache tesseract-ocr-data-eng 2>/dev/null || true)
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node assets ./assets
USER node
EXPOSE 3000
# API:       node dist/main.js   (default)
# Worker:    node dist/worker.js
# Migration: node dist/migrate.js
CMD ["node", "dist/main.js"]
