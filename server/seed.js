'use strict';

const { stmt, tx } = require('./db');
const { hashPassword, randomToken } = require('./lib/crypto');

const hm = (s) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

// Fictional organisations (Hyderabad coordinates). Admins can move each
// geofence to their real location from the dashboard.
const ORGS = [
  {
    name: 'Regional Passport Office', category: 'government', address: 'Begumpet, Hyderabad',
    lat: 17.4399, lng: 78.4636, radius: 150, open: '09:00', close: '17:00', slot: 15, counters: 4,
    services: [['Passport Application', 'P', 6, 8], ['Police Verification', 'V', 3, 10], ['Document Enquiry', 'E', 4, 5]],
  },
  {
    name: 'Municipal Citizen Service Centre', category: 'government', address: 'Abids, Hyderabad',
    lat: 17.392, lng: 78.475, radius: 120, open: '08:00', close: '20:00', slot: 15, counters: 3,
    services: [['Birth & Death Certificates', 'C', 4, 6], ['Property Tax', 'T', 4, 5], ['Grievances', 'G', 3, 8]],
  },
  {
    name: 'Regional Transport Office', category: 'government', address: 'Khairatabad, Hyderabad',
    lat: 17.4126, lng: 78.4617, radius: 200, open: '09:00', close: '17:00', slot: 15, counters: 3,
    services: [['Driving Licence', 'D', 5, 9], ['Vehicle Registration', 'R', 4, 10]],
  },
  {
    name: 'City General Hospital — Outpatients', category: 'hospital', address: 'Somajiguda, Hyderabad',
    lat: 17.4239, lng: 78.4575, radius: 200, open: '00:00', close: '24:00', slot: 10, counters: 4,
    services: [['General Medicine', 'M', 4, 7], ['Paediatrics', 'K', 3, 8], ['Orthopaedics', 'J', 3, 9], ['Lab & Diagnostics', 'L', 6, 4]],
  },
  {
    name: 'Lakeside Multispeciality Clinic', category: 'hospital', address: 'Necklace Road, Hyderabad',
    lat: 17.4239, lng: 78.4738, radius: 120, open: '09:00', close: '21:00', slot: 15, counters: 2,
    services: [['Cardiology', 'H', 3, 12], ['Dermatology', 'S', 3, 10]],
  },
  {
    name: 'Northwind Technologies — Visitor & HR Desk', category: 'corporate', address: 'HITEC City, Hyderabad',
    lat: 17.4474, lng: 78.3762, radius: 150, open: '09:30', close: '18:30', slot: 15, counters: 3,
    services: [['Interview Check-in', 'I', 5, 6], ['Visitor & Vendor Pass', 'V', 4, 4], ['ID & Access Card', 'A', 3, 7]],
  },
  {
    name: 'Helix Global Services — Campus Reception', category: 'corporate', address: 'Gachibowli, Hyderabad',
    lat: 17.4401, lng: 78.3489, radius: 150, open: '10:00', close: '19:00', slot: 15, counters: 2,
    services: [['Candidate Onboarding', 'N', 4, 10], ['Client Meetings', 'C', 3, 6]],
  },
  {
    name: 'Civic Commons Bank — Main Branch', category: 'bank', address: 'Koti, Hyderabad',
    lat: 17.385, lng: 78.4867, radius: 100, open: '10:00', close: '16:00', slot: 15, counters: 3,
    services: [['Cash & Deposits', 'B', 6, 4], ['Loans & Advisory', 'L', 3, 12], ['Account Opening', 'A', 3, 10]],
  },
];

async function seedOrganisations(db) {
  const countRow = await stmt(db, 'SELECT COUNT(*) AS c FROM organizations').get();
  if (countRow && countRow.c > 0) return false;
  await tx(db, async () => {
    for (const o of ORGS) {
      const res = await stmt(db,
        `INSERT INTO organizations (name, category, address, lat, lng, radius_m, open_min, close_min, slot_minutes)
         VALUES (?,?,?,?,?,?,?,?,?)`).run(o.name, o.category, o.address, o.lat, o.lng, o.radius, hm(o.open), hm(o.close), o.slot);
      const orgId = Number(res.lastInsertRowid);
      for (const [name, code, capacity, avg] of o.services) {
        await stmt(db, 'INSERT INTO services (org_id, name, code, slot_capacity, avg_service_min) VALUES (?,?,?,?,?)')
          .run(orgId, name, code, capacity, avg);
      }
      for (let i = 1; i <= o.counters; i++) {
        await stmt(db, 'INSERT INTO counters (org_id, name) VALUES (?,?)').run(orgId, `Counter ${i}`);
      }
    }
  });
  return true;
}

async function ensureSystemUser(db) {
  const existing = await stmt(db, "SELECT id FROM users WHERE role='system'").get();
  if (existing) return existing.id;
  const res = await stmt(db, "INSERT INTO users (email, name, role, created_at) VALUES ('kiosk@system.invalid','Walk-in kiosk','system',?)")
    .run(Date.now());
  return Number(res.lastInsertRowid);
}

/**
 * Creates the first admin. Credentials come from ADMIN_EMAIL / ADMIN_PASSWORD;
 * in development a random password is generated and printed once.
 */
async function ensureAdmin(db, { email, password, isProd }) {
  if (await stmt(db, "SELECT id FROM users WHERE role='admin'").get()) return null;
  if (!email || !password) {
    if (isProd) {
      console.warn('[seed] No admin exists. Set ADMIN_EMAIL and ADMIN_PASSWORD to create one.');
      return null;
    }
  }
  const adminEmail = (email || 'admin@smartqueue.local').toLowerCase();
  const adminPassword = password || randomToken(12);
  await stmt(db, "INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?,?,?,'admin',?)")
    .run(adminEmail, 'Administrator', await hashPassword(adminPassword), Date.now());
  return { email: adminEmail, password: password ? null : adminPassword };
}

module.exports = { seedOrganisations, ensureSystemUser, ensureAdmin, ORGS };
