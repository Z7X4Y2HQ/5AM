const CLIENT_ID_KEY = 'aftertone-spotify-client-id'
const TOKEN_KEY = 'aftertone-spotify-token'
const VERIFIER_KEY = 'aftertone-spotify-verifier'
const STATE_KEY = 'aftertone-spotify-state'
let spotifySdkPromise
let spotifyLoginPromise
let spotifyTokenRefreshPromise

async function readJsonBody(response) {
  const text = await response.text()
  if (!text.trim()) return null
  try { return JSON.parse(text) } catch { return undefined }
}

export const spotifyRedirectUri = () => {
  const url = new URL(window.location.href)
  if (import.meta.env.PROD) {
    url.pathname = import.meta.env.BASE_URL
    url.search = ''
    url.hash = ''
    return `${url.origin}${url.pathname}`
  }
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  url.pathname = '/callback'
  url.search = ''
  url.hash = ''
  return `${url.origin}${url.pathname}`
}

export function getSpotifyClientId() {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const migratedId = fragment.get('spotify-client-id')
  if (migratedId) {
    window.localStorage.setItem(CLIENT_ID_KEY, migratedId)
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`)
  }
  return import.meta.env.VITE_SPOTIFY_CLIENT_ID || window.localStorage.getItem(CLIENT_ID_KEY) || ''
}

export function saveSpotifyClientId(value) {
  const clientId = value.trim()
  if (clientId) window.localStorage.setItem(CLIENT_ID_KEY, clientId)
  else window.localStorage.removeItem(CLIENT_ID_KEY)
  return clientId
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

export async function startSpotifyLogin(clientId) {
  if (!clientId) throw new Error('Spotify sign-in is not configured for this app yet.')
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)))
  const challenge = base64Url(await sha256(verifier))
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)))
  window.sessionStorage.setItem(VERIFIER_KEY, verifier)
  window.sessionStorage.setItem(STATE_KEY, state)
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: spotifyRedirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: 'streaming user-read-private user-read-email user-read-playback-state user-modify-playback-state user-library-read user-library-modify playlist-read-private playlist-read-collaborative',
  })
  window.location.assign(`https://accounts.spotify.com/authorize?${params}`)
}

function saveToken(token) {
  const value = { ...token, expires_at: Date.now() + token.expires_in * 1000 }
  window.localStorage.setItem(TOKEN_KEY, JSON.stringify(value))
  window.sessionStorage.removeItem(TOKEN_KEY)
  return value
}

function readToken() {
  try {
    const storedToken = window.localStorage.getItem(TOKEN_KEY) || window.sessionStorage.getItem(TOKEN_KEY)
    const token = JSON.parse(storedToken || 'null')
    if (token && !window.localStorage.getItem(TOKEN_KEY)) window.localStorage.setItem(TOKEN_KEY, JSON.stringify(token))
    window.sessionStorage.removeItem(TOKEN_KEY)
    return token
  } catch { return null }
}

export function hasSpotifySession() {
  return Boolean(readToken()?.refresh_token || (readToken()?.access_token && readToken().expires_at > Date.now()))
}

async function finishSpotifyLoginRequest() {
  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')
  if (!code && !error) return false
  if (error) throw new Error(error === 'access_denied' ? 'Spotify sign-in was cancelled.' : `Spotify sign-in failed: ${error}`)
  const clientId = getSpotifyClientId()
  const expectedState = window.sessionStorage.getItem(STATE_KEY)
  const returnedState = url.searchParams.get('state')
  const verifier = window.sessionStorage.getItem(VERIFIER_KEY)
  if (!clientId || !verifier || !expectedState || expectedState !== returnedState) throw new Error('Spotify sign-in could not be verified. Please try connecting again.')
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: spotifyRedirectUri(),
    code_verifier: verifier,
  })
  const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  const token = await readJsonBody(response)
  if (!response.ok) throw new Error(token?.error_description || 'Spotify could not authorize this app.')
  if (!token?.access_token) throw new Error('Spotify returned an invalid sign-in response. Please connect again.')
  saveToken(token)
  window.sessionStorage.removeItem(VERIFIER_KEY)
  window.sessionStorage.removeItem(STATE_KEY)
  const appBasePath = new URL(import.meta.env.BASE_URL, window.location.origin).pathname
  window.history.replaceState({}, '', appBasePath)
  return true
}

