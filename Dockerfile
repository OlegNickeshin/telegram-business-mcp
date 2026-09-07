# Build and run the collector and the MCP server. whisper.cpp is deliberately
# out of scope here: it needs a compiler toolchain and ~500 MB of model, which
# would triple the image for a feature most deployments leave off.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx tsc

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# poppler-utils is the one thing reading attachments cannot do itself: xlsx and
# docx are ZIP+XML and come free with zlib, but PDF text needs pdftotext. ~15 MB,
# against a PDF otherwise arriving as a link nobody can follow.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY tests ./tests
RUN mkdir -p /data && chown node:node /data
USER node
ENV DB_PATH=/data/telegram.db
VOLUME ["/data"]
EXPOSE 8124
CMD ["node", "dist/mcp-http.js"]
