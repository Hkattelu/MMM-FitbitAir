/* MagicMirror²
 * Module: MMM-SleepScore
 *
 * Shows last night's sleep from Google's Health API.
 *
 * MIT Licensed.
 */

Module.register("MMM-SleepScore", {

  defaults: {
    // Sleep data only changes once a day; hourly is plenty.
    updateInterval: 60 * 60 * 1000,
    // Port for the LAN-only endpoint the re-auth bookmarklet posts to.
    authPort: 8091,
    // How far before local midnight a session may end and still count as
    // "last night" -- covers naps and very early bedtimes.
    lookbackHours: 6,
    showStages: true,
    showEfficiency: true,
    showTimes: true,
    // Hostname/IP the phone should reach the mirror at. Auto-detected from
    // the browser URL when left empty, which is right for nearly everyone.
    mirrorHost: ""
  },

  getStyles () {
    return ["MMM-SleepScore.css"];
  },

  start () {
    this.state = "LOADING";
    this.sleep = null;
    this.auth = null;
    this.errorMessage = null;
    this.sendSocketNotification("SLEEPSCORE_CONFIG", this.config);
  },

  socketNotificationReceived (notification, payload) {
    switch (notification) {
      case "SLEEPSCORE_DATA":
        this.state = "DATA";
        this.sleep = payload;
        this.errorMessage = null;
        break;
      case "SLEEPSCORE_AUTH_REQUIRED":
        this.state = "AUTH";
        this.auth = payload;
        break;
      case "SLEEPSCORE_NO_DATA":
        this.state = "NO_DATA";
        break;
      case "SLEEPSCORE_ERROR":
        this.state = "ERROR";
        this.errorMessage = payload.message;
        break;
      default:
        return;
    }
    this.updateDom(300);
  },

  getDom () {
    const wrapper = document.createElement("div");
    wrapper.className = "sleepscore";

    switch (this.state) {
      case "DATA":
        return this.renderSleep(wrapper);
      case "AUTH":
        return this.renderAuth(wrapper);
      case "NO_DATA":
        return this.renderMessage(
          wrapper,
          "No sleep recorded last night",
          "Make sure your device has synced."
        );
      case "ERROR":
        return this.renderMessage(wrapper, "Sleep unavailable", this.errorMessage);
      default:
        return this.renderMessage(wrapper, "Loading sleep…", null);
    }
  },

  renderMessage (wrapper, title, detail) {
    const heading = document.createElement("div");
    heading.className = "sleepscore-message bright";
    heading.textContent = title;
    wrapper.appendChild(heading);

    if (detail) {
      const sub = document.createElement("div");
      sub.className = "sleepscore-detail dimmed small";
      sub.textContent = detail;
      wrapper.appendChild(sub);
    }
    return wrapper;
  },

  renderAuth (wrapper) {
    const heading = document.createElement("div");
    heading.className = "sleepscore-message bright";
    heading.textContent = "Reconnect sleep data";
    wrapper.appendChild(heading);

    const sub = document.createElement("div");
    sub.className = "sleepscore-detail dimmed small";
    // Google expires refresh tokens weekly for unverified apps, so this is
    // routine rather than a failure -- word it that way.
    sub.textContent = "Scan to sign in with Google, then tap the bookmarklet.";
    wrapper.appendChild(sub);

    if (this.auth && this.auth.qrDataUrl) {
      const qr = document.createElement("img");
      qr.className = "sleepscore-qr";
      qr.src = this.auth.qrDataUrl;
      qr.alt = "Google authorization QR code";
      wrapper.appendChild(qr);
    }

    return wrapper;
  },

  renderSleep (wrapper) {
    const s = this.sleep;

    const total = document.createElement("div");
    total.className = "sleepscore-total bright";
    total.textContent = this.formatDuration(s.asleepMinutes);
    wrapper.appendChild(total);

    if (this.config.showEfficiency && s.efficiency !== null) {
      const eff = document.createElement("div");
      eff.className = "sleepscore-efficiency small";
      eff.textContent = `${s.efficiency}% efficiency`;
      wrapper.appendChild(eff);
    }

    if (this.config.showTimes) {
      const times = document.createElement("div");
      times.className = "sleepscore-times dimmed small";
      times.textContent = `${this.formatClock(s.startTime)} – ${this.formatClock(s.endTime)}`;
      wrapper.appendChild(times);
    }

    if (this.config.showStages && s.hasStages) {
      wrapper.appendChild(this.renderStages(s));
    }

    return wrapper;
  },

  renderStages (s) {
    const table = document.createElement("table");
    table.className = "sleepscore-stages small";

    const rows = [
      ["Deep", s.stages.deep],
      ["REM", s.stages.rem],
      ["Light", s.stages.light],
      ["Awake", s.stages.awake]
    ];

    for (const [label, minutes] of rows) {
      const row = document.createElement("tr");

      const name = document.createElement("td");
      name.className = "sleepscore-stage-name dimmed";
      name.textContent = label;
      row.appendChild(name);

      const value = document.createElement("td");
      value.className = "sleepscore-stage-value";
      value.textContent = this.formatDuration(minutes);
      row.appendChild(value);

      table.appendChild(row);
    }
    return table;
  },

  formatDuration (minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  },

  formatClock (isoString) {
    const date = new Date(isoString);
    return date.toLocaleTimeString(config.language || "en-US", {
      hour: "numeric",
      minute: "2-digit"
    });
  }
});
