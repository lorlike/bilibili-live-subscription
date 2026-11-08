# syntax=docker/dockerfile:1

# ---------- 依赖层 ----------
# 代码由 tsx 直接跑 TS/JSX，没有构建产物，所以依赖装好就能运行
FROM node:24-alpine AS deps
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@12.18.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# ---------- 运行层 ----------
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV WEB_HOST=0.0.0.0
ENV WEB_PORT=3000
ENV DB_PATH=/app/data/live.db

# tini 负责转发信号，保证 SIGTERM 能到 node（优雅关闭要关 SQLite）
RUN apk add --no-cache tini

# 非 root 运行
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs bls

# tsx 需要能执行 node_modules/.bin 下的命令
COPY --from=deps --chown=bls:nodejs /app/node_modules ./node_modules
COPY --chown=bls:nodejs package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY --chown=bls:nodejs src ./src
COPY --chown=bls:nodejs web ./web

# 数据库目录；实际部署建议挂卷覆盖
RUN mkdir -p /app/data && chown bls:nodejs /app/data

USER bls
EXPOSE 3000

# 健康检查用 Node 自带 fetch，不额外装 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
# tsx 的 bin 是 sh shim，直接执行（它有 shebang），不能交给 node 跑
CMD ["node_modules/.bin/tsx", "src/cli.ts", "start"]
