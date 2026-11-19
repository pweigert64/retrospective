const myTitle = document.title;
document.getElementById('current-year-label').textContent = myTitle;

const COLORS = { 
    'ski': '#4f46e5', 'hike': '#b54708', 'scramble': '#d97706', 'climb': '#dc2626', 'alpine': '#0f766e',
    'bike': '#024302', 'bike+hike': '#f97316', 'trip': '#9333ea', 'unknown': '#6b7280' 
};
const ICONS_MAP = { 
    'ski': '❄️', 'piste': '🚠', 'hike': '🥾', 'scramble': '⛰️', 'climb': '🧗', 'alpine': '⛏️',
    'bike': '🚴', 'bike+hike': '🚵', 'trip': '🏛️'
};

function normalizeActivityKey(activity) {
    const key = String(activity || '').trim().toLowerCase();
    // Keep the legacy rope value as an alias for the current roped-climbing category.
    if (key === 'rope') return 'climb';
    return key;
}

let map, overviewLayer, detailLayer, hikingLayer, cyclingLayer;
let photoMarkers = [], currentMarkers = [], allMarkers = [], loadedTracks = {};
let peakRecords = [], peakMarkers = [], peaksLoaded = false, peakLoadFailed = false, peakLoadPromise = null, showPeaksOnMap = false, filterPeaksByFilters = false;
let peakFindMatches = [], peakFindPosition = -1;
let coordinatePickMode = false, coordinateSelectionMarker = null, lastCopiedCoordinates = '';
const ACTIVITY_FILTER_KEYS = ['ski', 'piste', 'hike', 'scramble', 'climb', 'alpine', 'bike', 'bike+hike', 'trip'];
let activeFilters = { ski: true, piste: true, hike: true, scramble: true, climb: true, alpine: true, bike: true, 'bike+hike': true, trip: true, unknown: true };
let activeTxtSearch = '';
let activeSearchMode = 'literal';
let selectedTourIdx = null;
let activeYear = 'All', isInitialLoad = true; 
let MAPTILER_KEY, SHEETS_CSV_URL, SHEETS_CSV_PEAK_URL;
let typingTimer;               // Timer for real-time debounce (hesitate with immediate search)
const doneTypingInterval = 1200; // Wait ###ms after typing stops

// Calculate this ONCE when the page loads
const IS_LOCAL = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
/* -------------------------------------------------------------------------
 * which repo holds the assets for a given year?
 * befor y2k: 19XXs repo, after y2k: calculate decade and return e.g. "2020s"
 * Beyond that path the year-folder holds all gpx/img files.
 * -----------------------------------------------------------------------*/
function getAssetBase(year) {
    const base = IS_LOCAL? "./data/" : ASSETBASE_URL;
        
    return `${base}${year}/`;
}

function inheritTripAlbumLinks(records) {
    const albumByTripId = new Map();
    records.forEach(record => {
        const tripId = record.tripid?.trim();
        if (tripId && record.album?.startsWith('http') && !albumByTripId.has(tripId)) {
            albumByTripId.set(tripId, record.album);
        }
    });

    records.forEach(record => {
        const tripId = record.tripid?.trim();
        if (tripId && !record.album?.startsWith('http') && albumByTripId.has(tripId)) {
            record.album = albumByTripId.get(tripId);
        }
    });
}

/* -------------------------------------------------------------------------
 * TOGGLE Sidebar (Hamburger Menu) 
 * parameter: 'toggle', 'open', 'close'
 * -----------------------------------------------------------------------*/
function toggleSidebar(action = 'toggle') {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    
    // 1. Soll explizit geöffnet werden?
    if (action === 'open') {
        sidebar.classList.add('open');
        overlay.classList.remove('hidden');
    } 
    // 2. Soll explizit geschlossen werden?
    else if (action === 'close') {
        sidebar.classList.remove('open');
        overlay.classList.add('hidden');
    } 
    // 3. Wenn kein Parameter übergeben wurde (action = 'toggle'): Zustand einfach umkehren
    else {
        sidebar.classList.toggle('open');
        if (sidebar.classList.contains('open')) {
            overlay.classList.remove('hidden');
        } else {
            overlay.classList.add('hidden');
        }
    }
}

/* -------------------------------------------------------------------------
 * TOGGLE (i)-Button (reading info.md)
 * -----------------------------------------------------------------------*/
// Variable, um zu speichern, ob wir die Info schon einmal geladen haben (Performance-Schutz)
let isInfoLoaded = false;

function toggleInfoModal() {
    const modal = document.getElementById('info-modal');
    const isOpening = modal.classList.contains('hidden');

    // Wenn das Modal geöffnet wird UND wir die Info noch nicht geladen haben
    if (isOpening && !isInfoLoaded) {
        fetch('info.md')
            .then(response => {
                if (!response.ok) throw new Error('info.md konnte nicht geladen werden');
                return response.text();
            })
            .then(markdownText => {
                // Konvertiert das info.md in HTML und injiziert es
                document.getElementById('info-modal-content').innerHTML = marked.parse(markdownText);
                isInfoLoaded = true; // Markieren, dass es geladen ist
            })
            .catch(err => {
                console.error(err);
                document.getElementById('info-modal-content').innerHTML = `<p class="text-red-500">Fehler beim Laden der Site-Info.</p>`;
            });
    }

    // Modal umschalten (anzeigen / verstecken)
    modal.classList.toggle('hidden');
}

/* -------------------------------------------------------------------------
 * TOGGLE Searchbar (sliding in from beneath top-nav)
 * -----------------------------------------------------------------------*/
function toggleTxtSearch() {
    const toolbar = document.getElementById('txtSearchToolbar');
    toolbar.classList.toggle('hidden'); // toggle on/off

    // if the search box is visible
    if (!toolbar.classList.contains('hidden')) {
        // put the focus into the textbox (no need to click it)
        document.getElementById('txtSearchInput').focus();
    } else {
        // Clear search when closing
        document.getElementById('txtSearchInput').value = '';
        handleTxtSearch(''); 
    }
}

/* -------------------------------------------------------------------------
 * TOGGLE PANEL opens gear/map button.
 * -----------------------------------------------------------------------*/
function togglePanel(panelId) {
    const target = document.getElementById(panelId);
    const isCurrentlyVisible = target.style.display === 'flex';
    document.querySelectorAll('.pop-out-panel').forEach(p => p.style.display = 'none');
    if (!isCurrentlyVisible) target.style.display = 'flex';
}

/* -------------------------------------------------------------------------
 * LOAD CONFIG load config.ts parameters:
 *   - MAPTILER_KEY
 *   - GOOGLE_SHEETS_URL holding the activities basic data
 *   - GOOGLE-SHEETS_PEAK_URL holding the peak data (2nd Tab)
 * ------------------------------------------------------------------------*/
async function loadConfig() {
    const response = await fetch(`./config.js?t=${new Date().getTime()}`);
    if (!response.ok) throw new Error("Could not find config.js");
    const text = await response.text();
    const keyMatch = text.match(/MAPTILER_KEY\s*=\s*['"]([^'"]+)['"]/);
    const urlMatch = text.match(/SHEETS_CSV_URL\s*=\s*['"]([^'"]+)['"]/);
    const peakUrlMatch = text.match(/SHEETS_CSV_PEAK_URL\s*=\s*['"]([^'"]+)['"]/);
    const assetBaseMatch = text.match(/ASSETBASE_URL\s*=\s*['"]([^'"]+)['"]/);
    if (keyMatch && urlMatch && assetBaseMatch) {
        MAPTILER_KEY = keyMatch[1];
        SHEETS_CSV_URL = urlMatch[1];
        SHEETS_CSV_PEAK_URL = peakUrlMatch ? peakUrlMatch[1] : '';
        ASSETBASE_URL = assetBaseMatch[1];
    }
}

/* -------------------------------------------------------------------------
 * FETCH SHEET DATA: The core logic to get data from Google-Sheets
 * ------------------------------------------------------------------------*/
async function fetchSheetData() {
    try {
        if (!SHEETS_CSV_URL) await loadConfig(); 
        const response = await fetch(`${SHEETS_CSV_URL}&t=${new Date().getTime()}`);
        const csvText = await response.text();
        const lines = csvText.split(/\r?\n/);
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        const yearHeader = headers.find(header => /^(19|20)\d{2}$/.test(header));
        if (yearHeader && !headers.includes('year')) {
            headers[headers.indexOf(yearHeader)] = 'year';
        }

        photoMarkers = lines.slice(1).filter(l => l.trim() !== "").map(line => {
            const values = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            const obj = {};
            headers.forEach((h, i) => {
                let val = values[i] ? values[i].replace(/^"|"$/g, '').trim() : "";
                if (h === 'lat' || h === 'lon') val = parseFloat(val);
                obj[h] = val;
            });
            return obj;
        });

        // create collection info
        let lastTripId = null;

        photoMarkers = photoMarkers.map(p => {
            // Falls eine tripid vorhanden ist
            if (p.tripid && p.tripid !== "") {
                if (p.tripid !== lastTripId) {
                    // Dies ist der erste Record mit dieser ID -> Header markieren
                    p.isCollectionHeader = true;
                    lastTripId = p.tripid;
                } else {
                    // Folge-Record der gleichen ID -> Member
                    p.isCollectionHeader = false;
                }
            } else {
                // Keine tripid -> Einzelbild, kein Header
                p.isCollectionHeader = false;
                lastTripId = null; // Reset für den nächsten Block
            }
            
            // Clean up "undefined" strings in the data immediately after loading
            for (let key in p) {
                if (p[key] === "undefined" || p[key] === undefined) p[key] = "";
            }
            return p;
        });

        inheritTripAlbumLinks(photoMarkers);
        
        // FIXED: Initial Year Detection
        const yearsInData = [...new Set(photoMarkers.map(p => String(p.year || '')))]
                            .filter(y => y && y.length === 4)
                            .sort((a, b) => b - a);
        
        if (isInitialLoad) {
            const urlParams = new URLSearchParams(window.location.search);
            const hasDeepLink = urlParams.has('s') || urlParams.has('re') || urlParams.has('title'); // Prüft beide Varianten

            if (hasDeepLink) {
                // Wenn wir einen Deep-Link haben, zeigen wir ALLES an, 
                // damit die Suche den Marker sicher findet
                activeYear = 'All'; 
            } else {
                // Normaler Start: Das neueste Jahr nehmen
                activeYear = yearsInData.length > 0 ? yearsInData[0] : 'All';
            }
        }

        if (!map) {
            initMap();
            populateYearSidebar();
            switchView('portal'); // Always start in Portal
        } else {
            populateYearSidebar();
            renderPortal();
            renderMarkers();
        }
        
        return true; 
    } catch (e) {
        console.error("Fetch Error:", e);
        return false; 
    }
}

