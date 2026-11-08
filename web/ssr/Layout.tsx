import type { FC, PropsWithChildren } from 'hono/jsx'
import type { SessionUser } from '../types.ts'

export const Layout: FC<PropsWithChildren<{ title?: string; user?: SessionUser | null }>> = ({
  children,
  title = 'bls — live records',
  user,
}) => (
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <div class="screen">{children}</div>
    </body>
  </html>
)

/** 顶部条 + 导航（服务端渲染，无 JS） */
export const Chrome: FC<{
  user: SessionUser
  view: 'records' | 'rooms' | 'users'
  date?: string
}> = ({ user, view, date }) => (
  <>
    <header class="bar">
      <span class="seg title">bls</span>
      <span class="seg dim">bilibili live records</span>
      <span class="spacer" />
      <span class="seg dim">{user.username}</span>
      <form method="post" action="/logout" class="inline">
        <button class="key" type="submit">
          登出
        </button>
      </form>
    </header>

    <nav class="bar toolbar">
      <a class={view === 'records' ? 'key wide active' : 'key wide'} href="/records">
        records
      </a>
      <a class={view === 'rooms' ? 'key wide active' : 'key wide'} href="/rooms">
        rooms
      </a>
      <a class={view === 'users' ? 'key wide active' : 'key wide'} href="/users">
        users
      </a>

      {view === 'records' ? (
        <>
          <span class="spacer" />
          <form method="get" action="/records" class="inline">
            <input class="date" type="date" name="date" value={date} />
            <button class="key" type="submit">
              查看
            </button>
          </form>
          <a class="key" href="/records">
            today
          </a>
        </>
      ) : (
        <span class="spacer" />
      )}
    </nav>
  </>
)

/** 页面外壳：Layout + Chrome + 内容，服务端各路由复用 */
export const Shell: FC<
  PropsWithChildren<{ user: SessionUser; view: 'records' | 'rooms' | 'users'; date?: string }>
> = ({ user, view, date, children }) => (
  <Layout user={user}>
    <Chrome user={user} view={view} date={date} />
    <main class="term">{children}</main>
    <footer class="bar status">
      <span class="spacer" />
      <span class="seg dim">服务端渲染 · 表单操作</span>
    </footer>
  </Layout>
)
