const BASE_URL = 'https://api.carrismetropolitana.pt';

// --- State ---
let currentStopId = '120385';
let refreshInterval;
let showAbsoluteTime = false;
let cachedArrivals = [];
let allStops = [];

const stopGroups = {
    '172197': ['172197', '172537', '172491']
};

const searchInput = document.getElementById('stop-id-input');
const suggestionsList = document.getElementById('suggestions');

// --- Utils ---
function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

const getLineColor = (lineId) => {
    const firstDigit = lineId.charAt(0);
    switch (firstDigit) {
        case '1': return '#EBBD02'; // Yellow
        case '2': return '#C6007E'; // Pink
        case '3': return '#008BD2'; // Blue
        case '4': return '#E30613'; // Red
        default: return '#6f2282'; // Purple
    }
};

const updateClock = () => {
    const now = new Date();
    document.getElementById('clock').innerText = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

// --- API & Data ---
function loadStopsData() {
    if (window.ALL_STOPS) {
        processStops(window.ALL_STOPS);
        return;
    }

    fetch('stops_lite.json')
        .then(res => {
            if (!res.ok) throw new Error("Lite data missing");
            return res.json();
        })
        .then(data => {
            // Map short keys back to standard format for the app
            allStops = data.map(s => ({
                stop_id: s.i,
                name: s.n,
                lat: s.l,
                lon: s.o,
                locality: s.c,
                lines: s.r || [],
                status: s.s === 1 ? 'ACTIVE' : 'INACTIVE',
                // Add dummy fields if text search needs them avoids crashes
                tts_name: s.n
            }));

            if (typeof updateMapMarkers === 'function' && typeof map !== 'undefined' && map) {
                updateMapMarkers();
            }
        })
        .catch(e => {
            console.warn("Falling back to full stops.txt", e);
            fetch('stops.txt')
                .then(res => res.json())
                .then(data => {
                    processStops(data);
                });
        });
}

function processStops(data) {
    // Normalize data if it comes from legacy source (stops.txt or stops_data.js)
    allStops = data.map(stop => {
        // If already normalized (lite format), return as is (but mapped to full keys)
        if (stop.status) return stop;

        return {
            ...stop,
            // Map legacy fields to new standard
            status: stop.operational_status || 'ACTIVE',
            lines: stop.lines || [],
            // Ensure lat/lon are numbers for map
            lat: stop.lat,
            lon: stop.lon
        };
    });

    if (typeof updateMapMarkers === 'function' && typeof map !== 'undefined' && map) {
        updateMapMarkers();
    }
}

async function fetchStopInfo(stopId) {
    const res = await fetch(`${BASE_URL}/stops/${stopId}`);
    if (!res.ok) throw new Error('Stop not found');
    return res.json();
}

async function fetchRealtime(stopId) {
    const res = await fetch(`${BASE_URL}/stops/${stopId}/realtime`);
    if (!res.ok) throw new Error('Error fetching realtime');
    const data = await res.json();

    const now = new Date();

    return data.map(arrival => {
        const timeString = arrival.estimated_arrival || arrival.scheduled_arrival;
        if (!timeString) return null;

        const [h, m, s] = timeString.split(':').map(Number);
        const arrivalDate = new Date();
        arrivalDate.setHours(h, m, s, 0);

        if (now.getHours() > 20 && h < 4) {
            arrivalDate.setDate(arrivalDate.getDate() + 1);
        }

        const diffMs = arrivalDate.getTime() - now.getTime();
        const minutes = Math.floor(diffMs / 60000);

        return {
            lineId: arrival.line_id,
            destination: arrival.headsign,
            minutes: minutes,
            arrivalTime: `${String(arrivalDate.getHours()).padStart(2, '0')}:${String(arrivalDate.getMinutes()).padStart(2, '0')}`,
            isRealtime: !!arrival.estimated_arrival,
            color: getLineColor(arrival.line_id),
            vehicleId: arrival.vehicle_id
        };
    })
        .filter(a => a !== null && a.minutes >= -1)
        .sort((a, b) => a.minutes - b.minutes);
}

async function loadData(forceLoading = false) {
    // Clear existing timer immediately
    clearTimeout(refreshInterval);

    try {
        document.body.classList.add('updating');
        const title = document.getElementById('stop-name').innerText;

        // Show loading if forced or first load
        if (forceLoading || (title === 'Carris Metropolitana' && !document.getElementById('arrivals-list'))) {
            renderLoading();
        }

        // Determine IDs to fetch (single or group)
        const idsToFetch = stopGroups[currentStopId] || [currentStopId];

        // Fetch Stop Info (Primary)
        const stop = await fetchStopInfo(idsToFetch[0]);

        // Parallel fetch for all stops in group
        const results = await Promise.all(idsToFetch.map(id => fetchRealtime(id)));

        // Merge and Sort
        const mergedArrivals = results.flat().sort((a, b) => a.minutes - b.minutes);

        // Update Header
        const nameEl = document.getElementById('stop-name');
        nameEl.innerText = stop.name + (idsToFetch.length > 1 ? ' + Adjacent' : '');
        document.getElementById('stop-details').innerText = stop.locality || stop.municipality_name;

        // Check for overflow to trigger marquee
        nameEl.classList.remove('scrolling');
        nameEl.style.removeProperty('--scroll-dist');

        const overflow = nameEl.scrollWidth - nameEl.parentElement.clientWidth;
        if (overflow > 0) {
            // Add buffer of 20px
            nameEl.style.setProperty('--scroll-dist', `-${overflow + 20}px`);
            nameEl.classList.add('scrolling');
        }

        // Update List
        cachedArrivals = mergedArrivals;
        renderList(cachedArrivals);

    } catch (err) {
        console.error(err);
        if (document.getElementById('stop-name').innerText === 'Carris Metropolitana') {
            renderError('Stop not found or API error.');
        }
    } finally {
        document.body.classList.remove('updating');
        refreshInterval = setTimeout(() => loadData(false), 15000);
    }
}

// --- UI Rendering ---
function renderLoading() {
    document.getElementById('content').innerHTML = `
        <div class="loading">
            <div class="spinner"></div>
            <div>Updating arrivals...</div>
        </div>
    `;
}

function renderError(msg) {
    document.getElementById('content').innerHTML = `<div class="error">${msg}</div>`;
}

function renderEmpty() {
    document.getElementById('content').innerHTML = `<div class="empty">No buses arriving soon.</div>`;
}

function renderList(arrivals) {
    const container = document.getElementById('content');
    if (arrivals.length === 0) {
        renderEmpty();
        return;
    }

    const ul = document.createElement('ul');
    ul.id = 'arrivals-list';

    arrivals.forEach((bus) => {
        const li = document.createElement('li');
        li.className = 'arrival-item';

        const vehicleTag = bus.vehicleId
            ? `<span class="vehicle-tag">#${bus.vehicleId.split('|')[1] || bus.vehicleId}</span>`
            : '';

        li.innerHTML = `
            <div class="line-info">
                <div class="line-number" style="background-color: ${bus.color}">
                    ${bus.lineId}
                </div>
                <div class="destination-info">
                    <div class="destination">${bus.destination}</div>
                    <div>
                        <span class="status-badge ${bus.isRealtime ? 'status-live' : 'status-est'}">
                            ${bus.isRealtime ? 'LIVE' : 'EST'}
                        </span>
                        ${vehicleTag}
                    </div>
                </div>
            </div>
            <div class="time-display">
                <div class="time-val ${(!showAbsoluteTime && bus.minutes <= 0) ? 'animate-pulse' : ''}" 
                     style="color: #ffcd00; font-size: ${showAbsoluteTime ? '16px' : '20px'}">
                    ${showAbsoluteTime ? bus.arrivalTime : (bus.minutes <= 0 ? 'AGORA' : bus.minutes)}
                </div>
                <div class="time-unit">${showAbsoluteTime ? '' : (bus.minutes <= 0 ? '' : 'min')}</div>
            </div>
        `;
        ul.appendChild(li);
    });

    container.innerHTML = '';
    container.appendChild(ul);

    // Marquee Logic for destinations
    requestAnimationFrame(() => {
        const dests = ul.querySelectorAll('.destination');
        dests.forEach(el => {
            const overflow = el.scrollWidth - el.parentElement.clientWidth;
            if (overflow > 0) {
                el.style.setProperty('--scroll-dist', `-${overflow + 20}px`);
                el.classList.add('scrolling');

                // Play animation once on click
                el.onclick = (e) => {
                    e.stopPropagation();
                    el.classList.remove('animating');
                    void el.offsetWidth; // Trigger reflow
                    el.classList.add('animating');
                    const remove = () => {
                        el.classList.remove('animating');
                        el.removeEventListener('animationend', remove);
                    };
                    el.addEventListener('animationend', remove);
                };
            }
        });
    });
}

function renderSuggestions(matches) {
    if (matches.length === 0) {
        suggestionsList.classList.remove('show');
        return;
    }

    suggestionsList.innerHTML = matches.map(stop => `
        <div class="suggestion-item" onclick="selectStop('${stop.stop_id}', '${stop.name.replace(/'/g, "\\'")}')">
            <div class="suggestion-info">
                <div class="suggestion-name">${stop.name}</div>
                <div class="suggestion-detail" style="font-size: 11px; color:#64748b;">${stop.locality || ''}</div>
            </div>
            <span class="suggestion-id">${stop.stop_id}</span>
        </div>
    `).join('');

    suggestionsList.classList.add('show');
}

// --- Interaction Functions ---
function quickSelect(id) {
    const stop = allStops.find(s => s.stop_id === id);
    searchInput.value = stop ? stop.name : id;
    currentStopId = id;
    loadData(true);
}

window.selectStop = function (id, name) {
    searchInput.value = name;
    currentStopId = id;
    suggestionsList.classList.remove('show');
    toggleSearch();
    loadData(true);
};

function toggleViewMode() {
    showAbsoluteTime = !showAbsoluteTime;
    const toggle = document.getElementById('view-toggle');
    if (showAbsoluteTime) {
        toggle.classList.add('show-time');
    } else {
        toggle.classList.remove('show-time');
    }
    renderList(cachedArrivals);
}

function toggleSearch() {
    const form = document.getElementById('search-form');
    const btn = document.getElementById('btn-search');
    form.classList.toggle('show');

    if (form.classList.contains('show')) {
        searchInput.focus();
        btn.style.backgroundColor = 'var(--primary)';
        btn.style.color = 'white';
        btn.style.borderColor = 'var(--primary)';
    } else {
        btn.style.backgroundColor = '';
        btn.style.color = '';
        btn.style.borderColor = '';
    }
}

// --- Event Listeners ---
searchInput.addEventListener('input', debounce((e) => {
    const query = e.target.value.toLowerCase().trim();
    if (query.length < 2) {
        suggestionsList.classList.remove('show');
        return;
    }

    if (!allStops.length) return;

    const matches = allStops.filter(stop =>
        stop.name.toLowerCase().includes(query) ||
        stop.stop_id.includes(query) ||
        (stop.tts_name && stop.tts_name.toLowerCase().includes(query))
    ).slice(0, 50);

    renderSuggestions(matches);
}, 300));

document.getElementById('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = searchInput.value.trim();
    if (!val) return;

    // 1. Direct ID
    if (/^\d{6}$/.test(val)) {
        currentStopId = val;
        loadData(true);
        toggleSearch();
        return;
    }

    if (!allStops.length) {
        alert("Stop data not loaded yet. Please wait.");
        return;
    }

    // 2. Exact match
    const exactMatch = allStops.find(s => s.name.toLowerCase() === val.toLowerCase() || s.stop_id === val);
    if (exactMatch) {
        currentStopId = exactMatch.stop_id;
        loadData(true);
        toggleSearch();
    } else {
        // 3. Fuzzy fallback
        const bestMatch = allStops.find(s => s.name.toLowerCase().includes(val.toLowerCase()));
        if (bestMatch) {
            currentStopId = bestMatch.stop_id;
            searchInput.value = bestMatch.name;
            loadData(true);
            toggleSearch();
        } else {
            alert("Paragem não encontrada. Tente selecionar da lista.");
        }
    }
});

