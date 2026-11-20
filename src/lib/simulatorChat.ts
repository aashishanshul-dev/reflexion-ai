/**
 * Which chat the WhatsApp panel opens on: the person whose messages are waiting
 * (the unread badge counts these), oldest first; else whoever wrote last; else
 * the first staff member.
 */
import type { OpsDatabaseState } from '../types/ops.ts';

export function pickDefaultChatPhone(
  state: Pick<OpsDatabaseState, 'inbound_message_buffer' | 'whatsapp_messages' | 'team_members'>,
  staffPhones: string[]
): string {
  const known = new Set(Object.keys(state.team_members || {}));
  const waiting = Object.values(state.inbound_message_buffer || {})
    .filter((b) => b && known.has(b.employeePhone) && (b.messages?.length || 0) > 0)
    .sort((a, b) => (a.firstMessageAt || '').localeCompare(b.firstMessageAt || ''));
  if (waiting.length > 0) return waiting[0].employeePhone;

  let latest: { phone: string; ts: string } | null = null;
  for (const m of state.whatsapp_messages || []) {
    if (m.direction !== 'INBOUND' || !known.has(m.employeePhone)) continue;
    if (!latest || (m.timestamp || '') > latest.ts) latest = { phone: m.employeePhone, ts: m.timestamp || '' };
  }
  if (latest) return latest.phone;

  return staffPhones[0] || Object.keys(state.team_members || {})[0] || '';
}
