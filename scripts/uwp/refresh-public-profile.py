"""Generate the public, evidence-only UWP snapshot from approved sources."""

import argparse
from datetime import date, datetime, timezone
from html import unescape
import json
import math
from pathlib import Path
import re
import sys
import time
from http.client import IncompleteRead
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from prtr_provider import SOURCE as PRTR_SOURCE, import_prtr

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data/uwp"
UNIVERSE = DATA / "company-universe.uwp100.json"
SNAPSHOT = DATA / "snapshots/uwp-100.public.latest.json"
LEGACY = DATA / "snapshots/uwp-100.impact-data.latest.json"
INPUTS = DATA / "public-sources.json"
LOBBY_HELP = "https://www.lobbyregister.bundestag.de/informationen-und-hilfe/open-data-1049716"
LOBBY_API = "https://api.lobbyregister.bundestag.de/rest/v2/registerentries"
SOURCES = {
    "prtr": PRTR_SOURCE,
    "report": {"label": "Unternehmensbericht", "role": "Unternehmensangabe"},
    "lobby": {"label": "Lobbyregister des Deutschen Bundestages", "role": "Registerangabe", "url": LOBBY_HELP},
    "wikirate": {
        "label": "Wikirate · CC BY 4.0", "role": "Sekundärquelle", "url": "https://wikirate.org/Data",
        "license": "https://creativecommons.org/licenses/by/4.0/",
    },
}
METRICS = {
    "scope1": ("Scope 1: Direkte Treibhausgasemissionen", "t CO₂e", "Planet"),
    "scope2_location": ("Scope 2: Indirekte Emissionen, standortbasiert", "t CO₂e", "Planet"),
    "scope2_market": ("Scope 2: Indirekte Emissionen, marktbasiert", "t CO₂e", "Planet"),
    "scope3": ("Scope 3: Emissionen in der Wertschöpfungskette", "t CO₂e", "Planet"),
    "work_accidents": ("Gemeldete Arbeitsunfälle", "Unfälle", "Mensch"),
}


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def get(url, headers=None):
    request = Request(url, headers={"User-Agent": "Wirkungsoekonomie-UWP/1.0", **(headers or {})})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=18) as response:
                data = response.read(12_000_001)
                if len(data) > 12_000_000:
                    raise ValueError("Provider response exceeds the expected size")
                return data
        except HTTPError as error:
            if attempt == 2 or error.code not in {429, 500, 502, 503, 504}:
                raise
        except (OSError, IncompleteRead):
            if attempt == 2:
                raise
        time.sleep(2 ** attempt)


def lobby_observations(mapping, today):
    html = get(LOBBY_HELP).decode()
    plain = unescape(re.sub(r"<[^>]*>", " ", html))
    key = re.search(r"aktuell gültige\s+API-Key\s+lautet:\s+([A-Za-z0-9]{30,40})", plain)
    if not key:
        raise ValueError("Public Lobbyregister API key could not be found.")
    headers = {"Authorization": f"ApiKey {key[1]}", "Accept": "application/json"}
    observations = []
    for company_id, entry in mapping.items():
        number, name = entry
        if not re.fullmatch(r"R\d{6}", number):
            raise ValueError(f"Invalid Lobbyregister identifier for {company_id}")
        record = json.loads(get(f"{LOBBY_API}/{number}", headers))
        if record["registerNumber"] != number or record["lobbyistIdentity"]["name"] != name:
            raise ValueError(f"Lobbyregister entity changed for {company_id} ({number})")
        if not record["accountDetails"]["activeLobbyist"]:
            continue
        details = record["registerEntryDetails"]
        expenses = record["financialExpenses"]
        band = expenses.get("financialExpensesEuro")
        if not band or not expenses.get("relatedFiscalYearFinished"):
            continue
        start = date.fromisoformat(expenses["relatedFiscalYearStart"])
        end = date.fromisoformat(expenses["relatedFiscalYearEnd"])
        low, high = band.get("from"), band.get("to")
        if type(low) is not int or type(high) is not int or not 0 <= low <= high or start > end:
            raise ValueError(f"Invalid Lobbyregister financial disclosure for {number}")
        observations.append({
            "company_id": company_id, "indicator_id": "federal_lobbying_expenses",
            "label": "Gemeldete Ausgaben für Interessenvertretung beim Bund",
            "dimension": "Demokratie", "kind": "disclosure", "year": end.year,
            "period": [start.isoformat(), end.isoformat()], "value": [low, high], "unit": "€",
            "quality": "B", "source": "lobby", "url": details["detailsPageUrl"],
            "locator": f"{name} · {number}, Version {details['version']}",
            "retrieved_at": today,
            "note": "Selbstauskunft der eingetragenen Gesellschaft. Die Spanne beschreibt den gemeldeten Aufwand im Geltungsbereich des Bundesregisters. Politischer Einfluss und Folgen bleiben offen.",
        })
    if not observations:
        raise ValueError("Lobbyregister returned no active company disclosures.")
    return observations


def report_observations(reports):
    for report in reports:
        comparable = set(report.get("comparable_metrics", []))
        for metric in comparable:
            years = sorted(row[1] for row in report["values"] if row[0] == metric)
            if len(years) != 2 or years[1] != years[0] + 1:
                raise ValueError(f"Expected two consecutive years for {report['company_id']}: {metric}")
        for row in report["values"]:
            metric, year, value = row[:3]
            label, unit, dimension = METRICS[metric]
            observation = {
                "company_id": report["company_id"], "indicator_id": metric,
                "label": label, "dimension": dimension, "kind": "metric", "year": year,
                "value": value, "unit": unit, "quality": "B", "source": "report",
                "url": report["url"], "locator": report["locator"],
                "retrieved_at": report["retrieved_at"], "note": row[3] if len(row) > 3 else report["note"],
            }
            if metric in comparable:
                observation["comparable"] = True
            yield observation


