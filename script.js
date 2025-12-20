const BASE_URL = 'https://api.carrismetropolitana.pt';

// --- State ---
let currentStopId = '120385';
let refreshInterval;
let showAbsoluteTime = false;
let cachedArrivals = [];
let allStops = [];
let availableLines = [];
let activeLines = new Set();
let previousStopId = null;
let activeBusMapId = null;

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
            vehicleId: arrival.vehicle_id,
            tripId: arrival.trip_id
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

        // Update Filters if stop changed
        if (currentStopId !== previousStopId) {
            const currentObj = allStops.find(s => s.stop_id === currentStopId);
            const staticLines = currentObj ? currentObj.lines : [];
            const arrivalLines = mergedArrivals.map(a => a.lineId);
            // Combine unique lines
            availableLines = Array.from(new Set([...staticLines, ...arrivalLines])).sort();
            activeLines = new Set(availableLines);

            renderLineFilters(availableLines);
            previousStopId = currentStopId;
        }

        renderList(cachedArrivals);

    } catch (err) {
        console.error(err);
        if (document.getElementById('stop-name').innerText === 'Carris Metropolitana') {
            renderError('Stop not found or API error.');
        }
    } finally {
        document.body.classList.remove('updating');
        const nextRefresh = activeBusMapId ? 5000 : 15000;
        refreshInterval = setTimeout(() => loadData(false), nextRefresh);
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

    // Preserve active map DOM element
    let preservedMapEl = null;
    const preservedMapId = activeBusMapId; // v...ID

    if (activeBusMap && activeBusMapId) {
        // Did we have it open?
        // activeBusMap.getContainer() is the mini-map div.
        preservedMapEl = activeBusMap.getContainer();
    }

    const filteredArrivals = arrivals.filter(bus => activeLines.has(bus.lineId));

    if (filteredArrivals.length === 0) {
        if (arrivals.length > 0) {
            container.innerHTML = `<div class="empty">All lines filtered out.</div>`;
        } else {
            renderEmpty();
        }
        // If we filtered everything out, we close the map to avoid ghosts
        if (activeBusMap) { activeBusMap.remove(); activeBusMap = null; activeBusMapId = null; }
        return;
    }

    const ul = document.createElement('ul');
    ul.id = 'arrivals-list';

    filteredArrivals.forEach((bus) => {
        const li = document.createElement('li');
        li.className = 'arrival-item';

        const vehicleTag = bus.vehicleId
            ? `<span class="vehicle-tag">#${bus.vehicleId.split('|')[1] || bus.vehicleId}</span>`
            : '';

        li.innerHTML = `
            <div class="arrival-row" onclick="toggleBusMap(this, '${bus.tripId || ''}', '${bus.lineId}', '${bus.vehicleId || ''}')">
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
            </div>
            <div id="bus-map-${bus.tripId || 'unknown'}" class="bus-map-container"></div>
        `;
        ul.appendChild(li);
    });

    container.innerHTML = '';
    container.appendChild(ul);

    // Restore active map
    if (preservedMapEl && preservedMapId) {
        const vehicleId = preservedMapId.substring(1);
        const match = filteredArrivals.find(b => b.vehicleId === vehicleId || (b.vehicleId && b.vehicleId.endsWith(vehicleId)));

        if (match) {
            const mapContainer = document.getElementById(`bus-map-${match.tripId || 'unknown'}`);
            if (mapContainer) {
                // Re-attach the existing map element
                mapContainer.classList.add('open');
                mapContainer.appendChild(preservedMapEl);
                // Important: Leaflet map needs to know it's back in the DOM and possibly resized
                activeBusMap.invalidateSize();
                // Update position smoothly
                updateBusPosition(match.vehicleId, match.lineId);
            }
        } else {
            // Selected bus is no longer in the list (departed or filtered)
            if (activeBusMap) { activeBusMap.remove(); activeBusMap = null; activeBusMapId = null; }
        }
    }

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

// Helper: updates bus position on existing map without reloading it
async function updateBusPosition(vehicleId, lineId) {
    if (!activeBusMap) return;

    // We can assume vehicles are cached or fetch fresh
    const vehicles = await getVehicles();
    const vehicle = vehicles.find(v => v.id === vehicleId) ||
        vehicles.find(v => v.id && vehicleId.endsWith(v.id)) ||
        vehicles.find(v => v.id && v.id.endsWith(vehicleId));

    if (!vehicle) return;

    // Handle View Mode (Auto-Fit vs Free Mode vs Focus Mode)
    if (busFocusMode) {
        // Focus Mode: Lock strictly on bus with high zoom (reduced to 17 per request)
        // Use flyTo for smoother transition if distance is large
        activeBusMap.flyTo([vehicle.lat, vehicle.lon], 17, { animate: true, duration: 1 });
    } else if (!mapFreeMode) {
        const bounds = new L.LatLngBounds();
        bounds.extend([vehicle.lat, vehicle.lon]);

        const stop = allStops.find(s => s.stop_id === currentStopId);
        if (stop) {
            bounds.extend([stop.lat, stop.lon]);
            // Use fitBounds to show both
            // Auto-refresh fits stop and bus
            // Use fitBounds to show both
            // Auto-refresh fits stop and bus
            activeBusMap.fitBounds(bounds, {
                paddingTopLeft: [0, 0],
                paddingBottomRight: [50, 100],
                maxZoom: 20,
                animate: true,
                duration: 1
            });
        } else {
            // Fallback if stop not found
            activeBusMap.flyTo([vehicle.lat, vehicle.lon], 17, { animate: true, duration: 1 });
        }
    }

    // Update markers
    let busMarker = null;
    let pathLine = null;

    activeBusMap.eachLayer(layer => {
        if (layer instanceof L.Marker && layer.options.icon?.options?.className === 'bus-marker-icon') {
            busMarker = layer;
        }
        if (layer instanceof L.Polyline && layer.options.dashArray) {
            pathLine = layer;
        }
    });

    if (busMarker) {
        busMarker.setLatLng([vehicle.lat, vehicle.lon]);

        // Update rotation
        const bearing = vehicle.bearing || 0;
        const color = getLineColor(lineId);

        const newIcon = L.divIcon({
            className: 'bus-marker-icon',
            html: `
                <div style="transform: rotate(${bearing}deg); width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;">
                    <svg width="20" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));">
                        <path d="M12 2L4.5 20L12 17L19.5 20L12 2Z" fill="${color}" stroke="white" stroke-width="2" stroke-linejoin="round"/>
                    </svg>
                </div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });

        busMarker.setIcon(newIcon);

        // Update popup text just in case ID format changed? probably constant.
    }

    if (pathLine) {
        // 0 is bus, 1 is stop. Update 0.
        const latLngs = pathLine.getLatLngs();
        if (latLngs.length >= 2) {
            // Keep stop position (index -1 or 1), update bus (0)
            latLngs[0] = [vehicle.lat, vehicle.lon];
            pathLine.setLatLngs(latLngs);
        }
    }
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

function renderLineFilters(lines) {
    const container = document.getElementById('line-filters');
    if (!lines || lines.length === 0) {
        container.innerHTML = '';
        return;
    }

    const filtersHtml = lines.map(lineId => {
        const isActive = activeLines.has(lineId);
        const color = getLineColor(lineId);
        return `<div class="line-filter-badge ${isActive ? '' : 'inactive'}" 
                     style="${isActive ? `background-color: ${color}` : ''}"
                     onclick="toggleLineFilter('${lineId}')">
                    ${lineId}
                </div>`;
    }).join('');

    // Reset/Select All Button
    const resetHtml = `
        <div class="line-filter-badge" 
             style="background-color: #64748b; display: flex; align-items: center; justify-content: center; width: 34px; padding: 0;"
             title="Select All"
             onclick="resetLineFilters()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="1 4 1 10 7 10"></polyline>
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
        </div>
    `;

    container.innerHTML = filtersHtml + resetHtml;
}

window.toggleLineFilter = function (lineId) {
    // Check if we are currently in "All Selected" state
    const isAllActive = availableLines.length > 0 && availableLines.every(id => activeLines.has(id));

    if (isAllActive) {
        // "Focus" Mode: Deselect all others, keep only the clicked one
        activeLines.clear();
        activeLines.add(lineId);
    } else {
        // Standard Multi-Select Mode
        if (activeLines.has(lineId)) {
            activeLines.delete(lineId);
        } else {
            activeLines.add(lineId);
        }
    }

    renderLineFilters(availableLines);
    renderList(cachedArrivals);
};

window.resetLineFilters = function () {
    availableLines.forEach(id => activeLines.add(id));
    renderLineFilters(availableLines);
    renderList(cachedArrivals);
};

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
    const filters = document.getElementById('line-filters');
    const btn = document.getElementById('btn-search');
    form.classList.toggle('show');
    filters.classList.toggle('show');

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
                    ${stop.lines.map(line => {
                    const color = getLineColor(line);
                    return `<span style="font-size:10px; background:${color}; color:white; padding:2px 4px; border-radius:4px; font-weight:700;">${line}</span>`;
                }).join('')}
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

// --- Bus Location Map ---
let activeBusMap = null;
let mapFreeMode = false;
let busFocusMode = false;
let vehiclesCache = null;
let shapesCache = new Map();
let patternsCache = new Map();
let currentMapLineId = null;

let lastVehiclesUpdate = 0;

async function getVehicles() {
    const now = Date.now();
    if (vehiclesCache && (now - lastVehiclesUpdate) < 15000) return vehiclesCache;
    try {
        const res = await fetch('https://api.cmet.pt/vehicles');
        if (!res.ok) throw new Error('Failed');
        vehiclesCache = await res.json();
        lastVehiclesUpdate = now;
        return vehiclesCache;
    } catch (e) {
        console.error(e);
        return vehiclesCache || [];
    }
}

async function getPattern(patternId) {
    if (!patternId) return null;
    if (patternsCache.has(patternId)) return patternsCache.get(patternId);

    try {
        // User example logic
        const res = await fetch(`https://api.cmet.pt/patterns/${patternId}`);
        if (!res.ok) return null;
        let data = await res.json();
        if (Array.isArray(data)) data = data[0];
        patternsCache.set(patternId, data);
        return data;
    } catch (e) { return null; }
}

async function getShape(shapeId) {
    if (!shapeId) return null;
    if (shapesCache.has(shapeId)) return shapesCache.get(shapeId);

    try {
        const res = await fetch(`https://api.cmet.pt/shapes/${shapeId}`);
        if (!res.ok) return null;
        const data = await res.json();
        const geojson = data.geojson;
        if (geojson) {
            shapesCache.set(shapeId, geojson);
            return geojson;
        }
    } catch (e) { return null; }
}

window.toggleBusMap = async function (el, tripId, lineId, vehicleId) {
    if (!vehicleId || vehicleId === 'undefined') return;

    currentMapLineId = lineId;
    const uniqueId = `v${vehicleId}`;
    const mapContainer = document.getElementById(`bus-map-${tripId || 'unknown'}`) || el.nextElementSibling;
    if (!mapContainer?.classList.contains('bus-map-container')) return;

    // Close if Open
    if (mapContainer.classList.contains('open')) {
        mapContainer.classList.remove('open');
        activeBusMapId = null;
        setTimeout(() => {
            if (activeBusMap && activeBusMapId === uniqueId) {
                activeBusMap.remove(); activeBusMap = null; mapContainer.innerHTML = '';
            }
        }, 300);
        return;
    }

    // Close Others
    document.querySelectorAll('.bus-map-container.open').forEach(c => {
        c.classList.remove('open');
        setTimeout(() => c !== mapContainer && (c.innerHTML = ''), 300);
    });

    if (activeBusMap) { activeBusMap.remove(); activeBusMap = null; }

    // Init Open
    mapContainer.classList.add('open');
    activeBusMapId = uniqueId;
    if (!vehiclesCache) {
        mapContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#64748b;font-size:13px;font-weight:600;"><div class="spinner" style="width:16px;height:16px;margin:0 8px 0 0;border-width:2px;"></div>Locating...</div>';
    }

    // Find Vehicle
    const vehicles = await getVehicles();
    const vehicle = vehicles.find(v => v.id === vehicleId) ||
        vehicles.find(v => v.id && vehicleId.endsWith(v.id)) ||
        vehicles.find(v => v.id && v.id.endsWith(vehicleId));

    if (!mapContainer.classList.contains('open')) return;

    if (!vehicle) {
        mapContainer.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#ef4444;font-size:13px;">Signal lost for Bus #${vehicleId.split('|')[1] || vehicleId}</div>`;
        return;
    }

    // Render Map
    // Removed unnecessary timeout for instant rendering
    if (!mapContainer.classList.contains('open')) return;
    mapContainer.innerHTML = '';
    const mapDiv = document.createElement('div');
    mapDiv.className = 'mini-map';
    mapContainer.appendChild(mapDiv);

    activeBusMap = L.map(mapDiv, { attributionControl: false, zoomControl: false }).setView([vehicle.lat, vehicle.lon], 15);
    // Switch to CartoDB Light for a lighter, cleaner look and better reliability
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 20,
        subdomains: 'abcd'
    }).addTo(activeBusMap);

    mapFreeMode = false;

    const userAction = () => {
        mapFreeMode = true;
        if (busFocusMode) setBusFocus(false);
        updateModeUI();
    };

    // Use DOM events to differentiate user interaction from programmatic moves
    mapDiv.addEventListener('mousedown', userAction);
    mapDiv.addEventListener('touchstart', userAction, { passive: true });
    mapDiv.addEventListener('wheel', userAction, { passive: true });

    // Handle Leaflet specific drag (which is user driven)
    activeBusMap.on('dragstart', userAction);

    const bounds = new L.LatLngBounds();
    const color = getLineColor(lineId);

    // Marker
    const bearing = vehicle.bearing || 0;
    const icon = L.divIcon({
        className: 'bus-marker-icon',
        html: `
            <div style="transform: rotate(${bearing}deg); width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;">
                <svg width="20" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));">
                    <path d="M12 2L4.5 20L12 17L19.5 20L12 2Z" fill="${color}" stroke="white" stroke-width="2" stroke-linejoin="round"/>
                </svg>
            </div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
    });
    L.marker([vehicle.lat, vehicle.lon], { icon, zIndexOffset: 1000 }).addTo(activeBusMap)
        .bindPopup(`Bus #${vehicle.id.split('|')[1] || vehicle.id}`, { closeButton: false });
    bounds.extend([vehicle.lat, vehicle.lon]);

    // Stop & Path
    const stop = allStops.find(s => s.stop_id === currentStopId);
    if (stop) {
        const stopIcon = L.divIcon({
            className: 'stop-marker-icon',
            html: `<div style="background-color:#0f172a; width:12px; height:12px; border-radius:50%; border:2px solid white; box-shadow:0 2px 4px rgba(0,0,0,0.2);"></div>`,
            iconSize: [12, 12]
        });
        L.marker([stop.lat, stop.lon], { icon: stopIcon }).addTo(activeBusMap).bindPopup(stop.name, { closeButton: false });
        bounds.extend([stop.lat, stop.lon]);

        // Draw Shape & Calculate Stops Info
        let stopsInfo = '';
        if (vehicle.pattern_id) {
            const pattern = await getPattern(vehicle.pattern_id);
            if (pattern) {
                // GeoJSON Shape
                if (pattern.shape_id) {
                    const geojson = await getShape(pattern.shape_id);
                    if (geojson) {
                        L.geoJSON(geojson, {
                            style: { color: color, weight: 4, opacity: 0.6, lineCap: 'round', lineJoin: 'round' }
                        }).addTo(activeBusMap);
                        // We do not fit bounds to shape, only bus+stop
                    }
                }

                // Calculate Stops Away (Optional but nice)
                if (pattern.path && vehicle.current_stop_sequence) {
                    const stopNode = pattern.path.find(p => p.stop_id === currentStopId);
                    if (stopNode) {
                        const stopsAway = stopNode.stop_sequence - vehicle.current_stop_sequence;
                        if (stopsAway >= 0) {
                            stopsInfo = `<div style="margin-top:4px; font-weight:700; color:${color}">${stopsAway} stops away</div>`;
                        } else {
                            stopsInfo = `<div style="margin-top:4px; font-weight:700; color:#ef4444">Vehicle passed</div>`;
                        }
                    }
                }
            }
        } else {
            // Fallback if no pattern
            L.polyline([[vehicle.lat, vehicle.lon], [stop.lat, stop.lon]], {
                color: '#64748b', weight: 2, dashArray: '5, 10', opacity: 0.5
            }).addTo(activeBusMap);
        }

        // Update User Interface regarding stops (update default marker popup)
        activeBusMap.eachLayer(l => {
            if (l instanceof L.Marker && l.options.icon && l.options.icon.options.className === 'bus-marker-icon') {
                const idText = vehicle.id.split('|')[1] || vehicle.id;
                l.setPopupContent(`
                    <div style="text-align:center;">
                        <b>Bus #${idText}</b>
                        ${stopsInfo}
                    </div>
                 `);
            }
        });
    }

    // Add Map Controls (Leaflet Control to persist across DOM moves)
    const MapControls = L.Control.extend({
        options: { position: 'bottomright' },
        onAdd: function (map) {
            const container = L.DomUtil.create('div');
            container.style.display = 'flex';
            container.style.flexDirection = 'column';
            container.style.gap = '8px';
            container.style.pointerEvents = 'auto'; // Ensure clicks work

            // Reset (Auto Fit) Button
            const resetBtn = L.DomUtil.create('button', 'map-focus-btn', container);
            resetBtn.id = 'auto-fit-btn';
            resetBtn.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
                </svg>
            `;
            resetBtn.onclick = (e) => {
                L.DomEvent.stopPropagation(e);
                toggleAutoFit();
            };

            // Focus Bus Button
            const focusBtn = L.DomUtil.create('button', 'map-focus-btn', container);
            focusBtn.id = 'focus-bus-btn'; // ID for easier selection
            focusBtn.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M19 17h2l.64-2.54c.24-.959.24-1.962 0-2.92l-1.07-4.27A2.99 2.99 0 0 0 17.66 5H6.34a2.99 2.99 0 0 0-2.91 2.27L2.36 11.54a4.99 4.99 0 0 0 0 2.92L3 17h2"></path>
                    <path d="M14 17H9"></path>
                    <circle cx="7" cy="17" r="2"></circle>
                    <circle cx="17" cy="17" r="2"></circle>
                </svg>
            `;
            focusBtn.onclick = (e) => {
                L.DomEvent.stopPropagation(e);
                toggleBusFocus();
            };
            return container;
        }
    });
    activeBusMap.addControl(new MapControls());
    busFocusMode = false; // Reset on open
    mapFreeMode = false;
    updateModeUI();



    // Ensure map is correctly sized before fitting bounds
    activeBusMap.invalidateSize();
    activeBusMap.fitBounds(bounds, { paddingTopLeft: [10, 10], paddingBottomRight: [50, 100], maxZoom: 20 });

    // Double check size after a tick to handle dynamic layout reflows
    setTimeout(() => {
        activeBusMap.invalidateSize();
        activeBusMap.fitBounds(bounds, { paddingTopLeft: [0, 0], paddingBottomRight: [0, 0], maxZoom: 20 });
    }, 250);
};

// --- Initialization ---
setInterval(updateClock, 1000);
updateClock();
loadStopsData();
loadData();


function updateModeUI() {
    const autoFitBtn = document.getElementById('auto-fit-btn');
    const focusBtn = document.getElementById('focus-bus-btn');

    // Auto Fit is active if NOT FreeMode and NOT FocusMode
    const isAutoFit = !mapFreeMode && !busFocusMode;

    if (autoFitBtn) {
        if (isAutoFit) autoFitBtn.classList.add('active');
        else autoFitBtn.classList.remove('active');
    }

    if (focusBtn) {
        if (busFocusMode) focusBtn.classList.add('active');
        else focusBtn.classList.remove('active');
    }
}

function setBusFocus(active) {
    busFocusMode = active;
    if (active) {
        mapFreeMode = false;
        if (activeBusMapId) {
            updateBusPosition(activeBusMapId.substring(1), currentMapLineId);
        }
    }
    updateModeUI();
}

window.toggleAutoFit = function () {
    // If enabling AutoFit, disable FreeMode and FocusMode
    mapFreeMode = false;
    busFocusMode = false;
    updateModeUI();

    if (activeBusMapId) {
        updateBusPosition(activeBusMapId.substring(1), currentMapLineId);
    }
};

window.toggleBusFocus = function () {
    setBusFocus(!busFocusMode);
};