document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-input-wrapper')) {
        suggestionsList.classList.remove('show');
    }
});

// --- Map Logic ---
let map = null;
let stopsLayer = null;

function toggleMap() {
    const modal = document.getElementById('map-modal');
    const isShowing = modal.classList.toggle('show');

    if (isShowing) {
        if (!map) {
            setTimeout(initMap, 100);
        } else {
            setTimeout(() => {
                map.invalidateSize();
                updateMapMarkers();
            }, 100);
        }
    }
}

function initMap() {
    // Default to Lisbon
    const defaultCenter = [38.722, -9.139];

    // Performance optimization: preferCanvas
    map = L.map('map', {
        preferCanvas: true
    }).setView(defaultCenter, 13);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);

    stopsLayer = L.layerGroup().addTo(map);

    map.on('moveend', updateMapMarkers);

    // Add current location button or auto-locate
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                L.circleMarker([latitude, longitude], {
                    radius: 8,
                    fillColor: "#4285F4",
                    color: "#ffffff",
                    weight: 2,
                    opacity: 1,
                    fillOpacity: 1
                }).addTo(map).bindPopup("You are here");

                map.setView([latitude, longitude], 15);
            },
            (err) => console.warn("Geolocation denied or error", err),
            { timeout: 5000 }
        );
    }

    updateMapMarkers();
}

