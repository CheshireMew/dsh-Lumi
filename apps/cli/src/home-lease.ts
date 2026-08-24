/** Process-lifetime ownership for one Harness home. */

import { createHash } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { resolve } from 'node:path'

const LEASE_PROTOCOL_VERSION = 1
const OWNER_RESPONSE_MAX_BYTES = 4_096
const OWNER_RESPONSE_TIMEOUT_MS = 500
const TCP_PORT_BASE = 40_000
const TCP_PORT_COUNT = 20_000
const TCP_CANDIDATE_COUNT = 32

/** Human-readable owner facts returned by the process holding the home. */
export interface DshHomeLeaseOwner {
  /** Process id of the Host. */
  pid: number
  /** Profile mounted by the Host. */
  profile: string
  /** ISO timestamp recorded before profile composition starts. */
  startedAt: string
}

interface LeaseOwnerMessage extends DshHomeLeaseOwner {
  version: typeof LEASE_PROTOCOL_VERSION
  homeHash: string
}

type LeaseEndpoint =
  | { kind: 'pipe'; path: string }
  | { kind: 'tcp'; port: number }

/** A held process-lifetime lease for one canonical Harness home. */
export interface DshHomeLease {
  /** Canonical Harness home protected by this lease. */
  home: string
  /** Owner facts served to a contending local process. */
  owner: DshHomeLeaseOwner
  /** Release the operating-system endpoint; repeated calls join the first release. */
  release(): Promise<void>
}

/** Startup error raised when another process already owns the Harness home. */
export class DshHomeInUseError extends Error {
  readonly code = 'dsh-home-in-use'

  /** Canonical home whose Host ownership was rejected. */
  readonly home: string

  /** Owner facts when the live process answered the local probe. */
  readonly owner: DshHomeLeaseOwner | undefined

  /**
   * Create one user-facing ownership error.
   * @param home - canonical Harness home.
   * @param owner - live owner facts, when available.
   */
  constructor(home: string, owner: DshHomeLeaseOwner | undefined) {
    const detail = owner === undefined
      ? 'another Host is already using it; owner details were unavailable'
      : `PID ${String(owner.pid)} is already using it with profile ${JSON.stringify(owner.profile)} since ${owner.startedAt}`
    super(`Harness home ${JSON.stringify(home)} is unavailable: ${detail}. Stop that Host or use its existing UI before starting another profile.`)
    this.name = 'DshHomeInUseError'
    this.home = home
    this.owner = owner
  }
}

/** Whether a failed listen means another process owns this endpoint. */
function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE'
}

/** Stable endpoint identity for a canonical Harness home. */
function homeHash(home: string): string {
  const identity = process.platform === 'win32' ? home.toLowerCase() : home
  return createHash('sha256').update(identity).digest('hex')
}

/** Candidate endpoints. Windows named pipes are collision-free; other hosts probe loopback ports. */
function endpoints(hash: string): LeaseEndpoint[] {
  if (process.platform === 'win32') return [{ kind: 'pipe', path: `\\\\.\\pipe\\dsh-home-${hash}` }]
  const start = Number.parseInt(hash.slice(0, 8), 16) % TCP_PORT_COUNT
  return Array.from({ length: TCP_CANDIDATE_COUNT }, (_, offset) => ({
    kind: 'tcp' as const,
    port: TCP_PORT_BASE + ((start + offset) % TCP_PORT_COUNT),
  }))
}

/** Listen once and return the bind error instead of emitting it unhandled. */
function listen(server: Server, endpoint: LeaseEndpoint): Promise<Error | undefined> {
  return new Promise((resolveListen) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      resolveListen(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolveListen(undefined)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    if (endpoint.kind === 'pipe') server.listen(endpoint.path)
    else server.listen({ host: '127.0.0.1', port: endpoint.port, exclusive: true })
  })
}

/** Parse a bounded owner response from a local lease endpoint. */
function parseOwner(raw: string): LeaseOwnerMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate['version'] !== LEASE_PROTOCOL_VERSION
    || typeof candidate['homeHash'] !== 'string'
    || !Number.isInteger(candidate['pid'])
    || (candidate['pid'] as number) <= 0
    || typeof candidate['profile'] !== 'string'
    || typeof candidate['startedAt'] !== 'string'
    || !Number.isFinite(Date.parse(candidate['startedAt']))) return undefined
  return candidate as unknown as LeaseOwnerMessage
}

