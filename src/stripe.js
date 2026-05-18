const Stripe = require('stripe');
const { setUserPaid, cancelUserByStripe, getUserByEmail } = require('./database');
const { sendWelcomeEmail } = require('./email');

let _stripe = null;

function getStripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY not configured');
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-06-20',
    });
  }
  return _stripe;
}

async function createCheckoutSession(successUrl, cancelUrl) {
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [
      {
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1,
      },
    ],
    subscription_data: {
      trial_period_days: 7,
    },
    allow_promotion_codes: true,
    success_url: successUrl,
    cancel_url: cancelUrl,
    // email wordt door Stripe Checkout zelf ingevuld indien mogelijk
    customer_email: undefined,
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
    throw new Error(`HomeSeeker Stripe webhook signature failed: ${err.message}`);
  }

  // HomeSeeker: access direct on checkout completion (including trial)
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const email =
      session.customer_email || session.customer_details?.email;

    const customerId = session.customer;
    const subscriptionId = session.subscription;

    if (email) {
      setUserPaid.run(customerId, subscriptionId, email);

      const user = getUserByEmail.get(email);

      if (user) {
        sendWelcomeEmail(email, user.naam).catch(console.error);
      }

      console.log(`[HomeSeeker] Trial started for ${email} — access granted`);
    }
  }

  // Fallback: subscription created
  if (event.type === 'customer.subscription.created') {
    const subscription = event.data.object;

    const customerId = subscription.customer;
    const subscriptionId = subscription.id;

    try {
      const customer = await stripe.customers.retrieve(customerId);
      const email = customer.email;

      if (email) {
        setUserPaid.run(customerId, subscriptionId, email);
        console.log(
          `[HomeSeeker] Subscription created for ${email} — access granted`
        );
      }
    } catch (err) {
      console.error(
        `[HomeSeeker] Could not retrieve customer: ${err.message}`
      );
    }
  }

  // Cancellation
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;

    cancelUserByStripe.run(subscription.customer);

    console.log(
      `[HomeSeeker] Subscription cancelled for customer ${subscription.customer}`
    );
  }

  // Payment failure logging
  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;

    console.warn(
      `[HomeSeeker] Payment failed for customer ${invoice.customer}`
    );
  }

  return event.type;
}

async function cancelSubscription(subscriptionId) {
  const stripe = getStripe();
  await stripe.subscriptions.cancel(subscriptionId);
}

module.exports = {
  getStripe,
  createCheckoutSession,
  handleWebhook,
  cancelSubscription,
};