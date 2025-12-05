mapboxgl.accessToken = 'pk.eyJ1IjoiamthbmRhIiwiYSI6ImNtaGN5c3JwbDIyNDUybHBxM2VweHBrNzYifQ.Akume5yUr5MZyYxPQq9EjA';

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/jkanda/cmiqw9mjt000r01sn5hug2jtu',
    center: [-122.33, 47.62],
    zoom: 11
});

// data file URLS
const populationURL = "../assets/population/population20_50.geojson";
const linkLineURL = "../assets/lines/link_line.geojson";
const linkStopsURL = "../assets/stops/link_stops.geojson";
const rrLineURL = "../assets/lines/rr_existing.geojson";
const rrStopsURL = "../assets/stops/RR_stops_citylimits.geojson";
const rrPlannedURL = "../assets/lines/rr_planned.geojson";

// choropleth color scale
const colorScale = [
    [0, '#ffffcc'],
    [2500, '#c7e9b4'],
    [5000, '#7fcdbb'],
    [10000, '#41b6c4'],
    [20000, '#1d91c0'],
    [40000, '#225ea8'],
    [80000, '#0c2c84']
];

let populationData, linkLineData, linkStopsData, rrLineData, rrStopsData, rrPlannedData;
let seattleTotalPop2050 = 0;
let currentBuffer = 1320;
let cache = {};
let fullCityData = null;

// function to load geojson files
async function loadJSON(url) {
    const res = await fetch(url);
    return res.json();
}

// cache key generator to retrieve the specified walkshed data
function getCacheKey(showLink, showRR, radius) {
    return `${showLink ? 'L' : ''}-${showRR ? 'R' : ''}-${radius}`;
}


// calculate population for clipped census tract
// assumes population is uniformly distributed and
// multiplies the % of area within the buffer * total population of tract
function calculateClippedPopulation(censusFeature, clippedFeature) {
    try {
        const originalArea = turf.area(censusFeature);
        const clippedArea = turf.area(clippedFeature);
        if (originalArea === 0) return 0;
        const areaRatio = clippedArea / originalArea;
        const pop = censusFeature.properties.pop50 || 0;
        return Math.round(pop * areaRatio);
    } catch (e) {
        return 0;
    }
}

// create unified buffer around all stops
// goes through each buffer object and joins them together
function createUnifiedBuffer(stops, lines, radius) {
    const buffers = [];
    
    if (stops.features && stops.features.length > 0) {
        console.log(`Creating buffers for ${stops.features.length} stops at ${radius} feet`);
        stops.features.forEach((stop, i) => {
            try {
                const buffer = turf.buffer(stop, radius, { units: 'feet' });
                if (buffer && buffer.geometry) buffers.push(buffer);
            } catch (e) {
                console.warn(`Buffer failed for stop ${i}:`, e);
            }
        });
    }
    
    if (lines.features && lines.features.length > 0) {
        console.log(`Creating buffers for ${lines.features.length} planned lines at ${radius} feet`);
        lines.features.forEach((line, i) => {
            try {
                const buffer = turf.buffer(line, radius, { units: 'feet' });
                if (buffer && buffer.geometry) buffers.push(buffer);
            } catch (e) {
                console.warn(`Buffer failed for line ${i}:`, e);
            }
        });
    }
    
    console.log(`Created ${buffers.length} total buffers`);
    
    if (buffers.length === 0) return null;
    
    let unified = buffers[0];
    for (let i = 1; i < buffers.length; i++) {
        try {
            const result = turf.union(unified, buffers[i]);
            if (result) unified = result;
        } catch (e) {
            console.warn(`Union failed at ${i}:`, e);
        }
    }
    
    console.log('Unified buffer created successfully');
    return unified;
}

// gets buffer area and population of census tracts within buffer
function clipCensusToBuffer(census, buffer) {
    const clippedFeatures = [];
    let totalPop = 0;
    
    if (!buffer || !buffer.geometry) {
        return { geojson: turf.featureCollection([]), totalPopulation: 0, bufferArea: 0 };
    }
    
    const bufferBbox = turf.bbox(buffer);
    
    census.features.forEach((tract) => {
        try {
            if (!tract.geometry || !tract.geometry.coordinates) return;
            
            const tractBbox = turf.bbox(tract);
            if (tractBbox[2] < bufferBbox[0] || tractBbox[0] > bufferBbox[2] ||
                tractBbox[3] < bufferBbox[1] || tractBbox[1] > bufferBbox[3]) return;
            
            if (turf.booleanDisjoint(tract, buffer)) return;
            
            const clipped = turf.intersect(tract, buffer);
            if (clipped && clipped.geometry) {
                const clippedPop = calculateClippedPopulation(tract, clipped);
                const clippedAreaSqMi = turf.area(clipped) / 2589988.11;
                const density = clippedAreaSqMi > 0 ? clippedPop / clippedAreaSqMi : 0;
                
                clipped.properties = {
                    ...tract.properties,
                    clipped_population: clippedPop,
                    clipped_area_sqmi: parseFloat(clippedAreaSqMi.toFixed(4)),
                    density: Math.round(density)
                };
                
                totalPop += clippedPop;
                clippedFeatures.push(clipped);
            }
        } catch (e) {}
    });
    
    const bufferAreaSqMi = turf.area(buffer) / 2589988.11;
    
    return {
        geojson: turf.featureCollection(clippedFeatures),
        totalPopulation: totalPop,
        bufferArea: bufferAreaSqMi,
        bufferGeom: buffer
    };
}

