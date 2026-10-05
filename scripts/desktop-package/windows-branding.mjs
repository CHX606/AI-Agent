/** Use the same resedit APIs as Electron Packager to brand the Windows executable. */
import { cpSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";

function replaceIcon(resources, icon) {
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  if (groups.length !== 1) throw new Error("Windows executable must contain exactly one application icon group");
  Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries, groups[0].id, groups[0].lang, icon.icons.map((item) => item.data),
  );
}

function replaceVersion(resources, version) {
  const versions = Resource.VersionInfo.fromEntries(resources.entries);
  if (versions.length !== 1) throw new Error("Windows executable must contain exactly one version resource");
  const info = versions[0];
  info.setFileVersion(version);
  info.setProductVersion(version);
  for (const language of info.getAllLanguagesForStringValues()) {
    info.setStringValues(language, {
      FileDescription: "Bit Agent", ProductName: "Bit Agent", InternalName: "Bit Agent",
      OriginalFilename: "Bit Agent.exe", FileVersion: version, ProductVersion: version,
    });
  }
  info.outputToResourceEntries(resources.entries);
}

export function brandExecutable(executableData, iconData, version) {
  const executable = NtExecutable.from(executableData);
  const resources = NtExecutableResource.from(executable);
  replaceIcon(resources, Data.IconFile.from(iconData));
  replaceVersion(resources, version);
  resources.outputResource(executable);
  return Buffer.from(executable.generate());
}

export function applyWindowsBranding(output, { version }) {
  const assets = resolve(import.meta.dirname, "../../apps/desktop/assets");
  const executable = join(output, "Bit Agent.exe");
  renameSync(join(output, "electron.exe"), executable);
  const icon = join(assets, "icon.ico");
  writeFileSync(executable, brandExecutable(readFileSync(executable), readFileSync(icon), version));
  const packagedAssets = join(output, "resources/app/assets");
  cpSync(assets, packagedAssets, { recursive: true });
  return { executable, icon: join(packagedAssets, "icon.ico"), png: join(packagedAssets, "icon.png") };
}
