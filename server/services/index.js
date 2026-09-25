'use strict';

const { createNotifier } = require('./notifier');
const { createBookingService } = require('./bookingService');
const { createPresenceService } = require('./presenceService');
const { createCounterService } = require('./counterService');
const { createStatsService } = require('./statsService');

function createServices({ db, events }) {
  const notifier = createNotifier({ db, events });
  const bookings = createBookingService({ db, notifier, events });
  const presence = createPresenceService({ db, notifier, bookings });
  const counters = createCounterService({ db, notifier, presence });
  const stats = createStatsService({ db });
  events.setSnapshotProvider((orgId, now) => stats.snapshot(orgId, now));
  return Object.freeze({ notifier, bookings, presence, counters, stats });
}

module.exports = { createServices };
