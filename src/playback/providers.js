const providers = new Map()

export function registerPlaybackProvider(id, adapter) {
  if (!id || !adapter?.trackId || !adapter?.serializeTrack || !adapter?.restoreTrack) {
    throw new TypeError('A playback provider needs an id, trackId, serializeTrack, and restoreTrack adapter.')
  }
  providers.set(id, adapter)
  return () => providers.delete(id)
}

export function getPlaybackProviderId(track) {
  return track?.playbackProvider || track?.source || 'local'
}

export function serializePlaybackSession({ current, queue = [], queueOrder = [], context = null, queueLabel = 'Library', position = 0 }) {
  if (!current) return null
  const provider = getPlaybackProviderId(current)
  const adapter = providers.get(provider)
  if (!adapter) return null
  const sameProvider = (track) => getPlaybackProviderId(track) === provider
  const providerQueue = queue.filter(sameProvider)
  const providerOrder = queueOrder.filter(sameProvider)
  const ensureCurrent = (items) => items.some((track) => adapter.trackId(track) === adapter.trackId(current)) ? items : [current, ...items]
  const safeContext = context && typeof context === 'object' ? context : null
  return {
    version: 2,
    provider,
    source: provider,
    trackId: adapter.trackId(current),
    currentTrack: adapter.serializeTrack(current),
    queue: ensureCurrent(providerQueue).map((track) => adapter.serializeTrack(track)),
    queueOrder: ensureCurrent(providerOrder).map((track) => adapter.serializeTrack(track)),
    context: safeContext,
    queueLabel: queueLabel || safeContext?.name || 'Library',
    position: Number.isFinite(position) && position > 0 ? position : 0,
  }
}

export function restorePlaybackSession(session, { localTracks = [] } = {}) {
  if (!session || typeof session !== 'object') return null
  const provider = session.provider || session.source
  const adapter = providers.get(provider)
  if (!adapter) return null
  const restore = (stored) => stored == null ? null : adapter.restoreTrack(stored, { localTracks })
  const queue = (Array.isArray(session.queue) ? session.queue : []).map(restore).filter(Boolean)
  const queueOrder = (Array.isArray(session.queueOrder) ? session.queueOrder : []).map(restore).filter(Boolean)
  const current = restore(session.currentTrack) || queue.find((track) => adapter.trackId(track) === session.trackId) || null
  const addCurrent = (items) => current && !items.some((track) => adapter.trackId(track) === adapter.trackId(current)) ? [current, ...items] : items
  return {
    provider,
    current,
    queue: addCurrent(queue),
    queueOrder: addCurrent(queueOrder),
    context: session.context || null,
    queueLabel: session.queueLabel || session.context?.name || 'Library',
    position: Number.isFinite(session.position) && session.position > 0 ? session.position : 0,
  }
}

const localProvider = {
  trackId: (track) => track.id,
  serializeTrack: (track) => track.id,
  restoreTrack: (id, { localTracks }) => {
    const track = localTracks.find((item) => item.id === id)
    return track ? { ...track, source: 'local', playbackProvider: 'local' } : null
  },
}

const spotifyProvider = {
  trackId: (track) => track.id,
  serializeTrack: (track) => {
    const metadata = { ...track }
    delete metadata.blob
    delete metadata.file
    return metadata
  },
  restoreTrack: (track) => track && typeof track === 'object' ? { ...track, source: 'spotify', playbackProvider: 'spotify' } : null,
}

registerPlaybackProvider('local', localProvider)
registerPlaybackProvider('spotify', spotifyProvider)