def historic_wikirate():
    snapshot = load(LEGACY)
    checked = snapshot["generated_at"][:10]
    for obs in snapshot["observations"]:
        if obs["source_id"] != "wikirate-open-esg" or type(obs["raw_value"]) not in (int, float):
            continue
        # Keep the exact historical answer IDs on Wikirate's supported legacy host.
        answer = urlsplit(obs["source_url"]).path
        anchor = urlsplit(obs["source_anchor"] or "").path
        if not re.fullmatch(r"/~\d+", answer) or not re.fullmatch(r"/~\d+", anchor):
            continue
        yield {
            "company_id": obs["company_id"], "indicator_id": obs["indicator_id"],
            "label": obs["indicator"], "dimension": obs["dimension"], "kind": "metric",
            "year": obs["year"], "value": obs["raw_value"], "unit": obs["unit"],
            "quality": "C", "source": "wikirate", "url": f"https://legacy.wikirate.org{answer}",
            "original_url": f"https://legacy.wikirate.org{anchor}",
            "retrieved_at": checked,
            "note": "Historischer Sekundärwert. Abgrenzung und Erhebungsmethode im Originalbericht prüfen.",
        }


def validate(snapshot, universe, inputs):
    ids = {company["company_id"] for company in universe["companies"]}
    if len(ids) != 100 or snapshot["universe_id"] != universe["universe_id"]:
        raise ValueError("Unexpected UWP universe")
    if not set(inputs["lobby"]).issubset(ids) or len({entry[0] for entry in inputs["lobby"].values()}) != len(inputs["lobby"]):
        raise ValueError("Invalid Lobbyregister mapping")
    if not set(inputs["prtr"]).issubset(ids) or len({site["id"] for site in inputs["prtr"].values()}) != len(inputs["prtr"]):
        raise ValueError("Invalid PRTR site mapping")
    generated = date.fromisoformat(snapshot["checked_at"])
    seen = set()
    for obs in snapshot["observations"]:
        if obs["company_id"] not in ids or obs["dimension"] not in {"Mensch", "Planet", "Demokratie"}:
            raise ValueError("Invalid company or dimension")
        source = obs["source"]
        allowed_quality = {"lobby": {"B"}, "report": {"B"}, "wikirate": {"C"}, "prtr": {"B", "D"}}[source]
        value = obs["value"]
        url = urlsplit(obs["url"])
        if url.scheme != "https" or not url.hostname or url.username or url.password:
            raise ValueError("Expected a public HTTPS source")
        if obs["quality"] not in allowed_quality or not 1990 <= obs["year"] <= generated.year:
            raise ValueError("Invalid evidence quality or year")
        if date.fromisoformat(obs["retrieved_at"]) > generated:
            raise ValueError("Source date is in the future")
        if source == "lobby":
            if obs["kind"] != "disclosure" or not re.fullmatch(r"/suche/R\d{6}/\d+", url.path) or url.hostname != "www.lobbyregister.bundestag.de":
                raise ValueError("Unversioned Lobbyregister source")
            if not isinstance(value, list) or len(value) != 2 or any(type(item) is not int for item in value) or not 0 <= value[0] <= value[1]:
                raise ValueError("Invalid Lobbyregister band")
        elif type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise ValueError("Invalid reported metric")
        elif source == "prtr":
            site = inputs["prtr"][obs["company_id"]]
            if (
                obs["kind"] != "facility_metric" or obs["facility"]["id"] != site["id"]
                or obs["dimension"] != "Planet" or obs["unit"] not in {"kg/Jahr", "t/Jahr"}
                or url.hostname != "app.thru.de" or not re.fullmatch(r"/details/\d+/thrude", url.path)
                or obs["quality"] != {"gemessen": "B", "berechnet": "B", "geschätzt": "D"}.get(obs["determination"])
                or date.fromisoformat(obs["source_version"]) > generated
            ):
                raise ValueError("Invalid PRTR evidence")
        elif obs["kind"] != "metric":
            raise ValueError("Invalid reported metric category")
        key = (obs["company_id"], obs["indicator_id"], obs["year"], obs["url"])
        if key in seen:
            raise ValueError(f"Duplicate observation {key}")
        seen.add(key)
    if not seen or snapshot["sources"] != SOURCES:
        raise ValueError("Missing observations or source attribution")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["refresh", "validate"])
    args = parser.parse_args()
    universe = load(UNIVERSE)
    inputs = load(INPUTS)
    if args.command == "validate":
        snapshot = load(SNAPSHOT)
        validate(snapshot, universe, inputs)
    else:
        today = datetime.now(timezone.utc).date().isoformat()
        observations = [*historic_wikirate(), *report_observations(inputs["reports"])]
        observations.extend(lobby_observations(inputs["lobby"], today))
        observations.extend(import_prtr(inputs["prtr"], today, get))
        snapshot = {
            "schema_version": 1, "universe_id": universe["universe_id"], "checked_at": today,
            "sources": SOURCES, "observations": sorted(observations, key=lambda obs: (
                obs["company_id"], obs["dimension"], obs["indicator_id"], -obs["year"], obs["url"],
            )),
        }
        validate(snapshot, universe, inputs)
        temporary = SNAPSHOT.with_suffix(".tmp")
        temporary.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(SNAPSHOT)
    print(f"{len(snapshot['observations'])} observations across {len({obs['company_id'] for obs in snapshot['observations']})} companies")


if __name__ == "__main__":
    try:
        main()
    except (OSError, IncompleteRead, KeyError, ValueError) as error:
        sys.exit(f"UWP snapshot: {error}")
