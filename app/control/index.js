const crypto = require('crypto');
const Util = require('../lib/util');

const API = require('./API');


class Control {

	constructor (app, options) {

		this.app = app;

		this.options = options;

		// Init status default values
		this.status = {
			listening: false,
			relaysConnected: {},
			dbCount: 0,
			dbSize: 0
		};

		// Load initial config from disk
		this.config = {
			cacheLevel: 3,
			relayPort: parseInt(process.env.PORT),
			autoListen: true,
			logsEnabled: true,
			pubkeys: [],
			relays: [],
			...(Util.loadJson({ path: this.options.configPath }) || {})
		};

		// Actions may be called locally and also
		// by proxy through a control connection
		this.api = API(this);

		this._databaseStatusUpdated = 0;
	}

	action (type, data) {

		if (!this.api[type]) { return; }

		let result;

		try {

			result = this.api[type](data);

		} catch (err) {

			console.log('api err', err);
			// TODO dispatch error
		}
	}

	// Set config file state, save to disk,
	// and forward to change to controllers
	setConfig (data) {

		if (!data) { return; }

		this.config = {
			...this.config,
			...data
		};

		Util.saveJson(this.config, {
			path: this.options.configPath
		});

		this.broadcast({
			type: 'config/set',
			data
		});

		this.log({
			text: `[CONFIG] ${Object.keys(data).map(key => {
				return `${key} = ${JSON.stringify(data[key])}`.toUpperCase();
			}).join(' | ')}`
		});
	}

	// Set status flags and forward
	setStatus (data) {

		if (!data) { return; }

		this.status = {
			...this.status,
			...data
		};

		this.broadcast({
			type: 'status/set',
			data
		});
	}

	handleInserted ({ pubkey, kind, content }) {

		const profile = this.app.graph.getProfile(pubkey);

		const name = profile && profile.name ? profile.name : Util.formatPubkey(pubkey);

		let preview;
		
		// Preview kinds 1 and 7, truncating at 256 chars
		if (kind === 1 || kind === 7) {

			preview = content.length > 256 ? content.slice(0, 256) : content;
		}

		this.log({
			text: `[EVENT] KIND ${kind} FROM ${name}` + (preview ? ` "${preview}"` : ''),
		});

		if (this._databaseStatusPending) { return; }

		const statusDelta = (this._databaseStatusUpdated + 1000) - Date.now();

		// If it's been at least one second since the last
		// database status broadcast, update immediately
		if (statusDelta <= 0) {

			this.updateDatabaseStatus();

		} else { // Otherwise set to fire at t + delta

			this._databaseStatusPending = true;

			this._databaseStatusTimeout = setTimeout(() => {
				this.updateDatabaseStatus();
			}, statusDelta);
		}
	}

	updateDatabaseStatus () {

		this._databaseStatusPending = false;
		this._databaseStatusUpdated = Date.now();
		
		const dbSize = this.app.database.size();
		const dbCount = this.app.database.count();

		// Only broadcast db metrics if value(s) changed
		if (dbSize === this.status.dbSize && dbCount === this.status.dbCount) {
			return;
		}
		
		this.setStatus({
			dbCount,
			dbSize
		});
	}

	handleListenerReceived (event) {

		// Pass event to the relay
		this.app.relay.event([ null, event ], null, {

			// Relay handler doesn't need to verify
			// event, already verified by receiver
			skipVerification: true
		});
	}

	handleRelayStatus ({ status, relay }) {

		if (!relay) { return; }

		// When remote connected status changes to disconnected,
		// stop listening and reconnect only the persistent data
		// subs after slight delay - this is necessary to prevent
		// memory leaks caused by reopening subs on the ndk instance
		// if (status === 'disconnected' && this.status.listening) {

		// 	this._reconnectReceiverPending = true;

		// 	this.setStatus({ listening: false });

		// 	this._reconnectReceiver = setTimeout(() => {

		// 		this._reconnectReceiverPending = false;

		// 		receiver.unlisten();

		// 		receiver.listen(this.config, {
		// 			reconnect: true
		// 		});

		// 		this.setStatus({ listening: true });

		// 	}, 200);

		// 	return;
		// }

		const currentlyConnected = this.status.relaysConnected[relay.url];

		this.setStatus({
			relaysConnected: {
				...this.status.relaysConnected,
				[relay.url]: status === 'connected'
			}
		});

		if (
			(!currentlyConnected && status === 'connected')
			|| (status !== 'connected' && currentlyConnected)
		) {

			this.log({
				text: `[STATUS] REMOTE ${status.toUpperCase()} ${relay.url}`
			});

			//if (this._reconnectReceiverPending) { return; }

			//if (status === 'disconnected') {

				//if (!this._reconnectReceiverPending && status === 'disconnected') {

					//this._reconnectReceiverPending = true;

					//this._reconnectReceiver = setTimeout(() => {

						//this._reconnectReceiverPending = false;
						// receiver.unlisten();

						// receiver.listen(this.config, {
						// 	reconnect: true
						// });

					//}, 200);
				//}
			//}
		}
	}

	sendToParentProcess (message) {

		if (typeof process.send !== 'function') { return; }

		process.send(message);
	}

	// Broadcast control status to authorized clients
	broadcast (payload) {

		this.app.relay.broadcast(payload, {
			mode: 'CONTROL',
			authorized: true
		});
	}

	// Send log as authorized broadcast
	log (data) {

		if (this.config.logsEnabled) {

			this.broadcast({
				type: 'logs/remote',
				data: {
					id: crypto.randomUUID(),
					...data
				}
			});
		}
	}

	stop () {

		clearTimeout(this._databaseStatusTimeout);
		clearTimeout(this._reconnectReceiver);

		this._reconnectReceiverPending = false;
		this._databaseStatusPending = false;
	}

}

module.exports = Control;
