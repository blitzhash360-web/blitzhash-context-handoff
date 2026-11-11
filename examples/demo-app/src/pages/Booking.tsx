import { supabase } from '../lib/supabase';

export default function Booking() {
  // FIXME: double bookings when two people pick the same slot at once
  return <div className="p-4">Book a slot</div>;
}
