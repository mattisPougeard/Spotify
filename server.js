require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");

const fetch = require("node-fetch");
const cors = require("cors");
const qs = require("querystring");

const app = express();
app.use(cors());
app.use(express.static("public"));

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI,
  PLAYLIST_ID,
  PORT = 3000,
  SESSION_SECRET,
  NODE_ENV
} = process.env;

for (const [name, value] of Object.entries({
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI,
  PLAYLIST_ID
})) {
  if (!value) console.warn(`⚠️  Missing env var ${name} — check your .env file.`);
}

if (!SESSION_SECRET) {
  console.warn("⚠️  SESSION_SECRET not set — using a random value for this run only (sessions won't survive a restart). Set SESSION_SECRET in .env for production.");
}

app.use(session({
  secret: SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    httpOnly: true,
    secure: NODE_ENV === "production",
    sameSite: "lax"
  }
}));

// --- Smart Playlist Generation ---
const GENRE_MAP = {
  "Rap / Hip-Hop": [
    "hip hop","rap","east coast hip hop","southern hip hop","g-funk","jazz rap","melodic rap","cloud rap",
    "french rap","french r&b","pop urbaine","rap ivoire","rap chrétien","german hip hop","moroccan rap",
    "punjabi hip hop","hindi hip hop","desi hip hop","italian trap"
  ],
  "Drill / Trap / Phonk": [
    "drill","brooklyn drill","new york drill","uk drill","uk grime","trap latino","argentine trap","phonk",
    "brazilian phonk","drift phonk","jersey club","philly club","dembow belico","corridos tumbados",
    "corridos bélicos","electro corridos"
  ],
  "Electro / Techno": [
    "house","tech house","french house","tribal house","melodic house","progressive house","slap house",
    "stutter house","tropical house","afro house","techno","melodic techno","minimal techno","hard techno",
    "hypertechno","edm","big room","future bass","future house","melbourne bounce","progressive trance",
    "trance","psytrance","hardcore","hardstyle","frenchcore","gabber","riddim","deathstep","dubstep",
    "electronica","electronic","nu disco","italo dance","italo disco"
  ],
  "Latino": [
    "reggaeton","reggaeton chileno","reggaeton mexa","urbano latino","latin","latin dance","latin house",
    "dembow","rkt","turreo","neoperreo","salsa","merengue","mambo","cumbia","música mexicana","banda",
    "sertanejo tradicional","sierreño","sad sierreño"
  ],
  "Afro": [
    "afrobeat","afrobeats","afro house","afro soul","afro r&b","afroswing","afropop","afrogospel",
    "coupé décalé","ndombolo","rumba congolaise","shatta","zouk","kompa","kuduro","gnawa","raï"
  ],
  "Rock": [
    "rock","classic rock","southern rock","j-rock","german indie","german indie pop","french indie pop",
    "alternative dance","new wave","new rave"
  ],
  "Pop": [
    "pop","soft pop","europop","moroccan pop","bangla pop","colombian pop","french pop","j-pop","mpb",
    "new mpb","bossa nova","acoustic pop"
  ],
  "Experimental": [
    "hyperpop","ambient folk","lo-fi beats","jazz beats","nu jazz","medieval","anime","electro swing",
    "swing music","flamenco","flamenco urbano","gospel","christian reggae"
  ]
};

function mapGenreToCategory(genre) {
  for (const [cat, genres] of Object.entries(GENRE_MAP)) {
    if (genres.includes(genre.toLowerCase())) return cat;
  }
  return "Experimental";
}

// --- Spotify auth helpers -------------------------------------------------

async function exchangeCodeForToken(code) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: qs.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI
    })
  });
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: qs.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });
  return res.json();
}

/** Requires a session-authenticated user; 401s otherwise. */
function requireAuth(req, res, next) {
  if (!req.session.access_token) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

/**
 * Calls the Spotify Web API with the session's access token, transparently
 * refreshing it once and retrying on a 401.
 */
async function spotifyFetch(req, url, options = {}) {
  const doFetch = (token) =>
    fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
    });

  let response = await doFetch(req.session.access_token);

  if (response.status === 401 && req.session.refresh_token) {
    const refreshed = await refreshAccessToken(req.session.refresh_token);
    if (refreshed.access_token) {
      req.session.access_token = refreshed.access_token;
      response = await doFetch(req.session.access_token);
    }
  }

  return response;
}

