/**
 * 讓出主執行緒的工具。
 *
 * 不能用 setTimeout：瀏覽器會把背景分頁的 setTimeout 最小間隔夾到 1000ms，
 * 於是任何「送出工作 → 讓出 → 收結果」的迴圈都會退化成每秒一次。
 * 這會讓量測結果完全失真（量到的是節流間隔，不是實際效能），
 * 也會讓解碼補給在分頁失焦時停擺。
 *
 * MessageChannel 的 message event 不受這個節流影響，是目前唯一穩定的做法。
 */

let channel: MessageChannel | null = null
let nextId = 0
const pending = new Map<number, () => void>()

function ensureChannel(): MessageChannel {
  if (channel) return channel
  channel = new MessageChannel()
  channel.port1.onmessage = (e: MessageEvent<number>) => {
    const resolve = pending.get(e.data)
    if (resolve) {
      pending.delete(e.data)
      resolve()
    }
  }
  return channel
}

/** 讓出一次事件迴圈，使已排入的 callback（例如解碼器的 output）有機會執行。 */
export function yieldToEventLoop(): Promise<void> {
  const ch = ensureChannel()
  const id = nextId
  nextId += 1
  return new Promise<void>((resolve) => {
    pending.set(id, resolve)
    ch.port2.postMessage(id)
  })
}
