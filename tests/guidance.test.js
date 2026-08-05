/*
 * Tests for the range-comparison logic that decides whether a night reads as
 * good or worth noticing. Runs the real methods off MMM-FitbitAir.js with a
 * minimal stand-in for MagicMirror's Module.register, so the thresholds under
 * test are the shipped ones rather than copies.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/** Load the frontend module definition without a browser or MagicMirror. */
function loadModule () {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "MMM-FitbitAir.js"),
    "utf8"
  );
  let captured = null;
  const sandbox = {
    Module: { register: (_name, definition) => { captured = definition; } },
    document: undefined,
    config: { language: "en-US" }
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  // Mirror how MagicMirror merges user config over defaults.
  captured.config = structuredClone(captured.defaults);
  return captured;
}

const mod = loadModule();

/** Build a session with the given stage minutes. */
function session (stages, overrides = {}) {
  const asleep =
    stages.deep + stages.rem + stages.light;
  return {
    asleepMinutes: asleep,
    inBedMinutes: asleep + stages.awake,
    efficiency: Math.round((asleep / (asleep + stages.awake)) * 100),
    stages,
    hasStages: true,
    nightsAgo: 0,
    ...overrides
  };
}

// Roughly the user's real night: 7h13m, deep and REM both a touch high.
const goodNight = session({ deep: 106, rem: 107, light: 220, awake: 6 });

test("stagePercents normalises against total staged time", () => {
  const pct = mod.stagePercents(goodNight);

  assert.strictEqual(Math.round(pct.deep), 24);
  assert.strictEqual(Math.round(pct.rem), 24);
  assert.strictEqual(Math.round(pct.light), 50);
  assert.strictEqual(Math.round(pct.awake), 1);

  const sum = pct.deep + pct.rem + pct.light + pct.awake;
  assert.ok(Math.abs(sum - 100) < 0.001, `percentages sum to ${sum}`);
});

test("stagePercents returns null when a device reports no stages", () => {
  const bare = session({ deep: 0, rem: 0, light: 0, awake: 0 });
  assert.strictEqual(mod.stagePercents(bare), null);
});

test("guidance measures stages against sleep time, not time in bed", () => {
  // 90 minutes awake: dividing by the whole period would drag every stage
  // down and make an otherwise ordinary split look deficient.
  const restless = session({ deep: 80, rem: 100, light: 260, awake: 90 });

  const chart = mod.stagePercents(restless);
  const guide = mod.guidancePercents(restless);

  // Same night, two bases -- the clinical one is what the ranges expect.
  assert.strictEqual(Math.round(chart.deep), 15);
  assert.strictEqual(Math.round(guide.deep), 18);

  // On the chart basis this night would read as REM-deficient. It is not.
  assert.ok(chart.rem < mod.config.stageRanges.rem[0]);
  assert.ok(guide.rem >= mod.config.stageRanges.rem[0]);
  assert.strictEqual(mod.stageFlag("rem", guide.rem), null);

  // Time awake stays measured against the whole period, like efficiency.
  assert.strictEqual(Math.round(guide.awake), 17);
});

/*
 * Flags are built inside the vm context, so their prototype belongs to that
 * realm and deepStrictEqual would reject them on identity alone. Compare the
 * fields that carry meaning instead.
 */
function assertFlag (flag, arrow, tone) {
  assert.ok(flag, "expected a flag");
  assert.strictEqual(flag.arrow, arrow);
  assert.strictEqual(flag.tone, tone);
}

test("above-range deep and REM read as good, not as a problem", () => {
  // 24% deep is over the 13-23 band, but more deep sleep is not a warning.
  assertFlag(mod.stageFlag("deep", 24), "▲", "good");
  assertFlag(mod.stageFlag("rem", 26), "▲", "good");
});

test("below-range deep and REM are flagged as worth noticing", () => {
  assertFlag(mod.stageFlag("deep", 8), "▼", "warn");
  assertFlag(mod.stageFlag("rem", 12), "▼", "warn");
});

test("excess time awake is flagged, but a quiet night is not", () => {
  assertFlag(mod.stageFlag("awake", 14), "▲", "warn");
  assert.strictEqual(mod.stageFlag("awake", 1), null);
});

test("light sleep is never flagged -- it is the remainder", () => {
  assert.strictEqual(mod.stageFlag("light", 70), null);
  assert.strictEqual(mod.stageFlag("light", 20), null);
});

test("in-range stages produce no flag at all", () => {
  assert.strictEqual(mod.stageFlag("deep", 18), null);
  assert.strictEqual(mod.stageFlag("rem", 22), null);
});

test("a healthy night reads positively", () => {
  const v = mod.verdict(goodNight);
  assert.strictEqual(v.tone, "good");
  assert.match(v.text, /night/i);
});

test("short sleep outranks stage quality in the verdict", () => {
  // Only 4h, but the stage split itself is fine -- duration should win,
  // since it is the more consequential fact about the night.
  const short = session({ deep: 53, rem: 53, light: 110, awake: 3 });
  const v = mod.verdict(short);

  assert.strictEqual(v.tone, "warn");
  assert.match(v.text, /short night/i);
});

test("low deep sleep is surfaced over a passing efficiency", () => {
  const shallow = session({ deep: 15, rem: 110, light: 320, awake: 5 });
  const v = mod.verdict(shallow);

  assert.strictEqual(v.tone, "warn");
  assert.match(v.text, /deep/i);
});

test("a fragmented night is called out even with good stage ratios", () => {
  // Stage split is in range and duration is fine, but an hour and a half
  // awake drags efficiency under the 85% threshold.
  const restless = session({ deep: 80, rem: 100, light: 260, awake: 95 });
  const v = mod.verdict(restless);

  assert.ok(restless.efficiency < 85, "fixture should be under threshold");
  assert.strictEqual(v.tone, "warn");
  assert.match(v.text, /restless/i);
});

test("verdict is skipped rather than guessed when stages are missing", () => {
  const bare = session({ deep: 0, rem: 0, light: 0, awake: 0 });
  assert.strictEqual(mod.verdict(bare), null);
});

test("ranges come from config, so they can be retuned for age", () => {
  const strict = loadModule();
  strict.config.stageRanges.deep = [25, 40];

  // 24% is fine by default but low against the stricter band.
  assert.strictEqual(mod.stageFlag("deep", 24).tone, "good");
  assert.strictEqual(strict.stageFlag("deep", 24).tone, "warn");
});
