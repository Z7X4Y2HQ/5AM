# 5AM

5AM is a music player for keeping a personal local library and connected music services in one place. The long-term direction is to build custom playlists that can combine tracks from different providers and play them through one player.

The current app includes local music, Spotify, and a separate Mix area. Mix playlists can collect tracks from the supported sources. YouTube Music, SoundCloud, and other providers are future integrations; they are not connected yet.

<img width="1919" height="1025" alt="image" src="https://github.com/user-attachments/assets/a8da0372-2628-40c0-8f9e-32e2401a0e4b" />

<img width="1919" height="1024" alt="image" src="https://github.com/user-attachments/assets/2d8e49d9-874f-4528-98d8-6881ef395540" />

## What is in the app today

### Local library

- Import individual audio files or a folder of music.
- Folder imports create playlists from the selected folder structure, including nested folders.
- Drag audio files onto the app to import them.
- Search the local library and its playlists.
- Create named local playlists, add tracks to them, and remove tracks from a playlist or library.
- A track can be added more than once when you confirm the duplicate prompt.
- Local music does not have a separate local-only liked list. Use a track's heart to add or remove it from **Mix Liked Songs**.

Imported audio is stored in this browser's IndexedDB. The app does not upload local audio. Storage is tied to the browser profile and site origin, so clearing the site's stored data or using a different browser/profile can remove or hide the library. Keep the original files backed up on your device.

### Spotify

- Connect a Spotify account using Spotify's authorization flow.
- Browse Spotify Liked Songs and the account's playlists, and search Spotify tracks.
- Play tracks that Spotify makes available to the account and current playback market. Unavailable tracks are disabled in the list.
- Spotify track hearts in 5AM manage **Mix Liked Songs**; they do not change the user's Spotify Liked Songs.
- Spotify playback uses Spotify's Web Playback SDK and the Spotify Web API. A Spotify Premium account is required for in-app playback.

Spotify access is subject to Spotify's account, API, playback, and developer-app requirements. This project is a personal development app; publishing it for other users may require additional Spotify review or approval.

### Mix

- Mix is separate from the Local and Spotify libraries.
- **Mix Liked Songs** is its own list and can contain local and Spotify tracks.
- Create named Mix playlists and add tracks from supported sources, including local tracks and Spotify tracks.
- Duplicate entries are allowed after confirming the prompt.
- Mix playback crosses provider boundaries, but each provider still controls its own playback session and availability. The app's cross-provider playback is evolving; it should not be considered a finished universal streaming layer yet.

### Player

- Play and pause, skip between tracks, seek, change volume, and toggle shuffle or repeat.
- Repeat cycles between off, repeat queue, and repeat one track.
- The player remembers the current track, queue, playback position, and playlist context where possible. Local library and playlist data persist separately in browser storage.
- Keyboard shortcuts:

  | Shortcut | Action |
  | --- | --- |
  | `Space` | Play or pause |
  | `↑` / `↓` | Raise or lower volume |
  | `←` / `→` | Seek backward or forward 5 seconds |
  | `Ctrl` + `←` / `Ctrl` + `→` | Previous or next track |

Shortcuts are ignored while typing in text fields and other editable controls.

### Installable web app

5AM includes a web app manifest and install guidance. In supported browsers, use the app's **Install** control or the browser's install option to add it to a desktop or mobile home screen. Install availability depends on the browser and hosting context. Spotify sign-in and local audio storage remain scoped to that installed app's browser origin/profile.

## Requirements

- Node.js with npm.
- A current browser with IndexedDB, the HTML audio element, and modern JavaScript support.
- Spotify Premium and a Spotify developer app only if you want to use Spotify playback.
- For PWA installation, a browser and origin that meet the browser's installability requirements. Localhost development is treated as a secure context by modern browsers.

## Run locally

Open a terminal in the `5AM` project directory (the directory containing `package.json`), then run:

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. The default Vite development port is `5173`; if that port is already in use, Vite may select another one. Spotify's configured redirect URI must match the actual origin and port used by the app.

Other scripts:

```sh
npm run build    # Create a production build in dist/
npm run preview  # Serve the production build locally
npm run lint     # Run Oxlint
```

## Connect Spotify for local development

Each person connecting Spotify needs to use a Spotify Client ID from a Spotify developer app. 5AM uses Authorization Code with PKCE in the browser and does not need a Client Secret. Do not paste or commit a Client Secret into this frontend project.

1. Create or open a Spotify app in the Spotify Developer Dashboard.
2. In the app's settings, add the redirect URI for the running 5AM development origin, ending in `/callback`. For the default Vite port, use:

   ```text
   http://127.0.0.1:5173/callback
   ```

   For the public GitHub Pages deployment, also add this exact redirect URI to the Spotify app:

   ```text
   https://z7x4y2hq.github.io/5AM/
   ```

   The URI must match exactly, including scheme, host, port, and path. The app normalizes `localhost` to `127.0.0.1` for the Spotify redirect. If Vite starts on another port, register that port and use that origin when opening 5AM.

3. In 5AM, open the Spotify section, choose the setup option, enter the app's **Client ID**, and connect your account.
4. Accept the permissions Spotify displays. The app requests access for Spotify playback, profile/email, playback state and controls, saved tracks, and private/collaborative playlists.

The Client ID entered in the setup UI is saved in this browser's local storage. For a local developer default, you can instead create an untracked `.env.local` file beside `package.json`:

```dotenv
VITE_SPOTIFY_CLIENT_ID=your_spotify_client_id
```

Restart Vite after changing `.env.local`. The Client ID is public by design; a Client Secret is not used by this browser-based PKCE flow. Never commit `.env.local` or access tokens.

## Data and privacy

- Local audio files, local playlists, Mix playlists, and Mix likes are stored in IndexedDB in the current browser profile.
- The playback session and Spotify connection credentials are stored by the browser for this origin. Spotify tokens are used to make requests to Spotify and are not stored in the repository.
- The app does not currently provide cloud sync or cross-device library sync.
- Removing a song from 5AM removes the app's stored copy; it does not delete the original audio file from the computer.
- Removing all local songs clears 5AM's local library and local playlists. It does not delete the original files and does not clear Spotify data.

## Project layout

```text
5AM/
├── public/                 # App icons and install manifest
├── src/
│   ├── assets/             # Bundled visual assets
│   ├── playback/
│   │   └── providers.js    # Provider-aware playback session serialization
│   ├── App.jsx             # Player, libraries, dialogs, and app behavior
│   ├── App.css             # Main interface styling
│   ├── index.css            # Global styles
│   ├── main.jsx             # React entry point
│   └── spotify.js           # Spotify auth, API, and playback SDK helpers
├── index.html
├── package.json
└── vite.config.js
```

Playback provider adapters are registered by ID and serialize/restore provider-specific tracks. This is intended to give future integrations a place to add their own track identity and session handling instead of coupling every provider directly to local playback state.

## Current limitations and future direction

- Spotify playback requires Premium, an authorized Spotify developer app, and a matching redirect URI.
- Supported audio formats depend on the browser's codecs. A file may import successfully but fail to play if the browser cannot decode it.
- Browser storage has finite capacity and can be removed by browser cleanup settings. This app is not a replacement for backing up the original music files.
- Spotify API behavior and access depend on Spotify's current developer rules and account permissions.
- YouTube Music, SoundCloud, and other services are planned, not currently available in the app.
- The product goal is a unified player and custom playlists across sources, subject to each provider's playback APIs, terms, and technical limits.
