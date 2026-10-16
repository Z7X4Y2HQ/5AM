import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, AudioWaveform, Check, ChevronDown, ChevronUp, Clock3, Download, Ellipsis, Folder, Headphones, Heart, House, LibraryBig, Music2, Pause, Play, Plus, Repeat1, Repeat2, Search, Settings, Shuffle, Volume2, VolumeX, X } from 'lucide-react'
import { clearSpotifySession, finishSpotifyLogin, getSpotifyAccessToken, getSpotifyClientId, hasSpotifySession, loadSpotifyPlaybackSdk, normalizeSpotifyTrack, spotifyFetch, startSpotifyLogin } from './spotify.js'
import { restorePlaybackSession, serializePlaybackSession } from './playback/providers.js'
import './App.css'

const DB_NAME = 'aftertone-library'
const DB_VERSION = 2
const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|aiff?|wma|webm)$/i
const PLAYBACK_SESSION_KEY = '5am-playback-session'

function readPlaybackSession() {
  try {
    const value = JSON.parse(window.localStorage.getItem(PLAYBACK_SESSION_KEY) || 'null')
    return value && [1, 2].includes(value.version) ? value : null
  } catch {
    return null
  }
}

function savePlaybackSession(value) {
  try {
    if (value) window.localStorage.setItem(PLAYBACK_SESSION_KEY, JSON.stringify(value))
    else window.localStorage.removeItem(PLAYBACK_SESSION_KEY)
  } catch {
    // Playback state is a convenience; storage failures should not interrupt playback.
  }
}

function openLibraryDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('mixPlaylists')) db.createObjectStore('mixPlaylists', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('mixLikes')) db.createObjectStore('mixLikes', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readStore(storeName) {
  const db = await openLibraryDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
    request.onsuccess = () => { db.close(); resolve(request.result) }
    request.onerror = () => { db.close(); reject(request.error) }
  })
}

async function writeStore(storeName, value, method = 'put') {
  const db = await openLibraryDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName)[method](value)
    transaction.oncomplete = () => { db.close(); resolve() }
    transaction.onerror = () => { db.close(); reject(transaction.error) }
  })
}

async function removeStoreItem(storeName, id) {
  const db = await openLibraryDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).delete(id)
    transaction.oncomplete = () => { db.close(); resolve() }
    transaction.onerror = () => { db.close(); reject(transaction.error) }
  })
}

async function clearStore(storeName) {
  const db = await openLibraryDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).clear()
    transaction.oncomplete = () => { db.close(); resolve() }
    transaction.onerror = () => { db.close(); reject(transaction.error) }
  })
}

function parseTrackName(file) {
  const stem = file.name.replace(AUDIO_EXTENSIONS, '')
  const split = stem.split(' - ')
  if (split.length > 1) return { artist: split.shift().trim() || 'Unknown artist', title: split.join(' - ').trim() || stem }
  return { artist: 'Unknown artist', title: stem || file.name }
}

function readDuration(file) {
  return new Promise((resolve) => {
    const source = URL.createObjectURL(file)
    const probe = new Audio()
    let settled = false
    let timeout
    const finish = (duration) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      probe.src = ''
      URL.revokeObjectURL(source)
      resolve(Number.isFinite(duration) ? duration : 0)
    }
    probe.preload = 'metadata'
    probe.onloadedmetadata = () => finish(probe.duration)
    probe.onerror = () => finish(0)
    probe.src = source
    timeout = window.setTimeout(() => finish(0), 8000)
  })
}

function formatTime(value = 0) {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60).toString().padStart(2, '0')
  return `${minutes}:${seconds}`
}

function spotifyPlayRequest(track, queue, context) {
  // Mix queues can cross provider boundaries, so Spotify must play only the
  // selected item and let the app choose the next local or Spotify track.
  if (context?.type === 'mix') return { uris: [track.spotifyUri] }
  if (context?.type === 'playlist' && context.id) {
    return { context_uri: `spotify:playlist:${context.id}`, offset: { uri: track.spotifyUri } }
  }
  const playableQueue = queue.filter((item) => item.source === 'spotify' && item.playable !== false && item.spotifyUri)
  const startIndex = playableQueue.findIndex((item) => item.id === track.id)
  const remainingQueue = startIndex >= 0 ? playableQueue.slice(startIndex) : [track]
  return { uris: remainingQueue.slice(0, 100).map((item) => item.spotifyUri) }
}

function spotifyRepeatState(mode, context) {
  if (mode === 'one') return 'track'
  if (mode === 'all' && context?.type !== 'mix') return 'context'
  return 'off'
}

function shuffledFromTrack(tracks, currentTrack) {
  const currentIndex = tracks.findIndex((track) => track.id === currentTrack?.id)
  const played = currentIndex >= 0 ? tracks.slice(0, currentIndex) : []
  const upcoming = (currentIndex >= 0 ? tracks.slice(currentIndex + 1) : tracks)
    .filter((track) => track.id !== currentTrack?.id)
  for (let index = upcoming.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1))
    ;[upcoming[index], upcoming[randomIndex]] = [upcoming[randomIndex], upcoming[index]]
  }
  return currentTrack ? [...played, currentTrack, ...upcoming] : upcoming
}

function makeId(file) {
  return `${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`
}

function makeTrackReference(track, entryId) {
  return {
    id: entryId || `${track.source}:${track.id}`,
    source: track.source,
    trackId: track.id,
    snapshot: {
      id: track.id, source: track.source, title: track.title, artist: track.artist,
      album: track.album, duration: track.duration, artworkUrl: track.artworkUrl,
      spotifyUri: track.spotifyUri, spotifyUrl: track.spotifyUrl, playable: track.playable,
    },
  }
}

function makeFolderPlaylists(files) {
  const root = { name: '', path: '', files: [], children: new Map() }

  for (const file of files) {
    const relativePath = file.webkitRelativePath
    if (!relativePath) continue
    const folders = relativePath.split('/').filter(Boolean).slice(0, -1)
    if (!folders.length) continue

    let folder = root
    folders.forEach((name, index) => {
      const path = [...folders.slice(0, index + 1)].join('/')
      if (!folder.children.has(name)) {
        folder.children.set(name, { name, path, files: [], children: new Map() })
      }
      folder = folder.children.get(name)
    })
    folder.files.push(file)
  }

  const playlists = []
  const collectFolderFiles = (folder) => {
    const collected = [...folder.files]
    for (const child of folder.children.values()) collected.push(...collectFolderFiles(child))
    if (folder !== root && collected.length) {
      playlists.push({
        id: `folder-${encodeURIComponent(folder.path)}`,
        name: folder.name,
        folderPath: folder.path,
        trackIds: collected.map(makeId),
        createdAt: Date.now(),
        source: 'folder-import',
      })
    }
    return collected
  }

  collectFolderFiles(root)
  return playlists.sort((left, right) => left.folderPath.split('/').length - right.folderPath.split('/').length || left.folderPath.localeCompare(right.folderPath))
}

const iconSet = {
  home: House, library: LibraryBig, search: Search, plus: Plus, heart: Heart,
  play: Play, pause: Pause, next: ChevronDown, previous: ChevronUp,
  shuffle: Shuffle, repeat: Repeat2, repeatOne: Repeat1, volume: Volume2, more: Ellipsis,
  settings: Settings, clock: Clock3, music: Music2, folder: Folder,
  close: X, check: Check, headphones: Headphones,
}

function Icon({ name, size = 20, fill = 'none', strokeWidth = 1.8 }) {
  const LucideIcon = iconSet[name] || Music2
  return <LucideIcon size={size} fill={fill} strokeWidth={strokeWidth} aria-hidden="true" />
}

function Cover({ track, size = 'normal', className = '' }) {
  const artwork = track?.artwork || track?.artworkUrl || null
  const [artworkSrc, setArtworkSrc] = useState(typeof artwork === 'string' ? artwork : '')

  useEffect(() => {
    if (!artwork) { setArtworkSrc(''); return undefined }
    if (typeof artwork === 'string') { setArtworkSrc(artwork); return undefined }
    if (artwork instanceof Blob) {
      const url = URL.createObjectURL(artwork)
      setArtworkSrc(url)
      return () => URL.revokeObjectURL(url)
    }
    setArtworkSrc('')
    return undefined
  }, [artwork])

  return (
    <div className={`cover cover--fallback cover--${size} ${className}`} aria-hidden="true">
      {artworkSrc ? <img className="cover__image" src={artworkSrc} alt="" onError={() => setArtworkSrc('')} /> : <AudioWaveform className="cover__fallback-icon" strokeWidth={1.5} aria-hidden="true" />}
    </div>
  )
}

function TrackRow({ track, index, active, playing, liked, onPlay, onTogglePlayback, onLike, onMenu, likeScope = 'source' }) {
  const unavailable = track.source === 'spotify' && track.playable === false
  return (
    <div className={`track-row ${active ? 'track-row--active' : ''} ${unavailable ? 'track-row--unavailable' : ''}`} title={unavailable ? 'Unavailable in your Spotify market' : undefined} onDoubleClick={(event) => { if (!unavailable && !event.target.closest('button')) onPlay(track) }}>
      <button className="track-row__play" type="button" aria-label={unavailable ? `${track.title} is unavailable in your Spotify market` : `${active && playing ? 'Pause' : 'Play'} ${track.title}`} disabled={unavailable} onClick={() => { if (active) onTogglePlayback(); else onPlay(track) }}>
        <span className="track-row__number">{active && playing ? <span className="playing-bars"><i /><i /><i /></span> : index + 1}</span>
        <span className="track-row__play-icon"><Icon name={active && playing ? 'pause' : 'play'} size={16} /></span>
      </button>
      <Cover track={track} size="small" />
      <div className="track-row__title"><strong>{track.spotifyUrl ? <a className="spotify-track-link" href={track.spotifyUrl} target="_blank" rel="noreferrer" aria-label={`Open ${track.title} on Spotify`}>{track.title}<ArrowUpRight size={12} aria-hidden="true" /></a> : track.title}</strong><span>{track.artist}</span></div>
      <span className="track-row__album">{track.album || 'Single'}</span>
      {(likeScope === 'mix' || likeScope === 'spotify' || track.source !== 'spotify') && <button className={`icon-button track-row__like ${liked ? 'is-liked' : ''}`} type="button" aria-label={liked ? `Remove from ${likeScope === 'mix' ? 'Mix ' : ''}Liked Songs` : `Add to ${likeScope === 'mix' ? 'Mix ' : ''}Liked Songs`} title={likeScope === 'mix' ? 'Mix Liked Songs' : 'Spotify Liked Songs'} onClick={() => onLike(track)}><Icon name="heart" size={17} fill={liked ? 'currentColor' : 'none'} /></button>}
      <span className="track-row__duration">{formatTime(track.duration)}</span>
      {onMenu && <button className="icon-button track-row__more" type="button" aria-label={`More options for ${track.title}`} onClick={() => onMenu(track)}><Icon name="more" size={18} /></button>}
    </div>
  )
}

function TrackSkeleton() {
  return <div className="track-skeleton" aria-hidden="true"><i /><span><b /><small /></span><em /><em /></div>
}

