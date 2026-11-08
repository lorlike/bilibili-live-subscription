import type { FC } from 'hono/jsx'
import { Layout } from './Layout.tsx'

/** 登录页：纯表单提交，服务端校验后重定向，不需要任何客户端 JS */
export const LoginPage: FC<{ error?: string; username?: string }> = ({ error, username }) => (
  <Layout title="bls — 登录">
    <div class="login-wrap">
      <form class="login" method="post" action="/login">
        <div class="login-title">
          bls<span class="dim"> — 登录</span>
        </div>

        <label>
          <span class="dim">用户名</span>
          <input name="username" value={username ?? ''} autocomplete="username" autofocus required />
        </label>

        <label>
          <span class="dim">密码</span>
          <input name="password" type="password" autocomplete="current-password" required />
        </label>

        {error ? <div class="login-error">{error}</div> : null}

        <button class="key wide" type="submit">
          登录
        </button>
      </form>
    </div>
  </Layout>
)
