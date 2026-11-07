import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadRooms } from '../src/rooms.ts'

function writeTemp(content: string, name = 'rooms.toml'): string {
  const dir = mkdtempSync(join(tmpdir(), 'bls-rooms-'))
  const file = join(dir, name)
  writeFileSync(file, content)
  return file
}

// ---------- TOML ----------

test('解析 TOML 的 [[room]] 数组', () => {
  const file = writeTemp(`
[[room]]
id = 652581
name = "A"

[[room]]
id = 21452505
name = "B"
enabled = false
`)

  assert.deepEqual(loadRooms(file), [
    { id: 652581, name: 'A', enabled: true },
    { id: 21452505, name: 'B', enabled: false },
  ])
})

test('TOML 允许注释与空行', () => {
  const file = writeTemp(`
# 我的房间
[[room]]
id = 1     # 行尾注释
name = "A"

# 另一个
[[room]]
id = 2
name = "B"
`)

  assert.equal(loadRooms(file).length, 2)
})

test('TOML 支持多行字符串作为房间名', () => {
  const file = writeTemp(`
[[room]]
id = 1
name = """
多行
房间名
"""
`)
  assert.match(loadRooms(file)[0]!.name ?? '', /多行/)
})

test('TOML 的 id 可以是字符串（兼容旧清单）', () => {
  const file = writeTemp(`
[[room]]
id = "12345"
name = "A"
`)
  assert.equal(loadRooms(file)[0]!.id, 12345)
})

test('TOML 房间名两侧空白会被裁剪', () => {
  const file = writeTemp(`
[[room]]
id = 1
name = "  A  "
`)
  assert.equal(loadRooms(file)[0]!.name, 'A')
})

test('TOML 语法错误时报出文件名', () => {
  const file = writeTemp(`
[[room]
id = 1
`)
  assert.throws(() => loadRooms(file), /TOML 解析失败.*rooms\.toml/)
})

// ---------- 校验 ----------

test('id 无效时报错', () => {
  const file = writeTemp(`
[[room]]
id = "abc"
name = "A"
`)
  assert.throws(() => loadRooms(file), /id 无效/)
})

test('id 为 0 或负数时报错', () => {
  assert.throws(
    () => loadRooms(writeTemp('[[room]]\nid = 0\nname = "A"\n')),
    /id 无效/,
  )
  assert.throws(
    () => loadRooms(writeTemp('[[room]]\nid = -5\nname = "A"\n')),
    /id 无效/,
  )
})

test('省略 name 时表示自动取名', () => {
  const file = writeTemp(`
[[room]]
id = 1
`)
  assert.equal(loadRooms(file)[0]!.name, null)
})

test('name = "auto" 表示自动取名（大小写不敏感）', () => {
  for (const value of ['auto', 'AUTO', 'Auto']) {
    const file = writeTemp(`
[[room]]
id = 1
name = "${value}"
`)
    assert.equal(loadRooms(file)[0]!.name, null, `name = "${value}" 应被识别为自动`)
  }
})

test('name 为空字符串时也表示自动取名', () => {
  const file = writeTemp(`
[[room]]
id = 1
name = ""
`)
  assert.equal(loadRooms(file)[0]!.name, null)
})

test('手写 name 会被保留', () => {
  const file = writeTemp(`
[[room]]
id = 1
name = "我的备注"
`)
  assert.equal(loadRooms(file)[0]!.name, '我的备注')
})

test('重复房间号时报错', () => {
  const file = writeTemp(`
[[room]]
id = 1
name = "A"

[[room]]
id = 1
name = "B"
`)
  assert.throws(() => loadRooms(file), /重复/)
})

test('没有 [[room]] 时报错', () => {
  assert.throws(() => loadRooms(writeTemp('title = "x"\n')), /缺少 \[\[room\]\]/)
})

test('文件不存在时报错', () => {
  assert.throws(() => loadRooms(join(tmpdir(), 'bls-not-exist.toml')), /无法读取房间清单/)
})

// ---------- 兼容旧 JSON ----------

test('.json 扩展名仍按 JSON 解析', () => {
  const file = writeTemp(
    JSON.stringify({ rooms: [{ id: 1, name: 'A', enabled: false }] }),
    'rooms.json',
  )
  assert.deepEqual(loadRooms(file), [{ id: 1, name: 'A', enabled: false }])
})

test('内容以 { 开头时即使扩展名是 .toml 也按 JSON 解析', () => {
  const file = writeTemp(JSON.stringify({ rooms: [{ id: 2, name: 'B' }] }), 'rooms.toml')
  assert.equal(loadRooms(file)[0]!.id, 2)
})

test('JSON 语法错误时报 JSON 解析失败', () => {
  const file = writeTemp('{ "rooms": [', 'rooms.json')
  assert.throws(() => loadRooms(file), /JSON 解析失败/)
})