/* -------------------------------------------------------------------------
 * INIT MAP define layers, place the appropriate map
 * ------------------------------------------------------------------------*/
function initMap() {
    const startPos = [48.18, 14.17]; 
    map = L.map('map', { center: startPos, zoom: 11, zoomControl: false });
    
    // Define all available base layers
    baseLayers = {
        'opentopo': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { 
            maxZoom: 17, 
            attribution: '&copy; OpenTopoMap' 
        }),
        'maptiler': L.tileLayer(`https://api.maptiler.com/maps/outdoor-v4/{z}/{x}/{y}@2x.png?key=${MAPTILER_KEY}`, { 
            tileSize: 512, zoomOffset: -1, maxZoom: 19, 
            attribution: '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>' 
        }),
        'osm': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { 
            maxZoom: 19, 
            attribution: '&copy; OpenStreetMap' 
        }),
        'sat_esri': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { 
            maxZoom: 19, 
            attribution: '&copy; Esri'
        }),
        'sat_maptiler': L.tileLayer(`https://api.maptiler.com/maps/hybrid-v4/{z}/{x}/{y}.jpg?key=${MAPTILER_KEY}`, {
            tileSize: 512,
            zoomOffset: -1,
            maxZoom: 19,
            attribution: '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>'
        }),
        'sat_google': L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
            maxZoom: 20,
            attribution: '&copy; Google'
        })
    };

    // Define Overlays (Waymarked Trails)
    overlays = {
        'hike': L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png'),
        'bike': L.tileLayer('https://tile.waymarkedtrails.org/mtb/{z}/{x}/{y}.png')
    };

    // Set the initial base layer
    changeBaseLayer('opentopo');

    // Simple zoom display update
    map.on('zoomend', () => {
        document.getElementById('zoom-level-display').innerText = map.getZoom();
    });

    setupEvents();
    setupCoordinatePicker();
    renderMarkers();
}

/* -------------------------------------------------------------------------
 * Change the shown map as of the selected button.
 * ------------------------------------------------------------------------*/
function changeBaseLayer(layerKey) {
    // 1. Remove the current active base layer from the map
    Object.keys(baseLayers).forEach(key => {
        if (map.hasLayer(baseLayers[key])) {
            map.removeLayer(baseLayers[key]);
        }
    });

    // 2. Add the selected layer
    baseLayers[layerKey].addTo(map);
    currentBaseLayer = layerKey;

    // 3. Update the UI - Remove 'active' class from ALL, add to CLICKED
    document.querySelectorAll('.base-layer-btn').forEach(btn => {
        btn.classList.remove('filter-button-active');
        btn.classList.add('bg-white'); // Return to default
    });

    const activeBtn = document.getElementById('btn-' + layerKey);
    if (activeBtn) {
        activeBtn.classList.add('filter-button-active');
        activeBtn.classList.remove('bg-white');
    }
}

/* -------------------------------------------------------------------------
 * Determine the actual view: portal (Grid) or map (Leaflet)
 * If nothing is already rendered (within initial fetchSheetData)
 * we return the default: portal otherwise it depends on the viaibility
 * attribute of the portal-view
 * ------------------------------------------------------------------------*/
function getCurrentView() {
    const portal = document.getElementById('portal-view');
    const peaks = document.getElementById('peaks-view');
    if (peaks && peaks.style.display !== 'none') return 'peaks';
    
    // Check the actual computed style or the inline style
    if (portal && portal.style.display === 'none') {
        return 'map';
    }
    return 'portal'; // the default for the initial view
}

/* -------------------------------------------------------------------------
 * Determine index of the topmost fully visible potal card.
 * If a card has its top beyond the header (at 60px) it is fully visible.
 * ------------------------------------------------------------------------*/
function getTopPortalIndex() {
    const portal = document.getElementById('portal-view');
    if (!portal) return null;

    const cards = document.querySelectorAll('.portal-card');
    const portalRect = portal.getBoundingClientRect();
    const visibleCards = [...cards].filter(card => {
        const rect = card.getBoundingClientRect();
        return rect.bottom > portalRect.top && rect.top < portalRect.bottom;
    });

    if (visibleCards.length === 0) return null;

    visibleCards.sort((first, second) =>
        first.getBoundingClientRect().top - second.getBoundingClientRect().top
    );
    return parseInt(visibleCards[0].dataset.idx, 10);
}

/* -------------------------------------------------------------------------
 * Switches between Portal (Grid) and Map (Leaflet)
 * @param {string} view - 'portal' or 'map'
 * @param {boolean} shouldFlyToTopIdx - whether to fly to the top visible index
 * ------------------------------------------------------------------------*/
function switchView(view, shouldFlyToTopIdx = false) {
    const isMap = view === 'map';
    const isPeaks = view === 'peaks';
    if (isPeaks) {
        if (!peaksLoaded && activeYear !== 'All') {
            activeYear = 'All';
            populateYearSidebar();
        }
        loadPeakData();
    }
    // retrieve the index of the topmost visible card in the portal before switching
    console.log(`Switching to ${view} view. shouldFlyToTopIdx: ${shouldFlyToTopIdx}`);  
    let topIdx = null;
    if (isMap && shouldFlyToTopIdx) {
        topIdx = selectedTourIdx ?? getTopPortalIndex();
        if (selectedTourIdx === null) selectedTourIdx = topIdx;
    }
    
    // We toggle the display of the two main containers
    document.getElementById('portal-view').style.display = isMap || isPeaks ? 'none' : 'block';
    document.getElementById('peaks-view').style.display = isPeaks ? 'block' : 'none';
    document.getElementById('map-view').style.display = isMap ? 'block' : 'none';
    
    // Portal Button State
    const portalBtn = document.getElementById('nav-portal');
    portalBtn.classList.toggle('opacity-50', isMap);
    portalBtn.classList.toggle('bg-transparent', isMap);
    portalBtn.classList.toggle('bg-white', !isMap);
    portalBtn.classList.toggle('shadow-sm', !isMap);

    // Map Button State
    const mapBtn = document.getElementById('nav-map');
    mapBtn.classList.toggle('opacity-50', !isMap);
    mapBtn.classList.toggle('bg-transparent', !isMap);
    mapBtn.classList.toggle('bg-white', isMap);
    mapBtn.classList.toggle('shadow-sm', isMap);

    const peaksBtn = document.getElementById('nav-peaks');
    peaksBtn.classList.toggle('opacity-50', !isPeaks);
    peaksBtn.classList.toggle('bg-transparent', !isPeaks);
    peaksBtn.classList.toggle('bg-white', isPeaks);
    peaksBtn.classList.toggle('shadow-sm', isPeaks);

    // seems obsolete, but ensures inital setting on refresh (if year not changed)
    const label = document.getElementById('current-year-label');
    label.innerText = `${myTitle}: ${activeYear}` + '\u200A'; // add a hairspace to prevent cut of last character

    if(isMap && map) {
        setTimeout(() => {
            map.invalidateSize();
            renderMarkers(); // Force markers to re-evaluate their 'active' status
            if ( shouldFlyToTopIdx && topIdx !== null ) {
                console.log("switchView::Top Portal Index:", topIdx, "title:", photoMarkers[topIdx] ? photoMarkers[topIdx].title : "N/A");
                if (topIdx !== null && photoMarkers[topIdx] && hasTourCoordinates(photoMarkers[topIdx]))
                    { map.flyTo([photoMarkers[topIdx].lat, photoMarkers[topIdx].lon], 11, { duration: 1.5 }); }
                else
                    { window.syncToFirstVisible(); }
            }
        }, 300); // Give CSS time to render the div
    } else {
        if (isPeaks) renderPeaksGrid();
        else renderPortal();
        if (selectedTourIdx !== null) {
            restorePortalCard(selectedTourIdx);
        }
    }
}

function parseCsv(text) {
    const rows = [];
    let row = [], value = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"' && quoted && text[i + 1] === '"') {
            value += '"';
            i++;
        } else if (char === '"') {
            quoted = !quoted;
        } else if (char === ',' && !quoted) {
            row.push(value); value = '';
        } else if ((char === '\n' || char === '\r') && !quoted) {
            if (char === '\r' && text[i + 1] === '\n') i++;
            row.push(value); value = '';
            if (row.some(cell => cell.trim())) rows.push(row);
            row = [];
        } else {
            value += char;
        }
    }
    if (value.length || row.length) {
        row.push(value);
        if (row.some(cell => cell.trim())) rows.push(row);
    }
    return rows;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
}

function peakField(record, ...names) {
    for (const name of names) {
        const value = record[name];
        if (value !== undefined && value !== '') return value;
    }
    return '';
}

