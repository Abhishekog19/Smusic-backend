# Smusic Backend — REST API + WebSocket Server for Groove

> The Node.js backend powering [Groove Web](https://github.com/Abhishekog19/GrooveWeb). Handles auth, song metadata, playlists, recommendations, social features, listening history, and real-time friend activity.

**Deployed on Render** | Entry: `server/index.js` | Health: `/api/health`

---

## What It Does

Smusic Backend is the server layer for the Groove music platform. The frontend (GrooveWeb) is an offline-first PWA where audio files live in IndexedDB — this backend handles everything that requires persistence or real-time coordination across users: accounts, social connections, playlist sharing, listening history sync, and the recommendation engine.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│              Groove Web (React + Vite)              │
│         IndexedDB (audio, local metadata)           │
└────────────────┬──────────────┬────────────────────┘
                 │ REST API     │ WebSocket
┌────────────────▼──────────────▼────────────────────┐
│           Smusic Backend (Node.js / Express)        │
│                                                     │
│  Auth        Recommendations    Social              │
│  Songs       Analytics          Socket.io           │
│  Playlists   History sync                           │
└────────────────┬──────────────┬────────────────────┘
                 │              │
       PostgreSQL (primary)   Redis (cache + pub/sub)
```

The frontend handles playback and local storage entirely. The backend only receives metadata — never audio files. This keeps the server lightweight and the app fast even offline.

---

## API Reference

### Auth — `/api/auth`

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/register` | Create account (email + password) |
| `POST` | `/login` | Login, returns JWT access + refresh tokens |
| `POST` | `/refresh` | Refresh access token |
| `POST` | `/logout` | Invalidate refresh token |

JWT-based auth. Access tokens are short-lived; refresh tokens are stored server-side and invalidated on logout.

---

### Songs — `/api/songs`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Get user's song library |
| `POST` | `/` | Add a song (metadata only, no file upload) |
| `GET` | `/:id` | Get song by ID |
| `PUT` | `/:id` | Update song metadata |
| `DELETE` | `/:id` | Remove song from library |
| `POST` | `/bulk` | Bulk import song metadata |
| `GET` | `/search?q=` | Search songs by title, artist, album |
| `GET` | `/:id/similar` | Get similar songs (recommendation engine) |

---

### Playlists — `/api/playlists`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Get all user playlists |
| `POST` | `/` | Create playlist |
| `GET` | `/:id` | Get playlist with songs |
| `PUT` | `/:id` | Update playlist metadata |
| `DELETE` | `/:id` | Delete playlist |
| `POST` | `/:id/songs` | Add song to playlist |
| `DELETE` | `/:id/songs/:songId` | Remove song from playlist |
| `PUT` | `/:id/reorder` | Reorder songs (drag-and-drop) |
| `GET` | `/system/habit-mix` | Get Habit Mix (behaviorally scored playlist) |
| `GET` | `/system/mood/:mood` | Get mood-based playlist (Happy/Chill/Workout/Sad/Focus) |
| `GET` | `/system/time` | Get time-based playlist (morning/evening/night) |

---

### Listening History — `/api/history`

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/` | Record a listening session |
| `POST` | `/bulk` | Bulk sync offline listening history |
| `GET` | `/` | Get listening history |
| `GET` | `/recent` | Get recently played songs |

The bulk sync endpoint is specifically designed for the offline-first use case — when a user returns online after listening offline, the client sends all queued sessions in a single request.

---

### Recommendations — `/api/recommendations`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/feed` | Personalized recommendation feed |
| `GET` | `/similar/:songId` | Songs similar to a given track |
| `GET` | `/mood/:mood` | Songs matching a mood profile |
| `GET` | `/time` | Songs for current time of day |
| `POST` | `/instant` | Generate playlist from text prompt |

#### Recommendation Engine

The engine uses a **hybrid scoring approach** combining behavioral signals and audio feature similarity:

**Habit Mix scoring formula:**
```
habit_score = (play_count × 0.4) + (avg_completion × 0.3) + (non_skip_rate × 0.3)
```
Computed from the last 30 days of listening history. Updates incrementally on new data — never recalculates the full library each time.

**Signals tracked per song:**
- Play count, skip count, average completion percentage
- Repeat frequency, last played timestamp
- Time of day patterns
- Playlist additions and favorites

**Similar song lookup:** Cosine similarity across audio feature vectors (tempo, energy, valence, acousticness, danceability) + Jaccard similarity for genre overlap.

**Skip intelligence:** Sessions where a song is skipped before 30% completion are weighted negatively. Late skips (after 80%) are treated differently from early abandonment.

**Mood profiles:** Each mood maps to a feature range — songs are filtered to match the profile, then shuffled.

---

### Social — `/api/social`

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/friends/request` | Send a friend request |
| `POST` | `/friends/accept` | Accept a friend request |
| `DELETE` | `/friends/:id` | Remove a friend |
| `GET` | `/friends` | List friends + online status |
| `GET` | `/friends/activity` | Friend activity feed (now playing, recently played) |
| `GET` | `/friends/:id/playlists` | View a friend's public playlists |
| `POST` | `/playlists/:id/copy` | Copy a friend's playlist to your library |
| `GET` | `/friend-mix` | Shared playlist based on mutual listening patterns |

---

### Statistics — `/api/stats`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/weekly` | Weekly listening summary |
| `GET` | `/monthly` | Monthly listening summary |
| `GET` | `/top-songs` | Most played songs |
| `GET` | `/top-artists` | Most played artists |
| `GET` | `/trends` | Listening trends over time |

---

## WebSocket Events

Managed by **Socket.io**. Clients connect after auth and receive real-time updates:

| Event | Direction | Payload |
|---|---|---|
| `friend:now_playing` | Server → Client | `{ friendId, songId, title, artist }` |
| `friend:online` | Server → Client | `{ friendId }` |
| `friend:offline` | Server → Client | `{ friendId }` |
| `notification:new` | Server → Client | `{ type, message, data }` |

Friend online/offline status is tracked via Socket.io connection and disconnection events, stored in Redis for fast lookup.

---

## Tech Stack

| Technology | Purpose |
|---|---|
| Node.js 20 | Runtime |
| Express | HTTP server |
| Socket.io | WebSocket — real-time friend activity |
| PostgreSQL 15 | Primary database |
| Prisma | Type-safe ORM + migrations |
| Redis | Session cache + Socket.io pub/sub |
| Passport.js | JWT authentication strategy |
| Bull | Background job queue (recommendation recalc, history sync) |

---

## Project Structure

```
server/
├── index.js                  # Entry point — Express + Socket.io setup
├── routes/
│   ├── auth.js
│   ├── songs.js
│   ├── playlists.js
│   ├── history.js
│   ├── recommendations.js
│   ├── social.js
│   └── stats.js
├── services/
│   ├── recommendationEngine.js   # Habit Mix, mood profiles, skip intelligence
│   ├── analyticsService.js       # Stats aggregation
│   └── socketService.js          # Real-time event management
├── middleware/
│   ├── auth.js                   # JWT verification
│   └── errorHandler.js
└── prisma/
    ├── schema.prisma             # Database schema
    └── migrations/
```

---

## Getting Started

### Prerequisites
- Node.js 20+
- PostgreSQL 15+
- Redis

### Local Setup

```bash
git clone https://github.com/Abhishekog19/Smusic-backend.git
cd Smusic-backend/server
npm install
```

Create a `.env` file in `server/`:

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/smusic
REDIS_URL=redis://localhost:6379
JWT_SECRET=your_jwt_secret
JWT_REFRESH_SECRET=your_refresh_secret
PORT=5000
NODE_ENV=development
```

Run migrations and start:

```bash
npx prisma migrate dev
node index.js
```

Health check: `GET http://localhost:5000/api/health`

---

## Deployment

Deployed on **Render** via `render.yaml` in the repo root. Render auto-deploys on push to `main`.

```yaml
services:
  - type: web
    name: smusic-backend
    runtime: node
    rootDir: server
    buildCommand: npm install
    startCommand: node index.js
    healthCheckPath: /api/health
```

Set the following environment variables in your Render dashboard:
- `DATABASE_URL` — PostgreSQL connection string (Supabase recommended)
- `REDIS_URL` — Redis connection string (Upstash recommended)
- `JWT_SECRET` and `JWT_REFRESH_SECRET`
- `NODE_ENV=production`

---

## Related

| Repo | Description |
|---|---|
| [GrooveWeb](https://github.com/Abhishekog19/GrooveWeb) | Frontend PWA — React, Vite, IndexedDB, Howler.js |
| [GrooveApp](https://github.com/Abhishekog19/GrooveApp) | Android native music player (Kotlin, Room, Media3) |

---

## Author

**Abhishek** — [@Abhishekog19](https://github.com/Abhishekog19)
