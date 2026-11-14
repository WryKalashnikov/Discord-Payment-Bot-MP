require('dotenv').config();

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionsBitField,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const config = {
  token: process.env.TOKEN,
  guildId: process.env.GUILD_ID,
  adminRoleId: process.env.ADMIN_ROLE_ID,
  adminChannelId: process.env.ADMIN_CHANNEL_ID,
  mpAccessToken: process.env.MP_ACCESS_TOKEN,
  mpWebhookSecret: process.env.MP_WEBHOOK_SECRET,
  mpWebhookUrl: process.env.MP_WEBHOOK_URL,
  mpCollectorId: process.env.MP_COLLECTOR_ID,
  currency: (process.env.MP_CURRENCY_ID || 'BRL').toUpperCase(),
  port: Number(process.env.PORT || 3000)
};

function validateConfig() {
  const required = ['token', 'mpAccessToken', 'mpWebhookSecret', 'mpWebhookUrl', 'mpCollectorId'];
  const missing = required.filter(key => !config[key]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  const webhookUrl = new URL(config.mpWebhookUrl);
  if (webhookUrl.protocol !== 'https:') throw new Error('MP_WEBHOOK_URL must use HTTPS.');
  if (!/^[A-Z]{3}$/.test(config.currency)) throw new Error('MP_CURRENCY_ID must be a three-letter currency code.');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT is invalid.');
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: config.currency });
}

