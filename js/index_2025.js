mapboxgl.accessToken = 'pk.eyJ1IjoidHRob21wNCIsImEiOiJjbWg4ZnZ4cTUxMGQ5MmtwdWR4MTNnbm40In0.JHg_sbayM5UCtQkYhC2LEA';

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/light-v10',
    center: [-122.33, 47.62],
    zoom: 11
});

const rrStopsURL = "/transit-walkshed/assets/data/stops/RR_stops_citylimits.geojson";
const linkStopsURL = "/transit-walkshed/assets/data/stops/link_stops.geojson";
const populationURL = "/transit-walkshed/assets/data/population/2020population_4326.geojson";
const linkLineURL = "/transit-walkshed/assets/data/lines/link_line.geojson";
const rrLineURL = "/transit-walkshed/assets/data/lines/rr_existing.geojson";


const colorScale = [
    [0, '#ffffcc'],
    [2500, '#c7e9b4'],
    [5000, '#7fcdbb'],
    [10000, '#41b6c4'],
    [20000, '#1d91c0'],
    [40000, '#225ea8'],
    [80000, '#0c2c84']
];

let populationData, rrStopsData, linkStopsData, linkLineData, rrLineData;
let currentBuffer = 1320;
let cache = {};

async function loadJSON(url) {
    const res = await fetch(url);
    return res.json();
}

function getCacheKey(showLink, showRR, radius) {
    return `${showLink ? 'L' : ''}-${showRR ? 'R' : ''}-${radius}`;
}

function calculateClippedPopulation(censusFeature, clippedFeature) {
    try {
        const originalArea = turf.area(censusFeature);
        const clippedArea = turf.area(clippedFeature);
        if (originalArea === 0) return 0;
        const areaRatio = clippedArea / originalArea;
        const pop = censusFeature.properties.TOTAL_POPULATION || 0;
        return Math.round(pop * areaRatio);
    } catch (e) {
        return 0;
    }
}