async function loadPeakData(forceRefresh = false) {
    if (peaksLoaded && !forceRefresh) return peakRecords;
    if (peakLoadPromise) return peakLoadPromise;
    peakLoadPromise = (async () => {
        try {
            if (!SHEETS_CSV_PEAK_URL) await loadConfig();
            if (!SHEETS_CSV_PEAK_URL) throw new Error('Peaks CSV URL is not configured');
            const separator = SHEETS_CSV_PEAK_URL.includes('?') ? '&' : '?';
            const response = await fetch(`${SHEETS_CSV_PEAK_URL}${separator}t=${Date.now()}`);
            if (!response.ok) throw new Error(`Peaks CSV request failed (${response.status})`);
            const csvText = await response.text();
            if (/accounts\.google\.com|<html/i.test(csvText.slice(0, 500))) {
                throw new Error('Peaks sheet is not publicly published as CSV');
            }
            const rows = parseCsv(csvText);
            if (!rows.length) throw new Error('Peaks CSV is empty or has no header row');
            const headers = (rows.shift() || []).map(header => header.trim().toLowerCase().replace(/[\s-]+/g, '_'));
            const refreshedPeakRecords = rows.map((cells, rowIndex) => {
                const record = {};
                headers.forEach((header, index) => record[header] = (cells[index] || '').trim());
                record.sheet_row = rowIndex + 2;
                record.name = peakField(record, 'name', 'peak', 'peak_name', 'title', 'gipfel');
                record.massif = peakField(record, 'massif', 'massiv', 'range', 'gebirge', 'gebirgsgruppe');
                record.elevation = Number(String(peakField(record, 'elevation', 'height', 'elev', 'm', 'hoehe', 'höhe')).replace(',', '.')) || 0;
                record.first_visit = peakField(record, 'first_visit', 'date', 'firstvisit', 'erstbesteigung', 'first_visit_date', 'date_of_first_visit', 'datum1', 'datum_erstbesuch');
                record.additional_visit = peakField(record, 'additional_visit', 'visit2', 'second_visit', 'datum2');
                record.hint = peakField(record, 'hint', 'hinweis');
                const latitude = peakField(record, 'lat', 'latitude');
                const longitude = peakField(record, 'lon', 'lng', 'longitude');
                record.latRaw = latitude;
                record.lonRaw = longitude;
                record.lat = latitude === '' ? NaN : Number(String(latitude).replace(',', '.'));
                record.lon = longitude === '' ? NaN : Number(String(longitude).replace(',', '.'));
                record.remark = peakField(record, 'remark', 'remarks', 'comment', 'notes', 'bemerkung');
                return record;
            });
            if (!refreshedPeakRecords.length) throw new Error('Peaks CSV has no rows with a recognized name column');
            const isFirstPeakLoad = !peaksLoaded;
            peakMarkers.forEach(marker => {
                if (map && map.hasLayer(marker)) map.removeLayer(marker);
            });
            peakRecords = refreshedPeakRecords;
            peakMarkers = [];
            peaksLoaded = true;
            peakLoadFailed = false;
            if (isFirstPeakLoad) showPeaksOnMap = true;
            const peaksMapToggle = document.getElementById('show-peaks-map');
            if (peaksMapToggle) peaksMapToggle.checked = showPeaksOnMap;
            populateYearSidebar();
            renderPeaksGrid();
            renderPeakMarkers();
            return peakRecords;
        } catch (error) {
            console.error('Peaks load failed:', error);
            peakLoadFailed = true;
            renderPeaksGrid();
            return forceRefresh ? null : [];
        } finally {
            peakLoadPromise = null;
        }
    })();
    return peakLoadPromise;
}

function getPeakYear(record) {
    const match = String(record.first_visit || '').match(/\d{4}/);
    return match ? match[0] : '';
}

function isValidPeakCoordinate(value, minimum, maximum) {
    return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function hasValidPeakCoordinates(peak) {
    return isValidPeakCoordinate(peak.lat, -90, 90)
        && isValidPeakCoordinate(peak.lon, -180, 180);
}

function parsePeakDate(value) {
    const text = String(value || '').trim();
    let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
    match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (match) return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1])).getTime();
    const timestamp = Date.parse(text);
    return Number.isNaN(timestamp) ? NaN : timestamp;
}

function formatPeakDate(value) {
    const timestamp = parsePeakDate(value);
    if (Number.isNaN(timestamp)) return value || '';
    const date = new Date(timestamp);
    return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
}

window.togglePeakSortDirection = function() {
    const button = document.getElementById('peak-sort-direction');
    const descending = button.dataset.direction !== 'desc';
    button.dataset.direction = descending ? 'desc' : 'asc';
    button.textContent = descending ? 'Z→A' : 'A→Z';
    renderPeaksGrid();
};

function getFilteredPeaks() {
    return peakRecords.filter(record => {
        const year = getPeakYear(record);
        if (!filterPeaksByFilters) return true;
        const yearMatches = activeYear === 'All' || year === activeYear;
        return yearMatches && matchesTxtSearch({
            title: record.name,
            tags: record.massif,
            description: [record.first_visit, record.additional_visit, record.hint, record.remark].filter(Boolean).join(' ')
        }, activeTxtSearch);
    });
}

function getPeakFindText(peak) {
    return [peak.name, peak.m, peak.elevation, peak.massif, peak.first_visit, peak.additional_visit,
        peak.hint, peak.latRaw, peak.lonRaw, hasValidPeakCoordinates(peak) ? '' : 'ungültig koordinaten fehler invalid']
        .filter(Boolean).join(' ').toLocaleLowerCase();
}

function updatePeakFindMatches(moveToFirst = false) {
    const query = document.getElementById('peak-find-input')?.value.trim().toLocaleLowerCase() || '';
    const visiblePeaks = getFilteredPeaks();
    peakFindMatches = query ? visiblePeaks
        .filter(peak => getPeakFindText(peak).includes(query))
        .map(peak => peakRecords.indexOf(peak)) : [];
    if (peakFindMatches.length === 0) peakFindPosition = -1;
    else if (moveToFirst || peakFindPosition < 0 || peakFindPosition >= peakFindMatches.length) peakFindPosition = 0;
    updatePeakFindDisplay(moveToFirst);
}

function updatePeakFindDisplay(scrollToCurrent = false) {
    const count = document.getElementById('peak-find-count');
    const currentPeakIndex = peakFindMatches[peakFindPosition];
    if (count) count.textContent = peakFindMatches.length
        ? `${peakFindPosition + 1}/${peakFindMatches.length}`
        : '0/0';
    document.querySelectorAll('#peaks-grid tr[data-peak-index]').forEach(row => {
        const rowIndex = Number(row.dataset.peakIndex);
        row.classList.toggle('peak-find-match', peakFindMatches.includes(rowIndex));
        row.classList.toggle('peak-find-current', rowIndex === currentPeakIndex);
    });
    if (scrollToCurrent && currentPeakIndex !== undefined) {
        const row = document.querySelector(`#peaks-grid tr[data-peak-index="${currentPeakIndex}"]`);
        const view = document.getElementById('peaks-view');
        const toolbar = document.querySelector('.peaks-toolbar');
        if (row && view && toolbar) {
            const rowRect = row.getBoundingClientRect();
            const viewRect = view.getBoundingClientRect();
            const toolbarRect = toolbar.getBoundingClientRect();
            const visibleTop = Math.max(viewRect.top, toolbarRect.bottom) + 8;
            const visibleBottom = viewRect.bottom - 8;
            if (rowRect.top < visibleTop || rowRect.bottom > visibleBottom) {
                view.scrollBy({ top: rowRect.top - visibleTop, behavior: 'smooth' });
            }
        }
    }
}

window.searchPeaks = function() {
    peakFindPosition = 0;
    updatePeakFindMatches(true);
};

window.navigatePeakFind = function(direction) {
    if (peakFindMatches.length === 0) return;
    peakFindPosition = (peakFindPosition + direction + peakFindMatches.length) % peakFindMatches.length;
    updatePeakFindDisplay(true);
};

window.handlePeakFindKey = function(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        navigatePeakFind(event.shiftKey ? -1 : 1);
    }
};

document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closePhotoLightbox();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && getCurrentView() === 'peaks') {
        event.preventDefault();
        const input = document.getElementById('peak-find-input');
        input?.focus();
        input?.select();
    }
});

window.openPhotoLightbox = function(image) {
    const lightbox = document.getElementById('photo-lightbox');
    const enlargedImage = document.getElementById('photo-lightbox-image');
    if (!lightbox || !enlargedImage || !image?.src) return;

    enlargedImage.src = image.src;
    enlargedImage.alt = image.alt || '';
    lightbox.classList.remove('hidden');
};

window.closePhotoLightbox = function() {
    const lightbox = document.getElementById('photo-lightbox');
    const enlargedImage = document.getElementById('photo-lightbox-image');
    if (!lightbox || !enlargedImage) return;

    lightbox.classList.add('hidden');
    enlargedImage.removeAttribute('src');
};

window.handlePhotoLightboxBackdrop = function(event) {
    if (event.target === event.currentTarget) closePhotoLightbox();
};

function renderPeaksGrid() {
    const container = document.getElementById('peaks-grid');
    if (!container) return;
    if (!peaksLoaded) {
        container.innerHTML = peakLoadFailed
            ? '<p class="text-red-600">Could not load peaks. Check that the peaks tab is published as CSV and that its URL is correct.</p>'
            : '<p class="text-slate-500">Loading peaks…</p>';
        return;
    }
    const sortKey = document.getElementById('peak-sort')?.value || 'name';
    const descending = document.getElementById('peak-sort-direction')?.dataset.direction === 'desc';
    const records = getFilteredPeaks().sort((first, second) => {
        let comparison;
        if (sortKey === 'elevation') {
            comparison = first.elevation - second.elevation;
        } else if (sortKey === 'first_visit') {
            const firstDate = parsePeakDate(first.first_visit);
            const secondDate = parsePeakDate(second.first_visit);
            comparison = Number.isNaN(firstDate) ? (Number.isNaN(secondDate) ? 0 : 1)
                : Number.isNaN(secondDate) ? -1 : firstDate - secondDate;
        } else {
            comparison = String(first[sortKey] || '').localeCompare(String(second[sortKey] || ''), undefined, { sensitivity: 'base' });
        }
        if (!comparison) return first.sheet_row - second.sheet_row;
        return descending ? -comparison : comparison;
    });
    const count = document.getElementById('peaks-count');
    const invalidCoordinateCount = peakRecords.filter(peak => !hasValidPeakCoordinates(peak)).length;
    if (count) count.textContent = `${records.length} shown / ${peakRecords.length} loaded${invalidCoordinateCount ? ` · ${invalidCoordinateCount} Koordinatenfehler` : ''}`;
    container.innerHTML = `
        <div class="overflow-x-auto bg-white border border-slate-200">
            <table class="peaks-table">
                <thead><tr>
                    <th class="peak-row-number">Row</th><th>Gipfel</th><th class="peak-elevation">m</th><th>Gebirge</th><th>Datum1</th><th>Hinweis</th><th>Lat</th><th>Lon</th>
                </tr></thead>
                <tbody>${records.map((peak, index) => `
                        <tr data-peak-index="${peakRecords.indexOf(peak)}" class="${hasValidPeakCoordinates(peak) ? '' : 'peak-invalid-coordinates'}">
                        <td class="peak-row-number">${index + 1}</td>
                        <td>${peak.name ? `<button class="peak-name-button" onclick="focusPeak(${peakRecords.indexOf(peak)})">${escapeHtml(peak.name)}</button>` : '<span class="text-red-600">(blank)</span>'}</td>
                        <td class="peak-elevation">${escapeHtml(peak.m || peak.elevation || '')}</td>
                        <td>${escapeHtml(peak.massif)}</td>
                        <td class="peak-date">${escapeHtml(formatPeakDate(peak.first_visit))}</td>
                        <td>${escapeHtml(peak.hint)}</td>
                        <td class="${isValidPeakCoordinate(peak.lat, -90, 90) ? '' : 'peak-invalid-coordinate'}" title="${isValidPeakCoordinate(peak.lat, -90, 90) ? '' : 'Breitengrad muss zwischen -90 und 90 liegen'}">${escapeHtml(peak.latRaw)}${isValidPeakCoordinate(peak.lat, -90, 90) ? '' : ' ⚠'}</td>
                        <td class="${isValidPeakCoordinate(peak.lon, -180, 180) ? '' : 'peak-invalid-coordinate'}" title="${isValidPeakCoordinate(peak.lon, -180, 180) ? '' : 'Längengrad muss zwischen -180 und 180 liegen'}">${escapeHtml(peak.lonRaw)}${isValidPeakCoordinate(peak.lon, -180, 180) ? '' : ' ⚠'}</td>
                    </tr>
                `).join('')}</tbody>
            </table>
            ${records.length ? '' : '<p class="p-4 text-slate-500">No peaks match the current filters.</p>'}
        </div>`;
    updatePeakFindMatches();
}