// get stops based off of user category toggle, shows link and or rapid ride stops
function getSelectedStopsAndLines() {
    const showLink = document.getElementById('show-link').checked;
    const showRR = document.getElementById('show-rr').checked;
    
    const stopFeatures = [];
    if (showLink && linkStopsData) stopFeatures.push(...linkStopsData.features);
    if (showRR && rrStopsData) stopFeatures.push(...rrStopsData.features);
    
    const lineFeatures = [];
    if (showRR && rrPlannedData) lineFeatures.push(...rrPlannedData.features);
    
    return { 
        stops: turf.featureCollection(stopFeatures), 
        lines: turf.featureCollection(lineFeatures),
        showLink, 
        showRR 
    };
}

// calculates population statistics based off the spatial analysis
function updateStats(data, isFullCity = false) {
    const statsContent = document.getElementById('stats-content');
    const noSelection = document.getElementById('no-selection');
    
    if (!data || data.totalPopulation === 0) {
        statsContent.style.display = 'none';
        noSelection.style.display = 'block';
        return;
    }
    
    statsContent.style.display = 'block';
    noSelection.style.display = 'none';
    
    document.getElementById('total-pop').textContent = data.totalPopulation.toLocaleString();
    document.getElementById('total-area').textContent = data.bufferArea.toFixed(2);
    
    if (isFullCity) {
        document.getElementById('pct-seattle').textContent = '100%';
    } else {
        const pctSeattle = seattleTotalPop2050 > 0 
            ? ((data.totalPopulation / seattleTotalPop2050) * 100).toFixed(1)
            : '0';
        document.getElementById('pct-seattle').textContent = pctSeattle + '%';
    }
}

// toggles metro line visibility
function updateLineVisibility() {
    const showLink = document.getElementById('show-link').checked;
    const showRR = document.getElementById('show-rr').checked;
    const showStops = document.getElementById('show-stops').checked;
    
    map.setLayoutProperty('link-line-layer', 'visibility', showLink ? 'visible' : 'none');
    map.setLayoutProperty('link-stops-layer', 'visibility', showLink && showStops ? 'visible' : 'none');
    map.setLayoutProperty('rr-line-layer', 'visibility', showRR ? 'visible' : 'none');
    map.setLayoutProperty('rr-stops-layer', 'visibility', showRR && showStops ? 'visible' : 'none');
    map.setLayoutProperty('rr-planned-layer', 'visibility', showRR ? 'visible' : 'none');
}

// clears walkshed analysis and returns to full choropleth map
function clear() {
    map.getSource('clipped-census').setData(fullCityData.geojson);
    map.getSource('buffer-outline').setData(turf.featureCollection([]));
    updateStats(fullCityData, true);
}

// calculates walkshed based on selected stops and buffer distance
async function recalculateWalkshed() {
    const { stops, lines, showLink, showRR } = getSelectedStopsAndLines();
    const radius = currentBuffer;
    const cacheKey = getCacheKey(showLink, showRR, radius);
    
    if (cache[cacheKey]) {
        const data = cache[cacheKey];
        map.getSource('clipped-census').setData(data.geojson);
        map.getSource('buffer-outline').setData(data.bufferGeom || turf.featureCollection([]));
        updateStats(data);
        return;
    }
    
    if (stops.features.length === 0 && lines.features.length === 0) {
        map.getSource('clipped-census').setData(fullCityData.geojson);
        map.getSource('buffer-outline').setData(turf.featureCollection([]));
        updateStats(fullCityData, true);
        return;
    }
    
    document.getElementById('processing').style.display = 'block';
    await new Promise(resolve => setTimeout(resolve, 10));
    
    try {
        const buffer = createUnifiedBuffer(stops, lines, radius);
        const data = clipCensusToBuffer(populationData, buffer);
        
        cache[cacheKey] = data;
        
        map.getSource('clipped-census').setData(data.geojson);
        map.getSource('buffer-outline').setData(data.bufferGeom || turf.featureCollection([]));
        updateStats(data);
    } catch (e) {
        console.error('Error calculating walkshed:', e);
    }
    
    document.getElementById('processing').style.display = 'none';
}

