# ---- build stage: install workspace deps, build shared + api ----
FROM node:22-bookworm-slim AS build
WORKDIR /repo
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace packages/shared --workspace apps/api --include-workspace-root
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w packages/shared && npm run build -w apps/api && rm -rf apps/api/src apps/api/tsconfig.json apps/api/nest-cli.json

# ---- runtime stage ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo/package.json ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared/package.json packages/shared/package.json
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/apps/api apps/api
COPY apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && chown -R node:node /repo
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
HEALTHCHECK --interval=20s --timeout=5s --start-period=40s --retries=5 CMD curl -fsS http://localhost:4000/health || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
