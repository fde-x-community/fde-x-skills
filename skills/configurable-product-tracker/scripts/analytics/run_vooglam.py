"""Offline Session 1 JSON -> Session 3 dataset and bundle."""

import argparse
import json
from pathlib import Path

from analytics import analyze
from normalization import import_five_product_prices


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    dataset = import_five_product_prices(args.source)
    analysis = analyze(dataset)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, content in (("normalized_dataset.json", dataset), ("analysis_bundle.json", analysis)):
        (args.output_dir / name).write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output_dir": str(args.output_dir), "records": len(dataset["records"]),
                      "evidence": len(dataset["evidence"]), "metrics": len(analysis["metrics"]),
                      "quality_flags": len(analysis["quality_flags"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
