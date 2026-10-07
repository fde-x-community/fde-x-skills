"""Parse a public Similarweb Vooglam overview into a cautious AcquisitionBatch.

The agent may supply legally viewed page text with --input. In an environment
that permits outbound HTTP, --fetch reads the public page. No login, API key,
browser cookies, or paywall bypass is attempted.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone, date, timedelta
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.request import Request, urlopen


SOURCE_URL = "https://www.similarweb.com/website/vooglam.com/"
PARSER_VERSION = "vooglam-public-similarweb-0.1"


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        if data.strip():
            self.parts.append(data.strip())


def visible_text(content: str) -> str:
    if "<html" not in content.lower() and "<!doctype" not in content.lower():
        return content
    parser = _Text()
    parser.feed(content)
    return "\n".join(parser.parts)


def parse_public_overview(content: str, *, captured_at: str, source_ref: str = SOURCE_URL) -> dict:
    text = visible_text(content)
    evidence = {
        "evidence_id": "similarweb-vooglam-public-" + captured_at[:10],
        "source_url_or_ref": source_ref,
        "source_type": "public_webpage",
        "captured_at": captured_at,
        "data_date": None,
        "scope": "vooglam.com",
        "snapshot_ref": None,
        "access_status": "public",
    }
    records: list[dict] = []
    errors: list[dict] = []
    period = re.search(r"\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2})\b", text)
    period_label = period.group(1) if period else None
    period_start = period_end = None
    if period_label:
        month = datetime.strptime(period_label, '%B %Y').date()
        next_month = date(month.year + (month.month == 12), month.month % 12 + 1, 1)
        period_start, period_end = month.isoformat(), (next_month - timedelta(days=1)).isoformat()
    channel_section = re.search(r"vooglam\.com Top Traffic Sources(.*?)(?:Top Keywords|Referral Web Traffic|$)", text, re.I | re.S)
    section = channel_section.group(1) if channel_section else ""
    direct = re.search(r"Direct traffic,? driving\s+([0-9]+(?:\.[0-9]+)?)%\s+of desktop visits", section, re.I)
    if direct and period_label:
        records.append({
            "entity_type": "channel_observation",
            "site": "vooglam.com",
            "brand": "Vooglam",
            "market": "not_specified",
            "device": "desktop",
            "source_kind": "third_party_estimate",
            "source_channel": "Direct",
            "mapped_channel": "direct",
            "mapping_version": "similarweb-public-2026-09",
            "metric_type": "traffic_share",
            "value": direct.group(1),
            "unit": "percent",
            "period_label": period_label,
            "data_period_start": period_start,
            "data_period_end": period_end,
            "granularity": "month",
            "source_timezone": "not_specified",
            "observed_at": captured_at,
            "source_url_or_ref": source_ref,
            "evidence_id": evidence["evidence_id"],
            "status": "ok",
            "parser_version": PARSER_VERSION,
            "estimation_method": "not_disclosed_on_public_page",
        })
        evidence["data_date"] = period_label
    else:
        errors.append({"source": "similarweb", "stage": "parse", "code": "DIRECT_SHARE_MISSING", "message": "Public desktop Direct share or explicit page month was not found", "retryable": False, "evidence_ref": evidence["evidence_id"]})
    for label, channel, rank in (("Display", "display", 2), ("Paid Search", "paid_search", 3)):
        if period_label and re.search(rf"\b{re.escape(label)}\s+is the\s+{rank}(?:nd|rd|th)\b", section, re.I):
            records.append({
                "entity_type": "channel_observation", "site": "vooglam.com", "brand": "Vooglam",
                "market": "not_specified", "device": "desktop", "source_kind": "third_party_estimate",
                "source_channel": label, "mapped_channel": channel, "mapping_version": "similarweb-public-2026-09",
                "metric_type": "channel_rank", "value": rank, "unit": "rank", "period_label": period_label,
                "data_period_start": period_start, "data_period_end": period_end,
                "granularity": "month", "source_timezone": "not_specified", "observed_at": captured_at,
                "source_url_or_ref": source_ref, "evidence_id": evidence["evidence_id"], "status": "ok",
                "parser_version": PARSER_VERSION,
            })
    status = "partial" if records else "unavailable"
    return {
        "records": records,
        "evidence": [evidence],
        "coverage": {
            "requested_scope": {"site": "vooglam.com", "metric": "inbound_channels"},
            "observed_scope": {"site": "vooglam.com", "device": "desktop", "market": "not_specified", "period_label": period_label},
            "success_count": len(records), "missing_count": 1 if records else 3,
            "completeness": "public_page_top_channels_only" if records else "no_channel_values",
            "status": status,
        },
        "errors": errors,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--input", type=Path, help="Saved legally viewed page HTML or text")
    group.add_argument("--fetch", action="store_true", help="Fetch the public page when network permits")
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--captured-at", help="ISO 8601 UTC time for an agent-supplied snapshot")
    ap.add_argument("--source-ref", default=SOURCE_URL)
    args = ap.parse_args()
    if args.input:
        if not args.captured_at:
            ap.error("--captured-at is required with --input")
        content = args.input.read_text(encoding="utf-8")
        captured_at = args.captured_at
    else:
        request = Request(SOURCE_URL, headers={"User-Agent": "Mozilla/5.0 (compatible; ResearchSkill/0.1)"})
        with urlopen(request, timeout=20) as response:
            content = response.read().decode("utf-8", errors="replace")
        captured_at = datetime.now(timezone.utc).isoformat()
    batch = parse_public_overview(content, captured_at=captured_at, source_ref=args.source_ref)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(batch, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"status={batch['coverage']['status']} records={len(batch['records'])} output={args.output}")


if __name__ == "__main__":
    main()
