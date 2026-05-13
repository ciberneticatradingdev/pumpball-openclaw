FROM node:20-slim

WORKDIR /app

# Copy shared types
COPY shared/ ./shared/

# Copy server
COPY server/package.json server/package-lock.json* ./server/
WORKDIR /app/server
RUN npm install

COPY server/ ./

RUN npx tsc

EXPOSE 3001
CMD ["node", "dist/index.js"]