function updateMapMarkers() {
    if (!map || !allStops || allStops.length === 0) return;

    const zoom = map.getZoom();
    const messageEl = document.getElementById('map-message');

    // Threshold: Only show markers if zoomed in enough (level 14+)
    // or if the visible area contains a manageable number of stops (e.g. < 500)
    // Checking 15k stops against bounds is fast (~5ms).

    if (zoom < 14) {
        stopsLayer.clearLayers();
        messageEl.classList.add('visible');
        messageEl.innerText = "Zoom in to see stops";
        return;
    }

    const bounds = map.getBounds();
    const visibleStops = [];

    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const west = bounds.getWest();
    const east = bounds.getEast();

    for (let i = 0; i < allStops.length; i++) {
        const stop = allStops[i];
        const lat = parseFloat(stop.lat);
        const lon = parseFloat(stop.lon);

        if (lat >= south && lat <= north && lon >= west && lon <= east) {
            visibleStops.push({ ...stop, latNum: lat, lonNum: lon });
        }

        // Safety Break: if too many stops, stop rendering to avoid freeze
        if (visibleStops.length > 300) {
            stopsLayer.clearLayers();
            messageEl.classList.add('visible');
            messageEl.innerText = "Zoom in closer (too many stops)";
            return;
        }
    }

    messageEl.classList.remove('visible');

    // Render
    stopsLayer.clearLayers();

    visibleStops.forEach(stop => {
        const marker = L.circleMarker([stop.latNum, stop.lonNum], {
            radius: 6,
            fillColor: stop.status === 'ACTIVE' ? "#004494" : "#94a3b8", // Grey if inactive
            color: "#ffffff",
            weight: 1,
            opacity: 1,
            fillOpacity: 0.8
        });

        marker.on('click', () => {
            const linesHtml = stop.lines && stop.lines.length > 0
                ? `<div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px;">
                    ${stop.lines.map(line => `<span style="font-size:10px; background:#e2e8f0; color:#475569; padding:2px 4px; border-radius:4px; font-weight:600;">${line}</span>`).join('')}
                   </div>`
                : '<div style="font-size:11px; color:#94a3b8; margin-bottom:8px;">No lines available</div>';

            const statusBadge = stop.status === 'ACTIVE'
                ? '<span style="color:#16a34a; background:#dcfce7; font-size:9px; padding:1px 4px; border-radius:3px; font-weight:700; margin-left:6px;">ACTIVE</span>'
                : '<span style="color:#dc2626; background:#fee2e2; font-size:9px; padding:1px 4px; border-radius:3px; font-weight:700; margin-left:6px;">INACTIVE</span>';

            L.popup()
                .setLatLng([stop.latNum, stop.lonNum])
                .setContent(`
                    <div style="min-width: 180px;">
                        <h3 style="margin:0 0 2px; font-size:14px; font-weight:700; color:#0f172a; display:flex; align-items:center;">
                            ${stop.name}
                            ${statusBadge}
                        </h3>
                        <div style="font-size:11px; color:#64748b; margin-bottom:8px;">${stop.locality || ''} (${stop.stop_id})</div>
                        ${linesHtml}
                        <button onclick="window.selectStopFromMap('${stop.stop_id}', '${stop.name.replace(/'/g, "\\'")}')" 
                            style="width:100%; background:#004494; color:white; border:none; padding:8px 12px; border-radius:6px; font-weight:600; cursor:pointer;">
                            Select Stop
                        </button>
                    </div>
                `)
                .openOn(map);
        });

        stopsLayer.addLayer(marker);
    });
}

window.selectStopFromMap = function (id, name) {
    window.selectStop(id, name);
    toggleMap(); // Close modal
};

// --- Initialization ---
setInterval(updateClock, 1000);
updateClock();
loadStopsData();
loadData();
