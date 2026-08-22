FROM node:22-alpine AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/relay/package.json ./services/relay/package.json
COPY tools/kd/package.json ./tools/kd/package.json
COPY services/relay/tsconfig.json ./services/relay/tsconfig.json
COPY services/relay/src/ ./services/relay/src/

RUN pnpm install --frozen-lockfile --filter kanna-relay...
RUN pnpm --dir services/relay build
RUN pnpm --config.allowUnusedPatches=true --filter kanna-relay deploy --prod --legacy /relay

FROM node:22-alpine

# Source commit the image was built from; reported by GET /health.
ARG KANNA_RELAY_COMMIT=unknown
ENV KANNA_RELAY_COMMIT=$KANNA_RELAY_COMMIT

WORKDIR /app

COPY --from=build /relay ./

USER node

EXPOSE 8080

CMD ["node", "dist/index.js"]
