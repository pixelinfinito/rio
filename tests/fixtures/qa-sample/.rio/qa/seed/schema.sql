CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, persona TEXT UNIQUE, email TEXT UNIQUE NOT NULL, password_hash TEXT, verified INTEGER NOT NULL DEFAULT 0, address TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id));
CREATE TABLE IF NOT EXISTS cart (session TEXT NOT NULL, product_id INTEGER REFERENCES products(id), quantity INTEGER NOT NULL, PRIMARY KEY(session, product_id));
CREATE TABLE IF NOT EXISTS verifications (token TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id));
CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, user_id INTEGER, email TEXT NOT NULL, address TEXT NOT NULL, total INTEGER NOT NULL);
INSERT OR IGNORE INTO users(id,persona,email,verified,address) VALUES (1,'shopper','shopper@example.test',1,'10 Example Lane, Test City'),(2,'admin','admin@example.test',1,'');
INSERT OR IGNORE INTO products VALUES (1,'Canvas bag',2400),(2,'Notebook',800),(3,'Travel mug',1600);
