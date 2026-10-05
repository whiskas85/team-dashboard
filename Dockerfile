FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DB_FILE=/data/console.db
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY agent ./agent
COPY scripts ./scripts
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
