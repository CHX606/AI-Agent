import { spawn } from "node:child_process";

export async function runSandboxChild(
  argv: string[], env: NodeJS.ProcessEnv, workspace: string, signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  const executable = argv[0];
  if (!executable) throw new Error("Official sandbox wrapper returned an empty argv");
  const child = spawn(executable, argv.slice(1), {
    cwd: workspace, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  const abort = () => { child.kill(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(signal.aborted ? 130 : code ?? 125));
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