async function fetchAllLikedTracks(req) {
  let allTracks = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const response = await spotifyFetch(req, `https://api.spotify.com/v1/me/tracks?limit=${limit}&offset=${offset}`);
    if (!response.ok) throw new Error(`Spotify API error (tracks): ${response.status}`);
    const data = await response.json();
    if (!data.items) break;

    allTracks = allTracks.concat(data.items);
    if (data.items.length < limit) break;
    offset += limit;
  }

  return allTracks;
}

async function fetchArtistGenres(req, artistIds) {
  const batches = [];
  for (let i = 0; i < artistIds.length; i += 50) {
    batches.push(artistIds.slice(i, i + 50));
  }

  const artistGenresMap = {};
  // Small batches (max ~50 artists each) fetched in parallel — well within
  // Spotify's rate limits for a handful of batches, and much faster than
  // the previous sequential loop with an artificial delay.
  await Promise.all(batches.map(async (batch) => {
    const r = await spotifyFetch(req, `https://api.spotify.com/v1/artists?ids=${batch.join(",")}`);
    if (!r.ok) return;
    const d = await r.json();
    (d.artists || []).forEach(a => {
      if (a) artistGenresMap[a.id] = a.genres || [];
    });
  }));

  return artistGenresMap;
}

// --- Login / OAuth ---
app.get("/login", (req, res) => {
  const scope = "user-library-read playlist-modify-public playlist-modify-private";
  const params = qs.stringify({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// --- Callback Spotify ---
app.get("/callback", async (req, res) => {
  const code = req.query.code || null;
  const authError = req.query.error || null;

  if (authError) return res.redirect(`/?error=${encodeURIComponent(authError)}`);
  if (!code) return res.redirect("/?error=missing_code");

  try {
    const data = await exchangeCodeForToken(code);
    if (!data.access_token) {
      console.error("Token exchange failed:", data);
      return res.redirect("/?error=token_exchange_failed");
    }

    req.session.access_token = data.access_token;
    req.session.refresh_token = data.refresh_token;

    res.redirect("/");
  } catch (err) {
    console.error("Callback error:", err);
    res.redirect("/?error=callback_failed");
  }
});

app.get("/scan-genres", requireAuth, async (req, res) => {
  try {
    const allTracks = await fetchAllLikedTracks(req);

    const artistIds = new Set();
    allTracks.forEach(item => item.track?.artists.forEach(artist => artistIds.add(artist.id)));
    const uniqueArtistIds = Array.from(artistIds);

    const artistGenresMap = await fetchArtistGenres(req, uniqueArtistIds);
    const allGenres = new Set();
    Object.values(artistGenresMap).forEach(genres => genres.forEach(g => allGenres.add(g)));

    res.json({
      totalTracks: allTracks.length,
      totalArtists: uniqueArtistIds.length,
      genres: Array.from(allGenres).sort()
    });
  } catch (err) {
    console.error("SCAN GENRES ERROR:", err);
    res.status(500).json({ error: "Error scanning genres", details: err.message });
  }
});

// --- Generate Smart Playlists ---
app.get("/generate-smart-playlists", requireAuth, async (req, res) => {
  try {
    // 1️⃣ Liked tracks
    const allTracks = await fetchAllLikedTracks(req);

    // 2️⃣ Unique artists → genres
    const artistIds = new Set();
    allTracks.forEach(item => item.track?.artists.forEach(a => artistIds.add(a.id)));
    const artistGenresMap = await fetchArtistGenres(req, Array.from(artistIds));

    // 3️⃣ Track → category
    const categorizedTracks = {};
    for (const cat of Object.keys(GENRE_MAP)) categorizedTracks[cat] = [];

    allTracks.forEach(item => {
      const track = item.track;
      if (!track) return;
      const trackCategories = new Set();
      track.artists.forEach(artist => {
        (artistGenresMap[artist.id] || []).forEach(g => trackCategories.add(mapGenreToCategory(g)));
      });
      if (trackCategories.size === 0) trackCategories.add("Experimental");
      trackCategories.forEach(cat => categorizedTracks[cat].push(track.uri));
    });

    // 4️⃣ Current user + existing playlists (fetched once, not per category)
    const meResp = await spotifyFetch(req, "https://api.spotify.com/v1/me");
    const meData = await meResp.json();
    const userId = meData.id;

    const playlistsResp = await spotifyFetch(req, "https://api.spotify.com/v1/me/playlists?limit=50");
    const playlistsData = await playlistsResp.json();
    const existingPlaylists = playlistsData.items || [];

    // 5️⃣ Create any missing playlists first (sequential: avoids creating
    //    two "Liked - X" playlists if categories were processed concurrently).
    const nonEmptyCategories = Object.entries(categorizedTracks).filter(([, uris]) => uris.length > 0);
    const playlistByCategory = {};

    for (const [cat] of nonEmptyCategories) {
      let playlist = existingPlaylists.find(p => p.name === `Liked - ${cat}`);
      if (!playlist) {
        const createResp = await spotifyFetch(req, `https://api.spotify.com/v1/users/${userId}/playlists`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `Liked - ${cat}`,
            public: false,
            description: `Tracks liked, categorized in ${cat}`
          })
        });
        playlist = await createResp.json();
        existingPlaylists.push(playlist);
      }
      playlistByCategory[cat] = playlist;
    }

    // 6️⃣ Clear + repopulate each playlist. Independent playlists, so this
    //    runs in parallel instead of one category waiting on the previous.
    async function clearPlaylist(playlistId) {
      let uris = [];
      let offset = 0;
      while (true) {
        const r = await spotifyFetch(req, `https://api.spotify.com/v1/playlists/${playlistId}/tracks?fields=items(track(uri)),next&limit=100&offset=${offset}`);
        if (!r.ok) break;
        const d = await r.json();
        const items = d.items || [];
        uris = uris.concat(items.map(t => t.track?.uri).filter(Boolean));
        if (!d.next) break;
        offset += 100;
      }

      for (let i = 0; i < uris.length; i += 100) {
        const batch = uris.slice(i, i + 100);
        await spotifyFetch(req, `https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tracks: batch.map(u => ({ uri: u })) })
        });
      }
    }

    async function fillPlaylist(playlistId, trackUris) {
      for (let i = 0; i < trackUris.length; i += 100) {
        const batch = trackUris.slice(i, i + 100);
        await spotifyFetch(req, `https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uris: batch })
        });
      }
    }

    const results = {};
    await Promise.all(nonEmptyCategories.map(async ([cat, trackUris]) => {
      const playlist = playlistByCategory[cat];
      await clearPlaylist(playlist.id);
      await fillPlaylist(playlist.id, trackUris);
      results[cat] = trackUris.length;
    }));

    res.json({ status: "ok", playlists: results });
  } catch (err) {
    console.error("Smart Playlist Error:", err);
    res.status(500).json({ error: "Smart Playlist Error", details: err.message });
  }
});

