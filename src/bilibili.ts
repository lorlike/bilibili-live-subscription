/**
 * B 站直播间信息查询。
 *
 * 用到的公开接口（无需登录态）：
 *   · room/v1/Room/get_info           → 标题、真实房间号、开播状态、开播时间
 *   · live_user/v1/UserInfo/get_anchor_in_room → 主播昵称
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export interface RoomInfo {
  /** 真实（长）房间号 */
  roomId: number
  /** 短号，无短号时为 0 */
  shortId: number
  /** 直播间标题，每场直播都会变 */
  title: string
  /** 主播 UID */
  anchorUid: number
  /** 主播昵称；接口失败时为 null */
  anchorName: string | null
  /** 1 = 直播中 */
  liveStatus: number
  /** 开播时间（Unix 秒），未开播为 0 */
  liveTime: number
  areaName: string
  parentAreaName: string
}

export interface FetchOptions {
  cookie?: string
  timeoutMs?: number
}

interface GetInfoResponse {
  code: number
  message?: string
  msg?: string
  data?: {
    room_id: number
    short_id: number
    uid: number
    title: string
    live_status: number
    live_time: string
    area_name?: string
    parent_area_name?: string
  }
}

interface AnchorResponse {
  code: number
  data?: {
    info?: {
      uid: number
      uname: string
    }
  }
}

function headers(cookie?: string): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    Referer: 'https://live.bilibili.com/',
    ...(cookie ? { Cookie: cookie } : {}),
  }
}

async function getJson<T>(url: string, options: FetchOptions): Promise<T> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 8000)
  const res = await fetch(url, { headers: headers(options.cookie), signal })

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)

  return (await res.json()) as T
}

/** 把 "2026-10-15 15:50:15" 解析为 Unix 秒（按本地时区）；无效值返回 0 */
function parseLiveTime(value: string | undefined): number {
  if (!value) return 0
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim())
  if (!match) return 0

  const [, y, mo, d, h, mi, s] = match
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  )

  return Number.isNaN(date.getTime()) ? 0 : Math.floor(date.getTime() / 1000)
}

/** 查询直播间标题与主播名。房间不存在时抛错。 */
export async function fetchRoomInfo(
  roomId: number,
  options: FetchOptions = {},
): Promise<RoomInfo> {
  if (!Number.isInteger(roomId) || roomId <= 0) {
    throw new Error(`房间号无效: ${roomId}`)
  }

  const info = await getJson<GetInfoResponse>(
    `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`,
    options,
  )

  if (info.code !== 0 || !info.data) {
    throw new Error(info.message ?? info.msg ?? `接口返回 code=${info.code}`)
  }

  const data = info.data
  const realRoomId = data.room_id

  // 主播名单独一个接口；失败不影响标题等信息
  let anchorName: string | null = null
  try {
    const anchor = await getJson<AnchorResponse>(
      `https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid=${realRoomId}`,
      options,
    )
    const name = anchor.data?.info?.uname
    if (anchor.code === 0 && typeof name === 'string' && name.trim()) {
      anchorName = name.trim()
    }
  } catch {
    anchorName = null
  }

  return {
    roomId: realRoomId,
    shortId: data.short_id ?? 0,
    title: (data.title ?? '').trim(),
    anchorUid: data.uid ?? 0,
    anchorName,
    liveStatus: data.live_status ?? 0,
    liveTime: parseLiveTime(data.live_time),
    areaName: data.area_name ?? '',
    parentAreaName: data.parent_area_name ?? '',
  }
}

/** 批量查询，失败项返回带 error 的结果而不是整体失败 */
export async function fetchRoomsInfo(
  roomIds: number[],
  options: FetchOptions & { concurrency?: number } = {},
): Promise<Array<{ roomId: number; info: RoomInfo | null; error: string | null }>> {
  const limit = Math.max(1, options.concurrency ?? 4)
  const results: Array<{ roomId: number; info: RoomInfo | null; error: string | null }> = []

  for (let i = 0; i < roomIds.length; i += limit) {
    const batch = roomIds.slice(i, i + limit)
    const settled = await Promise.allSettled(
      batch.map((id) => fetchRoomInfo(id, options)),
    )

    settled.forEach((result, index) => {
      const roomId = batch[index]!
      if (result.status === 'fulfilled') {
        results.push({ roomId, info: result.value, error: null })
      } else {
        results.push({
          roomId,
          info: null,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
      }
    })
  }

  return results
}
