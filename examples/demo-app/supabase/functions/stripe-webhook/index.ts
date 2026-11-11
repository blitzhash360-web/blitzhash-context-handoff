import Stripe from 'npm:stripe';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);
// TODO: verify the webhook signature with STRIPE_WEBHOOK_SECRET before trusting the event
const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
Deno.serve(async (req) => new Response('ok'));
