FROM node:20-slim

WORKDIR /app

# Copy workspace root + server + shared
COPY package.json package-lock.json* ./
COPY server/ ./server/
COPY shared/ ./shared/

# Install deps at root (workspaces)
RUN npm install --production=false

# Build server
RUN npm run build --workspace=server

EXPOSE 3001

CMD ["node", "server/dist/index.js"]