// initiates map, loads data and creates layers and nodes based off of stops and data
// also sets up event listeners for user interactivity with map nodes
map.on('load', async () => {

    try {
        document.getElementById('loading').textContent = 'Loading data files...';
        
        [populationData, linkLineData, linkStopsData, rrLineData, rrStopsData, rrPlannedData] = await Promise.all([
            loadJSON(populationURL),
            loadJSON(linkLineURL),
            loadJSON(linkStopsURL),
            loadJSON(rrLineURL),
            loadJSON(rrStopsURL),
            loadJSON(rrPlannedURL)
        ]);

        document.getElementById('loading').textContent = 'Processing walksheds...';

        seattleTotalPop2050 = populationData.features.reduce((sum, tract) => {
            return sum + (tract.properties.pop50 || 0);
        }, 0);
        console.log(`Seattle total 2050 population: ${seattleTotalPop2050.toLocaleString()}`);

        const fullCityFeatures = populationData.features.map(tract => {
            const areaSqMi = turf.area(tract) / 2589988.11;
            const pop = tract.properties.pop50 || 0;
            const density = areaSqMi > 0 ? pop / areaSqMi : 0;
            return {
                ...tract,
                properties: {
                    ...tract.properties,
                    clipped_population: pop,
                    clipped_area_sqmi: parseFloat(areaSqMi.toFixed(4)),
                    density: Math.round(density)
                }
            };
        });
        
        const totalArea = populationData.features.reduce((sum, tract) => {
            return sum + turf.area(tract) / 2589988.11;
        }, 0);
        
        fullCityData = {
            geojson: turf.featureCollection(fullCityFeatures),
            totalPopulation: seattleTotalPop2050,
            bufferArea: totalArea
        };

        // Cache empty selection state
        cache[getCacheKey(false, false, 1320)] = { 
            geojson: turf.featureCollection([]), 
            totalPopulation: 0, 
            bufferArea: 0,
            bufferGeom: turf.featureCollection([])
        };

        document.getElementById('loading').style.display = 'none';

        // Initialize with full city data (no transit selected)
        map.addSource('clipped-census', {
            type: 'geojson',
            data: fullCityData.geojson
        });

        map.addSource('buffer-outline', {
            type: 'geojson',
            data: turf.featureCollection([])
        });

        map.addSource('link-line', { type: 'geojson', data: linkLineData });
        map.addSource('link-stops', { type: 'geojson', data: linkStopsData });
        map.addSource('rr-line', { type: 'geojson', data: rrLineData });
        map.addSource('rr-stops', { type: 'geojson', data: rrStopsData });
        map.addSource('rr-planned', { type: 'geojson', data: rrPlannedData });

        map.addLayer({
            id: 'census-choropleth',
            type: 'fill',
            source: 'clipped-census',
            paint: {
                'fill-color': [
                    'interpolate', ['linear'], ['get', 'density'],
                    ...colorScale.flat()
                ],
                'fill-opacity': 0.75
            }
        });

        map.addLayer({
            id: 'census-outline',
            type: 'line',
            source: 'clipped-census',
            paint: { 'line-color': '#fff', 'line-width': 0.5, 'line-opacity': 0.5 }
        });

        map.addLayer({
            id: 'buffer-outline-layer',
            type: 'line',
            source: 'buffer-outline',
            paint: { 'line-color': '#333', 'line-width': 2, 'line-dasharray': [2, 2] }
        });

        map.addLayer({
            id: 'rr-line-layer',
            type: 'line',
            source: 'rr-line',
            paint: {
                'line-color': '#c62828',
                'line-width': 2.5,
                'line-opacity': 0.9
            }
        });

        map.addLayer({
            id: 'rr-planned-layer',
            type: 'line',
            source: 'rr-planned',
            paint: {
                'line-color': '#c62828',
                'line-width': 3,
                'line-opacity': 0.9,
                'line-dasharray': [4, 2]
            }
        });

        map.addLayer({
            id: 'link-line-layer',
            type: 'line',
            source: 'link-line',
            paint: {
                'line-color': '#00A651',
                'line-width': 3,
                'line-opacity': 0.9
            }
        });

        map.addLayer({
            id: 'link-stops-layer',
            type: 'circle',
            source: 'link-stops',
            paint: {
                'circle-radius': 6,
                'circle-color': '#00A651',
                'circle-stroke-color': '#fff',
                'circle-stroke-width': 2
            }
        });

        map.addLayer({
            id: 'rr-stops-layer',
            type: 'circle',
            source: 'rr-stops',
            paint: {
                'circle-radius': 5,
                'circle-color': '#c62828',
                'circle-stroke-color': '#fff',
                'circle-stroke-width': 2
            }
        });

        // Show all transit layers by default
        map.setLayoutProperty('link-line-layer', 'visibility', 'visible');
        map.setLayoutProperty('link-stops-layer', 'visibility', 'visible');
        map.setLayoutProperty('rr-line-layer', 'visibility', 'visible');
        map.setLayoutProperty('rr-stops-layer', 'visibility', 'visible');
        map.setLayoutProperty('rr-planned-layer', 'visibility', 'visible');

        // Show full city stats
        updateStats(fullCityData, true);

        const popup = new mapboxgl.Popup({ closeButton: true, closeOnClick: true });

        map.on('click', 'census-choropleth', (e) => {
            const props = e.features[0].properties;
            popup.setLngLat(e.lngLat)
                .setHTML(`
                    <div class="popup-title">Census Tract (2050 Projection)</div>
                    <div class="popup-info">
                        <strong>Population:</strong> ${props.clipped_population?.toLocaleString() || 'N/A'}<br>
                        <strong>Density:</strong> ${props.density?.toLocaleString() || 'N/A'} /mi²<br>
                        <strong>Area:</strong> ${props.clipped_area_sqmi || 'N/A'} mi²<br>
                        <strong>Growth Rate:</strong> ${props.avg_growth_pct ? (props.avg_growth_pct * 100).toFixed(2) + '%' : 'N/A'} /yr
                    </div>
                `)
                .addTo(map);
        });

        ['rr-stops-layer'].forEach(layerId => {
            map.on('click', layerId, (e) => {
                const props = e.features[0].properties;
                const type = 'RapidRide';
                popup.setLngLat(e.lngLat)
                    .setHTML(`
                        <div class="popup-title">${props.RAPID_LINE || 'Transit Stop'}</div>
                        <div class="popup-info">
                            <strong>Type:</strong> ${type}<br>
                            <strong>Region:</strong> ${props.L_HOOD || 'N/A'}<br>
                            <strong>Neighborhood:</strong> ${props.S_HOOD || 'N/A'}<br>
                        </div>
                    `)
                    .addTo(map);
            });
        });

        ['link-stops-layer'].forEach(layerId => {
            map.on('click', layerId, (e) => {
                const props = e.features[0].properties;
                const type = 'Link Light Rail';
                popup.setLngLat(e.lngLat)
                    .setHTML(`
                        <div class="popup-title">${props.name || 'Transit Stop'}</div>
                        <div class="popup-info">
                            <strong>Type:</strong> ${type}<br>
                            <strong>Stop ID:</strong> ${props.id || 'N/A'}<br>
                            <strong>Daily Boardings:</strong> ${props.daily_boardings || 'N/A'}<br>
                            <strong>Opened: </strong> ${props.opened || 'N/A'}<br>
                        </div>
                    `)
                    .addTo(map);
            });
        });

        ['census-choropleth', 'link-stops-layer', 'rr-stops-layer'].forEach(layer => {
            map.on('mouseenter', layer, () => map.getCanvas().style.cursor = 'pointer');
            map.on('mouseleave', layer, () => map.getCanvas().style.cursor = '');
        });

        document.getElementById('choropleth').addEventListener('change', () => {
            map.setLayoutProperty('census-choropleth', 'visibility',
                document.getElementById('choropleth').checked ? 'visible' : 'none');
        });

        document.getElementById('calc').addEventListener('click', recalculateWalkshed);
        document.getElementById('clear').addEventListener('click', clear);

        document.querySelectorAll('input[name="buffer"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                currentBuffer = parseInt(e.target.value);
            });
        });

        document.getElementById('show-link').addEventListener('change', () => {
            const showLink = document.getElementById('show-link').checked;
            const showRR = document.getElementById('show-rr').checked;
            
            // Auto-enable stops when a line is selected
            if (showLink || showRR) {
                document.getElementById('show-stops').checked = true;
            }
            
            updateLineVisibility();
        });

        document.getElementById('show-rr').addEventListener('change', () => {
            const showLink = document.getElementById('show-link').checked;
            const showRR = document.getElementById('show-rr').checked;
            
            // Auto-enable stops when a line is selected
            if (showLink || showRR) {
                document.getElementById('show-stops').checked = true;
            }
            
            updateLineVisibility();
        });

        document.getElementById('show-stops').addEventListener('change', updateLineVisibility);

        document.getElementById('show-link').checked = true;
        document.getElementById('show-rr').checked = true;
        document.getElementById('show-stops').checked = true;
    } catch (error) {
        console.error('Error:', error);
        document.getElementById('loading').textContent = 'Error: ' + error.message;
    }
});

    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    
    const hamburger = document.getElementById("hamburger");
    const menu = document.getElementById("hamburger-menu");
    
    hamburger.addEventListener("click", () => {
        menu.style.display = (menu.style.display === "block") ? "none" : "block";
    });

