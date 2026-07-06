const Stripe = require('stripe');
const { createUserByCustomerId, setUserPaidByCustomerId, cancelUserByStripe, markStripeEventProcessed } = require('./database');
const { sendWelcomeEmail, sendCancellationEmail, maskEmail } = require('./email');
 
let _stripe = null;
function getStripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured');
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  }
  return _stripe;
}
 
async function createCheckoutSession(successUrl, cancelUrl) {
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    payment_method_collection: 'always',
    locale: 'en',
    line_items: [{
      price: process.env.STRIPE_PRICE_ID,
      quantity: 1,
    }],
    subscription_data: {
      trial_period_days: 7,
    },
    allow_promotion_codes: true,
    custom_text: {
      submit: {
        message: 'Cancel anytime before day 7 and you won\'t be charged. After the free trial, €9.99/month is billed automatically until cancelled. By subscribing you agree to the Terms of Service (homeseeker.dev/terms) and Privacy Policy (homeseeker.dev/privacy), you request that the service starts immediately, and you acknowledge that your 14-day right of withdrawal lapses once the service has been provided. HomeSeeker is not affiliated with Funda or any housing platform.',
      },
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return session;
}
 
async function handleWebhook(payload, sig) {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = stripe.webhooks.constructEvent(payload, sig, webhookSecret);
  } catch (err) {
    throw new Error(`Webhook signature verification failed: ${err.message}`);
  }

  // Persisted in the DB (not an in-memory Set) so a webhook Stripe retries right after a
  // restart/redeploy is still recognised as a duplicate instead of being processed twice.
  if (!markStripeEventProcessed(event.id)) {
    console.log(`[stripe] Skipping duplicate event ${event.id}`);
    return event.type;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email || session.customer_details?.email;
    const customerId = session.customer;
    const subscriptionId = session.subscription;
 
    if (customerId) {
      const naam = session.customer_details?.name || '';
      createUserByCustomerId.run(naam, email || '', customerId, subscriptionId, Date.now());
      console.log(`[stripe] Trial started for customer ${customerId} (${maskEmail(email)})`);
      if (email) {
        sendWelcomeEmail(email, naam, customerId).catch(err => console.error('[email] Failed to send welcome email:', err));
      }
    }
  }
 
  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const subscription = event.data.object;
    const isActive = ['active', 'trialing'].includes(subscription.status);
    if (isActive) {
      setUserPaidByCustomerId.run(subscription.id, subscription.customer);
      console.log(`[stripe] Subscription ${subscription.status} for ${subscription.customer}`);
    } else {
      cancelUserByStripe.run(subscription.customer);
      console.log(`[stripe] Subscription ${subscription.status} — access revoked for ${subscription.customer}`);
    }
  }
 
  if (event.type === 'customer.subscription.deleted') {
    cancelUserByStripe.run(event.data.object.customer);
    console.log(`[stripe] Subscription deleted for ${event.data.object.customer}`);
    try {
      const customer = await getStripe().customers.retrieve(event.data.object.customer);
      if (customer && customer.email && !customer.deleted) {
        sendCancellationEmail(customer.email, customer.name || '').catch(e => console.error('[email] cancellation email failed:', e.message));
      }
    } catch (e) { console.error('[stripe] Could not retrieve customer for cancellation email:', e.message); }
  }
 
  if (event.type === 'invoice.payment_failed') {
    console.warn(`[stripe] Payment failed for customer ${event.data.object.customer}`);
  }
 
  return event.type;
}
 
async function cancelSubscription(subscriptionId) {
  const stripe = getStripe();
  await stripe.subscriptions.cancel(subscriptionId);
}
 
module.exports = { getStripe, createCheckoutSession, handleWebhook, cancelSubscription };
 