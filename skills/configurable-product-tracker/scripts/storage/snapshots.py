"""JSONL snapshot store. Corrections append revisions instead of overwriting."""

import json
from pathlib import Path


class SnapshotStore:
    def __init__(self, root):
        self.root = Path(root)

    def append(self, record):
        kind = record.get("source_kind")
        if kind not in {"synthetic_fixture", "public_observation", "third_party_estimate", "authorized_first_party"}:
            raise ValueError("source_kind required")
        if not record.get("record_id") or not record.get("observed_at"):
            raise ValueError("record_id and observed_at required")
        folder = self.root / ("synthetic" if kind == "synthetic_fixture" else "real")
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / "snapshots.jsonl"
        previous = [item for item in self.query(kind=kind) if item["record_id"] == record["record_id"]]
        saved = dict(record)
        saved["revision"] = max((item["revision"] for item in previous), default=0) + 1
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(saved, ensure_ascii=False, sort_keys=True) + "\n")
        return saved

    def query(self, *, kind=None, product_id=None, source_url_or_ref=None, data_period_start=None):
        folders = ["synthetic"] if kind == "synthetic_fixture" else ["real"] if kind else ["real", "synthetic"]
        result = []
        for folder in folders:
            path = self.root / folder / "snapshots.jsonl"
            if not path.exists():
                continue
            with path.open(encoding="utf-8") as stream:
                for line in stream:
                    item = json.loads(line)
                    if kind and item.get("source_kind") != kind:
                        continue
                    if product_id and item.get("product_id") != product_id:
                        continue
                    if source_url_or_ref and item.get("source_url_or_ref") != source_url_or_ref:
                        continue
                    if data_period_start and item.get("data_period_start") != data_period_start:
                        continue
                    result.append(item)
        return result
