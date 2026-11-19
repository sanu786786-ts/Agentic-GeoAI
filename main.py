from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import httpx
import math
import re
from typing import Optional

app = FastAPI(
    title="Agentic GeoAI - Emergency Intelligence",
    version="6.1.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

DEFAULT_RADIUS = 5
MAX_RADIUS = 20
EARTH_RADIUS = 6371


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=2)
    latitude: float
    longitude: float
    radius_km: Optional[float] = None
    limit: int = 100


def haversine(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(
        math.radians, [lat1, lon1, lat2, lon2]
    )

    dlat = lat2 - lat1
    dlon = lon2 - lon1

    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1)
        * math.cos(lat2)
        * math.sin(dlon / 2) ** 2
    )

    return 2 * EARTH_RADIUS * math.asin(math.sqrt(a))


def detect_category(query):
    q = query.lower()

    # English + common Hindi/Hinglish words (India-first prototype)
    if any(word in q for word in [
        "blood bank", "blood banks", "blood donation",
        "blood centre", "blood center", "blood storage",
        "raktdan", "khoon", "rakt kosh"
    ]):
        return "blood_bank"

    if any(word in q for word in [
        "ambulance", "ambulance station"
    ]):
        return "ambulance_station"

    if any(word in q for word in [
        "clinic", "clinics", "dispensary", "dawakhana"
    ]):
        return "clinic"

    if any(word in q for word in [
        "hospital", "hospitals", "emergency hospital", "aspatal"
    ]):
        return "hospital"

    return "healthcare"


def extract_radius(query, requested_radius):
    """
    FIX: a radius typed inside the query (e.g. "blood banks within 3 km")
    now takes priority. Earlier, the dropdown value always overrode it.
    Order: radius in query text -> dropdown value -> default.
    """
    match = re.search(
        r"(\d+(?:\.\d+)?)\s*(?:km|kilometer|kilometre)",
        query.lower()
    )

    if match:
        return max(0.5, min(float(match.group(1)), MAX_RADIUS))

    if requested_radius is not None:
        return max(0.5, min(float(requested_radius), MAX_RADIUS))

    return DEFAULT_RADIUS


def build_overpass_query(lat, lon, radius, category):
    radius_m = int(radius * 1000)

    if category == "blood_bank":
        filters = [
            'node["amenity"="blood_bank"]',
            'way["amenity"="blood_bank"]',
            'relation["amenity"="blood_bank"]',
            'node["healthcare"="blood_bank"]',
            'way["healthcare"="blood_bank"]',
            'relation["healthcare"="blood_bank"]',
            'node["healthcare"="blood_donation"]',
            'way["healthcare"="blood_donation"]',
            'relation["healthcare"="blood_donation"]',
            'node["blood_bank"="yes"]',
            'way["blood_bank"="yes"]',
            'relation["blood_bank"="yes"]'
        ]

    elif category == "ambulance_station":
        filters = [
            'node["emergency"="ambulance_station"]',
            'way["emergency"="ambulance_station"]',
            'relation["emergency"="ambulance_station"]'
        ]

    elif category == "hospital":
        filters = [
            'node["amenity"="hospital"]',
            'way["amenity"="hospital"]',
            'relation["amenity"="hospital"]'
        ]

    elif category == "clinic":
        filters = [
            'node["amenity"="clinic"]',
            'way["amenity"="clinic"]',
            'relation["amenity"="clinic"]',
            'node["healthcare"="clinic"]',
            'way["healthcare"="clinic"]',
            'relation["healthcare"="clinic"]'
        ]

    else:
        # General healthcare: FIX - blood banks are now included too.
        filters = [
            'node["amenity"~"hospital|clinic|doctors"]',
            'way["amenity"~"hospital|clinic|doctors"]',
            'relation["amenity"~"hospital|clinic|doctors"]',
            'node["emergency"="ambulance_station"]',
            'way["emergency"="ambulance_station"]',
            'relation["emergency"="ambulance_station"]',
            'node["amenity"="blood_bank"]',
            'way["amenity"="blood_bank"]',
            'relation["amenity"="blood_bank"]',
            'node["healthcare"="blood_bank"]',
            'way["healthcare"="blood_bank"]',
            'relation["healthcare"="blood_bank"]'
        ]

    statements = []

    for item in filters:
        statements.append(
            f'{item}(around:{radius_m},{lat},{lon});'
        )

    return f"""
    [out:json][timeout:45];
    (
        {"".join(statements)}
    );
    out center tags;
    """


def get_coordinates(element):
    if element.get("lat") is not None:
        return element.get("lat"), element.get("lon")

    center = element.get("center", {})
    return center.get("lat"), center.get("lon")


def classify_facility(tags, fallback):
    if (
        tags.get("amenity") == "blood_bank"
        or tags.get("healthcare") in [
            "blood_bank", "blood_donation"
        ]
        or tags.get("blood_bank") == "yes"
    ):
        return "blood_bank"

    if tags.get("emergency") == "ambulance_station":
        return "ambulance_station"

    if tags.get("amenity") == "hospital":
        return "hospital"

    if (
        tags.get("amenity") == "clinic"
        or tags.get("healthcare") == "clinic"
    ):
        return "clinic"

    return fallback


def make_address(tags):
    parts = []

    for key in [
        "addr:housenumber",
        "addr:street",
        "addr:suburb",
        "addr:city",
        "addr:postcode"
    ]:
        if tags.get(key):
            parts.append(tags[key])

    return ", ".join(parts) if parts else "Address not available"


