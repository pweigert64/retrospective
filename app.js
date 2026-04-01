const myTitle = document.title;
document.getElementById('current-year-label').textContent = myTitle;

const COLORS = { 
    'ski': '#4f46e5', 'hike': '#b54708', 'climb': '#dc2626', 
    'bike': '#065f46', 'bike+hike': '#f97316', 'trip': '#9333ea', 'unknown': '#6b7280' 
};
const ICONS_MAP = { 
    'ski': '❄️', 'piste': '🚠', 'hike': '🥾', 'climb': '⛰️', 'rope': '🧗', 'bike': '🚴', 'bike+hike': '🚵', 'trip': '🏛️' 
};

let map, overviewLayer, detailLayer, hikingLayer, cyclingLayer;
let photoMarkers = [], currentMarkers = [], allMarkers = [], loadedTracks = {}; 
let activeFilters = { ski: true, piste: true, hike: true, climb: true, rope: true, bike: true, 'bike+hike': true, trip: true, unknown: true };
let activeTxtSearch = '';
let activeYear = 'All', isInitialLoad = true, switchThreshold = 16; 
let MAPTILER_KEY, SHEETS_CSV_URL;
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

/* -------------------------------------------------------------------------
 * TOGGLE Sidebar (Hamburger Menu)
 * -----------------------------------------------------------------------*/
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    
    sidebar.classList.toggle('open');
    
    // Show or hide the dark overlay
    if (sidebar.classList.contains('open')) {
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
    }
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
 * ------------------------------------------------------------------------*/
