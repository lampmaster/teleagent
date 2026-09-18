import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scriptedRunner } from "./fixtures.js";
import { checkSuccess, SCENARIOS, type ScenarioType } from "./scenarios.js";

const TYPES: ScenarioType[] = [
  "simple",
  "multi-tool",
  "large-output",
  "long-history",
  "repeated-data",
];

describe("scenarios", () => {
  it("has 20 scenarios, four of each type, with unique ids", () => {
    assert.equal(SCENARIOS.length, 20);
    assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, 20);

    for (const type of TYPES) {
      assert.equal(
        SCENARIOS.filter((s) => s.type === type).length,
        4,
        `expected four ${type} scenarios`,
      );
    }
  });

  it("gives every scenario at least one checkable expectation", () => {
    for (const scenario of SCENARIOS) {
      assert.ok(scenario.expect.length > 0, `${scenario.id} has no success criteria`);
    }
  });
});

describe("checkSuccess", () => {
  const scenario = SCENARIOS[0]!;

  it("fails a run that did not complete", () => {
    const result = checkSuccess(scenario, "max_iterations", "Sep 17 2026", [
      { name: "exec", arguments: {}, output: "x", isError: false },
    ]);
    assert.equal(result.success, false);
    assert.match(result.detail, /max_iterations/);
  });

  it("fails a plausible answer that used no tool", () => {
    const result = checkSuccess(scenario, "completed", "It is Sep 17 2026.", []);
    assert.equal(result.success, false);
    assert.match(result.detail, /no tool call/);
  });

  it("fails when an expected fact is missing", () => {
    const result = checkSuccess(scenario, "completed", "It is some day in 2026.", [
      { name: "exec", arguments: {}, output: "x", isError: false },
    ]);
    assert.equal(result.success, false);
    assert.match(result.detail, /missing/);
  });

  it("passes when the run completed with a tool call and all facts", () => {
    const result = checkSuccess(scenario, "completed", "Today is Sep 17, 2026.", [
      { name: "exec", arguments: {}, output: "x", isError: false },
    ]);
    assert.equal(result.success, true);
  });
});

describe("scripted exec fixtures", () => {
  it("returns identical output for the same command every time", async () => {
    const run = scriptedRunner();
    const first = await run("cat /var/log/app.log");
    const second = await run("cat /var/log/app.log");
    assert.equal(first.stdout, second.stdout);
    assert.ok(first.stdout.length > 5_000, "the log fixture should be large");
    assert.match(first.stdout, /E7731/);
  });

  it("fails deterministically for unknown commands", async () => {
    const outcome = await scriptedRunner()("definitely-not-a-command --x");
    assert.equal(outcome.exitCode, 127);
    assert.match(outcome.stderr, /not found/);
  });
});

describe("chained commands", () => {
  it("runs each part of a `;` chain and concatenates the output", async () => {
    const outcome = await scriptedRunner()("date; hostname; nproc");

    assert.match(outcome.stdout, /2026/);
    assert.match(outcome.stdout, /benchbox-7/);
    assert.match(outcome.stdout, /\b8\b/);
    assert.equal(outcome.exitCode, 0);
  });

  it("leaves a pipeline to a single fixture, as before", async () => {
    const piped = await scriptedRunner()("ps -axo pid,comm,%mem | sort -k3 -nr | head -n 2");
    assert.match(piped.stdout, /postgres/);
  });

  it("reports a non-zero exit code from any part of a chain", async () => {
    const outcome = await scriptedRunner()("date && not-a-real-command");
    assert.equal(outcome.exitCode, 127);
  });
});
