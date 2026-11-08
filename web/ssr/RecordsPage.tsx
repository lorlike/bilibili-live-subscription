import type { FC } from 'hono/jsx'
import type { LiveRecord } from '../types.ts'
import { durationOf, fullString, timeString } from '../format.ts'

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span class="dim">{`${label.padEnd(8, ' ')} : `}</span>
      <b>{value}</b>
    </div>
  )
}

/** 单行记录：用 <details> 实现展开，无需 JS */
const RecordRow: FC<{ record: LiveRecord }> = ({ record }) => {
  const delay = Math.max(0, Math.round(record.detectedAt / 1000 - record.liveTime))

  return (
    <details class="row rec-row">
      <summary>
        <span class="time">{timeString(record.liveTime)}</span>
        <span class="marker">▶ live</span>
        <span class="name">
          <span class="name-text">{record.roomName}</span>
          <span class="room-id">#{record.roomId}</span>
        </span>
        <span class="meta">{durationOf(record)}</span>
        <span class="chev">▸</span>
      </summary>

      <div class="detail">
        <DetailLine label="记录 id" value={String(record.id)} />
        <DetailLine label="开播时间" value={fullString(record.liveTime)} />
        <DetailLine label="检测时间" value={fullString(Math.floor(record.detectedAt / 1000))} />
        <DetailLine label="场次 key" value={record.liveKey || '—'} />
        <DetailLine label="推送延迟" value={`${delay}s`} />
        {record.anchorName ? <DetailLine label="主播" value={record.anchorName} /> : null}
        {record.title ? <DetailLine label="当场标题" value={record.title} /> : null}

        <form method="post" action={`/records/${record.id}/delete`} class="inline danger-form">
          <button class="key tiny danger" type="submit">
            删除这条
          </button>
        </form>
      </div>
    </details>
  )
}

export const RecordsPage: FC<{
  records: LiveRecord[]
  total: number
  date: string
  limit: number
  offset: number
  error?: string
}> = ({ records, total, date, limit, offset, error }) => {
  const pageEnd = offset + records.length
  const hasPrev = offset > 0
  const hasNext = pageEnd < total

  return (
    <>
      <div class="bar sub">
        <span class="seg dim">{total === 0 ? '无记录' : `${offset + 1}–${pageEnd} / ${total}`}</span>
        <span class="spacer" />
        {hasPrev ? (
          <a class="key" href={`/records?date=${date}&offset=${Math.max(0, offset - limit)}`}>
            ← 上页
          </a>
        ) : (
          <span class="key disabled">← 上页</span>
        )}
        {hasNext ? (
          <a class="key" href={`/records?date=${date}&offset=${offset + limit}`}>
            下页 →
          </a>
        ) : (
          <span class="key disabled">下页 →</span>
        )}
      </div>

      {error ? (
        <div class="empty">
          <span class="big">加载失败</span>
          <span>{error}</span>
        </div>
      ) : records.length === 0 ? (
        <div class="empty">
          <span class="big">{date} 暂无开播记录</span>
          <span>监听服务写入新记录后会出现在这里</span>
        </div>
      ) : (
        <div class="lines">
          {records.map((record) => (
            <RecordRow record={record} />
          ))}
        </div>
      )}
    </>
  )
}
