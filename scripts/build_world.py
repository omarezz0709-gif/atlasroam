"""One-off: builds data/world.json (country outlines for the globe) and scripts/names.json (name -> ISO2 for matching
the FCDO, Wikipedia and other sources) from Natural Earth (public domain). Run by hand only when the map should change:
    pip install shapely && python scripts/build_world.py
"""
from __future__ import annotations

import json
import math
import os

from shapely.geometry import mapping, shape

from common import ROOT, get_json, norm, save_json

NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson"

# Natural Earth parts without their own ISO code: shown as part of the country whose travel advice covers them
HOST = {"SOL": "SO", "CYN": "CY", "IOA": "AU", "ATC": "AU", "KOS": "XK"}
SKIP = {"KAS"}   # Siachen Glacier: disputed, no travel advice of its own
# tiny states get a clickable dot as well (their outline is hard to hit)
MICRO_KM2 = 2500

# names written differently by the sources (normalised by common.norm)
EXTRA = {
    "US": ["United States", "USA", "United States of America"], "GB": ["UK", "United Kingdom", "Britain", "Great Britain"],
    "BS": ["Bahamas", "The Bahamas"], "MM": ["Burma", "Myanmar", "Myanmar (Burma)"], "CI": ["Cote d'Ivoire", "Ivory Coast"],
    "CZ": ["Czech Republic", "Czechia"], "CD": ["Democratic Republic of the Congo", "DR Congo", "Congo, Democratic Republic of the", "Congo (Kinshasa)", "DRC"],
    "CG": ["Republic of the Congo", "Congo", "Congo-Brazzaville", "Congo (Brazzaville)", "Congo, Republic of the"],
    "SZ": ["Eswatini", "Swaziland"], "GM": ["Gambia", "The Gambia", "Gambia, The"], "TL": ["Timor-Leste", "East Timor"],
    "KP": ["North Korea", "Korea, North", "Democratic People's Republic of Korea"], "KR": ["South Korea", "Korea, South", "Republic of Korea"],
    "LA": ["Laos", "Lao People's Democratic Republic", "Lao PDR"], "FM": ["Micronesia", "Federated States of Micronesia", "Micronesia, Federated States of"],
    "MK": ["North Macedonia", "Macedonia"], "PS": ["Palestine", "Palestinian Territories", "The Occupied Palestinian Territories", "Israel and the Palestinian Territories", "West Bank and Gaza", "State of Palestine", "Palestinian territories"],
    "TR": ["Turkey", "Türkiye", "Turkiye"], "VA": ["Vatican City", "Holy See", "Vatican"], "KN": ["St Kitts and Nevis", "Saint Kitts and Nevis"],
    "LC": ["St Lucia", "Saint Lucia"], "VC": ["St Vincent and the Grenadines", "Saint Vincent and the Grenadines"],
    "CV": ["Cape Verde", "Cabo Verde"], "BN": ["Brunei", "Brunei Darussalam"], "RU": ["Russia", "Russian Federation"],
    "SY": ["Syria", "Syrian Arab Republic"], "IR": ["Iran", "Islamic Republic of Iran"], "VN": ["Vietnam", "Viet Nam"],
    "BO": ["Bolivia"], "VE": ["Venezuela"], "TZ": ["Tanzania", "United Republic of Tanzania"], "MD": ["Moldova", "Republic of Moldova"],
    "XK": ["Kosovo"], "ST": ["Sao Tome and Principe", "São Tomé and Príncipe"], "TW": ["Taiwan", "Republic of China (Taiwan)", "Taiwan, China"],
    "HK": ["Hong Kong", "Hong Kong SAR"], "MO": ["Macao", "Macau"], "CW": ["Curaçao", "Curacao"], "SX": ["Sint Maarten"],
    "BQ": ["Bonaire", "Caribbean Netherlands", "Bonaire, Sint Eustatius and Saba"], "PR": ["Puerto Rico"],
    "VI": ["US Virgin Islands", "United States Virgin Islands", "Virgin Islands (US)"], "VG": ["British Virgin Islands", "Virgin Islands (British)"],
    "FK": ["Falkland Islands", "Falklands"], "SH": ["St Helena, Ascension and Tristan da Cunha", "Saint Helena"], "PN": ["Pitcairn Island", "Pitcairn Islands"],
    "TC": ["Turks and Caicos Islands"], "KY": ["Cayman Islands"], "GI": ["Gibraltar"], "BM": ["Bermuda"], "AI": ["Anguilla"], "MS": ["Montserrat"],
    "SJ": ["Svalbard"], "GL": ["Greenland"], "FO": ["Faroe Islands"], "NC": ["New Caledonia"], "PF": ["French Polynesia"],
    "WF": ["Wallis and Futuna"], "PM": ["St Pierre and Miquelon"], "BL": ["St Barthélemy", "Saint Barthelemy"], "MF": ["St Martin", "Saint Martin"],
    "RE": ["Réunion", "Reunion"], "GP": ["Guadeloupe"], "MQ": ["Martinique"], "GF": ["French Guiana"], "YT": ["Mayotte"],
    "AW": ["Aruba"], "GU": ["Guam"], "AS": ["American Samoa"], "MP": ["Northern Mariana Islands"], "CK": ["Cook Islands"], "NU": ["Niue"],
    "TK": ["Tokelau"], "IO": ["British Indian Ocean Territory"], "EH": ["Western Sahara"], "AQ": ["Antarctica", "British Antarctic Territory"],
    "SO": ["Somalia", "Somaliland"], "CY": ["Cyprus", "Northern Cyprus"], "NL": ["Netherlands", "The Netherlands", "Kingdom of the Netherlands"],
    "IE": ["Ireland", "Republic of Ireland"], "GW": ["Guinea-Bissau"], "GQ": ["Equatorial Guinea"], "PG": ["Papua New Guinea"],
    "AE": ["United Arab Emirates", "UAE"], "SA": ["Saudi Arabia"], "BA": ["Bosnia and Herzegovina", "Bosnia-Herzegovina"],
    "NE": ["Niger"], "NG": ["Nigeria"], "DM": ["Dominica"], "DO": ["Dominican Republic"], "CF": ["Central African Republic"],
    "SS": ["South Sudan"], "SD": ["Sudan"], "GE": ["Georgia"], "JE": ["Jersey"], "GG": ["Guernsey"], "IM": ["Isle of Man"],
    "CN": ["China", "People's Republic of China", "Mainland China"], "MH": ["Marshall Islands"], "SB": ["Solomon Islands"],
}


