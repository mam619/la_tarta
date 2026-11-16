# La Tarta ordering system: setup guide

Pickup-only ordering: one cake per order, 2 Size S + 2 Size L a day (Wednesday to Sunday),
1-hour pickup slots 12:00–20:00 at Rua das Fontainhas, orders close at 18:00 two days before pickup,
payment by Stripe, Telegram alerts, confirmation and daily summary emails from Gmail.

## Update: November 2026 (La Tarta design, sizes, emails)

1. **Supabase → SQL Editor:** paste and run `supabase/migration-2-per-size.sql` once.
   Existing orders are kept.
2. **Netlify → Environment variables:** set `PICKUP_ADDRESS` to the full address customers see
   after paying (e.g. `Rua das Fontainhas 12, Alcântara, Lisboa. Ring the bell for La Tarta`).
   Make sure `GMAIL_USER`, `GMAIL_APP_PASSWORD` and `BRAND_NAME=La Tarta` are set.
3. **GitHub:** upload all files from this folder (they replace the old ones), then let Netlify deploy.

## What's in here

| File | What it does |
|---|---|
| `order.html` | The order page customers use |
| `order-confirmed.html` | Shown after payment, with the pickup address |
| `index.html` | Your site, with the "Order a BASCA" button now pointing to the order page |
| `netlify/functions/` | The backend: availability, checkout, Stripe webhook, cancel, confirmation, 18:00 summary |
| `netlify/lib/shared.mjs` | Shared code used by the functions |
| `supabase/schema.sql` | Database setup, run once |
| `netlify.toml`, `package.json` | Tell Netlify how to build the site |

**While testing, keep your current `index.html` live.** The new one sends customers to the
order page, so only switch to it when you go live. Until then, open `bascalisboa.com/order.html` directly.

---

## Step 1. Database (Supabase)

1. In your Supabase project, open **SQL Editor → New query**.
2. Paste the whole of `supabase/schema.sql` and click **Run**.
3. Go to **Project Settings → API** (or **API Keys**) and copy:
   - the **Project URL** → `SUPABASE_URL`
   - the **service_role** key (secret) → `SUPABASE_SERVICE_ROLE_KEY`

## Step 2. Stripe (test mode)

1. Make sure **Test mode** is on (toggle at the top of the dashboard).
2. **Developers → API keys**: copy the **Secret key** (`sk_test_...`) → `STRIPE_SECRET_KEY`.
3. **Settings → Payment methods**: turn on Cards, Apple Pay, Google Pay and MB WAY.
4. **Developers → Webhooks → Add endpoint**:
   - URL: `https://bascalisboa.com/api/stripe-webhook`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`, `checkout.session.expired`
   - After saving, copy the **Signing secret** (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`.

## Step 3. Telegram

1. In Telegram, message **@BotFather**, send `/newbot`, follow the prompts. Copy the token → `TELEGRAM_BOT_TOKEN`.
2. Open your new bot and send it any message (e.g. "hi").
3. In a browser, open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   and find `"chat":{"id":123456789`. That number → `TELEGRAM_CHAT_ID`.

## Step 4. GitHub and Netlify

1. Create a GitHub repository called `basca-site` (private is fine).
2. Upload everything from this folder **plus your existing site files** (videos, images, favicon)
   using **Add file → Upload files**. During testing, keep your old `index.html` (see above).
3. In Netlify, open your site → **Site configuration → Build & deploy → Link repository**, choose `basca-site`.
   Leave the build command empty and set the publish directory to `.`
4. **Site configuration → Environment variables**, add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | from Step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | from Step 1 |
| `STRIPE_SECRET_KEY` | from Step 2 |
| `STRIPE_WEBHOOK_SECRET` | from Step 2 |
| `TELEGRAM_BOT_TOKEN` | from Step 3 |
| `TELEGRAM_CHAT_ID` | from Step 3 |
| `PICKUP_ADDRESS` | your pickup address, as customers should see it after paying |

5. **Deploys → Trigger deploy → Deploy site**. Environment variables only apply after a new deploy.

## Step 5. Test it

1. Open `bascalisboa.com/order.html`, choose cakes, a day and a time, fill your details.
2. On Stripe, pay with test card `4242 4242 4242 4242`, any future expiry, any CVC.
3. Check that:
   - the confirmation page shows the order and pickup address
   - you get a Telegram message
   - Supabase **Table Editor → orders** shows the order as `paid`
   - that day now shows fewer cakes left on the order page
4. Start another order and press back on the Stripe page: the cakes should be released straight away.

Stripe doesn't email receipts in test mode. In live mode, turn on
**Settings → Customer emails → Successful payments**.

---

## Day-to-day (Supabase → Table Editor)

| To do this | Edit this table |
|---|---|
| Change the usual cakes per weekday | `weekly_capacity`: `size_s` and `size_l` columns |
| Close a day, or change one date's capacity | `date_overrides`: add a row with the date, `size_s` and `size_l` (both 0 = closed) |
| Change prices | `products` (in cents: 2400 = €24) |
| Change slot hours, cutoff, max cakes per order | `settings` |
| See orders | `orders` |

**Refunds:** refund in Stripe (open the payment → Refund), then set the order's `status` to
`refunded` in Supabase so the cakes go back into that day's capacity.

**18:00 summary:** each day at the cutoff time (Lisbon time), Telegram and your Gmail receive the
production list for the day whose orders just closed: sizes to bake, each order's slot, name, phone,
email, NIF and note.

**Stripe:** each payment carries the order's NIF, note and phone in its details (handy for invoicing).

## Going live

1. Finanças activity open and Stripe account activated with your NIF and IBAN.
2. In Stripe live mode: copy the live secret key, and create the same webhook again in live mode
   (it gets a new signing secret).
3. Replace `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in Netlify, upload the new `index.html`, redeploy.
4. In Supabase, delete your test orders from `orders`.
