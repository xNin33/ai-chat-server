# Multi-stage build kept simple since there's only one runtime dependency (express).
FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json ./
RUN npm install --omit=dev

# Copy server code and the frontend file
COPY server.js ./
COPY AI.html ./

ENV NODE_ENV=production
EXPOSE 3000

# Basic container healthcheck against /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/healthz', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
