'use strict';

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg) => (deg * Math.PI) / 180;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Is a GPS fix inside an organisation's geofence?
 * GPS accuracy widens the fence a little (capped) so users standing at the
 * door with a noisy fix are not rejected.
 */
function assessPresence(org, fix, { toleranceCapM, awayFactor }) {
  const distance = haversineMeters(org.lat, org.lng, fix.lat, fix.lng);
  const tolerance = Math.min(Math.max(0, fix.accuracy || 0), toleranceCapM);
  return {
    distance: Math.round(distance),
    inside: distance <= org.radius_m + tolerance,
    away: distance > org.radius_m * awayFactor + tolerance,
  };
}

module.exports = { haversineMeters, assessPresence };