window.togglePeakMap = async function(enabled) {
    showPeaksOnMap = enabled;
    if (enabled) await loadPeakData();
    renderPeakMarkers();
};

window.togglePeakFilters = function(enabled) {
    filterPeaksByFilters = enabled;
    renderPeaksGrid();
    renderPeakMarkers();
};

window.focusPeak = async function(index) {
    await loadPeakData();
    const peak = peakRecords[index];
    if (!peak || !hasValidPeakCoordinates(peak)) return;
    const year = getPeakYear(peak);
    if (filterPeaksByFilters && year && activeYear !== 'All' && activeYear !== year) window.updateActiveYear(year);
    showPeaksOnMap = true;
    const toggle = document.getElementById('show-peaks-map');
    if (toggle) toggle.checked = true;
    switchView('map');
    setTimeout(() => {
        renderPeakMarkers();
        map.flyTo([peak.lat, peak.lon], 12, { duration: 1.2 });
        const marker = peakMarkers[index];
        if (marker) marker.openPopup();
    }, 350);
};

function restorePortalCard(idx, attempt = 0) {
    const card = document.querySelector(`.portal-card[data-idx="${idx}"]`);
    if (card) {
        card.scrollIntoView({ block: 'start' });
        return;
    }

    if (attempt < 20) {
        requestAnimationFrame(() => restorePortalCard(idx, attempt + 1));
    }
}

/**
 * fire the Text-Search of the top-nav popup
 * But do not search immediately with each key-stroke
 * (check the typingTimer for the lag)
 */
function handleTxtSearch(val, isForced = false) {
    // 1. Clear any existing timer
    clearTimeout(typingTimer);

    // 2. If it's "Forced" (Enter key or Go button)
    if (isForced) {
        executeSearch(val,true); // close the keyboard, de-focus
        return;
    }

    // 3. Otherwise, set the "Live Search" timer
    typingTimer = setTimeout(() => {
        executeSearch(val,false); // do not hide the keyboard & de-focus
    }, doneTypingInterval);
}

/**
 * execute the Text-Search of the top-nav popup
 */
function executeSearch(val, shouldBlur) {
    activeTxtSearch = val;
    activeSearchMode = document.getElementById('regexSearchToggle')?.checked ? 'regex' : 'literal';
    updateTrackLoadControls();
    const urlParams = new URLSearchParams(window.location.search);
    const deepLinkKey = urlParams.has('re') ? 're' : 's';
    const deepLinkQuery = urlParams.get(deepLinkKey);
    if (deepLinkQuery !== null && (val !== deepLinkQuery || activeSearchMode !== (deepLinkKey === 're' ? 'regex' : 'literal'))) {
        urlParams.delete('s');
        urlParams.delete('re');
        urlParams.delete('view');
        const newUrl = `${window.location.pathname}${urlParams.toString() ? `?${urlParams}` : ''}${window.location.hash}`;
        window.history.replaceState({}, '', newUrl);
    }
        
    // Use the logic that matches your switchView method
    const isMapActive = document.getElementById('map-view').style.display === 'block';

    if (isMapActive) {
        renderMarkers();
    } else if (getCurrentView() === 'peaks') {
        renderPeaksGrid();
    } else {
        renderPortal();
    }

    
    // Only hide keyboard if user explicitly hit Enter/Go
    if (shouldBlur) {
        document.activeElement.blur();
    }
}

/**
 * Internal helper for general text search
 * Checks multiple fields and handles multiple words
 */
function matchesTxtSearch(p, searchStr) {
    if (!searchStr || searchStr.trim() === "") return true;

    const fields = [p.title, p.tags, p.description].map(value => value || "");
    if (activeSearchMode === 'regex') {
        try {
            const regex = new RegExp(searchStr, 'i');
            return fields.some(value => regex.test(value));
        } catch {
            return false;
        }
    }

    const searchText = searchStr.toLowerCase();
    return fields.some(value => value.toLowerCase().includes(searchText));
}

/**--------------------------------------------------------------
 * Updates the global year filter and refreshes all views
 * @param {string} yr - The selected year (e.g., '2024' or 'All')
 *-------------------------------------------------------------*/
window.updateActiveYear = function(yr) {
    activeYear = yr;
    updateTrackLoadControls();
    
    // Sync the Sidebar (Left)
    populateYearSidebar(); 
    
    // Update the Top Nav Label
    const isMapVisible = (document.getElementById('map-view').style.display === 'block');
    const label = document.getElementById('current-year-label');
    label.innerText = `${myTitle}: ${yr}`+ '\u200A'; // add a hairspace to prevent cut of last character
    
    // Refresh views
    if ( isMapVisible ) {
        renderMarkers();
    } else if (getCurrentView() === 'peaks') {
        renderPeaksGrid();
    } else {
        renderPortal(); 
    }
    
    // toggle Hamburger when window screen is small
    if (window.innerWidth <= 768) toggleSidebar();
};

/**-------------------------------------------------------------
 * Within the map view toggle the track button
 * @param url (track)
 * @param activityId (id of marker)
 *------------------------------------------------------------*/
window.toggleTrack = function(url, activityId) {
    if (window.currentTrackUrl === url) {
        // Already showing this one? Remove it.
        removeTrack(); 
    } else {
        // Show the new one
        loadTrack(url); 
    }
    
    // Tell all markers to update their buttons right now
    refreshAllMarkerPopups();
};

/**------------------------------------------------------------
 * refreshes the button state and regenerate popup-HTML 
 *-----------------------------------------------------------*/
function refreshAllMarkerPopups() {
    map.eachLayer((layer) => {
        if (layer instanceof L.Marker && layer.options.activityData) {
            const p = layer.options.activityData;
            const idx = layer._idx;
            
            // We need to re-generate the popup content string 
            const newContent = getPopupHTML(p, idx); 
            layer.setPopupContent(newContent);
        }
    });
}

/**------------------------------------------------------------
 * shows the optional .md (markdown) file
 *-----------------------------------------------------------*/
function openStory(reportUrl) {
    // Tell marked to treat single line breaks as real <br> tags
    marked.setOptions({
        breaks: true
    });

    fetch(reportUrl)
        .then(response => response.text())
        .then(markdownText => {
            document.getElementById('report-popup-content').innerHTML = marked.parse(markdownText);
            document.getElementById('report-popup').classList.remove('hidden');
        });
}

//------------------------------------------------------------------
// Helper to keep code DRY (Don't Repeat Yourself)
// Copy the HTML building logic from createMarker into this function
// the buttons and the image and the title and the activity
//------------------------------------------------------------------
function getPopupHTML(p, idx) {
    const activityKey = normalizeActivityKey(p.activity);
    const isKnown = Object.prototype.hasOwnProperty.call(ICONS_MAP, activityKey);
    const displayIcon = isKnown ? ICONS_MAP[activityKey] : '❓';
    
    // THE STATE CHECK: Is this track currently visible?
    const active = !!loadedTracks[idx]; 

    // Status helpers
    const hasAlbum = (p.album && p.album.startsWith('http'));
    const hasReport = (p.report && p.report.trim().length > 0);

    // Dynamischen Pfad für den Bericht via getAssetBase generieren
    const reportUrl = hasReport ? `${getAssetBase(p.year)}/${p.report.trim()}` : '';

    // --- DYNAMISCHER LINKER BUTTON (ALBUM UND/ODER BERICHT) ---
    let leftBtnHtml = '';

    if (hasAlbum && hasReport) {
        // Fall 1: BEIDES DA (Wir splitten den Platz für zwei schmale Buttons im Popup)
        leftBtnHtml = `
            <div class="flex-1 flex gap-1">
                <a href="${p.album}" target="_blank" class="flex-1 bg-sky-600 text-white no-underline text-[14px] font-bold rounded flex items-center justify-center p-1 py-[4px] leading-none" title="Album">📸</a>
                <button onclick="openStory('${reportUrl}')" class="flex-1 bg-amber-600 text-white text-[14px] font-bold rounded flex items-center justify-center p-1 py-[4px] leading-none" title="Story">📝</button>
            </div>`;
    } else if (hasAlbum) {
        // Fall 2: NUR ALBUM
        leftBtnHtml = `
            <a href="${p.album}" target="_blank" class="flex-1 bg-sky-600 text-white no-underline text-[10px] font-bold rounded flex items-center justify-center p-2 py-[4px] leading-none">
                <span class="text-[14px] mr-1">📸</span> Album
            </a>`;
    } else if (hasReport) {
        // Fall 3: NUR BERICHT
        leftBtnHtml = `
            <button onclick="openStory('${reportUrl}')" class="flex-1 bg-amber-600 text-white text-[10px] font-bold rounded flex items-center justify-center p-2 py-[4px] leading-none">
                <span class="text-[14px] mr-1">📝</span> Story
            </button>`;
    } else {
        // Fall 4: NICHTS DA (Ausgegrauter Platzhalter)
        leftBtnHtml = `
            <div class="flex-1 bg-gray-300 text-gray-500 text-[10px] font-bold rounded flex items-center justify-center p-2 py-[4px] leading-none cursor-not-allowed">
                <span class="text-[12px] mr-1">🚫</span> void
            </div>`;
    }

    // TRACK BUTTON LOGIC (Bleibt völlig unverändert)
    const hasTrack = (p.gpx && p.gpx.length > 5);
    let trackBtnClass, trackBtnText;
    
    if (!hasTrack) {
        trackBtnClass = 'bg-gray-300 cursor-not-allowed';
        trackBtnText = '<span class="text-[14px] mr-1">🚫</span> No Track';
    } else if (active) {
        trackBtnClass = 'bg-gray-500'; 
        trackBtnText = '<span class="text-[14px] mr-1">❌</span> Hide Track';
    } else {
        trackBtnClass = 'bg-emerald-700'; 
        trackBtnText = '<span class="text-[14px] mr-1">🗺️</span> Track';
    }

    const imgHtml = (p.img && p.img.length > 4)
        ? `<button type="button" class="photo-popup-image-button" onclick="openPhotoLightbox(this.querySelector('img'))" aria-label="Foto vergrößern">
                <img src="${getAssetBase(p.year)}/${p.img}" class="photo-popup-img" alt="${escapeHtml(p.title || '')}" onerror="this.closest('button').style.display='none'">
            </button>`
        : '';

    // DAS RETURN-TEMPLATE
    return `
        <div class="text-center" style="min-width: 180px;">
            ${imgHtml}
            <div class="popup-title" title="${p.title}">${p.title}</div>
            <div style="font-size: 9px; color: #666; margin-bottom: 8px;">
                <span class="use-noto" style="font-size: 14px;">${displayIcon}</span> ${isKnown ? activityKey : (p.activity || 'unknown')}
            </div>
            <div class="flex flex-row gap-2 justify-center">
                ${leftBtnHtml} 
                
                <button onclick="${hasTrack ? `loadGpxTrack(${idx})` : ''}" 
                        class="flex-1 p-2 py-[4px] ${trackBtnClass} text-white text-[10px] font-bold rounded flex items-center justify-center leading-none">
                    ${trackBtnText}
                </button>
            </div>
        </div>
    `;
}

