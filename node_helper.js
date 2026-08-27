/* MagicMirror²
 * Node Helper: MMM-FitbitAir
 *
 * Fetches sleep sessions from Google's Health API (health.googleapis.com).
 *
 * Google only supports a "Web Server" OAuth client type for the restricted
 * googlehealth.* scopes -- the device/limited-input flow is rejected with
 * invalid_scope. A MagicMirror on a home LAN has no public HTTPS URL of its
 * own to register as the redirect target, so REDIRECT_URI points at a static
 * page in this repo's docs/ folder, published via GitHub Pages. That page
 * reads the authorization code out of its own URL and relays it to this
 * mirror's LAN address, which travels through the flow in the `state`
 * parameter (see buildAuthUrl and docs/callback.html).
 *
 * MIT Licensed.
 */

const NodeHelper = require("node_helper");
const Log = require("logger");
const fs = require("fs").promises;
const path = require("path");
const http = require("http");
const os = require("os");
const QRCode = require("qrcode");

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const HEALTH_ENDPOINT =
  "https://health.googleapis.com/v4/users/me/dataTypes/sleep/dataPoints";
const SCOPE = "https://www.googleapis.com/auth/googlehealth.sleep.readonly";
// This repo's GitHub Pages site -- note it's hkattelu.com, not
// hkattelu.github.io: a custom domain verified on the account's user site
// makes GitHub publish every project site under that domain instead. A fork
// publishing its own Pages site needs to point this at whatever its own
// repo's Pages settings report, which may or may not be a plain *.github.io
// URL depending on the forking account's own setup.
const REDIRECT_URI = "https://hkattelu.com/MMM-FitbitAir/callback.html";

const CREDENTIALS_PATH = path.join(__dirname, "google-credentials.json");
const TOKEN_PATH = path.join(__dirname, "token.json");

// Refresh a little early so a long request can't straddle the expiry.
const EXPIRY_SKEW_MS = 60 * 1000;

// Interfaces that exist on the mirror but that a phone on the same Wi-Fi
// cannot reach: loopback, Docker bridges, VPN tunnels, VM adapters.
const VIRTUAL_INTERFACE =
  /^(lo|docker|br-|veth|vmnet|vboxnet|tun|tap|utun|tailscale|zt)/i;
