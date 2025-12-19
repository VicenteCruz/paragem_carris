const BASE_URL = 'https://api.carrismetropolitana.pt';
let currentStopId = '120385';
let refreshInterval;
let showAbsoluteTime = false;
let cachedArrivals = [];

function quickSelect(id) {
    document.getElementById('stop-id-input').value = id;
    currentStopId = id;
    loadData();
}

function toggleViewMode() {
    showAbsoluteTime = !showAbsoluteTime;
    const toggle = document.getElementById('view-toggle');
    if (showAbsoluteTime) {
        toggle.classList.add('show-time');
    } else {
        toggle.classList.remove('show-time');
    }
    // Re-render immediately with cached data
    renderList(cachedArrivals);
}

function toggleSearch() {
    const form = document.getElementById('search-form');
    const btn = document.getElementById('btn-search');
    form.classList.toggle('show');

    if (form.classList.contains('show')) {
        document.getElementById('stop-id-input').focus();
        btn.style.backgroundColor = 'var(--primary)';
        btn.style.color = 'white';
        btn.style.borderColor = 'var(--primary)';
    } else {
        btn.style.backgroundColor = '';
        btn.style.color = '';
        btn.style.borderColor = '';
    }
}

// --- Utils ---
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
setInterval(updateClock, 1000);
updateClock();

// --- API ---
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

// --- UI ---
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

    arrivals.forEach((bus, i) => {
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
}

// --- Core ---
const stopGroups = {
    '172197': ['172197', '172537', '172491']
};

async function loadData() {
    try {
        document.body.classList.add('updating');
        const title = document.getElementById('stop-name').innerText;

        // Only show full page loader if we don't have data yet (first load)
        if (title === 'Carris Metropolitana' && !document.getElementById('arrivals-list')) {
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
        document.getElementById('stop-name').innerText = stop.name + (idsToFetch.length > 1 ? ' + Adjacent' : '');
        document.getElementById('stop-details').innerText = stop.locality || stop.municipality_name;

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

        // Schedule next refresh in 15 seconds
        clearTimeout(refreshInterval);
        refreshInterval = setTimeout(loadData, 15000);
    }
}

// --- Init ---
document.getElementById('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = document.getElementById('stop-id-input').value.trim();
    if (val) {
        currentStopId = val;
        loadData();
    }
});

// Start
loadData();
// Refresh cycle is handled inside loadData via setTimeout
