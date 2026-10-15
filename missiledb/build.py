from __future__ import annotations

import json
import re
import unicodedata
from collections import OrderedDict, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Tuple


ROOT = Path(__file__).resolve().parent
DATA_FILES = [
    ROOT / "data_us.txt",
    ROOT / "data_ru.txt",
    ROOT / "data_cn.txt",
    ROOT / "data_other.txt",
]

OUTPUT_FILES = {
    "master": ROOT / "master_missile_database.json",
    "aliases": ROOT / "master_alias_database.json",
    "lookup": ROOT / "alias_to_missile_lookup.json",
    "counter": ROOT / "missile_to_countermeasure_lookup.json",
    "fox": ROOT / "missile_to_fox_lookup.json",
}


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    return value.strip()


def compact_alias(value: str) -> str:
    value = normalize_text(value).lower()
    value = re.sub(r"[^a-z0-9]+", "", value)
    return value


def spaced_alias(value: str) -> str:
    value = normalize_text(value).lower()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def hyphenless_alias(value: str) -> str:
    value = normalize_text(value).lower()
    value = value.replace("-", "")
    value = re.sub(r"\s+", " ", value).strip()
    return value


def alias_variants(value: str) -> List[str]:
    normalized = normalize_text(value).lower()
    candidates = [
        normalized,
        hyphenless_alias(normalized),
        spaced_alias(normalized),
        compact_alias(normalized),
    ]
    variants = []
    seen = set()
    for candidate in candidates:
        candidate = candidate.strip()
        if candidate and candidate not in seen:
            seen.add(candidate)
            variants.append(candidate)
    return variants


def parse_record(line: str) -> Tuple[str, str, str, str, List[str]]:
    parts = [part.strip() for part in line.split("|")]
    if len(parts) != 5:
        raise ValueError(f"Invalid record: {line!r}")
    name, country, manufacturer, guidance_code, aliases = parts
    alias_list = [a.strip() for a in aliases.split(",") if a.strip()]
    return name, country, manufacturer, guidance_code, alias_list


GUIDANCE = {
    "S": "Semi-Active Radar Homing",
    "I": "Infrared",
    "A": "Active Radar Homing",
    "M": "Mixed / Multiple",
    "N": "None / N/A",
}

FOX = {
    "S": "FOX 1",
    "I": "FOX 2",
    "A": "FOX 3",
    "M": "FOX 3",
    "N": "FOX 4",
}

DEFAULT_COUNTERMEASURE = {
    "S": "Chaff + Notching",
    "I": "Flares + Maneuvering",
    "A": "Chaff",
    "M": "Mixed / Multiple",
    "N": "None / N/A",
}

COUNTERMEASURE_OVERRIDES = {
    "AIM-26 Falcon": "Mixed / Multiple",
    "AIM-47 Falcon": "Mixed / Multiple",
    "AIM-54 Phoenix": "Mixed / Multiple",
    "AIM-132 ASRAAM": "Flares + Maneuvering",
    "R-27": "Mixed / Multiple",
    "R-37": "Chaff",
    "R-40": "Mixed / Multiple",
    "R-77": "Chaff",
    "MICA IR": "Flares + Maneuvering",
    "MICA EM": "Chaff",
    "Meteor": "Chaff",
    "IRIS-T": "Flares + Maneuvering",
    "Python 4": "Flares + Maneuvering",
    "Python 5": "Flares + Maneuvering",
    "Python 6": "Flares + Maneuvering",
    "Astra Mk3": "Chaff",
    "Bozdogan": "Flares + Maneuvering",
    "Gokdogan": "Chaff",
    "Sky Sword I": "Flares + Maneuvering",
    "Sky Sword II": "Chaff",
    "A-Darter": "Flares + Maneuvering",
    "Fakour-90": "Chaff",
}

