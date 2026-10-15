FROM node:24
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci --ignore-scripts
WORKDIR /app/apps/notification-service
CMD ["node", "--import", "tsx", "src/server.ts"]
