/** 与后端 API 对应的类型 */

export interface LiveRecord {
  id: number
  roomId: number
  roomName: string
  liveTime: number
  detectedAt: number
  liveKey: string
  title: string
  anchorName: string
}

export interface RecordsPage {
  date?: string
  records: LiveRecord[]
  total: number
  limit: number
  offset: number
}

export interface Room {
  id: number
  /** 显示名；null 表示由监听进程查主播名补全 */
  name: string | null
  anchorName: string | null
  enabled: boolean
  note: string
  createdAt: number
  updatedAt: number
  /** 当前是否正在监听（来自监听进程状态） */
  listening: boolean
  recordCount: number
  lastLive: number | null
}

export interface RoomsResponse {
  rooms: Room[]
  listeningCount: number
}

export interface SessionUser {
  id: number
  username: string
}

export interface UserInfo {
  id: number
  username: string
  createdAt: number
}

export type View = 'records' | 'rooms' | 'users'