SUPPLEMENTAL_ALIASES = {
    "AIM-4 Falcon": [
        "GAR 1", "GAR 2", "GAR 3", "GAR 4", "AIM 4", "AIM.4",
        "AIM-4D Falcon", "AIM-4F Falcon", "AIM-4G Falcon",
    ],
    "AIM-7 Sparrow": [
        "AIM 7", "AIM.7", "AIM-7E Sparrow", "AIM-7F Sparrow",
        "AIM-7M Sparrow", "AIM-7P Sparrow", "AIM-7MH", "AAM-N-6a",
        "AAM-N-6b", "AAM-N-6c", "AAM-N-6d", "AAM-N-6e",
    ],
    "AIM-9 Sidewinder": [
        "AIM 9", "AIM.9", "AIM-9L/I-1", "AIM-9L/I-2", "AIM-9M-8",
        "AIM-9M-9", "AIM-9X-2", "AIM-9X-Block-II", "AIM-9X-Block-III",
        "AIM-9X Block II+", "AIM-9X Block III+",
    ],
    "AIM-120 AMRAAM": [
        "AIM 120", "AIM.120", "AIM-120B AMRAAM", "AIM-120C-5 AMRAAM",
        "AIM-120C-7 AMRAAM", "AIM-120C-8 AMRAAM", "AIM-120D AMRAAM",
        "AIM-120D-3 AMRAAM", "AMRAAM-C", "AMRAAM-D",
        "AMRAAM-ER", "NATO AMRAAM", "Advanced Medium-Range Air-to-Air Missile",
    ],
    "AIM-132 ASRAAM": [
        "AIM 132", "AIM.132", "AIM-132 Advanced Short Range Air-to-Air Missile",
        "ASRAAM Australia", "ASRAAM United Kingdom", "ASRAAM UK",
    ],
    "R-23": ["R 23", "R.23", "R-23R Apex", "R-23T Apex"],
    "R-24": ["R 24", "R.24", "R-24R Apex", "R-24T Apex"],
    "R-27": [
        "R 27", "R.27", "R-27R1 export", "R-27T1 export",
        "R-27ER1 export", "R-27ET1 export", "R-27R1", "R-27T1",
        "R-27ER1", "R-27ET1", "R-27RE1", "R-27TE1",
    ],
    "R-37": [
        "R 37", "R.37", "RVV-BD export", "RVV-BD (export)",
        "RVV-BD long-range air-to-air missile",
    ],
    "R-73": [
        "R 73", "R.73", "RVV-MD export", "RVV-MD (export)",
        "RVV-MD short-range air-to-air missile",
    ],
    "R-77": [
        "R 77", "R.77", "RVV-AE export", "RVV-AE (export)",
        "RVV-SD export", "RVV-SD (export)", "RVV-SDM export",
        "RVV-SDM (export)", "R-77-1 export",
    ],
    "PL-5": ["PL 5", "PL.5", "PL-5E export", "PL-5E-II export"],
    "PL-8": ["PL 8", "PL.8", "PL-8 export", "PL-8B export"],
    "PL-9": ["PL 9", "PL.9", "PL-9C export"],
    "PL-12": [
        "PL 12", "PL.12", "SD-10 export designation",
        "SD-10A export designation", "ShanDian-10", "Shan Dian 10",
        "ShanDian 10",
    ],
    "PL-15": [
        "PL 15", "PL.15", "PL-15E export designation",
        "PL-15E export variant", "PL-15E for export",
    ],
    "SD-10": [
        "SD 10", "SD.10", "SD-10 export designation",
        "ShanDian-10", "Shan Dian 10", "ShanDian 10",
    ],
    "Super 530F": ["Super 530 F", "Super-530 F", "Super.530F", "Super 530F export"],
    "Super 530D": ["Super 530 D", "Super-530 D", "Super.530D"],
    "Magic I": ["R.550", "R.550 Magic 1", "R.550 Magic I"],
    "Magic II": ["R.550 Magic 2", "R.550 Magic II"],
    "MICA IR": ["MICA-IR export", "MICA IR export", "MICA IR (export)"],
    "MICA EM": ["MICA-EM export", "MICA EM export", "MICA EM (export)", "MICA RF"],
    "Meteor": ["Meteor BVRAAM export", "Meteor air-to-air missile"],
    "IRIS-T": ["IRIS-T export", "IRIS-T air-to-air missile"],
    "Python 5": ["Python-5 export", "Python 5 export", "Python-5 IIR"],
    "Derby": ["Derby export", "Derby active radar missile"],
    "I-Derby ER": [
        "I-Derby ER export", "I Derby ER export", "I-Derby-ER export",
        "I-Derby Extended Range",
    ],
}


def build_alias_set(name: str, base_aliases: Iterable[str]) -> List[str]:
    ordered = OrderedDict()

    def add(value: str) -> None:
        for variant in alias_variants(value):
            ordered.setdefault(variant, None)

    add(name)
    for alias in base_aliases:
        add(alias)
    for alias in SUPPLEMENTAL_ALIASES.get(name, []):
        add(alias)

    return list(ordered.keys())


def load_records() -> List[dict]:
    records = []
    for path in DATA_FILES:
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            name, country, manufacturer, guidance_code, base_aliases = parse_record(line)
            aliases = build_alias_set(name, base_aliases)
            guidance = GUIDANCE[guidance_code]
            fox = FOX[guidance_code]
            countermeasure = COUNTERMEASURE_OVERRIDES.get(
                name, DEFAULT_COUNTERMEASURE[guidance_code]
            )
            records.append(
                {
                    "official_name": name,
                    "country": country,
                    "manufacturer": manufacturer,
                    "guidance": guidance,
                    "fox_type": fox,
                    "countermeasure": countermeasure,
                    "aliases": aliases,
                }
            )
    return records


def build_indexes(records: List[dict]) -> Tuple[List[str], Dict[str, List[str]], Dict[str, str], Dict[str, str]]:
    alias_to_missiles: Dict[str, List[str]] = defaultdict(list)
    countermeasure_lookup: Dict[str, str] = {}
    fox_lookup: Dict[str, str] = {}
    master_aliases = OrderedDict()

    for record in records:
        name = record["official_name"]
        countermeasure_lookup[name] = record["countermeasure"]
        fox_lookup[name] = record["fox_type"]
        for alias in record["aliases"]:
            master_aliases.setdefault(alias, None)
            alias_to_missiles[alias].append(name)

    for alias, missile_names in alias_to_missiles.items():
        unique = []
        seen = set()
        for missile in missile_names:
            if missile not in seen:
                seen.add(missile)
                unique.append(missile)
        alias_to_missiles[alias] = unique

    return list(master_aliases.keys()), alias_to_missiles, countermeasure_lookup, fox_lookup


def main() -> None:
    records = load_records()
    aliases, alias_lookup, counter_lookup, fox_lookup = build_indexes(records)

    OUTPUT_FILES["master"].write_text(
        json.dumps(records, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    OUTPUT_FILES["aliases"].write_text(
        json.dumps(aliases, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    OUTPUT_FILES["lookup"].write_text(
        json.dumps(alias_lookup, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    OUTPUT_FILES["counter"].write_text(
        json.dumps(counter_lookup, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    OUTPUT_FILES["fox"].write_text(
        json.dumps(fox_lookup, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    print(f"Records: {len(records)}")
    print(f"Aliases: {len(aliases)}")


if __name__ == "__main__":
    main()
