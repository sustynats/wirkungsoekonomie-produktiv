"""Import reported German facility data from the UBA High-Value-Dataset API."""

from concurrent.futures import ThreadPoolExecutor
from datetime import date
import json
import math
import re
from urllib.parse import quote, urlsplit

API = "https://app.thru.de/api/v1/prtr"
LICENSE = "https://creativecommons.org/publicdomain/zero/1.0/"
SOURCE = {
    "label": "Umweltbundesamt · thru.de (PRTR)",
    "role": "Amtliche Standortmeldung",
    "url": "https://app.thru.de/api/v1/doc/",
    "license": LICENSE,
}
METHODS = {
    "Measured": ("gemessen", "B"),
    "Calculated": ("berechnet", "B"),
    "Estimated": ("geschätzt", "D"),
}
POLLUTANTS = {
    "Carbon dioxide (CO2)": ("co2", "Kohlendioxid (CO₂)"),
    "Nitrogen oxides": ("nox", "Stickoxide (NOₓ)"),
    "Sulphur oxides (SOX)": ("sox", "Schwefeloxide (SOₓ)"),
    "Particulate matter (PM10)": ("pm10", "Feinstaub (PM₁₀)"),
    "Particulates (PM10)": ("pm10", "Feinstaub (PM₁₀)"),
    "Methane (CH4)": ("ch4", "Methan (CH₄)"),
    "Carbon monoxide (CO)": ("co", "Kohlenmonoxid (CO)"),
    "Total nitrogen": ("nitrogen", "Gesamtstickstoff"),
    "Total phosphorus": ("phosphorus", "Gesamtphosphor"),
    "Fluorides (as total F)": ("fluorides", "Fluoride (als Gesamtfluor)"),
    "Chlorides (as total Cl)": ("chlorides", "Chloride (als Gesamtchlor)"),
    "Copper and compounds (as Cu)": ("cu", "Kupfer und Verbindungen (als Cu)"),
    "Lead and compounds (as Pb)": ("pb", "Blei und Verbindungen (als Pb)"),
    "Mercury and compounds (as Hg)": ("hg", "Quecksilber und Verbindungen (als Hg)"),
    "Arsenic and compounds (as As)": ("as", "Arsen und Verbindungen (als As)"),
    "Cadmium and compounds (as Cd)": ("cd", "Cadmium und Verbindungen (als Cd)"),
    "Nickel and compounds (as Ni)": ("ni", "Nickel und Verbindungen (als Ni)"),
    "Zinc and compounds (as Zn)": ("zn", "Zink und Verbindungen (als Zn)"),
    "Chromium and compounds (as Cr)": ("cr", "Chrom und Verbindungen (als Cr)"),
}


def canonical_name(name):
    return " ".join((name or "").casefold().split())


def selected_values(record):
    for medium, label in (("air", "Luft"), ("water", "Wasser"), ("soil", "Boden")):
        for row in record[f"release_to_{medium}"]:
            pollutant = row["pollutant"]
            metric = POLLUTANTS.get(pollutant["short_name"])
            if metric and pollutant["unit"] == "kg/Jahr" and not row["confidentiality"]:
                code, name = metric
                yield (f"prtr_{medium}_{code}", f"{name} in {label}", row["annual_load"], "kg/Jahr", row["determination_method"])

    for category, label in (("hazardous_waste", "Gefährlicher Abfall"), ("non_hazardous_waste", "Nicht gefährlicher Abfall")):
        shipments = record.get(category)
        if not shipments or shipments["confidentiality"]:
            continue
        if category == "hazardous_waste":
            shipments = shipments["national"]
            label += " (Inland)"
        for purpose, action in (("recovery", "Verwertung"), ("disposal", "Beseitigung")):
            rows = shipments.get(purpose) or []
            if len(rows) == 1:
                yield (f"prtr_{category}_{purpose}", f"{label} zur {action}", rows[0]["annual_load_sum"], "t/Jahr", rows[0]["determination_method"])


def import_prtr(sites, today, get):
    def fetch(path):
        return json.loads(get(f"{API}/{path}"))

    changed = fetch("metadata/last_change_date")["change_date"][:10]
    if date.fromisoformat(changed) > date.fromisoformat(today):
        raise ValueError("PRTR dataset version is in the future")
    years = sorted({int(year) for year in fetch("years")}, reverse=True)[:2]

    def read_site(job):
        company, site, year = job
        state, identifier = site["state"], site["id"]
        record = fetch(f"years/{year}/federal_states/{state}/facilities/{quote(identifier, safe='')}")
        city = record["address"]["city"]
        name = record["name"]
        if (
            record["facility_identifier"] != identifier or record["federal_state"] != state
            or str(record["reporting_year"]) != str(year)
        ):
            raise ValueError(f"PRTR identity mismatch for {company} in {year}")
        # Use only years in which the approved reporting entity and location match.
        if canonical_name(name) != canonical_name(site["name"]) or canonical_name(city) != canonical_name(site["city"]):
            return []
        details = urlsplit(record["detail_page_link"])
        if details.hostname != "app.thru.de" or not re.fullmatch(r"/details/\d+/thrude", details.path):
            raise ValueError(f"Invalid PRTR source link for {company} in {year}")
        location = f"{name.strip()}, {city}"
        observations = []
        for metric, label, value, unit, method in selected_values(record):
            if method not in METHODS or type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                continue
            method_label, quality = METHODS[method]
            observation = {
                "company_id": company, "indicator_id": metric, "label": label,
                "dimension": "Planet", "kind": "facility_metric", "year": year,
                "value": value, "unit": unit, "quality": quality, "source": "prtr",
                "url": f"https://app.thru.de{details.path}", "locator": "thru.de · Umweltbundesamt",
                "facility": {"id": identifier, "name": location}, "retrieved_at": today,
                "source_version": changed, "determination": method_label,
                "note": "Jahreswert für die ausgewiesene Betriebseinrichtung in Deutschland. Das Register erfasst meldepflichtige Mengen oberhalb definierter Schwellen.",
            }
            if site.get("relationship_url"):
                observation["relationship_url"] = site["relationship_url"]
            observations.append(observation)
        return observations

    jobs = []
    for year in years:
        # The annual list lets us distinguish absent site reports from source errors.
        available = {
            (row["federal_state"], row["facility_identifier"])
            for row in fetch(f"years/{year}?exclude_non_prtr=true")
        }
        if not available:
            raise ValueError(f"PRTR facility inventory for {year} is empty")
        jobs.extend(
            (company, site, year) for company, site in sites.items()
            if (site["state"], site["id"]) in available
        )
    with ThreadPoolExecutor(max_workers=4) as pool:
        observations = [item for group in pool.map(read_site, jobs) for item in group]
    if not observations:
        raise ValueError("PRTR returned no attributable site observations")
    return observations