export function finishSpotifyLogin() {
  if (!spotifyLoginPromise) spotifyLoginPromise = finishSpotifyLoginRequest()
  return spotifyLoginPromise
}

export async function getSpotifyAccessToken() {
  let token = readToken()
  if (!token) throw new Error('Connect your Spotify account first.')
  if (token.expires_at <= Date.now() + 30_000) {
    if (!token.refresh_token) throw new Error('Your Spotify session expired. Reconnect your account.')
    if (!spotifyTokenRefreshPromise) {
      spotifyTokenRefreshPromise = (async () => {
        const body = new URLSearchParams({ client_id: getSpotifyClientId(), grant_type: 'refresh_token', refresh_token: token.refresh_token })
        const refreshResponse = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
        const refreshed = await readJsonBody(refreshResponse)
        if (!refreshResponse.ok) throw new Error(refreshed?.error_description || 'Spotify session expired. Please reconnect.')
        if (!refreshed?.access_token) throw new Error('Spotify returned an invalid session response. Please reconnect your account.')
        return saveToken({ ...token, ...refreshed, refresh_token: refreshed.refresh_token || token.refresh_token })
      })().finally(() => { spotifyTokenRefreshPromise = null })
    }
    token = await spotifyTokenRefreshPromise
  }
  return token.access_token
}

export async function spotifyFetch(path, options = {}) {
  const accessToken = await getSpotifyAccessToken()
  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  })
  if (!response.ok) {
    let message = `Spotify request failed (${response.status}).`
    const body = await readJsonBody(response)
    message = body?.error?.message || message
    const error = new Error(message)
    error.status = response.status
    throw error
  }
  if (response.status === 204) return null
  // Spotify playback/library commands may return an empty or plain-text body
  // even when the action succeeded. Callers only consume JSON from read requests.
  if ((options.method || 'GET').toUpperCase() !== 'GET') return null
  const body = await readJsonBody(response)
  if (body === undefined) throw new Error('Spotify returned an unreadable response. Please try again.')
  return body
}

export function clearSpotifySession() {
  window.localStorage.removeItem(TOKEN_KEY)
  window.sessionStorage.removeItem(TOKEN_KEY)
}

export function loadSpotifyPlaybackSdk() {
  if (window.Spotify?.Player) return Promise.resolve(window.Spotify)
  if (spotifySdkPromise) return spotifySdkPromise
  spotifySdkPromise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => { spotifySdkPromise = null; reject(new Error('Spotify player SDK did not load. Check your connection and try again.')) }, 15_000)
    window.onSpotifyWebPlaybackSDKReady = () => { window.clearTimeout(timeout); resolve(window.Spotify) }
    let script = document.querySelector('script[data-spotify-playback-sdk]')
    if (!script) {
      script = document.createElement('script')
      script.src = 'https://sdk.scdn.co/spotify-player.js'
      script.async = true
      script.dataset.spotifyPlaybackSdk = 'true'
      script.onerror = () => { window.clearTimeout(timeout); spotifySdkPromise = null; reject(new Error('Could not load Spotify player SDK.')) }
      document.head.appendChild(script)
    }
  })
  return spotifySdkPromise
}

export function normalizeSpotifyTrack(track) {
  return {
    id: `spotify:${track.id}`,
    spotifyUri: track.uri,
    title: track.name,
    artist: track.artists?.map((artist) => artist.name).join(', ') || 'Unknown artist',
    album: track.album?.name || '',
    albumTrackCount: track.album?.total_tracks || 0,
    duration: (track.duration_ms || 0) / 1000,
    artworkUrl: track.album?.images?.[0]?.url || '',
    spotifyUrl: track.external_urls?.spotify || '',
    playable: track.is_playable !== false && !track.restrictions && !track.is_local,
    explicit: track.explicit,
    liked: false,
    source: 'spotify',
  }
}
