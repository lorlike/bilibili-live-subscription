# bilibili-live-subscription

监听 B 站直播间开播，把开播时间连同房间号、房间名持久化到 SQLite，并提供一个
终端风格的 Web 界面查看记录。

## 工作原理

1. `rooms.toml` 维护「房间号 + 房间名」清单（人工维护，是房间名的唯一事实来源）。
2. 每个房间用 `tiny-bilibili-ws` 的 `KeepLiveWS` 维持长连接，内置心跳与断线重连。
3. 收到 `LIVE` 事件后取出 `live_time`（开播时间）与 `live_key`（场次标识）。
4. 写入 SQLite 表 `live_records`，同房间 + 同 `live_key` 视为重复事件自动忽略
   （重连后 B 站会重放 `LIVE` 帧）。

监听与 Web 界面在**同一个进程**里：`node:http` 同时提供静态页面、API 和 SSE 推送。

## 快速开始

```bash
pnpm install
cp .env.example .env      # 至少填 BILIBILI_COOKIE
pnpm dev                  # http://127.0.0.1:3000
```

**不需要构建步骤** —— 页面由服务端直接渲染成 HTML，没有打包。

首次启动会自动创建 `admin` 账号并把随机密码打印到日志里，登录后请立即修改。

**监听不需要单独启动** —— `pnpm dev` 一个进程就够了。房间的增删改在 Web 界面操作，
监听会在 1 秒内自动跟上（同进程直接触发 `sync()`）。

## 命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动完整服务（Web + 监听） |
| `pnpm start` | 同上，生产模式（`NODE_ENV=production`） |
| `pnpm web` / `pnpm listen` | 只跑其中一方（配合 `WEB_ONLY=1`） |
| `pnpm user:add <用户名> <密码>` | 创建用户 |
| `pnpm user:list` | 列出用户 |
| `pnpm list [n]` | 在终端查看最近 n 条开播记录 |
| `pnpm today` | 在终端查看今天的开播记录 |
| `pnpm info [房间号...]` | 查询直播间标题与主播名 |
| `pnpm rooms` | 列出数据库里的房间 |
| `pnpm typecheck` | 类型检查 |
| `pnpm test` | 运行单元测试 |

## Web 界面

**服务端渲染（SSR）**，没有 index.html、没有 SPA 打包、没有客户端 JS。

页面由 `hono/jsx` 在服务端拼成完整 HTML 直接返回，所有交互都是普通表单
提交 + 303 重定向。唯一的静态资源是 `src/public/style.css`。

- **记录页** `/records`：默认当天，**从上到下由新到旧**。每行末尾显示距今时长，
  `<details>` 实现展开详情（开播/检测时间、场次 key、推送延迟、主播、当场标题），
  不依赖 JS
- **房间页** `/rooms`：增删改查、启停监听。改动后监听会自动跟上（同进程 1 秒内）
- **用户页** `/users`：新建用户、修改自己的密码
- 分页、日期切换都是普通链接和 GET 表单，刷新即可
- 删除操作带确认后的 POST，服务端处理完 303 回到原页面

### 为什么是 SSR 而不是 SPA

| | SPA（旧） | SSR（现在） |
| --- | --- | --- |
| 构建步骤 | 需要 esbuild | 无 |
| 前端 JS | 41 KB | 0 |
| 首屏 | 空 HTML + JS 渲染 | 直接可读的 HTML |
| 交互 | 无刷新 | 整页跳转 |

开播记录是「查多改少」的界面，整页刷新完全够用；换来的是零构建、零前端依赖。

### 路由一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/login` | 登录页 |
| POST | `/login` | 校验后 303 到 `/records`；失败返回 401 并重渲染 |
| POST | `/logout` | 清 cookie，303 到 `/login` |
| GET | `/records?date=&offset=` | 记录列表（分页） |
| POST | `/records/:id/delete` | 删除单条 |
| GET | `/rooms` | 房间列表 |
| POST | `/rooms` | 新增房间 |
| POST | `/rooms/:id/update` | 改名 / 改备注 |
| POST | `/rooms/:id/toggle` | 启停监听 |
| POST | `/rooms/:id/delete` | 删除房间 |
| GET | `/users` | 用户列表 |
| POST | `/users` | 新建用户 |
| POST | `/users/password` | 修改自己的密码 |

## 数据库结构

文件路径由 `DB_PATH` 决定，默认 `data/live.db`（WAL 模式）。

```sql
CREATE TABLE live_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id     INTEGER NOT NULL,   -- 直播间号
  room_name   TEXT    NOT NULL,   -- 房间名（来自清单）
  live_time   INTEGER NOT NULL,   -- 开播时间，Unix 秒（B 站 live_time）
  detected_at INTEGER NOT NULL,   -- 本地收到事件的时间，Unix 毫秒
  live_key    TEXT,               -- 场次标识，用于去重
  title       TEXT,               -- 当场标题（事后补全，可能为空）
  anchor_name TEXT,               -- 主播名（事后补全，可能为空）
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
```

去重规则：

- 有 `live_key`：`(room_id, live_key)` 唯一索引去重
- 无 `live_key`：`(room_id, live_time)` 去重

## Docker 部署

```bash
cp .env.example .env
# 必填两项：
#   BILIBILI_COOKIE=...
#   JWT_SECRET=$(openssl rand -hex 32)

docker compose up -d --build
```

访问 `http://<服务器>:3000`。默认监听 `0.0.0.0`，**可直接外网访问**。

想限制成只走本机反代（推荐的生产做法），在 `.env` 里改：

```bash
BIND_IP=127.0.0.1
HOST_PORT=3000     # 也可改成 8080 等
```

### 直接暴露到公网前请确认