def main() -> None:
    ne = get_json(NE, timeout=120)
    countries, names = [], {}
    seen = {}
    for f in ne["features"]:
        p = f["properties"]
        a3 = p["ADM0_A3"]
        if a3 in SKIP:
            continue
        iso = HOST.get(a3) or (p["ISO_A2_EH"] if p["ISO_A2_EH"] != "-99" else None)
        if not iso:
            print("no code:", p["NAME"]); continue
        g = shape(f["geometry"])
        area_deg = g.area
        tol = 0.04 if area_deg > 50 else 0.012 if area_deg > 2 else 0.0
        g2 = g.simplify(tol, preserve_topology=True) if tol else g
        geom = mapping(g2)

        def rnd(c):
            return [rnd(x) for x in c] if isinstance(c[0], (list, tuple)) else [round(c[0], 2), round(c[1], 2)]
        geom = {"type": geom["type"], "coordinates": rnd(geom["coordinates"])}
        part = {"id": iso, "g": geom}
        is_part = a3 in HOST and a3 != "KOS"   # Kosovo is its own country, the others belong to one
        if is_part:
            part["part"] = p["NAME"]   # e.g. Somaliland shown inside Somalia's advice
        seen.setdefault(iso, []).append(part)
        if not is_part and iso not in [c["id"] for c in countries]:
            # r = world subregion (sets the colour family), c = Natural Earth's 7-colour index (neighbours differ)
            countries.append({"id": iso, "a3": p["ISO_A3_EH"] if p["ISO_A3_EH"] != "-99" else a3, "n": p["NAME"],
                              "lat": round(p["LABEL_Y"], 2), "lng": round(p["LABEL_X"], 2), "_area": area_deg,
                              "r": p.get("SUBREGION") or p.get("REGION_UN") or "", "c": p.get("MAPCOLOR7") or 1})
        for k in ("NAME", "NAME_LONG", "ADMIN", "FORMAL_EN", "NAME_CIAWF", "BRK_NAME", "GEOUNIT", "SUBUNIT", "NAME_SORT"):
            if p.get(k):
                names.setdefault(norm(p[k]), set()).add(iso)
    for c in countries:
        if c["id"] == "XK":
            c["a3"] = "XKX"   # Kosovo's code in the sources
        # rough size in km² (degrees² scaled at the label latitude) decides which states get a dot
        c["micro"] = c.pop("_area") * 111.3 ** 2 * math.cos(math.radians(c["lat"])) < MICRO_KM2
    names_out = {k: next(iter(v)) for k, v in names.items() if len(v) == 1 and k}
    for iso, lst in EXTRA.items():
        for n in lst:
            names_out[norm(n)] = iso
    feats = [part for iso in seen for part in seen[iso]]
    save_json("world.json", {"source": "Natural Earth 1:50m (public domain)", "countries": sorted(countries, key=lambda c: c["id"]), "shapes": feats})
    with open(os.path.join(ROOT, "scripts", "names.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(dict(sorted(names_out.items())), fh, ensure_ascii=False, indent=0)
    print(len(countries), "countries,", len(feats), "shapes,", sum(c["micro"] for c in countries), "micro,", len(names_out), "names")


if __name__ == "__main__":
    main()