/** Ask an occupied endpoint which Harness home it owns. */
function probeOwner(endpoint: LeaseEndpoint): Promise<LeaseOwnerMessage | undefined> {
  return new Promise((resolveOwner) => {
    let settled = false
    let data = ''
    const socket = endpoint.kind === 'pipe'
      ? createConnection(endpoint.path)
      : createConnection({ host: '127.0.0.1', port: endpoint.port })
    const finish = (owner?: LeaseOwnerMessage): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      resolveOwner(owner)
    }
    const timeout = setTimeout(() => { finish() }, OWNER_RESPONSE_TIMEOUT_MS)
    socket.once('error', () => { finish() })
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8')
      if (Buffer.byteLength(data, 'utf8') > OWNER_RESPONSE_MAX_BYTES) {
        finish()
        return
      }
      const newline = data.indexOf('\n')
      if (newline !== -1) finish(parseOwner(data.slice(0, newline)))
    })
    socket.once('end', () => { finish(parseOwner(data)) })
  })
}

/** Close one listening server after terminating its short owner-probe sockets. */
function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  if (!server.listening) return Promise.resolve()
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose()
      else rejectClose(error)
    })
  })
}

/**
 * Acquire exclusive process-lifetime ownership of one Harness home. Windows
 * uses a named pipe derived from the canonical path. Other platforms probe a
 * deterministic loopback-port sequence and distinguish unrelated listeners
 * with the same owner handshake. Operating-system endpoint ownership vanishes
 * on process death, so recovery never guesses from a stale file or timestamp.
 * @param home - Harness home to own; it is created and canonicalized first.
 * @param profile - profile this Host will mount.
 * @param onCompromised - fatal callback if the held endpoint later fails or closes unexpectedly.
 * @returns the held lease.
 * @throws {@link DshHomeInUseError} when the same home already has a Host.
 */
export async function acquireDshHomeLease(
  home: string,
  profile: string,
  onCompromised: (error: Error) => void,
): Promise<DshHomeLease> {
  const requestedHome = resolve(home)
  await mkdir(requestedHome, { recursive: true, mode: 0o700 })
  const canonicalHome = await realpath(requestedHome)
  const hash = homeHash(canonicalHome)
  const ownerMessage: LeaseOwnerMessage = {
    version: LEASE_PROTOCOL_VERSION,
    homeHash: hash,
    pid: process.pid,
    profile,
    startedAt: new Date().toISOString(),
  }
  const payload = `${JSON.stringify(ownerMessage)}\n`

  let owned: { server: Server; sockets: Set<Socket> } | undefined
  for (const endpoint of endpoints(hash)) {
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => { sockets.delete(socket) })
      socket.end(payload)
    })
    const error = await listen(server, endpoint)
    if (error === undefined) {
      owned = { server, sockets }
      break
    }
    if (!isAddressInUse(error)) throw error
    const incumbent = await probeOwner(endpoint)
    if (endpoint.kind === 'pipe' || incumbent?.homeHash === hash) {
      throw new DshHomeInUseError(canonicalHome, incumbent)
    }
  }
  if (owned === undefined) {
    throw new Error(`Unable to reserve a local Host-ownership endpoint for Harness home ${JSON.stringify(canonicalHome)}.`)
  }

  const { server, sockets } = owned
  server.unref()
  let releasing = false
  let compromised = false
  let releasePromise: Promise<void> | undefined
  const compromise = (error: Error): void => {
    if (releasing || compromised) return
    compromised = true
    onCompromised(new Error(`Harness home ownership failed for ${JSON.stringify(canonicalHome)}: ${error.message}`, { cause: error }))
  }
  server.on('error', compromise)
  server.once('close', () => { compromise(new Error('ownership endpoint closed unexpectedly')) })

  const owner: DshHomeLeaseOwner = {
    pid: ownerMessage.pid,
    profile: ownerMessage.profile,
    startedAt: ownerMessage.startedAt,
  }
  return {
    home: canonicalHome,
    owner,
    release() {
      if (releasePromise !== undefined) return releasePromise
      releasing = true
      releasePromise = closeServer(server, sockets)
      return releasePromise
    },
  }
}
