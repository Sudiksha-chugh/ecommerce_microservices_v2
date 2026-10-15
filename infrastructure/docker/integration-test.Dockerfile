FROM node:24.21.0
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY test ./test
COPY scripts/search-setup-probe.mjs ./scripts/search-setup-probe.mjs
RUN npm ci --ignore-scripts
ENTRYPOINT ["node"]
