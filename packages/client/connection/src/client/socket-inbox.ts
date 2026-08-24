const EMPTY_INBOX_SLOT = Symbol('empty WebSocket inbox slot')

/** Bounded constant-time FIFO for decoded WebSocket frames. */
export class SocketInbox<T> {
  private readonly items: Array<T | typeof EMPTY_INBOX_SLOT>
  private head = 0
  private tail = 0
  private size = 0

  /** @param capacity - Maximum number of items retained. */
  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('WebSocket inbox capacity must be a positive safe integer')
    }
    this.items = new Array<T | typeof EMPTY_INBOX_SLOT>(capacity).fill(EMPTY_INBOX_SLOT)
  }

  /**
   * Append an item when capacity remains.
   * @param item - Decoded stream item.
   * @returns False when the inbox is already full.
   */
  push(item: T): boolean {
    if (this.size === this.capacity) return false
    this.items[this.tail] = item
    this.tail = (this.tail + 1) % this.capacity
    this.size += 1
    return true
  }

  /**
   * Remove the oldest item.
   * @returns The item wrapper, or undefined when the inbox is empty.
   */
  shift(): { value: T } | undefined {
    if (this.size === 0) return undefined
    const item = this.items[this.head] as T | typeof EMPTY_INBOX_SLOT
    /* v8 ignore next -- size is the authoritative occupancy count. */
    if (item === EMPTY_INBOX_SLOT) throw new Error('WebSocket inbox occupancy is inconsistent')
    this.items[this.head] = EMPTY_INBOX_SLOT
    this.head = (this.head + 1) % this.capacity
    this.size -= 1
    return { value: item }
  }

  /** Release every retained item. */
  clear(): void {
    this.items.fill(EMPTY_INBOX_SLOT)
    this.head = 0
    this.tail = 0
    this.size = 0
  }
}