1. **`JWT_SECRET` 必须是固定的长随机串**（compose 已强制必填）
2. **务必配 https 反代**，然后设 `COOKIE_SECURE=1`。
   直接用 http 暴露时 cookie 和登录密码都是明文传输
3. **登录已内置限流**：同一 IP 5 分钟内失败 5 次即锁定 15 分钟（返回 429）。
   这是单进程内存态，多副本部署需换 Redis
4. **`TRUST_PROXY` 保持 0**，除非前面确实有可信的 nginx/caddy。
   直接暴露时若设为 1，攻击者可伪造 `X-Forwarded-For` 绕过限流
5. 用防火墙只放行必要端口

### compose 做了什么

```yaml
ports:
  - '${BIND_IP:-0.0.0.0}:${HOST_PORT:-3000}:3000'
environment:
  BILIBILI_COOKIE: ${BILIBILI_COOKIE:?...}   # 缺失时 compose 直接报错
  JWT_SECRET: ${JWT_SECRET:?...}             # 同上
  TZ: Asia/Shanghai          # 影响「当天」边界，不设会用 UTC
volumes:
  - bls-data:/app/data       # 命名卷，容器重建不丢数据
stop_grace_period: 20s       # 给 SQLite flush 留时间
```

两个 `:?` 是刻意的：漏配环境变量时 `docker compose up` 会**直接失败并提示该填什么**，
而不是起来一个登录不了的空壳。

### 镜像实现要点

SSR 架构没有构建产物，镜像就是「装依赖 + 拷源码」：

```dockerfile
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY web ./web
CMD ["node_modules/.bin/tsx", "src/cli.ts", "start"]
```

踩过并已解决的点：

1. **tsx 的 bin 是 shell 脚本**，不能写成 `node node_modules/.bin/tsx`（会报
   `Invalid or unexpected token`），要直接执行让 shebang 生效
2. **用 tini 做 PID 1**，否则 SIGTERM 传不到 node，`docker stop` 会等满 10 秒后
   `SIGKILL`，SQLite 的 WAL 来不及 checkpoint
3. **非 root 运行**，`data/` 目录在构建时就 chown 给 1001
4. **用命名卷而非 bind mount** —— bind mount 会让宿主机目录被改成 1001 属主，
   之后本地 `rm -rf data` 会 Permission denied

### 优雅关闭验证

```
$ docker stop bls
real 0m0.272s      # 0.27 秒退出
exit=0             # 不是 143，说明 SIGTERM 被正确处理
日志：INFO 收到 SIGTERM，正在停止
```

### 常见操作

```bash
docker compose logs -f          # 看日志（含首次生成的 admin 密码）
docker compose restart          # 重启
docker compose down             # 停止（数据保留在 bls-data 卷里）
docker compose down -v          # 停止并删除数据卷（会清库）

# 在容器里管理用户
docker compose exec bls node_modules/.bin/tsx src/cli.ts user:list
```

## 环境变量

见 `.env.example`：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BILIBILI_COOKIE` | 空 | 网页版 Cookie，规避风控 |
| `UID` | `0` | **必须为 0**，非 0 会被弹幕服务器断开（close 1006） |
| `ROOMS_FILE` | `rooms.toml` | 房间清单路径 |
| `DB_PATH` | `data/live.db` | SQLite 文件路径 |
| `RETENTION_DAYS` | `0` | 记录保留天数，`0` 表示永久 |
| `RECONNECT_TIME` | `5000` | 重连间隔（毫秒） |
| `HEARTBEAT_TIME` | `30000` | 心跳间隔（毫秒） |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `WEB_HOST` | `127.0.0.1` | Web 监听地址 |
| `WEB_PORT` | `3000` | Web 端口 |

## 目录结构

```
src/
  cli.ts        命令入口（web / listen / list / today / info / rooms / user:*）
  server.tsx    Hono 路由 + 服务端渲染页面（JSX 需要 .tsx）
  app.ts        监听编排：从数据库读房间，差量增删监听（sync）
  monitor.ts    单房间 KeepLiveWS 监听 + LIVE 消息解析
  store.ts      SQLite 读写（node:sqlite，无需原生编译）
  bilibili.ts   B 站接口：查标题 / 主播名
  time.ts       本地时区的「当天」区间工具
  config.ts     环境变量
  logger.ts     带级别的日志
  auth/jwt.ts   JWT 签发与校验（hono/jwt）
  repo/rooms.ts 房间表 CRUD
  repo/users.ts 用户表 + scrypt 密码哈希
  public/
    style.css   终端样式（手写，唯一静态资源）

web/            服务端渲染的组件（与 src/server.tsx 共用 tsconfig）
  ssr/Layout.tsx     <html> 外壳 + 顶栏导航
  ssr/LoginPage.tsx  登录表单
  ssr/RecordsPage.tsx 记录列表（<details> 展开）
  ssr/RoomsPage.tsx   房间 CRUD
  ssr/UsersPage.tsx   用户管理
  format.ts      时间格式化
  types.ts       与数据层对应的类型

test/           单元测试（tsx --test）
```

`web/` 下的组件只在服务端运行，不进浏览器。

## 备注

- 依赖 Node.js ≥ 22.5 的 `node:sqlite`，因此不需要 `better-sqlite3` 之类的原生模块。
- 监听与 Web 共用同一个 SQLite 连接（单进程）。
- SSE 端点带 25 秒心跳（`: ping`），避免反向代理掐断空闲连接；
  数据库被短暂锁住时不会中断连接，下一轮轮询自动重试。
- 房间改名直接改 `rooms.toml` 的 `name` 即可，之后的新记录使用新名字；
  历史记录保留写入当时的名字。
- 进程收到 `SIGINT` / `SIGTERM` 会关闭所有连接和数据库后退出。
