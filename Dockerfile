# Debian, not Alpine. The loader's native helper (node-addon-require-builtin)
# publishes linux-x64-gnu and linux-arm64-gnu prebuilts and no musl build, so on
# Alpine it falls back to a source build that published installs refuse.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    NOTIFIER_DB=/app/data/notifier.db

WORKDIR /app
RUN corepack enable

# Dependencies first, so a source edit does not reinstall them.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Node 24 strips the types itself, so the sources ship as they are.
COPY cordis.yml ./
COPY src ./src

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/main.ts"]
