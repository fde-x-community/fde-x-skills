"""Package the complete maintained Skill directory for a clean installation."""

import argparse
from pathlib import Path
import zipfile


EXCLUDED_DIRECTORIES = {".git", ".pytest_cache", "__pycache__"}


def package_files(root: Path, output: Path):
    files = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if any(part in EXCLUDED_DIRECTORIES or part.startswith(".run-list-")
               for part in relative.parts):
            continue
        if relative.parts[:2] == ("assets", "delivery"):
            continue
        if path.resolve() == output.resolve() or path.suffix == ".pyc":
            continue
        files.append(path)
    return sorted(files, key=lambda path: path.relative_to(root).as_posix())


def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path,
                        default=root.parent / "configurable-product-tracker-full.zip")
    args = parser.parse_args()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    paths = package_files(root, output)
    if not paths or root / "SKILL.md" not in paths:
        raise FileNotFoundError("Skill sources are missing")
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for path in paths:
            bundle.write(path, path.relative_to(root).as_posix())
    print(f"{output} ({len(paths)} files)")


if __name__ == "__main__":
    main()