/**-----------------------------------------------------------------
 * Populates the sidebar with years from the dataset
 *----------------------------------------------------------------*/
function populateYearSidebar() {
    const tourYears = photoMarkers.map(p => String(p.year || '')).filter(y => /^\d{4}$/.test(y));
    const peakYears = peakRecords.map(getPeakYear).filter(Boolean);
    const yrs = ['All', ...new Set([...tourYears, ...peakYears])].sort((a, b) => a === 'All' ? -1 : b === 'All' ? 1 : Number(b) - Number(a));
    const side = document.getElementById('sidebar-years');
    side.innerHTML = yrs.map(y => `
        <div class="year-btn ${y === activeYear ? 'active' : ''}" onclick="updateActiveYear('${y}')">
            ${y}
        </div>
    `).join('');
}

function hasTourCoordinates(tour) {
    if (!tour || tour.lat === '' || tour.lon === '' || tour.lat == null || tour.lon == null) return false;
    const lat = Number(tour.lat);
    const lon = Number(tour.lon);
    return Number.isFinite(lat) && lat >= -90 && lat <= 90
        && Number.isFinite(lon) && lon >= -180 && lon <= 180;
}

function hasTourTrack(tour) {
    return !!(tour?.gpx && tour.gpx.length > 5);
}

function canShowTourOnMap(tour) {
    if (hasTourCoordinates(tour) || hasTourTrack(tour)) return true;
    // Collection headers may omit coordinates when their child entries locate the trip.
    return !!(tour?.isCollectionHeader && tour.tripid && photoMarkers.some(sibling =>
        sibling.tripid === tour.tripid && (hasTourCoordinates(sibling) || hasTourTrack(sibling))
    ));
}

/**-----------------------------------------------------------------
 * create the HTML for a Portal Grid Cards
 *----------------------------------------------------------------*/
function createPortalCard(p, idx) {
    const activityKey = normalizeActivityKey(p.activity);
    const displayIcon = ICONS_MAP[activityKey] || '❓';
    
    // --- RESTORED metaHtml DEFINITION ---
    let metaHtml = `<span class="use-noto mr-1.5">${displayIcon}</span>`;
    if (p.tags && p.tags.trim().length > 0) {
        metaHtml += `<span class="text-gray-400 font-normal">${p.tags}</span>`;
    }
    
    // Status helpers
    const hasAlbum = p.album && p.album.startsWith('http');
    const hasReport = p.report && p.report.trim().length > 0; 
    const canShowOnMap = canShowTourOnMap(p);
    
    // --- DYNAMISCHER INHALTS-BLOCK (ALBUM UND/ODER BERICHT) ---
    let contentBlockHtml = '';
    
    // Dynamischen Pfad für den Bericht via getAssetBase generieren
    const reportUrl = hasReport ? `${getAssetBase(p.year)}/${p.report.trim()}` : '';
    
    if (hasAlbum && hasReport) {
        // Fall 1: BEIDES existiert (Button wird gesplittet)
        contentBlockHtml = `
            <div class="flex-1 flex gap-1">
                <a href="${p.album}" target="_blank" class="flex-1 py-2 bg-blue-50 text-blue-600 rounded-lg text-[9px] font-bold text-center flex items-center justify-center gap-0.5 no-underline">📸 Album</a>
                <button onclick="openStory('${reportUrl}')" class="flex-1 py-2 bg-amber-50 text-amber-600 rounded-lg text-[9px] font-bold text-center flex items-center justify-center gap-0.5">📝 Story</button>
            </div>`;
    } else if (hasAlbum) {
        // Fall 2: Nur Album existiert
        contentBlockHtml = `<a href="${p.album}" target="_blank" class="flex-1 py-2 bg-blue-50 text-blue-600 rounded-lg text-[10px] font-bold text-center no-underline">📖 Album</a>`;
    } else if (hasReport) {
        // Fall 3: Nur Bericht existiert
        contentBlockHtml = `<button onclick="openStory('${reportUrl}')" class="flex-1 py-2 bg-amber-50 text-amber-600 rounded-lg text-[10px] font-bold text-center">📝 Story</button>`;
    } else {
        // Fall 4: Gar nichts existiert
        contentBlockHtml = `<div class="flex-1 py-2 bg-gray-50 text-gray-400 rounded-lg text-[10px] font-bold text-center">🚫 NO CONTENT</div>`;
    }
    
    return `
        <div class="portal-card bg-white shadow-sm overflow-hidden flex flex-col h-full hover:shadow-md transition-all border border-gray-100" data-idx="${idx}">
            <div class="portal-img-container ${canShowOnMap ? 'cursor-pointer' : ''}" ${canShowOnMap ? `onclick="jumpToMap(${idx})"` : ''}>
                <img src="${getAssetBase(p.year)}/${p.img}" 
                    class="w-full h-full object-contain" loading="lazy" onerror="this.style.display='none'">
            </div>
            
            <div class="p-3 flex flex-col flex-grow">
                <h3 class="font-bold text-gray-900 leading-tight mb-1 text-sm line-clamp-2">${p.title}</h3>
                <div class="text-[11px] font-bold text-gray-500 truncate mb-4" title="${p.tags || ''}">
                    ${metaHtml}
                </div>

                <div class="mt-auto flex gap-2">
                    ${contentBlockHtml}
                    
                    <button onclick="${canShowOnMap ? `jumpToMap(${idx})` : ''}" 
                            class="flex-1 py-2 ${canShowOnMap ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-400 cursor-not-allowed'} rounded-lg text-[10px] font-bold">
                        ${canShowOnMap ? '🗺️ MAP' : '🚫 NO MAP'}
                    </button>
                </div>
            </div>
        </div>
    `;
}

let currentRenderId = 0; // Globaler Counter
/**--------------------------------------------------------------------
 * Renders the Portal Grid Cards: in batch mode
 *-------------------------------------------------------------------*/
function renderPortal() {
    const container = document.getElementById('portal-grid');
    if (!container) return;
    
    container.innerHTML = ''; 
    const targets = getFilteredTours('portal');

    // new renderId to avoid duplicate renderings
    const myRenderId = ++currentRenderId;

    let i = 0;
    function processBatch() {
        // PRÜFUNG: Wenn eine neuere Render-ID existiert, brich diesen Batch ab
        if (myRenderId !== currentRenderId) return;

        const end = Math.min(i + 12, targets.length);
        let htmlChunk = '';

        for (; i < end; i++) {
            // We call the detailed function above
            htmlChunk += createPortalCard(targets[i], photoMarkers.indexOf(targets[i]));
        }

        container.insertAdjacentHTML('beforeend', htmlChunk);

        if (i < targets.length) {
            requestAnimationFrame(processBatch);
        } else {
            renderPeakMarkers();
        }
    }
    processBatch();
}

/**
 * Transitions to map, ensures correct year filter, focuses on marker, and auto-loads track
 * @param {array of numbers} idx - Global indices in photoMarkers array
 * Opens a popup only when the selection resolves to one map marker. Multiple markers,
 * including tracks belonging to the same tripid, are shown without opening popups.
 */
