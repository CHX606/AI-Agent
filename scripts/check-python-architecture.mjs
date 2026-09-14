// Use the project's interpreter; import-linter owns graph analysis and validation.
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const bundled = join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const python = process.env.BIT_AGENT_PYTHON ?? (existsSync(bundled) ? bundled : "python");
const result = spawnSync(python, ["-c", "from importlinter.cli import lint_imports_command; lint_imports_command()",
  "--config", "pyproject.toml"], {
  cwd: root, stdio: "inherit",
  env: { ...process.env, PYTHONPATH: [join(root, "services/agent/src"), process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
