import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  allFlagsOff,
  allFlagsOn,
  enabledFlagNames,
  FLAG_DESCRIPTIONS,
  FLAG_NAMES,
  FlagStore,
  onlyFlag,
} from "./flags.js";

const directory = mkdtempSync(join(tmpdir(), "teleagent-flags-"));

after(() => rmSync(directory, { recursive: true, force: true }));

describe("feature flags", () => {
  it("describes every flag it exposes", () => {
    for (const name of FLAG_NAMES) {
      assert.ok(FLAG_DESCRIPTIONS[name], `${name} has no description`);
    }
  });

  it("builds baseline, single-flag and all-on configurations", () => {
    assert.deepEqual(enabledFlagNames(allFlagsOff()), []);
    assert.deepEqual(enabledFlagNames(allFlagsOn()), FLAG_NAMES);
    assert.deepEqual(enabledFlagNames(onlyFlag("toolOutputLimiting")), ["toolOutputLimiting"]);
  });

  it("defaults to all off when the file is missing", () => {
    const store = new FlagStore(join(directory, "missing.json"));
    assert.deepEqual(store.read(), allFlagsOff());
  });

  it("round-trips through the file and ignores unknown or malformed keys", () => {
    const path = join(directory, "flags.json");
    const store = new FlagStore(path);
    store.write({ ...allFlagsOff(), contextCompaction: true });
    assert.deepEqual(enabledFlagNames(store.read()), ["contextCompaction"]);

    writeFileSync(path, '{"contextCompaction":true,"bogus":true,"earlyStop":"yes"}');
    const read = store.read();
    assert.equal(read.contextCompaction, true);
    assert.equal(read.earlyStop, false);
    assert.equal("bogus" in read, false);
  });
});
