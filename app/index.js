
const path = require('path');

const Database = require('./lib/sqlite');
const Graph = require('./lib/graph');
const Receiver = require('./lib/receiver');
const Relay = require('./lib/relay');

const Functions = require('./functions');
const Control = require('./control');

// KEEP WORKING . . . create an "app" sub dir and move
// the logic there . . . you should be able to create
// an instance of the app. Once that is working and has
// not broken anything, try to build the multiinstance
// thing


class App {

	constructor (config = {}) {

		this.config = config;

		console.log('app config', this.config);

		// Init embedded sqlite database
		this.database = new Database({
			directory: this.config.path,
			reportInterval: 1000
		});

		// Initialize model of the social graph
		this.graph = new Graph();

		// Initializse receiver for pulling data from remote relays
		this.receiver = new Receiver(this.graph);

		// API for controlling the node by proxy - create config
		// file in the db directory unless otherwise specified
		this.control = new Control(this, {
			configPath: path.join(this.config.path, 'node.json')
			//configPath: process.env.CONFIG_PATH || path.join(this.database.config.directory, 'node.json')
			//configPath: '/Users/sbowman/Library/Application Support/satellite-electron/config.json',
		});

		// Create the relay, connecting to
		// the node's control interface
		this.relay = new Relay(this.database, {

			// Localhost relay port number
			//port: process.env.PORT,

			connect: (ws, req) => {

				// TODO in the multi relay set up, ignore
				// connections if the subdomain does not
				// match the relay . . . there is only one
				// single websocket server, but there are
				// a bunch of differerent relays and databases

				return true;
			},

			// Control interface
			controlApi: (...args) => { this.control.action(...args); },

			// Control authorization
			controlAuth: (data) => { return data === this.config.auth; }
		});

		// Handle database status reports
		this.database.on('status', (data) => {

			this.control.handleDatabaseStatus(data);
		});

		// Handle relay status reports
		this.receiver.on('relay:status', (data) => {

			this.control.handleRelayStatus(data);
		});

		// Pass received events to the relay
		this.receiver.on('event:received', (data) => {

			this.control.handleListenerReceived(data);
		});

		// Handle new events being saved by relay
		this.relay.on('event:inserted', (data) => {

			this.control.handleInserted(data);
		});
	}

	start () {

		// Load metadata in from the db into the social graph
		Functions.Startup(this);
	}

	stop () {

		Functions.Shutdown(this);
	}
}

module.exports = App;
