const API_BASE = "http://127.0.0.1:8000";

let userLatitude = 18.5204;
let userLongitude = 73.8567;
let allFacilities = [];
let markerLayer;

const userQuery = document.getElementById("userQuery");
const facilityFilter = document.getElementById("facilityFilter");
const radiusFilter = document.getElementById("radiusFilter");
const searchButton = document.getElementById("searchButton");
const voiceButton = document.getElementById("voiceButton");
const locateButton = document.getElementById("locateButton");

const resultMessage = document.getElementById("resultMessage");
const hospitalList = document.getElementById("hospitalList");
const hospitalCount = document.getElementById("hospitalCount");
const selectedCategory = document.getElementById("selectedCategory");
const selectedRadius = document.getElementById("selectedRadius");
const locationStatus = document.getElementById("locationStatus");
const workflowList = document.getElementById("workflowList");

const map = L.map("geoMap").setView(
    [userLatitude, userLongitude],
    12
);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

if (typeof L.markerClusterGroup === "function") {
    markerLayer = L.markerClusterGroup();
} else {
    markerLayer = L.layerGroup();
}

map.addLayer(markerLayer);

const userMarker = L.marker([
    userLatitude,
    userLongitude
]).addTo(map).bindPopup("Your selected location");

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    })[char]);
}

// FIX: website values come from OpenStreetMap tags (user-edited data).
// Only allow http/https links so a "javascript:" link can never be rendered.
function safeUrl(value) {
    if (!value) return "";

    let url = String(value).trim();

    if (!/^https?:\/\//i.test(url)) {
        url = "http://" + url;
    }

    try {
        const parsed = new URL(url);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            return parsed.href;
        }
    } catch (error) {
        return "";
    }

    return "";
}

function categoryName(category) {
    const names = {
        all: "All facilities",
        hospital: "Hospitals",
        clinic: "Clinics",
        ambulance_station: "Ambulance stations",
        blood_bank: "Blood banks",
        healthcare: "General healthcare"
    };

    return names[category] || category;
}

function markerColor(type) {
    const colors = {
        hospital: "#1689d5",
        clinic: "#18a66a",
        ambulance_station: "#ed982a",
        blood_bank: "#c62848",
        healthcare: "#6c72c9"
    };

    return colors[type] || "#087fbd";
}

