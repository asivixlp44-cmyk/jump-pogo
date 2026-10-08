# +1 Jump Pogo game server (Colyseus).
# Build from the REPO ROOT so shared/ is included:
#   docker build -f server/Dockerfile -t jump-pogo-server .
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund

COPY shared ./shared
COPY server/src ./server/src

# Legion injects PORT; 2567 is the Colyseus default for local runs
ENV PORT=2567
EXPOSE 2567

WORKDIR /app/server
CMD ["node", "src/index.js"]
