"""Keep source records intact while checking identity and provenance."""

from copy import deepcopy

REQUIRED = ("record_id", "entity_type", "brand", "market", "source_kind",
            "source_url_or_ref", "evidence_id", "observed_at", "status")
KINDS = {"public_observation", "third_party_estimate", "authorized_first_party", "synthetic_fixture"}


def normalize(batch):
    """Return records, evidence, coverage, errors and quality_flags.

    This deliberately does not infer variants or merge products by fuzzy names.
    """
    records, flags = [], []
    evidence = deepcopy(batch.get("evidence", []))
    evidence_ids = {item.get("evidence_id") for item in evidence}
    seen = set()
    for source in batch.get("records", []):
        record = deepcopy(source)
        missing = [key for key in REQUIRED if not record.get(key)]
        if missing:
            flags.append({"record_id": record.get("record_id"), "code": "missing_required", "fields": missing})
            continue
        if record["source_kind"] not in KINDS:
            flags.append({"record_id": record["record_id"], "code": "unknown_source_kind"})
            continue
        if record["evidence_id"] not in evidence_ids:
            flags.append({"record_id": record["record_id"], "code": "missing_evidence"})
            continue
        key = (record["record_id"], record.get("revision", 1))
        if key in seen:
            flags.append({"record_id": record["record_id"], "code": "duplicate_revision"})
            continue
        seen.add(key)
        records.append(record)
    # A public product identity may not silently merge conflicting source IDs.
    identities = {}
    for record in records:
        if record["entity_type"] == "product" and record.get("product_id"):
            key = (record["brand"], record["market"], record["product_id"])
            identities.setdefault(key, set()).add(record.get("source_product_id"))
    for key, source_ids in identities.items():
        if len(source_ids) > 1:
            flags.append({"product_id": key[2], "code": "identity_conflict", "status": "ambiguous"})
    return {"records": records, "evidence": evidence,
            "coverage": deepcopy(batch.get("coverage", {})),
            "errors": deepcopy(batch.get("errors", [])), "quality_flags": flags}