function jumpToMap(indices) {
    const idxList = Array.isArray(indices) ? indices : [indices];
    if (idxList.length === 0) return;

    selectedTourIdx = idxList[0];

    // Close the previous tour popup before filters or marker rendering preserve it.
    if (map) {
        map.eachLayer(layer => {
            if (layer instanceof L.Marker) layer.closePopup();
        });
    }

    // 1. YEAR-SYNC (behalten wir bei)
    const years = [...new Set(idxList.map(i => photoMarkers[i]?.year?.toString()).filter(Boolean))];
    if (years.length > 0) {
        const targetYear = years.length === 1 ? years[0] : 'All';
        if (activeYear !== targetYear) window.updateActiveYear(targetYear);
    }

    switchView('map', false);

    setTimeout(() => {
        let finalMarkersToShow = [];
        let processedTrips = new Set();
        let trackIndices = [];

        // 2. ITERATION ÜBER ALLE ÜBERGEBENEN INDIZES
        idxList.forEach(i => {
            const p = photoMarkers[i];
            if (!p) return;

            // CHECK: Ist es ein Collection-Header?
            if (p.isCollectionHeader) {
                // Nur einmal verarbeiten, auch wenn derselbe Trip mehrfach ausgewählt wurde.
                if (!processedTrips.has(p.tripid)) {
                    processedTrips.add(p.tripid);
                    
                    // Alle Einträge dieses Trips finden
                    const albumSiblings = photoMarkers.filter(m => m.tripid === p.tripid);
                    
                    // Koordinaten-Marker zur Liste hinzufügen
                    albumSiblings.forEach(s => {
                        if (hasTourCoordinates(s)) finalMarkersToShow.push(s);
                        
                        // GPX-Track laden (falls vorhanden)
                        const sIdx = photoMarkers.indexOf(s);
                        if (hasTourTrack(s)) trackIndices.push(sIdx);
                        if (hasTourTrack(s) && !loadedTracks[sIdx]) {
                            loadGpxTrack(sIdx, false);
                        }
                    });
                }
            } 
            // ODER: Ist es ein normaler Marker mit Koordinaten?
            else if (hasTourCoordinates(p) || hasTourTrack(p)) {
                if (hasTourCoordinates(p)) finalMarkersToShow.push(p);
                if (hasTourTrack(p)) trackIndices.push(i);
                if (hasTourTrack(p) && !loadedTracks[i]) {
                    loadGpxTrack(i, false);
                }
            }
        });

        // 3. DARSTELLUNG: include loaded GPX bounds before fitting the map
        // Eindeutige Marker sicherstellen (falls ein Marker über Index UND Album kam)
        const uniqueMarkers = [...new Set(finalMarkersToShow)];
        const fitSelection = (attempt = 0) => {
            const tracksStillLoading = trackIndices.some(idx => !loadedTracks[idx]);
            if (tracksStillLoading && attempt < 50) {
                setTimeout(() => fitSelection(attempt + 1), 100);
                return;
            }

            const bounds = L.latLngBounds();
            uniqueMarkers.forEach(marker => bounds.extend([marker.lat, marker.lon]));
            trackIndices.forEach(idx => {
                const trackBounds = loadedTracks[idx]?.group?.getBounds();
                if (trackBounds?.isValid()) bounds.extend(trackBounds);
            });

            if (!bounds.isValid()) return;

            if (uniqueMarkers.length === 0 || uniqueMarkers.length > 1) {
                // Fit track-only trips and multi-point trips without opening a popup.
                map.flyToBounds(bounds, { padding: [80, 80], duration: 1.5 });
                return;
            }

            const p = uniqueMarkers[0];
            const originalIdx = photoMarkers.indexOf(p);
            // A single map marker opens its popup after the marker or its GPX track is in view.
            const openPopup = () => {
                let popupAttempts = 0;
                const tryOpen = () => {
                    const marker = allMarkers[originalIdx];
                    if (marker && map.hasLayer(marker)) {
                        marker.openPopup();
                    } else if (popupAttempts < 10) {
                        popupAttempts++;
                        setTimeout(tryOpen, 100);
                    }
                };
                tryOpen();
            };

            if (trackIndices.length > 0) {
                map.once('moveend', openPopup);
                map.flyToBounds(bounds, { padding: [80, 80], duration: 1.5 });
                return;
            }

            map.flyTo([p.lat, p.lon], 12, { duration: 1.5 });
            map.once('moveend', openPopup);
        };

        fitSelection();
    }, 400);
}

/* -------------------------------------------------------------------------
    * RELOAD DATA: Triggered by the button
    * ------------------------------------------------------------------------*/
window.reloadData = async function() {
    // 1. Get the status label from the bottom of your panel
    const status = document.getElementById('reload-status');
    if (status) {
        status.innerText = "LOADING...";
        status.style.color = "#f59e0b"; // Orange
    }

    // 2. Wipe the current map state
    // We remove the markers manually since we aren't using a cluster group yet
    currentMarkers.forEach(m => map.removeLayer(m));
    currentMarkers = [];
    
    // Clear the tracks using your existing function
    clearAllTracks();
    
    // Empty the data array
    photoMarkers = []; 

    // 3. Trigger the fetch and handle the result
    const refreshLoadedPeaks = peaksLoaded;
    const [toursSuccess, peakResult] = await Promise.all([
        fetchSheetData(),
        refreshLoadedPeaks ? loadPeakData(true) : Promise.resolve(true)
    ]);
    if (status) {
        const success = toursSuccess && peakResult !== null;
        status.innerText = success ? "DONE!" : "ERROR";
        status.style.color = success ? "#10b981" : "#ef4444";
        setTimeout(() => {
            status.innerText = "IDLE";
            status.style.color = "";
        }, 3000);
    }
};

/* -------------------------------------------------------------------------
    * SETUP the view to the first visible Marker. Spot at fixed ZOOM 11
    --------------------------------------------------------------------------*/
window.syncToFirstVisible = function() {
    // 1. Find the first marker that survives current Sidebar filters
    const currentSelection = photoMarkers.filter((p) => {
        const rawAct = normalizeActivityKey(p.activity);
        const activityKey = Object.prototype.hasOwnProperty.call(ICONS_MAP, rawAct) ? rawAct : 'unknown';
        const yearMatch = (activeYear === 'All' || String(p.year || '') === activeYear);
        const filterMatch = activeFilters[activityKey];
        return yearMatch && filterMatch;
    });

    if (currentSelection.length > 0) {
        const leader = currentSelection[0];
        const idx = photoMarkers.indexOf(leader);
        
        // 2. Center and Zoom (using your preferred zoom 11)
        map.flyTo([leader.lat, leader.lon], 11, { duration: 1.5 });

        // 3. Open the popup
        if (allMarkers[idx]) {
            setTimeout(() => allMarkers[idx].openPopup(), 1600);
        }
    }
};

/* -------------------------------------------------------------------------
    * RESIZE EVENT Fix for map not filling the screen on rotation/resize.
    --------------------------------------------------------------------------*/
window.addEventListener('resize', function() {
    // Wait 200ms for the rotation animation to finish
    setTimeout(function() {
        if (map) {
            console.log("Fixing map size...");
            map.invalidateSize();
        }
    }, 200);
});

/* -------------------------------------------------------------------------
    * SETUP EVENTS assigns the handlefunctions to the defined events.
    --------------------------------------------------------------------------*/
function setupEvents() {
    const allActivitiesToggle = document.getElementById('allActivitiesToggle');
    allActivitiesToggle?.addEventListener('change', () => {
        Object.keys(activeFilters).forEach(key => activeFilters[key] = allActivitiesToggle.checked);
        syncActivityFilterControls();
        updateTrackLoadControls();
        executeSearch(activeTxtSearch, false);
    });

    document.querySelectorAll('[data-activity]').forEach(btn => {
        btn.onclick = () => {
            setActivityFilter(btn.dataset.activity);
            syncActivityFilterControls();
            updateTrackLoadControls();
            executeSearch(activeTxtSearch, false);
        };
    });
    syncActivityFilterControls();
    updateTrackLoadControls();
}

function setActivityFilter(activityKey) {
    if (ACTIVITY_FILTER_KEYS.every(key => activeFilters[key])) {
        Object.keys(activeFilters).forEach(key => activeFilters[key] = false);
        activeFilters[activityKey] = true;
        return;
    }

    activeFilters[activityKey] = !activeFilters[activityKey];
    if (ACTIVITY_FILTER_KEYS.every(key => activeFilters[key])) activeFilters.unknown = true;
}

function syncActivityFilterControls() {
    document.querySelectorAll('[data-activity]').forEach(btn => {
        btn.classList.toggle('filter-button-active', !!activeFilters[btn.dataset.activity]);
    });
    const allActivitiesToggle = document.getElementById('allActivitiesToggle');
    if (allActivitiesToggle) {
        allActivitiesToggle.checked = ACTIVITY_FILTER_KEYS.every(key => activeFilters[key]);
    }
}

function setupCoordinatePicker() {
    map.on('click', event => {
        if (coordinatePickMode || event.originalEvent?.altKey) {
            L.DomEvent.stop(event.originalEvent);
            copyMapCoordinates(event.latlng);
        } else if (coordinateSelectionMarker) {
            clearCoordinatePin();
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Alt' && getCurrentView() === 'map') {
            map.getContainer().classList.add('coordinate-alt-pick-mode');
        }
    });
    document.addEventListener('keyup', event => {
        if (event.key === 'Alt') map.getContainer().classList.remove('coordinate-alt-pick-mode');
    });
    window.addEventListener('blur', () => map.getContainer().classList.remove('coordinate-alt-pick-mode'));
}

async function copyMapCoordinates(latlng) {
    const latitude = latlng.lat.toFixed(6);
    const longitude = latlng.lng.toFixed(6);
    const coordinateText = `${latitude}\t${longitude}`;
    const status = document.getElementById('coordinate-copy-status');

    if (coordinateSelectionMarker) map.removeLayer(coordinateSelectionMarker);
    const pinIcon = L.divIcon({
        className: 'peak-marker-icon coordinate-pin-icon',
        html: '<span class="peak-map-pin"><span class="peak-pin-head"></span><span class="peak-pin-needle"></span></span>',
        iconSize: [18, 25],
        iconAnchor: [9, 24]
    });
    coordinateSelectionMarker = L.marker(latlng, {
        icon: pinIcon,
        zIndexOffset: 2000,
        keyboard: false,
        bubblingMouseEvents: false,
        title: `Ausgewählte Koordinate ${latitude}, ${longitude}`
    }).addTo(map).bindTooltip(`${latitude}, ${longitude}`, {
        permanent: true,
        direction: 'top',
        offset: [0, -20],
        className: 'coordinate-pin-label'
    });
    updateCoordinatePickButton();

    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(coordinateText);
        } else {
            const temporaryInput = document.createElement('textarea');
            temporaryInput.value = coordinateText;
            temporaryInput.style.position = 'fixed';
            temporaryInput.style.opacity = '0';
            document.body.appendChild(temporaryInput);
            temporaryInput.select();
            const copied = document.execCommand('copy');
            temporaryInput.remove();
            if (!copied) throw new Error('Clipboard copy was denied');
        }
        lastCopiedCoordinates = `${latitude}, ${longitude}`;
        updateCoordinatePickButton();
        updateCoordinateCopyStatus();
    } catch (error) {
        console.error('Coordinate copy failed:', error);
        if (status) status.textContent = 'Clipboard-Zugriff nicht verfügbar';
    }
}

