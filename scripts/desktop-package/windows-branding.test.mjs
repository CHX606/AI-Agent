import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";
import { brandExecutable } from "./windows-branding.mjs";

const iconData = readFileSync(new URL("../../apps/desktop/assets/icon.ico", import.meta.url));

test("ICO provides all Windows taskbar and Explorer sizes", () => {
  const icons = Data.IconFile.from(iconData);
  assert.deepEqual(icons.icons.map((item) => item.width), [16, 20, 24, 32, 40, 48, 64, 96, 128, 0]);
});

test("brand real Electron resources without changing the installed original", { skip: process.platform !== "win32" }, () => {
  const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
  const original = readFileSync(require("electron"));
  const originalHash = createHash("sha256").update(original).digest("hex");
  const output = brandExecutable(original, iconData, "1.0.0");
  const resources = NtExecutableResource.from(NtExecutable.from(output));
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  assert.equal(groups.length, 1);
  const extracted = groups[0].getIconItemsFromEntries(resources.entries);
  const expected = Data.IconFile.from(iconData).icons;
  assert.equal(extracted.length, 10);
  for (const [index, icon] of extracted.entries()) {
    assert.deepEqual(Buffer.from(icon.bin), Buffer.from(expected[index].data.bin));
  }
  const [version] = Resource.VersionInfo.fromEntries(resources.entries);
  const values = version.getStringValues(version.getAllLanguagesForStringValues()[0]);
  assert.equal(values.ProductName, "Bit Agent");
  assert.equal(values.FileDescription, "Bit Agent");
  assert.equal(values.OriginalFilename, "Bit Agent.exe");
  assert.equal(values.FileVersion, "1.0.0");
  assert.equal(createHash("sha256").update(original).digest("hex"), originalHash);
});

test("reject malformed executable data", () => {
  assert.throws(() => brandExecutable(Buffer.from("invalid executable"), iconData, "1.0.0"));
});
