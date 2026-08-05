/*
 * Tests for the Health API response parsing. These cover the pure functions
 * only -- no network, no MagicMirror runtime -- so they run with plain
 * `node --test`.
 *
 * The fixtures below are trimmed from a real health.googleapis.com response
 * for a Fitbit Air, so the field shapes here are ground truth rather than
 * guesses: durations arrive as strings, stage timestamps sit directly on each
 * stage (not nested under `interval`), and offsets are Go-style ("-14400s").
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

/*
 * node_helper.js requires MagicMirror runtime modules that don't exist outside
 * a mirror install, so stub them before loading it.
 */
const originalResolve = Module._resolveFilename;
const stubs = {
  node_helper: {
    create: (definition) => definition
  },
  logger: { info () {}, error () {}, warn () {} }
};

Module._resolveFilename = function (request, ...args) {
  if (Object.hasOwn(stubs, request)) {
    return request;
  }
  return originalResolve.call(this, request, ...args);
};

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (Object.hasOwn(stubs, request)) {
    return stubs[request];
  }
  return originalLoad.call(this, request, ...args);
};

const helper = require("../node_helper.js");

Module._load = originalLoad;
Module._resolveFilename = originalResolve;

/** Verbatim shape of a real session, with the stage list trimmed. */
const realSession = {
  name: "users/1234/dataTypes/sleep/dataPoints/5678",
  dataSource: { recordingMethod: "DERIVED", device: {}, platform: "FITBIT" },
  sleep: {
    interval: {
      startTime: "2026-07-25T05:46:00Z",
      startUtcOffset: "-14400s",
      endTime: "2026-07-25T13:06:00Z",
      endUtcOffset: "-14400s"
    },
    type: "STAGES",
    stages: [
      {
        startTime: "2026-07-25T05:46:00Z",
        endTime: "2026-07-25T05:52:30Z",
        type: "AWAKE"
      },
      {
        startTime: "2026-07-25T05:52:30Z",
        endTime: "2026-07-25T06:17:00Z",
        type: "LIGHT"
      }
    ],
    summary: {
      minutesInSleepPeriod: "440",
      minutesAfterWakeUp: "0",
      minutesToFallAsleep: "0",
      minutesAsleep: "433",
      minutesAwake: "7",
      stagesSummary: [
        { type: "AWAKE", minutes: "6", count: "1" },
        { type: "LIGHT", minutes: "220", count: "14" },
        { type: "DEEP", minutes: "106", count: "6" },
        { type: "REM", minutes: "107", count: "8" }
      ]
    }
  }
};

test("summarize uses the API's stagesSummary rather than re-adding intervals", () => {
  const result = helper.summarize(realSession);

  // Comes from stagesSummary, not from the two trimmed stage entries.
  assert.deepStrictEqual(result.stages, {
    awake: 6,
    light: 220,
    deep: 106,
    rem: 107
  });
  assert.strictEqual(result.hasStages, true);
});

test("summarize coerces the API's string durations to numbers", () => {
  const result = helper.summarize(realSession);

  assert.strictEqual(result.asleepMinutes, 433);
  assert.strictEqual(result.inBedMinutes, 440);
  assert.strictEqual(typeof result.asleepMinutes, "number");
  assert.strictEqual(typeof result.inBedMinutes, "number");
  assert.strictEqual(result.efficiency, 98);
});

test("summarize falls back to stage intervals when no summary is present", () => {
  const noSummary = structuredClone(realSession);
  delete noSummary.sleep.summary;

  const result = helper.summarize(noSummary);

  // 6.5 min AWAKE + 24.5 min LIGHT from the flat stage timestamps.
  assert.strictEqual(result.stages.awake, 7);
  assert.strictEqual(result.stages.light, 25);
  assert.strictEqual(result.inBedMinutes, 440);
  // Stage totals minus awake.
  assert.strictEqual(result.asleepMinutes, 25);
});

test("summarize falls back to time in bed when a device reports no stages", () => {
  const bare = {
    sleep: {
      interval: {
        startTime: "2026-08-04T05:00:00Z",
        endTime: "2026-08-04T12:00:00Z",
        endUtcOffset: "-14400s"
      }
    }
  };

  const result = helper.summarize(bare);

  assert.strictEqual(result.asleepMinutes, 420);
  assert.strictEqual(result.efficiency, 100);
  assert.strictEqual(result.hasStages, false);
});

test("summarize still reads stages nested under interval", () => {
  // Defensive: tolerate the nested shape in case the API emits it.
  const nested = {
    sleep: {
      interval: {
        startTime: "2026-08-04T05:00:00Z",
        endTime: "2026-08-04T06:00:00Z",
        endUtcOffset: "-14400s"
      },
      stages: [
        {
          type: "DEEP",
          interval: {
            startTime: "2026-08-04T05:00:00Z",
            endTime: "2026-08-04T06:00:00Z"
          }
        }
      ]
    }
  };

  assert.strictEqual(helper.summarize(nested).stages.deep, 60);
});

test("pickMainSession returns the most recently ended session", () => {
  const older = structuredClone(realSession);
  older.sleep.interval.endTime = "2026-07-20T14:28:00Z";

  // Newest is not first, so ordering must not be assumed.
  assert.strictEqual(helper.pickMainSession([older, realSession]), realSession);
});

test("pickMainSession ignores malformed points and empty responses", () => {
  assert.strictEqual(helper.pickMainSession([]), null);
  assert.strictEqual(helper.pickMainSession([{ sleep: {} }, {}]), null);
});

test("offsetMs parses Go-style duration strings", () => {
  assert.strictEqual(helper.offsetMs("-14400s"), -14400000);
  assert.strictEqual(helper.offsetMs("0s"), 0);
  assert.strictEqual(helper.offsetMs(undefined), 0);
});

test("nightsAgo counts whole local days, not 24-hour blocks", () => {
  const now = Date.now();
  const offset = "-14400s";
  const lastNight = new Date(now - 20 * 3600 * 1000).toISOString();

  const nights = helper.nightsAgo(lastNight, offset);
  assert.ok(nights >= 0 && nights <= 2, `unexpected nightsAgo: ${nights}`);

  const old = new Date(now - 11 * 86400000).toISOString();
  assert.ok(helper.nightsAgo(old, offset) >= 10);
});
