import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { buzz, playChime } from '../lib/chime';

/**
 * How many orders are waiting to ship, and how many arrived since the packer
 * last looked - for the badge on the packing tab, wherever they are in the
 * CRM.
 *
 * "Last looked" is the moment the packing screen was last open on this
 * device, kept in localStorage. A new order (an insert on orders) chimes and
 * buzzes for people who ship, unless they turned the sound off.
 */

export const QUEUE_SEEN_KEY = 'duch.queue.seenAt';
export const QUEUE_SOUND_KEY = 'duch.queue.sound';
export const QUEUE_SEEN_EVENT = 'duch:queue-seen';

const TO_SHIP = ['awaiting_confirmation', 'confirmed', 'ready_to_pack', 'packed', 'awaiting_pickup'];

export function readSeenAt(): string {
  try {
    return localStorage.getItem(QUEUE_SEEN_KEY) ?? new Date(0).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** Marks every waiting order as seen on this device. */
export function markQueueSeen() {
  try {
    localStorage.setItem(QUEUE_SEEN_KEY, new Date().toISOString());
  } catch {
    // Without storage the badge just keeps counting; nothing breaks.
  }
  window.dispatchEvent(new Event(QUEUE_SEEN_EVENT));
}

export function readSoundOn(): boolean {
  try {
    return localStorage.getItem(QUEUE_SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function useQueueAlert({ enabled, alerts }: { enabled: boolean; alerts: boolean }) {
  const [waiting, setWaiting] = useState<Array<{ order_id: string; created_at: string }>>([]);
  const [seenAt, setSeenAt] = useState(readSeenAt);
  const [soundOn, setSoundOn] = useState(readSoundOn);
  const soundRef = useRef(soundOn);
  soundRef.current = soundOn;

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from('v_packing_queue')
      .select('order_id, created_at')
      .in('fulfillment_status', TO_SHIP)
      .limit(500);
    setWaiting((data ?? []) as Array<{ order_id: string; created_at: string }>);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase
      .channel('nav-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
        const fresh = payload.new as { fulfillment_status?: string } | undefined;
        if (
          alerts &&
          payload.eventType === 'INSERT' &&
          TO_SHIP.includes(fresh?.fulfillment_status ?? '') &&
          soundRef.current
        ) {
          playChime();
          buzz();
        }
        // A burst of changes (a sale writes several rows) reloads once.
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(), 400);
      })
      .subscribe();

    // The live connection can drop on a phone that slept; this catches up.
    const poll = setInterval(() => void refresh(), 60_000);

    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [enabled, alerts, refresh]);

  useEffect(() => {
    const update = () => setSeenAt(readSeenAt());
    window.addEventListener(QUEUE_SEEN_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(QUEUE_SEEN_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);

  // As times, not text: the database writes "+00:00", the browser "Z".
  const seenTime = Date.parse(seenAt);
  const unseen = waiting.filter((order) => Date.parse(order.created_at) > seenTime).length;

  const toggleSound = useCallback(() => {
    setSoundOn((current) => {
      const next = !current;
      try {
        localStorage.setItem(QUEUE_SOUND_KEY, next ? 'on' : 'off');
      } catch {
        // Kept for this visit only.
      }
      if (next) playChime();
      return next;
    });
  }, []);

  return { waiting: waiting.length, unseen, soundOn, toggleSound };
}
