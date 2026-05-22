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
CSV_PATH = OUTPUT_DIR / "eu_ai_machine_vision_integrators_precision_v4.csv"
RAW_JSON_PATH = OUTPUT_DIR / "eu_ai_machine_vision_integrators_precision_v4.raw.json"
METADATA_PATH = OUTPUT_DIR / "eu_ai_machine_vision_integrators_precision_v4.metadata.json"
SIZE = int(os.getenv("DIFFBOT_SIZE", "50"))
QUERY = """type:Organization
has:homepageUri
or(
  location.country.name:or("Germany","Austria","Switzerland","Netherlands","Belgium","Denmark","Sweden","France","Italy","Spain","Portugal","Poland","Czech Republic"),
  locations.country.name:or("Germany","Austria","Switzerland","Netherlands","Belgium","Denmark","Sweden","France","Italy","Spain","Portugal","Poland","Czech Republic")
)
or(
    description:or("machine vision","computer vision","artificial vision systems","vision systems provider","visual inspection","optical inspection","automated optical inspection","inline inspection","quality inspection","defect detection","metrology","vision-guided robotics","robot guidance","image processing","AOI","2D vision","3D vision","ai consulting","industrial ai consulting","computer vision consulting","machine vision consulting","process automation with ai","ki beratung","ki-beratung","ki consulting","industrie 4.0 consulting","predictive quality","quality ai"),
    allDescriptions:or("machine vision","computer vision","artificial vision systems","vision systems provider","visual inspection","optical inspection","automated optical inspection","inline inspection","quality inspection","defect detection","metrology","vision-guided robotics","robot guidance","image processing","AOI","2D vision","3D vision","Bildverarbeitung","industrielle Bildverarbeitung","optische Inspektion","Qualitaetspruefung","Qualitätsprüfung","Qualitaetskontrolle","Qualitätskontrolle","ai consulting","industrial ai consulting","computer vision consulting","machine vision consulting","process automation with ai","ki beratung","ki-beratung","ki consulting","industrie 4.0 consulting","predictive quality","quality ai","ITSM-Prozessautomatisierung mit KI")
)
or(
    description:or("system integrator","system integration","turnkey","customer-specific","custom solution","engineering services","consulting","implementation","delivery","project delivery","solution delivery","integration services","commissioning","retrofit","inspection system","inspection systems","inspection solutions","vision systems provider","integrator of advanced inspection","design, development and integration","robot integration","quality control","process automation","workflow automation"),
    allDescriptions:or("system integrator","system integration","turnkey","customer-specific","custom solution","engineering services","consulting","implementation","delivery","project delivery","solution delivery","integration services","commissioning","retrofit","inspection system","inspection systems","inspection solutions","vision systems provider","integrator of advanced inspection","design, development and integration","robot integration","quality control","process automation","workflow automation","Systemintegration","kundenspezifisch","Inbetriebnahme","Retrofit","Beratung","Implementierung","Projektumsetzung")
)
or(
    description:or("industrial","manufacturing","factory","production","inspection","quality","operations","automation"),
    allDescriptions:or("industrial","manufacturing","factory","production","inspection","quality","operations","automation","Industrie","Produktion","Qualitätskontrolle","Prozessautomatisierung")
)
not(
  or(
                description:or("supplier of components","machine vision components","industrial cameras","camera housings","frame grabbers","optics","smart cameras","camera manufacturer","sensor manufacturer","barcode readers","laser markers","digital microscopes","measurement systems","photoelectric sensors","fiber optic sensors","direct sales organization","sales engineers","distributor","reseller","wholesale","catalog products","pneumatic","actuator","valve terminal","didactic","technical education","training provider","consumer electronics","job board","staffing","recruiting","video surveillance","security cameras","smart city","traffic enforcement","marketing agency","face tracking","face recognition","biometrics","virtual try-on","emotion estimation","gaze tracking","document capture","document scanners","industrial pc","industrial pcs","metering pumps","pump manufacturer","traffic systems","roadside systems","ultrasound system","display systems"),
                allDescriptions:or("supplier of components","machine vision components","industrial cameras","camera housings","frame grabbers","optics","smart cameras","camera manufacturer","sensor manufacturer","barcode readers","laser markers","digital microscopes","measurement systems","photoelectric sensors","fiber optic sensors","direct sales organization","sales engineers","distributor","reseller","wholesale","catalog products","pneumatic","actuator","valve terminal","didactic","technical education","training provider","consumer electronics","job board","staffing","recruiting","video surveillance","security cameras","smart city","traffic enforcement","marketing agency","face tracking","face recognition","biometrics","virtual try-on","emotion estimation","gaze tracking","document capture","document scanners","industrial pc","industrial pcs","metering pumps","pump manufacturer","traffic systems","roadside systems","ultrasound system","display systems")
  )
)"""


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
        return " | ".join(str(part).strip() for part in raw if str(part).strip())
    return str(raw).strip()



