import { sign, verify } from 'hono/jwt'

/**
 * JWT 相关逻辑。
 *
 * 直接用 Hono 内置的 `hono/jwt`（sign / verify），它支持
 * exp / nbf / iat / aud / iss 校验，并区分过期与签名不匹配等错误类型。
 * 这里只是把它包成项目自己的窄接口，避免业务代码到处传 alg。
 */

export interface JwtPayload {
  sub: number
  username: string
  /** 签发时间（秒） */
  iat: number
  /** 过期时间（秒） */
  exp: number
}

const ALG = 'HS256'

export async function signJwt(
  payload: Pick<JwtPayload, 'sub' | 'username'>,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  return sign({ ...payload, iat: now, exp: now + ttlSeconds }, secret, ALG)
}

/** 校验签名与有效期；任何失败都返回 null（不向调用方区分原因） */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const payload = await verify(token, secret, ALG)

    // Hono 已校验 exp，这里只做结构上的收窄
    if (typeof payload.sub !== 'number' || typeof payload.username !== 'string') return null

    return {
      sub: payload.sub,
      username: payload.username,
      iat: Number(payload.iat ?? 0),
      exp: Number(payload.exp ?? 0),
    }
  } catch {
    return null
  }
}
