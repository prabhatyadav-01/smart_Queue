'use strict';

/**
 * Business rules for queueing, presence and abuse prevention.
 * Pure constants — safe to import from tests without touching env/config.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

module.exports = Object.freeze({
  SESSION_TTL_MS: 12 * HOUR,
  HUMAN_PASS_TTL_MS: 30 * MIN,

  // Booking limits
  MAX_ACTIVE_BOOKINGS: 3,
  MAX_RESCHEDULES: 3,
  BOOKING_HORIZON_DAYS: 14,

  // Presence / geofence
  CHECKIN_EARLY_MIN: 90, // check-in opens this long before the slot
  REMIND_BEFORE_MIN: 15, // "you're not here yet" reminder
  GRACE_MIN: 10, // absent this long after slot start → token moves
  DEFER_GAP_MIN: 15, // moved token lands at least this far in the future
  MAX_DEFERRALS: 2, // after this, the booking becomes a no-show
  MAX_GPS_ACCURACY_M: 150,
  GPS_TOLERANCE_CAP_M: 50,
  AWAY_FACTOR: 1.5, // distance > radius × factor counts as "left the premises"
  PRESENCE_STALE_MIN: 20, // location-based check-in with no fresh fix this long → back on hold
  EXPIRE_AFTER_SLOT_MIN: 120, // live tokens from a past day expire this long after their slot ended

  // No-show strikes
  NO_SHOW_STRIKE_LIMIT: 3,
  STRIKE_BLOCK_MS: 7 * DAY,

  // Background jobs
  MONITOR_INTERVAL_MS: 30_000,

  // Human verification
  HUMAN_THRESHOLD: 0.6,
  SUSPICIOUS_THRESHOLD: 0.35,
  CHALLENGE_MIN_HOLD_MS: 1500,
  CHALLENGE_TTL_MS: 2 * MIN,

  MIN,
  HOUR,
  DAY,
});