async function loadConfig() {
    const response = await fetch(`./config.js?t=${new Date().getTime()}`);
    if (!response.ok) throw new Error("Could not find config.js");
    const text = await response.text();
    const keyMatch = text.match(/MAPTILER_KEY\s*=\s*['"]([^'"]+)['"]/);
    const urlMatch = text.match(/SHEETS_CSV_URL\s*=\s*['"]([^'"]+)['"]/);
    const assetBaseMatch = text.match(/ASSETBASE_URL\s*=\s*['"]([^'"]+)['"]/);
    if (keyMatch && urlMatch && assetBaseMatch) {
        MAPTILER_KEY = keyMatch[1];
        SHEETS_CSV_URL = urlMatch[1];
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

        // Clean up "undefined" strings in the data immediately after loading
        photoMarkers = photoMarkers.map(p => {
            for (let key in p) {
                if (p[key] === "undefined" || p[key] === undefined) p[key] = "";
            }
            return p;
        });
        
        // FIXED: Initial Year Detection
        const yearsInData = [...new Set(photoMarkers.map(p => p.year.toString()))]
                            .filter(y => y && y.length === 4)
                            .sort((a, b) => b - a);
        
        if (isInitialLoad) {
            const urlParams = new URLSearchParams(window.location.search);
            const hasDeepLink = urlParams.has('s') || urlParams.has('title'); // Prüft beide Varianten

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
 * INIT MAP define layers, place the appropriate map (overview or detail).
 * ------------------------------------------------------------------------*/
function initMap() {
    // Start at a generic point 
    // because we will immediately 'fly' to the right spot in the next step.
    const startPos = [48.18, 14.17]; // Linz/Donau
    map = L.map('map', { center: startPos, zoom: 11, zoomControl: false });
    
    overviewLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17 }).addTo(map);
    detailLayer = L.tileLayer(`https://api.maptiler.com/maps/outdoor-v4/{z}/{x}/{y}@2x.png?key=${MAPTILER_KEY}`, { tileSize: 512, zoomOffset: -1, maxZoom: 19 });
    
    hikingLayer = L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png');
    cyclingLayer = L.tileLayer('https://tile.waymarkedtrails.org/mtb/{z}/{x}/{y}.png');

    map.on('zoomend', () => {
        const currentZoom = map.getZoom();
        document.getElementById('zoom-level-display').innerText = currentZoom;
        if (currentZoom >= switchThreshold) {
            if (!map.hasLayer(detailLayer)) { detailLayer.addTo(map); map.removeLayer(overviewLayer); }
        } else {
            if (!map.hasLayer(overviewLayer)) { overviewLayer.addTo(map); map.removeLayer(detailLayer); }
        }
    });

    setupEvents();
    renderMarkers();
}

/* -------------------------------------------------------------------------
 * Determine the actual view: portal (Grid) or map (Leaflet)
 * If nothing is already rendered (within initial fetchSheetData)
 * we return the default: portal otherwise it depends on the viaibility
 * attribute of the portal-view
 * ------------------------------------------------------------------------*/
function getCurrentView() {
    const portal = document.getElementById('portal-view');
    
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
    // 1. Alle aktuell gerenderten Cards im Portal holen
    const cards = document.querySelectorAll('.portal-card');
    const headerHeight = 60; // Dein h-[60px] Header

    for (let card of cards) {
        const rect = card.getBoundingClientRect();
        
        // find first card with top > 0 (most of the 200px are visible)
        // but maybe we should ensure full visibility ...
        if (rect.top > headerHeight) {
            // extract Index!
            return parseInt(card.dataset.idx);
        }
    }
    return null;
}

/* -------------------------------------------------------------------------
 * Switches between Portal (Grid) and Map (Leaflet)
 * @param {string} view - 'portal' or 'map'
 * ------------------------------------------------------------------------*/
function switchView(view) {
    const isMap = view === 'map';
    // retrieve the index of the topmost visible card in the portal before switching
    let topIdx = null;
    if (isMap) {
        topIdx = getTopPortalIndex(); 
    }
    
    // We toggle the display of the two main containers
    document.getElementById('portal-view').style.display = isMap ? 'none' : 'block';
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

    // seems obsolete, but ensures inital setting on refresh (if year not changed)
    const label = document.getElementById('current-year-label');
    label.innerText = `${myTitle}: ${activeYear}` + '\u200A'; // add a hairspace to prevent cut of last character

    if(isMap && map) {
        setTimeout(() => {
            map.invalidateSize();
            renderMarkers(); // Force markers to re-evaluate their 'active' status
             console.log("switchView::Top Portal Index:", topIdx);
            if (topIdx !== null && photoMarkers[topIdx] && photoMarkers[topIdx].lat && photoMarkers[topIdx].lon)
                { map.flyTo([photoMarkers[topIdx].lat, photoMarkers[topIdx].lon], 11, { duration: 1.5 }); }
            else
                { window.syncToFirstVisible(); }

        }, 300); // Give CSS time to render the div
    } else {
        renderPortal();
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
        
    // Use the logic that matches your switchView method
    const isMapActive = document.getElementById('map-view').style.display === 'block';

    if (isMapActive) {
        renderMarkers();
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
    
    const s = searchStr.toLowerCase();
    // Fields to search: Title, Tags, and Description (if exists)
    const title = (p.title || "").toLowerCase();
    const tags = (p.tags || "").toLowerCase();
    const desc = (p.description || "").toLowerCase();
    
    // Simple logic: returns true if any field contains the search string
    // You can later expand this to handle multiple words/terms
    return title.includes(s) || tags.includes(s) || desc.includes(s);
}

/**--------------------------------------------------------------
 * Updates the global year filter and refreshes all views
 * @param {string} yr - The selected year (e.g., '2024' or 'All')
 *-------------------------------------------------------------*/
window.updateActiveYear = function(yr) {
    activeYear = yr;
    
    // Sync the Sidebar (Left)
    populateYearSidebar(); 
    
    // Update the Top Nav Label
    const isMapVisible = (document.getElementById('map-view').style.display === 'block');
    const label = document.getElementById('current-year-label');
    label.innerText = `${myTitle}: ${yr}`+ '\u200A'; // add a hairspace to prevent cut of last character
    
    // Refresh views
    if ( isMapVisible ) {
        renderMarkers();
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

//------------------------------------------------------------------
// Helper to keep code DRY (Don't Repeat Yourself)
// Copy the HTML building logic from createMarker into this function
// the buttons and the image and the title and the activity
//------------------------------------------------------------------
function getPopupHTML(p, idx) {
    const rawAct = (p.activity) ? p.activity.toLowerCase().trim() : '';
    const isKnown = ICONS_MAP.hasOwnProperty(rawAct);
    const displayIcon = isKnown ? ICONS_MAP[rawAct] : '❓';
    
    // THE STATE CHECK: Is this track currently visible?
    const active = !!loadedTracks[idx]; 

    // ALBUM BUTTON LOGIC
    const hasAlbum = (p.album && p.album.startsWith('http'));
    // need to override the link representation (blue/underline) with white and no-underline
    const albumBtnClass = hasAlbum ? 'bg-sky-600 text-white no-underline' :
                                        'bg-gray-300 cursor-not-allowed';
    const albumBtnText = hasAlbum ? '<span class="text-[14px] mr-1">📸</span> ALBUM' : 
                                    '<span class="text-[14px] mr-1">🚫</span> NO ALBUM';
    const albumBtnLink = hasAlbum ? `href="${p.album}" target="_blank"` : 'onclick="return false;"';

    // TRACK BUTTON LOGIC
    const hasTrack = (p.gpx && p.gpx.length > 5);
    let trackBtnClass, trackBtnText;
    
    if (!hasTrack) {
        trackBtnClass = 'bg-gray-300 cursor-not-allowed';
        trackBtnText = '<span class="text-[14px] mr-1">🚫</span> NO TRACK';
    } else if (active) {
        trackBtnClass = 'bg-gray-500'; // Gray = "Click to hide"
        trackBtnText = '<span class="text-[14px] mr-1">❌</span> HIDE';
    } else {
        trackBtnClass = 'bg-emerald-700'; // Green = "Click to show"
        trackBtnText = '<span class="text-[14px] mr-1">🗺️</span> TRACK';
    }

    const imgHtml = (p.img && p.img.length > 4) 
        ? `<img src="${getAssetBase(p.year)}/${p.img}" class="photo-popup-img" onerror="this.style.display='none'">` 
        : '';

    return `
        <div class="text-center">
            ${imgHtml}
            <div class="popup-title" title="${p.title}">${p.title}</div>
            <div style="font-size: 9px; color: #666; margin-bottom: 8px;">
                <span class="use-noto" style="font-size: 14px;">${displayIcon}</span> ${p.activity || 'unknown'}
            </div>
            <div class="flex flex-row gap-2 justify-center">
                <a ${albumBtnLink} class="flex-1 p-2 py-[4px] ${albumBtnClass} text-white text-[10px] font-bold rounded flex items-center justify-center leading-none">
                    ${albumBtnText}
                </a>
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
    const yrs = ['All', ...new Set(photoMarkers.map(p => p.year.toString()))].sort().reverse();
    const side = document.getElementById('sidebar-years');
    side.innerHTML = yrs.map(y => `
        <div class="year-btn ${y === activeYear ? 'active' : ''}" onclick="updateActiveYear('${y}')">
            ${y}
        </div>
    `).join('');
}

/**-----------------------------------------------------------------
 * create the HTML for a Portal Grid Cards
 *----------------------------------------------------------------*/
function createPortalCard(p, idx) {
    const rawAct = (p.activity) ? p.activity.toLowerCase().trim() : '';
    const displayIcon = ICONS_MAP[rawAct] || '❓';
    
    // --- RESTORED metaHtml DEFINITION ---
    let metaHtml = `<span class="use-noto mr-1.5">${displayIcon}</span>`;
    if (p.tags && p.tags.trim().length > 0) {
        metaHtml += `<span class="text-gray-400 font-normal">${p.tags}</span>`;
    }
    
    // Status helpers
    const hasAlbum = p.album && p.album.startsWith('http');
    const hasLocation = (p.lat && p.lon);
    const isCollection = (!p.lat || !p.lon) && hasAlbum; 
    
    const canShowOnMap = hasLocation || isCollection;
    
    return `
        <div class="portal-card bg-white shadow-sm overflow-hidden flex flex-col h-full hover:shadow-md transition-all border border-gray-100" data-idx="${idx}">
            <div class="portal-img-container cursor-pointer" onclick="jumpToMap(${idx})">
                <img src="${getAssetBase(p.year)}/${p.img}" 
                    class="w-full h-full object-contain" loading="lazy" onerror="this.style.display='none'">
            </div>
            
            <div class="p-3 flex flex-col flex-grow">
                <h3 class="font-bold text-gray-900 leading-tight mb-1 text-sm line-clamp-2">${p.title}</h3>
                <div class="text-[11px] font-bold text-gray-500 truncate mb-4" title="${p.tags || ''}">
                    ${metaHtml}
                </div>

                <div class="mt-auto flex gap-2">
                    ${hasAlbum ? 
                        `<a href="${p.album}" target="_blank" class="flex-1 py-2 bg-blue-50 text-blue-600 rounded-lg text-[10px] font-bold text-center">📖 ALBUM</a>` : 
                        `<div class="flex-1 py-2 bg-gray-50 text-gray-400 rounded-lg text-[10px] font-bold text-center">🚫 NO ALBUM</div>`
                    }
                    
                    <button onclick="${canShowOnMap ? `jumpToMap(${idx})` : ''}" 
                            class="flex-1 py-2 ${canShowOnMap ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-400 cursor-not-allowed'} rounded-lg text-[10px] font-bold">
                        ${canShowOnMap ? '🗺️ MAP' : '🚫 NO MAP'}
                    </button>
                </div>
            </div>
        </div>
    `;
}

/**--------------------------------------------------------------------
 * Renders the Portal Grid Cards: in batch mode
 *-------------------------------------------------------------------*/
function renderPortal() {
    const container = document.getElementById('portal-grid');
    if (!container) return;
    
    container.innerHTML = ''; 
    const targets = getFilteredTours('portal');

    let i = 0;
    function processBatch() {
        const end = Math.min(i + 12, targets.length);
        let htmlChunk = '';

        for (; i < end; i++) {
            // We call the detailed function above
            htmlChunk += createPortalCard(targets[i], photoMarkers.indexOf(targets[i]));
        }

        container.insertAdjacentHTML('beforeend', htmlChunk);

        if (i < targets.length) {
            requestAnimationFrame(processBatch);
        }
    }
    processBatch();
}

/**
 * Transitions to map, ensures correct year filter, focuses on marker, and auto-loads track
 * @param {array of numbers} idx - Global indices in photoMarkers array
 */
function jumpToMap(indices) {
    const idxList = Array.isArray(indices) ? indices : [indices];
    if (idxList.length === 0) return;

    // Year-Sync
    const years = [...new Set(idxList.map(i => photoMarkers[i].year.toString()))];
    
    if (years.length === 1) {
        // Alle Ergebnisse aus einem Jahr -> Dieses Jahr aktiv setzen
        if (activeYear !== years[0]) {
            window.updateActiveYear(years[0]);
        }
    } else if (years.length > 1) {
        // Ergebnisse aus verschiedenen Jahren -> Auf "All" schalten, damit alle sichtbar sind
        if (activeYear !== 'All') {
            window.updateActiveYear('All');
        }
    }

    // 2. VIEW SELECTION
    switchView('map');

    // 3. LOGIC BRANCHING (Timeout für Leaflet-Initialisierung)
    setTimeout(() => {
        const markersWithCoords = idxList
            .map(i => photoMarkers[i])
            .filter(m => m && m.lat && m.lon);

        if (markersWithCoords.length === 0) return;

        // --- FALL A: MEHRERE MARKER / KOLLEKTION ---
        if (markersWithCoords.length > 1) {
            const bounds = L.latLngBounds(markersWithCoords.map(m => [m.lat, m.lon]));
            map.flyToBounds(bounds, { padding: [80, 80], duration: 1.5 });

            idxList.forEach(i => {
                const p = photoMarkers[i];
                if (p && p.gpx && p.gpx.length > 5 && !loadedTracks[i]) {
                    loadGpxTrack(i, false);
                }
            });
        } 
        // --- FALL B: EINZELNER MARKER ---
        else {
            const p = markersWithCoords[0];
            const originalIdx = idxList[0];
            map.flyTo([p.lat, p.lon], 11, { duration: 1.5 });

            map.once('moveend', () => {
                console.log("Trying to open popup for marker index:", originalIdx);
                let attempts = 0;
                const tryOpen = () => {
                    let found = false;
                    map.eachLayer(layer => {
                        if (layer instanceof L.Marker && layer._idx === originalIdx) {
                            layer.openPopup();
                            found = true;
                            console.log
                        }
                    });
                    if (!found && attempts < 10) {
                        attempts++;
                        setTimeout(tryOpen, 100);
                    }
                };
                tryOpen(); 
            });

            if (p.gpx && p.gpx.length > 5 && !loadedTracks[originalIdx]) {
                loadGpxTrack(originalIdx, true);
            }
        }
    }, 400);
}

/* -------------------------------------------------------------------------
    * RELOAD DATA: Triggered by the button
    * ------------------------------------------------------------------------*/
window.reloadData = function() {
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
    fetchSheetData().then((success) => {
        if (status) {
            if (success) {
                status.innerText = "DONE!";
                status.style.color = "#10b981"; // Green
            } else {
                status.innerText = "ERROR";
                status.style.color = "#ef4444"; // Red
            }
            
            // Reset to idle after 3 seconds
            setTimeout(() => { 
                status.innerText = "IDLE"; 
                status.style.color = ""; 
            }, 3000);
        }
    });
};

/* -------------------------------------------------------------------------
    * SETUP the view to the first visible Marker. Spot at fixed ZOOM 11
    --------------------------------------------------------------------------*/
window.syncToFirstVisible = function() {
    // 1. Find the first marker that survives current Sidebar filters
    const currentSelection = photoMarkers.filter((p) => {
        const rawAct = (p.activity) ? p.activity.toLowerCase().trim() : '';
        const activityKey = ICONS_MAP.hasOwnProperty(rawAct) ? rawAct : 'unknown';
        const yearMatch = (activeYear === 'All' || p.year.toString() === activeYear);
        const filterMatch = (activityKey === 'unknown') || activeFilters[activityKey];
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
    document.querySelectorAll('[data-activity]').forEach(btn => {
            btn.onclick = () => {
                // 1. Get the key (e.g., 'trip') from the button
                const activityKey = btn.dataset.activity; 
                
                // 2. Toggle the true/false value in our Global State
                activeFilters[activityKey] = !activeFilters[activityKey];
                
                // 3. Update the button's look
                btn.classList.toggle('filter-button-active', activeFilters[activityKey]);
                
                // 4. Refresh map/portal to reflect the new filter state
                executeSearch(activeTxtSearch,false); // use the search function to refresh views without changing the search term
            };
        });
    document.getElementById('hike-layer-btn').onclick = function() {
        map.hasLayer(hikingLayer) ? map.removeLayer(hikingLayer) : hikingLayer.addTo(map);
        this.classList.toggle('filter-button-active');
    };
    document.getElementById('bike-layer-btn').onclick = function() {
        map.hasLayer(cyclingLayer) ? map.removeLayer(cyclingLayer) : cyclingLayer.addTo(map);
        this.classList.toggle('filter-button-active');
    };
    document.getElementById('threshold-slider').oninput = (e) => {
        switchThreshold = parseFloat(e.target.value);
        document.getElementById('threshold-display').innerText = switchThreshold;
    };
}

/* -------------------------------------------------------------------------
    * LOAD GPX TRACK toggles tracks on and off. Optionally flying to bounds
    --------------------------------------------------------------------------*/
window.loadGpxTrack = function(idx, shouldZoom = true) {
    const p = photoMarkers[idx];
    const url = `${getAssetBase(p.year)}/${p.gpx}`;
    const rawAct = p.activity?.toLowerCase().trim();
    // Use COLORS keys directly (ski, hike, etc.)
    const color = COLORS[rawAct] || COLORS['unknown'];
    map.closePopup();

    if (loadedTracks[idx]) {
        map.removeLayer(loadedTracks[idx].group);
        delete loadedTracks[idx];
        refreshAllMarkerPopups(); // status toggle
        renderMarkers();
        return;
    }

    const trackGroup = L.featureGroup().addTo(map);
    const label = L.tooltip({ permanent: true, direction: 'right', offset: [15, 0], className: 'track-label' })
        .setContent(p.title).setLatLng([p.lat, p.lon]);
    trackGroup.addLayer(label);

    const trackLayer = new L.GPX(url, {
        async: true,
        marker_options: { startIconUrl: '', endIconUrl: '' },
        polyline_options: { color: color, weight: 5, opacity: 0.9, lineJoin: 'round' }
    }).on('loaded', e => {
        e.target.eachLayer(layer => {
            if (layer instanceof L.Polyline) {
                let dashPattern = p.activity === 'ski' ? '2, 12' : (p.activity === 'hike' || p.activity === 'climb' || p.activity === 'rope' ? '10, 10' : '20, 5');
                L.polyline(layer.getLatLngs(), { color: '#FFFFFF', weight: 2, opacity: 0.8, dashArray: dashPattern, lineCap: 'round', interactive: false }).addTo(trackGroup);
            }
        });
        
        // IMMEDIATE MOVE: As soon as THIS specific track is ready
        if (shouldZoom) {
            const b = e.target.getBounds();
            if (b.isValid()) map.flyToBounds(b, { padding: [50, 50] });
            else map.flyTo([p.lat, p.lon], 15);
        }
        
        loadedTracks[idx] = { group: trackGroup, filename: p.gpx, layer: e.target };
        refreshAllMarkerPopups();
        renderMarkers();
    }).on('error', () => {
        if (shouldZoom) map.flyTo([p.lat, p.lon], 15);
    });

    trackGroup.addLayer(trackLayer);
    return trackLayer;
};

/* -------------------------------------------------------------------------
    * GET FILTERED TOURS filter the photoMarkers
    * extracted from rendering. alows deviding loading into ad hoc and batch. 
    --------------------------------------------------------------------------*/
function getFilteredTours(targetView = 'map') {
    // Standard Filter logic
    let filtered = photoMarkers.filter(p => {
        const pYear = p.year.toString();
        const yearMatch = (activeYear === 'All' || pYear === activeYear);
        const searchMatch = matchesTxtSearch(p, activeTxtSearch);
        const rawAct = p.activity?.toLowerCase().trim();
        const activityKey = ICONS_MAP[rawAct] ? rawAct : 'unknown';
        const filterMatch = activeFilters[activityKey];
        
        return yearMatch && searchMatch && filterMatch;
    });

    if (targetView === 'map') {
        // Only return rows that have coordinates for the map markers
        return filtered.filter(p => p.lat && p.lon);
    }

    // PORTAL LOGIC: Hide duplicates to show only the "Ghost" (Collection Header)
    const seenCollectionAlbums = new Set();
    return filtered.filter(p => {
        // If no album is provided, always show the card
        if (!p.album || p.album === "" || p.album === "#") return true;
        
        // If we've already seen this album URL, hide this row
        if (seenCollectionAlbums.has(p.album)) return false;
        
        // Register collectionalbum w.o. coordinatesand show this first row (the Ghost/Header)
        if (!(p.lat && p.lon)) {
            seenCollectionAlbums.add(p.album);
        }
        return true;
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
    const rawAct = (p.activity) ? p.activity.toLowerCase().trim() : '';
    const activityKey = ICONS_MAP.hasOwnProperty(rawAct) ? rawAct : 'unknown';
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
    * Handles links like: ?album:Abc123&activity:ski
    --------------------------------------------------------------------------*/
// Am Ende deiner Initialisierung in app.js
function handleDeepLink() {
    const urlParams = new URLSearchParams(window.location.search);
    const query = urlParams.get('s')?.toLowerCase();
    console.log("handleDeepLink::urlParams.get():", query);
    if (!query) return false; // no deepLink-query

    // Search (Modular Filter)
    const matches = photoMarkers.filter(p => {
        const titleMatch = p.title?.toLowerCase().includes(query);
        return titleMatch;
    });

    if (matches.length === 1) {
        const targetIdx = photoMarkers.indexOf(matches[0]);
        jumpToMap(targetIdx); // Reuse the jumpToMap logic to handle the view switch and focusing
        return true; // link found
    }

    console.log("handleDeepLink::matches.length:", matches.length);
    if ( matches.length > 1) {
        const targetIndices = matches.map(m => photoMarkers.indexOf(m));
        jumpToMap(targetIndices); // Reuse the jumpToMap logic to handle the view switch and focusing
        return true; // link found
    }

    return false; // no match for link
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

/* -------------------------------------------------------------------------
    * SHOW ALL TRACKS that are not already visible and match the active filters
    * Function triggered by gear wheel button!
    --------------------------------------------------------------------------*/
window.showAllTracks = function() {
    let runningBounds = L.latLngBounds();
    let processedCount = 0;
    // power-search conflicts with showALL - so clear it!
    const searchBox = document.getElementById('power-search');
        if (searchBox) searchBox.value = "";
        
    // 1. Identify all markers that match current filters AND have a GPX file
    const tracksToProcess = photoMarkers.filter((p) => {
        const rawAct = (p.activity) ? p.activity.toLowerCase().trim() : '';
        const activityKey = ICONS_MAP.hasOwnProperty(rawAct) ? rawAct : 'unknown';
        const yearMatch = (activeYear === 'All' || p.year.toString() === activeYear);
        const filterMatch = (activityKey === 'unknown') || activeFilters[activityKey];
        
        // Only zoom to things that actually have a track to show
        return yearMatch && filterMatch && p.gpx && p.gpx.length > 5;
    });

    if (tracksToProcess.length === 0) return;

    // 2. The Final Master Zoom check
    const finalizeMasterView = () => {
        processedCount++;
        if (processedCount === tracksToProcess.length && runningBounds.isValid()) {
            map.flyToBounds(runningBounds, { padding: [50, 50], duration: 1.5 });
        }
    };

    // 3. Process each track
    tracksToProcess.forEach((p) => {
        const idx = photoMarkers.indexOf(p);
        
        if (loadedTracks[idx]) {
            // Already there? Just add its bounds to the master box
            const b = loadedTracks[idx].group.getBounds();
            if (b.isValid()) runningBounds.extend(b);
            finalizeMasterView();
        } else {
            // New? Load it and extend view cumulatively
            const track = loadGpxTrack(idx, false); 
            track.on('loaded', e => {
                const gb = e.target.getBounds();
                if (gb.isValid()) {
                    runningBounds.extend(gb);
                    // Cumulative "stretching" move
                    map.flyToBounds(runningBounds, { padding: [50, 50], duration: 1.5 }); //0.8 ?
                }
                finalizeMasterView();
            });
            track.on('error', () => finalizeMasterView());
        }
    });
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