def fetch_account_usage(token: str) -> dict[str, Any]:
    response = requests.get(ACCOUNT_ENDPOINT, params={"token": token}, timeout=60)
    response.raise_for_status()
    payload = response.json()
    today = datetime.now(timezone.utc).date().isoformat()
    today_entry = next((entry for entry in payload.get("apiCalls", []) if entry.get("date") == today), {})
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
        writer = csv.DictWriter(handle, fieldnames=["name", "website", "description"])
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
        "format": "json"
    }

    started_at = time.perf_counter()
    response = requests.get(ENDPOINT, params=params, timeout=180)
    elapsed_seconds = time.perf_counter() - started_at
    response_size_bytes = len(response.content)

    try:
        payload = response.json()
    except json.JSONDecodeError:
        payload = {"rawText": response.text}

    if response.status_code >= 400:
        print(json.dumps({
            "status_code": response.status_code,
            "response_time_seconds": round(elapsed_seconds, 3),
            "response_size_bytes": response_size_bytes,
            "payload": payload
        }, indent=2, ensure_ascii=False))
        return 1

    raw_entities = payload.get("data") or []
    rows = []
    for item in raw_entities[:SIZE]:
        entity = entity_payload(item)
        description = entity_field(entity, "description")
        all_descriptions = entity_field(entity, "allDescriptions")
        rows.append({
            "name": entity_field(entity, "name"),
            "website": entity_field(entity, "homepageUri"),
            "description": " || ".join(part for part in [description, all_descriptions] if part).strip()
        })

    save_csv(rows)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with RAW_JSON_PATH.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)

    after_usage = fetch_account_usage(token)
    metadata = {
        key: value
        for key, value in payload.items()
        if key not in {"data"}
    }
    metadata.update({
        "request": {
            "endpoint": ENDPOINT,
            "type": "query",
            "size": SIZE,
            "from": 0,
            "query": QUERY,
            "requested_fields": "full entity payload"
        },
        "response": {
            "status_code": response.status_code,
            "response_time_seconds": round(elapsed_seconds, 3),
            "response_size_bytes": response_size_bytes,
            "returned_entities": len(rows),
            "csv_path": str(CSV_PATH),
            "raw_json_path": str(RAW_JSON_PATH)
        },
        "account_usage": {
            "before": before_usage,
            "after": after_usage
        }
    })

    with METADATA_PATH.open("w", encoding="utf-8") as handle:
        json.dump(metadata, handle, indent=2, ensure_ascii=False)

    print(json.dumps({
        "csv_path": str(CSV_PATH),
        "raw_json_path": str(RAW_JSON_PATH),
        "metadata_path": str(METADATA_PATH),
        "response_time_seconds": round(elapsed_seconds, 3),
        "response_size_bytes": response_size_bytes,
        "returned_entities": len(rows),
        "hits": payload.get("hits"),
        "account_usage": metadata["account_usage"]
    }, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
