# Discord Payments Bot

An open-source Discord bot for selling digital goods through Mercado Pago. It verifies signed payment notifications, validates each payment against the internal order, reserves stock transactionally, and delivers one item by direct message after approval.

## Requirements

- Node.js 20 or newer
- A Discord bot invited with the `bot` and `applications.commands` scopes
- A Mercado Pago application and access token
- A public HTTPS endpoint for Mercado Pago webhooks

## Setup

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env` and set the Discord and Mercado Pago values.
3. Set `MP_COLLECTOR_ID` to the receiving Mercado Pago account ID. This value is required for payment validation.
4. Configure Mercado Pago notifications to use the HTTPS URL ending in `/webhooks/mercadopago`.
5. Forward that endpoint to the port configured by `PORT`.
6. Start the bot with `npm start`.

Use test credentials and a staging URL before processing real payments. Keep `.env`, `payments.db`, and all stock data out of version control.

## Commands

- `/productcreate` creates or updates a product and its price.
- `/stockadd` opens a private form for adding up to 100 stock items.
- `/stockview` displays available, reserved, and delivered stock.
- `/productdisable` prevents new purchases for a product.
- `/products` lists active products.
- `/buy` creates a Mercado Pago checkout and reserves one stock item for 30 minutes.
- `/deliveryretry` retries delivery for an approved purchase.

Administrative commands require Discord administrator permission or the role configured in `ADMIN_ROLE_ID`.

## Payment and delivery flow

The bot never approves a payment from a screenshot or user-submitted proof. It accepts a payment only after receiving a signed Mercado Pago notification and retrieving the payment directly from the Mercado Pago API. The amount, currency, collector account, external reference, and stock reservation are checked before delivery.

Delivery failures are retried automatically a limited number of times. Webhook timestamps older than five minutes are rejected to reduce replay risk. Refunds and chargebacks generate an administrator alert and require manual access review.

## Validation

```bash
npm run check
npm audit
```

Before production use, configure HTTPS, restrict server access, back up the SQLite database, rotate secrets if exposed, and test approved, rejected, expired, refunded, duplicate, and undeliverable payments.
