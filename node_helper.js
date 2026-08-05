/* MagicMirror²
 * Node Helper: MMM-FitbitAir
 *
 * Fetches sleep sessions from Google's Health API (health.googleapis.com).
 *
 * Google only supports a "Web Server" OAuth client type for the restricted
 * googlehealth.* scopes -- the device/limited-input flow is rejected with
 * invalid_scope. Since a MagicMirror on a home LAN cannot host a public HTTPS
 * callback, we use https://www.google.com as the registered redirect URI and
 * capture the ?code= parameter from that page via a bookmarklet, which posts
 * it back to the small LAN-only server this helper runs.
 *
 * MIT Licensed.
 */

const NodeHelper = require("node_helper");
const Log = require("logger");
const fs = require("fs").promises;
const path = require("path");
const http = require("http");
const QRCode = require("qrcode");

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const HEALTH_ENDPOINT =
  "https://health.googleapis.com/v4/users/me/dataTypes/sleep/dataPoints";
const SCOPE = "https://www.googleapis.com/auth/googlehealth.sleep.readonly";
const REDIRECT_URI = "https://www.google.com";

const CREDENTIALS_PATH = path.join(__dirname, "google-credentials.json");
const TOKEN_PATH = path.join(__dirname, "token.json");

// Refresh a little early so a long request can't straddle the expiry.
const EXPIRY_SKEW_MS = 60 * 1000;