def make_facility(element, user_lat, user_lon, category):
    tags = element.get("tags", {})
    lat, lon = get_coordinates(element)

    if lat is None or lon is None:
        return None

    try:
        lat = float(lat)
        lon = float(lon)
    except (TypeError, ValueError):
        return None

    distance = haversine(user_lat, user_lon, lat, lon)

    name = tags.get("name") or tags.get("brand") or "Unnamed facility"
    facility_type = classify_facility(tags, category)

    phone = (
        tags.get("phone")
        or tags.get("contact:phone")
        or "Not available"
    )

    website = (
        tags.get("website")
        or tags.get("contact:website")
        or None
    )

    osm_type = element.get("type", "node")
    osm_id = element.get("id")

    source_url = (
        f"https://www.openstreetmap.org/{osm_type}/{osm_id}"
    )

    # Ranking: closer = higher; small bonus for useful data.
    score = max(0, 100 - distance * 5)

    if phone != "Not available":
        score += 5

    if tags.get("name"):
        score += 5

    address = make_address(tags)

    return {
        "id": f"{osm_type}_{osm_id}",
        "osm_id": osm_id,
        "osm_type": osm_type,
        "name": name,
        "type": facility_type,
        "latitude": lat,
        "longitude": lon,
        "distance_km": round(distance, 2),
        "address": address,
        "phone": phone,
        "website": website,
        "opening_hours": tags.get("opening_hours"),
        "emergency": tags.get("emergency"),
        "operator": tags.get("operator"),
        "source": "OpenStreetMap",
        "source_url": source_url,
        "ranking_score": round(score, 2),
        "metadata": {
            "has_phone": phone != "Not available",
            "has_address": address != "Address not available",
            "has_name": bool(tags.get("name")),
            "independently_verified": False
        }
    }


async def fetch_overpass(query):
    async with httpx.AsyncClient(timeout=55) as client:
        for endpoint in OVERPASS_URLS:
            try:
                response = await client.post(
                    endpoint,
                    data={"data": query},
                    headers={
                        "User-Agent": "AgenticGeoAI/6.1"
                    }
                )

                response.raise_for_status()
                result = response.json()

                return result.get("elements", [])

            except Exception as error:
                print(f"Overpass error at {endpoint}: {error}")

    raise HTTPException(
        status_code=502,
        detail="OpenStreetMap data service is temporarily unavailable."
    )


def remove_duplicates(facilities):
    unique = []
    seen_ids = set()

    for facility in facilities:
        if facility["id"] in seen_ids:
            continue

        seen_ids.add(facility["id"])

        duplicate = False

        # FIX: unnamed facilities are never merged by name, because two
        # different unnamed places nearby would wrongly be treated as one.
        if facility["name"] != "Unnamed facility":
            for existing in unique:
                same_name = (
                    existing["name"].lower()
                    == facility["name"].lower()
                )

                if not same_name:
                    continue

                distance = haversine(
                    existing["latitude"],
                    existing["longitude"],
                    facility["latitude"],
                    facility["longitude"]
                )

                if distance < 0.12:
                    duplicate = True
                    break

        if not duplicate:
            unique.append(facility)

    return unique


@app.get("/")
def home():
    return {
        "message": "Agentic GeoAI Emergency Intelligence API",
        "version": "6.1.0"
    }


@app.get("/health")
def health():
    return {
        "status": "running",
        "application": "Agentic GeoAI",
        "version": "6.1.0"
    }


@app.get("/ai-status")
async def ai_status():
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            response = await client.get(
                "http://127.0.0.1:11434/api/tags"
            )
            response.raise_for_status()

            models = response.json().get("models", [])

            return {
                "ollama_available": True,
                "models": [
                    model.get("name") for model in models
                ]
            }

    except Exception:
        return {
            "ollama_available": False,
            "message": "Rule-based query understanding is available."
        }


@app.post("/search")
async def search(request: SearchRequest):
    query = request.query.strip()

    if not -90 <= request.latitude <= 90:
        raise HTTPException(400, "Invalid latitude.")

    if not -180 <= request.longitude <= 180:
        raise HTTPException(400, "Invalid longitude.")

    category = detect_category(query)
    radius = extract_radius(query, request.radius_km)

    overpass_query = build_overpass_query(
        request.latitude,
        request.longitude,
        radius,
        category
    )

    elements = await fetch_overpass(overpass_query)
    raw_count = len(elements)

    facilities = []

    for element in elements:
        facility = make_facility(
            element,
            request.latitude,
            request.longitude,
            category
        )

        if facility and facility["distance_km"] <= radius:
            facilities.append(facility)

    in_radius_count = len(facilities)

    facilities = remove_duplicates(facilities)
    unique_count = len(facilities)

    facilities.sort(
        key=lambda item: (
            -item["ranking_score"],
            item["distance_km"]
        )
    )

    facilities = facilities[:max(1, min(request.limit, 200))]

    # The workflow now reports what actually happened in this search.
    agent_workflow = [
        f"Query understanding: intent detected = {category}",
        f"Spatial search planning: radius = {radius:g} km around "
        f"({request.latitude:.4f}, {request.longitude:.4f})",
        f"OpenStreetMap data retrieval: {raw_count} raw records fetched",
        "Coordinate validation: records without valid coordinates removed",
        f"Distance and radius filtering: {in_radius_count} records within {radius:g} km",
        f"Duplicate removal: {unique_count} unique facilities",
        "Relevance ranking: sorted by score (distance + data completeness)",
        f"Result generation: {len(facilities)} results returned",
    ]

    return {
        "success": True,
        "query": query,
        "intent": category,
        "radius_km": radius,
        "total_results": len(facilities),
        "data": facilities,
        "agent_workflow": agent_workflow,
        "verification_summary": {
            "source": "OpenStreetMap",
            "independently_verified": False,
            "message": "Listing information is not independently verified."
        },
        "disclaimer": (
            "OpenStreetMap data may be incomplete or outdated. "
            "Results do not confirm real-time availability."
        )
    }

