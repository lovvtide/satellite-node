const EventEmitter = require('events');
const Sqlite3 = require('better-sqlite3');
const path = require('path');
const fs = require('fs');


const Util = {

	// If filter key is indexable
	indexable: (key) => {
		return key[0] === '#' && key.length === 2;
	},

	pmap: (_p) => {
		return `(${_p.map(() => `?`).join(', ')})`;
	},

	// Filter keys mapped to event
	filterMap: {
		ids: 'id',
		kinds: 'kind',
		authors: 'pubkey'
	}
};

class Database extends EventEmitter {

	constructor (config = {}) {

		super();

		this.config = {
			directory: __dirname,
			name: 'events',
			...config
		};

		this.path = {
			main: path.join(this.config.directory, `${this.config.name}.db`),
			shm: path.join(this.config.directory, `${this.config.name}.db-shm`),
			wal: path.join(this.config.directory, `${this.config.name}.db-wal`)
		};

		// Detect architecture to pass the correct native sqlite module
		this.db = new Sqlite3(this.path.main, {

			// TODO these binaries should not be stored in this package,
			// they need to be moved to the electron app instead, and
			// the electron app needs to pass down the path to a folder
			// that contains a structure like


			// /arm64/better_sqlite3.node
			// /x86/better_sqlite3.node

			// Optionally use native bindings indicated by environment
			nativeBinding: process.env.NATIVE_BINDINGS_PATH ? path.join(
				process.env.NATIVE_BINDINGS_PATH,
				`${process.arch === 'arm64' ? 'arm64' : 'x64'}/better_sqlite3.node`
			) : undefined

			// nativeBinding: path.join(
			// 	__dirname,
			// 	`bin/${process.arch === 'arm64' ? 'arm64' : 'x86'}/better_sqlite3.node`
			// )
		});

		this.sub = {};

		if (config.wal !== false) {

			this.db.pragma('journal_mode = WAL');		
		}

		this.db.transaction(() => {

			// Create events table
			this.db.prepare(`
				CREATE TABLE IF NOT EXISTS events (
					id TEXT(64) PRIMARY KEY,
					created_at INTEGER,
					pubkey TEXT(64),
					sig TEXT(128),
					kind INTEGER,
					content TEXT,
					tags TEXT
				)
			`).run();

			// Create tags table
			this.db.prepare(`
				CREATE TABLE IF NOT EXISTS tags (
					i INTEGER PRIMARY KEY AUTOINCREMENT,
					e TEXT(64) REFERENCES events(id),
					t TEXT(1),
					v TEXT
				)
			`).run();

			// Create indices
			const indices = [
				this.db.prepare('CREATE INDEX IF NOT EXISTS idx_created_at ON events(created_at)'),
				this.db.prepare('CREATE INDEX IF NOT EXISTS idx_pubkey ON events(pubkey)'),
				this.db.prepare('CREATE INDEX IF NOT EXISTS idx_kind ON events(kind)'),
				this.db.prepare('CREATE INDEX IF NOT EXISTS idx_e ON tags(e)'),
				this.db.prepare('CREATE INDEX IF NOT EXISTS idx_t ON tags(t)'),
				this.db.prepare('CREATE INDEX IF NOT EXISTS idx_v ON tags(v)')
			];

			indices.forEach(statement => statement.run());

		})();

		// if (config.reportInterval) {

		// 	this._status = setInterval(() => {

		// 		this.emit('status', {
		// 			size: this.size(),
		// 			count: this.count()
		// 		});

		// 	}, config.reportInterval);
		// }
	}