window.clearCoordinatePin = function(updateStatus = true) {
    if (!coordinateSelectionMarker) return;
    map.removeLayer(coordinateSelectionMarker);
    coordinateSelectionMarker = null;
    updateCoordinatePickButton();
    if (updateStatus) updateCoordinateCopyStatus('Marker gelöscht.');
};

window.toggleCoordinatePickMode = function() {
    if (coordinateSelectionMarker) {
        coordinatePickMode = false;
        clearCoordinatePin();
    } else {
        coordinatePickMode = true;
        updateCoordinatePickButton();
    }
    const mapContainer = map?.getContainer();
    mapContainer?.classList.toggle('coordinate-pick-mode', coordinatePickMode);
    updateCoordinateCopyStatus();
};

function updateCoordinatePickButton() {
    const button = document.getElementById('coordinate-pick-mode');
    if (button) {
        const hasMarker = !!coordinateSelectionMarker;
        button.textContent = hasMarker ? '✕ Marker löschen' : '📍 Marker setzen';
        button.title = lastCopiedCoordinates
            ? `Clipboard enthält: ${lastCopiedCoordinates}`
            : 'Koordinatenmarker setzen';
        button.setAttribute('aria-pressed', String(coordinatePickMode || hasMarker));
        button.classList.toggle('filter-button-active', coordinatePickMode || hasMarker);
    }
}

function updateCoordinateCopyStatus(fallbackMessage) {
    const status = document.getElementById('coordinate-copy-status');
    if (!status) return;
    if (lastCopiedCoordinates) {
        status.textContent = `📋 Kopiert: ${lastCopiedCoordinates}`;
    } else if (fallbackMessage) {
        status.textContent = fallbackMessage;
    } else {
        status.textContent = coordinatePickMode
            ? 'Tippen, um Lat und Lon zu kopieren.'
            : 'Alt + Linksklick kopiert Lat und Lon.';
    }
}

/* -------------------------------------------------------------------------
    * LOAD GPX TRACK toggles tracks on and off. Optionally flying to bounds
    --------------------------------------------------------------------------*/
window.loadGpxTrack = function(idx, shouldZoom = true) {
    const p = photoMarkers[idx];
    const url = `${getAssetBase(p.year)}/${p.gpx}`;
    const rawAct = p.activity?.toLowerCase().trim();
    const color = COLORS[normalizeActivityKey(rawAct)] || COLORS['unknown'];

    // 1. Toggle-Logik
    if (loadedTracks[idx]) {
        map.removeLayer(loadedTracks[idx].group);
        delete loadedTracks[idx];
        refreshAllMarkerPopups();
        renderMarkers();
        return;
    }

    // 2. Gruppe erstellen
    const trackGroup = L.featureGroup().addTo(map);

    // 3. GPX Layer laden
    const trackLayer = new L.GPX(url, {
        async: true,
        marker_options: { startIconUrl: '', endIconUrl: '' },
        polyline_options: { 
            color: color, 
            weight: 5, 
            opacity: 0.9, 
            lineJoin: 'round',
            interactive: false // Verhindert, dass die Linie Klicks schluckt
        }
    }).on('loaded', e => {
        // Rekursive Funktion für alle Unter-Ebenen (wichtig für mehrere <trk>)
        const addDirectionalArrows = (l) => {
            if (l instanceof L.Polyline) {
                // Wir erstellen keine dashLine mehr, sondern nutzen nur den Decorator
               const arrows = L.polylineDecorator(l, {
                    patterns: [
                        {
                            repeat: 30,     // Alle <repeat> Pixel ein Pfeil (kleinerer Wert = mehr Pfeile)
                            symbol: L.Symbol.arrowHead({
                                pixelSize: 3.9, 
                                polygon: false,
                                pathOptions: { 
                                    color: '#FFFFFF', 
                                    weight: 1.8, 
                                    fillOpacity: 1,
                                    opacity: 1,
                                    interactive: false // click 
                                }
                            })
                        }
                    ]
                });
                
                trackGroup.addLayer(arrows);
                
                // Optional: Den Decorator ganz nach hinten schieben, 
                // damit Marker immer oben liegen
                arrows.bringToBack(); 
                
            } else if (l.eachLayer) {
                l.eachLayer(addDirectionalArrows);
            }
        };
        /*****
        const addDashes = (l) => {
            if (l instanceof L.Polyline) {
                let dashPattern = normalizeActivityKey(p.activity) === 'ski' ? '2, 12' :
                                 (['hike', 'climb', 'scramble', 'alpine'].includes(normalizeActivityKey(p.activity)) ? '10, 10' : '20, 5');
                
                // Weiße Dash-Linie erstellen
                const dashLine = L.polyline(l.getLatLngs(), { 
                    color: '#FFFFFF', 
                    weight: 2, 
                    opacity: 0.8, 
                    dashArray: dashPattern, 
                    lineCap: 'round', 
                    interactive: false 
                });
                
                trackGroup.addLayer(dashLine);
                // Sicherstellen, dass der farbige Track und der Dash HINTER dem Marker liegen
                dashLine.bringToBack();
            } else if (l.eachLayer) {
                l.eachLayer(addDashes);
            }
        };

        addDashes(e.target);
        *****/
       addDirectionalArrows(e.target);
        
        // Den gesamten GPX-Layer nach hinten schieben
        e.target.bringToBack();

        const trackBounds = e.target.getBounds();
        if (trackBounds.isValid()) {
            const labelLocation = hasTourCoordinates(p) ? [p.lat, p.lon] : trackBounds.getCenter();
            const label = L.tooltip({
                permanent: true,
                direction: 'right',
                offset: [15, 0],
                className: 'track-label'
            }).setContent(p.title).setLatLng(labelLocation);
            trackGroup.addLayer(label);
        }

        if (shouldZoom) {
            if (trackBounds.isValid()) map.flyToBounds(trackBounds, { padding: [50, 50] });
        }
        
        loadedTracks[idx] = { group: trackGroup, filename: p.gpx, layer: e.target };
        refreshAllMarkerPopups();
        renderMarkers();
    });

    trackGroup.addLayer(trackLayer);

    return trackLayer; // for showAllTracks()
};

/* -------------------------------------------------------------------------
    * GET FILTERED TOURS filter the photoMarkers
    * extracted from rendering. alows deviding loading into ad hoc and batch. 
    --------------------------------------------------------------------------*/
function getFilteredTours(targetView = 'map') {
    // Standard Filter logic
    let filtered = photoMarkers.filter(p => {
        const pYear = String(p.year || '');
        const yearMatch = (activeYear === 'All' || pYear === activeYear);
        const searchMatch = matchesTxtSearch(p, activeTxtSearch)
            || (targetView === 'portal' && p.isCollectionHeader && p.tripid
                && photoMarkers.some(sibling =>
                    sibling.tripid === p.tripid && matchesTxtSearch(sibling, activeTxtSearch)
                ));
        const rawAct = normalizeActivityKey(p.activity);
        const activityKey = ICONS_MAP[rawAct] ? rawAct : 'unknown';
        const filterMatch = activeFilters[activityKey];
        
        return yearMatch && searchMatch && filterMatch;
    });

    if (targetView === 'map') {
        // Only return rows that have coordinates for the map markers
        return filtered.filter(hasTourCoordinates);
    }

    // now targetView !==  'map' PORTAL LOGIC: Hide childs of collection
    return filtered.filter(p => {
        // discarded => If no album is provided, always show the card
        //if (!p.album || p.album === "" || p.album === "#") return true;
        
        // filter childs of collection
        return !p.tripid || p.isCollectionHeader;
    });
}

/**
 * Creates a single Leaflet marker with a custom emoji icon and popup.
 * @param {Object} p - The tour data object from photoMarkers.
 * @param {number} idx - The global index in the photoMarkers array.
 * @returns {L.Marker} - The configured Leaflet marker.
 */
