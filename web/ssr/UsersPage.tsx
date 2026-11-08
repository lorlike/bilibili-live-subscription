import type { FC } from 'hono/jsx'
import type { SessionUser, UserInfo } from '../types.ts'

export const UsersPage: FC<{
  users: UserInfo[]
  currentUser: SessionUser
  message?: string
}> = ({ users, currentUser, message }) => (
  <>
    <div class="bar sub">
      <form method="post" action="/users" class="inline field-row">
        <input class="short" name="username" placeholder="用户名" required />
        <input class="short" name="password" type="password" placeholder="密码（≥8 位）" required />
        <button class="key" type="submit">
          新建用户
        </button>
      </form>
      {message ? <span class="seg dim">{message}</span> : null}
    </div>

    <div class="rooms-list">
      {users.map((user) => (
        <div class="row user-row">
          <span class="dot">{user.id === currentUser.id ? '●' : '○'}</span>
          <span class="name">
            <span class="name-text">{user.username}</span>
            {user.id === currentUser.id ? <span class="room-id">（当前登录）</span> : null}
          </span>
          <span class="meta">{new Date(user.createdAt * 1000).toLocaleDateString('zh-CN')}</span>
        </div>
      ))}
    </div>

    <div class="bar sub">
      <form method="post" action="/users/password" class="inline field-row">
        <span class="seg dim">修改我的密码</span>
        <input class="short" name="current" type="password" placeholder="当前密码" required />
        <input class="short" name="next" type="password" placeholder="新密码（≥8 位）" required />
        <button class="key" type="submit">
          更新
        </button>
      </form>
      {message ? <span class="seg dim">{message}</span> : null}
    </div>
  </>
)
