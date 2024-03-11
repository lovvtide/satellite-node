const EventEmitter = require('events');
const { verifyEvent } = require('nostr-tools');
// const { WebSocketServer } = require('ws');
const crypto = require('crypto');


class Relay extends EventEmitter {

	constructor (database, config = {}) {

		super();

		this.config = {
			//port: 2001,
			...config
		};

		// Create a map of subscriptions
		// in the form <subid> : <connid>
		this.subscriptions = {};

		// Create a map of connections
		// in the form <connid> : <ws>
		this.connections = {};

		// Optional event handlers
		this.eventHandlers = {};

		// Data persistance api
		this.database = database;

		// // Create websocket server
		// this.wss = new WebSocketServer({
		// 	port: parseInt(config.port)
		// });

		// // Fix CORS
		// this.wss.on('headers', (headers, request) => {
		// 	headers.push('Access-Control-Allow-Origin: *');
		// });

		// // Setup handlers for new connections
		// this.wss.on('connection', (ws, req) => {

		// 	if (!this.config.connect(ws, req)) { return; }

		// 	// Handle new connection
		// 	const conn = this.connect(ws, req);

		// 	if (!conn) { return; }

		// 	ws.on('message', (buffer) => {

		// 		this.message(buffer, conn);
		// 	});

		// 	ws.on('close', () => {

		// 		this.disconnect(ws);
		// 	});

		// });
	}

	message (buffer, conn) {

		let data;

		try {

			// TODO enforce max size

			// Parse JSON from the raw buffer
			data = JSON.parse(buffer.toString());

			// Pass the data to appropriate handler
			switch (data[0]) {

				// TODO handle auth

				// Clients creating a subscription
				case 'REQ':
					this.req(data, conn);
					break;

				// Clients publishing an event
				case 'EVENT':

					// TODO enforce event max size
					
					this.event(data, conn);
					break;

				// Clients canceling subscription
				case 'CLOSE':
					this.unsub(data, conn);
					break;

				// Control node on authenticated connection
				case 'CONTROL':
					this.control(data, conn);
					break;

				default:
					break;
			}

		} catch (err) {

			console.log(err);
		}

		return data;
	}

	control (data, conn) {

		if (!this.config.controlApi) { return; }

		// Get websocket associated with connection
		const ws = this.connections[conn.id];

		//Return id linked connection not found
		if (!ws) { return; }

		// Maybe authorize connection - maintain a flag or most recent
		// auth status on each websocket so that config updates can
		// be forwarded to multiple simultaneous control connections.
		// Send client a notice when its auth state changes.
		if (this.config.controlAuth && this.config.controlAuth(data[1])) {

			ws.authorized = true;

		} else {

			ws.authorized = false;
			return;
		}

		// Invoke the action, sending response
		// to each active control connection
		this.config.controlApi(data[2], data[3]);
	}

	// Broadcast payload to connected clients
	broadcast (payload, options = {}) {

		if (!payload) { return; }

		// Allow option for user specified broadcast mode
		const response = JSON.stringify([ options.mode, payload ]);

		let _ws;

		for (let id of Object.keys(this.connections)) {

			// Get websocket associated with connection
			_ws = this.connections[id];

			if (!_ws) { return; }

			// Allow option to only broadcast to authorized clients
			if (_ws.authorized || !options.authorized) {

				_ws.send(response);
			}
		}
	}

	connect (ws, req) {

		let ip;

		// Record the IP address of the client
		if (req.headers['x-forwarded-for']) {

			ip = req.headers['x-forwarded-for'].split(',')[0].trim();

		} else {

			ip = req.socket.remoteAddress;
		}

		// Generate a unique ID for ws connection
		const id = crypto.randomUUID();

		// Save a reference to the connection
		this.connections[id] = ws;

		// Attach the id to the websocket itself
		ws.id = id;

		// Init array of linked subscriptions
		ws.subids = [];

		// Set default alive
		ws.isAlive = true;

		// Mark alive on client response
		ws.on('pong', () => { ws.isAlive = true; });

		// Create interval to check connection status
		ws.kai = setInterval(() => {

			// If the connection is inactive, remove it
			if (ws.isAlive === false) {

				return ws.terminate();
			}

			// Invalidate alive status
			ws.isAlive = false;

			// Challeng client to revalidate
			ws.ping();

		}, this.config.heartbeatInterval ? parseInt(this.config.heartbeatInterval) : 60000);

		// Return model of the connection
		return { id, ip, opened: Math.floor(Date.now() / 1000) };
	}

