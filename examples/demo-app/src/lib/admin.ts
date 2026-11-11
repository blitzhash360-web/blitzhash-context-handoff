import { createClient } from '@supabase/supabase-js';

// TODO: this runs in the browser. Move admin actions to an Edge Function.
export const admin = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY);
