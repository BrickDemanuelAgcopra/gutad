# ---- build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /repo
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_API_URL=https://api.gutad.io
ARG PUBLIC_WEB_URL=https://gutad.io
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL PUBLIC_WEB_URL=$PUBLIC_WEB_URL
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace packages/shared --workspace apps/web --include-workspace-root
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w packages/shared && npm run build -w apps/web

# ---- runtime stage (Next standalone) ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=5 CMD curl -fsS http://localhost:3000/ >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]
