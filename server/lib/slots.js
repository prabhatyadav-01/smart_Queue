'use strict';

/**
 * Slot & token arithmetic (pure, no I/O).
 *
 * A day at an organisation is split into fixed slots. Each service has
 * `slot_capacity` seats per slot. A token number is derived from the slot and
 * seat, so it is a pure function of the user's chosen date/time:
 *
 *    token_no = slot_index × capacity + seat + 1
 *
 * Consequence: when someone reschedules or is moved for being absent, only
 * *their* token changes — nobody else's number shifts.
 */
const MS_PER_MIN = 60_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad2 = (n) => String(n).padStart(2, '0');

function toDateStr(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isValidDateStr(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function dayStartMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return toDateStr(new Date(y, m - 1, d + days).getTime());
}

function slotCount(org) {
  return Math.max(0, Math.floor((org.close_min - org.open_min) / org.slot_minutes));
}

function slotStartMinute(org, idx) {
  return org.open_min + idx * org.slot_minutes;
}

function slotStartMs(org, dateStr, idx) {
  return dayStartMs(dateStr) + slotStartMinute(org, idx) * MS_PER_MIN;
}

function slotEndMs(org, dateStr, idx) {
  return slotStartMs(org, dateStr, idx + 1);
}

function minutesLabel(totalMin) {
  const m = ((totalMin % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

function slotLabel(org, idx) {
  return minutesLabel(slotStartMinute(org, idx));
}

/** Wall-clock HH:MM for an epoch timestamp (server local time). */
function clockLabel(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function minuteOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/** First slot (on dateStr) that has not yet ended at `atMs`. Returns slotCount when the day is over. */
function firstOpenSlotIndex(org, dateStr, atMs) {
  const n = slotCount(org);
  const elapsedMin = (atMs - dayStartMs(dateStr)) / MS_PER_MIN - org.open_min;
  if (elapsedMin < 0) return 0;
  return Math.min(n, Math.floor(elapsedMin / org.slot_minutes));
}

function tokenNumber(capacity, slotIndex, seat) {
  return slotIndex * capacity + seat + 1;
}

function tokenCode(serviceCode, tokenNo) {
  return `${serviceCode}-${String(tokenNo).padStart(3, '0')}`;
}

module.exports = {
  MS_PER_MIN,
  toDateStr,
  isValidDateStr,
  dayStartMs,
  addDays,
  slotCount,
  slotStartMs,
  slotEndMs,
  slotLabel,
  clockLabel,
  minuteOfDay,
  minutesLabel,
  firstOpenSlotIndex,
  tokenNumber,
  tokenCode,
};
