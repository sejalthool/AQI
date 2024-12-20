import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import AsyncSelect from 'react-select/async';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js';

// Register ChartJS components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

// Create a separate component to handle map view updates
const MapUpdater = ({ center }) => {
  const map = useMap();
  useEffect(() => {
    map.setView(center, 13);
  }, [center, map]);
  return null;
};

const AirQualityIndex = () => {
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [aqi, setAqi] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [mapKey, setMapKey] = useState(0); // Add this to force map remount
  const [historicalData, setHistoricalData] = useState(null);

  const loadOptions = async (inputValue) => {
    if (!inputValue) return [];
    
    try {
      const response = await axios.get(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(inputValue)}`
      );
      
      if (!response.data || response.data.length === 0) {
        return [{
          label: 'No locations found',
          value: null,
          isDisabled: true
        }];
      }
      
      return response.data.map(item => ({
        value: {
          lat: parseFloat(item.lat),
          lng: parseFloat(item.lon)
        },
        label: item.display_name
      })).slice(0, 5);
    } catch (err) {
      console.error('Error fetching locations:', err);
      return [{
        label: 'Error loading locations',
        value: null,
        isDisabled: true
      }];
    }
  };

  const getAQIColor = (aqi) => {
    if (aqi <= 50) return 'bg-green-500';
    if (aqi <= 100) return 'bg-yellow-500';
    if (aqi <= 150) return 'bg-orange-500';
    if (aqi <= 200) return 'bg-red-500';
    if (aqi <= 300) return 'bg-purple-500';
    return 'bg-red-900';
  };

  const fetchAQI = async (location) => {
    setLoading(true);
    setError(null);
    try {
      const API_KEY = import.meta.env.VITE_WAQI_API_KEY;
      
      // First, get stations within 15km radius
      const stationsResponse = await axios.get(
        `https://api.waqi.info/map/bounds/?token=${API_KEY}&latlng=${location.value.lat-0.15},${location.value.lng-0.15},${location.value.lat+0.15},${location.value.lng+0.15}`
      );

      if (!stationsResponse.data.data || stationsResponse.data.data.length === 0) {
        setError('No AQI stations found near this location');
        return;
      }

      // Sort stations by distance and get the closest 3
      const stations = stationsResponse.data.data
        .map(station => ({
          ...station,
          distance: calculateDistance(
            location.value.lat,
            location.value.lng,
            station.lat,
            station.lon
          )
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 3);

      // Fetch detailed data for each station
      const stationDetails = await Promise.all(
        stations.map(station => 
          axios.get(`https://api.waqi.info/feed/@${station.uid}/?token=${API_KEY}`)
        )
      );

      // Process and aggregate the data
      const aggregatedData = processStationData(
        stationDetails.map(r => r.data.data),
        stations
      );
      setAqi(aggregatedData);
      
      // Fetch historical data for the closest station
      try {
        const historicalResponse = await fetchHistoricalData(stations[0]);
        setHistoricalData(historicalResponse);
      } catch (err) {
        console.error('Failed to fetch historical data:', err);
      }
    } catch (err) {
      setError(
        err.response?.data?.message || 
        'Failed to fetch AQI data. Please try again later.'
      );
    } finally {
      setLoading(false);
    }
  };

  const calculateDistance = (lat1, lon1, lat2, lon2) => {
    // Haversine formula for calculating distance between two points
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  };

  const processStationData = (stations, originalStations) => {
    return {
      aqi: weightedAverage(stations.map(s => s.aqi)),
      pollutants: {
        pm25: weightedAverage(stations.map(s => s.iaqi.pm25?.v)),
        pm10: weightedAverage(stations.map(s => s.iaqi.pm10?.v)),
        o3: weightedAverage(stations.map(s => s.iaqi.o3?.v)),
        no2: weightedAverage(stations.map(s => s.iaqi.no2?.v)),
        so2: weightedAverage(stations.map(s => s.iaqi.so2?.v)),
        co: weightedAverage(stations.map(s => s.iaqi.co?.v))
      },
      time: stations[0].time.iso,
      stations: stations.map((s, index) => ({
        name: s.city.name,
        aqi: s.aqi,
        distance: originalStations[index].distance
      }))
    };
  };

  const weightedAverage = (values) => {
    const validValues = values.filter(v => v !== undefined);
    if (validValues.length === 0) return null;
    return Math.round(validValues.reduce((a, b) => a + b, 0) / validValues.length);
  };

  useEffect(() => {
    if (selectedLocation) {
      fetchAQI(selectedLocation);
    }
  }, [selectedLocation]);

  const handleLocationChange = (newLocation) => {
    setSelectedLocation(newLocation);
    setMapKey(prev => prev + 1); // Force map to remount
  };

  const fetchHistoricalData = async (station) => {
    const API_KEY = import.meta.env.VITE_WAQI_API_KEY;
    const response = await axios.get(
      `https://api.waqi.info/feed/@${station.uid}/?token=${API_KEY}`
    );
    return response.data.data;
  };

  const getHealthRecommendations = (aqi) => {
    if (aqi <= 50) return "Air quality is good. Perfect for outdoor activities!";
    if (aqi <= 100) return "Sensitive individuals should consider limiting prolonged outdoor exposure.";
    if (aqi <= 150) return "Everyone should reduce prolonged or heavy outdoor exertion.";
    if (aqi <= 200) return "Avoid prolonged or heavy outdoor exertion.";
    if (aqi <= 300) return "Stay indoors and keep activity levels low.";
    return "Hazardous conditions! Avoid all outdoor activities.";
  };

  const prepareChartData = (data) => {
    if (!data || !data.forecast || !data.forecast.daily) return null;
    
    // Combine all pollutant forecasts into datasets
    const datasets = [];
    
    if (data.forecast.daily.pm25?.length > 0) {
      datasets.push({
        label: 'PM2.5',
        data: data.forecast.daily.pm25.map(d => d.avg),
        borderColor: 'rgb(75, 192, 192)',
        backgroundColor: 'rgba(75, 192, 192, 0.2)',
        tension: 0.1
      });
    }
    
    if (data.forecast.daily.pm10?.length > 0) {
      datasets.push({
        label: 'PM10',
        data: data.forecast.daily.pm10.map(d => d.avg),
        borderColor: 'rgb(255, 99, 132)',
        backgroundColor: 'rgba(255, 99, 132, 0.2)',
        tension: 0.1
      });
    }
    
    if (data.forecast.daily.o3?.length > 0) {
      datasets.push({
        label: 'O3',
        data: data.forecast.daily.o3.map(d => d.avg),
        borderColor: 'rgb(53, 162, 235)',
        backgroundColor: 'rgba(53, 162, 235, 0.2)',
        tension: 0.1
      });
    }
    
    if (datasets.length === 0) return null;
    
    // Use dates from the first available dataset
    const dates = data.forecast.daily[Object.keys(data.forecast.daily)[0]].map(d => 
      new Date(d.day).toLocaleDateString([], {
        month: 'short',
        day: 'numeric'
      })
    );
    
    return {
      labels: dates,
      datasets
    };
  };

  const chartOptions = {
    responsive: true,
    plugins: {
      legend: {
        position: 'top',
      },
      title: {
        display: true,
        text: 'Air Quality Forecast',
        color: '#374151',
        font: {
          size: 16,
          weight: 'bold'
        }
      }
    },
    scales: {
      y: {
        beginAtZero: true,
        title: {
          display: true,
          text: 'µg/m³'
        }
      }
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Real-time Air Quality Index</h1>
      
      <div className="mb-4 relative z-[1000]">
        <AsyncSelect
          cacheOptions
          defaultOptions
          loadOptions={loadOptions}
          value={selectedLocation}
          onChange={handleLocationChange}
          placeholder="Search for any location worldwide..."
          className="w-full"
          noOptionsMessage={() => "Start typing to search locations..."}
        />
      </div>

      {selectedLocation && (
        <div className="mb-4 h-[400px]">
          <MapContainer
            key={mapKey}
            center={[selectedLocation.value.lat, selectedLocation.value.lng]}
            zoom={13}
            style={{ height: '100%', width: '100%' }}
          >
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            />
            <Marker position={[selectedLocation.value.lat, selectedLocation.value.lng]}>
              <Popup>
                {selectedLocation.label}
                {aqi && <div>AQI: {aqi.aqi}</div>}
              </Popup>
            </Marker>
            <MapUpdater center={[selectedLocation.value.lat, selectedLocation.value.lng]} />
          </MapContainer>
        </div>
      )}

      {loading && <div className="text-center">Loading AQI data...</div>}
      
      {error && <div className="text-red-500 text-center">{error}</div>}
      
      {aqi && !loading && !error && (
        <>
          <div className={`p-4 rounded-lg text-white ${getAQIColor(aqi.aqi)} mb-4`}>
            <h2 className="text-xl font-bold">Current AQI: {aqi.aqi}</h2>
            <p className="text-sm mb-2">Last updated: {new Date(aqi.time).toLocaleString()}</p>
            
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
              {Object.entries(aqi.pollutants).map(([key, value]) => 
                value && (
                  <div key={key} className="bg-black/20 p-2 rounded">
                    <div className="font-bold">{key.toUpperCase()}</div>
                    <div>{value} µg/m³</div>
                  </div>
                )
              )}
            </div>

            <div className="mt-4">
              <h3 className="font-bold mb-2">Nearby Stations:</h3>
              {aqi.stations.map((station, index) => (
                <div key={index} className="text-sm">
                  {station.name} - AQI: {station.aqi} ({station.distance.toFixed(1)}km away)
                </div>
              ))}
            </div>

            <div className="mt-4 p-3 bg-black/10 rounded">
              <h3 className="font-bold mb-2">Health Recommendations</h3>
              <p>{getHealthRecommendations(aqi.aqi)}</p>
            </div>
          </div>

          {historicalData && (
            <div className="bg-white p-4 rounded-lg shadow mt-4">
              {prepareChartData(historicalData) ? (
                <Line 
                  data={prepareChartData(historicalData)} 
                  options={chartOptions}
                />
              ) : (
                <p className="text-gray-500 text-center py-4">
                  No historical data available for this location
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AirQualityIndex; 