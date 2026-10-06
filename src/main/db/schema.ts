// Ordered migrations. Each entry runs once; the index + 1 is stored in PRAGMA user_version.
// Money is stored in piasters (1 EGP = 100) and quantities as whole units of the product's unit.
// Periods are identified by their month key 'YYYY-MM', so a ledger row can point at a month
// (for example an advance against next month) before that month has been opened.
export const migrations: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'clerk')),
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    unit TEXT NOT NULL,
    -- 'sugar' / 'oil' mark the products counted against the batch quantity limits
    limit_key TEXT UNIQUE CHECK (limit_key IN ('sugar', 'oil')),
    carryover_allowed INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE periods (
    month TEXT PRIMARY KEY CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    opened_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    opened_by INTEGER REFERENCES users(id),
    closed_at TEXT,
    closed_by INTEGER REFERENCES users(id)
  );

  -- Per-period configuration: entitlement quantities and card value by number of members, product prices.
  CREATE TABLE entitlement_rules (
    month TEXT NOT NULL,
    product_id INTEGER NOT NULL REFERENCES products(id),
    members INTEGER NOT NULL CHECK (members >= 1),
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    PRIMARY KEY (month, product_id, members)
  );

  CREATE TABLE card_value_rules (
    month TEXT NOT NULL,
    members INTEGER NOT NULL CHECK (members >= 1),
    value_piasters INTEGER NOT NULL CHECK (value_piasters >= 0),
    PRIMARY KEY (month, members)
  );

  CREATE TABLE product_prices (
    month TEXT NOT NULL,
    product_id INTEGER NOT NULL REFERENCES products(id),
    price_piasters INTEGER NOT NULL CHECK (price_piasters >= 0),
    PRIMARY KEY (month, product_id)
  );

  CREATE TABLE cards (
    id INTEGER PRIMARY KEY,
    card_number TEXT NOT NULL UNIQUE,
    holder_name TEXT NOT NULL,
    secret_ref TEXT,
    bakery TEXT,
    members INTEGER NOT NULL CHECK (members >= 1),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'cancelled')),
    group_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  CREATE INDEX cards_holder_name ON cards(holder_name);

  CREATE TABLE card_history (
    id INTEGER PRIMARY KEY,
    card_id INTEGER NOT NULL REFERENCES cards(id),
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    reason TEXT,
    user_id INTEGER REFERENCES users(id),
    changed_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  -- Members count frozen at the start of each month; entitlements of that month use it.
  CREATE TABLE card_monthly_snapshots (
    month TEXT NOT NULL,
    card_id INTEGER NOT NULL REFERENCES cards(id),
    members INTEGER NOT NULL,
    value_piasters INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (month, card_id)
  );

  -- Citizen rights ledger. Remaining for (card, month, product) = SUM(quantity). Rows are never updated
  -- or deleted: a void writes the opposite quantity with the same entry_type and ref_type 'void'.
  CREATE TABLE citizen_ledger (
    id INTEGER PRIMARY KEY,
    card_id INTEGER NOT NULL REFERENCES cards(id),
    month TEXT NOT NULL,
    product_id INTEGER NOT NULL REFERENCES products(id),
    entry_type TEXT NOT NULL CHECK (entry_type IN
      ('entitlement', 'pos_right', 'delivery', 'carry_in', 'carry_out', 'expire')),
    quantity INTEGER NOT NULL,
    ref_type TEXT,
    ref_id INTEGER,
    note TEXT,
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  CREATE INDEX citizen_ledger_card_month ON citizen_ledger(card_id, month, product_id);
  CREATE INDEX citizen_ledger_month ON citizen_ledger(month, entry_type);

  CREATE TABLE pos_batches (
    id INTEGER PRIMARY KEY,
    batch_number TEXT NOT NULL UNIQUE,
    month TEXT NOT NULL,
    institution TEXT,
    money_limit_piasters INTEGER NOT NULL,
    sugar_limit INTEGER NOT NULL,
    oil_limit INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE pos_transactions (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES pos_batches(id),
    card_id INTEGER NOT NULL REFERENCES cards(id),
    month TEXT NOT NULL,
    executed_at TEXT NOT NULL,
    total_piasters INTEGER NOT NULL,
    entitled_value_piasters INTEGER,
    -- positive: struck above card value (settlement difference); negative: shortfall
    difference_piasters INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
    void_reason TEXT,
    voided_by INTEGER REFERENCES users(id),
    voided_at TEXT,
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  CREATE INDEX pos_transactions_card_month ON pos_transactions(card_id, month);
  CREATE INDEX pos_transactions_batch ON pos_transactions(batch_id);

  CREATE TABLE pos_transaction_items (
    id INTEGER PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES pos_transactions(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_piasters INTEGER NOT NULL,
    line_total_piasters INTEGER NOT NULL
  );

  CREATE TABLE distributions (
    id INTEGER PRIMARY KEY,
    card_id INTEGER NOT NULL REFERENCES cards(id),
    month TEXT NOT NULL,
    distributed_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
    void_reason TEXT,
    voided_by INTEGER REFERENCES users(id),
    voided_at TEXT,
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  CREATE INDEX distributions_card_month ON distributions(card_id, month);

  CREATE TABLE distribution_items (
    id INTEGER PRIMARY KEY,
    distribution_id INTEGER NOT NULL REFERENCES distributions(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    -- month whose right this item is taken from; later than distributions.month means an advance
    applies_to_month TEXT NOT NULL
  );

  -- Stock = SUM(quantity). A reversal is the opposite quantity with the same tx_type, linked via reversed_by.
  CREATE TABLE inventory_transactions (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    tx_type TEXT NOT NULL CHECK (tx_type IN
      ('opening', 'receipt', 'distribution', 'return', 'damage', 'stocktake')),
    quantity INTEGER NOT NULL,
    tx_date TEXT NOT NULL,
    document_ref TEXT,
    ref_type TEXT,
    ref_id INTEGER,
    reversed_by INTEGER REFERENCES inventory_transactions(id),
    note TEXT,
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  CREATE INDEX inventory_transactions_product ON inventory_transactions(product_id, tx_date);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    details TEXT
  );
  CREATE INDEX audit_log_at ON audit_log(at);
  `
]
