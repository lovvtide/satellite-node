require('dotenv').config();

//const Express = require('express');
const WebSocket = require('ws');
const Http = require('./http');
const App = require('./app');

// Needed for nostr-tools relay lib
global.WebSocket = WebSocket;

// Create websocket server
const wss = new WebSocket.WebSocketServer({
	port: parseInt(process.env.PORT || 2012)
});

const app = new App({
	path: process.env.DATA_PATH,
	auth: process.env.AUTH
});

// Attach http routes
const httpServer = Http(app);

// Fix CORS for websocket
wss.on('headers', (headers, request) => {
	headers.push('Access-Control-Allow-Origin: *');
});

// Setup handlers for new connections
wss.on('connection', (ws, req) => {

	// Handle new connection
	const conn = app.relay.connect(ws, req);

	if (!conn) { return; }

	ws.on('message', (buffer) => {

		app.relay.message(buffer, conn);
	});

	ws.on('close', () => {

		app.relay.disconnect(ws);
	});

});

// Allow parent (if any) to tell the node to shut itself
// down gracefully instead of just killing the process
process.on('SIGINT', () => {
	console.log('instance got SIGINT');
	app.stop();
	process.exit(0)
});

app.start();

// Listen for http connections
httpServer.listen(parseInt(process.env.HTTP_PORT || 2011), () => {

	console.log(`http server running);
});
