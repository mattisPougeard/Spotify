require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");

const fetch = require("node-fetch");

const app = express();
app.use(express.static("public"));
app.use(express.json());

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI,
  PLAYLIST_ID,
} = process.env;

const PORT = Number(process.env.PORT) || 3001;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET) {
  console.warn("SESSION_SECRET is missing from .env — sessions will be insecure.");
}

app.use(
  session({
    secret: SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  })
);

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function basicAuthHeader() {
  return (
    "Basic " +
    Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")
  );
}

function mapGenreToCategory(genre) {
  const g = String(genre || "").toLowerCase();
  if (!g) return "Experimental";

  for (const [cat, genres] of Object.entries(GENRE_MAP)) {
    if (genres.includes(g)) return cat;
  }

  for (const [cat, genres] of Object.entries(GENRE_MAP)) {
    if (genres.some((mapped) => mapped.length >= 4 && (g.includes(mapped) || mapped.includes(g)))) {
      return cat;
    }
  }

  return "Experimental";
}

function uniqueUris(uris) {
  const seen = new Set();
  const out = [];
  for (const uri of uris) {
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    out.push(uri);
  }
  return out;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { res, data };
}

async function refreshAccessToken(req) {
  const refreshToken = req.session.refresh_token;
  if (!refreshToken) return false;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const { res, data } = await fetchJson("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok || !data?.access_token) {
    console.error("Token refresh failed:", data);
    return false;
  }

  req.session.access_token = data.access_token;
  if (data.refresh_token) req.session.refresh_token = data.refresh_token;
  return true;
}

async function spotifyRequest(req, url, options = {}, retryAuth = true) {
  const token = req.session.access_token;
  if (!token) {
    const err = new Error("Not authenticated");
    err.status = 401;
    throw err;
  }

  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${token}`,
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { ...options, headers });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") || 1);
      await sleep(Math.min(retryAfter, 10) * 1000);
      continue;
    }

    if (res.status === 401 && retryAuth) {
      const refreshed = await refreshAccessToken(req);
      if (refreshed) return spotifyRequest(req, url, options, false);
    }

    return res;
  }

  const err = new Error("Spotify rate limit exceeded");
  err.status = 429;
  throw err;
}

async function spotifyJson(req, url, options = {}) {
  const res = await spotifyRequest(req, url, options);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Spotify API error (${res.status})`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

async function fetchAllItems(req, buildUrl) {
  const items = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const data = await spotifyJson(req, buildUrl(limit, offset));
    const page = data.items || [];
    items.push(...page);
    if (page.length < limit || !data.next) break;
    offset += limit;
  }

  return items;
}

async function fetchLikedTracks(req) {
  const items = await fetchAllItems(
    req,
    (limit, offset) => `https://api.spotify.com/v1/me/tracks?limit=${limit}&offset=${offset}`
  );
  return items.filter((item) => item?.track?.uri && !item.track.is_local);
}

async function fetchArtistGenresMap(req, artistIds) {
  const uniqueIds = [...new Set(artistIds.filter(Boolean))];
  const artistGenresMap = {};

  for (let i = 0; i < uniqueIds.length; i += 50) {
    const batch = uniqueIds.slice(i, i + 50).join(",");
    const data = await spotifyJson(req, `https://api.spotify.com/v1/artists?ids=${batch}`);
    for (const artist of data.artists || []) {
      if (artist?.id) artistGenresMap[artist.id] = artist.genres || [];
    }
  }

  return artistGenresMap;
}

async function replacePlaylistTracks(req, playlistId, uris) {
  const first = uris.slice(0, 100);
  await spotifyJson(req, `https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uris: first }),
  });

  for (let i = 100; i < uris.length; i += 100) {
    const batch = uris.slice(i, i + 100);
    await spotifyJson(req, `https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uris: batch }),
    });
  }
}

function requireAuth(req, res, next) {
  if (!req.session.access_token) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

function sendError(res, err, fallback) {
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  console.error(fallback, err.message);
  res.status(status).json({ error: fallback });
}

app.get("/auth/status", (req, res) => {
  res.json({ authenticated: Boolean(req.session.access_token) });
});

app.get("/login", (req, res) => {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_REDIRECT_URI) {
    return res.status(500).send("Spotify OAuth is not configured.");
  }

  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauth_state = state;

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: "user-library-read playlist-modify-public playlist-modify-private playlist-read-private",
    state,
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send("Spotify authorization was denied.");
  }
  if (!code || !state || state !== req.session.oauth_state) {
    return res.status(400).send("Invalid OAuth state.");
  }

  delete req.session.oauth_state;

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: SPOTIFY_REDIRECT_URI,
    });

    const { res: tokenRes, data } = await fetchJson("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!tokenRes.ok || !data?.access_token) {
      console.error("Token exchange failed:", data);
      return res.status(400).send("Could not complete Spotify login.");
    }

    req.session.access_token = data.access_token;
    req.session.refresh_token = data.refresh_token;
    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.status(500).send("Could not complete Spotify login.");
  }
});