function createUnifiedBuffer(stops, radius) {
    if (!stops.features || stops.features.length === 0) {
        console.warn('No stops provided for buffer creation');
        return null;
    }

    console.log(`Creating buffer for ${stops.features.length} stops at ${radius} feet`);

    const buffers = [];
    stops.features.forEach((stop, i) => {
        try {
            const buffer = turf.buffer(stop, radius, { units: 'feet' });
            if (buffer && buffer.geometry) buffers.push(buffer);
        } catch (e) {
            console.warn(`Buffer failed for stop ${i}:`, e);
        }
    });

    console.log(`Created ${buffers.length} individual buffers`);

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

function getSelectedStops() {
    const showLink = document.getElementById('show-link').checked;
    const showRR = document.getElementById('show-rr').checked;
    
    const features = [];
    if (showLink && linkStopsData) features.push(...linkStopsData.features);
    if (showRR && rrStopsData) features.push(...rrStopsData.features);
    
    return { stops: turf.featureCollection(features), showLink, showRR };
}

function updateStats(data) {
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
}



function updateStopLayerVisibility() {
    const showStops = document.getElementById('show-stops').checked;
    const showLink = document.getElementById('show-link').checked;
    const showRR = document.getElementById('show-rr').checked;
    
    map.setLayoutProperty('link-stops-layer', 'visibility', 
        showStops && showLink ? 'visible' : 'none');
    map.setLayoutProperty('rr-stops-layer', 'visibility', 
        showStops && showRR ? 'visible' : 'none');
}

async function recalculateWalkshed() {
    const { stops, showLink, showRR } = getSelectedStops();
    const radius = currentBuffer;
    const cacheKey = getCacheKey(showLink, showRR, radius);
    
    if (cache[cacheKey]) {
        const data = cache[cacheKey];
        map.getSource('clipped-census').setData(data.geojson);
        map.getSource('buffer-outline').setData(data.bufferGeom || turf.featureCollection([]));
        updateStats(data);
        return;
    }
    
    if (stops.features.length === 0) {
        const emptyData = { 
            geojson: turf.featureCollection([]), 
            totalPopulation: 0, 
            bufferArea: 0,
            bufferGeom: turf.featureCollection([])
        };
        map.getSource('clipped-census').setData(emptyData.geojson);
        map.getSource('buffer-outline').setData(emptyData.bufferGeom);
        updateStats(null);
        cache[cacheKey] = emptyData;
        return;
    }
    
    document.getElementById('processing').style.display = 'block';
    await new Promise(resolve => setTimeout(resolve, 10));
    
    try {
        const buffer = createUnifiedBuffer(stops, radius);
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

map.on('load', async () => {
    try {
        document.getElementById('loading').textContent = 'Loading data files...';
        
        [rrStopsData, linkStopsData, populationData, linkLineData, rrLineData] = await Promise.all([
            loadJSON(rrStopsURL),
            loadJSON(linkStopsURL),
            loadJSON(populationURL),
            loadJSON(linkLineURL),
            loadJSON(rrLineURL)
        ]);

        document.getElementById('loading').textContent = 'Processing walksheds...';

        const { stops } = getSelectedStops();
        const initialBuffer = createUnifiedBuffer(stops, 1320);
        const initialData = clipCensusToBuffer(populationData, initialBuffer);
        cache[getCacheKey(true, true, 1320)] = initialData;

        document.getElementById('loading').style.display = 'none';

        map.addSource('clipped-census', {
            type: 'geojson',
            data: initialData.geojson
        });

        map.addSource('buffer-outline', {
            type: 'geojson',
            data: initialData.bufferGeom || turf.featureCollection([])
        });

        map.addSource('link-stops', { type: 'geojson', data: linkStopsData });
        map.addSource('rr-stops', { type: 'geojson', data: rrStopsData });
        map.addSource('link-line', { type: 'geojson', data: linkLineData });
        map.addSource('rr-line', { type: 'geojson', data: rrLineData });

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
            id: 'link-line-layer',
            type: 'line',
            source: 'link-line',
            paint: {
                'line-color': '#1565c0',
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
                'circle-color': '#1565c0',
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

        updateStats(initialData);

        const popup = new mapboxgl.Popup({ closeButton: true, closeOnClick: true });

        map.on('click', 'census-choropleth', (e) => {
            const props = e.features[0].properties;
            popup.setLngLat(e.lngLat)
                .setHTML(`
                    <div class="popup-title">Census Tract</div>
                    <div class="popup-info">
                        <strong>Population:</strong> ${props.clipped_population?.toLocaleString() || 'N/A'}<br>
                        <strong>Density:</strong> ${props.density?.toLocaleString() || 'N/A'} /mi²<br>
                        <strong>Area:</strong> ${props.clipped_area_sqmi || 'N/A'} mi²
                    </div>
                `)
                .addTo(map);
        });

        ['link-stops-layer', 'rr-stops-layer'].forEach(layerId => {
            map.on('click', layerId, (e) => {
                const props = e.features[0].properties;
                const type = layerId.includes('link') ? 'Link Light Rail' : 'RapidRide';
                popup.setLngLat(e.lngLat)
                    .setHTML(`
                        <div class="popup-title">${props.stop_name || 'Transit Stop'}</div>
                        <div class="popup-info">
                            <strong>Type:</strong> ${type}<br>
                            <strong>Stop ID:</strong> ${props.stop_id || 'N/A'}
                        </div>
                    `)
                    .addTo(map);
            });
        });

        ['census-choropleth', 'link-stops-layer', 'rr-stops-layer'].forEach(layer => {
            map.on('mouseenter', layer, () => map.getCanvas().style.cursor = 'pointer');
            map.on('mouseleave', layer, () => map.getCanvas().style.cursor = '');
        });

        document.querySelectorAll('input[name="buffer"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                currentBuffer = parseInt(e.target.value);
                recalculateWalkshed();
            });
        });

        document.getElementById('show-link').addEventListener('change', () => {
            updateStopLayerVisibility();
            recalculateWalkshed();
            const showLink = document.getElementById('show-link').checked;
            map.setLayoutProperty('link-line-layer', 'visibility', showLink ? 'visible' : 'none');
        });

        document.getElementById('show-rr').addEventListener('change', () => {
            updateStopLayerVisibility();
            recalculateWalkshed();
            const showRR = document.getElementById('show-rr').checked;
            map.setLayoutProperty('rr-line-layer', 'visibility', showRR ? 'visible' : 'none');
        });

        document.getElementById('show-stops').addEventListener('change', updateStopLayerVisibility);

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
});