	disconnect (ws) {

		if (this.connections[ws.id]) {

			// Remove in-memory mapping
			delete this.connections[ws.id];

			// Clear keepalive interval
			clearInterval(ws.kai);

			// Find subscriptions on this connection
			for (let subid of ws.subids) {

				if (this.subscriptions[subid]) {

					// Delete memory reference and
					// mark for database removal
					delete this.subscriptions[subid];

					// Remove subscription model from the DB
					this.database.removeSubscription(subid);
				}
			}
		}
	}

	event (data, conn, options = {}) {

		//console.log('relay event()', data);

		// Get the event data
		const event = data[1];

		let inserted = null;
		let okstatus = true;
		let message = '';

		// Verify the event's signature
		if (options.skipVerification || verifyEvent(event)) {

			try {

				// Persist to database
				inserted = this.database.addEvent(event);

			} catch (err) {

				console.log(err);

				okstatus = false;

				switch (err.code) {

					// case 413: // Event too large
					// 	message = `invalid: event exceeds max size (${this.config.eventMaxSize} bytes)`;
					// 	break;

					default: // Unknown error
						message = 'error: server error';
				}
			}

		} else { // Failed to verify

			okstatus = false;
			message = `invalid: event failed to validate or verify`;
		}

		if (okstatus) { // Event received successfully

			this.emit('event:received', { event, conn });

		} else { // Event not received successfully

			// TODO differeniate failure modes by code
			this.emit('event:rejected', { event, conn });
		}

		if (conn) {

			// Get a reference to sender's connection
			const sws = this.connections[conn.id];

			if (sws) { // Send NIP-20 'OK' message

				sws.send(JSON.stringify([ 'OK', event.id, okstatus, message ]));
			}
		}

		// If new event, look for active subscriptions
		// that might need the event pushed to them
		if (inserted) {

			this.emit('event:inserted', event, conn);

			const matched = this.database.matchSubscriptions(inserted);

			if (inserted.kind === 5) {

				inserted.tags.filter(tag => {
					return tag[0] === 'e';
				}).map(tag => {
					return tag[1];
				}).forEach(id => {
					this.database.removeEvent({
						pubkey: inserted.pubkey,
						id
					});
				});
			}

			// Keep track of which subscriptions an event was
			// sent to - it's possible that an event matches
			// multiple filters on the same connection and
			// we don't need to send the client duplicates
			const sent = {/* <connid> : <bool> */};

			for (let subid of matched) {

				// Try to find an active ws connection id
				// associated with this subscription
				const connid = this.subscriptions[subid];

				if (!connid || sent[connid]) { continue; }

				// Get the actual connection object
				const ws = this.connections[connid];

				if (!ws) { continue; }

				try { // Push the event

					ws.send(JSON.stringify([ 'EVENT', subid, event ]));

					// Mark sent on connection
					sent[connid] = true;

				} catch (err) {

					console.log(`Failed to push event ${event.id} to connection ${connid}`, err);
					// TODO if websocket error, maybe delete the reference to the connection
				}
			}

		}
	}

	req (data, conn) {

		const subid = data[1];

		if (typeof subid !== 'string') { return; }

		const filters = data.slice(2);

		// TODO enforce filters max size (maybe add option to except connection)

		// Create record(s) of the subscription filter(s)
		this.database.addSubscription(subid, filters);

		// Save a reference connecting the sub id to the websocket
		// connection id so new events can be pushed to the client
		this.subscriptions[subid] = conn.id;

		// Pass request filters to query function
		const events = this.database.queryEvents(filters);

		// Get a reference to the websocket
		const ws = this.connections[conn.id];

		// Return id linked connection not found
		if (!ws) { return; }

		// Add subid to array of linked subs
		ws.subids.push(subid);

		// Push each event to the client
		for (let event of events) {

			ws.send(JSON.stringify([ 'EVENT', subid, event ]));			
		}

		// Send NIP-15 "end of saved events" message
		ws.send(JSON.stringify([ 'EOSE', subid ]));
	}

	unsub (data, conn) {

		if (typeof data[1] !== 'string') { return; }

		const subid = data[1];

		// Remove subscription model from the DB
		this.database.removeSubscription(subid);

		// Delete memory reference
		delete this.subscriptions[subid];

		// Try to find the connection for this sub
		const ws = this.connections[conn.id];

		if (ws) {

			// Remove sub id from array of active subs
			ws.subids = ws.subids.filter(_subid => {
				return _subid !== subid;
			});
		}
	}

	stop () {

		this.removeAllListeners();
	}

	// Set event handler
	// on (event, f) {

	// 	this.eventHandlers[event] = f;
	// }

	// // Call event handler if defined
	// fire (event, data) {

	// 	if (this.eventHandlers[event]) {

	// 		this.eventHandlers[event](data);
	// 	}
	// }
}

module.exports = Relay;