app.get("/scan-genres", requireAuth, async (req, res) => {
  try {
    const liked = await fetchLikedTracks(req);
    const artistIds = liked.flatMap((item) => item.track.artists.map((a) => a.id));
    const artistGenresMap = await fetchArtistGenresMap(req, artistIds);
    const genres = new Set();

    Object.values(artistGenresMap).forEach((list) => {
      list.forEach((genre) => genres.add(genre));
    });

    res.json({
      totalTracks: liked.length,
      totalArtists: Object.keys(artistGenresMap).length,
      genres: [...genres].sort(),
    });
  } catch (err) {
    sendError(res, err, "Error scanning genres");
  }
});

app.get("/generate-smart-playlists", requireAuth, async (req, res) => {
  try {
    const liked = await fetchLikedTracks(req);
    const artistIds = liked.flatMap((item) => item.track.artists.map((a) => a.id));
    const artistGenresMap = await fetchArtistGenresMap(req, artistIds);

    const categorizedTracks = {};
    for (const cat of Object.keys(GENRE_MAP)) categorizedTracks[cat] = [];

    for (const item of liked) {
      const track = item.track;
      const trackCategories = new Set();

      for (const artist of track.artists || []) {
        const genres = artistGenresMap[artist.id] || [];
        for (const genre of genres) trackCategories.add(mapGenreToCategory(genre));
      }

      if (trackCategories.size === 0) trackCategories.add("Experimental");
      for (const cat of trackCategories) categorizedTracks[cat].push(track.uri);
    }

    const me = await spotifyJson(req, "https://api.spotify.com/v1/me");
    const existingPlaylists = await fetchAllItems(
      req,
      (limit, offset) => `https://api.spotify.com/v1/me/playlists?limit=${limit}&offset=${offset}`
    );

    const results = {};

    for (const [cat, trackUris] of Object.entries(categorizedTracks)) {
      const uris = uniqueUris(trackUris);
      if (uris.length === 0) continue;

      const name = `Liked - ${cat}`;
      let playlist = existingPlaylists.find((p) => p.name === name);

      if (!playlist) {
        playlist = await spotifyJson(
          req,
          `https://api.spotify.com/v1/users/${encodeURIComponent(me.id)}/playlists`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name,
              public: false,
              description: `Tracks liked, categorized in ${cat}`,
            }),
          }
        );
        existingPlaylists.push(playlist);
      }

      await replacePlaylistTracks(req, playlist.id, uris);
      results[cat] = uris.length;
    }

    res.json({ status: "ok", playlists: results });
  } catch (err) {
    sendError(res, err, "Smart Playlist Error");
  }
});

app.get("/playlist", requireAuth, async (req, res) => {
  if (!PLAYLIST_ID) {
    return res.status(500).json({ error: "PLAYLIST_ID is not configured" });
  }

  try {
    const items = await fetchAllItems(
      req,
      (limit, offset) =>
        `https://api.spotify.com/v1/playlists/${encodeURIComponent(PLAYLIST_ID)}/tracks?limit=${limit}&offset=${offset}`
    );
    res.json({ items });
  } catch (err) {
    sendError(res, err, "Spotify API error");
  }
});

app.get("/deezer/preview", async (req, res) => {
  const title = String(req.query.title || "").trim();
  const artist = String(req.query.artist || "").trim();

  if (!title || !artist) {
    return res.status(400).json({ error: "Missing title or artist" });
  }

  try {
    const searches = [
      `track:"${title}" artist:"${artist}"`,
      `${title} ${artist}`,
    ];

    let data = null;
    for (const query of searches) {
      const { res: dzRes, data: payload } = await fetchJson(
        `https://api.deezer.com/search?q=${encodeURIComponent(query)}`
      );
      if (!dzRes.ok) continue;
      data = payload;
      if (payload?.data?.length) break;
    }

    if (!data) {
      return res.status(502).json({ error: "Deezer error" });
    }

    const track =
      data.data?.find(
        (t) =>
          t.preview &&
          t.title?.toLowerCase() === title.toLowerCase() &&
          t.artist?.name?.toLowerCase() === artist.toLowerCase()
      ) || data.data?.find((t) => t.preview);

    if (!track) return res.status(404).json({ error: "No preview found" });

    res.json({
      title: track.title,
      artist: track.artist.name,
      preview: track.preview,
      cover: track.album.cover_medium,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Deezer error" });
  }
});

app.listen(PORT, () => {
  const host = SPOTIFY_REDIRECT_URI?.includes("127.0.0.1") ? "127.0.0.1" : "localhost";
  console.log(`Server running: http://${host}:${PORT}`);
  console.log(`Go to http://${host}:${PORT}/login to authenticate Spotify`);
});