function createMarker(p, idx) {
    // Determine Activity and Icon
    const rawAct = normalizeActivityKey(p.activity);
    const activityKey = Object.prototype.hasOwnProperty.call(ICONS_MAP, rawAct) ? rawAct : 'unknown';
    const displayIcon = ICONS_MAP[activityKey] || '❓'; // ? for unknown actitvityKey 

    // Build the Icon (using your divIcon logic)
    const icon = L.divIcon({
        className: `emoji-marker-outer marker-${activityKey.replace('+', '-')}`,
        html: `<span class="emoji-marker-inner">${displayIcon}</span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14] // half of iconSize for exact centering
    });

    // Create and Bind the Marker
    const m = L.marker([p.lat, p.lon], { 
        icon: icon, 
        zIndexOffset: 1000,
        activityData: p // anchor for refresh
    }).on('click', () => {
        selectedTourIdx = idx;
    })
    .bindPopup(getPopupHTML(p, idx), {
        minWidth: 200,
        maxWidth: 200,
        closeButton: false,
        className: 'custom-tour-popup'
    })
    .bindTooltip(p.title, { 
        direction: 'top', 
        offset: [0, -15],
        opacity: 0.9,
        className: 'hover-title' 
    });

    // Attach the index directly to the marker object so we can find it later
    m._idx = idx;

    return m;
}

/* -------------------------------------------------------------------------
 * HANDLE DEEP LINK extracts and applies the logic of parameterized search
 * Handles links like: ?s=<literal>&view=map|portal or ?re=<regex>&view=map|portal
 --------------------------------------------------------------------------*/
// Am Ende deiner Initialisierung in app.js
function handleDeepLink() {
    const urlParams = new URLSearchParams(window.location.search);
    const regexQuery = urlParams.get('re');
    const literalQuery = urlParams.get('s');
    const query = regexQuery ?? literalQuery;
    const requestedView = urlParams.get('view');
    const deepLinkView = requestedView === 'portal' ? 'portal' : 'map';
    console.log("handleDeepLink::urlParams.get():", query);
    if (!query) return false; // no deepLink-query

    activeSearchMode = regexQuery !== null ? 'regex' : 'literal';
    const searchInput = document.getElementById('txtSearchInput');
    const regexToggle = document.getElementById('regexSearchToggle');
    if (searchInput) searchInput.value = query;
    if (regexToggle) regexToggle.checked = activeSearchMode === 'regex';

    // Search (Modular Filter)
    const matches = photoMarkers.filter(p => matchesTxtSearch(p, query));

    if (matches.length === 1) {
        activeTxtSearch = query;
        showDeepLinkSearch(query);
        const targetIdx = photoMarkers.indexOf(matches[0]);
        showDeepLinkMatch(targetIdx, deepLinkView);
        toggleSidebar('close'); // ensure sidebar is closed
        return true; // link found
    }

    console.log("handleDeepLink::matches.length:", matches.length);
    if ( matches.length > 1) {
        activeTxtSearch = query;
        showDeepLinkSearch(query);
        // Pass all results together; jumpToMap keeps popups closed for multiple map markers.
        const targetIndices = matches.map(m => photoMarkers.indexOf(m));
        showDeepLinkMatch(targetIndices, deepLinkView);
        toggleSidebar('close');
        return true; // link found
    }

    return false; // no match for link
}

/* -------------------------------------------------------------------------
 * Paste the content of s=<search pattern> of a deepLink into the 
 * search box and make it visible.
 * -----------------------------------------------------------------------*/
function showDeepLinkSearch(query) {
    const toolbar = document.getElementById('txtSearchToolbar');
    const searchInput = document.getElementById('txtSearchInput');
    toolbar?.classList.remove('hidden');
    if (searchInput) searchInput.value = query;
}

/* -------------------------------------------------------------------------
 * Show the matched results in the appropriate view (portal|map)
 * -----------------------------------------------------------------------*/
function showDeepLinkMatch(indices, view) {
    if (view === 'map') {
        jumpToMap(indices);
        return;
    }

    const idxList = Array.isArray(indices) ? indices : [indices];
    const years = [...new Set(idxList.map(i => photoMarkers[i]?.year?.toString()).filter(Boolean))];
    if (years.length === 1 && activeYear !== years[0]) {
        window.updateActiveYear(years[0]);
    } else {
        switchView('portal');
    }

    setTimeout(() => {
        const firstCard = document.querySelector(`.portal-card[data-idx="${idxList[0]}"]`);
        firstCard?.scrollIntoView({ block: 'start' });
    }, 0);
}

/* -------------------------------------------------------------------------
    * APPLY power-search clear button
    --------------------------------------------------------------------------*/
window.clearPowerSearch = function() {
    const searchBox = document.getElementById('power-search');
    if (searchBox) searchBox.value = "";
    
    // Wipe any tracks from a previous search
    clearAllTracks(); 
    
    // Clear the URL junk
    const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
    window.history.pushState({path:newUrl}, '', newUrl);

    // Sync back to the first visible marker in the current sidebar view
    syncToFirstVisible();
};

function loadTracksBatch(ignoreFilters) {
    let runningBounds = L.latLngBounds();
    let processedCount = 0;
    const tracksToProcess = photoMarkers.filter((p) => {
        const rawAct = normalizeActivityKey(p.activity);
        const activityKey = Object.prototype.hasOwnProperty.call(ICONS_MAP, rawAct) ? rawAct : 'unknown';
        const yearMatch = (activeYear === 'All' || String(p.year || '') === activeYear);
        const filterMatch = activeFilters[activityKey];
        const searchMatch = matchesTxtSearch(p, activeTxtSearch);
        return (ignoreFilters || (yearMatch && filterMatch && searchMatch)) && p.gpx && p.gpx.length > 5;
    });

    if (tracksToProcess.length === 0) return;

    const finalizeMasterView = () => {
        processedCount++;
        if (processedCount === tracksToProcess.length && runningBounds.isValid()) {
            map.flyToBounds(runningBounds, { padding: [50, 50], duration: 1.5 });
        }
    };

    tracksToProcess.forEach((p) => {
        const idx = photoMarkers.indexOf(p);
        
        if (loadedTracks[idx]) {
            const b = loadedTracks[idx].group.getBounds();
            if (b.isValid()) runningBounds.extend(b);
            finalizeMasterView();
        } else {
            const track = loadGpxTrack(idx, false); 
            
            if (track) {
                track.on('loaded', e => {
                    // Now we know it's safe to grab the bounds
                    const gb = e.target.getBounds();
                    if (gb.isValid()) {
                        runningBounds.extend(gb);
                    }
                    finalizeMasterView();
                });
                track.on('error', () => finalizeMasterView());
            } else {
                finalizeMasterView();
            }
        }
    });
}

function hasActiveTrackFilters() {
    return activeYear !== 'All'
        || Object.values(activeFilters).some(isActive => !isActive)
        || activeTxtSearch.trim() !== '';
}

function updateTrackLoadControls() {
    const button = document.getElementById('load-filtered-tracks-btn');
    const status = document.getElementById('track-filter-status');
    if (!button || !status) return;
    const filtersActive = hasActiveTrackFilters();
    button.disabled = !filtersActive;
    button.classList.toggle('opacity-50', !filtersActive);
    button.classList.toggle('cursor-not-allowed', !filtersActive);
    status.textContent = filtersActive ? 'Filter aktiv' : 'Keine Filter aktiv';
}

window.showFilteredTracks = function() {
    if (!hasActiveTrackFilters()) return;
    loadTracksBatch(false);
};

window.showAllTracks = function() {
    if (!window.confirm('Alle Tracks über alle Jahre und Aktivitäten laden? Dabei werden möglicherweise viele GPX-Dateien heruntergeladen.')) return;
    loadTracksBatch(true);
};

/* -------------------------------------------------------------------------
    * CLEAR ALL TRACKS that are visible
    * Function triggered by gear wheel button!
    --------------------------------------------------------------------------*/	
window.clearAllTracks = function() {
    // Loop through all currently active track groups
    Object.keys(loadedTracks).forEach(idx => {
        // Use .group because that's where we stored the LayerGroup
        if (loadedTracks[idx] && loadedTracks[idx].group) {
            map.removeLayer(loadedTracks[idx].group);
        }
    });
    // Reset the tracking object so the map "forgets" what was loaded
    loadedTracks = {};
    // Refresh the UI/Markers
    refreshAllMarkerPopups();
    renderMarkers();
};

/* -------------------------------------------------------------------------
    * RENDER MARKERS on the map
    * Function drows the activity markers on the map and handles the popUp
    --------------------------------------------------------------------------*/	
function renderMarkers() {
    let openId = null;

    // 1. Get the list of what SHOULD be visible
    const targets = getFilteredTours('map');
    
    // Create a Set of indices for fast lookups
    const targetIndices = new Set(targets.map(p => photoMarkers.indexOf(p)));

    // 2. HIDE markers that are currently out of filter range
    // We don't delete them, we just take them off the map
    currentMarkers.forEach(m => {
        if (m.getPopup().isOpen()) openId = m._idx;
        if (!targetIndices.has(m._idx)) {
            map.removeLayer(m);
        }
    });

    // 3. Update currentMarkers to only include what's still on the map
    currentMarkers = currentMarkers.filter(m => targetIndices.has(m._idx));

    // 4. ADD/SHOW the missing markers in batches
    let i = 0;
    function processBatch() {
        const end = Math.min(i + 30, targets.length);
        
        for (; i < end; i++) {
            const p = targets[i];
            const idx = photoMarkers.indexOf(p);
            
            // DECISION: If it's already in currentMarkers, skip it (it's already on the map)
            if (currentMarkers.some(m => m._idx === idx)) continue;

            // DECISION: If we've never built it before, build it now
            if (!allMarkers[idx]) {
                allMarkers[idx] = createMarker(p, idx);
            }

            // Put the pre-built marker on the map
            allMarkers[idx].addTo(map);
            currentMarkers.push(allMarkers[idx]);

            if (openId === idx) allMarkers[idx].openPopup();
        }

        if (i < targets.length) {
            requestAnimationFrame(processBatch);
        }
    }
    processBatch();
}

function renderPeakMarkers() {
    if (!map) return;
    for (let index = 0; index < peakRecords.length; index++) {
        const peak = peakRecords[index];
        let marker = peakMarkers[index];
        const year = getPeakYear(peak || {});
        const peakFiltersMatch = !filterPeaksByFilters || (
            (activeYear === 'All' || year === activeYear)
            && matchesTxtSearch({ title: peak?.name, tags: peak?.massif, description: [peak?.first_visit, peak?.additional_visit, peak?.hint, peak?.remark].filter(Boolean).join(' ') }, activeTxtSearch)
        );
        const shouldShow = showPeaksOnMap && peak && hasValidPeakCoordinates(peak)
            && peakFiltersMatch;
        if (!shouldShow) {
            if (marker && map.hasLayer(marker)) map.removeLayer(marker);
            continue;
        }
        if (!marker) {
            const icon = L.divIcon({
                className: 'peak-marker-icon',
                html: '<span class="peak-map-pin"><span class="peak-pin-head"></span><span class="peak-pin-needle"></span></span>',
                iconSize: [18, 25],
                iconAnchor: [9, 24]
            });
            peakMarkers[index] = L.marker([peak.lat, peak.lon], { icon, zIndexOffset: 1200 })
                .bindPopup(`<div class="text-center"><strong>${escapeHtml(peak.name)}</strong><div>${escapeHtml(peak.massif)}</div><div>${peak.elevation || ''} m · ${escapeHtml(peak.first_visit)}</div>${peak.additional_visit ? `<div>Additional visit: ${escapeHtml(peak.additional_visit)}</div>` : ''}${peak.hint ? `<p>${escapeHtml(peak.hint)}</p>` : ''}${peak.remark ? `<p>${escapeHtml(peak.remark)}</p>` : ''}</div>`)
                .bindTooltip(peak.name, { direction: 'top', offset: [0, -15], opacity: 0.9, className: 'hover-title' });
            marker = peakMarkers[index];
        }
        if (!map.hasLayer(marker)) marker.addTo(map);
    }
}

//-----------------------------------------
// MAIN: START EVERYTHING
//-----------------------------------------
// MAIN: START EVERYTHING
loadConfig()
.then(() => fetchSheetData())
.then(() => {
    const foundSomething = handleDeepLink(); 
    
    if (!foundSomething) {
        console.log("no DeepLink or nothing found via DeepLink!");
        // force Portal only if nothing found by deepLink
        switchView('portal');
    } else {
        console.log("Deep-Link successful!");
    }
});