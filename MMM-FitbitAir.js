/* MagicMirror²
 * Module: MMM-FitbitAir
 *
 * Shows last night's sleep from Google's Health API.
 *
 * MIT Licensed.
 */

Module.register("MMM-FitbitAir", {

  defaults: {
    // Sleep data only changes once a day; hourly is plenty.
    updateInterval: 60 * 60 * 1000,
    // Port for the LAN-only endpoint the re-auth bookmarklet posts to.
    authPort: 8091,
    // How many nights back to search for the most recent session. A watch
    // that hasn't synced yet this morning is common, so showing the previous
    // night (labelled with its age) beats showing nothing.
    lookbackDays: 14,
    showStages: true,
    showEfficiency: true,
    showTimes: true,
    // Donut chart of the stage breakdown, with the total in its centre.
    showChart: true,
    // Hostname/IP the phone should reach the mirror at. Auto-detected from
    // the browser URL when left empty, which is right for nearly everyone.
    mirrorHost: ""
  },

  getStyles () {
    return ["MMM-FitbitAir.css"];
  },

  start () {
    this.state = "LOADING";
    this.sleep = null;
    this.auth = null;
    this.errorMessage = null;
    this.sendSocketNotification("FITBITAIR_CONFIG", this.config);
  },

  socketNotificationReceived (notification, payload) {
    switch (notification) {
      case "FITBITAIR_DATA":
        this.state = "DATA";
        this.sleep = payload;
        this.errorMessage = null;
        break;
      case "FITBITAIR_AUTH_REQUIRED":
        this.state = "AUTH";
        this.auth = payload;
        break;
      case "FITBITAIR_NO_DATA":
        this.state = "NO_DATA";
        break;
      case "FITBITAIR_ERROR":
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
    wrapper.className = "fitbitair";

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
    heading.className = "fitbitair-message bright";
    heading.textContent = title;
    wrapper.appendChild(heading);

    if (detail) {
      const sub = document.createElement("div");
      sub.className = "fitbitair-detail dimmed small";
      sub.textContent = detail;
      wrapper.appendChild(sub);
    }
    return wrapper;
  },

  renderAuth (wrapper) {
    const heading = document.createElement("div");
    heading.className = "fitbitair-message bright";
    heading.textContent = "Reconnect sleep data";
    wrapper.appendChild(heading);

    const sub = document.createElement("div");
    sub.className = "fitbitair-detail dimmed small";
    // Google expires refresh tokens weekly for unverified apps, so this is
    // routine rather than a failure -- word it that way.
    sub.textContent = "Scan to sign in with Google, then tap the bookmarklet.";
    wrapper.appendChild(sub);

    if (this.auth && this.auth.qrDataUrl) {
      const qr = document.createElement("img");
      qr.className = "fitbitair-qr";
      qr.src = this.auth.qrDataUrl;
      qr.alt = "Google authorization QR code";
      wrapper.appendChild(qr);
    }

    return wrapper;
  },

  renderSleep (wrapper) {
    const s = this.sleep;
    const charted = this.config.showChart && s.hasStages;

    if (charted) {
      // The donut carries the total in its centre, so the standalone
      // headline would just repeat it.
      wrapper.appendChild(this.renderChart(s));
    } else {
      const total = document.createElement("div");
      total.className = "fitbitair-total bright";
      total.textContent = this.formatDuration(s.asleepMinutes);
      wrapper.appendChild(total);

      if (this.config.showEfficiency && s.efficiency !== null) {
        const eff = document.createElement("div");
        eff.className = "fitbitair-efficiency small";
        eff.textContent = `${s.efficiency}% efficiency`;
        wrapper.appendChild(eff);
      }
    }

    if (this.config.showTimes) {
      const times = document.createElement("div");
      times.className = "fitbitair-times dimmed small";
      times.textContent = `${this.formatClock(s.startTime)} – ${this.formatClock(s.endTime)}`;
      wrapper.appendChild(times);
    }

    // Without this, a stale reading is indistinguishable from last night's --
    // the most misleading thing this module could do.
    if (s.nightsAgo > 1) {
      const stale = document.createElement("div");
      stale.className = "fitbitair-stale dimmed xsmall";
      stale.textContent = `${s.nightsAgo} nights ago — device hasn't synced since`;
      wrapper.appendChild(stale);
    }

    if (this.config.showStages && s.hasStages) {
      wrapper.appendChild(this.renderStages(s, charted));
    }

    return wrapper;
  },

  /** Stage order runs deepest to lightest so the ring reads as a gradient. */
  stageRows (s) {
    return [
      { key: "deep", label: "Deep", minutes: s.stages.deep },
      { key: "rem", label: "REM", minutes: s.stages.rem },
      { key: "light", label: "Light", minutes: s.stages.light },
      { key: "awake", label: "Awake", minutes: s.stages.awake }
    ];
  },

  /**
   * A donut built from stroke-dasharray arcs. Deliberately no chart library:
   * a MagicMirror runs on a Pi behind semi-transparent film, so this needs to
   * stay cheap to render and legible at a distance, which means thick strokes
   * and brightness steps rather than colour (mirror film mutes hues badly).
   */
  renderChart (s) {
    const NS = "http://www.w3.org/2000/svg";
    const RADIUS = 40;
    const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
    // A hairline between arcs keeps adjacent brightness steps distinguishable.
    const GAP = 1.5;

    const rows = this.stageRows(s).filter((r) => r.minutes > 0);
    const total = rows.reduce((sum, r) => sum + r.minutes, 0);

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.classList.add("fitbitair-donut");

    const group = document.createElementNS(NS, "g");
    // SVG arcs start at 3 o'clock; rotate so the ring begins at the top.
    group.setAttribute("transform", "rotate(-90 50 50)");
    svg.appendChild(group);

    let offset = 0;
    for (const row of rows) {
      const arc = (row.minutes / total) * CIRCUMFERENCE;
      // Never let the gap consume a sliver-thin arc entirely.
      const drawn = Math.max(arc - GAP, 0.5);

      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("cx", "50");
      circle.setAttribute("cy", "50");
      circle.setAttribute("r", String(RADIUS));
      circle.setAttribute("fill", "none");
      circle.setAttribute("stroke-width", "12");
      circle.setAttribute(
        "stroke-dasharray", `${drawn} ${CIRCUMFERENCE - drawn}`
      );
      circle.setAttribute("stroke-dashoffset", String(-offset));
      circle.classList.add("fitbitair-arc", `fitbitair-arc-${row.key}`);
      group.appendChild(circle);

      offset += arc;
    }

    const centre = document.createElementNS(NS, "text");
    centre.setAttribute("x", "50");
    centre.setAttribute("y", s.efficiency === null ? "54" : "48");
    centre.setAttribute("text-anchor", "middle");
    centre.classList.add("fitbitair-donut-total");
    centre.textContent = this.formatDuration(s.asleepMinutes);
    svg.appendChild(centre);

    if (this.config.showEfficiency && s.efficiency !== null) {
      const sub = document.createElementNS(NS, "text");
      sub.setAttribute("x", "50");
      sub.setAttribute("y", "62");
      sub.setAttribute("text-anchor", "middle");
      sub.classList.add("fitbitair-donut-sub");
      sub.textContent = `${s.efficiency}%`;
      svg.appendChild(sub);
    }

    return svg;
  },

  /**
   * Doubles as the chart's legend when one is drawn: the swatch is what ties
   * each row to its arc, so percentages only earn their place alongside it.
   */
  renderStages (s, isLegend) {
    const table = document.createElement("table");
    table.className = "fitbitair-stages small";

    const rows = this.stageRows(s);
    const total = rows.reduce((sum, r) => sum + r.minutes, 0);

    for (const row of rows) {
      const tr = document.createElement("tr");

      if (isLegend) {
        const swatchCell = document.createElement("td");
        const swatch = document.createElement("span");
        swatch.className = `fitbitair-swatch fitbitair-arc-${row.key}`;
        swatchCell.appendChild(swatch);
        tr.appendChild(swatchCell);
      }

      const name = document.createElement("td");
      name.className = "fitbitair-stage-name dimmed";
      name.textContent = row.label;
      tr.appendChild(name);

      const value = document.createElement("td");
      value.className = "fitbitair-stage-value";
      value.textContent = this.formatDuration(row.minutes);
      tr.appendChild(value);

      if (isLegend) {
        const pct = document.createElement("td");
        pct.className = "fitbitair-stage-pct dimmed";
        pct.textContent =
          total > 0 ? `${Math.round((row.minutes / total) * 100)}%` : "—";
        tr.appendChild(pct);
      }

      table.appendChild(tr);
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