// --- Playlist Spotify ---
app.get("/playlist", requireAuth, async (req, res) => {
  try {
    const response = await spotifyFetch(req, `https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/tracks`);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error("Playlist error:", err);
    res.status(500).json({ error: "Spotify API error" });
  }
});

// --- Deezer preview (with a tiny in-memory cache to avoid refetching
//     the same title/artist pair repeatedly) ---
const deezerCache = new Map();
const DEEZER_CACHE_MAX = 500;

app.get("/deezer/preview", async (req, res) => {
  const { title, artist } = req.query;

  if (!title || !artist) {
    return res.status(400).json({ error: "Missing title or artist" });
  }

  const cacheKey = `${title.toLowerCase()}::${artist.toLowerCase()}`;
  if (deezerCache.has(cacheKey)) {
    return res.json(deezerCache.get(cacheKey));
  }

  try {
    const response = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(title + " " + artist)}`);
    const data = await response.json();
    const track = data.data?.find(t => t.preview);

    if (!track) return res.status(404).json({ error: "No preview found" });

    const payload = {
      title: track.title,
      artist: track.artist.name,
      preview: track.preview,
      cover: track.album.cover_medium
    };

    if (deezerCache.size >= DEEZER_CACHE_MAX) {
      deezerCache.delete(deezerCache.keys().next().value);
    }
    deezerCache.set(cacheKey, payload);

    res.json(payload);
  } catch (err) {
    console.error("Deezer error:", err);
    res.status(500).json({ error: "Deezer error" });
  }
});

// --- 404 + error handling ---
app.use((req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`Go to http://localhost:${PORT}/login to authenticate Spotify`);
});
