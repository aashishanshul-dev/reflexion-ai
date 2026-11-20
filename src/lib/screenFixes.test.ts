import test from 'node:test';
import assert from 'node:assert/strict';
import { pickDefaultChatPhone } from './simulatorChat';
import { triggerDailyOverviewCron } from './opsEngine';
import { createDemoSeedState } from './demoData';

const NOW = '2026-11-19T08:39:00.000Z'; // 14:09 in India
const NITIN = '919820100006';
const PRIYA = '919820100002';
const KAVITA = '919820100007';

test('WhatsApp panel opens on the person whose messages are waiting (the unread badge)', () => {
  const state = createDemoSeedState(NOW);
  const staff = Object.values(state.team_members)
    .filter((m) => m.authorityLevel !== 'OWNER')
    .map((m) => m.phone);
  assert.equal(staff[0], PRIYA); // the old default
  assert.equal(pickDefaultChatPhone(state, staff), NITIN);
});

test('with nothing waiting: whoever wrote last, else the first staff member', () => {
  const state = createDemoSeedState(NOW);
  const noBuffer = { ...state, inbound_message_buffer: {} };
  const lastInbound = [...state.whatsapp_messages]
    .filter((m) => m.direction === 'INBOUND')
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .at(-1)!;
  assert.equal(pickDefaultChatPhone(noBuffer, [PRIYA]), lastInbound.employeePhone);
  assert.equal(
    pickDefaultChatPhone({ ...noBuffer, whatsapp_messages: [] }, [KAVITA, PRIYA]),
    KAVITA
  );
  // Waiting messages from an unknown number are ignored.
  const stranger = {
    ...noBuffer,
    whatsapp_messages: [],
    inbound_message_buffer: {
      '911111111111': {
        employeePhone: '911111111111',
        bufferMode: 'STANDARD_15_MIN' as const,
        firstMessageAt: NOW,
        processAt: NOW,
        messages: [{ id: 'x', timestamp: NOW, type: 'text' as const, textContent: 'hi' }],
      },
    },
  };
  assert.equal(pickDefaultChatPhone(stranger, [PRIYA]), PRIYA);
});

test('Shift digest reports who got it, and uses the business day (not UTC)', () => {
  const state = createDemoSeedState(NOW);
  const res = triggerDailyOverviewCron(state, NOW);
  assert.equal(res.recipientNames.length, res.digestsSent);
  assert.ok(res.digestsSent > 0);
  assert.ok(res.recipientNames.includes('Nitin Sharma'));
  const nitinDigest = res.nextState.whatsapp_messages.find(
    (m) => m.tag === 'DAILY_DIGEST' && m.employeePhone === NITIN
  )!;
  assert.match(nitinDigest.text, /^☀️ Good Morning Nitin bhai, /);
  assert.match(nitinDigest.text, /19 Nov, 11:00/);

  // 00:30 in India is still the previous day in UTC: recurring tasks due "yesterday" (India)
  // must expire, which only happens when "today" is the business day.
  const justAfterMidnightIst = '2026-11-19T19:00:00.000Z'; // 2026-11-20 00:30 IST
  const later = triggerDailyOverviewCron(
    {
      ...state,
      tasks: state.tasks.map((t, i) =>
        i === 0 ? { ...t, taskFrequency: 'RECURRING', recurrenceRule: 'DAILY', dueDate: '2026-11-19' } : t
      ),
    },
    justAfterMidnightIst
  );
  assert.ok(later.expiredCount >= 1);
});