function markerIcon(type) {
    const symbols = {
        hospital: "H",
        clinic: "C",
        ambulance_station: "A",
        blood_bank: "B",
        healthcare: "+"
    };

    const color = markerColor(type);
    const symbol = symbols[type] || "+";

    return L.divIcon({
        className: "",
        html: `<div style="
            background:${color};
            color:white;
            border:2px solid white;
            border-radius:50%;
            width:32px;
            height:32px;
            display:flex;
            align-items:center;
            justify-content:center;
            font-weight:bold;
            box-shadow:0 2px 6px #777;
        ">${symbol}</div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });
}

async function checkBackend() {
    const indicator = document.getElementById("apiIndicator");
    const status = document.getElementById("apiStatus");

    try {
        const response = await fetch(`${API_BASE}/health`);
        if (!response.ok) throw new Error("Backend unavailable");

        indicator.style.background = "#18a66a";
        status.textContent = "Backend connected";
    } catch (error) {
        indicator.style.background = "#e04444";
        status.textContent = "Backend disconnected";
    }
}

async function searchFacilities() {
    const query = userQuery.value.trim();

    if (query.length < 2) {
        resultMessage.textContent = "Please enter a search query.";
        return;
    }

    const radius = Number(radiusFilter.value);

    searchButton.disabled = true;
    searchButton.textContent = "Searching...";
    resultMessage.textContent = "Searching OpenStreetMap data...";
    hospitalList.innerHTML = '<div class="empty-state">Loading results...</div>';

    selectedRadius.textContent = `${radius} km`;

    try {
        const response = await fetch(`${API_BASE}/search`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                query: query,
                latitude: userLatitude,
                longitude: userLongitude,
                radius_km: radius,
                limit: 100
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || "Search failed");
        }

        allFacilities = Array.isArray(data.data) ? data.data : [];

        selectedCategory.textContent = categoryName(data.intent);
        selectedRadius.textContent = `${data.radius_km} km`;

        // FIX: keep the dropdowns in sync with what the backend understood
        // (e.g. query "blood banks within 3 km" selects 3 km + Blood banks).
        const radiusOption = Array.from(radiusFilter.options)
            .find(option => Number(option.value) === Number(data.radius_km));
        if (radiusOption) {
            radiusFilter.value = radiusOption.value;
        }

        const hasTypeOption = Array.from(facilityFilter.options)
            .some(option => option.value === data.intent);
        facilityFilter.value = hasTypeOption ? data.intent : "all";

        resultMessage.textContent =
            `${data.total_results} facilities found within ${data.radius_km} km.`;

        renderWorkflow(data.agent_workflow || []);
        renderFacilities();

    } catch (error) {
        resultMessage.textContent = `Error: ${error.message}`;
        hospitalList.innerHTML =
            '<div class="empty-state">Unable to retrieve results. Check whether the backend is running.</div>';

        hospitalCount.textContent = "0";
        markerLayer.clearLayers();

    } finally {
        searchButton.disabled = false;
        searchButton.textContent = "Search";
    }
}

function renderWorkflow(steps) {
    workflowList.innerHTML = "";

    steps.forEach(step => {
        const li = document.createElement("li");
        li.textContent = step;
        workflowList.appendChild(li);
    });
}

function renderFacilities() {
    const selected = facilityFilter.value;

    let facilities = allFacilities;

    if (selected !== "all") {
        facilities = allFacilities.filter(item => item.type === selected);
    }

    hospitalCount.textContent = facilities.length;

    markerLayer.clearLayers();

    if (facilities.length === 0) {
        hospitalList.innerHTML = `
            <div class="empty-state">
                No ${escapeHTML(categoryName(selected).toLowerCase())}
                found in this search.

                <br><br>
                OpenStreetMap may not contain listings for every facility.
                Try increasing the search radius or checking another source.
            </div>
        `;
        return;
    }

    hospitalList.innerHTML = "";

    facilities.forEach(facility => {
        const lat = Number(facility.latitude);
        const lon = Number(facility.longitude);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            return;
        }

        const marker = L.marker(
            [lat, lon],
            { icon: markerIcon(facility.type) }
        );

        marker.bindPopup(`
            <strong>${escapeHTML(facility.name)}</strong><br>
            ${escapeHTML(categoryName(facility.type))}<br>
            ${escapeHTML(facility.distance_km)} km away
        `);

        markerLayer.addLayer(marker);

        const websiteHref = safeUrl(facility.website);

        const website = websiteHref
            ? `<a href="${escapeHTML(websiteHref)}" target="_blank" rel="noopener noreferrer">Website</a>`
            : "Website not available";

        const source = facility.source_url
            ? `<a href="${escapeHTML(facility.source_url)}" target="_blank" rel="noopener noreferrer">OpenStreetMap source</a>`
            : "";

        // Lets users report wrong/outdated data directly on OpenStreetMap.
        const reportUrl =
            `https://www.openstreetmap.org/note/new#map=19/${lat}/${lon}`;

        const phone = facility.phone || "Not available";
        const address = facility.address || "Address not available";
        const hours = facility.opening_hours || "Not available";
        const score = Number(facility.ranking_score);
        const scoreText = Number.isFinite(score) ? score.toFixed(1) : "N/A";

        const card = document.createElement("article");
        card.className = "facility-card";

        card.innerHTML = `
            <span class="facility-type">
                ${escapeHTML(categoryName(facility.type))}
            </span>

            <h3>${escapeHTML(facility.name)}</h3>

            <p><strong>Distance:</strong>
                ${escapeHTML(facility.distance_km)} km
            </p>

            <p><strong>Relevance score:</strong>
                ${escapeHTML(scoreText)}
                <span class="score-note">(closer + more complete data = higher)</span>
            </p>

            <p><strong>Address:</strong>
                ${escapeHTML(address)}
            </p>

            <p><strong>Phone:</strong>
                ${escapeHTML(phone)}
            </p>

            <p><strong>Opening hours:</strong>
                ${escapeHTML(hours)}
            </p>

            <p><strong>Website:</strong> ${website}</p>

            <p>${source}</p>

            <p><strong>Data source:</strong> OpenStreetMap</p>

            <p>
                <strong>Verification:</strong>
                Not independently verified
            </p>

            <p>
                <a href="https://www.google.com/maps?q=${lat},${lon}"
                   target="_blank" rel="noopener noreferrer">
                   View directions
                </a>
                &nbsp;|&nbsp;
                <a href="${escapeHTML(reportUrl)}"
                   target="_blank" rel="noopener noreferrer">
                   Report incorrect information
                </a>
            </p>
        `;

        card.addEventListener("click", event => {
            if (event.target.closest("a")) return;

            map.setView([lat, lon], 16);
            marker.openPopup();
        });

        hospitalList.appendChild(card);
    });

    const markerBounds = facilities
        .filter(item =>
            Number.isFinite(Number(item.latitude)) &&
            Number.isFinite(Number(item.longitude))
        )
        .map(item => [
            Number(item.latitude),
            Number(item.longitude)
        ]);

    if (markerBounds.length) {
        map.fitBounds(markerBounds, { padding: [35, 35], maxZoom: 14 });
    }
}