const db = new Database(path.join(__dirname, 'payments.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT,
    price_usd REAL,
    ltc_address TEXT,
    paypal_email TEXT,
    price_minor INTEGER,
    currency TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    product_id TEXT,
    method TEXT,
    proof_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_message_id TEXT,
    timestamp INTEGER,
    mp_preference_id TEXT,
    mp_payment_id TEXT,
    external_reference TEXT,
    reserved_stock_id INTEGER,
    amount_minor INTEGER,
    currency TEXT,
    created_at INTEGER,
    expires_at INTEGER,
    delivered_at INTEGER,
    failure_reason TEXT
  );
  CREATE TABLE IF NOT EXISTS stock_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL,
    item TEXT NOT NULL,
    reserved_payment_id INTEGER UNIQUE,
    delivered_at INTEGER
  );
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(entry => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

for (const [column, definition] of [
  ['price_minor', 'INTEGER'],
  ['currency', 'TEXT'],
  ['active', 'INTEGER NOT NULL DEFAULT 1']
]) ensureColumn('products', column, definition);

db.prepare(`UPDATE products SET active = 0
  WHERE price_minor IS NULL AND price_usd IS NOT NULL`).run();

for (const [column, definition] of [
  ['mp_preference_id', 'TEXT'],
  ['mp_payment_id', 'TEXT'],
  ['external_reference', 'TEXT'],
  ['reserved_stock_id', 'INTEGER'],
  ['amount_minor', 'INTEGER'],
  ['currency', 'TEXT'],
  ['created_at', 'INTEGER'],
  ['expires_at', 'INTEGER'],
  ['delivered_at', 'INTEGER'],
  ['delivery_claimed_at', 'INTEGER'],
  ['delivery_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['next_delivery_attempt_at', 'INTEGER'],
  ['failure_reason', 'TEXT']
]) ensureColumn('payments', column, definition);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS payments_external_reference
    ON payments(external_reference) WHERE external_reference IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS payments_mp_payment_id
    ON payments(mp_payment_id) WHERE mp_payment_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS stock_available
    ON stock_items(product_id, reserved_payment_id, delivered_at);
`);
db.prepare(`UPDATE products SET price_minor = CAST(ROUND(price_usd * 100) AS INTEGER)
  WHERE price_minor IS NULL AND price_usd IS NOT NULL`).run();
db.prepare(`UPDATE products SET currency = ? WHERE currency IS NULL`).run(config.currency);
db.prepare(`UPDATE payments SET created_at = timestamp WHERE created_at IS NULL AND timestamp IS NOT NULL`).run();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const PURCHASE_TTL_MS = 30 * 60 * 1000;
const API_BASE = 'https://api.mercadopago.com';

function formatPrice(minor, currency = config.currency) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(minor / 100);
}

function isAdmin(interaction) {
  return Boolean(
    interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ||
    (config.adminRoleId && interaction.member?.roles?.cache?.has(config.adminRoleId))
  );
}

function requireAdmin(interaction) {
  if (isAdmin(interaction)) return false;
  interaction.reply({ content: 'This command requires administrator permission.', ephemeral: true });
  return true;
}

async function mpRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.mpAccessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    },
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Mercado Pago API returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function notifyAdmins(message) {
  if (!config.adminChannelId) return;
  try {
    const channel = await client.channels.fetch(config.adminChannelId);
    if (channel?.isTextBased()) {
      await channel.send({ content: message, allowedMentions: { parse: [] } });
    }
  } catch (error) {
    console.error('Could not notify the configured admin channel:', error.message);
  }
}

const createProduct = new SlashCommandBuilder()
  .setName('productcreate')
  .setDescription('Create or update a product')
  .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands)
  .addStringOption(option => option.setName('id').setDescription('Short ID without spaces').setRequired(true).setMaxLength(32))
  .addStringOption(option => option.setName('nome').setDescription('Product name').setRequired(true).setMaxLength(100))
  .addNumberOption(option => option.setName('preco').setDescription(`Price in ${config.currency}`).setRequired(true).setMinValue(0.01).setMaxValue(1000000));

const addStock = new SlashCommandBuilder()
  .setName('stockadd')
  .setDescription('Add digital items to stock, one item per line')
  .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands)
  .addStringOption(option => option.setName('produto').setDescription('Product ID').setRequired(true).setMaxLength(32))
  .addBooleanOption(option => option.setName('confirmar').setDescription('Open the private stock form').setRequired(true));

const commands = [
  createProduct,
  addStock,
  new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Purchase an available product')
    .addStringOption(option => option.setName('produto').setDescription('Product ID').setRequired(true).setMaxLength(32)),
  new SlashCommandBuilder()
    .setName('products')
    .setDescription('List available products'),
  new SlashCommandBuilder()
    .setName('stockview')
    .setDescription('View product stock')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands)
    .addStringOption(option => option.setName('produto').setDescription('Product ID').setRequired(true).setMaxLength(32)),
  new SlashCommandBuilder()
    .setName('productdisable')
    .setDescription('Disable a product')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands)
    .addStringOption(option => option.setName('produto').setDescription('Product ID').setRequired(true).setMaxLength(32)),
  new SlashCommandBuilder()
    .setName('deliveryretry')
    .setDescription('Retry delivery for an approved purchase')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.UseApplicationCommands)
  .addIntegerOption(option => option.setName('pagamento').setDescription('Internal payment ID').setRequired(true).setMinValue(1))
].map(command => command.toJSON());

async function handleProductCreate(interaction) {
  if (requireAdmin(interaction)) return;
  const id = interaction.options.getString('id').trim().toLowerCase();
  const name = interaction.options.getString('nome').trim();
  const price = interaction.options.getNumber('preco');
  if (!/^[a-z0-9_-]{1,32}$/.test(id) || !name || name.length > 100) {
    return interaction.reply({ content: 'Invalid product ID or name.', ephemeral: true });
  }
  const priceMinor = Math.round(price * 100);
  if (!Number.isSafeInteger(priceMinor) || priceMinor < 1) {
    return interaction.reply({ content: 'Invalid price.', ephemeral: true });
  }
  try {
    db.prepare(`INSERT INTO products (id, name, price_usd, price_minor, currency, active)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, price_usd = excluded.price_usd,
        price_minor = excluded.price_minor, currency = excluded.currency, active = 1`)
      .run(id, name, priceMinor / 100, priceMinor, config.currency);
    await interaction.reply({ content: `Product **${name}** created/updated at ${formatPrice(priceMinor)}.`, ephemeral: true });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return interaction.reply({ content: 'A product with this ID already exists.', ephemeral: true });
    }
    throw error;
  }
}

async function handleStockAdd(interaction) {
  if (requireAdmin(interaction)) return;
  const productId = interaction.options.getString('produto').trim().toLowerCase();
  const product = db.prepare('SELECT id FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) return interaction.reply({ content: 'Product does not exist or is disabled.', ephemeral: true });
  if (!interaction.options.getBoolean('confirmar')) {
    return interaction.reply({ content: 'Confirm to open the private form.', ephemeral: true });
  }
  const button = new ButtonBuilder()
    .setCustomId(`stock_open:${productId}`)
    .setLabel('Enter stock in private form')
    .setStyle(ButtonStyle.Primary);
  await interaction.reply({
    content: 'Items are entered through a private form and delivered by DM after purchase.',
    components: [new ActionRowBuilder().addComponents(button)],
    ephemeral: true
  });
}

async function showStockModal(interaction, productId) {
  if (requireAdmin(interaction)) return;
  const product = db.prepare('SELECT id FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) return interaction.reply({ content: 'Product does not exist or is disabled.', ephemeral: true });
  const modal = new ModalBuilder()
    .setCustomId(`stock_submit:${productId}`)
    .setTitle('Add private stock');
  const input = new TextInputBuilder()
    .setCustomId('items')
    .setLabel('One item per line (up to 100)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function saveStockModal(interaction, productId) {
  if (requireAdmin(interaction)) return;
  const lines = interaction.fields.getTextInputValue('items').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 100 || lines.some(line => line.length > 1000)) {
    return interaction.reply({ content: 'Enter 1 to 100 items, with up to 1,000 characters per line.', ephemeral: true });
  }
  const product = db.prepare('SELECT id FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) return interaction.reply({ content: 'Product does not exist or is disabled.', ephemeral: true });
  const insert = db.prepare('INSERT INTO stock_items (product_id, item) VALUES (?, ?)');
  const transaction = db.transaction(items => {
    for (const item of items) insert.run(productId, item);
  });
  transaction(lines);
  await interaction.reply({ content: `${lines.length} item(s) added to private stock.`, ephemeral: true });
}

async function handleProducts(interaction) {
  const products = db.prepare(`
    SELECT p.id, p.name, p.price_minor, p.currency, COUNT(s.id) AS stock
    FROM products p LEFT JOIN stock_items s
      ON s.product_id = p.id AND s.reserved_payment_id IS NULL AND s.delivered_at IS NULL
    WHERE p.active = 1 GROUP BY p.id ORDER BY p.name LIMIT 20
  `).all();
  if (!products.length) return interaction.reply({ content: 'No products are currently available.', ephemeral: true });
  const description = products.map(product =>
    `**${product.name}** \`${product.id}\` - ${formatPrice(product.price_minor, product.currency)} - ${product.stock} available`
  ).join('\n');
  await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Products').setDescription(description).setColor(0x1f8b4c)], ephemeral: true });
}

