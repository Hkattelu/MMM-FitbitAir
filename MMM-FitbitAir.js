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
    // Colour the donut by stage. Set false for a monochrome ring that uses
    // brightness steps instead -- useful behind heavily tinted mirror glass,
    // which mutes hues.
    useColor: true,
    // Flag stages that fall outside typical adult ranges, and add a one-line
    // read on the night.
    showGuidance: true,
    /*
     * Percentage-of-sleep reference ranges for healthy adults (N3 13-23%,
     * REM 20-25%, N1+N2 45-55%, awake under 5%). These shift with age --
     * deep sleep in particular declines steadily -- so they are configurable
     * rather than baked in. General reference only, not medical advice.
     */
    stageRanges: {
      deep: [13, 23],
      rem: [20, 25],
      light: [45, 55],
      awake: [0, 5]
    },
    // Recommended nightly sleep for adults 18-64.
    idealSleepHours: [7, 9],
    // Clinical threshold for normal sleep efficiency.
    minEfficiency: 85,
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
    if (this.config.useColor) {
      wrapper.classList.add("fitbitair-color");
    }

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

    if (this.config.showGuidance) {
      const v = this.verdict(s);
      if (v) {
        const verdict = document.createElement("div");
        verdict.className = `fitbitair-verdict small fitbitair-tone-${v.tone}`;
        verdict.textContent = v.text;
        wrapper.appendChild(verdict);
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

  /**
   * Each stage as a share of the whole period, awake included. This is what
   * the ring and its legend show, so the numbers match the arcs.
   */
  stagePercents (s) {
    const total =
      s.stages.deep + s.stages.rem + s.stages.light + s.stages.awake;
    if (total <= 0) {
      return null;
    }
    return {
      deep: (s.stages.deep / total) * 100,
      rem: (s.stages.rem / total) * 100,
      light: (s.stages.light / total) * 100,
      awake: (s.stages.awake / total) * 100
    };
  },

  /**
   * The same stages on the basis the published ranges actually use: sleep
   * stage percentages are of total *sleep* time, not time in bed. Dividing
   * by the whole period instead would understate every stage in proportion
   * to how restless the night was, and flag a broken-up night as short on
   * all three stages at once when the split was really fine.
   *
   * Time awake is the exception -- it only means anything against the whole
   * period, which is also what sleep efficiency measures.
   */
  guidancePercents (s) {
    const asleep = s.stages.deep + s.stages.rem + s.stages.light;
    const period = asleep + s.stages.awake;
    if (asleep <= 0) {
      return null;
    }
    return {
      deep: (s.stages.deep / asleep) * 100,
      rem: (s.stages.rem / asleep) * 100,
      light: (s.stages.light / asleep) * 100,
      awake: period > 0 ? (s.stages.awake / period) * 100 : 0
    };
  },

  /**
   * Where a stage sits against its reference range, expressed as whether it
   * is worth flagging rather than as a raw high/low. More deep sleep or REM
   * is a good thing; more time awake is not; light sleep is just whatever
   * remains, so it is never flagged.
   */
  stageFlag (key, pct) {
    const range = this.config.stageRanges[key];
    if (!range || pct === undefined) {
      return null;
    }
    const [min, max] = range;

    if (key === "deep" || key === "rem") {
      if (pct < min) return { arrow: "▼", tone: "warn" };
      if (pct > max) return { arrow: "▲", tone: "good" };
      return null;
    }
    if (key === "awake") {
      return pct > max ? { arrow: "▲", tone: "warn" } : null;
    }
    return null;
  },

  /**
   * One line on the night as a whole. Reports the single most useful thing
   * rather than a list, and stays descriptive -- this is a bathroom mirror,
   * not a diagnosis.
   */
  verdict (s) {
    const pct = this.guidancePercents(s);
    if (!pct) {
      return null;
    }
    const [minHours] = this.config.idealSleepHours;
    const hours = s.asleepMinutes / 60;
    const R = this.config.stageRanges;

    if (hours < minHours) {
      return {
        text: `Short night — under ${minHours}h asleep`,
        tone: "warn"
      };
    }
    if (pct.deep < R.deep[0]) {
      return { text: "Light on deep sleep", tone: "warn" };
    }
    if (pct.rem < R.rem[0]) {
      return { text: "Light on REM", tone: "warn" };
    }
    if (s.efficiency !== null && s.efficiency < this.config.minEfficiency) {
      return { text: "Restless — broken up by waking", tone: "warn" };
    }
    if (pct.deep > R.deep[1] && pct.rem > R.rem[1]) {
      return { text: "Great night — deep and REM both high", tone: "good" };
    }
    if (pct.deep > R.deep[1] || pct.rem > R.rem[1]) {
      return { text: "Strong night — all stages healthy", tone: "good" };
    }
    return { text: "Solid night — everything in range", tone: "good" };
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
    // Displayed percentages match the ring; flags use the clinical basis.
    const guide = this.config.showGuidance ? this.guidancePercents(s) : null;

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
        const share = total > 0 ? (row.minutes / total) * 100 : undefined;

        const pct = document.createElement("td");
        pct.className = "fitbitair-stage-pct dimmed";
        pct.textContent = share === undefined ? "—" : `${Math.round(share)}%`;
        tr.appendChild(pct);

        const flagCell = document.createElement("td");
        flagCell.className = "fitbitair-stage-flag";
        const flag = guide ? this.stageFlag(row.key, guide[row.key]) : null;
        if (flag) {
          // Arrow plus range text, never colour alone -- the tone is a
          // reinforcement, not the message.
          const [min, max] = this.config.stageRanges[row.key];
          flagCell.classList.add(`fitbitair-tone-${flag.tone}`);
          flagCell.textContent = flag.arrow;
          flagCell.title = `Typical ${min}–${max}%`;
        }
        tr.appendChild(flagCell);
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