function locateUser() {
    if (!navigator.geolocation) {
        locationStatus.textContent =
            "Geolocation is not supported by this browser.";
        return;
    }

    locationStatus.textContent = "Getting your location...";

    navigator.geolocation.getCurrentPosition(
        position => {
            userLatitude = position.coords.latitude;
            userLongitude = position.coords.longitude;

            userMarker.setLatLng([
                userLatitude,
                userLongitude
            ]);

            map.setView([
                userLatitude,
                userLongitude
            ], 13);

            locationStatus.textContent =
                "Your current location has been selected. Search again to update results.";
        },

        error => {
            locationStatus.textContent =
                "Location permission denied or location unavailable.";
        },

        {
            enableHighAccuracy: true,
            timeout: 10000
        }
    );
}

searchButton.addEventListener("click", searchFacilities);

userQuery.addEventListener("keydown", event => {
    if (event.key === "Enter") {
        searchFacilities();
    }
});

facilityFilter.addEventListener("change", renderFacilities);

radiusFilter.addEventListener("change", () => {
    selectedRadius.textContent = `${radiusFilter.value} km`;
});

locateButton.addEventListener("click", locateUser);

// Voice search: supported browsers only.
const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechRecognition) {
    const recognition = new SpeechRecognition();

    recognition.lang = "en-IN";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    voiceButton.addEventListener("click", () => {
        // FIX: start() throws if recognition is already running.
        try {
            recognition.start();
            voiceButton.textContent = "Listening...";
        } catch (error) {
            voiceButton.textContent = "🎤";
        }
    });

    recognition.onresult = event => {
        userQuery.value = event.results[0][0].transcript;
        voiceButton.textContent = "🎤";
        searchFacilities();
    };

    recognition.onerror = () => {
        voiceButton.textContent = "🎤";
        locationStatus.textContent =
            "Voice search failed. Check microphone permission.";
    };

    recognition.onend = () => {
        voiceButton.textContent = "🎤";
    };

} else {
    voiceButton.disabled = true;
    voiceButton.title = "Voice search is not supported in this browser.";
}

checkBackend();
// Re-check the backend every 30 seconds so the status dot stays accurate.
setInterval(checkBackend, 30000);