	addEvent (event, options = {}) {

		// Don't store ephemeral events in db,
		// just return the event directly
		if (
			!options.preserveEphemeral
			&& event.kind >= 20000
			&& event.kind < 30000
		) {

			return event;
		}

		const result = this.db.transaction(() => {

			const _result = this.db.prepare(`
				INSERT OR IGNORE INTO events (id, created_at, pubkey, sig, kind, content, tags)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).run([
				event.id,
				event.created_at,
				event.pubkey,
				event.sig,
				event.kind,
				event.content,
				JSON.stringify(event.tags)
			]);

			// If event inserted, index tags
			if (_result.changes) {

				for (let tag of event.tags) {

					if (tag[0].length === 1) {

						const _result = this.db.prepare(`
							INSERT INTO tags (e, t, v)
							VALUES (?, ?, ?)
						`).run([ event.id, tag[0], tag[1] ]);
					}
				}

				// By default, remove older replaceable
				// events and all their associated tags
				if (!options.preserveReplaceable) {

					let replaceable;

					if ( // Normal replaceable event
						event.kind === 0
						|| event.kind === 3
						|| (event.kind >= 10000 && event.kind < 20000)
					) {

						replaceable = this.db.prepare(`
							SELECT events.id, events.created_at FROM events
							WHERE kind = ? AND pubkey = ?
						`).all([
							event.kind,
							event.pubkey
						]);

					} else if (event.kind >= 30000 && event.kind < 40000) { // Parameterized

						for (let tag of event.tags) {

							if (tag[0] === 'd') {

								replaceable = this.db.prepare(`
									SELECT events.id, events.created_at FROM events
									INNER JOIN tags ON events.id = tags.e
									WHERE kind = ? AND pubkey = ? AND tags.t = ? AND tags.v = ?
								`).all([
									event.kind,
									event.pubkey,
									'd',
									tag[1]
								]);

								break;
							}
						}
					}

					// If found other events that may need to be replaced,
					// sort the events according to timestamp descending,
					// falling back to id lexical order ascending as per
					// NIP-01. Remove all non-most-recent events and tags.
					if (replaceable && replaceable.length > 1) {

						// console.log('found replaceable', replaceable);
						// console.log('for event', event.id, event.kind);

						const removeIds = replaceable.sort((a, b) => {
							return a.created_at === b.created_at ? a.id.localeCompare(b.id) : b.created_at - a.created_at;
						}).slice(1).map(item => {
							return item.id;
						});

						this.db.prepare(`
							DELETE FROM tags
							WHERE e IN ${Util.pmap(removeIds)}
						`).run(removeIds);

						this.db.prepare(`
							DELETE FROM events
							WHERE id IN ${Util.pmap(removeIds)}
						`).run(removeIds);

						// If the event that was just inserted was one of
						// the events that was removed, return null so to
						// indicate that the event was in effect *not*
						// upserted and thus, if using the DB for a nostr
						// relay, does not need to be pushed to clients
						if (removeIds.indexOf(event.id) !== -1) {

							return null;
						}
					}
				}
			}

			return _result;

		})();

		// Return record only if upserted
		return result && result.changes ? event : null;
	}

	removeEvent (params) {

		this.db.transaction(() => {

			this.db.prepare(`
				DELETE FROM tags
				WHERE e = ?
			`).run([
				params.id
			]);

			this.db.prepare(`
				DELETE FROM events
				WHERE id = ? AND pubkey = ?
			`).run([
				params.id,
				params.pubkey
			]);

		})();
	}

	addSubscription (subid, filters) {

		this.sub[subid] = filters.map(filter => {

			const match = {}

			for (let key of Object.keys(filter)) {

				if (Util.filterMap[key]) {

					match[key] = new Set(filter[key]);

				} else if (Util.indexable(key)) {

					match[key.slice(1)] = new Set(filter[key]);
				}
			}

			return match;

		});
	}

	removeSubscription (subid) {

		delete this.sub[subid];
	}

	queryEvents (filters) {

		const p = (_p) => { return `(${_p.map(() => `?`).join(', ')})`; };

		const results = filters.map(filter => {

			let sql = 'SELECT events.id, events.created_at, events.pubkey, events.sig, events.kind, events.content, events.tags FROM events';

			const conditions = [];
			const parameters = [];

			const tagQueries = Object.keys(filter).filter(t => {
				return Util.indexable(t);
			});

			if (tagQueries.length > 0) {

				sql += ' INNER JOIN tags ON events.id = tags.e';
			}

			if (typeof filter.since === 'number') {

				conditions.push(`created_at >= ?`);
				parameters.push(filter.since);
			}

			if (typeof filter.until === 'number') {

				conditions.push(`created_at < ?`);
				parameters.push(filter.until);
			}

			if (filter.ids) {

				conditions.push(`id IN ${Util.pmap(filter.ids)}`);
				parameters.push(...filter.ids);
			}

			if (filter.kinds) {

				conditions.push(`kind IN ${Util.pmap(filter.kinds)}`);
				parameters.push(...filter.kinds);
			}

			if (filter.authors) {

				conditions.push(`pubkey IN ${Util.pmap(filter.authors)}`);
				parameters.push(...filter.authors);
			}

			for (let t of tagQueries) {

				conditions.push(`tags.t = ?`);
				parameters.push(t.slice(1));

				conditions.push(`tags.v IN ${Util.pmap(filter[t])}`);
				parameters.push(...filter[t]);	
			}

			if (parameters.length > 0) {

				sql += ` WHERE ${conditions.join(' AND ')}`;
			}

			sql = sql + ' ORDER BY created_at DESC';

			if (filter.limit) {
				parameters.push(filter.limit);
				sql += ' LIMIT ?';
			}

			return this.db.prepare(sql).all(parameters);
		});

		let events;

		// For multiple filters, results need
		// to be merged to avoid duplicates
		if (results.length > 1) {

			const merged = {};

			for (let result of results) {
				for (let event of result) {
					merged[event.id] = event;
				}
			}

			// Return sorted unique array of
			// events that match any filter,
			// sorting deterministically by
			// created_at, falling back to id
			events = Object.keys(merged).map(id => {
				return merged[id];
			}).sort((a, b) => {
				const deltat = b.created_at - a.created_at;
				return deltat === 0 ? (parseInt(b, 16) - parseInt(a, 16)) : deltat;
			});

		} else {

			events = results[0];
		}

		events.forEach(event => {

			event.tags = JSON.parse(event.tags);
		});

		// Return events matching single filter
		return events;
	}

	matchSubscriptions (event) {

		const matched = [];
		const indexed = {};

		for (let tag of event.tags) {

			if (tag[0].length !== 1) { continue; }

			if (!indexed[tag[0]]) { indexed[tag[0]] = []; }

			indexed[tag[0]].push(tag[1]);
		}

		const match = (filter) => {

			for (let key of Object.keys(filter)) {

				if (Util.filterMap[key]) { // Authors, kinds, ids

					if (!filter[key].has(event[Util.filterMap[key]])) {
						return false;
					}

				} else if (indexed[key]) { // Single letter tags

					if (!indexed[key].some(item => filter[key].has(item))) {
						return false;
					}

				} else if (key === 'since') { // Since

					if (event.created_at < filter.since) {
						return false;
					}

				} else if (key === 'until') { // Until

					if (event.created_at >= filter.until) {
						return false;
					}

				} else {

					return false;
				}
			}

			return true;
		};

		for (let subid of Object.keys(this.sub)) {

			for (let filter of this.sub[subid]) {

				if (match(filter)) {

					matched.push(subid);
					break;
				}
			}
		}

		return matched;
	}

	// Delete all records in the database
	clear () {

		this.db.transaction(() => {

			this.db.prepare(`DELETE FROM tags`).run();
			this.db.prepare(`DELETE FROM events`).run();
			
		})();
	}

	// Get number of events in the database
	count () {

		const result = this.db.prepare(`SELECT COUNT(*) AS events FROM events`).get();

		return result.events;
	}

	// Get total size of the database on disk
	size () {

		let sum;

		try {

			const statMain = fs.statSync(this.path.main);
			const statShm = fs.statSync(this.path.shm);
			const statWal = fs.statSync(this.path.wal);

			sum = statMain.size + statShm.size + statWal.size;

		} catch (err) {
			console.log(err);
		}

		return sum;
	}

	stop () {

		this.removeAllListeners()
	}
}

module.exports = Database;
