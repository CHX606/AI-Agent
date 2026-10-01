"""把只读工作区中的项目复制到临时目录后执行 Python package build。"""

import shutil
import subprocess
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print("build runner requires exactly one project path", file=sys.stderr)
        return 2

    workspace = Path("/workspace").resolve()
    source = (workspace / sys.argv[1]).resolve()
    if not source.is_relative_to(workspace) or not source.is_dir():
        print("build path must be a directory inside /workspace", file=sys.stderr)
        return 2

    build_root = Path("/tmp/bit-agent-build")
    copied_source = build_root / "source"
    output_directory = build_root / "dist"
    shutil.rmtree(build_root, ignore_errors=True)
    shutil.copytree(source, copied_source)
    output_directory.mkdir(parents=True)

    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "build",
            "--no-isolation",
            "--outdir",
            str(output_directory),
            str(copied_source),
        ],
        check=False,
    )
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
