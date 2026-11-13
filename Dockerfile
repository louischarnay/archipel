# Host image. App code does not run here: it goes into containers started by the server's engine.
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS manifests
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/manifest-schema/package.json packages/manifest-schema/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/cli/package.json packages/cli/

FROM manifests AS dependencies
RUN npm ci --omit=dev --workspace=@archipel/server

FROM manifests AS build
RUN npm ci
COPY tsconfig.json tsconfig.base.json ./
COPY packages ./packages
RUN npm run build

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94
RUN apk add --no-cache docker-cli git
RUN install -d -o node -g node /var/lib/archipel
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/packages/manifest-schema/package.json ./packages/manifest-schema/
COPY --from=build /app/packages/manifest-schema/dist ./packages/manifest-schema/dist
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/runner ./packages/server/runner
# Interface built by Vite: static files only, React is bundled in.
COPY --from=build /app/packages/web/dist ./packages/web/dist
# Claude Code skill served at /agent/skill.tar.gz: instructions and the CLI as a single file.
COPY --from=build /app/packages/cli/dist/skill ./packages/cli/dist/skill

ENV NODE_ENV=production HOST=0.0.0.0 ARCHIPEL_DATA_DIR=/var/lib/archipel DOCKER_CONFIG=/tmp/docker
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "packages/server/dist/main.js"]