async function createCheckout(interaction) {
  const productId = interaction.options.getString('produto').trim().toLowerCase();
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) return interaction.reply({ content: 'Product does not exist or is disabled.', ephemeral: true });
  if (!Number.isSafeInteger(product.price_minor) || product.price_minor < 1 || product.currency !== config.currency) {
    return interaction.reply({ content: 'Invalid price or currency configuration. Contact an administrator.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const now = Date.now();
  const expiresAt = now + PURCHASE_TTL_MS;
  let paymentId;
  const reserve = db.transaction(() => {
    const stock = db.prepare(`SELECT id FROM stock_items
      WHERE product_id = ? AND reserved_payment_id IS NULL AND delivered_at IS NULL ORDER BY id LIMIT 1`).get(productId);
    if (!stock) return null;
    const result = db.prepare(`INSERT INTO payments
      (user_id, product_id, method, status, timestamp, amount_minor, currency, created_at, expires_at)
      VALUES (?, ?, 'mercadopago', 'pending', ?, ?, ?, ?, ?)`)
      .run(interaction.user.id, productId, now, product.price_minor, product.currency, now, expiresAt);
    paymentId = Number(result.lastInsertRowid);
    const reference = `dsc-${crypto.randomUUID()}`;
    db.prepare('UPDATE payments SET external_reference = ? WHERE id = ?').run(reference, paymentId);
    const claim = db.prepare(`UPDATE stock_items SET reserved_payment_id = ?
      WHERE id = ? AND reserved_payment_id IS NULL AND delivered_at IS NULL`).run(paymentId, stock.id);
    if (claim.changes !== 1) throw new Error('Could not reserve stock atomically.');
    db.prepare('UPDATE payments SET reserved_stock_id = ? WHERE id = ?').run(stock.id, paymentId);
    return reference;
  });

  const externalReference = reserve();
  if (!externalReference) {
    return interaction.editReply({ content: 'This product is currently out of stock.' });
  }

  try {
    const preference = await mpRequest(`${API_BASE}/checkout/preferences`, {
      method: 'POST',
      body: JSON.stringify({
        items: [{ id: product.id, title: product.name, quantity: 1, currency_id: product.currency, unit_price: product.price_minor / 100 }],
        external_reference: externalReference,
        notification_url: config.mpWebhookUrl,
        expires: true,
        expiration_date_from: new Date(now).toISOString(),
        expiration_date_to: new Date(expiresAt).toISOString()
      })
    });
    const checkoutUrl = new URL(preference.init_point);
    if (checkoutUrl.protocol !== 'https:' || !preference.id) throw new Error('Mercado Pago returned an invalid checkout URL.');
    db.prepare('UPDATE payments SET mp_preference_id = ? WHERE id = ?').run(String(preference.id), paymentId);
    const button = new ButtonBuilder().setLabel('Pay with Mercado Pago').setStyle(ButtonStyle.Link).setURL(checkoutUrl.toString());
    await interaction.editReply({
      content: `Purchase **${product.name}** for **${formatPrice(product.price_minor, product.currency)}**. Stock is reserved for 30 minutes. Delivery occurs after Mercado Pago confirmation.`,
      components: [new ActionRowBuilder().addComponents(button)]
    });
  } catch (error) {
    db.transaction(() => {
      db.prepare('UPDATE stock_items SET reserved_payment_id = NULL WHERE reserved_payment_id = ?').run(paymentId);
      db.prepare("UPDATE payments SET status = 'failed', failure_reason = ? WHERE id = ? AND status = 'pending'")
        .run('checkout_creation_failed', paymentId);
    })();
    console.error('Could not create Mercado Pago checkout:', error.message);
    await interaction.editReply({ content: 'The payment could not be created. No charge was confirmed; please try again.' });
  }
}

async function handleStockView(interaction) {
  if (requireAdmin(interaction)) return;
  const productId = interaction.options.getString('produto').trim().toLowerCase();
  const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(productId);
  if (!product) return interaction.reply({ content: 'Product not found.', ephemeral: true });
  const counts = db.prepare(`SELECT
    SUM(CASE WHEN reserved_payment_id IS NULL AND delivered_at IS NULL THEN 1 ELSE 0 END) AS available,
    SUM(CASE WHEN reserved_payment_id IS NOT NULL AND delivered_at IS NULL THEN 1 ELSE 0 END) AS reserved,
    SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered
    FROM stock_items WHERE product_id = ?`).get(productId);
  await interaction.reply({
    content: `**${product.name}**: ${counts.available || 0} available, ${counts.reserved || 0} reserved, ${counts.delivered || 0} delivered.`,
    ephemeral: true
  });
}

async function handleProductDisable(interaction) {
  if (requireAdmin(interaction)) return;
  const productId = interaction.options.getString('produto').trim().toLowerCase();
  const result = db.prepare('UPDATE products SET active = 0 WHERE id = ? AND active = 1').run(productId);
  await interaction.reply({ content: result.changes ? 'Product disabled; pending purchases remain valid.' : 'Product not found or already disabled.', ephemeral: true });
}

function verifyWebhookSignature(request, paymentId) {
  const signatureHeader = request.headers['x-signature'];
  const requestId = request.headers['x-request-id'];
  if (typeof signatureHeader !== 'string' || typeof requestId !== 'string') return false;
  const values = Object.fromEntries(signatureHeader.split(',').map(part => {
    const [key, ...rest] = part.trim().split('=');
    return [key, rest.join('=')];
  }));
  if (!values.ts || !values.v1) return false;
  const timestamp = Number(values.ts);
  if (!Number.isInteger(timestamp) || Math.abs(Date.now() - timestamp * 1000) > 5 * 60 * 1000) return false;
  const manifest = `id:${String(paymentId).toLowerCase()};request-id:${requestId};ts:${values.ts};`;
  const expected = crypto.createHmac('sha256', config.mpWebhookSecret).update(manifest).digest();
  let received;
  try {
    received = Buffer.from(values.v1, 'hex');
  } catch {
    return false;
  }
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function cents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : NaN;
}

async function deliverPayment(paymentId) {
  const payment = db.prepare(`SELECT p.*, pr.name AS product_name, s.item AS delivery_item
    FROM payments p LEFT JOIN products pr ON pr.id = p.product_id
    LEFT JOIN stock_items s ON s.id = p.reserved_stock_id
    WHERE p.id = ?`).get(paymentId);
  if (!payment || payment.status !== 'approved' || payment.delivered_at || !payment.delivery_item) return;

  const now = Date.now();
  const claim = db.prepare(`UPDATE payments SET delivery_claimed_at = ?, delivery_attempts = delivery_attempts + 1,
      next_delivery_attempt_at = NULL, failure_reason = NULL
    WHERE id = ? AND delivered_at IS NULL AND
      delivery_attempts < 5 AND (next_delivery_attempt_at IS NULL OR next_delivery_attempt_at <= ?) AND
      (delivery_claimed_at IS NULL OR delivery_claimed_at < ?)`)
    .run(now, paymentId, now, now - 120_000);
  if (!claim.changes) return;
  try {
    const user = await client.users.fetch(payment.user_id);
    await user.send({
      content: `Payment confirmed. Your product **${payment.product_name || payment.product_id}**:\n\n${payment.delivery_item}`,
      allowedMentions: { parse: [] },
      nonce: `pay-${paymentId}`,
      enforceNonce: true
    });
    const deliveredAt = Date.now();
    db.transaction(() => {
      const stockUpdate = db.prepare('UPDATE stock_items SET delivered_at = ? WHERE id = ? AND reserved_payment_id = ? AND delivered_at IS NULL')
        .run(deliveredAt, payment.reserved_stock_id, paymentId);
      const paymentUpdate = db.prepare('UPDATE payments SET delivered_at = ?, delivery_claimed_at = NULL, failure_reason = NULL WHERE id = ? AND delivered_at IS NULL')
        .run(deliveredAt, paymentId);
      if (stockUpdate.changes !== 1 || paymentUpdate.changes !== 1) throw new Error('Delivery state changed concurrently.');
    })();
  } catch (error) {
    db.prepare(`UPDATE payments SET delivery_claimed_at = NULL, next_delivery_attempt_at = ?, failure_reason = ?
      WHERE id = ? AND delivered_at IS NULL`)
      .run(Date.now() + 5 * 60 * 1000, `delivery_failed:${String(error.code || error.message).slice(0, 100)}`, paymentId);
    await notifyAdmins(`Payment ${paymentId} was approved, but DM delivery failed. Use /deliveryretry ${paymentId} after verifying the user.`);
    console.error(`Delivery failed for payment ${paymentId}:`, error.message);
  }
}

async function verifyAndProcessPayment(payment) {
  if (!payment || !payment.id) throw new Error('Invalid payment payload from Mercado Pago.');
  const reference = payment.external_reference;
  const order = db.prepare('SELECT * FROM payments WHERE external_reference = ?').get(reference);
  if (!order) {
    console.warn('Mercado Pago notification has no matching order.');
    return;
  }
  const amountMatches = cents(payment.transaction_amount) === order.amount_minor;
  const currencyMatches = payment.currency_id === order.currency;
  const collectorMatches = !config.mpCollectorId || String(payment.collector_id) === config.mpCollectorId;
  const metadataMatches = !payment.metadata?.payment_id || Number(payment.metadata.payment_id) === order.id;
  if (!amountMatches || !currencyMatches || !collectorMatches || !metadataMatches) {
    await notifyAdmins(`Mercado Pago payment ${payment.id} does not match internal order ${order.id}; delivery blocked.`);
    console.error(`Payment validation mismatch for internal order ${order.id}.`);
    return;
  }

  if (payment.status !== 'approved') {
    if (['refunded', 'charged_back'].includes(payment.status) && order.status === 'approved') {
      await notifyAdmins(`WARNING: payment ${order.id} became ${payment.status} after approval. Review access and delivery manually.`);
    }
    return;
  }

  const approve = db.transaction(() => {
    const current = db.prepare('SELECT * FROM payments WHERE id = ?').get(order.id);
    if (!current) return current;
    if (current.status === 'approved') {
      return { ...current, duplicate_payment: String(current.mp_payment_id) !== String(payment.id) };
    }
    const stock = db.prepare('SELECT id FROM stock_items WHERE id = ? AND reserved_payment_id = ? AND delivered_at IS NULL')
      .get(current.reserved_stock_id, order.id);
    if (!stock) {
      db.prepare(`UPDATE payments SET status = 'approved', mp_payment_id = ?, failure_reason = 'approved_without_reserved_stock'
        WHERE id = ?`).run(String(payment.id), order.id);
      return { ...current, status: 'approved', failure_reason: 'approved_without_reserved_stock' };
    }
    db.prepare(`UPDATE payments SET status = 'approved', mp_payment_id = ?, failure_reason = NULL
      WHERE id = ? AND status = 'pending'`).run(String(payment.id), order.id);
    return { ...current, status: 'approved' };
  });
  const approved = approve();
  if (approved?.duplicate_payment) {
    await notifyAdmins(`CRITICAL: order ${order.id} received multiple approved payments (${approved.mp_payment_id} and ${payment.id}). Review and refund the duplicate charge.`);
    return;
  }
  if (approved?.failure_reason === 'approved_without_reserved_stock') {
    await notifyAdmins(`CRITICAL: payment ${order.id} was approved without reserved stock. Investigate immediately.`);
    return;
  }
  if (approved?.status === 'approved') await deliverPayment(order.id);
}

async function handleWebhook(request, response) {
  let rawBody = '';
  for await (const chunk of request) {
    rawBody += chunk;
    if (rawBody.length > 32768) {
      response.writeHead(413).end();
      return;
    }
  }
  let payload = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    response.writeHead(400).end();
    return;
  }
  const url = new URL(request.url, 'http://localhost');
  const paymentId = url.searchParams.get('data.id') || payload.data?.id;
  if (!paymentId || !verifyWebhookSignature(request, paymentId)) {
    response.writeHead(401).end();
    return;
  }
  try {
    const payment = await mpRequest(`${API_BASE}/v1/payments/${encodeURIComponent(paymentId)}`);
    await verifyAndProcessPayment(payment);
    response.writeHead(200).end('ok');
  } catch (error) {
    console.error('Mercado Pago webhook processing failed:', error.message);
    response.writeHead(503).end('retry');
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (request.method === 'POST' && request.url?.startsWith('/webhooks/mercadopago')) {
    await handleWebhook(request, response);
    return;
  }
  response.writeHead(404).end();
});

async function cleanExpiredCheckouts() {
  const expired = db.prepare(`SELECT * FROM payments WHERE status = 'pending' AND expires_at < ? AND mp_preference_id IS NOT NULL`).all(Date.now());
  for (const order of expired) {
    try {
      const searchUrl = new URL(`${API_BASE}/v1/payments/search`);
      searchUrl.searchParams.set('external_reference', order.external_reference);
      searchUrl.searchParams.set('sort', 'date_created');
      searchUrl.searchParams.set('criteria', 'desc');
      const results = await mpRequest(searchUrl.toString());
      if (results.results?.length) {
        let hasUnresolvedOrUnexpectedApproval = false;
        for (const result of results.results) {
          const current = await mpRequest(`${API_BASE}/v1/payments/${encodeURIComponent(result.id)}`);
          await verifyAndProcessPayment(current);
          if (!['rejected', 'cancelled', 'refunded', 'charged_back'].includes(current.status)) {
            hasUnresolvedOrUnexpectedApproval = true;
          }
        }
        const refreshed = db.prepare('SELECT status FROM payments WHERE id = ?').get(order.id);
        if (refreshed?.status === 'pending' && !hasUnresolvedOrUnexpectedApproval) {
          db.transaction(() => {
            db.prepare("UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'pending'").run(order.id);
            db.prepare('UPDATE stock_items SET reserved_payment_id = NULL WHERE reserved_payment_id = ? AND delivered_at IS NULL').run(order.id);
          })();
        }
        continue;
      }
      db.transaction(() => {
        db.prepare("UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'pending'").run(order.id);
        db.prepare('UPDATE stock_items SET reserved_payment_id = NULL WHERE reserved_payment_id = ? AND delivered_at IS NULL').run(order.id);
      })();
    } catch (error) {
      console.error(`Could not reconcile expired checkout ${order.id}:`, error.message);
    }
  }
}

async function retryUndeliveredPayments() {
  const pending = db.prepare(`SELECT id FROM payments WHERE status = 'approved' AND delivered_at IS NULL
    AND delivery_attempts < 5 AND (next_delivery_attempt_at IS NULL OR next_delivery_attempt_at <= ?)
    ORDER BY id LIMIT 25`).all(Date.now());
  for (const payment of pending) await deliverPayment(payment.id);
}

async function handleCommand(interaction) {
  switch (interaction.commandName) {
    case 'productcreate': return handleProductCreate(interaction);
    case 'stockadd': return handleStockAdd(interaction);
    case 'buy': return createCheckout(interaction);
    case 'products': return handleProducts(interaction);
    case 'stockview': return handleStockView(interaction);
    case 'productdisable': return handleProductDisable(interaction);
    case 'deliveryretry': {
      if (requireAdmin(interaction)) return;
      const paymentId = interaction.options.getInteger('pagamento');
      const payment = db.prepare('SELECT status, delivered_at FROM payments WHERE id = ?').get(paymentId);
      if (!payment || payment.status !== 'approved' || payment.delivered_at) {
        return interaction.reply({ content: 'Payment not found, not approved, or already delivered.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      db.prepare(`UPDATE payments SET delivery_attempts = 0, next_delivery_attempt_at = NULL
        WHERE id = ? AND status = 'approved' AND delivered_at IS NULL`).run(paymentId);
      await deliverPayment(paymentId);
      const updated = db.prepare('SELECT delivered_at, failure_reason FROM payments WHERE id = ?').get(paymentId);
      return interaction.editReply(updated.delivered_at ? 'Delivery sent by DM.' : `Delivery is still pending: ${updated.failure_reason || 'unknown error'}.`);
    }
    default: return interaction.reply({ content: 'Unknown command.', ephemeral: true });
  }
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`Bot online: ${readyClient.user.tag}`);
  const guild = config.guildId ? await readyClient.guilds.fetch(config.guildId).catch(() => null) : null;
  if (config.guildId && !guild) throw new Error('GUILD_ID is set, but the bot cannot access that server.');
  if (guild) await guild.commands.set(commands);
  else await readyClient.application.commands.set(commands);
  console.log(`Registered ${commands.length} slash commands.`);
  await cleanExpiredCheckouts();
  await retryUndeliveredPayments();
  setInterval(() => {
    cleanExpiredCheckouts().catch(error => console.error('Checkout reconciliation failed:', error.message));
    retryUndeliveredPayments().catch(error => console.error('Delivery retry failed:', error.message));
  }, 60_000);
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (config.guildId && interaction.guildId !== config.guildId) {
      return interaction.reply({ content: 'This bot is not configured for this server.', ephemeral: true });
    }
    if (interaction.isButton() && interaction.customId.startsWith('stock_open:')) {
      return await showStockModal(interaction, interaction.customId.slice('stock_open:'.length));
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('stock_submit:')) {
      return await saveStockModal(interaction, interaction.customId.slice('stock_submit:'.length));
    }
    if (!interaction.isChatInputCommand()) return;
    await handleCommand(interaction);
  } catch (error) {
    console.error('Interaction failed:', error);
    const message = 'An error occurred while processing the command. No manual approval will be performed.';
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
  }
});

client.on('error', error => console.error('Discord client error:', error));
process.on('unhandledRejection', error => console.error('Unhandled promise rejection:', error));
process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

try {
  validateConfig();
  server.listen(config.port, '0.0.0.0', () => console.log(`Webhook server listening on port ${config.port}.`));
  client.login(config.token);
} catch (error) {
  console.error('Startup configuration error:', error.message);
  process.exit(1);
}

