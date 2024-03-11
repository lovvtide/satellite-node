const Express = require('express');
const Cors = require('cors');

const Routes = require('./routes');


module.exports = (app) => {

	//const port = process.env.HTTP_PORT || 2011;

	const server = Express();

	server.use(Cors());

	server.use((req, res, next) => {

		// if (req.app === null) {
		// 	next();
		// }

		req.app = typeof app === 'function' ? app(req, res, next) : app;

		// if (req.app) {
			
		// }

		next();

	});

	server.use((req, res, next) => {

		// TODO handle the NIP-11 business

		next();

	});

	server.use(Routes());

	return server;

};