function App() {
  const [clockNow, setClockNow] = useState(() => new Date())
  const [installPrompt, setInstallPrompt] = useState(null)
  const [installHelpOpen, setInstallHelpOpen] = useState(false)
  const [isInstalled, setIsInstalled] = useState(() => Boolean(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone))
  const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const [tracks, setTracks] = useState([])
  const [playlists, setPlaylists] = useState([])
  const [mixPlaylists, setMixPlaylists] = useState([])
  const [mixLikes, setMixLikes] = useState([])
  const [mixView, setMixView] = useState('collections')
  const [view, setView] = useState('home')
  const [viewHistory, setViewHistory] = useState(['home'])
  const [viewHistoryIndex, setViewHistoryIndex] = useState(0)
  const [search, setSearch] = useState('')
  const [current, setCurrent] = useState(() => {
    const saved = restorePlaybackSession(readPlaybackSession())
    return saved?.provider === 'spotify' ? saved.current : null
  })
  const currentTrackRef = useRef(current)
  currentTrackRef.current = current
  const [trackTextTransition, setTrackTextTransition] = useState(null)
  const [artworkCenter, setArtworkCenter] = useState(null)
  const [viewportSize, setViewportSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const [isViewportResizing, setIsViewportResizing] = useState(false)
  const [queue, setQueue] = useState(() => {
    const saved = restorePlaybackSession(readPlaybackSession())
    return saved?.provider === 'spotify' ? saved.queue : []
  })
  const [queueOrder, setQueueOrder] = useState(() => {
    const saved = restorePlaybackSession(readPlaybackSession())
    return saved?.provider === 'spotify' ? saved.queueOrder : []
  })
  const [queueLabel, setQueueLabel] = useState(() => {
    return restorePlaybackSession(readPlaybackSession())?.queueLabel || 'Library'
  })
  const [queueTrackCount, setQueueTrackCount] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [seekHover, setSeekHover] = useState(null)
  const [volume, setVolume] = useState(0.82)
  const [showVolumeSlider, setShowVolumeSlider] = useState(false)
  const lastAudibleVolumeRef = useRef(0.82)
  const volumeCloseTimerRef = useRef(null)
  const volumeControlRef = useRef(null)
  const [shuffle, setShuffle] = useState(false)
  const [repeatMode, setRepeatMode] = useState('off')
  const [showLibrary, setShowLibrary] = useState(false)
  const [libraryMounted, setLibraryMounted] = useState(false)
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [playlistDialog, setPlaylistDialog] = useState(null)
  const [playlistName, setPlaylistName] = useState('')
  const [loading, setLoading] = useState(true)
  const [spotifyConnected, setSpotifyConnected] = useState(hasSpotifySession())
  const [spotifyPlayerReady, setSpotifyPlayerReady] = useState(false)
  const [spotifyMode, setSpotifyMode] = useState(() => {
    const saved = restorePlaybackSession(readPlaybackSession())
    return saved?.provider === 'spotify' && saved.context?.type !== 'mix'
  })
  const [mixMode, setMixMode] = useState(() => {
    const saved = restorePlaybackSession(readPlaybackSession())
    return saved?.provider === 'spotify' && saved.context?.type === 'mix'
  })
  const [spotifyTracks, setSpotifyTracks] = useState([])
  const [spotifyCollectionTrackTotal, setSpotifyCollectionTrackTotal] = useState(0)
  const [spotifyHasMore, setSpotifyHasMore] = useState(false)
  const [spotifyLoadingMore, setSpotifyLoadingMore] = useState(false)
  const [spotifyListScroll, setSpotifyListScroll] = useState({ top: 0, height: 640 })
  const [spotifyPlaylists, setSpotifyPlaylists] = useState([])
  const [spotifyCollection, setSpotifyCollection] = useState('playlists')
  const [spotifyPlaybackContext, setSpotifyPlaybackContext] = useState(() => {
    const saved = restorePlaybackSession(readPlaybackSession())
    return saved?.provider === 'spotify' ? saved.context : null
  })
  const [localPlaybackContext, setLocalPlaybackContext] = useState(() => {
    const saved = restorePlaybackSession(readPlaybackSession())
    return saved?.provider === 'local' ? saved.context : null
  })
  const [spotifyWorking, setSpotifyWorking] = useState(false)
  const [spotifyPlaylistsLoading, setSpotifyPlaylistsLoading] = useState(false)
  const spotifyPlayerRef = useRef(null)
  const spotifyPaginationKeyRef = useRef('')
  const spotifyPageFlightRef = useRef('')
  const spotifyOffsetRef = useRef(0)
  const spotifyDeviceIdRef = useRef('')
  const spotifyDeviceActivationRef = useRef(null)
  const spotifyLoginCompletedRef = useRef(false)
  const spotifyHandledEndRef = useRef('')
  const spotifyEndCheckRef = useRef('')
  const spotifyObservedStateRef = useRef(null)
  const spotifyQueueActionsRef = useRef(null)
  const expectedSpotifyTrackRef = useRef(null)
  const expectedSpotifyTrackTimerRef = useRef(null)
  const currentQueuePositionRef = useRef(-1)
  const trackTextTransitionTimerRef = useRef(null)
  const trackTextTransitionIdRef = useRef(0)
  const resizeSettleTimerRef = useRef(null)

  useEffect(() => {
    if (showLibrary) {
      setLibraryMounted(true)
      return undefined
    }
    if (!libraryMounted) return undefined
    const timer = window.setTimeout(() => setLibraryMounted(false), 260)
    return () => window.clearTimeout(timer)
  }, [showLibrary, libraryMounted])
  const fileInput = useRef(null)
  const folderInput = useRef(null)
  const audioRef = useRef(null)
  const localAudioTrackIdRef = useRef(null)
  const pendingLocalSeekRef = useRef(0)
  const volumeRef = useRef(volume)
  const searchRef = useRef(null)
  const swipeStartRef = useRef(null)
  const swipeHandledRef = useRef(false)
  const mobileControlsTimerRef = useRef(null)
  const artworkWrapRef = useRef(null)
  const [mobileControlsVisible, setMobileControlsVisible] = useState(false)
  const [isArtworkDragging, setIsArtworkDragging] = useState(false)
  const [artworkDragDirection, setArtworkDragDirection] = useState(null)
  const artworkTapTimerRef = useRef(null)
  const artworkTapPositionRef = useRef(null)
  const spotifyPlaylistsRef = useRef([])

  useEffect(() => {
    const handleInstallPrompt = (event) => {
      event.preventDefault()
      setInstallPrompt(event)
    }
    const handleInstalled = () => {
      setIsInstalled(true)
      setInstallPrompt(null)
      setInstallHelpOpen(false)
    }
    window.addEventListener('beforeinstallprompt', handleInstallPrompt)
    window.addEventListener('appinstalled', handleInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt)
      window.removeEventListener('appinstalled', handleInstalled)
    }
  }, [])

  const requestAppInstall = async () => {
    if (!installPrompt) {
      setInstallHelpOpen(true)
      return
    }
    try {
      await installPrompt.prompt()
      await installPrompt.userChoice
    } catch {
      setInstallHelpOpen(true)
    } finally {
      setInstallPrompt(null)
    }
  }

  useEffect(() => { spotifyPlaylistsRef.current = spotifyPlaylists }, [spotifyPlaylists])

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const expectSpotifyTrack = (id, context = null) => {
    window.clearTimeout(expectedSpotifyTrackTimerRef.current)
    const expected = { id, context, expiresAt: Date.now() + 5000 }
    expectedSpotifyTrackRef.current = expected
    expectedSpotifyTrackTimerRef.current = window.setTimeout(() => {
      if (expectedSpotifyTrackRef.current === expected) expectedSpotifyTrackRef.current = null
    }, 5000)
  }
  const clearExpectedSpotifyTrack = (id) => {
    const expected = expectedSpotifyTrackRef.current
    if (!expected || (id && expected.id !== id)) return
    window.clearTimeout(expectedSpotifyTrackTimerRef.current)
    expectedSpotifyTrackRef.current = null
  }

  const openVolumeSlider = () => {
    window.clearTimeout(volumeCloseTimerRef.current)
    setShowVolumeSlider(true)
  }
  const scheduleVolumeSliderClose = (delay = 450) => {
    window.clearTimeout(volumeCloseTimerRef.current)
    volumeCloseTimerRef.current = window.setTimeout(() => {
      const control = volumeControlRef.current
      if (control?.matches(':hover, :focus-within')) return
      setShowVolumeSlider(false)
    }, delay)
  }

  const navigateToView = (nextView) => {
    setView(nextView)
    const next = [...viewHistory.slice(0, viewHistoryIndex + 1), nextView]
    setViewHistory(next)
    setViewHistoryIndex(next.length - 1)
  }

  const moveViewHistory = (direction) => {
    const nextIndex = Math.min(Math.max(viewHistoryIndex + direction, 0), viewHistory.length - 1)
    setViewHistoryIndex(nextIndex)
    setView(viewHistory[nextIndex])
  }

  useEffect(() => {
    Promise.all([readStore('tracks'), readStore('playlists'), readStore('mixPlaylists'), readStore('mixLikes')])
      .then(async ([rawTracks, savedPlaylists, rawMixPlaylists, rawMixLikes]) => {
        const fixTrack = (track) => track.source ? track : { ...track, source: 'local', playbackProvider: 'local' }
        const fixEntry = (entry) => {
          if (entry.source) return entry
          const source = entry.snapshot?.spotifyUri ? 'spotify' : 'local'
          return { ...entry, source, snapshot: entry.snapshot ? { ...entry.snapshot, source } : entry.snapshot }
        }
        const savedTracks = rawTracks.map(fixTrack)
        await Promise.all(rawTracks.filter((track) => !track.source).map((track) => writeStore('tracks', fixTrack(track))))
        const savedMixPlaylists = rawMixPlaylists.map((playlist) => (playlist.entries || []).some((entry) => !entry.source)
          ? { ...playlist, entries: playlist.entries.map(fixEntry) }
          : playlist)
        await Promise.all(savedMixPlaylists.filter((playlist, index) => playlist !== rawMixPlaylists[index]).map((playlist) => writeStore('mixPlaylists', playlist)))
        const staleLikes = rawMixLikes.filter((entry) => !entry.source)
        await Promise.all(staleLikes.map((entry) => removeStoreItem('mixLikes', entry.id)))
        const likesById = new Map()
        for (const entry of rawMixLikes) {
          const fixed = entry.source ? entry : { ...fixEntry(entry) }
          if (!entry.source) fixed.id = `${fixed.source}:${fixed.trackId}`
          likesById.set(fixed.id, fixed)
        }
        const savedMixLikes = [...likesById.values()]
        await Promise.all(savedMixLikes.filter((entry) => staleLikes.some((stale) => `${entry.source}:${entry.trackId}` === entry.id && stale.trackId === entry.trackId)).map((entry) => writeStore('mixLikes', entry)))
        const existingMixLikeIds = new Set(savedMixLikes.map((entry) => entry.id))
        const legacyLocalLikes = savedTracks.filter((track) => track.liked)
        const migratedMixLikes = legacyLocalLikes
          .map((track) => makeTrackReference(track))
          .filter((entry) => !existingMixLikeIds.has(entry.id))
          .map((entry) => ({ ...entry, likedAt: Date.now() }))
        const tracksWithoutLocalLikes = savedTracks.map((track) => track.liked ? { ...track, liked: false } : track)
        await Promise.all([
          ...migratedMixLikes.map((entry) => writeStore('mixLikes', entry)),
          ...legacyLocalLikes.map((track) => writeStore('tracks', { ...track, liked: false })),
        ])
        const orderedTracks = tracksWithoutLocalLikes.sort((a, b) => b.addedAt - a.addedAt)
        setTracks(orderedTracks)
        setPlaylists(savedPlaylists)
        setMixPlaylists(savedMixPlaylists)
        setMixLikes([...savedMixLikes, ...migratedMixLikes])

        const restored = restorePlaybackSession(readPlaybackSession(), { localTracks: orderedTracks })
        if (restored?.provider !== 'local' || !restored.current) return
        setCurrent(restored.current)
        setQueue(restored.queue)
        setQueueOrder(restored.queueOrder)
        setQueueLabel(restored.queueLabel)
        const playbackContext = restored.context?.type === 'favorites'
          ? { ...restored.context, type: 'mix', name: 'Liked Songs' }
          : restored.context
        setLocalPlaybackContext(playbackContext)
        setCurrentTime(restored.position)
        setDuration(restored.current.duration || 0)
        setIsPlaying(false)
        pendingLocalSeekRef.current = restored.position
        if (playbackContext?.type === 'mix') {
          if (!spotifyLoginCompletedRef.current) {
            setSpotifyMode(false)
            setMixMode(true)
          }
          setMixView(playbackContext.id ? `playlist:${playbackContext.id}` : playbackContext.name === 'Liked Songs' ? 'liked' : 'collections')
        } else if (restored.context?.type === 'playlist' && savedPlaylists.some((playlist) => playlist.id === restored.context.id)) {
          setView(`playlist:${restored.context.id}`)
        } else if (restored.context?.type === 'favorites') {
          setView('favorites')
        } else {
          setView('library')
        }
      })
      .catch(() => setMessage('Your browser could not open local library storage.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!current) return
    const context = current.source === 'spotify' ? spotifyPlaybackContext : localPlaybackContext
    const session = serializePlaybackSession({ current, queue, queueOrder, context, queueLabel, position: currentTime })
    if (session) savePlaybackSession(session)
  }, [current, queue, queueOrder, queueLabel, spotifyPlaybackContext, localPlaybackContext, currentTime])

  useEffect(() => {
    let active = true
    finishSpotifyLogin().then((completed) => {
      if (completed && active) {
        spotifyLoginCompletedRef.current = true
        setSpotifyConnected(true)
        setSpotifyMode(true)
        setMixMode(false)
        setSpotifyCollection('playlists')
        setShowLibrary(true)
        setMessage('Spotify connected. Loading your player…')
      }
    }).catch((error) => {
      if (active) setMessage(error.message || 'Spotify sign-in failed.')
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!spotifyConnected) return undefined
    let cancelled = false
    let player
    loadSpotifyPlaybackSdk().then((Spotify) => {
      if (cancelled) return
      player = new Spotify.Player({
        name: '5AM',
        volume: volumeRef.current,
        getOAuthToken: (callback) => getSpotifyAccessToken().then(callback).catch((error) => setMessage(error.message)),
      })
      spotifyPlayerRef.current = player
      player.addListener('ready', ({ device_id: deviceId }) => {
        spotifyDeviceIdRef.current = deviceId
        spotifyHandledEndRef.current = ''
        spotifyObservedStateRef.current = null
        setSpotifyPlayerReady(false)
        const promise = (async () => {
          let lastError
          for (let attempt = 0; attempt < 5; attempt += 1) {
            if (cancelled || spotifyDeviceIdRef.current !== deviceId) throw new Error('Spotify player connection changed. Please try again.')
            try {
              await spotifyFetch('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [deviceId], play: false }) })
              if (cancelled || spotifyDeviceIdRef.current !== deviceId) throw new Error('Spotify player connection changed. Please try again.')
              setSpotifyPlayerReady(true)
              return deviceId
            } catch (error) {
              lastError = error
              if (![404, 500, 502, 503].includes(error.status) || attempt === 4) throw error
              await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)))
            }
          }
          throw lastError || new Error('Spotify player could not become active.')
        })()
        spotifyDeviceActivationRef.current = { deviceId, promise }
        promise.catch((error) => {
          if (!cancelled && spotifyDeviceIdRef.current === deviceId) {
            setSpotifyPlayerReady(false)
            setMessage(error.message || 'Spotify player is ready, but could not become active.')
          }
        })
      })
      player.addListener('not_ready', ({ device_id: deviceId }) => {
        if (spotifyDeviceIdRef.current !== deviceId) return
        spotifyDeviceIdRef.current = ''
        spotifyDeviceActivationRef.current = null
        setSpotifyPlayerReady(false)
      })
      player.addListener('player_state_changed', (state) => {
        if (!state) return
        console.log('[5am] spotify state', { track: state.track_window?.current_track?.id, paused: state.paused, position: state.position, duration: state.duration, appCurrent: currentTrackRef.current?.id, appSource: currentTrackRef.current?.source, expected: expectedSpotifyTrackRef.current?.id })
        const activeTrack = state.track_window?.current_track
        if (activeTrack) {
          const track = normalizeSpotifyTrack(activeTrack)
          const previousState = spotifyObservedStateRef.current
          const eventPosition = state.position || 0
          const endedPositionReset = state.paused
            && previousState?.id === track.id
            && previousState.duration === (state.duration || 0)
            && previousState.position >= (state.duration || 0) - 1500
            && eventPosition < previousState.position
          if (!endedPositionReset) {
            spotifyObservedStateRef.current = {
              id: track.id,
              position: eventPosition,
              duration: state.duration || 0,
              paused: state.paused,
            }
          }
          const expected = expectedSpotifyTrackRef.current
          const requestedTrack = expected?.id === track.id && expected.expiresAt > Date.now()
          const savedSession = readPlaybackSession()
          const requestedContext = requestedTrack ? expected.context : null
          const isMixPlayback = requestedContext?.type === 'mix' || savedSession?.context?.type === 'mix'
          const appCurrentTrack = currentTrackRef.current
          const observedCurrent = spotifyObservedStateRef.current
          const currentTrackWasAtEnd = observedCurrent?.id === appCurrentTrack?.id
            && observedCurrent.duration > 0
            && observedCurrent.position >= observedCurrent.duration - 1500
          if (isMixPlayback && appCurrentTrack?.source === 'spotify' && appCurrentTrack.id !== track.id
            && currentTrackWasAtEnd && !requestedTrack) {
            if (expected?.id === 'local') return
            const actions = spotifyQueueActionsRef.current
            if (actions?.current?.id === appCurrentTrack.id && actions.repeatMode !== 'one' && spotifyHandledEndRef.current !== appCurrentTrack.id) {
              spotifyHandledEndRef.current = appCurrentTrack.id
              console.log('[5am] mix end via state_changed')
              actions.goToTrack(1)
            }
            return
          }
          if (currentTrackRef.current?.source !== 'spotify' && !requestedTrack) return
          if (spotifyHandledEndRef.current && spotifyHandledEndRef.current !== track.id) spotifyHandledEndRef.current = ''
          if (!state.paused && state.position < 3000 && spotifyHandledEndRef.current === track.id) spotifyHandledEndRef.current = ''
          if (expected && expected.expiresAt > Date.now()) {
            if (expected.id === 'local' || track.id !== expected.id) return
          }
          const contextUri = state.context?.uri || ''
          const savedContextMatchesTrack = savedSession?.source === 'spotify'
            && (savedSession.trackId === track.id || savedSession.queue?.some((item) => item.id === track.id))
          let playbackContext = requestedContext
          if (!playbackContext && contextUri.startsWith('spotify:playlist:')) {
            const playlistId = contextUri.split(':').at(-1)
            const playlist = spotifyPlaylistsRef.current.find((item) => item.id === playlistId)
            const cachedPlaylistName = savedSession?.context?.type === 'playlist' && savedSession.context.id === playlistId ? savedSession.context.name : ''
            const contextName = playlist?.name || state.context?.metadata?.context_description || cachedPlaylistName || 'Spotify Playlist'
            playbackContext = { type: 'playlist', id: playlistId, name: contextName, total: playlist?.total || savedSession?.context?.total || 0 }
          } else if (!playbackContext && contextUri.startsWith('spotify:album:')) {
            playbackContext = savedContextMatchesTrack && ['playlist', 'liked', 'mix', 'search'].includes(savedSession?.context?.type)
              ? savedSession.context
              : { type: 'album', name: track.album, total: track.albumTrackCount }
          } else if (!playbackContext && savedContextMatchesTrack && savedSession?.context) {
            playbackContext = savedSession.context
          } else if (!playbackContext) {
            playbackContext = { type: 'album', name: track.album, total: track.albumTrackCount }
          }
          const contextName = ['playlist', 'liked'].includes(playbackContext.type) ? playbackContext.name : playbackContext.name || track.album || 'Spotify'
          setSpotifyPlaybackContext(playbackContext)
          setQueueLabel(contextName)
          console.log('[5am] spotify state ACCEPTED, may overwrite current', track.id)
          setCurrent((existing) => existing?.id === track.id ? existing : track)
          setDuration(state.duration / 1000 || track.duration || 0)
          setCurrentTime(state.position / 1000 || 0)
          setIsPlaying(!state.paused)
          if (playbackContext.type !== 'mix') {
            setQueue((existing) => existing.some((item) => item.id === track.id) ? existing : [track])
            setQueueOrder((existing) => existing.some((item) => item.id === track.id) ? existing : [track])
          }
        }
      })
      player.addListener('initialization_error', ({ message: error }) => setMessage(`Spotify player: ${error}`))
      player.addListener('authentication_error', ({ message: error }) => { setMessage(`Spotify sign-in: ${error}`); setSpotifyConnected(false) })
      player.addListener('account_error', () => setMessage('Spotify playback needs an eligible Premium account.'))
      player.addListener('playback_error', ({ message: error }) => setMessage(`Spotify playback: ${error}`))
      player.connect().then((connected) => { if (!connected) setMessage('Spotify player could not connect. Try again.') })
    }).catch((error) => { if (!cancelled) setMessage(error.message || 'Spotify player could not load.') })
    return () => {
      cancelled = true
      if (player) player.disconnect()
      setSpotifyPlayerReady(false)
      if (spotifyPlayerRef.current === player) spotifyPlayerRef.current = null
      spotifyDeviceIdRef.current = ''
      spotifyDeviceActivationRef.current = null
      spotifyHandledEndRef.current = ''
      spotifyEndCheckRef.current = ''
      spotifyObservedStateRef.current = null
    }
  }, [spotifyConnected])

  useEffect(() => {
    if (current?.source !== 'spotify' || !spotifyPlayerReady) return undefined
    const player = spotifyPlayerRef.current
    if (!player) return undefined
    let disposed = false
    let pendingTrackId = ''
    let endCheckTimer = 0
    let polling = false

    const advanceQueueAtEnd = async (trackId) => {
      const actions = spotifyQueueActionsRef.current
      console.log('[5am] advanceQueueAtEnd', { trackId, current: actions?.current?.id })
      if (spotifyHandledEndRef.current === trackId || actions?.current?.id !== trackId || actions.repeatMode === 'one') return
      spotifyHandledEndRef.current = trackId
      if (actions.repeatMode === 'all' && actions.queue.length === 1) {
        await player.seek(0)
        await player.resume()
      } else {
        actions.goToTrack(1)
      }
    }

    const checkEnd = async () => {
      if (disposed || polling) return
      polling = true
      try {
        const state = await player.getCurrentState()
        if (disposed) return
        if (!state) {
          const observed = spotifyObservedStateRef.current
          if (observed?.id !== current.id || observed.duration <= 0 || observed.position < observed.duration - 1200
            || pendingTrackId === current.id || spotifyHandledEndRef.current === current.id) return
          pendingTrackId = current.id
          spotifyEndCheckRef.current = current.id
          endCheckTimer = window.setTimeout(async () => {
            pendingTrackId = ''
            if (spotifyEndCheckRef.current === current.id) spotifyEndCheckRef.current = ''
            try {
              const latest = await player.getCurrentState()
              if (disposed || latest) return
              const latestObserved = spotifyObservedStateRef.current
              if (latestObserved?.id === current.id && latestObserved.duration > 0 && latestObserved.position >= latestObserved.duration - 1200) {
                await advanceQueueAtEnd(current.id)
              }
            } catch (error) {
              if (!disposed) setMessage(error.message || 'Spotify could not start the next track.')
            }
          }, 850)
          return
        }
        const sdkTrack = state.track_window?.current_track
        if (!sdkTrack) return
        const trackId = `spotify:${sdkTrack.id}`
        const duration = state.duration || 0
        const position = state.position || 0
        if (trackId !== current.id) {
          const actions = spotifyQueueActionsRef.current
          const expected = expectedSpotifyTrackRef.current
          const isExpectedTrack = expected?.id === trackId && expected.expiresAt > Date.now()
          const observedCurrent = spotifyObservedStateRef.current
          const currentTrackWasAtEnd = observedCurrent?.id === current.id
            && observedCurrent.duration > 0
            && observedCurrent.position >= observedCurrent.duration - 1500
          if (!isExpectedTrack && expected?.id !== 'local' && readPlaybackSession()?.context?.type === 'mix'
            && actions?.current?.id === current.id && current.source === 'spotify'
            && currentTrackWasAtEnd && actions.repeatMode !== 'one' && spotifyHandledEndRef.current !== current.id) {
            spotifyHandledEndRef.current = current.id
            console.log('[5am] mix end via poll')
            actions.goToTrack(1)
          }
          return
        }
        const previousState = spotifyObservedStateRef.current
        spotifyObservedStateRef.current = { id: trackId, position, duration, paused: state.paused }
        setCurrentTime(position / 1000)
        if (duration > 0) setDuration(duration / 1000)
        setIsPlaying(!state.paused)
        const endedAfterProgress = previousState?.id === trackId
          && previousState.duration === duration
          && !previousState.paused
          && previousState.position >= duration - 1500
          && state.paused
        const atEnd = duration > 0 && (
          position >= duration - 1200
          || endedAfterProgress
          || (state.paused && previousState?.id === trackId && previousState.position >= duration - 1500)
        )
        if (!atEnd || pendingTrackId === trackId || spotifyHandledEndRef.current === trackId) return

        pendingTrackId = trackId
        spotifyEndCheckRef.current = trackId
        endCheckTimer = window.setTimeout(async () => {
          pendingTrackId = ''
          if (spotifyEndCheckRef.current === trackId) spotifyEndCheckRef.current = ''
          try {
            const latest = await player.getCurrentState()
            const latestTrack = latest?.track_window?.current_track
            if (disposed) return
            const observed = spotifyObservedStateRef.current
            const latestMatchesTrack = latest && `spotify:${latestTrack?.id}` === trackId
            if (latest && !latestMatchesTrack) return
            const latestNearEnd = latest?.duration > 0
              && (latest.position >= latest.duration - 1200
                || (latest.paused && observed?.id === trackId && observed.duration === latest.duration && observed.position >= latest.duration - 1500))
            const endedStateDisappeared = !latest
              && observed?.id === trackId
              && observed.duration > 0
              && observed.position >= observed.duration - 1200
            const stillAtEnd = latestNearEnd || endedStateDisappeared
            if (!stillAtEnd) return

            await advanceQueueAtEnd(trackId)
          } catch (error) {
            if (!disposed) setMessage(error.message || 'Spotify could not start the next track.')
          }
        }, 850)
      } catch {
        // A transient SDK state read should not interrupt playback.
      } finally {
        polling = false
      }
    }

    const interval = window.setInterval(checkEnd, 500)
    return () => {
      disposed = true
      window.clearInterval(interval)
      window.clearTimeout(endCheckTimer)
      if (spotifyEndCheckRef.current && spotifyEndCheckRef.current === pendingTrackId) spotifyEndCheckRef.current = ''
    }
  }, [current?.id, current?.source, spotifyPlayerReady])

  useEffect(() => {
    if (!spotifyMode || !spotifyConnected) return undefined
    const paginationKey = `${spotifyCollection}|${search.trim()}`
    spotifyPaginationKeyRef.current = paginationKey
    spotifyPageFlightRef.current = ''
    spotifyOffsetRef.current = 0
    setSpotifyHasMore(false)
    setSpotifyLoadingMore(false)
    if (spotifyCollection === 'playlists' && !search.trim()) {
      setSpotifyTracks([])
      setSpotifyCollectionTrackTotal(0)
      setSpotifyWorking(false)
      return undefined
    }
    setSpotifyWorking(true)
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setSpotifyWorking(true)
      try {
        let results = []
        let resultTotal = 0
        const savedResponse = await spotifyFetch('/me/tracks?limit=50&market=from_token')
        if (search.trim()) {
          const params = new URLSearchParams({ q: search.trim(), type: 'track', limit: '10', market: 'from_token' })
          const response = await spotifyFetch(`/search?${params}`)
          results = response.tracks.items
          resultTotal = results.length
        } else if (spotifyCollection !== 'liked') {
          const response = await spotifyFetch(`/playlists/${encodeURIComponent(spotifyCollection)}/items?limit=50&market=from_token`)
          results = response.items.map((entry) => entry.item || entry.track).filter((item) => item?.type === 'track' && item.id)
          resultTotal = response.total ?? results.length
        } else {
          results = savedResponse.items.map((item) => item.track).filter(Boolean)
          resultTotal = savedResponse.total ?? results.length
        }
        if (!cancelled) {
          setSpotifyCollectionTrackTotal(resultTotal)
          setSpotifyTracks(results.map(normalizeSpotifyTrack))
          if (!search.trim() && spotifyCollection === 'liked') {
            const nextOffset = savedResponse.items.length
            spotifyOffsetRef.current = nextOffset
            setSpotifyHasMore(nextOffset < (savedResponse.total ?? nextOffset))
          }
        }
      } catch (error) {
        if (!cancelled) {
          setSpotifyTracks([])
          setSpotifyCollectionTrackTotal(0)
          const isPlaylist = !search.trim() && spotifyCollection !== 'liked'
          setMessage(error.status === 403
            ? isPlaylist ? 'Spotify denied access to this playlist. Reconnect to grant playlist permissions; playlists owned by someone else may only open in Spotify.' : 'Spotify playlist access needs approval. Disconnect Spotify and reconnect to grant playlist access.'
            : error.message || 'Could not load Spotify music.')
        }
      } finally { if (!cancelled) setSpotifyWorking(false) }
    }, search.trim() ? 280 : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [spotifyMode, spotifyConnected, search, spotifyCollection])

  const loadMoreLikedSongs = useCallback(async () => {
    const paginationKey = `${spotifyCollection}|${search.trim()}`
    if (!spotifyMode || !spotifyConnected || spotifyCollection !== 'liked' || search.trim() || spotifyWorking) return
    if (spotifyPaginationKeyRef.current !== paginationKey || !spotifyHasMore || spotifyPageFlightRef.current === paginationKey) return
    const offset = spotifyOffsetRef.current
    if (offset <= 0) return
    if (offset >= spotifyCollectionTrackTotal) { setSpotifyHasMore(false); return }
    spotifyPageFlightRef.current = paginationKey
    setSpotifyLoadingMore(true)
    try {
      const response = await spotifyFetch(`/me/tracks?limit=50&offset=${offset}&market=from_token`)
      if (spotifyPaginationKeyRef.current !== paginationKey) return
      const page = response.items.map((item) => item.track).filter(Boolean).map(normalizeSpotifyTrack)
      setSpotifyTracks((existing) => {
        const existingIds = new Set(existing.map((track) => track.id))
        return [...existing, ...page.filter((track) => !existingIds.has(track.id))]
      })
      const nextOffset = offset + response.items.length
      spotifyOffsetRef.current = nextOffset
      setSpotifyCollectionTrackTotal(response.total ?? spotifyCollectionTrackTotal)
      setSpotifyHasMore(response.items.length > 0 && nextOffset < (response.total ?? nextOffset))
    } catch (error) {
      if (spotifyPaginationKeyRef.current === paginationKey) setMessage(error.message || 'Could not load more liked songs.')
    } finally {
      if (spotifyPageFlightRef.current === paginationKey) spotifyPageFlightRef.current = ''
      if (spotifyPaginationKeyRef.current === paginationKey) setSpotifyLoadingMore(false)
    }
  }, [spotifyMode, spotifyConnected, spotifyCollection, search, spotifyWorking, spotifyHasMore, spotifyCollectionTrackTotal])

  useEffect(() => {
    if (!spotifyMode || !spotifyConnected) return undefined
    let cancelled = false
    setSpotifyPlaylistsLoading(true)
    spotifyFetch('/me/playlists?limit=50').then((response) => {
      if (cancelled) return
      setSpotifyPlaylists(response.items.map((playlist) => ({
        id: playlist.id,
        name: playlist.name,
        total: playlist.items?.total ?? playlist.tracks?.total ?? 0,
        artworkUrl: playlist.images?.[0]?.url || '',
        spotifyUrl: playlist.external_urls?.spotify || '',
      })))
    }).catch((error) => {
      if (!cancelled) {
        setSpotifyPlaylists([])
        setMessage(error.status === 403 ? 'Spotify playlist access needs approval. Disconnect Spotify and reconnect to grant playlist access.' : error.message || 'Could not load Spotify playlists.')
      }
    }).finally(() => { if (!cancelled) setSpotifyPlaylistsLoading(false) })
    return () => { cancelled = true }
  }, [spotifyMode, spotifyConnected])

  useLayoutEffect(() => {
    const artwork = artworkWrapRef.current
    if (!artwork) return undefined
    const updateCenter = () => {
      const rect = artwork.getBoundingClientRect()
      setArtworkCenter((previous) => previous && previous.left === rect.left && previous.top === rect.top && previous.width === rect.width && previous.height === rect.height
        ? previous
        : { left: rect.left, top: rect.top, width: rect.width, height: rect.height })
    }
    const updateViewport = () => {
      const nextSize = { width: window.innerWidth, height: window.innerHeight }
      setViewportSize((previous) => previous.width === nextSize.width && previous.height === nextSize.height ? previous : nextSize)
      setIsViewportResizing(true)
      window.clearTimeout(resizeSettleTimerRef.current)
      resizeSettleTimerRef.current = window.setTimeout(() => setIsViewportResizing(false), 140)
      updateCenter()
    }
    updateCenter()
    updateViewport()
    const observer = new ResizeObserver(updateCenter)
    observer.observe(artwork)
    window.addEventListener('resize', updateViewport)
    window.visualViewport?.addEventListener('resize', updateViewport)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateViewport)
      window.visualViewport?.removeEventListener('resize', updateViewport)
      window.clearTimeout(resizeSettleTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return undefined
    if (current?.source !== 'local' || !current.blob) {
      localAudioTrackIdRef.current = null
      audio.pause()
      audio.removeAttribute('src')
      console.log('[5am] audio src cleared', current?.id, current?.source)
      audio.load()
      return undefined
    }
    const playableBlob = current.blob.type
      ? current.blob
      : new Blob([current.blob], { type: current.type || 'audio/mpeg' })
    const source = URL.createObjectURL(playableBlob)
    localAudioTrackIdRef.current = current.id
    audio.src = source
    console.log('[5am] audio src set', { id: current.id, blobType: playableBlob.type, size: playableBlob.size })
    audio.load()
    return () => {
      if (localAudioTrackIdRef.current === current.id) localAudioTrackIdRef.current = null
      URL.revokeObjectURL(source)
    }
  }, [current?.id])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !current) return
    console.log('[5am] play effect', { isPlaying, id: current?.id, source: current?.source })
    if (current.source === 'spotify') { audio.pause(); return undefined }
    let frame = 0
    if (isPlaying) {
      audio.volume = volumeRef.current
      audio.play().catch((error) => {
        if (error?.name === 'AbortError') { console.warn('[5am] play() aborted', current?.id); return }
        console.error('local audio play() failed', error?.name, error?.message, current)
        setIsPlaying(false)
        setMessage(error?.name === 'NotAllowedError'
          ? 'Tap play to continue with this local track.'
          : 'This file could not be played by your browser.')
      })
    } else if (!audio.paused) {
      const startVolume = audio.volume
      const startTime = performance.now()
      const fadeDown = (now) => {
        const progress = Math.min((now - startTime) / 280, 1)
        audio.volume = Math.max(0, startVolume * (1 - progress) ** 2)
        if (progress < 1) frame = requestAnimationFrame(fadeDown)
        else { audio.pause(); audio.volume = volumeRef.current }
      }
      frame = requestAnimationFrame(fadeDown)
    }
    return () => { if (frame) cancelAnimationFrame(frame) }
  }, [isPlaying, current?.id])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return undefined
    const originalPause = audio.pause.bind(audio)
    const originalLoad = audio.load.bind(audio)
    audio.pause = () => { console.trace('[5am] audio.pause() called'); return originalPause() }
    audio.load = () => { console.trace('[5am] audio.load() called'); return originalLoad() }
    const eventTypes = ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'pause', 'emptied', 'stalled', 'abort', 'error', 'ended']
    const logAudioEvent = (event) => console.log('[5am] audio event', event.type, { readyState: audio.readyState, networkState: audio.networkState, paused: audio.paused, currentTime: audio.currentTime, hasSrc: Boolean(audio.getAttribute('src')) })
    eventTypes.forEach((eventType) => audio.addEventListener(eventType, logAudioEvent))
    return () => {
      eventTypes.forEach((eventType) => audio.removeEventListener(eventType, logAudioEvent))
      audio.pause = originalPause
      audio.load = originalLoad
    }
  }, [])

  useEffect(() => {
    console.log('[5am] state', { current: current?.id, source: current?.source, isPlaying })
  }, [isPlaying, current?.id])

  useEffect(() => {
    volumeRef.current = volume
    if (audioRef.current) audioRef.current.volume = volume
    if (spotifyPlayerRef.current) spotifyPlayerRef.current.setVolume(volume).catch(() => {})
  }, [volume, current?.id])

  useEffect(() => { document.title = '5AM' }, [])

  useEffect(() => {
    if (!message) return undefined
    const timer = window.setTimeout(() => setMessage(''), 4200)
    return () => window.clearTimeout(timer)
  }, [message])

  const exactCurrentIndex = queue.indexOf(current)
  const retainedCurrentIndex = queue[currentQueuePositionRef.current]?.id === current?.id ? currentQueuePositionRef.current : -1
  const currentIndex = exactCurrentIndex >= 0 ? exactCurrentIndex : retainedCurrentIndex >= 0 ? retainedCurrentIndex : queue.findIndex((track) => track.id === current?.id)
  const canGoToPreviousTrack = Boolean(current && currentIndex > 0)
  const canGoToNextTrack = Boolean(current && currentIndex >= 0 && (currentIndex < queue.length - 1 || repeatMode !== 'off'))
  useEffect(() => { currentQueuePositionRef.current = currentIndex }, [currentIndex])
  const carouselTracks = useMemo(() => {
    if (currentIndex < 0 || !queue.length) return []
    if (repeatMode !== 'off' && queue.length > 1) {
      const seenPositions = new Set()
      return [0, -1, 1, -2, 2].flatMap((offset) => {
        const queueIndex = (currentIndex + offset + queue.length) % queue.length
        if (seenPositions.has(queueIndex)) return []
        seenPositions.add(queueIndex)
        return [{ track: queue[queueIndex], offset, queueIndex }]
      }).sort((a, b) => a.offset - b.offset)
    }
    const start = Math.min(Math.max(currentIndex - 2, 0), Math.max(queue.length - 5, 0))
    return queue.slice(start, start + 5).map((track, index) => ({ track, offset: start + index - currentIndex, queueIndex: start + index }))
  }, [queue, currentIndex, repeatMode])
  const viewportWidth = viewportSize.width
  const viewportHeight = viewportSize.height
  const peekSize = artworkCenter?.width || (viewportWidth <= 700
    ? Math.max(170, Math.min(viewportWidth * .88, 380))
    : Math.max(180, Math.min(viewportWidth * .17, 280)))
  const cardPosition = (offset) => {
    const centerX = artworkCenter ? artworkCenter.left + artworkCenter.width / 2 : viewportWidth / 2
    const centerY = artworkCenter ? artworkCenter.top + artworkCenter.height / 2 : viewportHeight / 2
    const centerScale = artworkCenter ? artworkCenter.width / peekSize : 1
    const x = centerX
    const y = offset === 0 ? centerY : offset < 0
      ? -((Math.abs(offset) - 1) * viewportHeight) - peekSize * .34
      : offset * viewportHeight + peekSize * (offset === 1 ? .24 : .34)
    const scaleX = offset === 0 ? centerScale : 1
    const scaleY = offset === 0 ? centerScale : 1
    return { '--card-x': `${x}px`, '--card-y': `${y}px`, '--card-scale-x': scaleX, '--card-scale-y': scaleY, '--card-opacity': Math.abs(offset) === 1 ? .68 : 0, '--peek-size': `${peekSize}px` }
  }
  const isMixLiked = (track) => Boolean(track && mixLikes.some((entry) => entry.source === track.source && entry.trackId === track.id))

  const revealMobileControls = () => {
    setMobileControlsVisible(true)
    window.clearTimeout(mobileControlsTimerRef.current)
    mobileControlsTimerRef.current = window.setTimeout(() => setMobileControlsVisible(false), 3000)
  }

  useEffect(() => () => {
    window.clearTimeout(mobileControlsTimerRef.current)
    window.clearTimeout(artworkTapTimerRef.current)
  }, [])

  const startArtworkSwipe = (event) => {
    if (event.pointerType !== 'touch' || event.target.closest?.('.mobile-art-controls')) return
    swipeHandledRef.current = false
    swipeStartRef.current = { x: event.clientX, y: event.clientY }
    setArtworkDragDirection(null)
    event.currentTarget.style.setProperty('--drag-y', '0px')
    setIsArtworkDragging(true)
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
  }
  const moveArtworkSwipe = (event) => {
    const start = swipeStartRef.current
    if (!start) return
    const deltaX = event.clientX - start.x
    const deltaY = event.clientY - start.y
    if (Math.abs(deltaY) <= Math.abs(deltaX) * 1.1) return
    const cardHeight = event.currentTarget.getBoundingClientRect().height
    const boundedDeltaY = Math.max(-cardHeight, Math.min(cardHeight, deltaY))
    setArtworkDragDirection(deltaY < 0 ? 'next' : 'previous')
    event.currentTarget.style.setProperty('--drag-y', `${boundedDeltaY}px`)
    const cards = event.currentTarget.parentElement?.querySelectorAll('.carousel-card')
    cards?.forEach((card) => {
      if (card === event.currentTarget) return
      if (card.classList.contains('carousel-card--previous') || card.classList.contains('carousel-card--next')) card.style.setProperty('--drag-y', `${boundedDeltaY}px`)
      else card.style.removeProperty('--drag-y')
    })
  }
  const endArtworkSwipe = (event) => {
    const start = swipeStartRef.current
    swipeStartRef.current = null
    if (start) {
      const deltaX = event.clientX - start.x
      const deltaY = event.clientY - start.y
      if (Math.abs(deltaY) > 48 && Math.abs(deltaY) > Math.abs(deltaX) * 1.25) {
        swipeHandledRef.current = true
        window.setTimeout(() => { swipeHandledRef.current = false }, 450)
        goToTrack(deltaY < 0 ? 1 : -1)
      }
    }
    setIsArtworkDragging(false)
    setArtworkDragDirection(null)
    const card = event.currentTarget
    window.requestAnimationFrame(() => {
      card.parentElement?.querySelectorAll('.carousel-card').forEach((item) => item.style.removeProperty('--drag-y'))
    })
  }
  const cancelArtworkSwipe = (event) => {
    swipeStartRef.current = null
    setIsArtworkDragging(false)
    setArtworkDragDirection(null)
    const card = event.currentTarget
    window.requestAnimationFrame(() => {
      card.parentElement?.querySelectorAll('.carousel-card').forEach((item) => item.style.removeProperty('--drag-y'))
    })
  }

  const filteredTracks = useMemo(() => {
    let result = tracks
    if (view === 'favorites') result = result.filter((track) => track.liked)
    if (view.startsWith('playlist:')) {
      const playlist = playlists.find((item) => item.id === view.slice('playlist:'.length))
      const tracksById = new Map(tracks.map((track) => [track.id, track]))
      result = (playlist?.trackIds || []).flatMap((trackId, index) => {
        const track = tracksById.get(trackId)
        return track ? [{ ...track, playlistEntryId: playlist.entryIds?.[index] || `${playlist.id}:${trackId}:${index}` }] : []
      })
    }
    const query = search.trim().toLowerCase()
    if (query) result = result.filter((track) => `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(query))
    return result
  }, [tracks, playlists, view, search])

  const resolveMixEntry = (entry) => {
    const source = entry.source === 'spotify' || entry.snapshot?.spotifyUri ? 'spotify' : 'local'
    const available = source === 'spotify' ? spotifyTracks : tracks
    const track = available.find((item) => item.id === entry.trackId) || (source === 'local' ? null : entry.snapshot)
    if (!track) return null
    return {
      ...track,
      source,
      ...(source === 'local' ? { playbackProvider: 'local' } : {}),
      playlistEntryId: entry.id,
    }
  }
  const mixLikedTracks = []
  mixLikes.forEach((entry) => {
    const track = resolveMixEntry(entry)
    if (track && !mixLikedTracks.some((item) => item.source === track.source && item.id === track.id)) mixLikedTracks.push(track)
  })
  const selectedMixPlaylist = mixPlaylists.find((playlist) => playlist.id === mixView.slice('playlist:'.length))
  const mixBaseTracks = mixView === 'liked'
    ? mixLikedTracks
    : mixView === 'collections'
      ? [...tracks, ...spotifyTracks]
      : selectedMixPlaylist?.entries?.map(resolveMixEntry).filter(Boolean) || []
  const mixDisplayTracks = mixBaseTracks.filter((track) => !search.trim() || `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(search.trim().toLowerCase()))
  const displayTracks = mixMode ? mixDisplayTracks : spotifyMode ? spotifyTracks : filteredTracks
  const selectedSpotifyPlaylist = spotifyPlaylists.find((playlist) => playlist.id === spotifyCollection)
  const isSpotifyLikedList = spotifyMode && spotifyConnected && spotifyCollection === 'liked' && !search.trim()
  const virtualLikedCount = isSpotifyLikedList
    ? Math.max(spotifyCollectionTrackTotal, spotifyTracks.length, spotifyWorking && !spotifyTracks.length ? 10 : 0)
    : 0
  const virtualRowHeight = 62
  const virtualLikedStart = Math.max(0, Math.floor(spotifyListScroll.top / virtualRowHeight) - 8)
  const virtualLikedEnd = Math.min(virtualLikedCount, Math.max(10, Math.ceil((spotifyListScroll.top + spotifyListScroll.height) / virtualRowHeight) + 8))
  const virtualLikedRows = Array.from({ length: Math.max(0, virtualLikedEnd - virtualLikedStart) }, (_, index) => virtualLikedStart + index)
  const drawerListRef = useRef(null)
  useEffect(() => {
    if (drawerListRef.current) drawerListRef.current.scrollTop = 0
    setSpotifyListScroll({ top: 0, height: drawerListRef.current?.clientHeight || 640 })
  }, [spotifyCollection, search, spotifyMode, mixMode, mixView])
  useEffect(() => {
    if (isSpotifyLikedList && spotifyHasMore && !spotifyLoadingMore && spotifyTracks.length < Math.min(spotifyCollectionTrackTotal, virtualLikedEnd + 10)) {
      loadMoreLikedSongs()
    }
  }, [isSpotifyLikedList, spotifyHasMore, spotifyLoadingMore, spotifyTracks.length, spotifyCollectionTrackTotal, virtualLikedEnd, loadMoreLikedSongs])
  const libraryBadgeCount = (spotifyPlaybackContext?.type === 'mix' || localPlaybackContext?.type === 'mix')
    ? queue.length
    : current?.source === 'spotify'
    ? spotifyPlaybackContext?.type === 'playlist' || spotifyPlaybackContext?.type === 'liked'
      ? spotifyPlaybackContext.total || queue.length
      : spotifyPlaybackContext?.type === 'album'
        ? spotifyPlaybackContext.total || current.albumTrackCount || queue.length
        : spotifyPlaybackContext?.type === 'search'
          ? queue.length
          : current.albumTrackCount || queue.length
    : mixMode
      ? mixView === 'liked' ? mixLikedTracks.length : selectedMixPlaylist?.entries.length ?? mixLikedTracks.length
    : spotifyMode
      ? selectedSpotifyPlaylist?.total ?? spotifyCollectionTrackTotal ?? spotifyTracks.length
      : current
      ? queue.length
      : view === 'favorites'
        ? tracks.filter((track) => track.liked).length
        : view.startsWith('playlist:')
          ? playlists.find((playlist) => playlist.id === view.slice(9))?.trackIds.length ?? 0
          : tracks.length
  const topbarLabel = current?.source === 'spotify'
    ? spotifyPlaybackContext?.name || (queueLabel !== 'Library' ? queueLabel : current.album || queueLabel)
    : queueLabel

  const title = useMemo(() => {
    if (mixMode) return search.trim() ? 'Mix Search' : mixView === 'collections' ? 'Mix playlists' : mixView === 'liked' ? 'Liked Songs' : selectedMixPlaylist?.name || 'Mix playlist'
    if (spotifyMode) return search.trim() ? 'Spotify Search' : spotifyCollection === 'playlists' ? 'Spotify Playlists' : spotifyCollection === 'liked' ? 'Liked Songs' : selectedSpotifyPlaylist?.name || 'Spotify'
    if (view === 'home' || view === 'collections') return 'Your library'
    if (view === 'library') return 'All music'
    if (view === 'favorites') return 'Favorites'
    if (view.startsWith('playlist:')) return playlists.find((item) => item.id === view.slice(9))?.name || 'Playlist'
    return 'Your listening room'
  }, [view, playlists, spotifyMode, mixMode, mixView, selectedMixPlaylist, search, spotifyCollection, selectedSpotifyPlaylist])

  const resetSingleTrackRepeat = (nextTrack) => {
    if (repeatMode !== 'one' || nextTrack?.id === current?.id) return false
    setRepeatMode('all')
    return true
  }

  const playTrack = useCallback((track, source = filteredTracks, sourceLabel, sourceContext = null) => {
    const unlockAudio = audioRef.current
    if (unlockAudio && track?.source === 'spotify' && unlockAudio.paused && !unlockAudio.getAttribute('src')) {
      unlockAudio.muted = true
      unlockAudio.play().catch(() => {})
      unlockAudio.pause()
      unlockAudio.muted = false
    }
    if (track?.source === 'spotify' && track.playable === false) {
      setMessage('This track is unavailable in your Spotify market.')
      return
    }
    window.clearTimeout(trackTextTransitionTimerRef.current)
    setTrackTextTransition(null)
    const resetSpotifyRepeat = resetSingleTrackRepeat(track)
    pendingLocalSeekRef.current = 0
    const playableSource = source.filter((item) => item.source !== 'spotify' || item.playable !== false)
    const nextQueue = playableSource.length ? playableSource : tracks
    const playbackQueue = shuffle ? shuffledFromTrack(nextQueue, track) : nextQueue
    setQueueOrder(nextQueue)
    setQueue(playbackQueue)
    const activePlaylist = view.startsWith('playlist:') ? playlists.find((item) => item.id === view.slice('playlist:'.length)) : null
    if (track.source === 'spotify') {
      const context = sourceContext || { type: 'album', name: track.album, total: track.albumTrackCount }
      setSpotifyPlaybackContext(context)
      setLocalPlaybackContext(context.type === 'mix' ? context : null)
      setQueueLabel(['playlist', 'liked', 'album', 'mix'].includes(context.type) ? context.name : track.album || sourceLabel || 'Spotify')
    } else {
      setSpotifyPlaybackContext(null)
      const localContext = sourceContext || (activePlaylist
        ? { type: 'playlist', id: activePlaylist.id, name: activePlaylist.name, total: playableSource.length }
        : view === 'favorites'
          ? { type: 'favorites', name: 'Favorites', total: playableSource.length }
          : { type: 'library', name: sourceLabel || 'Library', total: playableSource.length })
      setLocalPlaybackContext(localContext)
      if (localContext.type === 'mix') setSpotifyPlaybackContext(localContext)
      setQueueLabel(sourceLabel || activePlaylist?.name || (view === 'favorites' ? 'Favorites' : 'Library'))
    }
    setCurrent(track)
    setIsPlaying(true)
    setCurrentTime(0)
    setDuration(0)
    if (track.source === 'spotify') {
      const context = sourceContext || { type: 'album', name: track.album, total: track.albumTrackCount }
      expectSpotifyTrack(track.id, context)
      const activation = spotifyDeviceActivationRef.current
      if (!activation) { setMessage('Spotify player is reconnecting. Try again when it shows connected.'); return }
      activation.promise.then((deviceId) => spotifyFetch(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, { method: 'PUT', body: JSON.stringify(spotifyPlayRequest(track, playbackQueue, sourceContext || { type: 'album', name: track.album, total: track.albumTrackCount })) }))
        .then(() => resetSpotifyRepeat || context.type === 'mix'
          ? spotifyFetch(`/me/player/repeat?state=${spotifyRepeatState(resetSpotifyRepeat ? 'all' : repeatMode, context)}`, { method: 'PUT' })
          : undefined)
        .catch((error) => { clearExpectedSpotifyTrack(track.id); setIsPlaying(false); setMessage(error.message || 'Spotify could not start playback.') })
    } else if (current?.source === 'spotify') {
      expectSpotifyTrack('local')
      spotifyFetch('/me/player/repeat?state=off', { method: 'PUT' }).catch(() => {})
      spotifyPlayerRef.current?.pause().catch(() => spotifyFetch('/me/player/pause', { method: 'PUT' }).catch(() => {}))
    }
  }, [filteredTracks, tracks, view, playlists, shuffle, current, repeatMode, spotifyPlaybackContext, localPlaybackContext])

  const animateToTrack = useCallback((requested, direction = 1) => {
    if (!requested) return
    let track = requested
    if (requested.source !== 'spotify' && !requested.blob) {
      const stored = tracks.find((item) => item.id === requested.id)
      console.log('[5am] repairing blob-less track', requested.id, 'found in library:', Boolean(stored))
      if (stored) track = { ...stored, source: 'local', playbackProvider: 'local', playlistEntryId: requested.playlistEntryId }
    }
    if (track.source !== 'spotify' && !track.blob) {
      setMessage(`"${track.title}" is missing from your local library.`)
      return
    }
    console.log('[5am] animateToTrack', { from: current?.id, fromSource: current?.source, to: track.id, toSource: track.source, hasBlob: Boolean(track.blob), blobType: track.blob?.type, blobSize: track.blob?.size, sameAsCurrent: track === current })
    if (track === current) {
      setCurrentTime(0)
      setIsPlaying(true)
      if (track.source === 'local' && audioRef.current) {
        audioRef.current.currentTime = 0
        audioRef.current.play().catch(() => setMessage('This file could not be played by your browser.'))
      }
      return
    }
    if (current && track.id !== current.id) {
      window.clearTimeout(trackTextTransitionTimerRef.current)
      const id = ++trackTextTransitionIdRef.current
      setTrackTextTransition({ from: current, to: track, direction: direction < 0 ? 'down' : 'up', id })
      trackTextTransitionTimerRef.current = window.setTimeout(() => {
        setTrackTextTransition((transition) => transition?.id === id ? null : transition)
      }, 460)
    }
    const resetSpotifyRepeat = resetSingleTrackRepeat(track)
    const mixedContext = spotifyPlaybackContext?.type === 'mix' ? spotifyPlaybackContext : localPlaybackContext?.type === 'mix' ? localPlaybackContext : null
    if (mixedContext) {
      setSpotifyPlaybackContext(mixedContext)
      setLocalPlaybackContext(mixedContext)
      setQueueLabel(mixedContext.name)
    }
    pendingLocalSeekRef.current = 0
    setCurrent(track)
    setIsPlaying(true)
    setCurrentTime(0)
    setDuration(0)
    if (track.source === 'spotify') {
      expectSpotifyTrack(track.id, mixedContext || spotifyPlaybackContext)
      const activation = spotifyDeviceActivationRef.current
      if (!activation) { setMessage('Spotify player is reconnecting. Try again when it shows connected.'); return }
      activation.promise.then((deviceId) => spotifyFetch(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, { method: 'PUT', body: JSON.stringify(spotifyPlayRequest(track, queue, mixedContext || spotifyPlaybackContext)) }))
        .then(() => resetSpotifyRepeat
          ? spotifyFetch(`/me/player/repeat?state=${spotifyRepeatState('all', mixedContext || spotifyPlaybackContext)}`, { method: 'PUT' })
          : undefined)
        .catch((error) => { clearExpectedSpotifyTrack(track.id); setIsPlaying(false); setMessage(error.message || 'Spotify could not start playback.') })
    } else if (current?.source === 'spotify') {
      expectSpotifyTrack('local')
      spotifyFetch('/me/player/repeat?state=off', { method: 'PUT' }).catch(() => {})
      spotifyPlayerRef.current?.pause().catch(() => spotifyFetch('/me/player/pause', { method: 'PUT' }).catch(() => {}))
    }
  }, [current, repeatMode, spotifyPlaybackContext, localPlaybackContext, tracks])

  const goToTrack = useCallback((direction, selectedTrack) => {
    if (!queue.length || currentIndex < 0) {
      console.log('[5am] goToTrack early return', { queueLength: queue.length, currentIndex })
      return
    }
    console.log('[5am] goToTrack', { direction, currentIndex, queueLength: queue.length, next: queue[currentIndex + direction]?.id, nextSource: queue[currentIndex + direction]?.source, repeatMode })
    if (selectedTrack) { animateToTrack(selectedTrack, direction); return }
    const nextIndex = currentIndex + direction
    if (nextIndex < 0) { animateToTrack(queue[0], direction); return }
    if (nextIndex >= queue.length) {
      if (repeatMode !== 'off') animateToTrack(queue[0], direction)
      else {
        console.trace('[5am] setIsPlaying(false) from goToTrack end of queue')
        setIsPlaying(false)
      }
      return
    }
    animateToTrack(queue[nextIndex], direction)
  }, [queue, currentIndex, repeatMode, animateToTrack])

  useEffect(() => {
    spotifyQueueActionsRef.current = { current, queue, repeatMode, goToTrack }
  }, [current, queue, repeatMode, goToTrack])

  const toggleShuffle = () => {
    const nextShuffle = !shuffle
    setShuffle(nextShuffle)
    if (nextShuffle && current && queue.length > 1) setQueue(shuffledFromTrack(queueOrder.length ? queueOrder : queue, current))
    else if (!nextShuffle && queueOrder.length) setQueue(queueOrder)
    if (current?.source === 'spotify') spotifyFetch(`/me/player/shuffle?state=${nextShuffle}`, { method: 'PUT' }).catch((error) => setMessage(error.message))
  }

  const cycleRepeatMode = () => {
    const nextMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off'
    setRepeatMode(nextMode)
    if (current?.source === 'spotify') {
      const context = spotifyPlaybackContext?.type === 'mix' ? spotifyPlaybackContext : localPlaybackContext?.type === 'mix' ? localPlaybackContext : spotifyPlaybackContext
      spotifyFetch(`/me/player/repeat?state=${spotifyRepeatState(nextMode, context)}`, { method: 'PUT' }).catch((error) => setMessage(error.message))
    }
  }

  const togglePlayback = () => {
    if (current?.source !== 'spotify') { setIsPlaying((value) => !value); return }
    const method = isPlaying ? 'pause' : 'resume'
    spotifyPlayerRef.current?.[method]().then(() => setIsPlaying(!isPlaying)).catch((error) => setMessage(error.message || 'Spotify playback could not be changed.'))
  }

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }

      const target = event.target instanceof HTMLElement ? event.target : null
      const isEditable = target && (target.isContentEditable || ['TEXTAREA', 'SELECT'].includes(target.tagName) || (target.tagName === 'INPUT' && target.type !== 'range'))
      if (isEditable || event.altKey || event.shiftKey) return

      if (event.code === 'Space') {
        if (event.repeat) return
        if (target?.closest('button, a, [role="button"], [role="tab"]')) return
        event.preventDefault()
        if (current) togglePlayback()
        return
      }

      if (event.ctrlKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault()
        if (current) goToTrack(event.key === 'ArrowRight' ? 1 : -1)
        return
      }

      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        const nextVolume = Math.max(0, Math.min(1, volume + (event.key === 'ArrowUp' ? 0.05 : -0.05)))
        if (nextVolume > 0) lastAudibleVolumeRef.current = nextVolume
        setVolume(nextVolume)
        openVolumeSlider()
        scheduleVolumeSliderClose(1500)
        return
      }

      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && current) {
        event.preventDefault()
        const offset = event.key === 'ArrowRight' ? 5 : -5
        const nextTime = Math.max(0, Math.min(duration || 0, currentTime + offset))
        if (current.source === 'spotify') spotifyPlayerRef.current?.seek(nextTime * 1000).catch((error) => setMessage(error.message || 'Spotify could not seek.'))
        else if (audioRef.current) audioRef.current.currentTime = nextTime
        setCurrentTime(nextTime)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [current, currentTime, duration, volume, togglePlayback, goToTrack])

  const connectSpotify = async () => {
    try { await startSpotifyLogin(getSpotifyClientId()) }
    catch (error) { setMessage(error.message || 'Could not start Spotify sign-in.') }
  }

  const disconnectSpotify = () => {
    clearSpotifySession()
    clearExpectedSpotifyTrack()
    if (current?.source === 'spotify') savePlaybackSession(null)
    spotifyPlayerRef.current?.disconnect()
    spotifyPlayerRef.current = null
    spotifyDeviceIdRef.current = ''
    setSpotifyConnected(false)
    setSpotifyPlayerReady(false)
    setSpotifyMode(false)
    setSpotifyPlaybackContext(null)
    setSpotifyTracks([])
    setSpotifyPlaylists([])
    setSpotifyPlaylistsLoading(false)
    setSpotifyCollection('playlists')
    if (current?.source === 'spotify') { setCurrent(null); setQueue([]); setQueueOrder([]); setIsPlaying(false); setCurrentTime(0); setDuration(0); setQueueLabel('Library') }
    setMessage('Spotify disconnected.')
  }

  const importFiles = async (fileList, fromFolder = false) => {
    const files = [...(fileList || [])].filter((file) => file.type.startsWith('audio/') || AUDIO_EXTENSIONS.test(file.name))
    if (!files.length) { setMessage('No supported audio files found. Try MP3, M4A, FLAC, OGG, WAV, or AAC.'); return }
    setAdding(true)
    let imported = 0
    const knownIds = new Set(tracks.map((track) => track.id))
    try {
      const folderPlaylists = fromFolder ? makeFolderPlaylists(files) : []
      for (const file of files) {
        const id = makeId(file)
        if (knownIds.has(id)) continue
        knownIds.add(id)
        const { title: trackTitle, artist } = parseTrackName(file)
        const track = { id, source: 'local', playbackProvider: 'local', title: trackTitle, artist, album: file.webkitRelativePath?.split('/').slice(-2, -1)[0] || 'Local collection', fileName: file.name, relativePath: file.webkitRelativePath || file.name, type: file.type || 'audio/mpeg', size: file.size, addedAt: Date.now(), duration: await readDuration(file), blob: file, liked: false }
        await writeStore('tracks', track)
        setTracks((existing) => [track, ...existing])
        imported++
      }
      if (folderPlaylists.length) {
        const existingByPath = new Map(playlists.filter((playlist) => playlist.source === 'folder-import').map((playlist) => [playlist.folderPath, playlist]))
        const updatedFolderPlaylists = folderPlaylists.map((playlist) => {
          const existing = existingByPath.get(playlist.folderPath)
          return existing ? { ...existing, name: playlist.name, trackIds: playlist.trackIds, entryIds: undefined } : playlist
        })
        await Promise.all(updatedFolderPlaylists.map((playlist) => writeStore('playlists', playlist)))
        setPlaylists((existing) => {
          const byId = new Map(existing.map((playlist) => [playlist.id, playlist]))
          for (const playlist of updatedFolderPlaylists) byId.set(playlist.id, playlist)
          return [...byId.values()]
        })
      }
      navigateToView('library')
      const playlistCount = folderPlaylists.length
      if (fromFolder && playlistCount) {
        setMessage(`${imported ? `${imported} ${imported === 1 ? 'track' : 'tracks'} added. ` : ''}${playlistCount} ${playlistCount === 1 ? 'folder playlist' : 'folder playlists'} added to your library.`)
      } else {
        setMessage(imported ? `${imported} ${imported === 1 ? 'track added' : 'tracks added'} to your library.` : 'Those tracks are already in your library.')
      }
    } catch (error) {
      console.error(error)
      setMessage('The library could not save these files. Your browser may be low on storage.')
    } finally {
      setAdding(false)
      if (fileInput.current) fileInput.current.value = ''
      if (folderInput.current) folderInput.current.value = ''
    }
  }

  const toggleMixLike = async (track) => {
    const liked = !isMixLiked(track)
    const reference = makeTrackReference(track)
    if (liked) {
      const entry = { ...reference, likedAt: Date.now() }
      await writeStore('mixLikes', entry)
      setMixLikes((existing) => [...existing.filter((item) => item.id !== reference.id), entry])
    } else {
      await removeStoreItem('mixLikes', reference.id)
      setMixLikes((existing) => existing.filter((item) => item.id !== reference.id))
    }
    setMessage(liked ? 'Added to Mix Liked Songs.' : 'Removed from Mix Liked Songs.')
  }

  const createPlaylist = async (event) => {
    event.preventDefault()
    const name = playlistName.trim()
    if (!name) return
    const selectedTrack = playlistDialog?.track
    if (playlistDialog?.kind === 'mix-create') {
      const playlist = { id: `mix-playlist-${Date.now()}`, name, entries: selectedTrack ? [makeTrackReference(selectedTrack)] : [], createdAt: Date.now() }
      await writeStore('mixPlaylists', playlist)
      setMixPlaylists((existing) => [...existing, playlist])
      setPlaylistName('')
      setPlaylistDialog(null)
      setMixMode(true)
      setSpotifyMode(false)
      setMixView(`playlist:${playlist.id}`)
      setSearch('')
      if (selectedTrack) setMessage(`Created ${name} and added ${selectedTrack.title}.`)
      return
    }
    const playlist = { id: `playlist-${Date.now()}`, name, trackIds: selectedTrack ? [selectedTrack.id] : [], createdAt: Date.now() }
    await writeStore('playlists', playlist)
    setPlaylists((existing) => [...existing, playlist])
    setPlaylistName('')
    setPlaylistDialog(null)
    navigateToView(`playlist:${playlist.id}`)
    if (selectedTrack) setMessage(`Created ${name} and added ${selectedTrack.title}.`)
  }

  const addToPlaylist = async (playlistId, track) => {
    const playlist = playlists.find((item) => item.id === playlistId)
    if (!playlist) return
    if ((playlist.trackIds || []).includes(track.id)) {
      setPlaylistDialog({ kind: 'duplicate-add', playlistKind: 'local', playlistId, playlistName: playlist.name, track })
      return
    }
    await appendToPlaylist(playlist, track)
  }

  const appendToPlaylist = async (playlist, track) => {
    const trackIds = playlist.trackIds || []
    const entryIds = trackIds.map((trackId, index) => playlist.entryIds?.[index] || `${playlist.id}:${trackId}:${index}`)
    const updated = { ...playlist, trackIds: [...trackIds, track.id], entryIds: [...entryIds, `${playlist.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`] }
    await writeStore('playlists', updated)
    setPlaylists((existing) => existing.map((item) => item.id === playlist.id ? updated : item))
    setPlaylistDialog(null)
    setMessage(`Added to ${playlist.name}.`)
  }

  const addToMixPlaylist = async (playlistId, track) => {
    const playlist = mixPlaylists.find((item) => item.id === playlistId)
    if (!playlist) return
    const alreadyAdded = playlist.entries.some((entry) => entry.source === track.source && entry.trackId === track.id)
    if (alreadyAdded) {
      setPlaylistDialog({ kind: 'duplicate-add', playlistKind: 'mix', playlistId, playlistName: playlist.name, track })
      return
    }
    await appendToMixPlaylist(playlist, track)
  }

  const appendToMixPlaylist = async (playlist, track) => {
    const reference = makeTrackReference(track, `${track.source}:${track.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`)
    const updated = { ...playlist, entries: [...playlist.entries, reference] }
    await writeStore('mixPlaylists', updated)
    setMixPlaylists((existing) => existing.map((item) => item.id === playlist.id ? updated : item))
    setPlaylistDialog(null)
    setMessage(`Added to ${playlist.name}.`)
  }

  const confirmDuplicateAdd = async () => {
    const { playlistKind, playlistId, track } = playlistDialog || {}
    if (!track || !playlistId) return
    if (playlistKind === 'mix') {
      const playlist = mixPlaylists.find((item) => item.id === playlistId)
      if (playlist) await appendToMixPlaylist(playlist, track)
    } else {
      const playlist = playlists.find((item) => item.id === playlistId)
      if (playlist) await appendToPlaylist(playlist, track)
    }
  }

  const removeFromMixPlaylist = async (track) => {
    if (!selectedMixPlaylist) return
    const referenceId = `${track.source}:${track.id}`
    const entryIndex = track.playlistEntryId
      ? selectedMixPlaylist.entries.findIndex((entry) => entry.id === track.playlistEntryId)
      : selectedMixPlaylist.entries.findIndex((entry) => entry.id === referenceId || (entry.source === track.source && entry.trackId === track.id))
    const entries = [...selectedMixPlaylist.entries]
    if (entryIndex >= 0) entries.splice(entryIndex, 1)
    const updated = { ...selectedMixPlaylist, entries }
    await writeStore('mixPlaylists', updated)
    setMixPlaylists((existing) => existing.map((item) => item.id === updated.id ? updated : item))
    setPlaylistDialog(null)
    setMessage(`Removed ${track.title} from ${updated.name}.`)
  }

  const removeTrack = async (track) => {
    await removeStoreItem('tracks', track.id)
    setTracks((existing) => existing.filter((item) => item.id !== track.id))
    const mixReferenceId = `local:${track.id}`
    const updatedMixPlaylists = mixPlaylists.map((playlist) => ({ ...playlist, entries: playlist.entries.filter((entry) => entry.source !== 'local' || entry.trackId !== track.id) }))
    await Promise.all(updatedMixPlaylists.map((playlist) => writeStore('mixPlaylists', playlist)))
    setMixPlaylists(updatedMixPlaylists)
    await removeStoreItem('mixLikes', mixReferenceId)
    setMixLikes((existing) => existing.filter((entry) => entry.id !== mixReferenceId))
    setQueue((existing) => existing.filter((item) => item.id !== track.id))
    setQueueOrder((existing) => existing.filter((item) => item.id !== track.id))
    const updatedPlaylists = playlists.map((playlist) => {
      const keptIndices = playlist.trackIds.map((id, index) => id === track.id ? -1 : index).filter((index) => index >= 0)
      return {
        ...playlist,
        trackIds: keptIndices.map((index) => playlist.trackIds[index]),
        ...(playlist.entryIds ? { entryIds: keptIndices.map((index) => playlist.entryIds[index]) } : {}),
      }
    })
    await Promise.all(updatedPlaylists.map((playlist) => writeStore('playlists', playlist)))
    setPlaylists(updatedPlaylists)
    if (current?.id === track.id) { setIsPlaying(false); setCurrent(null); setQueue([]); setQueueOrder([]); savePlaybackSession(null) }
    setPlaylistDialog(null)
    setMessage(`Removed ${track.title} from your local library.`)
  }

  const removeAllTracks = async () => {
    try {
      await clearStore('tracks')
      const emptyPlaylists = playlists.map((playlist) => ({ ...playlist, trackIds: [], ...(playlist.entryIds ? { entryIds: [] } : {}) }))
      await Promise.all(emptyPlaylists.map((playlist) => writeStore('playlists', playlist)))
      const updatedMixPlaylists = mixPlaylists.map((playlist) => ({ ...playlist, entries: playlist.entries.filter((entry) => entry.source !== 'local') }))
      await Promise.all(updatedMixPlaylists.map((playlist) => writeStore('mixPlaylists', playlist)))
      const retainedMixLikes = mixLikes.filter((entry) => entry.source !== 'local')
      await clearStore('mixLikes')
      await Promise.all(retainedMixLikes.map((entry) => writeStore('mixLikes', entry)))
      setTracks([])
      setPlaylists(emptyPlaylists)
      setMixPlaylists(updatedMixPlaylists)
      setMixLikes(retainedMixLikes)
      setCurrent(null)
      setQueue([])
      setQueueOrder([])
      if (current?.source !== 'spotify') savePlaybackSession(null)
      setIsPlaying(false)
      setCurrentTime(0)
      setDuration(0)
      setSearch('')
      navigateToView('library')
      setPlaylistDialog(null)
      setMessage('All songs have been removed from your library.')
    } catch (error) {
      console.error(error)
      setMessage('The library could not be cleared. Please try again.')
    }
  }

  const onEnded = () => {
    if (repeatMode === 'one' && current) {
      setCurrentTime(0)
      if (audioRef.current) {
        audioRef.current.currentTime = 0
        audioRef.current.play().catch(() => setMessage('This file could not be played by your browser.'))
      }
      return
    }
    goToTrack(1)
  }

  const onDrop = (event) => {
    event.preventDefault(); setIsDragging(false); importFiles(event.dataTransfer.files)
  }

  const playAll = () => {
    if (filteredTracks.length) playTrack(filteredTracks[0], filteredTracks)
  }

  const playMixTrack = (track) => {
    const name = mixView === 'liked' ? 'Liked Songs' : selectedMixPlaylist?.name || 'Mix playlist'
    const context = { type: 'mix', id: selectedMixPlaylist?.id, name, total: mixDisplayTracks.length }
    playTrack(track, mixDisplayTracks, name, context)
  }

  const playSpotifyTrack = (track) => {
    const isSearch = Boolean(search.trim())
    const isLikedCollection = !isSearch && spotifyCollection === 'liked'
    const context = {
      type: isSearch ? 'search' : isLikedCollection ? 'liked' : 'playlist',
      id: !isSearch && !isLikedCollection ? selectedSpotifyPlaylist?.id : undefined,
      name: isSearch ? track.album : isLikedCollection ? 'Liked Songs' : selectedSpotifyPlaylist?.name || 'Spotify Playlist',
      total: isSearch ? displayTracks.length : isLikedCollection ? spotifyCollectionTrackTotal : selectedSpotifyPlaylist?.total || spotifyCollectionTrackTotal || displayTracks.length,
    }
    playTrack(track, displayTracks, context.name, context)
  }

  const playLocalTrack = (track) => playTrack(track, filteredTracks)
  const playDisplayedTrack = (track) => mixMode ? playMixTrack(track) : spotifyMode ? playSpotifyTrack(track) : playLocalTrack(track)

  const currentLiked = isMixLiked(current)
  const currentLikeCollection = 'Mix'
  const toggleCurrentLike = () => toggleMixLike(current)
  const isTrackActive = (track) => current?.id === track.id && current?.source === track.source
    && (!track.playlistEntryId || current?.playlistEntryId === track.playlistEntryId)

  return (
    <div className={`player-app ${isDragging ? 'is-dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setIsDragging(true) }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setIsDragging(false) }} onDrop={onDrop}>
      <input ref={fileInput} className="visually-hidden" type="file" accept="audio/*,.mp3,.m4a,.aac,.flac,.ogg,.opus,.wav,.aiff,.wma" multiple onChange={(event) => importFiles(event.target.files)} />
      <input ref={folderInput} className="visually-hidden" type="file" accept="audio/*,.mp3,.m4a,.aac,.flac,.ogg,.opus,.wav,.aiff,.wma" multiple webkitdirectory="" onChange={(event) => importFiles(event.target.files, true)} />

      <header className="minimal-topbar">
        <button className="wordmark" type="button" onClick={() => { navigateToView('home'); setShowLibrary(false) }}><span>{topbarLabel}</span></button>
        <div className="topbar-tools">
          {!isInstalled && <button className="topbar-tool topbar-tool--install" type="button" onClick={requestAppInstall} aria-label="Install 5AM" title="Install 5AM"><Download size={16} strokeWidth={1.9} aria-hidden="true" /><span>Install</span></button>}
          <button className="topbar-tool" type="button" onClick={() => setShowLibrary((value) => !value)} aria-label={`Open music library, ${libraryBadgeCount} tracks`}><LibraryBig size={18} strokeWidth={1.8} aria-hidden="true" /><span>Library <b>{libraryBadgeCount}</b></span></button>
          <div ref={volumeControlRef} className={`volume-control ${showVolumeSlider ? 'is-open' : ''}`} onPointerEnter={(event) => { if (event.pointerType === 'mouse') openVolumeSlider() }} onPointerLeave={(event) => { if (event.pointerType === 'mouse') scheduleVolumeSliderClose() }} onFocus={() => { if (window.matchMedia('(hover: hover)').matches) openVolumeSlider() }} onBlur={(event) => { if (window.matchMedia('(hover: hover)').matches && !event.currentTarget.contains(event.relatedTarget)) scheduleVolumeSliderClose() }}>
            <button className="topbar-tool volume-control__button" type="button" aria-label={volume === 0 ? 'Unmute audio' : 'Mute audio'} title={volume === 0 ? 'Unmute' : 'Mute'} aria-expanded={showVolumeSlider} onClick={() => { if (volume > 0) { lastAudibleVolumeRef.current = volume; setVolume(0) } else setVolume(lastAudibleVolumeRef.current || 0.82) }}>{volume === 0 ? <VolumeX size={18} strokeWidth={1.8} aria-hidden="true" /> : <Volume2 size={18} strokeWidth={1.8} aria-hidden="true" />}</button>
            <div className="volume-popover" onPointerEnter={(event) => { if (event.pointerType === 'mouse') openVolumeSlider() }}><label className="visually-hidden" htmlFor="topbar-volume">Volume</label><input id="topbar-volume" aria-label="Volume" type="range" min="0" max="1" step="0.01" value={volume} style={{ '--range-progress': `${volume * 100}%` }} onPointerDown={(event) => { if (event.pointerType === 'mouse') openVolumeSlider() }} onPointerUp={(event) => { if (event.pointerType === 'mouse') openVolumeSlider() }} onChange={(event) => { const value = Number(event.target.value); if (value > 0) lastAudibleVolumeRef.current = value; setVolume(value); if (audioRef.current) audioRef.current.volume = value }} /></div>
          </div>
        </div>
      </header>

      <main className="stage">
        <section className="track-copy" onClick={() => { if (window.matchMedia('(max-width: 700px)').matches) revealMobileControls() }}>
          <div className={`track-copy__identity ${!current ? 'track-copy__identity--clock' : ''} ${!current && clockNow.getHours() === 5 ? 'track-copy__identity--five-am' : ''} ${trackTextTransition ? 'track-copy__identity--transitioning' : ''}`}>
            {current ? <>
              <div className="track-copy__identity-current" aria-hidden={Boolean(trackTextTransition)}>
                <h1>{current.title}</h1>
                <p>{current.artist}</p>
              </div>
              <button className={`track-copy__like ${currentLiked ? 'is-liked' : ''}`} type="button" aria-label={`${currentLiked ? 'Remove from' : 'Add to'} ${currentLikeCollection} Liked Songs`} aria-pressed={currentLiked} title={`${currentLikeCollection} Liked Songs`} onClick={(event) => { event.stopPropagation(); revealMobileControls(); toggleCurrentLike() }}><Icon name="heart" size={20} fill={currentLiked ? 'currentColor' : 'none'} /></button>
              {trackTextTransition && <div key={trackTextTransition.id} className={`track-copy__motion track-copy__motion--${trackTextTransition.direction}`} aria-hidden="true">
                <div className="track-copy__motion-layer track-copy__motion-layer--leaving"><h1>{trackTextTransition.from.title}</h1><p>{trackTextTransition.from.artist}</p></div>
                <div className="track-copy__motion-layer track-copy__motion-layer--entering"><h1>{trackTextTransition.to.title}</h1><p>{trackTextTransition.to.artist}</p></div>
              </div>}
            </> : <>
              <h1 className="track-copy__clock">{clockNow.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</h1>
              <p>{clockNow.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
            </>}
          </div>
          {current && <div className={`track-progress ${isPlaying && !mobileControlsVisible ? 'track-progress--hidden' : ''}`} onPointerMove={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); const position = Math.min(100, Math.max(0, ((event.clientX - bounds.left) / bounds.width) * 100)); setSeekHover({ position }) }} onPointerLeave={() => setSeekHover(null)}><span className="seek-time-badge" style={{ '--hover-position': `${seekHover?.position ?? (duration ? (currentTime / duration) * 100 : 50)}%` }} aria-hidden="true">{formatTime(currentTime)} / {formatTime(duration)}</span><input aria-label="Seek through track" type="range" min="0" max={duration || 1} value={Math.min(currentTime, duration || 0)} style={{ '--range-progress': `${duration ? (currentTime / duration) * 100 : 0}%` }} onChange={(event) => { const time = Number(event.target.value); if (current?.source === 'spotify') spotifyPlayerRef.current?.seek(time * 1000).catch((error) => setMessage(error.message)); else if (audioRef.current) audioRef.current.currentTime = time; setCurrentTime(time) }} /></div>}
          {!current && <button className="browse-link" type="button" onClick={() => setShowLibrary(true)}>{tracks.length ? 'Choose a track' : 'Add music to begin'} <ArrowUpRight size={16} aria-hidden="true" /></button>}
        </section>

        <div className={`album-carousel ${isPlaying ? 'album-carousel--playing' : ''}`} aria-label="Album artwork. Swipe up for next track or down for previous track.">
          <div ref={artworkWrapRef} className={`artwork-wrap ${isPlaying ? 'artwork-wrap--playing' : ''}`} aria-hidden="true" />
          <div className="sound-wave" aria-hidden="true">{Array.from({ length: 19 }, (_, index) => <i key={index} style={{ '--bar': `${14 + ((index * 29 + 31) % 52)}px`, '--delay': `${(index % 7) * -0.16}s` }} />)}</div>
        </div>

        <nav className="control-rail" aria-label="Playback controls">
          <button className={`rail-button ${shuffle ? 'is-active' : ''}`} type="button" aria-label={shuffle ? 'Disable shuffle' : 'Enable shuffle'} aria-pressed={shuffle} title={shuffle ? 'Shuffle on' : 'Shuffle off'} onClick={toggleShuffle}><Icon name="shuffle" size={20} /></button>
          <button className="rail-button rail-button--track" type="button" aria-label="Previous track" title="Previous" onClick={() => goToTrack(-1)} disabled={!canGoToPreviousTrack}><Icon name="previous" size={26} strokeWidth={2.6} /></button>
          <button className={`rail-play ${isPlaying ? 'rail-play--playing' : 'rail-play--paused'}`} type="button" aria-label={isPlaying ? 'Pause' : 'Play'} aria-pressed={isPlaying} title={isPlaying ? 'Pause' : 'Play'} disabled={!current} onClick={togglePlayback}><Icon name={isPlaying ? 'pause' : 'play'} size={24} /></button>
          <button className="rail-button rail-button--track" type="button" aria-label="Next track" title="Next" onClick={() => goToTrack(1)} disabled={!canGoToNextTrack}><Icon name="next" size={26} strokeWidth={2.6} /></button>
          <button className={`rail-button ${repeatMode !== 'off' ? 'is-active' : ''}`} type="button" aria-label={`Repeat mode: ${repeatMode === 'off' ? 'off' : repeatMode === 'all' ? 'queue' : 'one song'}`} aria-pressed={repeatMode !== 'off'} title={`Repeat ${repeatMode === 'off' ? 'off' : repeatMode === 'all' ? 'queue — click for one song' : 'one song — click to turn off'}`} onClick={cycleRepeatMode}><Icon name={repeatMode === 'one' ? 'repeatOne' : 'repeat'} size={20} /></button>
          {current && <button className={`rail-button ${currentLiked ? 'is-liked' : ''}`} type="button" aria-label={`${currentLiked ? 'Remove from' : 'Add to'} ${currentLikeCollection} Liked Songs`} title={`${currentLikeCollection} Liked Songs`} onClick={toggleCurrentLike}><Icon name="heart" size={20} fill={currentLiked ? 'currentColor' : 'none'} /></button>}
        </nav>
      </main>

      {artworkCenter && carouselTracks.length > 0 && <div className={`artwork-cards ${isViewportResizing ? 'artwork-cards--resizing' : ''}`} aria-label="Previous, current, and next album artwork">
        {carouselTracks.map(({ track, offset, queueIndex }) => {
          const position = offset === 0 ? 'current' : offset === -1 ? 'previous' : offset === 1 ? 'next' : 'buffer'
          const isCurrent = position === 'current'
          const canSelect = position === 'previous' || position === 'next'
          return <div key={`${queueIndex}:${track.id}`} className={`carousel-card carousel-card--${position} ${isCurrent && mobileControlsVisible ? 'carousel-card--controls-visible' : ''} ${isCurrent && isArtworkDragging ? 'carousel-card--dragging' : ''} ${(position === 'previous' || position === 'next') && artworkDragDirection ? 'carousel-card--dragging-along' : ''}`} style={cardPosition(offset)} role={isCurrent ? 'group' : canSelect ? 'button' : undefined} tabIndex={canSelect ? 0 : -1} aria-hidden={position === 'buffer' || undefined} aria-label={isCurrent ? `Currently playing: ${track.title}` : canSelect ? `Play ${position} track: ${track.title}` : undefined} onPointerDown={isCurrent ? startArtworkSwipe : undefined} onPointerMove={isCurrent ? moveArtworkSwipe : undefined} onPointerUp={isCurrent ? endArtworkSwipe : undefined} onPointerCancel={isCurrent ? cancelArtworkSwipe : undefined} onKeyDown={canSelect ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              goToTrack(offset < 0 ? -1 : 1, track)
            }
          } : undefined} onClick={isCurrent ? (event) => {
            revealMobileControls()
            if (swipeHandledRef.current) return
            const bounds = event.currentTarget.getBoundingClientRect()
            const x = (event.clientX - bounds.left) / bounds.width
            const y = (event.clientY - bounds.top) / bounds.height
            const isCenterTap = x >= .3 && x <= .7 && y >= .3 && y <= .7
            if (artworkTapTimerRef.current) {
              window.clearTimeout(artworkTapTimerRef.current)
              artworkTapTimerRef.current = null
              const firstTap = artworkTapPositionRef.current
              artworkTapPositionRef.current = null
              if (!isCenterTap && firstTap && !firstTap.isCenter) toggleCurrentLike()
              else if (isCenterTap || firstTap?.isCenter) togglePlayback()
              return
            }
            artworkTapPositionRef.current = { isCenter: isCenterTap }
            artworkTapTimerRef.current = window.setTimeout(() => {
              artworkTapTimerRef.current = null
              const firstTap = artworkTapPositionRef.current
              artworkTapPositionRef.current = null
              if (firstTap?.isCenter) togglePlayback()
            }, 450)
          } : position === 'previous' ? () => goToTrack(-1, track) : position === 'next' ? () => goToTrack(1, track) : undefined}>
            <Cover track={track} size="large" className="hero-cover" />
            {isCurrent && <nav className="mobile-art-controls" aria-label="Playback controls" onClick={(event) => {
              event.stopPropagation()
              window.clearTimeout(artworkTapTimerRef.current)
              artworkTapTimerRef.current = null
              revealMobileControls()
            }}>
              <button className={`rail-button ${shuffle ? 'is-active' : ''}`} type="button" aria-label={shuffle ? 'Disable shuffle' : 'Enable shuffle'} aria-pressed={shuffle} title={shuffle ? 'Shuffle on' : 'Shuffle off'} onClick={toggleShuffle}><Icon name="shuffle" size={20} /></button>
              <button className={`rail-play ${isPlaying ? 'rail-play--playing' : 'rail-play--paused'}`} type="button" aria-label={isPlaying ? 'Pause' : 'Play'} aria-pressed={isPlaying} title={isPlaying ? 'Pause' : 'Play'} disabled={!current} onClick={togglePlayback}><Icon name={isPlaying ? 'pause' : 'play'} size={24} /></button>
              <button className={`rail-button ${repeatMode !== 'off' ? 'is-active' : ''}`} type="button" aria-label={`Repeat mode: ${repeatMode === 'off' ? 'off' : repeatMode === 'all' ? 'queue' : 'one song'}`} aria-pressed={repeatMode !== 'off'} title={`Repeat ${repeatMode === 'off' ? 'off' : repeatMode === 'all' ? 'queue — click for one song' : 'one song — click to turn off'}`} onClick={cycleRepeatMode}><Icon name={repeatMode === 'one' ? 'repeatOne' : 'repeat'} size={20} /></button>
            </nav>}
          </div>
        })}
      </div>}



      {libraryMounted && <div className={`library-backdrop ${showLibrary ? 'library-backdrop--open' : 'library-backdrop--closing'}`} onMouseDown={(event) => { if (event.target === event.currentTarget) setShowLibrary(false) }}>
        <section className="library-drawer" aria-label="Music library">
          <div className="drawer-heading"><div><h2>{title}</h2></div><button className="tool-icon" type="button" onClick={() => setShowLibrary(false)} aria-label="Close library"><Icon name="close" size={19} /></button></div>
          <label className="drawer-search"><Icon name="search" size={17} /><input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={spotifyMode ? 'Find a Spotify song or artist' : 'Find a song or artist'} aria-label={spotifyMode ? 'Search Spotify' : 'Search your music'} />{!spotifyMode && !mixMode && <button className="drawer-add" type="button" title="Add music files" onClick={() => fileInput.current?.click()} aria-label="Add music"><Icon name="plus" size={18} /></button>}</label>
          <div className="library-sources" role="tablist" aria-label="Music source">
            <button className={!spotifyMode && !mixMode ? 'is-selected' : ''} type="button" role="tab" aria-selected={!spotifyMode && !mixMode} onClick={() => { setSpotifyMode(false); setMixMode(false); setSearch(''); navigateToView('collections') }}><Icon name="folder" size={16} /> Local</button>
            <button className={spotifyMode ? 'is-selected' : ''} type="button" role="tab" aria-selected={spotifyMode} onClick={() => { setSpotifyMode(true); setMixMode(false); setSearch(''); setSpotifyCollection('playlists') }}><Icon name="headphones" size={16} /> Spotify</button>
            <button className={mixMode ? 'is-selected' : ''} type="button" role="tab" aria-selected={mixMode} onClick={() => { setSpotifyMode(false); setMixMode(true); setSearch(''); setMixView('collections') }}><Icon name="shuffle" size={16} /> Mix</button>
          </div>
          {!spotifyMode && !mixMode && <div className="drawer-filters">
          </div>}
          {spotifyMode && <div className="spotify-panel">
            {spotifyConnected
              ? <div className="spotify-status"><span><i />{spotifyPlayerReady ? 'Spotify connected' : 'Connecting to Spotify…'}</span><button type="button" onClick={disconnectSpotify}>Disconnect</button></div>
              : <div className="spotify-status"><span>Connect your Premium account</span><button type="button" onClick={connectSpotify}>Connect Spotify</button></div>}
          </div>}
          {!spotifyMode && !mixMode && ((view !== 'home' && view !== 'collections') || search.trim()) && <button className="spotify-back" type="button" onClick={() => { setSearch(''); navigateToView('collections') }}><ArrowLeft size={15} /> All collections</button>}
          {mixMode && mixView !== 'collections' && !search.trim() && <button className="spotify-back" type="button" onClick={() => { setSearch(''); setMixView('collections') }}><ArrowLeft size={15} /> All Mix playlists</button>}
          {spotifyMode && spotifyConnected && spotifyCollection !== 'playlists' && !search.trim() && <button className="spotify-back" type="button" onClick={() => { setSpotifyCollection('playlists'); setSearch('') }}><ArrowLeft size={15} /> All playlists</button>}
          <div ref={drawerListRef} className="drawer-list" onScroll={(event) => {
            if (!isSpotifyLikedList) return
            const { scrollTop, clientHeight } = event.currentTarget
            setSpotifyListScroll((previous) => Math.floor(previous.top / virtualRowHeight) === Math.floor(scrollTop / virtualRowHeight) && previous.height === clientHeight
              ? previous
              : { top: scrollTop, height: clientHeight })
          }}>
            {spotifyMode && !spotifyConnected ? <div className="drawer-empty"><Icon name="headphones" size={28} /><p>Sign in with your Spotify Premium account to browse and play your music.</p><button className="browse-link" type="button" onClick={connectSpotify}>Connect Spotify <ArrowUpRight size={14} /></button></div>
              : mixMode && mixView === 'collections' && !search.trim() ? <div className="local-collections" aria-label="Mix playlists">
                <button className="local-collection" type="button" onClick={() => setMixView('liked')}><span className="local-collection__cover local-collection__cover--favorites"><Icon name="heart" size={19} fill="currentColor" /></span><span><b>Liked Songs</b><small>{mixLikedTracks.length} {mixLikedTracks.length === 1 ? 'track' : 'tracks'} from all sources</small></span></button>
                {mixPlaylists.map((playlist) => <button className="local-collection" key={playlist.id} type="button" onClick={() => setMixView(`playlist:${playlist.id}`)}><span className="local-collection__cover"><Icon name="shuffle" size={19} /></span><span><b>{playlist.name}</b><small>{playlist.entries.length} {playlist.entries.length === 1 ? 'track' : 'tracks'}</small></span></button>)}
                <button className="library-create-playlist" type="button" onClick={() => { setPlaylistDialog({ kind: 'mix-create' }); setPlaylistName('') }}><Icon name="plus" size={16} /> Create Mix playlist</button>
              </div>
              : !spotifyMode && !mixMode && (view === 'home' || view === 'collections') && !search.trim() ? <div className="local-collections" aria-label="Local music collections">
                <button className="local-collection" type="button" onClick={() => navigateToView('library')}><span className="local-collection__cover"><Icon name="music" size={19} /></span><span><b>All music</b><small>{tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}</small></span></button>
                {playlists.map((playlist) => <button className="local-collection" key={playlist.id} type="button" onClick={() => navigateToView(`playlist:${playlist.id}`)}><span className="local-collection__cover"><Icon name="folder" size={19} /></span><span><b>{playlist.name}</b><small>{playlist.trackIds.length} {playlist.trackIds.length === 1 ? 'track' : 'tracks'}</small></span></button>)}
                <button className="library-create-playlist" type="button" onClick={() => setPlaylistDialog({ kind: 'create' })}><Icon name="plus" size={16} /> Create playlist</button>
              </div>
              : spotifyMode && spotifyCollection === 'playlists' && !search.trim() ? spotifyPlaylistsLoading ? <p className="drawer-empty">Loading your Spotify playlists…</p> : <div className="spotify-collections" aria-label="Spotify playlists">
                <button className="spotify-collection" type="button" onClick={() => { setSpotifyCollection('liked'); setSearch('') }}><span className="spotify-collection__cover spotify-collection__cover--liked"><Icon name="heart" size={19} fill="currentColor" /></span><span><b>Liked Songs</b><small>Saved tracks</small></span></button>
                {spotifyPlaylists.map((playlist) => <div className="spotify-collection-item" key={playlist.id}>
                  <button className="spotify-collection" type="button" onClick={() => { setSpotifyCollection(playlist.id); setSearch('') }}><span className="spotify-collection__cover">{playlist.artworkUrl ? <img src={playlist.artworkUrl} alt="" /> : <Icon name="music" size={19} />}</span><span><b>{playlist.name}</b><small>{playlist.total} {playlist.total === 1 ? 'track' : 'tracks'}</small></span></button>
                  {playlist.spotifyUrl && <a className="spotify-collection__link" href={playlist.spotifyUrl} target="_blank" rel="noreferrer" aria-label={`Open ${playlist.name} on Spotify`}><ArrowUpRight size={13} /></a>}
                </div>)}
                {!spotifyPlaylists.length && <div className="drawer-empty"><Icon name="music" size={28} /><p>No playlists were found on this Spotify account.</p></div>}
              </div>
              : (loading && !spotifyMode && !mixMode) || (spotifyMode && spotifyWorking && !isSpotifyLikedList) ? <p className="drawer-empty">{spotifyMode ? 'Loading Spotify music…' : 'Loading your library…'}</p>
                : isSpotifyLikedList ? <div className="track-list track-list--virtual" aria-busy={spotifyWorking || spotifyLoadingMore}>
                  <div className="track-virtual-spacer" style={{ height: `${virtualLikedStart * virtualRowHeight}px` }} aria-hidden="true" />
                  {virtualLikedRows.map((index) => {
                    const track = spotifyTracks[index]
                    return track
                      ? <TrackRow key={track.id} track={track} index={index} active={isTrackActive(track)} playing={isPlaying} liked={isMixLiked(track)} onPlay={playSpotifyTrack} onTogglePlayback={togglePlayback} onLike={toggleMixLike} likeScope="mix" onMenu={(item) => setPlaylistDialog({ kind: 'track', track: item })} />
                      : <TrackSkeleton key={`liked-loading-${index}`} />
                  })}
                  <div className="track-virtual-spacer" style={{ height: `${Math.max(0, virtualLikedCount - virtualLikedEnd) * virtualRowHeight}px` }} aria-hidden="true" />
                </div>
                : displayTracks.length ? displayTracks.map((track, index) => <TrackRow key={`${track.source}:${track.id}-${track.playlistEntryId || index}`} track={track} index={index} active={isTrackActive(track)} playing={isPlaying} liked={isMixLiked(track)} onPlay={mixMode ? playMixTrack : spotifyMode ? playSpotifyTrack : playLocalTrack} onTogglePlayback={togglePlayback} onLike={toggleMixLike} likeScope="mix" onMenu={(item) => setPlaylistDialog({ kind: 'track', track: item })} />)
                  : <div className="drawer-empty"><Icon name="music" size={28} /><p>{mixMode ? (search ? 'No Mix songs found.' : mixView === 'liked' ? 'Like tracks from Local or Spotify to collect them here.' : 'This Mix playlist is empty. Add tracks from Local or Spotify.') : spotifyMode ? (search ? 'No Spotify songs found.' : spotifyCollection === 'liked' ? 'Your Spotify Liked Songs will appear here.' : `No tracks in ${selectedSpotifyPlaylist?.name || 'this playlist'}.`) : search ? 'No songs found.' : tracks.length ? 'Nothing in this collection yet.' : 'Your library is empty.'}</p>{!spotifyMode && !mixMode && <button className="browse-link" type="button" onClick={() => fileInput.current?.click()}>Add music <Plus size={14} aria-hidden="true" /></button>}</div>}
          </div>
          {!spotifyMode && !mixMode && <button className="drawer-import" type="button" onClick={() => folderInput.current?.click()}><Icon name="folder" size={17} /> Import folder</button>}
        </section>
      </div>}

      <audio ref={audioRef} preload="metadata" onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onLoadedMetadata={(event) => {
        const audio = event.currentTarget
        const nextDuration = audio.duration || 0
        setDuration(nextDuration)
        if (pendingLocalSeekRef.current > 0) {
          audio.currentTime = Math.min(pendingLocalSeekRef.current, Math.max(0, nextDuration - 0.25))
          setCurrentTime(audio.currentTime)
          pendingLocalSeekRef.current = 0
        }
      }} onEnded={onEnded} onError={(event) => {
        const audio = event.currentTarget
        if (!audio.getAttribute('src')) return
        console.error('audio element error', audio.error?.code, audio.error?.message, current)
        if (current?.source === 'local' && localAudioTrackIdRef.current === current.id) {
          setIsPlaying(false)
          setMessage('This audio format could not be played in your browser.')
        }
      }} />
      {adding && <div className="import-progress"><span className="loader loader--small" /> Adding music…</div>}
      {isDragging && <div className="drop-overlay"><div><Icon name="plus" size={28} /><strong>Drop your music here</strong><span>Audio files will be added to your library</span></div></div>}
      {message && <div className="toast" role="status"><span className="toast__mark"><Icon name="check" size={15} /></span>{message}<button className="icon-button" type="button" aria-label="Dismiss message" onClick={() => setMessage('')}><Icon name="close" size={15} /></button></div>}

      {installHelpOpen && <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setInstallHelpOpen(false) }}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="install-dialog-title"><button className="icon-button dialog__close" type="button" aria-label="Close" onClick={() => setInstallHelpOpen(false)}><X size={18} /></button><div className="eyebrow">TAKE 5AM WITH YOU</div><h2 id="install-dialog-title">Install 5AM.</h2><p>{isIOSDevice ? <>In Safari, tap <strong>Share</strong>, then choose <strong>Add to Home Screen</strong>.</> : <>Open your browser menu and choose <strong>Install 5AM</strong> or <strong>Add to Home screen</strong>.</>} The exact wording depends on your browser.</p><div className="dialog__actions"><button className="button button--accent" type="button" onClick={() => setInstallHelpOpen(false)}>Got it</button></div></section></div>}

      {playlistDialog && <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPlaylistDialog(null) }}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><button className="icon-button dialog__close" type="button" aria-label="Close" onClick={() => setPlaylistDialog(null)}><Icon name="close" /></button>{['create', 'mix-create'].includes(playlistDialog.kind) ? <><div className="eyebrow">{playlistDialog.kind === 'mix-create' ? 'NEW MIX PLAYLIST' : 'NEW LOCAL PLAYLIST'}</div><h2 id="dialog-title">Give it a name.</h2>{playlistDialog.track && <p className="dialog-context">“{playlistDialog.track.title}” will be added automatically.</p>}<form onSubmit={createPlaylist}><label className="field-label" htmlFor="playlist-name">Playlist name</label><input id="playlist-name" autoFocus maxLength={48} value={playlistName} onChange={(event) => setPlaylistName(event.target.value)} placeholder="Sunday drive" /><div className="dialog__actions"><button className="button button--ghost" type="button" onClick={() => setPlaylistDialog(null)}>Cancel</button><button className="button button--accent" type="submit" disabled={!playlistName.trim()}>Create</button></div></form></> : playlistDialog.kind === 'duplicate-add' ? <><div className="eyebrow">DUPLICATE TRACK</div><h2 id="dialog-title">Already in this playlist.</h2><p>“{playlistDialog.track?.title}” is already in {playlistDialog.playlistName}. Add it again?</p><div className="dialog__actions"><button className="button button--ghost" type="button" onClick={() => { setPlaylistDialog(null); setMessage('Track was not added again.') }}>Don’t add</button><button className="button button--accent" type="button" onClick={confirmDuplicateAdd}>Add anyway</button></div></> : playlistDialog.kind === 'clear' ? <><div className="eyebrow">CLEAR LIBRARY</div><h2 id="dialog-title">Remove all songs?</h2><p>This removes all {tracks.length} saved songs from this browser and empties your playlists. Your original audio files on your device are not changed.</p><div className="dialog__actions"><button className="button button--ghost" type="button" onClick={() => setPlaylistDialog(null)}>Cancel</button><button className="button button--danger" type="button" onClick={removeAllTracks}>Remove all</button></div></> : <><div className="eyebrow">TRACK OPTIONS</div><h2 id="dialog-title">{playlistDialog.track?.title}</h2><p>{playlistDialog.track?.artist}</p><div className="track-options"><button type="button" onClick={() => { playDisplayedTrack(playlistDialog.track); setPlaylistDialog(null) }}><Icon name="play" size={17} /> Play now</button><button type="button" onClick={() => { toggleMixLike(playlistDialog.track); setPlaylistDialog(null) }}><Icon name="heart" size={16} fill={isMixLiked(playlistDialog.track) ? "currentColor" : "none"} /> {isMixLiked(playlistDialog.track) ? "Remove from Mix Liked Songs" : "Add to Mix Liked Songs"}</button><div className="field-label">Add to Mix playlist</div>{mixPlaylists.length ? mixPlaylists.map((playlist) => <button key={playlist.id} type="button" onClick={() => addToMixPlaylist(playlist.id, playlistDialog.track)}><Icon name="plus" size={16} /> {playlist.name}<span>{playlist.entries.length}</span></button>) : <p className="track-options__empty">No Mix playlists yet. Create one for this song.</p>}<button className="track-options__create" type="button" onClick={() => { setPlaylistDialog({ kind: 'mix-create', track: playlistDialog.track }); setPlaylistName('') }}><Icon name="plus" size={16} /> Create Mix playlist</button>{playlistDialog.track?.source === 'local' && <><div className="field-label">Add to local playlist</div>{playlists.length ? playlists.map((playlist) => <button key={playlist.id} type="button" onClick={() => addToPlaylist(playlist.id, playlistDialog.track)}><Icon name="folder" size={16} /> {playlist.name}<span>{playlist.trackIds.length}</span></button>) : <p className="track-options__empty">No local playlists yet.</p>}<button className="track-options__remove" type="button" onClick={() => removeTrack(playlistDialog.track)}><Icon name="close" size={16} /> Remove from library</button></>}{mixMode && selectedMixPlaylist && <button className="track-options__remove" type="button" onClick={() => removeFromMixPlaylist(playlistDialog.track)}><Icon name="close" size={16} /> Remove from this Mix playlist</button>}</div><div className="dialog__actions"><button className="button button--ghost" type="button" onClick={() => setPlaylistDialog(null)}>Done</button></div></>}</section></div>}
    </div>
  )
}

export default App
