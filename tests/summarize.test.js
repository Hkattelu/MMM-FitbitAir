/*
 * Tests for the Health API response parsing. These cover the pure functions
 * only -- no network, no MagicMirror runtime -- so they run with plain
 * `node --test`.
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

const stagedSession = {
  sleep: {
    interval: {
      startTime: "2026-08-04T05:00:00Z",
      endTime: "2026-08-04T13:00:00Z"
    },
    stages: [
      {
        type: "LIGHT",
        interval: {
          startTime: "2026-08-04T05:00:00Z",
          endTime: "2026-08-04T09:00:00Z"
        }
      },
      {
        type: "DEEP",
        interval: {
          startTime: "2026-08-04T09:00:00Z",
          endTime: "2026-08-04T11:00:00Z"
        }
      },
      {
        type: "REM",
        interval: {
          startTime: "2026-08-04T11:00:00Z",
          endTime: "2026-08-04T12:30:00Z"
        }
      },
      {
        type: "AWAKE",
        interval: {
          startTime: "2026-08-04T12:30:00Z",
          endTime: "2026-08-04T13:00:00Z"
        }
      }
    ]
  }
};

test("summarize totals each stage and derives time asleep", () => {
  const result = helper.summarize(stagedSession);

  assert.strictEqual(result.inBedMinutes, 480);
  assert.deepStrictEqual(result.stages, {
    light: 240,
    deep: 120,
    rem: 90,
    awake: 30
  });
  // Everything except the awake stretch counts as asleep.
  assert.strictEqual(result.asleepMinutes, 450);
  assert.strictEqual(result.efficiency, 94);
  assert.strictEqual(result.hasStages, true);
});

test("summarize prefers the API's own minutesAsleep when present", () => {
  const withSummary = structuredClone(stagedSession);
  withSummary.sleep.summary = { minutesAsleep: 400 };

  const result = helper.summarize(withSummary);

  assert.strictEqual(result.asleepMinutes, 400);
  assert.strictEqual(result.efficiency, 83);
});

test("summarize falls back to time in bed when a device reports no stages", () => {
  const noStages = {
    sleep: {
      interval: {
        startTime: "2026-08-04T05:00:00Z",
        endTime: "2026-08-04T12:00:00Z"
      }
    }
  };

  const result = helper.summarize(noStages);

  assert.strictEqual(result.asleepMinutes, 420);
  assert.strictEqual(result.efficiency, 100);
  assert.strictEqual(result.hasStages, false);
});

test("summarize accepts flattened stage timestamps", () => {
  // Defensive: tolerate stages that carry start/end directly rather than
  // nested under `interval`.
  const flattened = {
    sleep: {
      interval: {
        startTime: "2026-08-04T05:00:00Z",
        endTime: "2026-08-04T06:00:00Z"
      },
      stages: [
        {
          stage: "deep",
          startTime: "2026-08-04T05:00:00Z",
          endTime: "2026-08-04T06:00:00Z"
        }
      ]
    }
  };

  const result = helper.summarize(flattened);

  assert.strictEqual(result.stages.deep, 60);
  assert.strictEqual(result.hasStages, true);
});

test("pickMainSession returns the longest session, ignoring naps", () => {
  const nap = {
    sleep: {
      interval: {
        startTime: "2026-08-04T18:00:00Z",
        endTime: "2026-08-04T18:45:00Z"
      }
    }
  };

  const picked = helper.pickMainSession([nap, stagedSession]);

  assert.strictEqual(picked, stagedSession);
});

test("pickMainSession ignores malformed points and empty responses", () => {
  assert.strictEqual(helper.pickMainSession([]), null);
  assert.strictEqual(helper.pickMainSession([{ sleep: {} }, {}]), null);
});