module.exports = NodeHelper.create({
  start () {
    this.credentials = null;
    this.tokens = null;
    this.config = null;
    this.authServer = null;
    this.fetchTimer = null;
    Log.info("Starting node helper for: MMM-FitbitAir");
  },

  socketNotificationReceived (notification, payload) {
    if (notification === "FITBITAIR_CONFIG") {
      // The frontend re-sends config on every browser refresh; only do the
      // one-time setup once so we don't stack timers or servers.
      const firstRun = this.config === null;
      this.config = payload;

      if (firstRun) {
        this.startAuthServer();
      }
      this.refreshAndFetch();

      if (firstRun) {
        this.fetchTimer = setInterval(
          () => this.refreshAndFetch(),
          this.config.updateInterval
        );
      }
    }
  },

  /* ---------------------------------------------------------------- config */

  async loadCredentials () {
    if (this.credentials) {
      return this.credentials;
    }
    try {
      const raw = await fs.readFile(CREDENTIALS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed.client_id || !parsed.client_secret) {
        throw new Error("client_id and client_secret are both required");
      }
      this.credentials = parsed;
      return this.credentials;
    } catch (err) {
      if (err.code === "ENOENT") {
        throw new Error(
          "google-credentials.json not found. Copy google-credentials.json.sample and fill in your OAuth client details."
        );
      }
      throw err;
    }
  },

  async loadTokens () {
    if (this.tokens) {
      return this.tokens;
    }
    try {
      this.tokens = JSON.parse(await fs.readFile(TOKEN_PATH, "utf8"));
      return this.tokens;
    } catch (err) {
      if (err.code !== "ENOENT") {
        Log.error(`MMM-FitbitAir: could not read token.json - ${err.message}`);
      }
      return null;
    }
  },

  async saveTokens (tokens) {
    this.tokens = tokens;
    // Tokens are as sensitive as a password: keep them owner-readable only.
    await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), {
      mode: 0o600
    });
  },

  async clearTokens () {
    this.tokens = null;
    try {
      await fs.unlink(TOKEN_PATH);
    } catch (err) {
      if (err.code !== "ENOENT") {
        Log.error(`MMM-FitbitAir: could not clear token.json - ${err.message}`);
      }
    }
  },

  /* ------------------------------------------------------------------ auth */

  async buildAuthUrl () {
    const { client_id: clientId } = await this.loadCredentials();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPE,
      // offline + consent is what actually mints a refresh token; without
      // prompt=consent Google silently omits it on repeat authorizations.
      access_type: "offline",
      prompt: "consent"
    });
    return `${AUTH_ENDPOINT}?${params.toString()}`;
  },

  async sendAuthRequired (reason) {
    try {
      const authUrl = await this.buildAuthUrl();
      const qrDataUrl = await QRCode.toDataURL(authUrl, {
        margin: 1,
        width: 256,
        color: { dark: "#ffffff", light: "#00000000" }
      });
      this.sendSocketNotification("FITBITAIR_AUTH_REQUIRED", {
        authUrl,
        qrDataUrl,
        submitPort: this.config.authPort,
        reason
      });
    } catch (err) {
      this.sendError(err.message);
    }
  },

  sendError (message) {
    Log.error(`MMM-FitbitAir: ${message}`);
    this.sendSocketNotification("FITBITAIR_ERROR", { message });
  },

  /** Exchange an authorization code (or refresh token) for access tokens. */
  async requestTokens (bodyParams) {
    const { client_id: clientId, client_secret: clientSecret } =
      await this.loadCredentials();

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      ...bodyParams
    });

    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const err = new Error(
        data.error_description || data.error || `HTTP ${res.status}`
      );
      err.oauthError = data.error;
      throw err;
    }
    return data;
  },

  async exchangeCode (code) {
    const data = await this.requestTokens({
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI
    });

    if (!data.refresh_token) {
      throw new Error(
        "Google did not return a refresh token. Revoke this app's access at myaccount.google.com/permissions and authorize again."
      );
    }

    await this.saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expiry: Date.now() + data.expires_in * 1000
    });
    Log.info("MMM-FitbitAir: authorization successful");
  },

  /**
   * Returns a valid access token, refreshing if needed.
   * Returns null when the user needs to (re)authorize -- which for an
   * unverified app happens every 7 days, by Google policy.
   */
  async getAccessToken () {
    const tokens = await this.loadTokens();
    if (!tokens || !tokens.refresh_token) {
      return null;
    }

    if (tokens.access_token && Date.now() < tokens.expiry - EXPIRY_SKEW_MS) {
      return tokens.access_token;
    }

    try {
      const data = await this.requestTokens({
        refresh_token: tokens.refresh_token,
        grant_type: "refresh_token"
      });
      await this.saveTokens({
        access_token: data.access_token,
        // A refresh response usually omits refresh_token; keep the old one.
        refresh_token: data.refresh_token || tokens.refresh_token,
        expiry: Date.now() + data.expires_in * 1000
      });
      return this.tokens.access_token;
    } catch (err) {
      if (err.oauthError === "invalid_grant") {
        // Expected on the weekly expiry -- not an error worth alarming about.
        Log.info(
          "MMM-FitbitAir: refresh token expired (7-day limit for unverified apps), re-authorization needed"
        );
        await this.clearTokens();
        return null;
      }
      throw err;
    }
  },

  /* ---------------------------------------------------- local auth handoff */

  /**
   * A tiny LAN-only endpoint the bookmarklet calls with the code copied from
   * the google.com redirect. Deliberately minimal: one route, no static files.
   */
  startAuthServer () {
    const port = this.config.authPort;

    this.authServer = http.createServer(async (req, res) => {
      // The bookmarklet runs on www.google.com, so the browser sends a
      // cross-origin request; allow it explicitly.
      res.setHeader("Access-Control-Allow-Origin", "*");

      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== "/submit") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing 'code' parameter");
        return;
      }

      try {
        await this.exchangeCode(code);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<h1>Mirror connected</h1><p>Sleep data will appear shortly. You can close this tab.</p>"
        );
        this.refreshAndFetch();
      } catch (err) {
        Log.error(`MMM-FitbitAir: code exchange failed - ${err.message}`);
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h1>Authorization failed</h1><p>${err.message}</p>`);
        this.sendError(`Authorization failed: ${err.message}`);
      }
    });

    this.authServer.on("error", (err) => {
      this.sendError(`Auth server could not start on port ${port}: ${err.message}`);
    });

    this.authServer.listen(port, () => {
      Log.info(`MMM-FitbitAir: auth handoff listening on port ${port}`);
    });
  },

  stop () {
    if (this.fetchTimer) {
      clearInterval(this.fetchTimer);
    }
    if (this.authServer) {
      this.authServer.close();
    }
  },

  /* ------------------------------------------------------------ data fetch */

  /**
   * Start of the window we consider "last night". Sleep that began late the
   * previous evening still ends this morning, so anchoring on local midnight
   * and looking at sessions ending after it captures the whole night.
   */
  windowStart () {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    // A nap yesterday afternoon shouldn't win over last night's sleep, but a
    // session that ended at 00:30 should still count, so reach back slightly.
    start.setHours(start.getHours() - this.config.lookbackHours);
    return start;
  },

  async refreshAndFetch () {
    try {
      const accessToken = await this.getAccessToken();
      if (!accessToken) {
        await this.sendAuthRequired("expired");
        return;
      }
      await this.fetchSleep(accessToken);
    } catch (err) {
      this.sendError(err.message);
    }
  },

  async fetchSleep (accessToken) {
    const filter = `sleep.interval.end_time >= "${this.windowStart().toISOString()}"`;
    const url = `${HEALTH_ENDPOINT}?${new URLSearchParams({ filter })}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (res.status === 401 || res.status === 403) {
      // Token rejected despite being fresh -- treat as needing re-consent
      // (e.g. the user revoked access, or scopes changed).
      await this.clearTokens();
      await this.sendAuthRequired("rejected");
      return;
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Health API returned ${res.status}. ${detail.slice(0, 200)}`);
    }

    const body = await res.json();
    const session = this.pickMainSession(body.dataPoints || []);

    if (!session) {
      this.sendSocketNotification("FITBITAIR_NO_DATA", {});
      return;
    }

    this.sendSocketNotification("FITBITAIR_DATA", this.summarize(session));
  },

  /** The longest qualifying session is the night's sleep; the rest are naps. */
  pickMainSession (dataPoints) {
    let best = null;
    let bestDuration = 0;

    for (const point of dataPoints) {
      const sleep = point.sleep;
      if (!sleep || !sleep.interval) {
        continue;
      }
      const start = new Date(sleep.interval.startTime).getTime();
      const end = new Date(sleep.interval.endTime).getTime();
      const duration = end - start;

      if (Number.isFinite(duration) && duration > bestDuration) {
        best = point;
        bestDuration = duration;
      }
    }
    return best;
  },

  /**
   * Reduce a Health API session to the few numbers we actually display.
   * Stage names are uppercase enums (AWAKE / LIGHT / DEEP / REM) in this API,
   * unlike the lowercase ones the old Fitbit Web API used.
   */
  summarize (point) {
    const sleep = point.sleep;
    const start = new Date(sleep.interval.startTime);
    const end = new Date(sleep.interval.endTime);
    const inBedMinutes = Math.round((end - start) / 60000);

    const stageMinutes = { DEEP: 0, LIGHT: 0, REM: 0, AWAKE: 0 };

    for (const stage of sleep.stages || []) {
      const key = String(stage.type || stage.stage || "").toUpperCase();
      if (!(key in stageMinutes)) {
        continue;
      }
      const stageStart = new Date(stage.interval?.startTime ?? stage.startTime);
      const stageEnd = new Date(stage.interval?.endTime ?? stage.endTime);
      const minutes = (stageEnd - stageStart) / 60000;
      if (Number.isFinite(minutes) && minutes > 0) {
        stageMinutes[key] += minutes;
      }
    }

    const staged = Object.values(stageMinutes).reduce((a, b) => a + b, 0);
    // Prefer the API's own summary when present; fall back to stage math, and
    // finally to raw time in bed when a device reports no stages at all.
    const asleepMinutes =
      sleep.summary?.minutesAsleep ??
      (staged > 0 ? staged - stageMinutes.AWAKE : inBedMinutes);

    return {
      startTime: sleep.interval.startTime,
      endTime: sleep.interval.endTime,
      inBedMinutes,
      asleepMinutes: Math.round(asleepMinutes),
      efficiency:
        inBedMinutes > 0
          ? Math.round((asleepMinutes / inBedMinutes) * 100)
          : null,
      stages: {
        deep: Math.round(stageMinutes.DEEP),
        light: Math.round(stageMinutes.LIGHT),
        rem: Math.round(stageMinutes.REM),
        awake: Math.round(stageMinutes.AWAKE)
      },
      hasStages: staged > 0
    };
  }
});
