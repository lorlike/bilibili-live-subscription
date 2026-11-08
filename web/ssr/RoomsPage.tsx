import type { FC } from 'hono/jsx'
import type { Room } from '../types.ts'
import { agoString, dateTimeString } from '../format.ts'

/** 房间行：操作都是普通表单提交，不需要 JS */
const RoomRow: FC<{ room: Room }> = ({ room }) => (
  <details class="row room-row">
    <summary>
      <span class="dot" title={room.listening ? '正在监听' : room.enabled ? '已启用' : '已禁用'}>
        {room.listening ? '●' : room.enabled ? '◐' : '○'}
      </span>
      <span class="name">
        <span class={room.name ? 'name-text' : 'name-text auto'}>
          {room.name ?? room.anchorName ?? '(未取名)'}
        </span>
        <span class="room-id">#{room.id}</span>
      </span>
      <span class="meta">{room.recordCount ? `${room.recordCount} 次` : '—'}</span>
      <span class="meta">{room.lastLive ? dateTimeString(room.lastLive) : '无记录'}</span>
      <span class="meta">{agoString(room.lastLive)}</span>
      <span class="chev">▸</span>
    </summary>

    <div class="detail">
      <div>
        <span class="dim">房间号 : </span>
        <b>{room.id}</b>
      </div>
      <div>
        <span class="dim">主播名 : </span>
        <b>{room.anchorName ?? '—'}</b>
      </div>
      <div>
        <span class="dim">备注   : </span>
        <b>{room.note || '—'}</b>
      </div>
      <div>
        <span class="dim">监听中 : </span>
        <b>{room.listening ? '是' : '否'}</b>
      </div>

      <form method="post" action={`/rooms/${room.id}/update`} class="field-row">
        <input name="name" value={room.name ?? ''} placeholder="显示名（留空则自动查主播名）" />
        <input name="note" value={room.note} placeholder="备注" />
        <button class="key" type="submit">
          保存
        </button>
      </form>

      <div class="field-row">
        <form method="post" action={`/rooms/${room.id}/toggle`} class="inline">
          <button class="key" type="submit">
            {room.enabled ? '停止监听' : '开始监听'}
          </button>
        </form>

        <form method="post" action={`/rooms/${room.id}/delete`} class="inline">
          <button class="key danger" type="submit">
            删除房间
          </button>
        </form>
      </div>
    </div>
  </details>
)

export const RoomsPage: FC<{
  rooms: Room[]
  listeningCount: number
  error?: string
}> = ({ rooms, listeningCount, error }) => (
  <>
    <div class="bar sub">
      <form method="post" action="/rooms" class="inline field-row">
        <input class="short" name="id" placeholder="房间号" required />
        <input class="short" name="name" placeholder="显示名（可空）" />
        <button class="key" type="submit">
          添加
        </button>
      </form>
      <span class="seg dim">监听中 {listeningCount}</span>
    </div>

    {error ? (
      <div class="empty">
        <span class="big">清单读取失败</span>
        <span>{error}</span>
      </div>
    ) : rooms.length === 0 ? (
      <div class="empty">
        <span class="big">还没有房间</span>
        <span>在上面输入房间号添加，监听服务会在 5 秒内自动连上</span>
      </div>
    ) : (
      <>
        <div class="rooms-head">
          <span class="head-cell c-dot">监听</span>
          <span class="head-cell c-name">房间</span>
          <span class="head-cell c-count">次数</span>
          <span class="head-cell c-last">最近开播</span>
          <span class="head-cell c-ago">距今</span>
          <span class="head-cell" />
        </div>
        <div class="rooms-list">
          {rooms.map((room) => (
            <RoomRow room={room} />
          ))}
        </div>
      </>
    )}
  </>
)