const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function escapeHtml (value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = NodeHelper.create({
  start () {
    this.credentials = null;
    this.tokens = null;
    this.config = null;
    this.authServer = null;
    this.fetchTimer = null;
    // undefined = not looked up yet; null = looked up and nothing usable found.
    this.detectedHost = undefined;
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

    // Carried through the flow in `state` and echoed back by Google onto the
    // callback page, so a redirect that's the same for every install can
    // still find its way back to this particular mirror.
    const host = this.getMirrorHost();
    if (!host) {
      throw new Error(
        "Could not work out this mirror's LAN address for the sign-in link. Set mirrorHost in the module config to the IP your phone can reach."
      );
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPE,
      // offline + consent is what actually mints a refresh token; without
      // prompt=consent Google silently omits it on repeat authorizations.
      access_type: "offline",
      prompt: "consent",
      state: `${host}:${this.config.authPort}`
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

  /* -------------------------------------------------------- mirror address */

  /**
   * This mirror's address as a phone on the same network would reach it.
   * Private-range IPv4 wins outright; anything else is only a last resort,
   * and the virtual interfaces Docker and VPNs leave behind are skipped
   * entirely, since they resolve on the mirror but not from a phone.
   */
  detectMirrorHost () {
    let fallback = null;

    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
      if (VIRTUAL_INTERFACE.test(name)) {
        continue;
      }
      for (const address of addresses || []) {
        if (address.internal || address.family !== "IPv4") {
          continue;
        }
        if (PRIVATE_IPV4.test(address.address)) {
          return address.address;
        }
        fallback = fallback || address.address;
      }
    }
    return fallback;
  },

  /**
   * Where the phone should reach this mirror. A configured mirrorHost wins;
   * otherwise detect it once and keep the answer, failure included -- walking
   * the interfaces again on every poll would only repeat the same log line.
   */
  getMirrorHost () {
    if (this.config.mirrorHost) {
      return this.config.mirrorHost;
    }
    if (this.detectedHost === undefined) {
      this.detectedHost = this.detectMirrorHost();
      if (!this.detectedHost) {
        Log.error(
          "MMM-FitbitAir: could not work out this mirror's LAN address. Set mirrorHost in the module config to the IP your phone can reach."
        );
      }
    }
    return this.detectedHost;
  },

  /* ---------------------------------------------------- local auth handoff */

  /**
   * A tiny LAN-only server with one route: the callback page (see
   * docs/callback.html) relays the authorization code here as a plain page
   * navigation once Google redirects to it. No static files, no CORS needed
   * -- a top-level navigation isn't subject to CORS the way fetch/XHR are.
   */
  startAuthServer () {
    const port = this.config.authPort;

    this.authServer = http.createServer(async (req, res) => {
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
        res.end(`<h1>Authorization failed</h1><p>${escapeHtml(err.message)}</p>`);
        this.sendError(`Authorization failed: ${err.message}`);
      }
    });

    this.authServer.on("error", (err) => {
      this.sendError(`Auth server could not start on port ${port}: ${err.message}`);
    });

    this.authServer.listen(port, () => {
      // Resolve the address now rather than on first use, so a bad guess
      // shows up in the log at startup instead of a week later.
      const host = this.getMirrorHost();
      Log.info(
        `MMM-FitbitAir: auth handoff listening on ${host || "this host"}:${port}`
      );
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
   * Oldest session worth fetching. Bounded so the response stays small; the
   * newest session inside the window is the one we actually display.
   */
  windowStart () {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - this.config.lookbackDays);
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
    // Search a window of nights rather than just last night: a watch that
    // hasn't synced yet this morning is the common case, and showing the
    // previous night labelled with its age beats showing nothing.
    const filter = `sleep.interval.end_time >= "${this.windowStart().toISOString()}"`;
    const url = `${HEALTH_ENDPOINT}?${new URLSearchParams({ filter })}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // Always log the raw failure: without it, a cleared token looks like a
      // spontaneous logout and the real cause is invisible.
      Log.error(
        `MMM-FitbitAir: Health API returned ${res.status} - ${detail.slice(0, 500)}`
      );

      if (res.status === 401) {
        // The token itself was rejected (revoked, or scopes changed), so
        // re-consent is the only fix.
        await this.clearTokens();
        await this.sendAuthRequired("rejected");
        return;
      }

      // 403 usually means the project is misconfigured -- API not enabled,
      // quota, or a missing scope -- none of which a new token would fix.
      // Throwing away a working refresh token here would just force a
      // pointless re-auth loop, so keep it and surface the message instead.
      throw new Error(this.describeApiFailure(res.status, detail));
    }

    const body = await res.json();
    const session = this.pickMainSession(body.dataPoints || []);

    if (!session) {
      this.sendSocketNotification("FITBITAIR_NO_DATA", {});
      return;
    }

    this.sendSocketNotification("FITBITAIR_DATA", this.summarize(session));
  },

  /**
   * Turn an API failure into something a user can act on. The raw Google
   * payload is accurate but says nothing about which console page to visit.
   */
  describeApiFailure (status, detail) {
    if (status === 403 && /SERVICE_DISABLED|has not been used|is disabled/i.test(detail)) {
      return "Google Health API is not enabled for this project. Enable it in the Cloud Console under APIs & Services → Library.";
    }
    if (status === 403 && /insufficient|scope/i.test(detail)) {
      return "The token is missing the sleep scope. Remove access at myaccount.google.com/permissions, then re-authorize.";
    }
    if (status === 429) {
      return "Rate limited by the Health API. It will retry on the next update.";
    }
    return `Health API error ${status}. See the MagicMirror log for details.`;
  },

  /**
   * The most recently *ended* session is the night we want. (The API returns
   * newest first, but that ordering isn't contractual, so sort explicitly.)
   */
  pickMainSession (dataPoints) {
    let best = null;
    let bestEnd = -Infinity;

    for (const point of dataPoints) {
      const sleep = point.sleep;
      if (!sleep || !sleep.interval) {
        continue;
      }
      const end = new Date(sleep.interval.endTime).getTime();
      if (Number.isFinite(end) && end > bestEnd) {
        best = point;
        bestEnd = end;
      }
    }
    return best;
  },

  /** Google returns durations as strings ("433"); coerce them safely. */
  toNumber (value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  },

  /** Offsets arrive as a Go-style duration string, e.g. "-14400s". */
  offsetMs (value) {
    return this.toNumber(String(value ?? "0").replace(/s$/, "")) * 1000;
  },

  /**
   * Whole days between a session's local end date and today's local date.
   * Uses the offset the device recorded rather than the mirror's current
   * offset, so DST changes and travel don't skew the count.
   */
  nightsAgo (endTime, endUtcOffset) {
    const endLocalDay = Math.floor(
      (new Date(endTime).getTime() + this.offsetMs(endUtcOffset)) / 86400000
    );
    const now = new Date();
    const todayLocalDay = Math.floor(
      (now.getTime() - now.getTimezoneOffset() * 60000) / 86400000
    );
    return Math.max(0, todayLocalDay - endLocalDay);
  },

  /**
   * Reduce a Health API session to the few numbers we actually display.
   * Stage names are uppercase enums (AWAKE / LIGHT / DEEP / REM) in this API,
   * unlike the lowercase ones the old Fitbit Web API used.
   */
  summarize (point) {
    const sleep = point.sleep;
    const summary = sleep.summary;
    const start = new Date(sleep.interval.startTime);
    const end = new Date(sleep.interval.endTime);

    const stages = summary?.stagesSummary
      ? this.stagesFromSummary(summary.stagesSummary)
      : this.stagesFromIntervals(sleep.stages);

    const stagedTotal = Object.values(stages).reduce((a, b) => a + b, 0);

    // minutesInSleepPeriod is the device's own view of the period and can
    // differ slightly from the raw interval; trust it when offered.
    const inBedMinutes = summary?.minutesInSleepPeriod
      ? this.toNumber(summary.minutesInSleepPeriod)
      : Math.round((end - start) / 60000);

    // Prefer the reported figure, then stages minus awake, then time in bed
    // for devices that report no stages at all.
    const asleepMinutes = summary?.minutesAsleep
      ? this.toNumber(summary.minutesAsleep)
      : stagedTotal > 0
        ? stagedTotal - stages.awake
        : inBedMinutes;

    return {
      startTime: sleep.interval.startTime,
      endTime: sleep.interval.endTime,
      startUtcOffset: sleep.interval.startUtcOffset,
      endUtcOffset: sleep.interval.endUtcOffset,
      nightsAgo: this.nightsAgo(
        sleep.interval.endTime,
        sleep.interval.endUtcOffset
      ),
      inBedMinutes,
      asleepMinutes: Math.round(asleepMinutes),
      efficiency:
        inBedMinutes > 0
          ? Math.round((asleepMinutes / inBedMinutes) * 100)
          : null,
      stages,
      hasStages: stagedTotal > 0
    };
  },

  /** Preferred path: the API pre-totals each stage for us. */
  stagesFromSummary (stagesSummary) {
    const stages = { deep: 0, light: 0, rem: 0, awake: 0 };
    for (const entry of stagesSummary) {
      const key = String(entry.type || "").toLowerCase();
      if (key in stages) {
        stages[key] += this.toNumber(entry.minutes);
      }
    }
    return stages;
  },

  /**
   * Fallback for sessions without a summary: add up the stage intervals.
   * Timestamps sit directly on each stage, though older payloads nest them
   * under `interval`, so accept both.
   */
  stagesFromIntervals (rawStages) {
    const stages = { deep: 0, light: 0, rem: 0, awake: 0 };
    for (const stage of rawStages || []) {
      const key = String(stage.type || stage.stage || "").toLowerCase();
      if (!(key in stages)) {
        continue;
      }
      const from = new Date(stage.interval?.startTime ?? stage.startTime);
      const to = new Date(stage.interval?.endTime ?? stage.endTime);
      const minutes = (to - from) / 60000;
      if (Number.isFinite(minutes) && minutes > 0) {
        stages[key] += minutes;
      }
    }
    for (const key of Object.keys(stages)) {
      stages[key] = Math.round(stages[key]);
    }
    return stages;
  }
});
