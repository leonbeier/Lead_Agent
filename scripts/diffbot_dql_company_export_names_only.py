import csv
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests


ENDPOINT = "https://kg.diffbot.com/kg/v3/dql"
ACCOUNT_ENDPOINT = "https://api.diffbot.com/v3/account"
OUTPUT_DIR = Path("data/diffbot")
CSV_PATH = OUTPUT_DIR / "eu_ai_machine_vision_integrators_100_names_only_v2.csv"
METADATA_PATH = OUTPUT_DIR / "eu_ai_machine_vision_integrators_100_names_only_v2.metadata.json"
SIZE = 100
QUERY = (
    'type:Organization has:description has:homepageUri '
    'or(location.country.name:or("Germany", "France", "Italy", "Netherlands", "Switzerland", "Sweden", "Austria", "Spain"), '
    'locations.country.name:or("Germany", "France", "Italy", "Netherlands", "Switzerland", "Sweden", "Austria", "Spain")) '
    'description:or("machine vision", "computer vision", "vision systems", "quality inspection", "visual inspection", '
    '"industrial inspection", "robotic vision", "embedded vision", "optical inspection", "image processing", "vision-guided robotics") '
    'description:or("integrator", "system integrator", "engineering services", "integration services", '
    '"industrial automation services", "robotics integrator", "machine vision integrator", "control systems integrator", "engineering consultancy") '
    'not(description:or("camera manufacturer", "camera supplier", "lens manufacturer", "sensor manufacturer", '
    '"software platform", "video surveillance", "security cameras", "consumer electronics", "distributor", '
    '"reseller", "e-commerce", "job board", "staffing"))'
)


def unwrap_value(value: Any) -> Any:
    if isinstance(value, dict):
        if "value" in value:
            return unwrap_value(value["value"])
        if "str" in value and len(value) == 1:
            return value["str"]
    if isinstance(value, list):
        return [unwrap_value(item) for item in value]
    return value


def entity_payload(item: Any) -> dict[str, Any]:
    if isinstance(item, dict) and isinstance(item.get("entity"), dict):
        return item["entity"]
    if isinstance(item, dict):
        return item
    return {}


def entity_field(entity: dict[str, Any], field_name: str) -> str:
    raw = unwrap_value(entity.get(field_name))
    if raw is None:
        return ""
    if isinstance(raw, list):
        flattened = [str(part).strip() for part in raw if str(part).strip()]
        return " | ".join(flattened)
    return str(raw).strip()


def select_usage_headers(headers: requests.structures.CaseInsensitiveDict[str]) -> dict[str, str]:
    interesting = {}
    for key, value in headers.items():
        lowered = key.lower()
        if any(token in lowered for token in ("credit", "usage", "limit", "billing", "token", "cost")):
            interesting[key] = value
    return interesting


def fetch_account_usage(token: str) -> dict[str, Any]:
    response = requests.get(ACCOUNT_ENDPOINT, params={"token": token}, timeout=60)
    response.raise_for_status()
    payload = response.json()
    today = datetime.now(timezone.utc).date().isoformat()
    matching_calls = [entry for entry in payload.get("apiCalls", []) if entry.get("date") == today]
    today_entry = matching_calls[0] if matching_calls else {}
    return {
        "plan": payload.get("plan"),
        "today": today,
        "today_entry": today_entry,
        "searchResults": today_entry.get("searchResults"),
        "calls": today_entry.get("calls")
    }


def save_csv(rows: list[dict[str, str]]) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with CSV_PATH.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["name", "website"])
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    token = os.getenv("DIFFBOT_TOKEN") or os.getenv("DIFFBOT_API_TOKEN")
    if not token:
        print("Missing DIFFBOT_TOKEN or DIFFBOT_API_TOKEN environment variable.", file=sys.stderr)
        return 1

    before_usage = fetch_account_usage(token)

    params = {
        "token": token,
        "type": "query",
        "query": QUERY,
        "size": str(SIZE),
        "from": "0",
        "format": "json",
        "filter": "$.name;$.homepageUri"
    }

    started_at = time.perf_counter()
    response = requests.get(ENDPOINT, params=params, timeout=120)
    elapsed_seconds = time.perf_counter() - started_at
    response_size_bytes = len(response.content)
    usage_headers = select_usage_headers(response.headers)

    try:
        payload = response.json()
    except json.JSONDecodeError:
        payload = {"rawText": response.text}

    if response.status_code >= 400:
        print(json.dumps({
            "status_code": response.status_code,
            "response_time_seconds": round(elapsed_seconds, 3),
            "response_size_bytes": response_size_bytes,
            "usage_headers": usage_headers,
            "payload": payload
        }, indent=2, ensure_ascii=False))
        return 1

    raw_entities = payload.get("data") or []
    rows = []
    for item in raw_entities[:SIZE]:
        entity = entity_payload(item)
        rows.append(
            {
                "name": entity_field(entity, "name"),
                "website": entity_field(entity, "homepageUri")
            }
        )

    save_csv(rows)
    after_usage = fetch_account_usage(token)

    search_results_before = before_usage.get("searchResults")
    search_results_after = after_usage.get("searchResults")
    search_results_delta = None
    if isinstance(search_results_before, int) and isinstance(search_results_after, int):
        search_results_delta = search_results_after - search_results_before

    metadata = {
        key: value
        for key, value in payload.items()
        if key not in {"data"}
    }
    metadata.update(
        {
            "request": {
                "endpoint": ENDPOINT,
                "type": "query",
                "size": SIZE,
                "from": 0,
                "query": QUERY,
                "requested_fields": ["name", "homepageUri"]
            },
            "response": {
                "status_code": response.status_code,
                "response_time_seconds": round(elapsed_seconds, 3),
                "response_size_bytes": response_size_bytes,
                "returned_entities": len(rows),
                "csv_path": str(CSV_PATH),
                "usage_headers": usage_headers
            },
            "account_usage": {
                "before": before_usage,
                "after": after_usage,
                "searchResultsDelta": search_results_delta
            }
        }
    )

    with METADATA_PATH.open("w", encoding="utf-8") as handle:
        json.dump(metadata, handle, indent=2, ensure_ascii=False)

    print(json.dumps({
        "csv_path": str(CSV_PATH),
        "metadata_path": str(METADATA_PATH),
        "response_time_seconds": round(elapsed_seconds, 3),
        "response_size_bytes": response_size_bytes,
        "returned_entities": len(rows),
        "hits": payload.get("hits"),
        "usage_headers": usage_headers,
        "account_usage": metadata["account_usage"],
        "metadata": {key: value for key, value in payload.items() if key != "data"}
    }, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())